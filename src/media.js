// ─── RedMrxGram — Media Download Manager ─────────────────────────────────────
// Заменяет старое хранение вложений как base64 в IndexedDB (OfflineStore.files).
// Реальные байты файла лежат на диске устройства (Capacitor Filesystem),
// метаданные и статус загрузки — в SQLite (см. db.js: getMediaEntry/upsertMedia).
// В браузере (не native) файловой системы нет — модуль просто ничего не делает,
// компоненты продолжают показывать remote_url напрямую, как раньше.

import { getMediaEntry, upsertMedia } from "./db.js";

const MEDIA_DIR = "rmg_media";
let _fsMod = undefined; // undefined = ещё не пробовали, null = недоступен
let _capMod = undefined;

async function _getFs() {
  if (_fsMod !== undefined) return _fsMod;
  try {
    const mod = await import("@capacitor/filesystem");
    _fsMod = mod || null;
  } catch (e) {
    console.warn("[media] @capacitor/filesystem not available:", e?.message || e);
    _fsMod = null;
  }
  return _fsMod;
}

async function _getCap() {
  if (_capMod !== undefined) return _capMod;
  try {
    const mod = await import("@capacitor/core");
    _capMod = mod || null;
  } catch (e) {
    _capMod = null;
  }
  return _capMod;
}

async function _isNative() {
  const cap = await _getCap();
  return !!(cap && cap.Capacitor && cap.Capacitor.isNativePlatform && cap.Capacitor.isNativePlatform());
}

function _extFromMime(mime, kind) {
  if (mime && mime.includes("/")) {
    const e = mime.split("/")[1]?.split(";")[0];
    if (e && e.length <= 5) return e.replace(/[^a-z0-9]/gi, "") || "bin";
  }
  if (kind === "video") return "mp4";
  if (kind === "audio") return "m4a";
  if (kind === "image") return "jpg";
  return "bin";
}

