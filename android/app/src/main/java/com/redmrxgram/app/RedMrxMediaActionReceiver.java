package com.redmrxgram.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Manifest-приёмник кнопок медиа-уведомления (prev / play-pause / next /
// ±10с). Manifest, а не runtime-регистрация: PendingIntent кнопок должен
// срабатывать даже когда процесс приложения давно убит системой — тогда
// plugin == null и мы просто гасим осиротевшее уведомление (иначе оно
// висело бы в шторке с мёртвыми кнопками).
public class RedMrxMediaActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        // Команды нашего плагина — прямая пересылка (внутри dispatchCommand
        // есть проверка живого плагина и dead-ветка гашения уведомления).
        if (action.startsWith(RedMrxMediaPlugin.ACTION_PREFIX)) {
            RedMrxMediaPlugin.dispatchCommand(context, action);
            return;
        }
        // Медийные кнопки (гарнитура/Bluetooth) приходят как KEYCODE_MEDIA_*
        // через MediaSession — их обрабатывает MediaSessionCompat, не мы.
    }
}
