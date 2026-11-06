package com.redmrxgram.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

import java.util.List;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        RedMrxPushPlugin.capturePushOpen(this, getIntent());
        registerPlugin(RedMrxPushPlugin.class);
        registerPlugin(RedMrxMediaPlugin.class);
        registerPlugin(RedMrxUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        installImeAnimation();
    }

    // Плавная клавиатура (120 Гц), проверенная схема:
    //  – Хост WebView НЕ ресайзится от клавиатуры (padding только под
    //    системные бары) → раскладка страницы во время анимации заморожена.
    //  – Каждый кадр анимации → __rmgImeFrame(hCss, sysCss): JS двигает док
    //    (инпут/эмодзи) и скролл-контейнер композиторным transform'ом —
    //    маленькие слои экранного размера, мгновенный raster.
    //  – Один раз в onEnd → __rmgImeSettle(hCss, sysCss): JS ставит
    //    paddingBottom корню чата и снимает transform в том же тике —
    //    единственная переразметка, пиксель-в-пиксель.
    //  – postInvalidate: страховка от артефактов растеризации после
    //    закрытия клавиатуры.
    private void installImeAnimation() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        View webView = getBridge().getWebView();
        View insetHost = webView.getParent() instanceof View ? (View) webView.getParent() : webView;

        ViewCompat.setOnApplyWindowInsetsListener(insetHost, (view, insets) -> {
            int sys = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()).bottom;
            applyBottomInset(view, sys);
            return insets;
        });

        ViewCompat.setWindowInsetsAnimationCallback(insetHost,
            new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
                @Override
                public WindowInsetsCompat onProgress(WindowInsetsCompat insets,
                                                     List<WindowInsetsAnimationCompat> runningAnimations) {
                    evalIme(insets, "__rmgImeFrame");
                    return insets;
                }

                @Override
                public void onEnd(WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                        WindowInsetsCompat root = ViewCompat.getRootWindowInsets(insetHost);
                        if (root != null) evalIme(root, "__rmgImeSettle");
                        // Страховка от артефактов растеризации после закрытия.
                        insetHost.postInvalidate();
                    }
                }
            });

        ViewCompat.requestApplyInsets(insetHost);
    }

    private void evalIme(WindowInsetsCompat insets, String fn) {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) return;
        float density = getResources().getDisplayMetrics().density;
        int ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        int sys = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout()).bottom;
        // CSS px (иначе док уезжал на плотность экрана). Асинхронно — кадр не блокируется.
        wv.evaluateJavascript("window." + fn + "&&window." + fn + "("
                + (ime / density) + "," + (sys / density) + ")", null);
    }

    private void applyBottomInset(View host, int bottomInset) {
        if (host.getPaddingBottom() != bottomInset) {
            host.setPadding(host.getPaddingLeft(), host.getPaddingTop(),
                    host.getPaddingRight(), bottomInset);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        RedMrxPushPlugin.capturePushOpen(this, intent);
        super.onNewIntent(intent);
    }
}