function _safeId(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function _localPathFor(chatId, msgId, mime, kind) {
  return `${MEDIA_DIR}/${_safeId(chatId)}__${_safeId(msgId)}.${_extFromMime(mime, kind)}`;
}

// relPath (то, что лежит в media.local_path) → готовый src для <img>/<video>/<audio>.
export async function resolveLocalSrc(relPath) {
  if (!relPath) return null;
  const fs = await _getFs();
  const cap = await _getCap();
  if (!fs || !cap) return null;
  try {
    const { uri } = await fs.Filesystem.getUri({ directory: fs.Directory.Data, path: relPath });
    return cap.Capacitor.convertFileSrc(uri);
  } catch (e) {
    return null;
  }
}

// Уже скачано? Возвращает готовый локальный src или null (не скачано / не native).
export async function getCachedMediaSrc(chatId, msgId) {
  if (!(await _isNative())) return null;
  const entry = await getMediaEntry(chatId, msgId);
  if (!entry || entry.status !== "done" || !entry.localPath) return null;
  const src = await resolveLocalSrc(entry.localPath);
  if (!src) {
    // Файл пропал с диска (переустановка / очистка) — сбрасываем статус,
    // чтобы ensureMediaDownloaded не думал, что всё ок.
    await upsertMedia(chatId, msgId, { status: "none", localPath: "" }).catch(() => {});
    return null;
  }
  return src;
}

export async function getMediaStatus(chatId, msgId) {
  const entry = await getMediaEntry(chatId, msgId);
  return entry ? entry.status : "none";
}

const _inFlight = new Map(); // key -> Promise<string|null>, чтобы не качать один файл дважды параллельно

// ── Ограничитель параллельных закачек ────────────────────────────────────────
// Без этого при открытии чата с большой историей (много фото/видео) все
// сообщения монтируются разом и КАЖДОЕ сразу лезет качать файл — это отнимает
// соединения/трафик у обычной "живой" загрузки картинок/видео в тех же
// бабблах, из-за чего они и не показываются, пока онлайн. Ограничиваем до
// MAX_CONCURRENT одновременных фоновых закачек, остальные ждут своей очереди.
const MAX_CONCURRENT = 1; // сервер слабый (512MB/1vCPU) — качаем максимум один файл фоном за раз
let _active = 0;
let _pauseCount = 0; // >0 — фоновые закачки временно не стартуют (например, идёт отправка своего файла)
const _queue = [];

// Вызывайте перед началом важной сетевой операции (отправка своего файла),
// чтобы фоновый кэш не отнимал у неё соединение/трафик на слабом сервере.
// Уже стартовавшие закачки не прерываются — просто новые не запускаются,
// пока pauseCount не вернётся к нулю.
export function pauseMediaDownloads() { _pauseCount++; }
export function resumeMediaDownloads() { _pauseCount = Math.max(0, _pauseCount - 1); _runNext(); }

function _runNext() {
  if (_pauseCount > 0) return;
  if (_active >= MAX_CONCURRENT) return;
  const next = _queue.shift();
  if (!next) return;
  _active++;
  next().finally(() => {
    _active--;
    _runNext();
  });
}

function _enqueue(fn) {
  return new Promise((resolve) => {
    _queue.push(() => fn().then(resolve, () => resolve(null)));
    _runNext();
  });
}

// Запустить (или дождаться уже идущей) загрузку. Безопасно вызывать многократно —
// повторные вызовы для того же сообщения либо возвращают уже готовый src,
// либо подключаются к уже идущей загрузке, либо тихо выходят, если недавно упало.
export async function ensureMediaDownloaded(chatId, msgId, remoteUrl, kind, mime, size) {
  if (!remoteUrl || !chatId || !msgId) {
    console.log("[media] skip (no url/chatId/msgId):", chatId, msgId, kind, "url=", !!remoteUrl);
    return null;
  }
  if (!(await _isNative())) return null; // в браузере — просто используем remote_url как раньше

  const key = `${chatId}::${msgId}`;
  if (_inFlight.has(key)) return _inFlight.get(key);

  const existing = await getMediaEntry(chatId, msgId);
  if (existing && existing.status === "done" && existing.localPath) {
    const src = await resolveLocalSrc(existing.localPath);
    if (src) return src;
    console.log("[media] cached row but file missing on disk, redownloading:", chatId, msgId);
    // файла на диске нет — перекачиваем ниже
  }
  if (existing && existing.status === "downloading") return null; // уже качается где-то ещё

  const job = _enqueue(async () => {
    console.log("[media] start download:", chatId, msgId, kind, remoteUrl);
    const fs = await _getFs();
    if (!fs) { console.warn("[media] @capacitor/filesystem missing, cannot download"); return null; }
    await upsertMedia(chatId, msgId, {
      kind, remoteUrl, mime: mime || "", size: size || 0, status: "downloading",
    });
    try {
      await fs.Filesystem.mkdir({ path: MEDIA_DIR, directory: fs.Directory.Data, recursive: true }).catch(() => {});
      const path = _localPathFor(chatId, msgId, mime, kind);
      // downloadFile стримит прямо на диск — файл никогда целиком не лежит
      // в JS-памяти как base64-строка (в отличие от старого IndexedDB-подхода),
      // поэтому крупное видео больше не должно ронять WebView.
      await fs.Filesystem.downloadFile({ url: remoteUrl, path, directory: fs.Directory.Data });
      await upsertMedia(chatId, msgId, { localPath: path, status: "done" });
      console.log("[media] download OK:", chatId, msgId, path);
      return resolveLocalSrc(path);
    } catch (e) {
      console.warn("[media] download failed:", chatId, msgId, e?.message || e);
      await upsertMedia(chatId, msgId, { status: "failed" }).catch(() => {});
      return null;
    } finally {
      _inFlight.delete(key);
    }
  });

  _inFlight.set(key, job);
  return job;
}

// Повторить загрузку после неудачи (например, пользователь тапнул на кружок
// с восклицательным знаком у медиа-сообщения).
export async function retryMediaDownload(chatId, msgId, remoteUrl, kind, mime, size) {
  await upsertMedia(chatId, msgId, { status: "none" }).catch(() => {});
  return ensureMediaDownloaded(chatId, msgId, remoteUrl, kind, mime, size);
}
