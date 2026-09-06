// ────────────────────────────────────────────────────────────────────────────
// storage.js — замена firebase/storage. Файлы грузятся на собственный сервер
// (POST /upload, поле "file"), а тот хранит их в Telegram-канале.
// ────────────────────────────────────────────────────────────────────────────

import { SERVER_HTTP, authToken } from "./core.js";

export function getStorage() {
  return { __rmgstorage: true };
}

export function ref(_storage, path) {
  return { __type: "storageRef", fullPath: path || "", name: (path || "").split("/").pop(), _url: null };
}

export function uploadBytesResumable(storageRef, blob) {
  const listeners = { progress: null, error: null, complete: null };
  const task = {
    snapshot: { ref: storageRef, bytesTransferred: 0, totalBytes: (blob && blob.size) || 0, state: "running" },
    on(_event, onProgress, onError, onComplete) {
      listeners.progress = onProgress || null;
      listeners.error = onError || null;
      listeners.complete = onComplete || null;
      return () => {};
    },
    cancel() {
      try {
        xhr.abort();
      } catch (e) {}
      return true;
    },
  };

  const xhr = new XMLHttpRequest();
  const form = new FormData();
  const fileName = storageRef.name || "file.bin";
  form.append("file", blob, fileName);

  let done = false;
  let resolveP, rejectP;
  task.then = (a, b) => new Promise((res, rej) => {
    resolveP = (v) => res(a ? a(v) : v);
    rejectP = (e) => (b ? res(b(e)) : rej(e));
    if (done) finish();
  });

  let finish = () => {};

  xhr.upload.onprogress = (ev) => {
    task.snapshot.bytesTransferred = ev.loaded;
    task.snapshot.totalBytes = ev.total || task.snapshot.totalBytes;
    if (listeners.progress) {
      try {
        listeners.progress(task.snapshot);
      } catch (e) {}
    }
  };
  xhr.onload = () => {
    done = true;
    if (xhr.status >= 200 && xhr.status < 300) {
      let out = null;
      try {
        out = JSON.parse(xhr.responseText);
      } catch (e) {}
      storageRef._url = out && out.url;
      task.snapshot.state = "success";
      finish = () => resolveP && resolveP(task.snapshot);
      if (listeners.complete) {
        try {
          listeners.complete();
        } catch (e) {}
      }
      if (resolveP) resolveP(task.snapshot);
    } else {
      let msg = "upload failed (" + xhr.status + ")";
      try {
        const out = JSON.parse(xhr.responseText);
        if (out && out.error) msg = out.error;
      } catch (e) {}
      const err = new Error(msg);
      task.snapshot.state = "error";
      finish = () => rejectP && rejectP(err);
      if (listeners.error) {
        try {
          listeners.error(err);
        } catch (e) {}
      }
      if (rejectP) rejectP(err);
    }
  };
  xhr.onerror = () => {
    done = true;
    const err = new Error("Нет связи с сервером");
    task.snapshot.state = "error";
    finish = () => rejectP && rejectP(err);
    if (listeners.error) {
      try {
        listeners.error(err);
      } catch (e) {}
    }
    if (rejectP) rejectP(err);
  };

  xhr.timeout = 60000;
  xhr.ontimeout = () => {
    done = true;
    const err = new Error("Таймаут: сервер не принял файл за 60 секунд");
    task.snapshot.state = "error";
    finish = () => rejectP && rejectP(err);
    if (listeners.error) {
      try {
        listeners.error(err);
      } catch (e) {}
    }
    if (rejectP) rejectP(err);
  };
  xhr.open("POST", SERVER_HTTP + "/upload");
  const tok = authToken();
  if (tok) xhr.setRequestHeader("Authorization", "Bearer " + tok);
  xhr.send(form);
  return task;
}

export async function getDownloadURL(storageRef) {
  if (storageRef && storageRef._url) return storageRef._url;
  throw new Error("Файл ещё не загружен");
}
