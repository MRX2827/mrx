import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App as CapApp } from "@capacitor/app";
import { hasAndroidUpdates, updateCheckEvent, updater } from "./app-update-bridge.js";
import "./app-update.css";

export function AppUpdateHost() {
  return hasAndroidUpdates() ? <AndroidUpdateBanner/> : null;
}

function AndroidUpdateBanner() {
  const [card, setCard] = useState(null);
  const [closing, setClosing] = useState(false);
  const [progress, setProgress] = useState(0);
  const dismissed = useRef("");
  const busy = useRef(false);
  const closeTimer = useRef();

  useEffect(() => {
    let active = true;
    let lastCheck = 0;
    let pending;
    const check = async (manual = false) => {
      if (busy.current || (!manual && (document.hidden || Date.now() - lastCheck < 15000))) return;
      if (manual) {
        dismissed.current = "";
        clearTimeout(closeTimer.current);
        setClosing(false);
        setCard({ stage: "checking" });
      }
      lastCheck = Date.now();
      pending ||= updater.check().finally(() => { pending = null; });
      try {
        const release = await pending;
        if (!active || busy.current) return;
        if (release.version && dismissed.current !== release.version) {
          setCard(previous => previous?.version === release.version && !manual
            ? previous
            : { ...release, stage: release.ready ? "ready" : "available" });
        } else if (manual) {
          setCard({ stage: "current", subtitle: "У вас последняя версия MRX" });
        }
      } catch (error) {
        if (active && manual) setCard({ stage: "current", subtitle: error.message || "Проверьте подключение к интернету" });
      }
    };
    const timer = setTimeout(check, 900);
    const resume = CapApp.addListener("appStateChange", ({ isActive }) => { if (isActive) check(); });
    const download = updater.addListener("progress", ({ downloaded, total }) => {
      if (active && total > 0) setProgress(Math.min(100, Math.floor(downloaded * 100 / total)));
    });
    const manualCheck = () => { check(true); };
    const online = () => { lastCheck = 0; check(); };
    window.addEventListener(updateCheckEvent, manualCheck);
    window.addEventListener("online", online);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(closeTimer.current);
      window.removeEventListener(updateCheckEvent, manualCheck);
      window.removeEventListener("online", online);
      for (const listener of [resume, download]) listener.then(handle => handle.remove()).catch(() => {});
    };
  }, []);

  if (!card) return null;
  const { stage, version, size, subtitle } = card;
  const downloading = stage === "downloading";
  const ready = stage === "ready" || stage === "installing";
  const working = downloading || stage === "installing" || stage === "checking";
  const title = {
    checking: "Проверяем обновления",
    current: subtitle === "У вас последняя версия MRX" ? "Обновлений нет" : "Проверка обновлений",
    available: "Доступно обновление",
    downloading: "Скачиваем обновление",
    ready: "Обновление готово",
    installing: "Открываем установщик",
    failed: "Не удалось обновить",
  }[stage];
  const detail = subtitle || (downloading ? `${progress}% · MRX ${version}` : version
    ? `MRX ${version} · ${(size / 1048576).toLocaleString("ru", { maximumFractionDigits: 1 })} МБ`
    : "GitHub Releases");

  const dismiss = () => {
    if (closing || working) return;
    dismissed.current = version || "";
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setCard(null);
      setClosing(false);
    }, 280);
  };
  const action = async () => {
    if (busy.current || working || closing) return;
    busy.current = true;
    try {
      if (ready) {
        setCard({ ...card, stage: "installing", subtitle: "" });
        const result = await updater.install({ version });
        setCard({ ...card, stage: "ready", subtitle: result.permissionRequired
          ? "Разрешите установку из MRX и нажмите ещё раз"
          : "Подтвердите установку в Android" });
      } else {
        setProgress(0);
        setCard({ ...card, stage: "downloading", subtitle: "" });
        await updater.download({ version });
        setCard({ ...card, stage: "ready", subtitle: "" });
      }
    } catch (error) {
      setCard({ ...card, stage: "failed", subtitle: error.message || "Повторите попытку" });
    } finally {
      busy.current = false;
    }
  };

  return createPortal(
    <aside className="mrx-update" data-closing={closing} aria-label="Обновление MRX">
      <div className="mrx-update-row">
        <span className="mrx-update-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            {ready ? <path d="m5 12 4 4L19 6"/> : <path d="M12 3v12m-5-5 5 5 5-5M5 18v2h14v-2"/>}
          </svg>
        </span>
        <div className="mrx-update-copy">
          <strong key={title} role="status">{title}</strong>
          <small>{detail}</small>
        </div>
        {version && !working && <button className="mrx-update-action" onClick={action}>
          {ready ? "Установить" : stage === "failed" ? "Повторить" : "Скачать"}
        </button>}
        {!working && <button className="mrx-update-close" aria-label="Закрыть уведомление об обновлении" onClick={dismiss}>×</button>}
      </div>
      {downloading && <div className="mrx-update-progress" role="progressbar" aria-label="Скачивание обновления" aria-valuenow={progress}>
        <div style={{ transform: `scaleX(${progress / 100})` }}/>
      </div>}
    </aside>,
    document.body,
  );
}
