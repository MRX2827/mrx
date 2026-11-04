package com.redmrxgram.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.util.Log;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public class RedMrxPushConnectionService extends android.app.Service {
    private static final String TAG = "RedMrxPush";
    private static final String NTFY_BASE = "https://ntfy.sh";

    private static final String CHANNEL_CONNECTION = "push_connection";
    private static final String CHANNEL_FULL = "messages";
    private static final String CHANNEL_SOUND = "messages_sound";
    private static final String CHANNEL_VIBRATION = "messages_vibration";
    private static final String CHANNEL_SILENT = "messages_silent";
    private static final int CONNECTION_NOTIF_ID = 1;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private OkHttpClient client;
    private WebSocket webSocket;
    private long backoffMs = 2000;
    private boolean stopping = false;
    private String connectedTopic = "";

    static void start(Context context) {
        Intent intent = new Intent(context, RedMrxPushConnectionService.class);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, RedMrxPushConnectionService.class));
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
        client = new OkHttpClient.Builder()
            .pingInterval(45, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String topic = RedMrxPushPlugin.currentTopic(this);
        Log.d(TAG, "onStartCommand topic=" + topic + " connectedTopic=" + connectedTopic + " webSocket=" + (webSocket != null));
        if (topic.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(CONNECTION_NOTIF_ID, buildConnectionNotification());
        if (topic.equals(connectedTopic) && webSocket != null) {
            Log.d(TAG, "onStartCommand: already connected to this topic, ignoring duplicate start()");
            return START_STICKY;
        }
        stopping = false;
        handler.removeCallbacksAndMessages(null);
        connect(topic);
        return START_STICKY;
    }

    private void connect(String topic) {
        closeSocket();
        connectedTopic = topic;
        String url = NTFY_BASE.replaceFirst("^http", "ws") + "/" + topic + "/ws";
        Log.d(TAG, "connecting to " + url);
        Request request = new Request.Builder()
            .url(url)
            .build();
        webSocket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                Log.d(TAG, "ws onOpen code=" + response.code());
                backoffMs = 2000;
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                Log.d(TAG, "ws onMessage: " + text);
                handleMessage(text);
            }

            @Override
            public void onMessage(WebSocket ws, ByteString bytes) {
                Log.d(TAG, "ws onMessage(bytes)");
                handleMessage(bytes.utf8());
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                Log.w(TAG, "ws onClosed code=" + code + " reason=" + reason);
                scheduleReconnect(topic);
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                Log.e(TAG, "ws onFailure: " + t.getMessage(), t);
                scheduleReconnect(topic);
            }
        });
    }

    private void scheduleReconnect(String topic) {
        if (stopping) return;
        handler.postDelayed(() -> {
            if (!stopping) connect(topic);
        }, backoffMs);
        backoffMs = Math.min((long) (backoffMs * 1.7), 30000);
    }

    private void handleMessage(String text) {
        try {
            JSONObject payload = new JSONObject(text);
            String event = payload.optString("event", "");
            Log.d(TAG, "handleMessage event=" + event);
            if (!"message".equals(event)) return;
            String title = payload.optString("title", "RedMrxGram");
            String body = payload.optString("message", "");
            // Сервер может передать id чата в поле click — используем как
            // есть, если оно похоже на id, а не на настоящую ссылку.
            String chatId = payload.optString("click", "");
            if (chatId.contains("://")) chatId = "";
            boolean sound = true;
            boolean vibration = true;
            int id = (chatId.isEmpty() ? (int) System.currentTimeMillis() : chatId.hashCode()) & 0x7fffffff;

            showNotification(title.isEmpty() ? "RedMrxGram" : title, body.isEmpty() ? "Новое сообщение" : body, chatId, sound, vibration, id);

            JSObject data = new JSObject();
            data.put("chatId", chatId);
            JSObject eventObj = new JSObject();
            eventObj.put("id", id);
            eventObj.put("data", data);
            RedMrxPushPlugin.emitNotification(eventObj);
        } catch (Exception e) {
            Log.e(TAG, "handleMessage failed to parse: " + text, e);
            // ntfy also sends "open"/"keepalive" events with no "message" —
            // those just fall through here silently, which is correct.
        }
    }

    private void showNotification(String title, String body, String chatId, boolean sound, boolean vibration, int id) {
        Intent intent = new Intent(this, MainActivity.class)
            .setAction(RedMrxPushPlugin.OPEN_PUSH_ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("chatId", chatId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, id, intent, flags);
        String channel = sound && vibration ? CHANNEL_FULL : sound ? CHANNEL_SOUND : vibration ? CHANNEL_VIBRATION : CHANNEL_SILENT;
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_redmrxgram)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(id, notification.build());
    }

    private Notification buildConnectionNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_redmrxgram)
            .setContentTitle("RedMrxGram")
            .setContentText("Уведомления включены")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .build();
    }

    private void closeSocket() {
        if (webSocket != null) {
            try { webSocket.close(1000, "reconnecting"); } catch (Exception ignored) {}
            webSocket = null;
        }
    }

    @Override
    public void onDestroy() {
        stopping = true;
        handler.removeCallbacksAndMessages(null);
        closeSocket();
        super.onDestroy();
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .build();
        manager.createNotificationChannel(channel(CHANNEL_FULL, "Сообщения", sound, attributes, true, NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(channel(CHANNEL_SOUND, "Сообщения (без вибрации)", sound, attributes, false, NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(channel(CHANNEL_VIBRATION, "Сообщения (без звука)", null, null, true, NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(channel(CHANNEL_SILENT, "Сообщения (без звука)", null, null, false, NotificationManager.IMPORTANCE_HIGH));

        NotificationChannel connection = channel(CHANNEL_CONNECTION, "Служебное уведомление push", null, null, false, NotificationManager.IMPORTANCE_MIN);
        connection.setShowBadge(false);
        manager.createNotificationChannel(connection);
    }

    private static NotificationChannel channel(String id, String name, Uri sound, AudioAttributes attributes, boolean vibration, int importance) {
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription("Уведомления RedMrxGram");
        channel.setSound(sound, attributes);
        channel.enableVibration(vibration);
        if (vibration) channel.setVibrationPattern(new long[]{0, 250, 100, 250});
        channel.setShowBadge(true);
        return channel;
    }
}
