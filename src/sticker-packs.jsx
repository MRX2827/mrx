import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiBase, mediaUrl } from "./fb/core.js";
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { ComposerIcon } from "./composer-icon.jsx";

const PACK_ID = /^[a-f0-9]{32}$/;
const IMAGE_PATH = /^\/media\/[a-f0-9]{64}$/;
const MAX_STICKERS = 30;

export function stickerLinkId(text) {
  try {
    const url = new URL(text.trim());
    const path = url.protocol === "mrx:" && url.hostname === "stickers"
      ? url.pathname.slice(1)
      : url.origin === apiBase() && url.pathname.startsWith("/stickers/")
        ? url.pathname.slice("/stickers/".length) : "";
    return PACK_ID.test(path) ? path : null;
  } catch {
    return null;
  }
}

export function stickerLink(id) {
  return apiBase() + "/stickers/" + id;
}

async function readPack(id) {
  if (!PACK_ID.test(id)) throw new Error("Неверная ссылка на набор.");
  const snapshot = await getDoc(doc(db, "stickerPacks", id));
  if (!snapshot.exists()) throw new Error("Набор не найден.");
  const { owner, name, stickers } = snapshot.data();
  return { id, owner, name, stickers: stickers || [] };
}

function cachedPacks(key) {
  try {
    const packs = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(packs) ? packs : [];
  } catch {
    return [];
  }
}

export function useStickerPacks(uid, enabled) {
  const key = "mrx_sticker_packs_" + uid;
  const [state, setState] = useState(() => ({ key, packs: cachedPacks(key) }));
  const packs = state.key === key ? state.packs : cachedPacks(key);

  function apply(update) {
    setState(current => {
      const next = update(current.key === key ? current.packs : cachedPacks(key));
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return { key, packs: next };
    });
  }

  useEffect(() => {
    if (!uid || !enabled) return;
    let generation = 0;
    const unsubscribe = onSnapshot(collection(db, "users", uid, "stickerPacks"), async snapshot => {
      const current = ++generation;
      const ids = snapshot.docs.map(item => item.id);
      const results = await Promise.allSettled(ids.map(readPack));
      if (current !== generation) return;
      apply(previous => ids.flatMap((id, index) => {
        const result = results[index];
        if (result.status === "fulfilled") return [result.value];
        return previous.filter(pack => pack.id === id);
      }));
    }, () => {});
    return () => { generation++; unsubscribe(); };
  }, [uid, enabled]);

  async function install(pack) {
    await setDoc(doc(db, "users", uid, "stickerPacks", pack.id), {});
    apply(previous => [...previous.filter(item => item.id !== pack.id), pack]);
  }

  async function remove(id) {
    await deleteDoc(doc(db, "users", uid, "stickerPacks", id));
    apply(previous => previous.filter(item => item.id !== id));
  }

  return { packs, install, remove };
}

async function uploadSticker(file) {
  if (!["image/png", "image/webp", "image/jpeg"].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error("Выбери PNG, WebP или JPEG размером до 12 МБ.");
  }
  const image = await createImageBitmap(file).catch(() => {
    throw new Error("Не удалось открыть изображение. Попробуй другой файл.");
  });
  const canvas = document.createElement("canvas");
  try {
    const scale = Math.min(1, 512 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    image.close();
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.88));
  if (!blob) throw new Error("Не удалось подготовить изображение.");
  const form = new FormData();
  form.append("file", blob, blob.type === "image/webp" ? "sticker.webp" : "sticker.png");
  const uploaded = await api("/upload", { method: "POST", body: form });
  if (!IMAGE_PATH.test(uploaded?.url || "")) throw new Error("Сервер не сохранил стикер.");
  return uploaded.url;
}

