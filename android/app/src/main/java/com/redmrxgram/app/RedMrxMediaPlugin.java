package com.redmrxgram.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.os.Build;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.ref.WeakReference;

// Нативное зеркало аудио-плеера из WebView (AUDIO_ENGINE в App.jsx).
// Сам звук играет HTMLAudioElement в WebView — этот плагин НЕ играет звук,
// а только показывает MediaStyle-уведомление (плеер в шторке) и MediaSession
// (кнопки на BT/наушниках, приоритет звука), и пересылает нажатия кнопок
// обратно в JS событием "mediaCommand".
//
// Без foreground-сервиса сознательно: аудио-элемент WebView сам держит
// процесс живым во время воспроизведения (как YouTube в браузере), а
// уведомление живёт ровно столько же. FOREGROUND_SERVICE_MEDIA_PLAYBACK
// на F-Droid-ревью добавил бы лишние вопросы.
//
// Действия кнопок идут через manifest-приёмник RedMrxMediaActionReceiver
// (НЕ через MediaSession callbacks): MediaSessionCompat-колбэки шлёются
// только пока жив объект MediaSession — при убитом процессе они молча
// теряются. Приёмник же в любом случае стартует и в dead-состоянии просто
// гасит осиротевшее уведомление.
@CapacitorPlugin(name = "NativeMedia")
public class RedMrxMediaPlugin extends Plugin {

    static final String CHANNEL_MEDIA = "media";
    static final int NOTIF_ID = 41001;
    static final String PREFS = "rmg_media";
    static final String KEY_ALIVE = "alive";
    static final String ACTION_PREFIX = "com.redmrxgram.app.media.";
    static final String ACTION_PLAY_PAUSE = ACTION_PREFIX + "PLAY_PAUSE";
    static final String ACTION_NEXT = ACTION_PREFIX + "NEXT";
    static final String ACTION_PREV = ACTION_PREFIX + "PREV";
    static final String ACTION_REW = ACTION_PREFIX + "REW";
    static final String ACTION_FFW = ACTION_PREFIX + "FFW";
    static final String ACTION_CLOSE = ACTION_PREFIX + "CLOSE";

    private static WeakReference<RedMrxMediaPlugin> current = new WeakReference<>(null);

    private MediaSessionCompat session;
    private String lastState = "none"; // "none" | "playing" | "paused"

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static RedMrxMediaPlugin instance() {
        return current.get();
    }

