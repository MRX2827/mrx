package com.redmrxgram.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PluginMethod;

import java.lang.ref.WeakReference;

// Embedded push: this plugin starts/stops a foreground service
// (RedMrxPushConnectionService) that keeps a permanent connection to ntfy
// directly inside this APK. No UnifiedPush distributor app, no Firebase, no
// Google Play Services — the whole point is zero extra apps for the user.
@CapacitorPlugin(
    name = "NativePush",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = RedMrxPushPlugin.NOTIFICATION_PERMISSION)
)
public class RedMrxPushPlugin extends Plugin {
    static final String NOTIFICATION_PERMISSION = "receive";
    static final String PREFS = "rmg_push";
    static final String KEY_TOPIC = "topic";
    static final String KEY_PENDING_CHAT = "pending_chat";
    static final String OPEN_PUSH_ACTION = "com.redmrxgram.app.OPEN_PUSH";

    private static WeakReference<RedMrxPushPlugin> current = new WeakReference<>(null);
    private NotificationManager notificationManager;

    @Override
    public void load() {
        current = new WeakReference<>(this);
        notificationManager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        RedMrxPushConnectionService.createChannels(getContext());
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String currentTopic(Context context) {
        return prefs(context).getString(KEY_TOPIC, "");
    }

    static void emitError(String error) {
        RedMrxPushPlugin plugin = current.get();
        if (plugin != null) {
            JSObject out = new JSObject();
            out.put("error", error);
            plugin.notifyListeners("registrationError", out, true);
        }
    }

    static void emitNotification(JSObject notification) {
        RedMrxPushPlugin plugin = current.get();
        if (plugin != null) plugin.notifyListeners("pushNotificationReceived", notification, true);
    }

    static void capturePushOpen(Context context, Intent intent) {
        if (intent == null) return;
        String chatId = intent.getStringExtra("chatId");
        if (chatId == null || chatId.isEmpty()) return;
        prefs(context).edit().putString(KEY_PENDING_CHAT, chatId).apply();
        RedMrxPushPlugin plugin = current.get();
        if (plugin != null) plugin.emitAction(chatId);
    }

    private void emitAction(String chatId) {
        JSObject data = new JSObject();
        data.put("chatId", chatId);
        JSObject notification = new JSObject();
        notification.put("data", data);
        JSObject action = new JSObject();
        action.put("actionId", "tap");
        action.put("notification", notification);
        notifyListeners("pushNotificationActionPerformed", action, true);
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject out = new JSObject();
            out.put(NOTIFICATION_PERMISSION, "granted");
            call.resolve(out);
        } else {
            super.checkPermissions(call);
        }
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            JSObject out = new JSObject();
            out.put(NOTIFICATION_PERMISSION, "granted");
            call.resolve(out);
            return;
        }
        requestPermissionForAlias(NOTIFICATION_PERMISSION, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        checkPermissions(call);
    }

    @PluginMethod
    public void createChannel(PluginCall call) {
        RedMrxPushConnectionService.createChannels(getContext());
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String topic = call.getString("topic", "").trim();
        if (topic.isEmpty()) {
            call.reject("Missing topic");
            return;
        }
        prefs(getContext()).edit().putString(KEY_TOPIC, topic).apply();
        RedMrxPushConnectionService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        RedMrxPushConnectionService.stop(getContext());
        prefs(getContext()).edit().remove(KEY_TOPIC).apply();
        call.resolve();
    }

    @PluginMethod
    public void getLaunchData(PluginCall call) {
        SharedPreferences store = prefs(getContext());
        String chatId = store.getString(KEY_PENDING_CHAT, "");
        if (!chatId.isEmpty()) store.edit().remove(KEY_PENDING_CHAT).apply();
        JSObject out = new JSObject();
        out.put("chatId", chatId);
        call.resolve(out);
    }

    @PluginMethod
    public void getDeliveredNotifications(PluginCall call) {
        JSArray notifications = new JSArray();
        if (notificationManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            for (StatusBarNotification item : notificationManager.getActiveNotifications()) {
                JSObject notification = new JSObject();
                notification.put("id", item.getId());
                notification.put("tag", item.getTag());
                notifications.put(notification);
            }
        }
        JSObject out = new JSObject();
        out.put("notifications", notifications);
        call.resolve(out);
    }

    @PluginMethod
    public void removeDeliveredNotifications(PluginCall call) {
        JSArray notifications = call.getArray("notifications");
        if (notificationManager != null && notifications != null) {
            for (int index = 0; index < notifications.length(); index++) {
                try {
                    JSObject notification = JSObject.fromJSONObject(notifications.getJSONObject(index));
                    Integer id = notification.getInteger("id");
                    if (id != null) notificationManager.cancel(id);
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void removeAllDeliveredNotifications(PluginCall call) {
        if (notificationManager != null) notificationManager.cancelAll();
        call.resolve();
    }
}