export function StickerPackDialog({ request, uid, library, theme, accentText, onClose }) {
  const [pack, setPack] = useState(null);
  const [editing, setEditing] = useState(request.kind === "create");
  const [name, setName] = useState("");
  const [items, setItems] = useState([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [message, setMessage] = useState("");
  const shadeRef = useRef(null);
  const newId = useRef(null);
  const uploadedFiles = useRef(new Map());
  const objectUrls = useRef(new Set());

  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    const dismiss = () => setClosing(true);
    const setInset = height => shadeRef.current?.style.setProperty("--pack-ime-inset", `${height}px`);
    window.__rmgStickerImeInset = setInset;
    window.addEventListener("mrx:close-sticker-pack", dismiss);
    return () => {
      window.removeEventListener("mrx:close-sticker-pack", dismiss);
      if (window.__rmgStickerImeInset === setInset) delete window.__rmgStickerImeInset;
    };
  }, []);

  const load = async id => {
    const result = await readPack(id);
    setPack(result);
    return result;
  };

  useEffect(() => {
    if (!request.id) return;
    let cancelled = false;
    setBusy(true);
    readPack(request.id).then(result => {
      if (!cancelled) setPack(result);
    }).catch(error => {
      if (!cancelled) setMessage(error.message);
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [request.id]);

  const installed = pack && library.packs.some(item => item.id === pack.id);

  const edit = () => {
    setName(pack.name);
    setItems(pack.stickers.map((src, index) => ({ key: String(index), src })));
    setMessage("");
    setEditing(true);
  };

  const addImages = event => {
    const files = [...event.target.files];
    event.target.value = "";
    const next = files.slice(0, MAX_STICKERS - items.length).map(file => {
      const url = URL.createObjectURL(file);
      objectUrls.current.add(url);
      return { key: url, src: url, file };
    });
    if (files.length > next.length) setMessage("В одном наборе до 30 стикеров.");
    setItems(current => [...current, ...next]);
  };

  const publish = async () => {
    const title = name.trim();
    if (!title || !items.length) { setMessage("Укажи название и добавь хотя бы один стикер."); return; }
    setBusy(true);
    setMessage("");
    try {
      const stickers = [];
      for (const item of items) {
        if (!item.file) { stickers.push(item.src); continue; }
        let path = uploadedFiles.current.get(item.file);
        if (!path) {
          path = await uploadSticker(item.file);
          uploadedFiles.current.set(item.file, path);
        }
        stickers.push(path);
      }
      const id = pack?.id || (newId.current ||= crypto.randomUUID().replaceAll("-", ""));
      const result = { id, owner: uid, name: title, stickers };
      await setDoc(doc(db, "stickerPacks", id), { owner: uid, name: title, stickers });
      setPack(result);
      setEditing(false);
      try { await library.install(result); }
      catch { setMessage("Набор сохранён. Добавь его в панель кнопкой ниже."); }
    } catch (error) {
      setMessage(error.message || "Не удалось сохранить набор.");
    } finally {
      setBusy(false);
    }
  };

  const openLink = async () => {
    const id = stickerLinkId(link);
    if (!id) { setMessage("Вставь ссылку на набор MRX."); return; }
    setBusy(true);
    setMessage("");
    try { await load(id); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };

  const changeInstalled = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (installed) await library.remove(pack.id);
      else await library.install(pack);
    } catch {
      setMessage("Не удалось обновить список наборов.");
    } finally { setBusy(false); }
  };

  const share = async () => {
    const url = stickerLink(pack.id);
    try {
      if (navigator.share) await navigator.share({ title: pack.name, url });
      else {
        await navigator.clipboard.writeText(url);
        setMessage("Ссылка скопирована.");
      }
    } catch (error) {
      if (error.name !== "AbortError") setMessage("Скопируй ссылку из поля ниже.");
    }
  };

  return createPortal(
    <div ref={shadeRef} className="mrx-sticker-shade" data-closing={closing} onClick={() => setClosing(true)}>
      <section className="mrx-sticker-sheet" role="dialog" aria-modal="true" aria-label="Набор стикеров"
        onClick={event => event.stopPropagation()}
        onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === "sheetDownQ") onClose(); }}
        style={{ "--pack-surface": theme.surface, "--pack-card": theme.surface2, "--pack-text": theme.text,
          "--pack-border": theme.border, "--pack-accent": theme.accent, "--pack-on-accent": accentText }}>
        <header><strong>{editing ? (pack ? "Редактировать набор" : "Новый набор") : pack?.name || "Набор по ссылке"}</strong>
          <button className="mrx-sticker-close" aria-label="Закрыть" onClick={() => setClosing(true)}><ComposerIcon name="close" size={18}/></button></header>
        {editing ? <>
          <input aria-label="Название набора" placeholder="Название набора" maxLength={60} value={name}
            onChange={event => setName(event.target.value)} disabled={busy}/>
          <div className="mrx-sticker-preview">{items.map(item =>
            <div key={item.key}>
              <img src={mediaUrl(item.src)} alt=""/>
              <button aria-label="Убрать стикер" disabled={busy} onClick={() => setItems(current => current.filter(value => value.key !== item.key))}>×</button>
            </div>
          )}</div>
          <label className="mrx-sticker-file">
            <ComposerIcon name="add" size={19}/>
            Добавить изображения
            <input type="file" multiple accept="image/png,image/webp,image/jpeg" onChange={addImages}
              disabled={busy || items.length >= MAX_STICKERS}/>
          </label>
          <button className="mrx-sticker-primary" onClick={publish} disabled={busy}>{busy ? "Сохранение…" : "Сохранить набор"}</button>
        </> : pack ? <>
          <div className="mrx-sticker-preview">{pack.stickers.map((src, index) =>
            <img key={index} src={mediaUrl(src)} alt="" loading="lazy"/>)}</div>
          <button className="mrx-sticker-primary" onClick={changeInstalled} disabled={busy}>
            {installed ? "Убрать из моей панели" : "Добавить в панель"}
          </button>
          <div className="mrx-sticker-actions"><button onClick={share}>Поделиться</button>
            {pack.owner === uid && <button onClick={edit} disabled={busy}>Редактировать</button>}</div>
          <input aria-label="Ссылка на набор" value={stickerLink(pack.id)} readOnly onFocus={event => event.target.select()}/>
        </> : request.kind === "link" ? <>
          <input aria-label="Ссылка на набор" placeholder="Вставь ссылку MRX" value={link}
            onChange={event => setLink(event.target.value)} disabled={busy}/>
          <button className="mrx-sticker-primary" onClick={openLink} disabled={busy}>Открыть набор</button>
        </> : null}
        {(message || (busy && !editing)) && <p role="status">{message || "Загрузка…"}</p>}
      </section>
    </div>, document.body
  );
}