    @Override
    public void load() {
        current = new WeakReference<>(this);
        createChannel(getContext());
        // На случай reinstal/обновления: старое уведомление могло остаться в шторке
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            prefs(getContext()).edit().putBoolean(KEY_ALIVE, false).apply();
        }
        cancelNotification(getContext());
        prefs(getContext()).edit().putBoolean(KEY_ALIVE, false).apply();
    }

    @Override
    protected void handleOnDestroy() {
        if (session != null) {
            try {
                session.setActive(false);
                session.release();
            } catch (Exception ignored) {}
            session = null;
        }
        cancelNotification(getContext());
        prefs(getContext()).edit().putBoolean(KEY_ALIVE, false).apply();
        current.clear();
        super.handleOnDestroy();
    }

    private void ensureSession() {
        if (session != null) return;
        session = new MediaSessionCompat(getContext(), "MrXAudio");
        // Приоритет звука как у «музыки»: клавиатура BT/системные звуки не глушат трек
        try {
            session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        } catch (Exception ignored) {}
        // Без явного MediaButtonReceiver в манифесте — отключаем, чтобы
        // MediaSessionCompat не строил PendingIntent в несуществующий компонент.
        try { session.setMediaButtonReceiver(null); } catch (Exception ignored) {}
        // ГЛАВНОЕ: на Android 13+ MediaStyle-уведомление рисуется СИСТЕМОЙ из
        // PlaybackState, и addAction-кнопки уведомления игнорируются —
        // нажатия (включая seekbar и кнопки BT-гарнитуры) приходят СЮДА,
        // в колбэки MediaSession. Без этого колбэка на 13+ кнопки мёртвые.
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { emitCommand("play"); }
            @Override public void onPause() { emitCommand("pause"); }
            @Override public void onSkipToNext() { emitCommand("next"); }
            @Override public void onSkipToPrevious() { emitCommand("prev"); }
            @Override public void onFastForward() { emitCommand("ffw"); }
            @Override public void onRewind() { emitCommand("rew"); }
            @Override public void onStop() { emitCommand("close"); }
            @Override public void onSeekTo(long posMs) {
                JSObject data = new JSObject();
                data.put("command", "seek");
                data.put("position", posMs / 1000.0);
                notifyListeners("mediaCommand", data, true);
            }
        });
    }

    // Кнопки уведомления → PendingIntent → RedMrxMediaActionReceiver (manifest) → сюда.
    // Если плагина нет (процесс только поднимается ради приёмника / умирает) —
    // гасим осиротевшее уведомление, чтобы не висело с мёртвыми кнопками.
    static void dispatchCommand(Context context, String action) {
        RedMrxMediaPlugin plugin = current.get();
        if (plugin == null) {
            cancelNotification(context);
            prefs(context).edit().putBoolean(KEY_ALIVE, false).apply();
            return;
        }
        String cmd;
        switch (action == null ? "" : action) {
            case ACTION_PLAY_PAUSE: cmd = plugin.lastState.equals("playing") ? "pause" : "play"; break;
            case ACTION_NEXT: cmd = "next"; break;
            case ACTION_PREV: cmd = "prev"; break;
            case ACTION_REW: cmd = "rew"; break;
            case ACTION_FFW: cmd = "ffw"; break;
            case ACTION_CLOSE: cmd = "close"; break;
            default: return;
        }
        plugin.emitCommand(cmd);
    }

    private void emitCommand(String cmd) {
        JSObject data = new JSObject();
        data.put("command", cmd);
        notifyListeners("mediaCommand", data, true);
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_MEDIA, "Плеер", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Управление воспроизведением музыки");
        channel.setShowBadge(false);
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
        channel.setSound(null, attributes);
        manager.createNotificationChannel(channel);
    }

    private static void cancelNotification(Context context) {
        try {
            NotificationManagerCompat.from(context).cancel(NOTIF_ID);
        } catch (SecurityException ignored) {}
    }

    // ── API из JS ────────────────────────────────────────────────────────────

    // options: { title, author, playing, duration, position, speed }
    @PluginMethod
    public void update(PluginCall call) {
        String title = call.getString("title", "");
        String author = call.getString("author", "");
        Boolean playing = call.getBoolean("playing", false);
        Double duration = call.getDouble("duration");
        Double position = call.getDouble("position");
        Double speed = call.getDouble("speed");

        JSObject opts = call.getData();
        boolean hasDur = opts != null && opts.has("duration");
        boolean hasPos = opts != null && opts.has("position");

        ensureSession();
        Context context = getContext();

        String state = playing ? "playing" : "paused";
        lastState = state;

        // ── MediaMetadata (нужен для MediaStyle-мини-плеера на лочке и для
        // системных выводов звука) — только при смене трека/вызове с треком.
        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder();
        meta.putString(MediaMetadataCompat.METADATA_KEY_TITLE, title);
        meta.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, author);
        meta.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "MrX");
        if (hasDur && duration != null && duration > 0) {
            meta.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (duration * 1000));
        } else {
            meta.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, 0L);
        }
        try { session.setMetadata(meta.build()); } catch (Exception ignored) {}

        // ── PlaybackState: и позиция, и действия для seekbar (Android 13+).
        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SEEK_TO
                | PlaybackStateCompat.ACTION_FAST_FORWARD | PlaybackStateCompat.ACTION_REWIND
                | PlaybackStateCompat.ACTION_STOP;
        PlaybackStateCompat.Builder pb = new PlaybackStateCompat.Builder();
        pb.setActions(actions);
        float rate = (speed != null && speed > 0) ? speed.floatValue() : 1f;
        // Позицию отдаём с учётом playbackRate — система сама экстраполирует.
        long posMs = (hasPos && position != null && position >= 0) ? (long) (position * 1000) : 0;
        pb.setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                posMs, playing ? rate : 0f);
        try { session.setPlaybackState(pb.build()); } catch (Exception ignored) {}
        try { session.setActive(true); } catch (Exception ignored) {}

        // ── MediaStyle-уведомление. На Android 13+ seekbar рисует система из
        // PlaybackState — прогресс в уведомлении обновлять из JS НЕ нужно.
        // На 10–12 позиция в уведомлении статична (это ограничение ОС).
        try {
            NotificationManagerCompat manager = NotificationManagerCompat.from(context);
            boolean canNotify = Build.VERSION.SDK_INT < 33 ||
                    ContextCompat.checkSelfPermission(context, "android.permission.POST_NOTIFICATIONS")
                            == PackageManager.PERMISSION_GRANTED;
            if (canNotify) {
                manager.notify(NOTIF_ID, buildNotification(context, title, author, playing));
                prefs(context).edit().putBoolean(KEY_ALIVE, true).apply();
            }
        } catch (SecurityException ignored) {}
        call.resolve();
    }

    private Notification buildNotification(Context context, String title, String author, boolean playing) {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;

        Intent open = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        androidx.media.app.NotificationCompat.MediaStyle style =
                new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken());

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_MEDIA)
                .setSmallIcon(R.drawable.ic_stat_redmrxgram)
                .setContentTitle(title)
                .setContentText(author)
                .setOngoing(playing)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(PendingIntent.getActivity(context, NOTIF_ID, open, piFlags))
                .addAction(R.drawable.ic_media_prev, "Предыдущий", actionPI(context, ACTION_PREV, 1))
                .addAction(playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                        playing ? "Пауза" : "Играть", actionPI(context, ACTION_PLAY_PAUSE, 2))
                .addAction(R.drawable.ic_media_next, "Следующий", actionPI(context, ACTION_NEXT, 3));

        // До Android 13 (T) seekbar'а в MediaStyle нет — добавляем ±10c
        if (Build.VERSION.SDK_INT < 33) {
            builder.addAction(R.drawable.ic_media_rew, "-10 сек", actionPI(context, ACTION_REW, 4));
            builder.addAction(R.drawable.ic_media_ffw, "+10 сек", actionPI(context, ACTION_FFW, 5));
        }
        builder.setStyle(style.setShowActionsInCompactView(0, 1, 2));
        return builder.build();
    }

    private static PendingIntent actionPI(Context context, String action, int requestCode) {
        Intent intent = new Intent(context, RedMrxMediaActionReceiver.class)
                .setAction(action)
                .putExtra("fromReceiver", true);
        return PendingIntent.getBroadcast(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    @PluginMethod
    public void clear(PluginCall call) {
        lastState = "none";
        cancelNotification(getContext());
        prefs(getContext()).edit().putBoolean(KEY_ALIVE, false).apply();
        if (session != null) {
            try {
                session.setActive(false);
            } catch (Exception ignored) {}
        }
        call.resolve();
    }
}
