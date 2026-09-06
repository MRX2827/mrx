import React, { useState, useEffect, useLayoutEffect, useRef, createContext, useContext, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { initDB, saveMsg, getMsgs, deleteMsg, updateMsgReactions, updateMsgText, getSetting, setSetting, clearChatMsgs, searchMsgs } from "./db.js";

// ─── Go Server ────────────────────────────────────────────────────────────────
const SERVER_HTTP = "https://redmrxgram.duckdns.org";
const SERVER_WS   = "wss://redmrxgram.duckdns.org";

// Совместимые вызовы данных и файлов идут на собственный сервер.
// Firebase используется отдельно для FCM, поэтому push-плагин не алиасится.
async function serverUpload(file, onProgress) {
  return uploadFileToFirebase(file, "chat", onProgress);
}
async function serverRegister(user) {
  return user || null;
}
async function serverSearch(query) {
  return [];
}

const PUSH_DEVICE_ID_KEY = "rmg_push_device_id";
const PUSH_TOKEN_KEY = "rmg_unifiedpush_registration";
let pushRegistrationUid = "";
let nativePushListenersReady = false;

function getPushDeviceId() {
  let id = "";
  try { id = localStorage.getItem(PUSH_DEVICE_ID_KEY) || ""; } catch (e) {}
  if (id) return id;

  const raw = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}${Math.random()}`;
  id = `d${String(raw).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
  try { localStorage.setItem(PUSH_DEVICE_ID_KEY, id); } catch (e) {}
  return id;
}

function getPushPreferences() {
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem("rmg_s") || "{}"); } catch (e) {}
  const mutedChatIds = Object.entries(settings)
    .filter(([key, value]) => key.startsWith("mute_") && !!value)
    .map(([key]) => key.slice("mute_".length));

  return {
    sound: settings.notifSound !== false,
    vibration: settings.notifVibro !== false,
    preview: settings.notifPreview !== false,
    groups: settings.notifGroups !== false,
    mutedChatIds,
  };
}

async function serverSaveUnifiedPush(userId, registration) {
  if (!userId || !registration?.endpoint || !registration?.keys?.p256dh || !registration?.keys?.auth) return;
  const deviceId = getPushDeviceId();
  await api("/push/unifiedpush", {
    method: "PUT",
    body: {
      deviceId,
      endpoint: registration.endpoint,
      keys: registration.keys,
      preferences: getPushPreferences(),
    },
  });
  try { localStorage.setItem(PUSH_TOKEN_KEY, JSON.stringify(registration)); } catch (e) {}
}

async function syncPushPreferences(userId) {
  if (!userId) return;
  try {
    await api("/push/unifiedpush", {
      method: "PATCH",
      body: {
        deviceId: getPushDeviceId(),
        preferences: getPushPreferences(),
      },
    });
  } catch (e) {}
}

async function clearPushRegistration(userId) {
  if (!userId) return;
  try {
    await api("/push/unifiedpush", { method: "DELETE", body: { deviceId: getPushDeviceId() } });
  } catch (e) {}
  try { localStorage.removeItem(PUSH_TOKEN_KEY); } catch (e) {}
  if (Capacitor.isNativePlatform()) {
    PushNotifications.unregister().catch(() => {});
  }
  if (pushRegistrationUid === userId) pushRegistrationUid = "";
}

// Fallback to localStorage if SQLite not available (web browser)
let _db = null;
let _sqliteReady = false;
// Текущий открытый чат (для подавления Android-уведомлений в foreground)
let _activeChatId = null;

async function initSQLite() {
  try {
    const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    _db = await sqlite.createConnection("rmg_db", false, "no-encryption", 1, false);
    await _db.open();
    await _db.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT,
        author TEXT,
        type TEXT DEFAULT 'text',
        text TEXT DEFAULT '',
        file_data TEXT DEFAULT '',
        file_url TEXT DEFAULT '',
        file_name TEXT DEFAULT '',
        file_type TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0,
        duration TEXT DEFAULT '',
        waveform TEXT DEFAULT '',
        reply_to TEXT DEFAULT '',
        reactions TEXT DEFAULT '',
        video_url TEXT DEFAULT '',
        video_data TEXT DEFAULT '',
        time TEXT DEFAULT '',
        unix_ms INTEGER DEFAULT 0,
        pending INTEGER DEFAULT 0,
        edited INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_msgs_chat ON messages(chat_id, unix_ms ASC);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    _sqliteReady = true;
    console.log("✅ SQLite ready");
  } catch(e) {
    console.log("⚠️ SQLite unavailable, using localStorage:", e.message);
    _sqliteReady = false;
  }
}

const SQLiteDB = {
  // Messages
  async saveMsg(msg) {
    if (!_sqliteReady || !_db) {
      // Fallback: localStorage
      try {
        const key = `rmg_msgs_${msg.chatId}`;
        const arr = JSON.parse(localStorage.getItem(key) || "[]");
        const idx = arr.findIndex(m => m.id === msg.id);
        if (idx >= 0) arr[idx] = msg; else arr.push(msg);
        if (arr.length > 300) arr.splice(0, arr.length - 300);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch {}
      return;
    }
    try {
      await _db.run(
        `INSERT OR REPLACE INTO messages
         (id,chat_id,sender_id,author,type,text,file_data,file_url,file_name,file_type,file_size,
          duration,waveform,reply_to,reactions,video_url,video_data,time,unix_ms,pending,edited)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          msg.id || "", msg.chatId || msg.chat_id || "",
          msg.uid || msg.sender_id || "",
          msg.author || "",
          msg.type || "text",
          msg.text || "",
          msg.fileData || "",
          msg.fileUrl || "",
          msg.fileName || "",
          msg.fileType || "",
          msg.fileSize || 0,
          msg.duration || "",
          JSON.stringify(msg.waveform || []),
          JSON.stringify(msg.replyTo || null),
          JSON.stringify(msg.reactions || {}),
          msg.videoUrl || "",
          msg.videoData || "",
          msg.time || "",
          msg.unixMs || msg.unix_ms || Date.now(),
          msg._pending ? 1 : 0,
          msg.edited ? 1 : 0,
        ]
      );
    } catch(e) { console.warn("SQLite saveMsg error:", e.message); }
  },

  async getMsgs(chatId, limit = 200) {
    if (!_sqliteReady || !_db) {
      try {
        return JSON.parse(localStorage.getItem(`rmg_msgs_${chatId}`) || "[]");
      } catch { return []; }
    }
    try {
      const res = await _db.query(
        `SELECT * FROM messages WHERE chat_id=? ORDER BY unix_ms ASC LIMIT ?`,
        [chatId, limit]
      );
      return (res.values || []).map(row => ({
        id: row.id,
        chatId: row.chat_id,
        uid: row.sender_id,
        author: row.author,
        type: row.type,
        text: row.text,
        fileData: row.file_data,
        fileUrl: row.file_url,
        fileName: row.file_name,
        fileType: row.file_type,
        fileSize: row.file_size,
        duration: row.duration,
        waveform: JSON.parse(row.waveform || "[]"),
        replyTo: JSON.parse(row.reply_to || "null"),
        reactions: JSON.parse(row.reactions || "{}"),
        videoUrl: row.video_url,
        videoData: row.video_data,
        time: row.time,
        unixMs: row.unix_ms,
        _pending: row.pending === 1,
        edited: row.edited === 1,
      }));
    } catch(e) { console.warn("SQLite getMsgs error:", e.message); return []; }
  },

  async deleteMsg(msgId, chatId) {
    if (!_sqliteReady || !_db) {
      try {
        const key = `rmg_msgs_${chatId}`;
        const arr = JSON.parse(localStorage.getItem(key) || "[]").filter(m => m.id !== msgId);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch {}
      return;
    }
    try { await _db.run(`DELETE FROM messages WHERE id=?`, [msgId]); } catch {}
  },

  async updateMsg(msgId, chatId, fields) {
    if (!_sqliteReady || !_db) {
      try {
        const key = `rmg_msgs_${chatId}`;
        const arr = JSON.parse(localStorage.getItem(key) || "[]");
        const idx = arr.findIndex(m => m.id === msgId);
        if (idx >= 0) { arr[idx] = { ...arr[idx], ...fields }; localStorage.setItem(key, JSON.stringify(arr)); }
      } catch {}
      return;
    }
    try {
      const sets = Object.keys(fields).map(k => {
        const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
        return `${col}=?`;
      }).join(",");
      await _db.run(`UPDATE messages SET ${sets} WHERE id=?`,
        [...Object.values(fields).map(v => typeof v === 'object' ? JSON.stringify(v) : v), msgId]);
    } catch {}
  },

  async searchMsgs(chatId, query) {
    if (!_sqliteReady || !_db) {
      try {
        const arr = JSON.parse(localStorage.getItem(`rmg_msgs_${chatId}`) || "[]");
        return arr.filter(m => m.text?.toLowerCase().includes(query.toLowerCase()));
      } catch { return []; }
    }
    try {
      const res = await _db.query(
        `SELECT * FROM messages WHERE chat_id=? AND type='text' AND text LIKE ? ORDER BY unix_ms DESC LIMIT 50`,
        [chatId, `%${query}%`]
      );
      return res.values || [];
    } catch { return []; }
  },

  // Settings (replaces getS/setS)
  async getSetting(key, def = null) {
    if (!_sqliteReady || !_db) {
      try { const s = JSON.parse(localStorage.getItem("rmg_s") || "{}"); return s[key] ?? def; } catch { return def; }
    }
    try {
      const res = await _db.query(`SELECT value FROM settings WHERE key=?`, [key]);
      if (res.values?.length) return JSON.parse(res.values[0].value);
      return def;
    } catch { return def; }
  },

  async setSetting(key, value) {
    if (!_sqliteReady || !_db) {
      try { const s = JSON.parse(localStorage.getItem("rmg_s") || "{}"); s[key] = value; localStorage.setItem("rmg_s", JSON.stringify(s)); } catch {}
      return;
    }
    try { await _db.run(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, [key, JSON.stringify(value)]); } catch {}
  },
};
import { auth, db, storage } from "./firebase";
import { ref as sRef, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, signInAnonymously, registerAccount, verifyEmailCode, resendEmailCode, attachEmail, requestPasswordReset, confirmPasswordReset } from "firebase/auth";
import { collection, doc, setDoc, getDoc, addDoc, query, orderBy, onSnapshot, where, getDocs, serverTimestamp, updateDoc, arrayUnion, limitToLast, startAfter, endBefore, deleteDoc, increment } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "./unified-push-notifications.js";
import { api } from "./fb/core.js";

// ── Скрытые (удалённые у себя) чаты: {chatId: момент удаления ms}. Старый формат-массив мигрируем.
function readHidden(key){
  try{
    const raw=JSON.parse(localStorage.getItem(key)||"{}");
    if(Array.isArray(raw)){const m={};const now=Date.now();raw.forEach(id=>{m[id]=now;});try{localStorage.setItem(key,JSON.stringify(m));}catch(e){}return m;}
    return raw&&typeof raw==="object"?raw:{};
  }catch(e){return{};}
}
function isHiddenChat(hidden,c){
  const at=hidden?.[c?.id];
  if(!at)return false;
  const last=(typeof c?.lastTimeMs==="number")?c.lastTimeMs:0;
  return !(last>at); // есть сообщение новее момента удаления — чат снова виден
}

const directChatId=(a,b)=>[a,b].sort().join("_");
async function ensureDirectChat(currentUser,profile,person){
  const myUid=currentUser?.uid;
  const otherUid=person?.uid||person?.id;
  if(!myUid||!otherUid)throw new Error("missing user id");
  const chatId=directChatId(myUid,otherUid);
  try{
    const hk="rmg_hidden_chats_"+myUid;
    const hm=readHidden(hk);
    if(hm[chatId]){delete hm[chatId];localStorage.setItem(hk,JSON.stringify(hm));}
  }catch(e){}
  const chatRef=doc(db,"chats",chatId);
  const snap=await getDoc(chatRef).catch(()=>null);
  const old=snap?.exists?.()?snap.data():{};
  const myName=profile?.name||currentUser?.displayName||"";
  const otherName=person?.name||person?.displayName||person?.tag||"";
  const members=[...new Set([...(Array.isArray(old.members)?old.members:[]),myUid,otherUid])];
  const names={...(old.names||{}),[myUid]:myName,[otherUid]:otherName};
  const photos={...(old.photos||{}),[myUid]:profile?.photo||profile?.photoURL||"",[otherUid]:person?.photo||person?.photoURL||""};
  const patch={
    id:chatId,
    type:"direct",
    members,
    names,
    photos,
    updatedAt:serverTimestamp()
  };
  if(!snap?.exists?.()){
    patch.created=serverTimestamp();
    patch.lastMsg="";
    patch.lastTime="";
    patch.lastTimeMs=0;
  }
  await setDoc(chatRef,patch,{merge:true});
  return {
    id:chatId,
    ...(old||{}),
    ...patch,
    type:"direct",
    name:otherName,
    tag:person?.tag||"",
    uid:otherUid,
    photo:person?.photo||person?.photoURL||"",
    _partnerPhoto:person?.photo||person?.photoURL||""
  };
}

const uploadFileToFirebase = (file, scope="chat", onProgress)=>new Promise((resolve,reject)=>{
  const safeName=(file?.name||"file").replace(/[^a-zA-Z0-9._-]+/g,"_");
  const type=file?.type||"application/octet-stream";
  const top=type.startsWith("image/")?"images":type.startsWith("video/")?"videos":type.startsWith("audio/")?"audio":"files";
  const path=`${scope}/${top}/${Date.now()}_${Math.random().toString(36).slice(2,8)}_${safeName}`;
  const storageRef=sRef(storage,path);
  const task=uploadBytesResumable(storageRef,file,{contentType:type,customMetadata:{originalName:file?.name||""}});
  task.on("state_changed",snap=>{
    if(onProgress&&snap.totalBytes)onProgress(Math.round((snap.bytesTransferred/snap.totalBytes)*100));
  },err=>reject(err),async()=>{
    try{resolve(await getDownloadURL(task.snapshot.ref));}
    catch(e){reject(e);}
  });
});

async function createVideoPoster(fileOrUrl){
  return new Promise(resolve=>{
    try{
      const video=document.createElement("video");
      const revoke=[];
      video.muted=true;video.playsInline=true;video.preload="metadata";video.crossOrigin="anonymous";
      video.src=typeof fileOrUrl==="string"?fileOrUrl:URL.createObjectURL(fileOrUrl);
      if(typeof fileOrUrl!=="string")revoke.push(video.src);
      const done=(value)=>{revoke.forEach(u=>URL.revokeObjectURL(u));resolve(value||"");};
      const timer=setTimeout(()=>done(""),4500);
      video.onloadeddata=()=>{
        try{video.currentTime=Math.min(0.1,video.duration||0.1);}catch(e){}
      };
      video.onseeked=()=>{
        try{
          clearTimeout(timer);
          const canvas=document.createElement("canvas");
          canvas.width=Math.min(720,video.videoWidth||360);
          canvas.height=Math.round(canvas.width*((video.videoHeight||640)/(video.videoWidth||360)));
          canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
          done(canvas.toDataURL("image/jpeg",0.72));
        }catch(e){clearTimeout(timer);done("");}
      };
      video.onerror=()=>{clearTimeout(timer);done("");};
    }catch(e){resolve("");}
  });
}

// ─── Universal download helper ────────────────────────────────────────────────
// Сохраняет файл на устройство: Capacitor Filesystem (Android) или <a> (браузер)
async function downloadToDevice(src, fileName){
  if(!src)return;
  const isNative=window?.Capacitor?.isNativePlatform?.();

  const showToast=async(msg)=>{
    try{
      const {Toast}=await import("@capacitor/toast");
      await Toast.show({text:msg,duration:"short",position:"bottom"});
    }catch(e){alert(msg);}
  };

  if(isNative){
    try{
      const {Filesystem,Directory}=await import("@capacitor/filesystem");

      // Запрашиваем разрешение
      try{await Filesystem.requestPermissions();}catch(pe){}

      const dir=Directory.ExternalStorage;
      const path="Download/"+fileName;

      if(src.startsWith("data:")){
        // base64 data URL — пишем напрямую
        const b64=src.split(",")[1]||"";
        let written=false;
        try{
          await Filesystem.writeFile({path,data:b64,directory:dir,recursive:true});
          written=true;
        }catch(e1){
          await Filesystem.writeFile({path:fileName,data:b64,directory:Directory.Documents,recursive:true});
          written=true;
        }
        if(written)await showToast("✅ Сохранено в Загрузки");
      }else{
        // Внешний URL — используем downloadFile (нативный Java, обходит CORS WebView)
        let downloaded=false;
        try{
          await Filesystem.downloadFile({
            path,
            url:src,
            directory:dir,
            recursive:true,
          });
          downloaded=true;
        }catch(e1){
          // Fallback: Documents
          try{
            await Filesystem.downloadFile({
              path:fileName,
              url:src,
              directory:Directory.Documents,
              recursive:true,
            });
            downloaded=true;
          }catch(e2){
            // Последний fallback: fetch → base64
            const resp=await fetch(src,{mode:"no-cors"});
            const blob=await resp.blob();
            const b64=await new Promise((res,rej)=>{
              const r=new FileReader();
              r.onload=()=>res((r.result||"").split(",")[1]||"");
              r.onerror=rej;
              r.readAsDataURL(blob);
            });
            await Filesystem.writeFile({path:fileName,data:b64,directory:Directory.Documents,recursive:true});
            downloaded=true;
          }
        }
        if(downloaded)await showToast("✅ Сохранено в Загрузки");
      }
    }catch(e){
      console.warn("downloadToDevice error:",e);
      // Последний аварийный вариант — открыть в браузере
      await showToast("⬇️ Открываем в браузере...");
      setTimeout(()=>window.open(src,"_blank"),400);
    }
  }else{
    // Браузер
    const a=document.createElement("a");
    a.href=src;a.download=fileName;a.target="_blank";
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);
  }
}


// ─── Оффлайн-режим: пользовательский локальный архив ──────────────────────────
// Отдельное хранилище от db.js (тот — автокэш последних сообщений). Сюда
// переписки и файлы попадают по правилам, которые пользователь задаёт в
// Настройках → «Оффлайн-сохранение». Хранилище — IndexedDB: работает и в
// браузере, и в Capacitor WebView, и вмещает крупные файлы (в отличие от
// localStorage). Логически каждый чат = отдельная «папка» (запись в store
// "chats"), файлы чата лежат рядом в store "files" с префиксом chatId.
const OFFLINE_DEFAULTS = { mode:"always", type:"full", fileLimit:0 };

// Чтение настроек оффлайн-сохранения из общего объекта rmg_s (с дефолтами).
function getOfflineSettings(){
  let s={};
  try{ s=JSON.parse(localStorage.getItem("rmg_s")||"{}"); }catch{}
  return {
    mode:      "always",            // "always" | "manual"
    type:      "full",            // "full"   | "text"
    fileLimit: 0,
  };
}

const OfflineStore = {
  _db:null,
  _capHttp:undefined, // ленивая загрузка @capacitor/core (CapacitorHttp) — undefined=ещё не пробовали, null=недоступен

  _open(){
    if(this._db) return Promise.resolve(this._db);
    return new Promise((resolve,reject)=>{
      let req;
      // v2: добавлен store "chatLists" — оффлайн-кэш списка чатов пользователя.
      // IndexedDB переживает чистку памяти Android-системой гораздо надёжнее, чем
      // localStorage, поэтому используем его как основное персистентное хранилище
      // для метаданных чатов (имя, последнее сообщение, фото и т.п.).
      try{ req=indexedDB.open("mrx_offline_db",2); }
      catch(e){ reject(e); return; }
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains("chats")) db.createObjectStore("chats",{keyPath:"chatId"});
        if(!db.objectStoreNames.contains("files")) db.createObjectStore("files",{keyPath:"key"});
        if(!db.objectStoreNames.contains("chatLists")) db.createObjectStore("chatLists",{keyPath:"uid"});
      };
      req.onsuccess=()=>{ this._db=req.result; resolve(this._db); };
      req.onerror=()=>reject(req.error);
    });
  },
  async _store(name,mode){
    const db=await this._open();
    return db.transaction(name,mode).objectStore(name);
  },
  // Обёртка IDBRequest → Promise. Важно: внутри одной транзакции делаем
  // максимум один await _p — иначе транзакция может «уснуть» между await'ами.
  _p(req){ return new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); }); },

  async init(){
    try{ await this._open(); }
    catch(e){ console.warn("OfflineStore init failed:",e&&e.message); }
  },

  _unixOf(m){
    if(m && m.unixMs) return m.unixMs;
    if(m && m.createdAt){
      if(typeof m.createdAt.toDate==="function"){ try{ return m.createdAt.toDate().getTime(); }catch{} }
      if(m.createdAt.seconds)  return m.createdAt.seconds*1000;
      if(m.createdAt._seconds) return m.createdAt._seconds*1000;
    }
    return Date.now();
  },

  // Определяем "вид" вложения по сообщению — нужно знать, в какое поле его потом
  // подмешивать при оффлайн-чтении (fileData vs videoData vs audioData).
  _kindOf(m){
    if(!m) return "file";
    if(m.type==="video"||m.type==="circle") return "video";
    if(m.type==="voice"||m.type==="audio") return "audio";
    if(m.type==="image") return "image";
    const ft=String(m.fileType||"");
    if(ft.startsWith("video/")) return "video";
    if(ft.startsWith("audio/")) return "audio";
    if(ft.startsWith("image/")) return "image";
    return "file";
  },

  // Сообщение с файлом → «оболочка» (метаданные есть, данные файла — нет).
  // Стрипаем ВСЕ возможные поля с данными — иначе в chats-store сохранится дубликат
  // (для voice ранее текли audioUrl/audioData, потому что их не удаляли).
  _stripFile(m){
    const c={...m};
    delete c.fileData; delete c.fileUrl;
    delete c.videoData; delete c.videoUrl;
    delete c.audioData; delete c.audioUrl;
    c._shell=true;
    return c;
  },

  _sizeAllowed(size,limitMb){
    if(!limitMb||limitMb<=0) return true;   // безлимит
    if(!size) return true;                  // размер неизвестен — не блокируем
    return size <= limitMb*1024*1024;
  },

  _hasFile(m){
    return !!(m && (m.fileUrl||m.fileData||m.videoUrl||m.videoData ||
      m.audioUrl||m.audioData ||
      ["image","video","file","audio","voice","circle"].includes(m.type)));
  },

  // Источник медиа в сообщении (data:URL или http(s) URL). Поддерживает все три
  // канала: file*, video*, audio*. Возвращает первое непустое.
  _srcOf(m){
    return m.fileUrl||m.fileData||m.videoUrl||m.videoData||m.audioUrl||m.audioData||"";
  },

  // Сохранить переписку (текст + метаданные файлов). Данные файлов — отдельно,
  // и только если тип сохранения = «Переписки и файлы».
  // Новые сообщения ДОБАВЛЯЮТСЯ к уже сохранённым (merge по id), а не заменяют их —
  // это важно для режима «Всегда», где onSnapshot приносит лишь последние сообщения.
  // Возвращает {savedFiles, shellFiles}.
  async saveLocalFile(chatId,m,file){
    if(!chatId||!m?.id||!file)return false;
    try{
      const dataUrl=await new Promise((res,rej)=>{
        const r=new FileReader();
        r.onload=()=>res(r.result);
        r.onerror=()=>rej(new Error("FileReader error"));
        r.readAsDataURL(file);
      });
      const kind=this._kindOf(m);
      const st=await this._store("files","readwrite");
      await this._p(st.put({
        key:chatId+"::"+m.id,
        chatId,msgId:m.id,
        name:m.fileName||file.name||"",
        type:m.fileType||file.type||"",
        kind,
        size:file.size||m.fileSize||0,
        data:dataUrl,
        savedAt:Date.now(),
      }));
      return true;
    }catch(e){
      console.warn("[offline] saveLocalFile failed:",e?.message||e);
      return false;
    }
  },

  async saveChat(chatId, messages, chatMeta){
    if(!chatId || !Array.isArray(messages)) return {savedFiles:0,shellFiles:0};
    const settings=getOfflineSettings();
    const MAX_PER_CHAT=5000; // разумный потолок, чтобы архив не рос бесконечно

    // Нормализуем + делаем сериализуемыми (Firestore Timestamp → {seconds}).
    const norm=messages.map(m=>{
      const unixMs=this._unixOf(m);
      let base={...m, chatId, unixMs};
      base.createdAt={seconds:Math.floor(unixMs/1000)};
      if(this._hasFile(base)) base=this._stripFile(base);
      return base;
    });
    let safe;
    try{ safe=JSON.parse(JSON.stringify(norm)); }
    catch(e){ safe=norm; }

    try{
      // Одна readwrite-транзакция: читаем существующую запись и пишем объединённую.
      const st=await this._store("chats","readwrite");
      let prev=null;
      try{ prev=await this._p(st.get(chatId)); }catch(e){}

      const byId=new Map();
      if(prev && Array.isArray(prev.messages)){
        prev.messages.forEach(m=>{ if(m&&m.id) byId.set(m.id,m); });
      }
      // Новые версии перекрывают старые (правки текста, реакции, отметки о прочтении).
      safe.forEach(m=>{ if(m&&m.id) byId.set(m.id,m); });

      let merged=Array.from(byId.values()).sort((a,b)=>(a.unixMs||0)-(b.unixMs||0));
      if(merged.length>MAX_PER_CHAT) merged=merged.slice(merged.length-MAX_PER_CHAT);

      await this._p(st.put({
        chatId,
        name: (chatMeta&&chatMeta.name) || (prev&&prev.name) || "",
        type: (chatMeta&&chatMeta.type) || (prev&&prev.type) || "",
        // Сохраняем фото собеседника для оффлайн-режима (чтобы аватарка
        // не пропадала при входе в чат без интернета).
        partnerPhoto: (chatMeta&&chatMeta.partnerPhoto) || (prev&&prev.partnerPhoto) || "",
        messages: merged,
        msgCount: merged.length,
        savedAt: Date.now(),
      }));
    }catch(e){ console.warn("OfflineStore.saveChat:",e&&e.message); }

    // Файлы — только в режиме «Переписки и файлы».
    let savedFiles=0, shellFiles=0;
    if(settings.type==="full"){
      // Собираем все сообщения с файлами, которых ещё нет в архиве.
      const fileMessages=[];
      for(const m of messages){
        if(!this._hasFile(m)) continue;
        const src=this._srcOf(m);
        if(!src || !this._sizeAllowed(m.fileSize,settings.fileLimit)){
          shellFiles++;
          continue;
        }
        fileMessages.push({m,src});
      }

      // Batch-проверка: за один запрос получаем ВСЕ файлы чата и фильтруем.
      let existingKeys=new Set();
      try{
        const fst=await this._store("files","readonly");
        const all=await this._p(fst.getAll());
        (all||[]).forEach(f=>{ if(f.chatId===chatId) existingKeys.add(f.msgId); });
      }catch(e){}

      const needFetch=fileMessages.filter(({m})=>!existingKeys.has(m.id));
      savedFiles=fileMessages.filter(({m})=>existingKeys.has(m.id)).length;
      shellFiles+=messages.filter(m=>this._hasFile(m)&&!this._srcOf(m)).length;

      // Параллельная загрузка: максимум 3 файла одновременно (чтобы не перегружать
      // сеть и не блокировать UI). Каждый файл защищён таймаутом внутри
      // _fetchAndSaveFile, так что «зависший» файл не остановит остальные.
      const CONCURRENCY=3;
      for(let i=0;i<needFetch.length;i+=CONCURRENCY){
        const batch=needFetch.slice(i,i+CONCURRENCY);
        const results=await Promise.all(
          batch.map(({m,src})=>this._fetchAndSaveFile(chatId,m,src).catch(()=>false))
        );
        results.forEach(ok=>{ if(ok) savedFiles++; else shellFiles++; });
      }
    }else{
      shellFiles=messages.filter(m=>this._hasFile(m)).length;
    }
    return {savedFiles,shellFiles};
  },

  async _fileExists(chatId,msgId){
    try{
      const st=await this._store("files","readonly");
      const r=await this._p(st.get(chatId+"::"+msgId));
      return !!r;
    }catch{ return false; }
  },

  // Ленивая инициализация CapacitorHttp. На Android он обходит CORS WebView'а
  // (запросы идут через нативный Java/Kotlin-код). В чистом браузере его нет —
  // возвращаем null и довольствуемся обычным fetch.
  async _getCapHttp(){
    if(this._capHttp!==undefined) return this._capHttp;
    try{
      const mod=await import("@capacitor/core");
      const isNative=mod?.Capacitor?.isNativePlatform?.();
      if(isNative && mod.CapacitorHttp){
        this._capHttp=mod.CapacitorHttp;
      }else{
        this._capHttp=null;
      }
    }catch(e){
      this._capHttp=null;
    }
    return this._capHttp;
  },

  // base64-данные из CapacitorHttp → data:URL
  _b64ToDataUrl(b64, mime){
    return "data:"+(mime||"application/octet-stream")+";base64,"+b64;
  },

  // оценить размер data:URL (полезная нагрузка ≈ 0.75 от base64-части)
  _dataUrlSize(dataUrl){
    try{
      const i=dataUrl.indexOf(",");
      if(i<0) return 0;
      return Math.round((dataUrl.length-i-1)*0.75);
    }catch{ return 0; }
  },

  // Утилита: fetch с таймаутом через AbortController.
  // В отличие от «голого» fetch, гарантирует отклонение promise по таймауту.
  async _fetchWithTimeout(url,ms=10000){
    const ctrl=new AbortController();
    const t=setTimeout(()=>ctrl.abort(),ms);
    try{
      const resp=await fetch(url,{signal:ctrl.signal,redirect:"follow"});
      clearTimeout(t);
      return resp;
    }catch(e){
      clearTimeout(t);
      throw e;
    }
  },

  // Утилита: обёртка Promise с таймаутом.
  _withTimeout(promise,ms,label){
    return Promise.race([
      promise,
      new Promise((_,rej)=>setTimeout(()=>rej(new Error(label||"timeout")),ms)),
    ]);
  },

  async _fetchAndSaveFile(chatId,m,src){
    // Общий таймаут на всю операцию: 45 с (fetch + FileReader + IDB put).
    return this._withTimeout(this.__fetchAndSaveFileInner(chatId,m,src),45000,"_fetchAndSaveFile timeout");
  },

  async __fetchAndSaveFileInner(chatId,m,src){
    const kind=this._kindOf(m);
    const limitMb=getOfflineSettings().fileLimit;

    let dataUrl=null;
    let bytes=Number(m.fileSize)||0;

    // 1. data:URL — копируем как есть (это уже встроенный файл).
    if(typeof src==="string" && src.startsWith("data:")){
      dataUrl=src;
      if(!bytes) bytes=this._dataUrlSize(dataUrl);
      if(!this._sizeAllowed(bytes,limitMb)){
        console.warn("[offline] file too large (data:URL):",bytes,">",limitMb,"MB");
        return false;
      }
    }else{
      // 2. Пробуем обычный fetch с таймаутом (работает в web и в Capacitor если CORS ок).
      let fetched=false;
      try{
        const resp=await this._fetchWithTimeout(src,10000); // 10 с на fetch
        if(resp.ok){
          const blob=await resp.blob();
          if(!this._sizeAllowed(blob.size,limitMb)){
            console.warn("[offline] file too large:",blob.size,">",limitMb,"MB",src);
            return false;
          }
          dataUrl=await new Promise((res,rej)=>{
            const r=new FileReader();
            r.onload=()=>res(r.result);
            r.onerror=()=>rej(new Error("FileReader error"));
            r.readAsDataURL(blob);
          });
          bytes=blob.size;
          fetched=true;
        }else{
          console.warn("[offline] fetch returned not-ok:",resp.status,src);
        }
      }catch(fetchErr){
        // Чаще всего — CORS в WebView для серверов без `Access-Control-Allow-Origin`,
        // либо таймаут сети (AbortError).
        console.warn("[offline] fetch failed, trying CapacitorHttp fallback:",fetchErr?.name||fetchErr?.message||fetchErr,src);
      }

      // 3. Fallback: CapacitorHttp (Android) — обходит CORS через нативный канал.
      if(!fetched){
        const cap=await this._withTimeout(this._getCapHttp(),5000,"_getCapHttp timeout");
        if(!cap){
          console.warn("[offline] no CapacitorHttp available — file stays as shell:",src);
          return false;
        }
        try{
          const resp=await cap.get({
            url:src,
            responseType:"blob",
            // CapacitorHttp readTimeout по умолчанию короткий — на крупные файлы тянемся подольше.
            connectTimeout:15000,
            readTimeout:60000,
          });
          if(!resp || (resp.status&&(resp.status<200||resp.status>=300))){
            console.warn("[offline] CapacitorHttp not-ok:",resp&&resp.status,src);
            return false;
          }
          // responseType=blob → resp.data это base64-строка.
          const b64=resp.data;
          if(typeof b64!=="string" || !b64){
            console.warn("[offline] CapacitorHttp: empty body",src);
            return false;
          }
          const mime=(resp.headers&&(resp.headers["content-type"]||resp.headers["Content-Type"]))
                    || m.fileType || "application/octet-stream";
          dataUrl=this._b64ToDataUrl(b64, mime.split(";")[0].trim());
          bytes=this._dataUrlSize(dataUrl);
          if(!this._sizeAllowed(bytes,limitMb)){
            console.warn("[offline] CapacitorHttp: file too large",bytes,">",limitMb,"MB");
            return false;
          }
        }catch(capErr){
          console.warn("[offline] CapacitorHttp failed:",capErr?.message||capErr,src);
          return false;
        }
      }
    }

    if(!dataUrl) return false;

    // 4. Пишем в files-store. ВАЖНО: сохраняем `kind` отдельно от MIME, чтобы при
    //    чтении точно знать, в какое поле подмешать (audioData/videoData/fileData).
    try{
      const st=await this._store("files","readwrite");
      await this._p(st.put({
        key:chatId+"::"+m.id,
        chatId, msgId:m.id,
        name:m.fileName||"",
        type:m.fileType||"",
        kind,                    // image | video | audio | file
        size:bytes||m.fileSize||0,
        data:dataUrl,
        savedAt:Date.now(),
      }));
      return true;
    }catch(e){
      console.warn("[offline] IDB put failed:",e?.message||e);
      return false;
    }
  },

  // Прочитать переписку для оффлайн-просмотра — с подмешанными файлами.
  async getChat(chatId){
    try{
      const cst=await this._store("chats","readonly");
      const rec=await this._p(cst.get(chatId));
      if(!rec || !Array.isArray(rec.messages)) return [];
      // Все файлы чата — одним запросом (без await'ов внутри транзакции).
      const fileMap={};
      try{
        const fst=await this._store("files","readonly");
        const all=await this._p(fst.getAll());
        (all||[]).forEach(f=>{ if(f.chatId===chatId) fileMap[f.msgId]=f; });
      }catch{}
      return rec.messages.map(m=>{
        const f=fileMap[m.id];
        if(m._shell && f && f.data){
          const mm={...m};
          // Определяем "вид" приоритетно по сохранённому kind, а если его нет
          // (старая запись до апгрейда) — fallback на MIME / тип сообщения.
          const kind = f.kind
            || ((f.type||"").startsWith("video/")||m.type==="video"||m.type==="circle" ? "video"
              : (f.type||"").startsWith("audio/")||m.type==="voice"||m.type==="audio" ? "audio"
              : "file");
          if(kind==="video")      mm.videoData=f.data;
          else if(kind==="audio") mm.audioData=f.data;
          else                    mm.fileData=f.data;
          delete mm._shell;
          return mm;
        }
        return m;
      });
    }catch(e){ return []; }
  },

  // Прочитать метаданные чата (name, type, partnerPhoto) — для оффлайн-режима,
  // когда нужно восстановить аватарку собеседника без запроса к Firestore.
  async getChatMeta(chatId){
    try{
      const st=await this._store("chats","readonly");
      const rec=await this._p(st.get(chatId));
      if(!rec) return null;
      return {
        name: rec.name || "",
        type: rec.type || "",
        partnerPhoto: rec.partnerPhoto || "",
        msgCount: rec.msgCount || 0,
        savedAt: rec.savedAt || 0,
      };
    }catch{ return null; }
  },

  async listChats(){
    try{
      const st=await this._store("chats","readonly");
      return (await this._p(st.getAll()))||[];
    }catch{ return []; }
  },

  // ── Оффлайн-кэш СПИСКА чатов пользователя ─────────────────────────────────
  // Это отдельное хранилище от `chats` (там — пользовательский архив переписок).
  // Сюда дублируется список чатов из Firestore, чтобы при запуске без интернета
  // мы могли восстановить главный экран мессенджера, даже если localStorage
  // был очищен системой/обновлением WebView (на Android это случается).
  // Ключ — uid пользователя, значение — массив объектов чатов с метаданными.
  async saveChatList(uid, chats){
    if(!uid || !Array.isArray(chats)) return;
    try{
      // Чистим объекты от «тяжёлых»/runtime-полей перед записью.
      // _partnerPhoto — это рантайм-поле, добавляемое в onSnapshot; нет смысла
      // его кэшировать (фото партнёра отдельно лежит в mrx_photos).
      const lean=chats.map(c=>{
        const cc={...c};
        delete cc._partnerPhoto;
        // Если фото чата — гигантская base64-строка, обрезаем, чтобы не упасть
        // в QuotaExceeded при большом числе чатов. URL и небольшие base64 — ок.
        if(typeof cc.photo==="string" && cc.photo.length>200000) delete cc.photo;
        return cc;
      });
      const st=await this._store("chatLists","readwrite");
      await this._p(st.put({uid, chats:lean, savedAt:Date.now()}));
    }catch(e){ console.warn("OfflineStore.saveChatList:", e&&e.message); }
  },

  async getChatList(uid){
    if(!uid) return [];
    try{
      const st=await this._store("chatLists","readonly");
      const rec=await this._p(st.get(uid));
      return (rec && Array.isArray(rec.chats)) ? rec.chats : [];
    }catch(e){ return []; }
  },

  async clearChatList(uid){
    try{
      const st=await this._store("chatLists","readwrite");
      if(uid) await this._p(st.delete(uid));
      else    await this._p(st.clear());
    }catch{}
  },

  // Статистика для экрана настроек.
  async getStats(){
    let chatCount=0,msgCount=0,fileCount=0,fileBytes=0;
    try{
      const cs=await this.listChats();
      chatCount=cs.length;
      msgCount=cs.reduce((a,c)=>a+(c.msgCount||0),0);
      const fst=await this._store("files","readonly");
      const files=(await this._p(fst.getAll()))||[];
      fileCount=files.length;
      fileBytes=files.reduce((a,f)=>a+(f.data?Math.round(f.data.length*0.75):0),0);
    }catch{}
    return {chatCount,msgCount,fileCount,fileBytes};
  },

  // ── Очистка локального архива ──
  async clearFiles(){
    try{ const st=await this._store("files","readwrite"); await this._p(st.clear()); }catch{}
  },
  async clearChatsAndFiles(){
    try{ const st=await this._store("chats","readwrite"); await this._p(st.clear()); }catch{}
    await this.clearFiles();
  },
  async clearAll(){
    // Список чатов архива забираем ДО очистки — пригодится для зачистки кэша db.js.
    let archivedIds=[];
    try{ archivedIds=(await this.listChats()).map(c=>c.chatId).filter(Boolean); }catch{}
    await this.clearChatsAndFiles();
    // Плюс — авто-кэш сообщений из db.js (SQLite на Android / localStorage в web).
    for(const cid of archivedIds){
      try{ await clearChatMsgs(cid); }catch{}
    }
    // На случай web-fallback'а — подчищаем и прямые ключи localStorage.
    try{
      Object.keys(localStorage).forEach(k=>{ if(k.startsWith("rmg_msgs_")) localStorage.removeItem(k); });
    }catch{}
  },
};

// ─── Жёлтый мини-бар «оффлайн режим» ─────────────────────────────────────────
// Показывается в шапке каждого экрана, пока нет интернета.
//  • topInset=true  — бар сам отрисовывается под «чёлкой» (он самый верхний);
//  • fixed=true     — позиционируется фиксированно (для экранов без шапки).
function OfflineBar({topInset=true,fixed=false}){
  const base={
    flexShrink:0,
    background:"linear-gradient(180deg,#FFD60A 0%,#FFC400 100%)",
    color:"#3D2E00",
    paddingTop: topInset ? "max(env(safe-area-inset-top,28px),28px)" : 6,
    paddingBottom:6, paddingLeft:12, paddingRight:12,
    fontSize:12, fontWeight:800, letterSpacing:0.2,
    display:"flex", alignItems:"center", justifyContent:"center", gap:6,
    boxShadow:"0 1px 8px rgba(0,0,0,0.28)",
    textAlign:"center",
  };
  const style = fixed
    ? {...base, position:"fixed", top:0, left:0, right:0, zIndex:50}
    : base;
  return(
    <div style={style}>
      <span style={{fontSize:13}}>📴</span>
      <span>Оффлайн режим — нет подключения к интернету</span>
    </div>
  );
}


const ThemeCtx = createContext({bg:'#000',surface:'#111',surface2:'#1a1a1a',border:'#222',text:'#fff',text2:'#888',accent:'#E53935',accent2:'#B71C1C'});

// ─── Единая функция форматирования скорости ───────────────────────────────────
// Используется в AudioPlayerScreen, MiniPlayer, SpeedPopup для единообразия
const formatSpeed=(s)=>`${s}×`;

// ─── Global Music Player ─────────────────────────────────────────────────────
// ─── Global Audio Engine (singleton, survives React re-renders) ───────────────
const AudioCtx = createContext(null);

const AUDIO_ENGINE = {
  el: null,
  queue: [],
  idx: -1,
  playing: false,
  shuffle: false,
  repeat: "off",   // "off" | "one" | "all"
  speed: 1,
  posCache: {},    // { [trackId]: seconds }
  historyStack: [], // История индексов для корректного prev() в shuffle-режиме
  _lastMediaPosUpdate: 0,
  listeners: new Set(),

  get track(){ return this.queue[this.idx] || null; },

  notify(){
    const snap={
      queue:[...this.queue], idx:this.idx,
      track:this.track, playing:this.playing,
      shuffle:this.shuffle, repeat:this.repeat, speed:this.speed,
    };
    try{this.listeners.forEach(fn=>{try{fn(snap);}catch(e){}});}catch(e){}
  },

  _buildEl(src){
    if(this.el){try{this.el.pause();this.el.src="";}catch(e){}}
    const a=new Audio(src);
    a.playbackRate=this.speed;
    a.onended=()=>{
      if(this.repeat==="one"){a.currentTime=0;a.play().catch(()=>{});return;}
      const ni=this._nextIdx();
      if(ni!==-1){this.jumpTo(ni);}else{this.playing=false;this.notify();}
    };
    this.el=a;
    return a;
  },

  _nextIdx(){
    if(!this.queue.length)return -1;
    if(this.shuffle){
      const cands=this.queue.map((_,i)=>i).filter(i=>i!==this.idx);
      if(!cands.length)return this.repeat==="all"?this.idx:-1;
      return cands[Math.floor(Math.random()*cands.length)];
    }
    if(this.idx<this.queue.length-1)return this.idx+1;
    return this.repeat==="all"?0:-1;
  },

  _prevIdx(){
    if(!this.queue.length)return -1;
    if(this.shuffle){
      // В shuffle-режиме возвращаемся к предыдущему прослушанному треку из historyStack
      if(this.historyStack.length>0){
        return this.historyStack[this.historyStack.length-1];
      }
      return -1;
    }
    if(this.idx>0)return this.idx-1;
    return this.repeat==="all"?this.queue.length-1:-1;
  },

  _savePos(){
    const t=this.track;
    if(t&&this.el)this.posCache[t.id]=this.el.currentTime;
    try{localStorage.setItem("rmg_audio_positions",JSON.stringify(this.posCache));}catch(e){}
  },

  jumpTo(i,fromPrev=false){
    this._savePos();
    // Сохраняем текущий индекс в историю (только при движении вперёд, не при prev)
    if(!fromPrev&&this.idx!==-1&&this.idx!==i){
      this.historyStack.push(this.idx);
      if(this.historyStack.length>50)this.historyStack.shift(); // Ограничиваем размер
    }
    this.idx=i;
    const t=this.track;
    if(!t){this.playing=false;this.notify();return;}
    const a=this._buildEl(t.src);
    const pos=this.posCache[t.id]||0;
    if(pos>2)a.currentTime=pos;
    a.play().then(()=>{this.playing=true;this._updateMediaSession();this.notify();}).catch(()=>{this.playing=false;this.notify();});
    this.notify();
  },

  playTrack(track){
    // If already in queue, jump to it
    const ex=this.queue.findIndex(t=>t.id===track.id);
    if(ex!==-1){this.jumpTo(ex);return;}
    this._savePos();
    // Insert new track at current position, shift old
    if(this.idx===-1){
      this.queue=[track];
      this.idx=0;
    }else{
      this.queue.splice(this.idx,0,track);
    }
    this.jumpTo(this.idx);
    this._persist();
  },

  addToQueue(track){
    if(this.queue.findIndex(t=>t.id===track.id)!==-1)return;
    this.queue.push(track);
    if(this.idx===-1){this.jumpTo(0);}
    this.notify();
    this._persist();
  },

  play(){
    if(!this.el||!this.track)return;
    this.el.play().then(()=>{this.playing=true;this._updateMediaSession();this.notify();}).catch(()=>{});
  },

  pause(){
    if(!this.el)return;
    this.el.pause();
    this.playing=false;
    this._updateMediaSession();
    this.notify();
  },

  next(){const ni=this._nextIdx();if(ni!==-1)this.jumpTo(ni);},
  prev(){
    if(this.el&&this.el.currentTime>3){this.el.currentTime=0;return;}
    if(this.shuffle&&this.historyStack.length>0){
      const pi=this.historyStack.pop();
      this.jumpTo(pi,true);
      return;
    }
    const pi=this._prevIdx();if(pi!==-1)this.jumpTo(pi,true);
  },

  seek(ratio){if(!this.el||!this.el.duration)return;this.el.currentTime=ratio*this.el.duration;this._updateMediaSessionPosition(true);},
  seekTo(sec){if(!this.el)return;this.el.currentTime=sec;this._updateMediaSessionPosition(true);},

  setSpeed(s){
    this.speed=s;
    if(this.el)this.el.playbackRate=s;
    this._updateMediaSessionPosition(true);
    this.notify();this._persist();
  },

  setRepeat(m){this.repeat=m;this.notify();this._persist();},
  setShuffle(v){this.shuffle=v;this.notify();this._persist();},

  removeFromQueue(i){
    this._savePos();
    this.queue.splice(i,1);
    if(i<this.idx)this.idx--;
    else if(i===this.idx){
      if(!this.queue.length){this.stop();return;}
      if(this.idx>=this.queue.length)this.idx=this.queue.length-1;
      this.jumpTo(this.idx);
    }
    this.notify();this._persist();
  },

  reorderQueue(from,to){
    if(from===to||from<0||to<0||from>=this.queue.length||to>=this.queue.length)return;
    const item=this.queue.splice(from,1)[0];
    this.queue.splice(to,0,item);
    // Adjust current index
    if(this.idx===from){this.idx=to;}
    else if(from<this.idx&&to>=this.idx){this.idx--;}
    else if(from>this.idx&&to<=this.idx){this.idx++;}
    this.notify();this._persist();
  },

  stop(){
    this._savePos();
    if(this.el){try{this.el.pause();this.el.src="";}catch(e){}this.el=null;}
    this.playing=false;this.idx=-1;this.queue=[];this.historyStack=[];
    this.notify();this._persist();
  },

  _updateMediaSession(){
    if(!("mediaSession" in navigator))return;
    const t=this.track;if(!t)return;
    try{
      navigator.mediaSession.metadata=new MediaMetadata({
        title:t.name||"Audio",
        artist:t.author||t.chatName||"RedMrxGram",
        album:t.ext||"",
        artwork:t.coverUrl?[{src:t.coverUrl,sizes:"512x512",type:"image/png"}]:[]
      });
      navigator.mediaSession.playbackState=this.playing?"playing":"paused";
      navigator.mediaSession.setActionHandler("play",()=>this.play());
      navigator.mediaSession.setActionHandler("pause",()=>this.pause());
      navigator.mediaSession.setActionHandler("previoustrack",()=>this.prev());
      navigator.mediaSession.setActionHandler("nexttrack",()=>this.next());
      navigator.mediaSession.setActionHandler("seekto",({seekTime})=>this.seekTo(seekTime));
      navigator.mediaSession.setActionHandler("seekbackward",()=>this.seekTo(Math.max(0,(this.el?.currentTime||0)-10)));
      navigator.mediaSession.setActionHandler("seekforward",()=>this.seekTo(Math.min(this.el?.duration||0,(this.el?.currentTime||0)+10)));
      navigator.mediaSession.setActionHandler("stop",()=>this.pause());
      this._updateMediaSessionPosition(true);
    }catch(e){}
  },

  _updateMediaSessionPosition(force=false){
    if(!("mediaSession" in navigator)||!navigator.mediaSession?.setPositionState)return;
    const el=this.el;
    if(!el||!isFinite(el.duration)||el.duration<=0)return;
    const now=Date.now();
    if(!force&&now-this._lastMediaPosUpdate<900)return;
    this._lastMediaPosUpdate=now;
    try{
      navigator.mediaSession.setPositionState({
        duration:el.duration,
        playbackRate:this.speed||1,
        position:Math.max(0,Math.min(el.duration,el.currentTime||0)),
      });
      navigator.mediaSession.playbackState=this.playing?"playing":"paused";
    }catch(e){}
  },

  _persist(){
    try{
      localStorage.setItem("rmg_audio_queue",JSON.stringify(this.queue));
      localStorage.setItem("rmg_audio_idx",String(this.idx));
      localStorage.setItem("rmg_audio_settings",JSON.stringify({shuffle:this.shuffle,repeat:this.repeat,speed:this.speed}));
    }catch(e){}
  },

  restore(){
    try{
      const q=JSON.parse(localStorage.getItem("rmg_audio_queue")||"[]");
      const i=parseInt(localStorage.getItem("rmg_audio_idx")||"-1");
      const s=JSON.parse(localStorage.getItem("rmg_audio_settings")||"{}");
      const pos=JSON.parse(localStorage.getItem("rmg_audio_positions")||"{}");
      this.queue=q;this.idx=i;
      this.shuffle=s.shuffle||false;this.repeat=s.repeat||"off";this.speed=s.speed||1;
      this.posCache=pos;
    }catch(e){}
  },
};
try{AUDIO_ENGINE.restore();}catch(e){}

// AudioCtxProvider — wraps entire app, syncs React state with AUDIO_ENGINE
function AudioCtxProvider({children}){
  const[state,setState]=useState(()=>({
    queue:AUDIO_ENGINE.queue,idx:AUDIO_ENGINE.idx,track:AUDIO_ENGINE.track,
    playing:AUDIO_ENGINE.playing,shuffle:AUDIO_ENGINE.shuffle,repeat:AUDIO_ENGINE.repeat,
    speed:AUDIO_ENGINE.speed,currentTime:0,duration:0,progress:0,
    showFullPlayer:false,showMini:false,
  }));

  // RAF loop for smooth time updates.
  // Останавливается при паузе/отсутствии аудио, перезапускается при воспроизведении.
  // isDraggingRef блокирует обновление прогресса во время скрабинга seek-бара.
  const rafRef=useRef(null);
  const isDraggingRef=useRef(false);

  const startRAF=useCallback(()=>{
    cancelAnimationFrame(rafRef.current);
    const tick=()=>{
      const el=AUDIO_ENGINE.el;
      if(!el||el.paused||el.ended){
        rafRef.current=null;
        return; // останавливаем RAF при паузе
      }
      if(!isDraggingRef.current&&el.duration){
        const ct=el.currentTime,dur=el.duration;
        setState(prev=>({...prev,currentTime:ct,duration:dur,progress:ct/dur}));
        AUDIO_ENGINE._updateMediaSessionPosition();
      }
      rafRef.current=requestAnimationFrame(tick);
    };
    rafRef.current=requestAnimationFrame(tick);
  },[]);

  // Подписываемся на события audio-элемента чтобы запускать/останавливать RAF
  useEffect(()=>{
    const handlePlay=()=>startRAF();
    const handlePause=()=>{cancelAnimationFrame(rafRef.current);rafRef.current=null;};
    // Слушаем нотификации от AUDIO_ENGINE чтобы подписаться на новый el
    const fn=snap=>{
      setState(prev=>({
        ...prev,...snap,
        showMini:snap.track?true:(prev.showMini&&(snap.queue?.length||0)>0),
      }));
      // Перезапускаем RAF если начали играть
      const el=AUDIO_ENGINE.el;
      if(el&&snap.playing){
        el.removeEventListener("play",handlePlay);
        el.removeEventListener("pause",handlePause);
        el.removeEventListener("ended",handlePause);
        el.addEventListener("play",handlePlay);
        el.addEventListener("pause",handlePause);
        el.addEventListener("ended",handlePause);
        if(!el.paused)startRAF();
      }else if(!snap.playing){
        cancelAnimationFrame(rafRef.current);
        rafRef.current=null;
      }
    };
    AUDIO_ENGINE.listeners.add(fn);
    return()=>{
      AUDIO_ENGINE.listeners.delete(fn);
      cancelAnimationFrame(rafRef.current);
    };
  },[startRAF]);

  const ctx={
    ...state,
    playTrack:(track)=>{AUDIO_ENGINE.playTrack(track);setState(prev=>({...prev,showMini:true}));},
    addToQueue:(track)=>{AUDIO_ENGINE.addToQueue(track);setState(prev=>({...prev,showMini:true}));},
    play:()=>AUDIO_ENGINE.play(),
    pause:()=>AUDIO_ENGINE.pause(),
    next:()=>AUDIO_ENGINE.next(),
    prev:()=>AUDIO_ENGINE.prev(),
    seek:(r)=>{AUDIO_ENGINE.seek(r);},
    setSpeed:(s)=>AUDIO_ENGINE.setSpeed(s),
    setRepeat:(m)=>AUDIO_ENGINE.setRepeat(m),
    setShuffle:(v)=>AUDIO_ENGINE.setShuffle(v),
    removeFromQueue:(i)=>AUDIO_ENGINE.removeFromQueue(i),
    reorderQueue:(f,t)=>AUDIO_ENGINE.reorderQueue(f,t),
    openFullPlayer:()=>setState(prev=>({...prev,showFullPlayer:true})),
    closeFullPlayer:()=>setState(prev=>({...prev,showFullPlayer:false})),
    closeMini:()=>{AUDIO_ENGINE.stop();setState(prev=>({...prev,showMini:false,showFullPlayer:false}));},
    // Expose drag flag so AudioPlayerScreen can pause RAF during scrubbing
    setSeekDragging:(v)=>{
      isDraggingRef.current=v;
      if(!v){
        // После отпускания — сразу обновить прогресс из текущей позиции
        const el=AUDIO_ENGINE.el;
        if(el&&el.duration){
          const ct=el.currentTime,dur=el.duration;
          setState(prev=>({...prev,currentTime:ct,duration:dur,progress:ct/dur}));
        }
        if(AUDIO_ENGINE.playing)startRAF();
      }
    },
  };

  return <AudioCtx.Provider value={ctx}>{children}</AudioCtx.Provider>;
}

const THEMES = {
  dark:  { bg:"#0A0A0A", surface:"#141414", surface2:"#1E1E1E", border:"#2A2A2A", text:"#FFFFFF", text2:"#9E9E9E", accent:"#E53935", accent2:"#B71C1C" },
  light: { bg:"#F2F2F7", surface:"#FFFFFF",  surface2:"#E8E8ED", border:"#D1D1D6", text:"#000000", text2:"#6C6C70", accent:"#E53935", accent2:"#B71C1C" },
  amoled:{ bg:"#000000", surface:"#0D0D0D", surface2:"#1A1A1A", border:"#222222", text:"#FFFFFF", text2:"#888888", accent:"#E53935", accent2:"#B71C1C" },
  blue:  { bg:"#0A0F1E", surface:"#111827", surface2:"#1F2937", border:"#2D3748", text:"#FFFFFF", text2:"#94A3B8", accent:"#3B82F6", accent2:"#1D4ED8" },
  mrx:   { bg:"#000000", surface:"#0D0000", surface2:"#1A0000", border:"#3D0000", text:"#FFFFFF", text2:"#FF6666", accent:"#FF0000", accent2:"#CC0000" },
  green: { bg:"#061209", surface:"#0C1E10", surface2:"#122817", border:"#1E4228", text:"#FFFFFF", text2:"#6FCF97", accent:"#22C55E", accent2:"#15803D" },
  glass: { bg:"#0a0a1a", surface:"rgba(255,255,255,0.07)", surface2:"rgba(255,255,255,0.12)", border:"rgba(255,255,255,0.18)", text:"#FFFFFF", text2:"rgba(255,255,255,0.55)", accent:"#7dd3fc", accent2:"#38bdf8", _glass:true },
  crystal: { bg:"transparent", surface:"rgba(255,255,255,0.04)", surface2:"rgba(255,255,255,0.08)", border:"rgba(255,255,255,0.12)", text:"#FFFFFF", text2:"rgba(255,255,255,0.5)", accent:"#e0f2fe", accent2:"#bae6fd", _glass:true, _crystal:true },
};
// ─── Chat Settings (wallpaper, accent, font size) ────────────────────────────
const WALLPAPERS = [
  {id:"none",   label:"Нет",      bg:null},
  {id:"dots",   label:"Точки",    bg:"radial-gradient(circle,rgba(255,0,0,0.08) 1px,transparent 1px) 0 0/24px 24px"},
  {id:"grid",   label:"Сетка",    bg:"linear-gradient(rgba(255,0,0,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,0,0,0.05) 1px,transparent 1px) 0 0/32px 32px"},
  {id:"wave",   label:"Волны",    bg:"repeating-linear-gradient(45deg,transparent,transparent 10px,rgba(255,0,0,0.04) 10px,rgba(255,0,0,0.04) 20px)"},
  {id:"bubble", label:"Пузыри",   bg:"radial-gradient(ellipse at 20% 50%,rgba(255,0,0,0.07) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(255,0,0,0.05) 0%,transparent 50%)"},
  {id:"dark",   label:"Тёмный",   bg:"linear-gradient(135deg,#0a0000 0%,#050000 100%)"},
  {id:"night",  label:"Ночь",     bg:"linear-gradient(180deg,#000010 0%,#000510 50%,#050000 100%)"},
  {id:"sunset", label:"Закат",    bg:"linear-gradient(180deg,#1a0000 0%,#0a0010 50%,#000508 100%)"},
];

const ACCENT_COLORS = [
  {id:"red",    color:"#FF0000", color2:"#CC0000", label:"Красный"},
  {id:"blue",   color:"#2AABEE", color2:"#1D8BC4", label:"Голубой"},
  {id:"green",  color:"#22C55E", color2:"#15803D", label:"Зелёный"},
  {id:"purple", color:"#A855F7", color2:"#7C3AED", label:"Фиолетовый"},
  {id:"orange", color:"#F97316", color2:"#C2410C", label:"Оранжевый"},
  {id:"pink",   color:"#EC4899", color2:"#BE185D", label:"Розовый"},
  {id:"gold",   color:"#EAB308", color2:"#A16207", label:"Золотой"},
  {id:"white",  color:"#FFFFFF", color2:"#CCCCCC", label:"Белый"},
];

const PALETTE=["#E53935","#E91E63","#9C27B0","#3F51B5","#2196F3","#009688","#4CAF50","#FF9800","#FF5722","#795548"];
const getS=k=>{try{return JSON.parse(localStorage.getItem("rmg_s")||"{}")[k];}catch{return null;}};
const setS=(k,v)=>{try{const s=JSON.parse(localStorage.getItem("rmg_s")||"{}");s[k]=v;localStorage.setItem("rmg_s",JSON.stringify(s));}catch{}};
const colorFor=s=>{let h=0;for(let i=0;i<(s||"").length;i++)h=s.charCodeAt(i)+((h<<5)-h);return PALETTE[Math.abs(h)%PALETTE.length];};
const dominantColorFromImage=(url,fallback="#E53935")=>new Promise(resolve=>{
  if(!url){resolve(fallback);return;}
  try{
    const img=new Image();
    img.crossOrigin="anonymous";
    img.referrerPolicy="no-referrer";
    img.onload=()=>{
      try{
        const c=document.createElement("canvas");
        const size=28;
        c.width=size;c.height=size;
        const ctx=c.getContext("2d",{willReadFrequently:true});
        ctx.drawImage(img,0,0,size,size);
        const data=ctx.getImageData(0,0,size,size).data;
        let r=0,g=0,b=0,count=0;
        for(let i=0;i<data.length;i+=16){
          const a=data[i+3];
          if(a<80)continue;
          const rr=data[i],gg=data[i+1],bb=data[i+2];
          if(rr+gg+bb<90||rr+gg+bb>720)continue;
          r+=rr;g+=gg;b+=bb;count++;
        }
        if(!count){resolve(fallback);return;}
        r=Math.round(r/count);g=Math.round(g/count);b=Math.round(b/count);
        resolve(`rgb(${r},${g},${b})`);
      }catch{resolve(fallback);}
    };
    img.onerror=()=>resolve(fallback);
    img.src=url;
  }catch{resolve(fallback);}
});
const alphaColor=(color,alpha=1)=>{
  try{
    const rgb=String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if(rgb)return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})`;
    const hex=String(color).replace("#","");
    if(hex.length===3){
      const r=parseInt(hex[0]+hex[0],16),g=parseInt(hex[1]+hex[1],16),b=parseInt(hex[2]+hex[2],16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    if(hex.length>=6){
      const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }catch{}
  return color;
};
const initials=n=>(n||"?").split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
const timeNow=()=>new Date().toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"});
const fmtSize=b=>b>1048576?`${(b/1048576).toFixed(1)}MB`:b>1024?`${(b/1024).toFixed(0)}KB`:`${b}B`;

// ─── Стикеры (5 паков) ──────────────────────────────────────────────────────────
const STICKER_PACKS = [
  { name:"Смайлы", stickers:["😀","😂","🥹","😍","🤩","😎","🥳","😏","😒","😤","🤬","😭","🥺","😱","🤯","🤔","😴","🤤","🤑","😈","👻","💀","🤡","👾","🤖"] },
  { name:"Жесты", stickers:["👍","👎","👏","🙌","🤝","✌️","🤞","🤙","💪","🙏","👋","🤜","🫶","❤️","🔥","💯","✅","⭐","🎉","🎊","🎁","💎","🏆","👑","💫"] },
  { name:"Животные", stickers:["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴"] },
  { name:"Еда", stickers:["🍕","🍔","🌮","🌯","🥙","🍜","🍣","🍱","🍦","🍩","🍪","🎂","🍰","🧁","🍫","🍭","🍬","🥤","☕","🧋","🍵","🥛","🍺","🥂","🍾"] },
  { name:"Активность", stickers:["⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥊","🎯","🎮","🎲","🎸","🎹","🎺","🎻","🥁","🎤","🎧","���","🖼️","📸","🎬"] },
];

// ─── Sound ────────────────────────────────────────────────────────────────────
function playSound(type="msg"){
  if(!getS("notifSound"))return;
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.connect(g);g.connect(ctx.destination);o.type="sine";
    if(type==="msg"){o.frequency.setValueAtTime(523,ctx.currentTime);o.frequency.exponentialRampToValueAtTime(784,ctx.currentTime+0.1);g.gain.setValueAtTime(0.2,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.28);o.start();o.stop(ctx.currentTime+0.28);}
    else{o.frequency.setValueAtTime(440,ctx.currentTime);o.frequency.exponentialRampToValueAtTime(660,ctx.currentTime+0.07);g.gain.setValueAtTime(0.09,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.14);o.start();o.stop(ctx.currentTime+0.14);}
  }catch{}
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({toast,onClose}){
  const {accent,accent2}=useContext(ThemeCtx);
  const[leaving,setLeaving]=useState(false);
  const close=useCallback(()=>{
    setLeaving(true);
    setTimeout(()=>onClose?.(),260);
  },[onClose]);
  useEffect(()=>{const t=setTimeout(close,4000);return()=>clearTimeout(t);},[close]);
  const title=toast.title||toast.msg||"RedMrxGram";
  const body=toast.body||toast.text||"";
  return(
    <div onClick={toast.onClick} style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",zIndex:9999,width:"min(380px, calc(100vw - 24px))",background:"rgba(18,18,18,0.97)",backdropFilter:"blur(24px)",WebkitBackdropFilter:"blur(24px)",borderRadius:20,padding:"11px 14px 14px",display:"flex",alignItems:"center",gap:11,boxShadow:"0 8px 40px rgba(0,0,0,0.7)",border:"1px solid rgba(255,255,255,0.07)",cursor:toast.onClick?"pointer":"default",animation:`${leaving?"toastOut":"toastIn"} ${leaving?".24s":".32s"} cubic-bezier(0.34,1.56,0.64,1) forwards`,overflow:"hidden"}}>
      <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{toast.icon||"💬"}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:"#fff",fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</div>
        {body&&<div style={{color:"rgba(255,255,255,0.55)",fontSize:12,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{body}</div>}
      </div>
      <button onClick={e=>{e.stopPropagation();close();}} style={{background:"none",border:"none",color:"rgba(255,255,255,0.35)",fontSize:15,cursor:"pointer",flexShrink:0}}>✕</button>
      <div style={{position:"absolute",left:0,bottom:0,height:3,width:"100%",background:`linear-gradient(90deg,${accent},${accent2})`,transformOrigin:"left",animation:"toastProgress 4s linear forwards"}}/>
    </div>
  );
}

// ─── Animated Screen Wrapper ──────────────────────────────────────────────────

// ─── Avatar ──────────────────────────────────────────────────────────────────
// Лучшее из доступных фото: встроенные (data:) надёжнее внешних ссылок, которые могут быть битыми
function bestPhoto(...cands){
  // fix11: mertvye starye ssylki tgfile-proksi polnostyu ignoriruem
  const list=cands.filter(x=>typeof x==="string"&&x.trim()&&!x.includes("duckdns.org/tgfi"));
  return list.find(x=>x.startsWith("data:"))||list[0]||null;
}

function Avatar({name,size=42,online=false,photo=null,onClick=null}){
  const {bg}=useContext(ThemeCtx);
  const c=colorFor(name||"?");
  const[err,setErr]=useState(false);

  useEffect(()=>{setErr(false);},[photo]);

  return(
    <div style={{position:"relative",flexShrink:0,cursor:onClick?"pointer":"default"}} onClick={onClick}>
      <div style={{width:size,height:size,borderRadius:"50%",
        background:`linear-gradient(135deg,${c},${c}99)`,
        display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:size*.38,fontWeight:700,color:"#fff",
        overflow:"hidden",position:"relative",userSelect:"none"}}>
        <span style={{position:"absolute",zIndex:0}}>{initials(name)}</span>
        {photo&&!err&&(
          <img
            key={photo}
            src={photo}
            alt=""
            style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",
              objectFit:"cover",zIndex:1,borderRadius:"50%",display:"block",
              opacity:1}}
            onError={()=>{setErr(true);}}
          />
        )}
      </div>
      {online&&(
        <div style={{position:"absolute",bottom:1,right:1,
          width:Math.max(8,size*.24),height:Math.max(8,size*.24),
          borderRadius:"50%",background:"#4CAF50",
          border:`2px solid ${bg}`,zIndex:2}}/>
      )}
    </div>
  );
}


// ─── Waveform ────────────────────────────────────────────────────────────────
function Waveform({wf,progress=0,fromMe}){
  const {accent}=useContext(ThemeCtx);
  const c=fromMe?"rgba(255,255,255,0.9)":accent;
  return(
    <div style={{display:"flex",alignItems:"center",gap:2,height:24}}>
      {(wf||[]).map((h,i)=><div key={i} style={{width:3,borderRadius:3,height:Math.max(3,h),background:i/wf.length<progress?c:`${c}28`}}/>)}
    </div>
  );
}

// ─── Voice Bubble ────────────────────────────────────────────────────────────
function VoiceBubble({msg,fromMe}){
  const {accent,text2}=useContext(ThemeCtx);
  const[playing,setPlaying]=useState(false);
  const[prog,setProg]=useState(0);
  const[dur,setDur]=useState(msg.duration||"0:00");
  const[err,setErr]=useState(false);
  const aRef=useRef(null),raf=useRef(null);

  const stop=()=>{
    try{if(aRef.current){aRef.current.pause();aRef.current.src="";aRef.current=null;}}catch(e){}
    cancelAnimationFrame(raf.current);
    setPlaying(false);setProg(0);
  };

  const toggle=()=>{
    if(playing){stop();return;}
    const src=msg.audioUrl||msg.audioData||msg.fileUrl||msg.fileData;
    if(!src){setErr(true);return;}
    setErr(false);
    try{
      const a=new Audio(src);
      // НЕ ставим crossOrigin — Firebase Storage не поддерживает CORS для Audio на Android
      aRef.current=a;
      a.onloadedmetadata=()=>{
        if(a.duration&&isFinite(a.duration)&&a.duration>0)
          setDur(`${Math.floor(a.duration/60)}:${String(Math.floor(a.duration%60)).padStart(2,"0")}`);
      };
      // Убираем ontimeupdate — прогресс обновляется только через RAF (избегаем двойного setState)
      a.onended=()=>{setPlaying(false);setProg(0);aRef.current=null;cancelAnimationFrame(raf.current);};
      a.onerror=(e)=>{console.log("Audio error:",e);setErr(true);stop();};
      a.oncanplay=()=>{
        // Единственный механизм обновления прогресса — RAF
        const tick=()=>{
          const cur=aRef.current;
          if(cur&&!cur.paused&&!cur.ended&&cur.duration){
            setProg(cur.currentTime/cur.duration);
            raf.current=requestAnimationFrame(tick);
          }
          // Если пауза/конец — RAF останавливается сам
        };
        tick();
      };
      // Используем play() напрямую без load() — это важно для Android WebView
      a.play().then(()=>{
        setPlaying(true);
      }).catch(err=>{
        console.log("Play failed:",err);
        setErr(true);
        aRef.current=null;
      });
    }catch(e){
      console.log("Audio init error:",e);
      setErr(true);
    }
  };

  useEffect(()=>()=>stop(),[]);
  const wf=useMemo(()=>msg.waveform||Array.from({length:28},()=>Math.floor(Math.random()*18)+5),[msg.id]);

  return(
    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:200}}>
      <button onClick={toggle} style={{width:42,height:42,borderRadius:"50%",border:"none",cursor:"pointer",background:err?"rgba(255,59,48,0.3)":fromMe?"rgba(255,255,255,0.2)":accent,color:"#fff",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"transform 0.15s",transform:playing?"scale(0.88)":"scale(1)"}}>
        {err?"✕":playing?"⏸":"▶"}
      </button>
      <div style={{flex:1}}>
        <Waveform wf={wf} progress={prog} fromMe={fromMe}/>
        <div style={{fontSize:11,color:fromMe?"rgba(255,255,255,0.45)":text2,marginTop:2}}>{dur}</div>
      </div>
    </div>
  );
}


function AudioBubble({msg,fromMe}){
  const {accent,text,text2}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  const trackId=msg.id||(msg.fileUrl||msg.audioUrl||msg.fileData||msg.audioData||"");
  const isActive=audio?.track?.id===trackId;
  const isPlaying=isActive&&audio?.playing;
  const progress=isActive?(audio?.progress||0):0;
  const curTime=isActive?(audio?.currentTime||0):0;
  const fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

  const buildTrack=()=>({
    id:trackId,
    src:msg.fileUrl||msg.fileData||msg.audioUrl||msg.audioData||"",
    name:(msg.fileName||"Аудио").replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|opus|aiff|ape)$/i,""),
    ext:(msg.fileName||"").split(".").pop()?.toUpperCase()||"MP3",
    size:msg.fileSize?fmtSize(msg.fileSize):"",
    chatName:"",author:msg.author||"",
  });

  const toggle=()=>{
    if(!audio)return;
    const src=msg.fileUrl||msg.fileData||msg.audioUrl||msg.audioData;
    if(!src)return;
    if(isActive){isPlaying?audio.pause():audio.play();}
    else{audio.playTrack(buildTrack());}
  };

  const name=msg.fileName||"Аудио";
  const ext=name.split(".").pop()?.toUpperCase()||"MP3";
  const sizeMb=msg.fileSize?(msg.fileSize/1024/1024).toFixed(1)+"MB":"";
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:220,maxWidth:280}}>
      <button onClick={toggle} style={{width:46,height:46,borderRadius:"50%",border:"none",cursor:"pointer",flexShrink:0,background:fromMe?"rgba(255,255,255,0.22)":accent,color:"#fff",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.15s",transform:isPlaying?"scale(0.88)":"scale(1)"}}>
        {isPlaying?"⏸":"▶"}
      </button>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:fromMe?"#fff":text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginBottom:4}}>🎵 {name}</div>
        <div style={{height:3,background:fromMe?"rgba(255,255,255,0.25)":"rgba(0,0,0,0.15)",borderRadius:2,overflow:"hidden",marginBottom:4}}>
          <div style={{height:"100%",width:(progress*100)+"%",background:fromMe?"rgba(255,255,255,0.85)":accent,borderRadius:2,transition:"width 0.1s linear"}}/>
        </div>
        <div style={{fontSize:10,color:fromMe?"rgba(255,255,255,0.5)":text2,display:"flex",gap:6}}>
          <span>{isActive?fmt(curTime):"0:00"}</span>{sizeMb&&<span>· {sizeMb}</span>}<span>· {ext}</span>
        </div>
      </div>
    </div>
  );
}

function CircleBubble({msg,onFullscreen}){
  const {accent,accent2}=useContext(ThemeCtx);
  const[playing,setPlaying]=useState(false);
  const[prog,setProg]=useState(0);
  const[thumb,setThumb]=useState(null);
  const vRef=useRef(null),raf=useRef(null);
  const BASE_SIZE=138;
  const ACTIVE_SIZE=188;
  const size=playing?ACTIVE_SIZE:BASE_SIZE;
  const src=msg.videoUrl||msg.videoData;

  // Превью первого кадра через скрытый video + canvas
  useEffect(()=>{
    if(!src)return;
    let cancelled=false;
    const v=document.createElement("video");
    v.src=src;v.muted=true;v.playsInline=true;v.preload="metadata";
    v.crossOrigin="anonymous";
    const grab=()=>{
      if(cancelled)return;
      try{
        const c=document.createElement("canvas");
        c.width=200;c.height=200;
        const ctx2=c.getContext("2d");
        const vw=v.videoWidth||200,vh=v.videoHeight||200;
        const sc=Math.max(200/vw,200/vh);
        ctx2.drawImage(v,(vw-200/sc)/2,(vh-200/sc)/2,200/sc,200/sc,0,0,200,200);
        if(!cancelled)setThumb(c.toDataURL("image/jpeg",0.75));
      }catch(e){}
    };
    v.addEventListener("loadeddata",()=>{v.currentTime=0.1;},false);
    v.addEventListener("seeked",grab,{once:true});
    v.addEventListener("loadeddata",()=>setTimeout(grab,500),{once:true});
    return()=>{cancelled=true;v.src="";};
  },[src]);

  const toggle=()=>{
    const v=vRef.current;if(!src||!v)return;
    if(playing){
      v.pause();cancelAnimationFrame(raf.current);setPlaying(false);setProg(0);v.currentTime=0;
      _unregisterActiveVideo(v);
      return;
    }
    if(!v.src||v.src!==src)v.src=src;
    // Регистрируем как активное видео — останавливает любые другие плееры (видео/кружки)
    _registerActiveVideo(v);
    v.play().catch(()=>{});setPlaying(true);
    const tick=()=>{
      if(v&&!v.paused&&!v.ended){
        if(v.duration)setProg(v.currentTime/v.duration);
        raf.current=requestAnimationFrame(tick);
      }
    };
    v.onplay=()=>tick();
    v.onended=()=>{setPlaying(false);setProg(0);_unregisterActiveVideo(v);};
  };

  // Слушаем сигнал остановки от глобального синглтона (другое видео начало играть)
  useEffect(()=>{
    const v=vRef.current;if(!v)return;
    const onStop=()=>{
      try{v.pause();}catch(e){}
      cancelAnimationFrame(raf.current);
      setPlaying(false);setProg(0);
      try{v.currentTime=0;}catch(e){}
    };
    v.addEventListener("rmg_stop",onStop);
    return()=>v.removeEventListener("rmg_stop",onStop);
  },[]);

  useEffect(()=>()=>{
    if(vRef.current){vRef.current.pause();_unregisterActiveVideo(vRef.current);}
    cancelAnimationFrame(raf.current);
  },[]);

  return(
    <div style={{position:"relative",width:size,height:size,cursor:"pointer",flexShrink:0,
      transition:"width 0.32s cubic-bezier(0.34,1.56,0.64,1),height 0.32s cubic-bezier(0.34,1.56,0.64,1)",
      zIndex:playing?8:"auto"}}
      onClick={toggle}
      onDoubleClick={()=>{onFullscreen&&onFullscreen(src);}}>

      {/* Outer glow ring — тонкая прогресс-обводка */}
      <div style={{position:"absolute",inset:-2,borderRadius:"50%",
        background:`conic-gradient(${accent} ${prog*360}deg, transparent ${prog*360}deg)`,
        opacity:playing?0.9:0.5,transition:"opacity 0.3s",
        filter:`blur(0.5px)`}}/>

      {/* Video circle */}
      <div style={{position:"absolute",inset:3,borderRadius:"50%",overflow:"hidden",
        boxShadow:`0 2px 12px rgba(0,0,0,0.4),0 0 0 1px ${playing?accent+"99":"rgba(255,255,255,0.1)"}`}}>

        {/* Превью кадра — пока не играет */}
        {thumb&&!playing&&(
          <img src={thumb} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:0}}/>
        )}
        {/* Цветной градиент-заглушка если thumbnail ещё не готов */}
        {!thumb&&!playing&&(
          <div style={{position:"absolute",inset:0,zIndex:0,
            background:`radial-gradient(circle at 38% 32%,${accent}88 0%,rgba(0,0,0,0.85) 68%)`}}/>
        )}

        <video ref={vRef} playsInline preload="none"
          style={{position:"relative",zIndex:1,width:"100%",height:"100%",objectFit:"cover",
            opacity:playing?1:0,transition:"opacity 0.18s"}}/>

        {/* Play overlay */}
        {!playing&&(
          <div style={{position:"absolute",inset:0,zIndex:2,
            background:thumb?"rgba(0,0,0,0.22)":"rgba(0,0,0,0.35)",
            display:"flex",alignItems:"center",justifyContent:"center",
            backdropFilter:"blur(1px)"}}>
            <div style={{width:44,height:44,borderRadius:"50%",
              background:`linear-gradient(135deg,${accent},${accent2})`,
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:`0 4px 16px ${accent}66`,fontSize:18,color:"#fff",
              paddingLeft:3}}>▶</div>
          </div>
        )}
      </div>

      {/* Duration badge */}
      {msg.duration&&(
        <div style={{position:"absolute",bottom:10,left:"50%",transform:"translateX(-50%)",
          background:"rgba(0,0,0,0.7)",backdropFilter:"blur(8px)",
          borderRadius:12,padding:"2px 9px",color:"#fff",fontSize:10,
          fontWeight:600,letterSpacing:0.3,whiteSpace:"nowrap",
          border:"1px solid rgba(255,255,255,0.15)"}}>
          {playing?(()=>{
            const parts=(msg.duration||"0:00").split(":");
            const totalSec=(parseInt(parts[0]||0)*60)+(parseInt(parts[1]||0));
            const curSec=Math.floor(prog*totalSec);
            const m=Math.floor(curSec/60),s=curSec%60;
            return `${m}:${String(s).padStart(2,"0")}`;
          })():msg.duration}
        </div>
      )}

      {/* Animated dots when playing */}
      {playing&&(
        <div style={{position:"absolute",top:8,right:8,display:"flex",gap:2}}>
          {[0,1,2].map(i=>(
            <div key={i} style={{width:4,height:4,borderRadius:"50%",background:accent,
              animation:`pulse 0.8s ease-in-out ${i*0.2}s infinite`}}/>
          ))}
        </div>
      )}
    </div>
  );
}

function AudioPlayer({msg,fromMe}){
  const {accent,text2,text}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  const trackId=msg.id||(msg.fileUrl||msg.fileData||"");
  const isActive=audio?.track?.id===trackId;
  const isPlaying=isActive&&audio?.playing;
  const progress=isActive?(audio?.progress||0):0;
  const curTime=isActive?(audio?.currentTime||0):0;
  const durTime=isActive?(audio?.duration||0):0;
  const fmt=s=>isFinite(s)&&s>0?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`:"0:00";

  const buildTrack=()=>({
    id:trackId,
    src:msg.fileUrl||msg.fileData||"",
    name:(msg.fileName||"Аудио").replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|opus|aiff|ape)$/i,""),
    ext:(msg.fileName||"").split(".").pop()?.toUpperCase()||"MP3",
    size:msg.fileSize?fmtSize(msg.fileSize):"",
    chatName:"",author:msg.author||"",
  });

  const toggle=()=>{
    if(!audio)return;
    if(!msg.fileUrl&&!msg.fileData)return;
    if(isActive){isPlaying?audio.pause():audio.play();}
    else{audio.playTrack(buildTrack());}
  };

  const wf=useMemo(()=>msg.waveform||Array.from({length:36},(_,i)=>8+Math.sin(i*0.7)*6+Math.random()*8),[msg.id]);
  const name=msg.fileName||"Аудио";
  const size=msg.fileSize?fmtSize(msg.fileSize):"";

  return(
    <div style={{minWidth:220,maxWidth:280}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
        <div style={{position:"relative",flexShrink:0}}>
          <div style={{width:46,height:46,borderRadius:12,
            background:fromMe?"rgba(255,255,255,0.15)":accent+"22",
            display:"flex",alignItems:"center",justifyContent:"center",
            overflow:"hidden",boxShadow:isPlaying?`0 0 14px ${accent}66`:"none",transition:"box-shadow 0.3s"}}>
            {msg.coverUrl
              ?<img src={msg.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :<span style={{fontSize:22}}>🎵</span>}
          </div>
          <button onClick={toggle} style={{position:"absolute",inset:0,borderRadius:12,border:"none",cursor:"pointer",
            background:isPlaying?"rgba(0,0,0,0.4)":"rgba(0,0,0,0.25)",color:"#fff",fontSize:14,
            display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s",WebkitTapHighlightColor:"transparent"}}>
            {isPlaying?"⏸":"▶"}
          </button>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:fromMe?"#fff":text,fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name.replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|aiff|ape)$/i,"")}</div>
          <div style={{color:fromMe?"rgba(255,255,255,0.55)":text2,fontSize:11,marginTop:1}}>{size}{size?" · ":""}Аудио</div>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"flex-end",gap:2,height:28,marginBottom:4,cursor:"pointer"}}
        onClick={e=>{
          if(!isActive||!audio)return;
          const rect=e.currentTarget.getBoundingClientRect();
          audio.seek((e.clientX-rect.left)/rect.width);
        }}>
        {wf.map((h,i)=>(
          <div key={i} style={{flex:1,borderRadius:2,height:Math.max(3,h),
            background:i/wf.length<progress?(fromMe?"rgba(255,255,255,0.9)":accent):(fromMe?"rgba(255,255,255,0.25)":accent+"33"),
            transition:"background 0.08s"}}/>
        ))}
      </div>
      <div style={{display:"flex",justifyContent:"space-between"}}>
        <span style={{color:fromMe?"rgba(255,255,255,0.5)":text2,fontSize:10}}>{fmt(curTime)}</span>
        <span style={{color:fromMe?"rgba(255,255,255,0.5)":text2,fontSize:10}}>{fmt(durTime)}</span>
      </div>
    </div>
  );
}


// ─── File Bubble ─────────────────────────────────────────────────────────────
// ─── Custom Video Player ──────────────────────────────────────────────────────
// Drop-in replacement for VideoPlayer and VideoFullscreen components.
// Paste both functions into App.jsx, replacing the existing ones.
// ─────────────────────────────────────────────────────────────────────────────

// ─── SVG Icon helpers (internal) ─────────────────────────────────────────────
const IcPlay   = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="white" style={{marginLeft:3}}><path d="M8 5v14l11-7z"/></svg>;
const IcPause  = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>;
const IcBack   = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>;
const IcDown   = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>;
const IcPip    = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M19 7h-8v6h8V7zm2-4H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H3V5h18v14zm-10-7h8v6h-8v-6z"/></svg>;
const IcFull   = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>;
const IcSeekB  = () => <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="15.5" textAnchor="middle" fontSize="6" fill="white" fontWeight="bold">15</text></svg>;
const IcSeekF  = () => <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="15.5" textAnchor="middle" fontSize="6" fill="white" fontWeight="bold">15</text></svg>;

const fmtTime = s => {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

// ─── Global Video Singleton — один видеофайл в эфире (как в Telegram) ────────
let _globalActiveVideo = null;
// ─── fix23: SVG-иконки вместо эмодзи (нативный вид) ─────────────────────────
const _ic=(d)=>({size=22,color="currentColor",style})=>(
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={style}><path d={d}/></svg>
);
const IcTabChats=_ic("M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z");
const IcTabDirect=_ic("M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z");
const IcTabContacts=_ic("M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z");
const IcTabGroups=_ic("M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58C.48 14.9 0 15.62 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm4 3.43c0-.81-.48-1.53-1.22-1.85-.85-.37-1.79-.58-2.78-.58-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z");
const IcTabChannels=_ic("M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z");
const IcTabSettings=_ic("M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z");
const IcSetBell=_ic("M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z");
const IcSetLock=_ic("M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM9 8V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9z");
const IcSetClock=_ic("M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z");
const IcSetPalette=_ic("M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z");
const IcSetDownload=_ic("M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z");
const IcSetInfo=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z");
const IcSetLogout=_ic("M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z");
const IcSearchSm=_ic("M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z");
const IcPencilSm=_ic("M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z");

const haptic=(ms=10)=>{try{if(navigator.vibrate)navigator.vibrate(ms);}catch(e){}};
const _mi={display:"block",margin:"0 auto"};
const IcReply=_ic("M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z");
const IcForward=_ic("M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z");
const IcCopy=_ic("M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z");
const IcStar=_ic("M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z");
const IcMusic=_ic("M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z");
const IcTrash=_ic("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z");
const IcTrashAll=_ic("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm2.46-7.12l1.41-1.41L12 12.59l2.12-2.12 1.41 1.41L13.41 14l2.12 2.12-1.41 1.41L12 15.41l-2.12 2.12-1.41-1.41L10.59 14l-2.13-2.12zM15.5 4l-1-1h-5l-1 1H5v2h14V4h-3.5z");
const IcImage=_ic("M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z");
const IcFileDoc=_ic("M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z");
const IcCircleVid=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-2-12.5v9l6-4.5-6-4.5z");
const IcPin=_ic("M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z");
const IcArchiveBox=_ic("M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z");
const IcMute=_ic("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z");
const IcCheckOne=_ic("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z");
const IcEye=_ic("M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z");
const IcKeys=_ic("M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z");
const IcSpark=_ic("M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z");
const IcDot=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z");
const IcShield=_ic("M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z");
const IcHeart=_ic("M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z");
const IcRuler=_ic("M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H3V8h2v4h2V8h2v4h2V8h2v4h2V8h2v4h2V8h2v8z");
const IcWrench=_ic("M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z");
const IcDoor=_ic("M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z");
const IcVibro=_ic("M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zM16.5 3h-9C6.67 3 6 3.67 6 4.5v15c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5v-15c0-.83-.67-1.5-1.5-1.5zM16 19H8V5h8v14z");
const IcHistory=_ic("M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z");

const IcGhost=_ic("M12 2C7.58 2 4 5.58 4 10v10l2.5-2 2.5 2 3-2.5 3 2.5 2.5-2 2.5 2V10c0-4.42-3.58-8-8-8zm-3 8c-.83 0-1.5-.67-1.5-1.5S8.17 7 9 7s1.5.67 1.5 1.5S9.83 10 9 10zm6 0c-.83 0-1.5-.67-1.5-1.5S14.17 7 15 7s1.5.67 1.5 1.5S15.83 10 15 10z");
const IcHelpQ=_ic("M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z");

let _appConfirmShow=null;
const appConfirm=(msg,okLabel="Да")=>new Promise(res=>{if(_appConfirmShow)_appConfirmShow({msg,okLabel,res});else res(window.confirm(msg));});
function ConfirmHost(){
  const theme=useContext(ThemeCtx)||{};
  const[st,setSt]=useState(null);
  const[vis,setVis]=useState(false);
  useEffect(()=>{_appConfirmShow=(c)=>{setSt(c);requestAnimationFrame(()=>requestAnimationFrame(()=>setVis(true)));};return()=>{_appConfirmShow=null;};},[]);
  if(!st)return null;
  const done=(v)=>{setVis(false);setTimeout(()=>{st.res(v);setSt(null);},200);};
  return(
    <div style={{position:"fixed",inset:0,zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",background:vis?"rgba(0,0,0,0.55)":"rgba(0,0,0,0)",backdropFilter:vis?"blur(3px)":"none",transition:"background 0.2s ease,backdrop-filter 0.2s ease",padding:24}} onClick={()=>done(false)}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:320,background:theme.surface||"#1c1c1e",border:`1px solid ${theme.border||"#333"}`,borderRadius:18,padding:"20px 18px 14px",boxShadow:"0 18px 60px rgba(0,0,0,0.6)",transform:vis?"scale(1)":"scale(0.86)",opacity:vis?1:0,transition:"transform 0.22s cubic-bezier(0.34,1.56,0.64,1),opacity 0.18s ease"}}>
        <div style={{color:theme.text||"#fff",fontSize:15,fontWeight:600,lineHeight:1.45,textAlign:"center",marginBottom:16}}>{st.msg}</div>
        <div style={{display:"flex",gap:10}}>
          <button className="rmg-press" onClick={()=>done(false)} style={{flex:1,padding:"11px 0",borderRadius:12,border:`1px solid ${theme.border||"#333"}`,background:theme.surface2||"#2a2a2c",color:theme.text2||"#aaa",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Отмена</button>
          <button className="rmg-press" onClick={()=>done(true)} style={{flex:1,padding:"11px 0",borderRadius:12,border:"none",background:"#e53935",color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{st.okLabel}</button>
        </div>
      </div>
    </div>
  );
}

function _registerActiveVideo(videoEl) {
  if (_globalActiveVideo && _globalActiveVideo !== videoEl) {
    try { _globalActiveVideo.pause(); } catch(e) {}
    // Сбрасываем состояние предыдущего плеера через кастомное событие
    try { _globalActiveVideo.dispatchEvent(new Event("rmg_stop")); } catch(e) {}
  }
  _globalActiveVideo = videoEl;
}
function _unregisterActiveVideo(videoEl) {
  if (_globalActiveVideo === videoEl) _globalActiveVideo = null;
}

// ─── Глобальный коллбек закрытия полноэкранного видео ────────────────────────
// Устанавливается VideoFullscreen на mount, читается App-level back-handler
// чтобы кнопка Назад на Android выходила из полноэкранного режима, а не из чата.
let _videoFullscreenClose = null;

// ─── Глобальный коллбек закрытия лайтбокса (просмотрщика изображений) ────────
// Тот же паттерн, что и _videoFullscreenClose. Lightbox регистрирует свой
// анимированный close на mount, App-level back-handler вызывает его ра��ьше,
// чем покидает экран чата — так системная кнопка «Назад» сначала закрывает
// просмотр изображения (с обратной анимацией), а не выходит из чата.
let _lightboxClose = null;
let _chatBackHandler = null;
let _storyBackHandler = null;
let _profileBackHandler = null;
let _audioBackHandler = null;

// ─── Spinner CSS injected once ────────────────────────────────────────────────
let _vpStyleInjected = false;
function injectVpStyles() {
  if (_vpStyleInjected) return;
  _vpStyleInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes _vpSpin { to { transform: rotate(360deg); } }
    @keyframes _vpFadeIn { from { opacity:0; transform:scale(0.7); } to { opacity:1; transform:scale(1); } }
    @keyframes _vpSeekAnim { 0%{opacity:0;transform:scale(0.6);} 20%{opacity:1;transform:scale(1.1);} 80%{opacity:1;transform:scale(1);} 100%{opacity:0;transform:scale(0.9);} }
    @keyframes _vpPillIn { from{opacity:0;transform:translateX(-50%) scale(0.85);} to{opacity:1;transform:translateX(-50%) scale(1);} }
    @keyframes _vpRipple { from{transform:translate(-50%,-50%) scale(0);opacity:0.6;} to{transform:translate(-50%,-50%) scale(3);opacity:0;} }
  `;
  document.head.appendChild(s);
}

// ─── Gesture Indicator Pill ───────────────────────────────────────────────────
function GesturePill({ type, value }) {
  // type: "volume" | "brightness" | "seek"
  const icons = { volume: "🔊", brightness: "☀️", seek: value > 0 ? "⏩" : "⏪" };
  const label =
    type === "seek"
      ? (value > 0 ? `+${Math.abs(value)}с` : `-${Math.abs(value)}с`)
      : `${Math.round(value * 100)}%`;
  const progress = type === "seek" ? null : value;

  return (
    <div style={{
      position: "absolute", left: "50%", top: "38%",
      transform: "translateX(-50%)",
      background: "rgba(0,0,0,0.72)",
      backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: 18, padding: "10px 22px 10px 16px",
      display: "flex", alignItems: "center", gap: 10,
      animation: "_vpPillIn 0.18s cubic-bezier(0.34,1.56,0.64,1)",
      zIndex: 20, pointerEvents: "none", minWidth: 140,
    }}>
      <span style={{ fontSize: 22 }}>{icons[type]}</span>
      <div style={{ flex: 1 }}>
        {progress !== null && (
          <div style={{
            height: 4, background: "rgba(255,255,255,0.18)", borderRadius: 2,
            overflow: "hidden", marginBottom: 5,
          }}>
            <div style={{
              height: "100%", borderRadius: 2,
              background: "rgba(255,255,255,0.88)",
              width: `${Math.max(0, Math.min(100, progress * 100))}%`,
              transition: "width 0.1s linear",
            }} />
          </div>
        )}
        <div style={{
          color: "#fff", fontSize: 13, fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
        }}>{label}</div>
      </div>
    </div>
  );
}

// ─── Double-tap seek animation ────────────────────────────────────────────────
function SeekFlash({ side }) {
  return (
    <div style={{
      position: "absolute", top: 0, bottom: 0,
      [side === "left" ? "left" : "right"]: 0,
      width: "42%",
      display: "flex", alignItems: "center",
      justifyContent: "center",
      background: `radial-gradient(ellipse at ${side === "left" ? "70%" : "30%"} 50%, rgba(255,255,255,0.12) 0%, transparent 70%)`,
      animation: "_vpSeekAnim 0.5s ease forwards",
      pointerEvents: "none", zIndex: 15,
    }}>
      <div style={{ color: "#fff", fontSize: 36, fontWeight: 900, letterSpacing: -1 }}>
        {side === "left" ? "◀◀" : "▶▶"}
      </div>
    </div>
  );
}

// ─── Speed Selector Popup ─────────────────────────────────────────────────────
function SpeedPopup({ speed, onSelect, onClose, accent }) {
  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 200 }} onClick={onClose} />
      <div style={{
        position: "absolute", bottom: 72, right: 16,
        background: "rgba(18,18,18,0.97)",
        backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 16, overflow: "hidden",
        boxShadow: "0 16px 48px rgba(0,0,0,0.8)",
        animation: "_vpFadeIn 0.18s cubic-bezier(0.34,1.56,0.64,1)",
        zIndex: 201, minWidth: 120,
      }}>
        {speeds.map(s => (
          <button key={s} onClick={() => { onSelect(s); onClose(); }} style={{
            display: "block", width: "100%", padding: "12px 22px",
            background: speed === s ? `${accent}22` : "none",
            border: "none", cursor: "pointer", fontFamily: "inherit",
            color: speed === s ? accent : "rgba(255,255,255,0.85)",
            fontSize: 14, fontWeight: speed === s ? 700 : 400,
            textAlign: "center", transition: "background 0.15s",
            borderLeft: speed === s ? `3px solid ${accent}` : "3px solid transparent",
          }}>
            {formatSpeed(s)}
          </button>
        ))}
      </div>
    </>
  );
}

// ─── Draggable Progress Bar ───────────────────────────────────────────────────
function ProgressBar({ prog, buffered, accent, accent2, onSeek, onDragStart, onDragEnd }) {
  const barRef = React.useRef(null);
  const dragging = React.useRef(false);

  const getPos = (clientX) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const handleMouseDown = (e) => {
    e.stopPropagation();
    dragging.current = true;
    onDragStart?.();
    onSeek(getPos(e.clientX));
    const up = (e2) => { dragging.current = false; onDragEnd?.(); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    const mv = (e2) => { if (dragging.current) onSeek(getPos(e2.clientX)); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  };

  const handleTouchStart = (e) => {
    e.stopPropagation();
    dragging.current = true;
    onDragStart?.();
    onSeek(getPos(e.touches[0].clientX));
    const up = () => { dragging.current = false; onDragEnd?.(); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
    const mv = (e2) => { if (dragging.current) onSeek(getPos(e2.touches[0].clientX)); };
    window.addEventListener("touchmove", mv, { passive: true });
    window.addEventListener("touchend", up);
  };

  return (
    <div ref={barRef} style={{
      height: 20, display: "flex", alignItems: "center",
      cursor: "pointer", position: "relative", margin: "0 -4px",
    }}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      {/* Track */}
      <div style={{
        position: "absolute", left: 4, right: 4, height: 3,
        background: "rgba(255,255,255,0.18)", borderRadius: 2,
      }}>
        {/* Buffered */}
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          borderRadius: 2, background: "rgba(255,255,255,0.22)",
          width: `${(buffered || 0) * 100}%`, transition: "width 0.3s ease",
        }} />
        {/* Played */}
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          borderRadius: 2,
          background: "rgba(255,255,255,0.86)",
          width: `${prog * 100}%`,
        }} />
        {/* Thumb */}
        <div style={{
          position: "absolute", top: "50%",
          left: `${prog * 100}%`,
          transform: "translate(-50%,-50%)",
          width: 14, height: 14, borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 8px rgba(0,0,0,0.6)",
          transition: "transform 0.1s ease",
        }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VideoPlayer — compact bubble in chat
// ═══════════════════════════════════════════════════════════════════════════════
function VideoPlayer({ src, fileName, fromMe, onOpenLightbox }) {
  React.useEffect(() => { injectVpStyles(); }, []);
  const { accent, accent2 } = useContext(ThemeCtx);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [showCtrl, setShowCtrl] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [thumbUrl, setThumbUrl] = useState(null);
  const [started, setStarted] = useState(false); // user pressed play at least once
  const rafRef = useRef(null);
  const ctrlTimer = useRef(null);
  const W = 245, H = 175;

  // Generate thumbnail from first frame
  const captureThumb = () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || thumbUrl) return;
    try {
      c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      ctx.drawImage(v, 0, 0, W, H);
      setThumbUrl(c.toDataURL("image/jpeg", 0.8));
    } catch (e) {}
  };

  const tick = () => {
    const v = videoRef.current; if (!v) return;
    if (v.duration) {
      setProg(v.currentTime / v.duration);
      if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1) / v.duration);
    }
    if (!v.paused && !v.ended) rafRef.current = requestAnimationFrame(tick);
  };

  const revealCtrl = () => {
    setShowCtrl(true);
    clearTimeout(ctrlTimer.current);
    if (playing) ctrlTimer.current = setTimeout(() => setShowCtrl(false), 3000);
  };

  const toggle = (e) => {
    e.stopPropagation();
    // Первый тап: открываем видео в лайтбоксе с zoom-анимацией (как у фото)
    if (onOpenLightbox && !started) {
      let originRect = null;
      try { originRect = (videoRef.current || e.currentTarget)?.getBoundingClientRect?.() || null; } catch (e2) {}
      onOpenLightbox({ src, fileName: fileName || "video.mp4", fileType: "video/mp4", originRect });
      return;
    }
    const v = videoRef.current; if (!v) return;
    if (v.paused) {
      // Регистрируем как активное видео — остановит другие плееры
      _registerActiveVideo(v);
      // Назначаем src только если он действительно не задан — переназначение
      // ломает загрузку и роняет play() с AbortError (видео не запускается).
      if (!v.src && src) { v.src = src; v.load(); }
      const playPromise = v.play();
      if (playPromise && playPromise.then) {
        playPromise.then(() => {
          setPlaying(true); setStarted(true);
          rafRef.current = requestAnimationFrame(tick);
        }).catch(err => {
          // Повтор: явный load() и play() — на случай если поток ещё не готов
          try {
            v.load();
            v.play().then(() => {
              setPlaying(true); setStarted(true);
              rafRef.current = requestAnimationFrame(tick);
            }).catch(() => {
              // Последняя попытка — muted-play (Android может блокировать sound)
              try {
                v.muted = true;
                v.play().then(() => {
                  setPlaying(true); setStarted(true);
                  rafRef.current = requestAnimationFrame(tick);
                }).catch(() => {});
              } catch(e2) {}
            });
          } catch(e2) {}
        });
      } else {
        // Старый API без Promise
        setPlaying(true); setStarted(true);
        rafRef.current = requestAnimationFrame(tick);
      }
    } else {
      v.pause(); setPlaying(false); cancelAnimationFrame(rafRef.current);
      _unregisterActiveVideo(v);
    }
    revealCtrl();
  };

  // Слушаем событие остановки от глобального синглтона
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onStop = () => { v.pause(); setPlaying(false); cancelAnimationFrame(rafRef.current); setShowCtrl(true); };
    v.addEventListener("rmg_stop", onStop);
    return () => v.removeEventListener("rmg_stop", onStop);
  }, []);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(ctrlTimer.current);
    _unregisterActiveVideo(videoRef.current);
  }, []);

  const downloadVideo = async (e) => {
    e.stopPropagation();
    try { await downloadToDevice(src, fileName || "video.mp4"); } catch {}
    revealCtrl();
  };

  if (fullscreen) return createPortal(
    <VideoFullscreen
      src={src} fileName={fileName}
      initialTime={videoRef.current?.currentTime || 0}
      onClose={() => {
        setFullscreen(false);
        // sync position back
        const v = videoRef.current;
        if (v) { v.pause(); setPlaying(false); cancelAnimationFrame(rafRef.current); setShowCtrl(true); }
      }}
    />,
    document.body
  );

  const showPoster = !started;

  return (
    <div style={{
      width: W, borderRadius: 16, overflow: "hidden",
      background: "#060606", position: "relative",
      cursor: "pointer", userSelect: "none",
      boxShadow: "0 8px 32px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.4)",
    }} onClick={toggle} onMouseMove={revealCtrl} onTouchStart={revealCtrl}>

      {/* Hidden canvas for thumbnail generation */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* Video element */}
      <video ref={videoRef} src={src} playsInline preload="metadata"
        style={{ width: "100%", height: H, display: "block", objectFit: "cover", background: "#000" }}
        onLoadedMetadata={e => setDur(e.target.duration)}
        onSeeked={captureThumb}
        onLoadedData={captureThumb}
        onEnded={() => { setPlaying(false); setProg(0); cancelAnimationFrame(rafRef.current); setShowCtrl(true); setStarted(false); }}
        onError={() => {}}
      />

      {/* Poster overlay — first frame thumbnail, shown before play */}
      {showPoster && thumbUrl && (
        <img src={thumbUrl} alt="" style={{
          position: "absolute", inset: 0, width: "100%", height: H,
          objectFit: "cover", display: "block", pointerEvents: "none",
        }} />
      )}

      {/* Dark gradient overlay */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(to bottom, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.72) 100%)",
        pointerEvents: "none",
      }} />

      {/* Duration badge (top-right) when not started */}
      {!playing && (
        <div style={{
          position: "absolute", top: 9, right: 9,
          background: "rgba(0,0,0,0.62)",
          backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
          borderRadius: 8, padding: "3px 8px",
          color: "#fff", fontSize: 11, fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          border: "1px solid rgba(255,255,255,0.1)",
        }}>{fmtTime(dur)}</div>
      )}

      {/* Center play / pause button */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        opacity: showCtrl ? 1 : 0, transition: "opacity 0.25s ease",
        pointerEvents: showCtrl ? "auto" : "none",
      }}>
        <div style={{
          width: 58, height: 58, borderRadius: "50%",
          background: "rgba(255,255,255,0.12)",
          backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
          border: "1.5px solid rgba(255,255,255,0.22)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "transform 0.18s cubic-bezier(0.34,1.56,0.64,1)",
          transform: playing ? "scale(0.88)" : "scale(1)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.42)",
        }}>
          {playing ? <IcPause /> : <IcPlay />}
        </div>
      </div>

      {/* Bottom controls */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        padding: "24px 10px 8px",
        opacity: showCtrl ? 1 : 0, transition: "opacity 0.25s ease",
        pointerEvents: showCtrl ? "auto" : "none",
      }} onClick={e => e.stopPropagation()}>

        {/* Progress bar */}
        <ProgressBar
          prog={prog} buffered={buffered}
          accent={accent} accent2={accent2}
          onSeek={(ratio) => {
            const v = videoRef.current; if (!v || !v.duration) return;
            v.currentTime = ratio * v.duration;
            setProg(ratio); revealCtrl();
          }}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{
            color: "rgba(255,255,255,0.7)", fontSize: 11,
            fontWeight: 600, fontVariantNumeric: "tabular-nums",
          }}>
            {fmtTime(videoRef.current?.currentTime || 0)} / {fmtTime(dur)}
          </span>
          <button onClick={downloadVideo}
            style={{
              background: "rgba(255,255,255,0.1)",
              backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.85)", cursor: "pointer",
              padding: "4px 8px", borderRadius: 8,
              display: "inline-flex", alignItems: "center", justifyContent:"center",
              fontSize: 12, fontWeight: 700, fontFamily: "inherit", marginRight: 6,
            }}>⬇</button>
          {/* Fullscreen button */}
          <button onClick={e => { e.stopPropagation(); setFullscreen(true); }}
            style={{
              background: "rgba(255,255,255,0.1)",
              backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.85)", cursor: "pointer",
              padding: "4px 8px", borderRadius: 8,
              display: "flex", alignItems: "center", gap: 5,
              fontSize: 10, fontWeight: 600, fontFamily: "inherit",
            }}>
            <IcFull /> <span>На весь экран</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VideoFullscreen — full custom player modal
// ═══════════════════════════════════════════════════════════════════════════════
function VideoFullscreen({ src, fileName, videoRef: _ignored, playing: _p, setPlaying: _sp,
  prog: _pr, setProg: _spr, dur: _d, fmt: _f, tick: _t, onClose, initialTime }) {
  React.useEffect(() => { injectVpStyles(); }, []);
  const { accent, accent2 } = useContext(ThemeCtx);

  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const rafRef = useRef(null);
  const ctrlTimer = useRef(null);

  // ── State ──
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [showCtrl, setShowCtrl] = useState(true);
  const [volume, setVolume] = useState(1);
  const [brightness, setBrightness] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  // Gesture indicator
  const [gesture, setGesture] = useState(null); // { type, value }
  const gestureTimer = useRef(null);

  // Seek flash (double-tap animation)
  const [seekFlash, setSeekFlash] = useState(null); // "left" | "right"
  const seekFlashTimer = useRef(null);

  // Swipe-down to close
  const [swipeY, setSwipeY] = useState(0);
  const swipeStart = useRef(null);

  // Touch gesture tracking
  const touchData = useRef(null); // { startX, startY, startTime, type: null|"seek"|"volume"|"brightness" }
  const lastTap = useRef({ time: 0, x: 0 });
  // Флаг "только что был тач" — чтобы синтезированный onClick после touch не
  // вызвал повторный toggle (что вернуло бы состояние обратно).
  const justTouched = useRef(false);
  const touchCooldown = useRef(null);
  // Время последнего реального touch-события — для блокировки синтетических mousemove
  const lastTouchTime = useRef(0);

  // Dragging progress bar
  const dragRef = useRef(false);

  // ── Init ──
  useEffect(() => {
    injectVpStyles();
    setPipSupported(!!document.pictureInPictureEnabled);
    const v = videoRef.current; if (!v) return;

    // Регистрируем как активное — останавливает другие видео
    _registerActiveVideo(v);

    if (initialTime) v.currentTime = initialTime;
    v.volume = volume;
    v.playbackRate = speed;
    v.play().then(() => {
      setPlaying(true);
      rafRef.current = requestAnimationFrame(rafTick);
    }).catch(() => {});
    revealCtrl();

    // ── Регистрируем глобальный коллбек закрытия — его вызовет App-level
    //    обработчик кнопки Назад (см. useEffect c "backbutton" в корневом App).
    //    Это надёжнее чем регистрировать собственный слушатель Capacitor:
    //    избегает двойного срабатывания и гонок при размонтировании.
    _videoFullscreenClose = onClose;

    // ── Скрываем статусбар и навбар Android ──────────────────────────────
    // Стратегия: 1) Browser Fullscreen API — самый надёжный путь к полному
    // immersive-режиму в Android WebView (Chromium поддерживает),
    // 2) Capacitor StatusBar.hide() как страховка,
    // 3) NavigationBar плагин если он установлен.
    const hideSystemBars = async () => {
      // 1) Browser Fullscreen API
      try {
        const el = containerRef.current;
        if (el) {
          if (el.requestFullscreen) await el.requestFullscreen().catch(() => {});
          else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
          else if (el.msRequestFullscreen) el.msRequestFullscreen();
        }
      } catch(e) {}
      // 2) Capacitor StatusBar + NavigationBar
      try {
        if (window?.Capacitor?.isNativePlatform?.()) {
          const { StatusBar } = await import("@capacitor/status-bar").catch(() => ({}));
          if (StatusBar) {
            try { await StatusBar.hide(); } catch(e) {}
            // Дополнительно: пусть webview перекрывает зону статус-бара
            try { await StatusBar.setOverlaysWebView({ overlay: true }); } catch(e) {}
          }
          try {
            const nbPlugin = window.Capacitor?.Plugins?.NavigationBar;
            if (nbPlugin?.hide) await nbPlugin.hide();
          } catch(e) {}
        }
      } catch(e) {}
    };
    hideSystemBars();

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(ctrlTimer.current);
      clearTimeout(gestureTimer.current);
      clearTimeout(seekFlashTimer.current);
      clearTimeout(touchCooldown.current);
      _unregisterActiveVideo(v);

      // Снимаем глобальный коллбек закрытия
      if (_videoFullscreenClose === onClose) _videoFullscreenClose = null;

      // Восстанавливаем статусбар и навбар + выходим из browser fullscreen
      (async () => {
        try {
          if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
          else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
        } catch(e) {}
        try {
          if (window?.Capacitor?.isNativePlatform?.()) {
            const { StatusBar } = await import("@capacitor/status-bar").catch(() => ({}));
            if (StatusBar) {
              try { await StatusBar.setOverlaysWebView({ overlay: false }); } catch(e) {}
              try { await StatusBar.show(); } catch(e) {}
            }
            try {
              const nbPlugin = window.Capacitor?.Plugins?.NavigationBar;
              if (nbPlugin?.show) await nbPlugin.show();
            } catch(e) {}
          }
        } catch(e) {}
      })();
    };
  }, []);

  const rafTick = () => {
    const v = videoRef.current; if (!v) return;
    if (v.duration && !dragRef.current) {
      setProg(v.currentTime / v.duration);
      if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1) / v.duration);
    }
    if (!v.paused && !v.ended) rafRef.current = requestAnimationFrame(rafTick);
  };

  // ── Controls visibility ──
  const revealCtrl = () => {
    setShowCtrl(true);
    clearTimeout(ctrlTimer.current);
    // Only auto-hide when playing, not on pause
    if (videoRef.current && !videoRef.current.paused) {
      ctrlTimer.current = setTimeout(() => setShowCtrl(false), 3000);
    }
  };

  // ── Playback ──
  const toggle = (e) => {
    e?.stopPropagation();
    const v = videoRef.current; if (!v) return;
    if (v.paused) {
      v.play().then(() => { setPlaying(true); rafRef.current = requestAnimationFrame(rafTick); }).catch(() => {});
      // re-arm hide timer after play
      clearTimeout(ctrlTimer.current);
      ctrlTimer.current = setTimeout(() => setShowCtrl(false), 3000);
    } else {
      v.pause(); setPlaying(false); cancelAnimationFrame(rafRef.current);
      clearTimeout(ctrlTimer.current); // stay visible on pause
    }
  };

  const seekBy = (sec) => {
    const v = videoRef.current; if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
    setProg(v.currentTime / v.duration);
    revealCtrl();
  };

  // ── Gesture indicator ──
  const showGesture = (type, value) => {
    setGesture({ type, value });
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => setGesture(null), 900);
  };

  const flashSeek = (side) => {
    setSeekFlash(side);
    clearTimeout(seekFlashTimer.current);
    seekFlashTimer.current = setTimeout(() => setSeekFlash(null), 520);
  };

  // ── Mouse wheel → volume ──
  const onWheel = (e) => {
    e.preventDefault();
    const v = videoRef.current; if (!v) return;
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    const newVol = Math.max(0, Math.min(1, v.volume + delta));
    v.volume = newVol;
    setVolume(newVol);
    showGesture("volume", newVol);
    revealCtrl();
  };

  // ── Touch handlers ──
  // Стратегия: всегда отслеживаем тач, но помечаем флагами isOverlay/isButton.
  // - Тап на кнопке (isButton): кнопка обрабатывает сама, мы только ставим
  //   justTouched чтобы синтез-click не натворил дел.
  // - Тап на фоне overlay (isOverlay && !isButton): toggle контролов
  //   (как тап на видео).
  // - Жесты (свайп-сик/громкость/яркость) пропускаются если isOverlay,
  //   чтобы драг по верхней/нижней панели не запускал перемотку.
  const onTouchStart = (e) => {
    lastTouchTime.current = Date.now(); // запоминаем время реального тача
    const isOverlay = !!e.target.closest("[data-notouch]");
    const isButton = !!e.target.closest("button");
    const t = e.touches[0];
    touchData.current = {
      startX: t.clientX, startY: t.clientY,
      startTime: Date.now(), type: null,
      startVol: videoRef.current?.volume ?? 1,
      startBright: brightness,
      isOverlay, isButton,
    };
    swipeStart.current = null;
  };

  const onTouchMove = (e) => {
    const td = touchData.current; if (!td) return;
    // На overlay-областях (топ/центр/низ) жесты не обрабатываем —
    // только тап для toggle контролов (это сделает onTouchEnd).
    if (td.isOverlay) return;
    const t = e.touches[0];
    const dx = t.clientX - td.startX;
    const dy = t.clientY - td.startY;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);

    // Determine gesture type once
    if (!td.type) {
      if (absDx < 8 && absDy < 8) return;
      td.type = absDx > absDy ? "seek" : (td.startX < window.innerWidth / 2 ? "brightness" : "volume");
    }

    const v = videoRef.current;
    if (td.type === "seek") {
      if (!v || !v.duration) return;
      const seekDelta = (dx / window.innerWidth) * v.duration * 0.8;
      const newTime = Math.max(0, Math.min(v.duration, v.currentTime + seekDelta));
      // Show preview seek without committing (commit on touchEnd)
      td.seekTarget = newTime;
      showGesture("seek", Math.round(seekDelta));
    } else if (td.type === "volume") {
      if (!v) return;
      const newVol = Math.max(0, Math.min(1, td.startVol - dy / 200));
      v.volume = newVol;
      setVolume(newVol);
      showGesture("volume", newVol);
    } else if (td.type === "brightness") {
      const newBright = Math.max(0.1, Math.min(2, td.startBright - dy / 200));
      setBrightness(newBright);
      showGesture("brightness", Math.min(1, newBright));
    }

    // Swipe-down to close (only when no horizontal gesture)
    if (td.type !== "seek" && td.type !== "brightness" && td.type !== "volume") {
      if (dy > 0 && absDy > absDx) setSwipeY(dy);
    }
  };

  const onTouchEnd = (e) => {
    const td = touchData.current;
    if (!td) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - td.startX;
    const dy = t.clientY - td.startY;
    const dt = Date.now() - td.startTime;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);

    // ── Тач начался на overlay (топ-бар / центр-контролы / низ-бар) ──
    // Жесты не обрабатывались (см. onTouchMove). Здесь решаем что делать:
    //  - кнопка → только ставим justTouched (кнопка отработает свой onClick)
    //  - фон overlay + это был тап (мало движения, короткий) → toggle контролов
    if (td.isOverlay) {
      touchData.current = null;
      if (td.isButton) {
        // Тап по кнопке — пусть кнопка сама отработает свой клик.
        // Гасим возможный последующий синтез-click на контейнере.
        justTouched.current = true;
        clearTimeout(touchCooldown.current);
        touchCooldown.current = setTimeout(() => { justTouched.current = false; }, 400);
        return;
      }
      // Фон overlay (padding верхней/нижней панели и т.п.) — toggle.
      if (absDx < 10 && absDy < 10 && dt < 300) {
        if (showCtrl) {
          clearTimeout(ctrlTimer.current);
          setShowCtrl(false);
        } else {
          revealCtrl();
        }
        justTouched.current = true;
        clearTimeout(touchCooldown.current);
        touchCooldown.current = setTimeout(() => { justTouched.current = false; }, 400);
      }
      return;
    }

    // Commit seek gesture
    if (td.type === "seek" && td.seekTarget !== undefined) {
      const v = videoRef.current;
      if (v) v.currentTime = td.seekTarget;
    }

    // Swipe down to close
    if (!td.type && dy > 120 && absDy > absDx) {
      videoRef.current?.pause();
      onClose();
      return;
    }
    if (swipeY > 120) {
      videoRef.current?.pause();
      onClose();
      return;
    }
    setSwipeY(0);

    // Double-tap detection (only when it was a tap, not a gesture)
    if (absDx < 10 && absDy < 10 && dt < 300) {
      const now = Date.now();
      const prev = lastTap.current;
      const sameArea = Math.abs(t.clientX - prev.x) < 80;
      if (now - prev.time < 350 && sameArea) {
        // Double tap!
        const side = t.clientX < window.innerWidth / 2 ? "left" : "right";
        seekBy(side === "left" ? -10 : 10);
        flashSeek(side);
        lastTap.current = { time: 0, x: 0 };
        touchData.current = null;
        return;
      }
      lastTap.current = { time: now, x: t.clientX };
      // Single tap → toggle controls (показываем если скрыты, скрываем если видны).
      // Раньше скрытие работало только во время воспроизведения — это мешало
      // пользователю самостоятельно закрыть оверлей. Теперь скрываем всегда.
      if (showCtrl) {
        clearTimeout(ctrlTimer.current);
        setShowCtrl(false);
      } else {
        revealCtrl();
      }
      // Отмечаем что был тап — пропустим следующий синтезированный onClick,
      // чтобы он не отменил скрытие повторным toggle.
      justTouched.current = true;
      clearTimeout(touchCooldown.current);
      touchCooldown.current = setTimeout(() => { justTouched.current = false; }, 400);
    }

    touchData.current = null;
    // Не вызываем revealCtrl() здесь — управление показывается только через одиночный тап
  };

  // ── Seek from progress bar ──
  const onProgressSeek = (ratio) => {
    const v = videoRef.current; if (!v || !v.duration) return;
    v.currentTime = ratio * v.duration;
    setProg(ratio);
  };

  // ── Download ──
  const doDownload = async () => {
    setDownloading(true);
    try {
      await downloadToDevice(src, fileName || "video.mp4");
    } catch (e) {
      try {
        const a = document.createElement("a"); a.href = src; a.download = fileName || "video.mp4";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch (e2) {}
    }
    setDownloading(false);
  };

  // ── PiP ──
  const doPip = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (videoRef.current) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (e) {}
  };

  // ── Speed ──
  const onSpeedSelect = (s) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  const opacity = Math.max(0, 1 - swipeY / 200);
  const scale = Math.max(0.9, 1 - swipeY / 1000);
  const currentTime = videoRef.current?.currentTime || 0;

  return (
    <div ref={containerRef} style={{
      position: "fixed", inset: 0, zIndex: 3000,
      background: `rgba(0,0,0,${opacity})`,
      display: "flex", alignItems: "center", justifyContent: "center",
      transform: `translateY(${swipeY}px) scale(${scale})`,
      transition: swipeY === 0 ? "transform 0.3s cubic-bezier(0.25,0.46,0.45,0.94)" : "none",
      touchAction: "none",
    }}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseMove={(e) => {
        // Игнорируем синтетические mousemove после touch (браузер генерирует их автоматически).
        // Реальные движения мышью имеют movementX/Y != 0 или приходят спустя >600мс после тача.
        if (Date.now() - lastTouchTime.current < 600) return;
        revealCtrl();
      }}
      onClick={(e) => {
        // Пропускаем синтезированный click после touch (touchEnd уже отработал).
        if (justTouched.current) return;
        if (e.target === containerRef.current || e.target === videoRef.current) {
          // Toggle: скрываем если показаны, показываем если скрыты.
          if (showCtrl) {
            clearTimeout(ctrlTimer.current);
            setShowCtrl(false);
          } else {
            revealCtrl();
          }
        }
      }}
    >
      {/* ── Video ── */}
      <video
        ref={videoRef}
        src={src}
        playsInline
        style={{
          width: "100%", height: "100%",
          objectFit: "contain", display: "block",
          filter: `brightness(${brightness})`,
        }}
        onLoadedMetadata={e => { setDur(e.target.duration); }}
        onEnded={() => { setPlaying(false); cancelAnimationFrame(rafRef.current); setShowCtrl(true); }}
        onError={() => {}}
      />

      {/* ── Seek flash ── */}
      {seekFlash && <SeekFlash side={seekFlash} />}

      {/* ── Gesture indicator pill ── */}
      {gesture && <GesturePill type={gesture.type} value={gesture.value} />}

      {/* ── Speed popup ── */}
      {showSpeed && (
        <SpeedPopup
          speed={speed} accent={accent}
          onSelect={onSpeedSelect}
          onClose={() => setShowSpeed(false)}
        />
      )}

      {/* ════════════════════════════════════════════════
          TOP BAR
      ════════════════════════════════════════════════ */}
      <div data-notouch="1" style={{
        position: "absolute", top: 0, left: 0, right: 0,
        padding: "max(env(safe-area-inset-top,16px),16px) 14px 36px",
        background: "linear-gradient(rgba(0,0,0,0.8) 0%, transparent 100%)",
        display: "flex", alignItems: "center", gap: 10,
        opacity: showCtrl ? 1 : 0, transition: "opacity 0.28s ease",
        pointerEvents: showCtrl ? "auto" : "none",
      }} onClick={e => e.stopPropagation()}>

        {/* Back button */}
        <button onClick={onClose} style={{
          width: 40, height: 40, borderRadius: "50%", border: "none",
          cursor: "pointer", flexShrink: 0,
          background: "rgba(255,255,255,0.12)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.15s",
        }}>
          <IcBack />
        </button>

        {/* File name */}
        <div style={{
          flex: 1, color: "#fff", fontSize: 14, fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.92,
        }}>{fileName || "Видео"}</div>

        {/* PiP */}
        {pipSupported && (
          <button onClick={doPip} style={{
            width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
            background: "rgba(255,255,255,0.12)",
            backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <IcPip />
          </button>
        )}

        {/* Download */}
        <button onClick={doDownload} style={{
          width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
          background: "rgba(255,255,255,0.12)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          opacity: downloading ? 0.5 : 1, transition: "opacity 0.2s",
        }}>
          {downloading
            ? <div style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.25)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "_vpSpin 0.8s linear infinite" }} />
            : <IcDown />
          }
        </button>
      </div>

      {/* ════════════════════════════════════════════════
          CENTER CONTROLS: ±15s + Play/Pause
      ════════════════════════════════════════════════ */}
      <div data-notouch="1" style={{
        position: "absolute",
        display: "flex", alignItems: "center", gap: 32,
        opacity: showCtrl ? 1 : 0, transition: "opacity 0.28s ease",
        pointerEvents: showCtrl ? "auto" : "none",
      }} onClick={e => e.stopPropagation()}>

        {/* -15s */}
        <button onClick={() => seekBy(-15)} style={{
          background: "rgba(0,0,0,0.42)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.1)",
          width: 52, height: 52, borderRadius: "50%", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "transform 0.15s cubic-bezier(0.34,1.56,0.64,1)",
        }}
          onMouseDown={e => e.currentTarget.style.transform = "scale(0.85)"}
          onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
          onTouchStart={e => { e.stopPropagation(); e.currentTarget.style.transform = "scale(0.85)"; }}
          onTouchEnd={e => { e.stopPropagation(); seekBy(-15); e.currentTarget.style.transform = "scale(1)"; }}
        >
          <IcSeekB />
        </button>

        {/* Play/Pause */}
        <button onClick={toggle} style={{
          width: 72, height: 72, borderRadius: "50%", cursor: "pointer",
          background: "rgba(255,255,255,0.12)",
          backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: "1.5px solid rgba(255,255,255,0.18)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
          transition: "transform 0.18s cubic-bezier(0.34,1.56,0.64,1)",
        }}
          onMouseDown={e => e.currentTarget.style.transform = "scale(0.88)"}
          onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
        >
          {playing ? <IcPause /> : <IcPlay />}
        </button>

        {/* +15s */}
        <button onClick={() => seekBy(15)} style={{
          background: "rgba(0,0,0,0.42)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.1)",
          width: 52, height: 52, borderRadius: "50%", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "transform 0.15s cubic-bezier(0.34,1.56,0.64,1)",
        }}
          onMouseDown={e => e.currentTarget.style.transform = "scale(0.85)"}
          onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
          onTouchStart={e => { e.stopPropagation(); e.currentTarget.style.transform = "scale(0.85)"; }}
          onTouchEnd={e => { e.stopPropagation(); seekBy(15); e.currentTarget.style.transform = "scale(1)"; }}
        >
          <IcSeekF />
        </button>
      </div>

      {/* ════════════════════════════════════════════════
          BOTTOM BAR: progress + time + speed
      ════════════════════════════════════════════════ */}
      <div data-notouch="1" style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        padding: "48px 18px max(env(safe-area-inset-bottom,20px),20px)",
        background: "linear-gradient(transparent 0%, rgba(0,0,0,0.82) 100%)",
        opacity: showCtrl ? 1 : 0, transition: "opacity 0.28s ease",
        pointerEvents: showCtrl ? "auto" : "none",
      }} onClick={e => e.stopPropagation()}>

        {/* Progress bar */}
        <ProgressBar
          prog={prog} buffered={buffered}
          accent={accent} accent2={accent2}
          onSeek={onProgressSeek}
          onDragStart={() => { dragRef.current = true; clearTimeout(ctrlTimer.current); }}
          onDragEnd={() => {
            dragRef.current = false;
            if (videoRef.current && !videoRef.current.paused) {
              ctrlTimer.current = setTimeout(() => setShowCtrl(false), 3000);
            }
          }}
        />

        {/* Time + Speed row */}
        <div style={{
          display: "flex", alignItems: "center",
          justifyContent: "space-between", marginTop: 8,
        }}>
          {/* Elapsed / Total */}
          <span style={{
            color: "rgba(255,255,255,0.78)", fontSize: 13,
            fontWeight: 600, fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.02em",
          }}>
            {fmtTime(currentTime)}
            <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 400, margin: "0 4px" }}>/</span>
            {fmtTime(dur)}
          </span>

          {/* Right: speed + volume */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Volume indicator (bar) */}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 13 }}>🔊</span>
              <div style={{ width: 48, height: 3, background: "rgba(255,255,255,0.18)", borderRadius: 2 }}>
                <div style={{
                  height: "100%", borderRadius: 2, background: "rgba(255,255,255,0.7)",
                  width: `${volume * 100}%`, transition: "width 0.1s",
                }} />
              </div>
            </div>

            {/* Speed button */}
            <button onClick={() => setShowSpeed(s => !s)} style={{
              background: showSpeed ? `${accent}22` : "rgba(255,255,255,0.1)",
              backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
              border: `1px solid ${showSpeed ? accent + "66" : "rgba(255,255,255,0.15)"}`,
              color: showSpeed ? accent : "rgba(255,255,255,0.85)",
              cursor: "pointer", padding: "5px 12px", borderRadius: 10,
              fontSize: 13, fontWeight: 700, fontFamily: "inherit",
              transition: "all 0.18s", minWidth: 46, textAlign: "center",
            }}>
              {speed === 1 ? "1×" : `${speed}×`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileBubble({msg,fromMe,onOpenLightbox}){
  const {accent,text2,text}=useContext(ThemeCtx);
  const src=msg.fileUrl||msg.fileData||"";

  // Оболочка файла: сохранён офлайн без загрузки (тип "Только текстовые"
  // или файл превысил лимит размера). Показываем как есть, без скачивания.
  if(msg._shell&&!src){
    const shExt=(msg.fileName||"FILE").split(".").pop().toUpperCase().slice(0,5);
    return(
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:180,opacity:0.85}}>
        <div style={{width:44,height:44,borderRadius:12,
          background:fromMe?"rgba(255,255,255,0.14)":accent+"22",
          display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <span style={{fontSize:20}}>📎</span>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:fromMe?"rgba(255,255,255,0.9)":text,fontSize:13,fontWeight:600,
            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>
            {msg.fileName||(shExt!=="FILE"?shExt+"-файл":"Файл")}
          </div>
          <div style={{color:fromMe?"rgba(255,255,255,0.5)":text2,fontSize:11,marginTop:2}}>
            {msg.fileSize?fmtSize(msg.fileSize)+" · ":""}не сохранён офлайн
          </div>
        </div>
      </div>
    );
  }

  // Detect type
  const isImage = msg.type==="image"||
    msg.fileType?.startsWith("image/")||
    /\.(jpg|jpeg|png|gif|webp|heic|bmp)$/i.test(msg.fileName||"")||
    src.startsWith("data:image/");

  const isAudio = msg.type==="audio"||
    msg.type==="voice"||
    msg.fileType?.startsWith("audio/")||
    /\.(mp3|m4a|aac|wav|ogg|flac|opus|wma|aiff|ape|alac|dsd|dsf|amr)$/i.test(msg.fileName||"");

  const isVideo = msg.type==="video"||
    msg.fileType?.startsWith("video/")||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(msg.fileName||"");

  if(isImage)return(
    <div style={{borderRadius:14,overflow:"hidden",maxWidth:260,cursor:"pointer",
      boxShadow:"0 2px 12px rgba(0,0,0,0.35)"}}
      onClick={e=>{
        // Снимаем bounding rect миниатюры — Lightbox использует его как стартовую
        // точку анимации zoom-from-thumbnail. Если onOpenLightbox недоступен,
        // оставляем прежний fallback на window.open.
        const r=e.currentTarget.getBoundingClientRect();
        const originRect={left:r.left,top:r.top,width:r.width,height:r.height};
        if(onOpenLightbox)onOpenLightbox({src,fileName:msg.fileName,fileType:msg.fileType||"image/jpeg",originRect});
        else window.open(src,"_blank");
      }}>
      <img src={src} alt={msg.fileName||"Фото"}
        style={{width:"100%",display:"block",maxHeight:320,objectFit:"cover"}}
        onError={e=>{e.target.style.display="none";}}/>
    </div>
  );

  if(isAudio)return <AudioPlayer msg={msg} fromMe={fromMe}/>;

  if(isVideo)return <VideoPlayer src={src} fileName={msg.fileName||"video.mp4"} fromMe={fromMe} onOpenLightbox={onOpenLightbox}/>;

  const ext=(msg.fileName||"FILE").split(".").pop().toUpperCase().slice(0,5);
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:180,cursor:"pointer"}}
      onClick={()=>{
        if(!src)return;
        // Открываем Lightbox (как для фото) — внутри есть кнопка «Скачать»,
        // использующая downloadToDevice. НЕ используем window.open: в Android WebView
        // это уводит пользователя во внешний браузер.
        if(onOpenLightbox){
          onOpenLightbox({src,fileName:msg.fileName||"file",fileType:msg.fileType||"application/octet-stream"});
        }else{
          // Резервный путь, если Lightbox недоступен — качаем напрямую
          downloadToDevice(src,msg.fileName||"file");
        }
      }}>
      <div style={{width:44,height:44,borderRadius:12,
        background:fromMe?"rgba(255,255,255,0.18)":accent+"33",
        display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <span style={{color:fromMe?"#fff":accent,fontSize:10,fontWeight:800}}>{ext}</span>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:fromMe?"rgba(255,255,255,0.9)":text,fontSize:13,fontWeight:600,
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>
          {msg.fileName||"Файл"}
        </div>
        <div style={{color:fromMe?"rgba(255,255,255,0.5)":text2,fontSize:11,marginTop:2}}>
          {msg.fileSize?fmtSize(msg.fileSize):""} ↓
        </div>
      </div>
    </div>
  );
}

// ─── Reply Preview ────────────────────────────────────────────────────────────
function ReplyBar({msg,onCancel}){
  const {accent,surface2,text2,border}=useContext(ThemeCtx);
  if(!msg)return null;
  const preview=msg.type==="voice"?"🎙 Голосовое"
    :msg.type==="circle"?"⭕ Кружок"
    :msg.type==="image"?"🖼 Фото"
    :msg.type==="video"?"🎬 Видео"
    :msg.type==="audio"?"🎵 "+(msg.fileName||"Аудио")
    :msg.type==="sticker"?msg.text
    :msg.type==="file"?(msg.fileType?.startsWith("image/")?"🖼 Фото":"📎 "+(msg.fileName||"Файл"))
    :msg.text||"";
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:surface2,borderLeft:`3px solid ${accent}`,margin:"0 0 6px"}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:accent,fontSize:11,fontWeight:700,marginBottom:2}}>{msg.author}</div>
        <div style={{color:text2,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{preview}</div>
      </div>
      {onCancel&&<button onClick={onCancel} style={{background:"none",border:"none",color:text2,fontSize:18,cursor:"pointer",flexShrink:0}}>✕</button>}
    </div>
  );
}

function ReplyInBubble({msg,fromMe}){
  const {accent,text2}=useContext(ThemeCtx);
  if(!msg)return null;
  const isImg=msg.type==="image"||(msg.type==="file"&&msg.fileType?.startsWith("image/"));
  const isVideo=msg.type==="video";
  const isVoice=msg.type==="voice";
  const isCircle=msg.type==="circle";
  const isAudio=msg.type==="audio";
  const preview=isVoice?"🎙 Голосовое"
    :isCircle?"⭕ Кружок"
    :isVideo?"🎬 Видео"
    :isAudio?"🎵 "+(msg.fileName||"Аудио")
    :msg.type==="sticker"?msg.text
    :isImg?"🖼 Фото"
    :msg.type==="file"?"📎 "+(msg.fileName||"Файл")
    :msg.text||"";
  const thumbSrc=isImg?(msg.fileData||msg.fileUrl):isCircle?(msg.videoThumb||msg.videoUrl||msg.videoData):isVideo?(msg.videoThumb||msg.fileUrl||msg.fileData):null;
  return(
    <div style={{display:"flex",alignItems:"center",gap:6,borderLeft:`2.5px solid ${fromMe?"rgba(255,255,255,0.5)":accent}`,paddingLeft:7,marginBottom:6,opacity:0.88}}>
      {thumbSrc&&(
        <div style={{width:32,height:32,borderRadius:6,overflow:"hidden",flexShrink:0}}>
          {isCircle
            ? <video src={thumbSrc} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            : <img src={thumbSrc} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          }
        </div>
      )}
      {isVoice&&<span style={{fontSize:16}}>🎙</span>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:fromMe?"rgba(255,255,255,0.75)":accent,fontSize:11,fontWeight:700,marginBottom:1}}>{msg.author}</div>
        <div style={{color:fromMe?"rgba(255,255,255,0.55)":text2,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>{preview}</div>
      </div>
    </div>
  );
}

// ─── Emoji/Sticker Panel ──────────────────────────────────────────────────────
// Категоризированные эмодзи (без дублей с STICKER_PACKS)
const EMOJI_CATEGORIES = [
  { id:"recent",   icon:"🕒", name:"Недавние",    emojis:null /* динамический */ },
  { id:"smileys",  icon:"😀", name:"Смайлы",      emojis:["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥸","🥳","🤗","🤭","🫢","🫣","🤫","🤔","🫡","🤐"] },
  { id:"emotions", icon:"😢", name:"Эмоции",      emojis:["😐","😑","😶","🫥","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🥺","🥹","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😠","😡","🤬","🤡","👿","😈","💀","☠️","👻","👽","👾","🤖"] },
  { id:"hearts",   icon:"❤️", name:"Сердца",       emojis:["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","❤️‍🩹","💖","💗","💓","💞","���","💟","❣️","💌","💘","💝","💋","♥️","💯","💢","💥","💫","💦","💨","💭","💤"] },
  { id:"gestures", icon:"👍", name:"Жесты",       emojis:["👍","👎","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","🫵","🫱","🫲","🫳","🫴","👈","👉","👆","👇","☝️","✋","🤚","🖐","🖖","👋","🤝","🫶","🙏","💪","🦾","👏","🙌","👐","🤲","🤜","🤛","✊","👊","🫦","👀","👁","👅","👄","👂","🦻","👃","🧠","🫀","🫁","💅"] },
  { id:"animals",  icon:"🐶", name:"Животные",    emojis:["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐽","🐸","🐵","🙈","🙉","🙊","🐒","🐔","🐧","🐦","🐤","🐣","🐥","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🦂","🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🦧","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🐃","🐂","🐄","🐎","🐖","🐏","🐑","🦙","🐐","🦌","🐕","🐩","🐈","🐓","🦃","🦚","🦜","🦢","🦩","🕊","🐇","🐁","🐀","🐿","🌵","🎄","🌲","🌳","🌴","🌱","🌿","☘️","🍀","🎍","🪴","🎋","🍃","🍂","🍁","🍄","🐚","🌾","💐","🌷","🌹","🥀","🌺","🌸","🌼","🌻","🌞","🌝","🌛","🌜","🌚","🌕","🌖","🌗","🌘","🌑","🌒","🌓","🌔","🌙","🌎","🌍","🌏","🪐","⭐","🌟","⚡","☄️","🌪","🌈","☀️","⛅","☁️","🌧","⛈","🌩","🌨","❄️","☃️","⛄","💨","💧","☔","🌊"] },
  { id:"food",     icon:"🍔", name:"Еда",          emojis:["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑","🥦","🥬","🥒","🌶","🫑","🌽","🥕","🫒","🧄","🧅","🥔","🍠","🥐","🥯","🍞","🥖","🥨","🧀","🥚","🍳","🧈","🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🥪","🥙","🧆","🌮","🌯","🫔","🥗","🥘","🫕","🥫","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🦪","🍤","🍙","🍚","🍘","🍥","🥠","🥮","🍢","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🌰","🥜","🍯","🥛","🍼","🫖","☕","🍵","🧃","🥤","🧋","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🍾","🧊","🥄","🍴","🍽","🥣","🥡","🥢","🧂"] },
  { id:"activity", icon:"⚽", name:"Активности",  emojis:["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🪀","🏓","🏸","🏒","🏑","🥍","🏏","🥅","⛳","🪁","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷","⛸","🥌","🎿","⛷","🏂","🪂","🏋️","🤼","🤸","⛹️","🤺","🤾","🏌️","🏇","🧘","🏄","🏊","🤽","🚣","🧗","🚵","🚴","🏆","🥇","🥈","🥉","🏅","🎖","🎫","🎟","🎪","🤹","🎭","🩰","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🎻","🎲","♟","🎯","🎳","🎮","🎰","🧩"] },
  { id:"travel",   icon:"✈️", name:"Транспорт",   emojis:["🚗","🚕","🚙","🚌","🚎","🏎","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🛴","🚲","🛵","🏍","🛺","🚨","🚔","🚍","🚘","🚖","🚡","🚠","🚟","🚃","🚋","🚞","🚝","🚄","🚅","🚈","🚂","🚆","🚇","🚊","🚉","✈️","🛫","🛬","🛩","💺","🛰","🚀","🛸","🚁","🛶","⛵","🚤","🛥","🛳","⛴","🚢","⚓","⛽","🚧","🚦","🚥","🗺","🗿","🗽","🗼","🏰","🏯","🏟","🎡","🎢","🎠","⛲","⛱","🏖","🏝","🏜","🌋","⛰","🏔","🗻","🏕","⛺"] },
  { id:"objects",  icon:"💡", name:"Объекты",     emojis:["⌚","📱","📲","💻","⌨️","🖥","🖨","🖱","💽","💾","💿","📀","📼","📷","📸","📹","🎥","📽","🎞","📞","☎️","📟","📠","📺","📻","🎙","⏱","⏲","⏰","🕰","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯","🧯","🛢","💸","💵","💴","💶","💷","🪙","💰","💳","💎","⚖️","🧰","🔧","🔨","🛠","⛏","🔩","⚙️","🧱","⛓","🧲","🔫","💣","🧨","🪓","🔪","🗡","⚔️","🛡","🚬","⚰️","⚱️","🏺","🔮","📿","🧿","💈","⚗️","🔭","🔬","🩹","🩺","💊","💉","🩸","🧬","🦠","🧫","🧪","🌡","🧹","🧺","🧻","🚽","🚰","🚿","🛁","🛀","🧼","🧽","🛎","🔑","🗝","🚪","🪑","🛋","🛏","🧸","🖼","🛍","🛒","🎁","🎈","🎀","🎊","🎉","✉️","📩","📨","📧","📥","📤","📦","🏷","📜","📃","📄","📑","🧾","📊","📈","📉","🗒","🗓","📆","📅","🗑","📋","📁","📂","🗞","📰","📓","📔","📒","📕","📗","📘","📙","📚","📖","🔖","🧷","🔗","📎","🖇","📐","📏","🧮","📌","📍","✂️","🖊","🖋","✒️","🖌","🖍","📝","✏️","🔍","🔎","🔏","🔐","🔒","🔓"] },
  { id:"symbols",  icon:"✨", name:"Символы",     emojis:["✨","⭐","🌟","💫","🔥","🎉","🎊","💯","✅","❌","⭕","🛑","⛔","📛","🚫","💢","♨️","🚷","🚯","🚳","🚱","🔞","📵","🚭","❗","❕","❓","❔","‼️","⁉️","🔅","🔆","〽️","⚠️","🚸","🔱","⚜️","🔰","♻️","🈯","💹","❇️","✳️","❎","🌐","💠","Ⓜ️","🌀","🏧","🚾","♿","🅿️","🆑","🆒","🆓","🆕","🆖","🆗","🆙","🆚","ℹ️","🅰️","🅱️","🆎","🅾️","🆘","☢️","☣️","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","⛎","🔀","🔁","🔂","▶️","⏩","⏭","⏯","◀️","⏪","⏮","🔼","⏫","🔽","⏬","⏸","⏹","⏺","⏏️","🎵","🎶","➕","➖","➗","✖️","♾","💲","💱","™️","©️","®️","🔠","🔡","🔢","🔣","🔤","♠️","♣️","♥️","♦️","🃏","🎴","🀄","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚","🕛"] },
];

const RECENT_EMOJI_KEY = "rmg_recent_emojis";
const getRecentEmojis = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || "[]"); }
  catch { return []; }
};
const saveRecentEmoji = (emoji, currentList) => {
  const next = [emoji, ...currentList.filter(e => e !== emoji)].slice(0, 32);
  try { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)); } catch {}
  return next;
};

function EmojiPanel({open, onEmoji, onSticker, onClose}){
  const {surface,surface2,border,text,text2,accent}=useContext(ThemeCtx);
  const[recent,setRecent]=useState(getRecentEmojis);
  // tab: 0..(EMOJI_CATEGORIES.length-1) = эмодзи-категории, далее — стикерпаки
  const[tab,setTab]=useState(()=>recent.length>0?0:1);
  const[mounted,setMounted]=useState(open);
  const[closing,setClosing]=useState(false);
  const gridRef=useRef(null);
  const tabsRef=useRef(null);

  // Lifecycle: handle open/close with exit animation
  useEffect(()=>{
    let t;
    if(open){
      setMounted(true);
      setClosing(false);
      // освежить недавние при открытии
      setRecent(getRecentEmojis());
    } else if(mounted){
      setClosing(true);
      t=setTimeout(()=>{setMounted(false);setClosing(false);},220);
    }
    return ()=>{if(t)clearTimeout(t);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open]);

  // Scroll grid to top on tab change
  useEffect(()=>{
    if(gridRef.current)gridRef.current.scrollTop=0;
  },[tab]);

  // Scroll active tab into view in tabs bar
  useEffect(()=>{
    if(!tabsRef.current)return;
    const activeBtn=tabsRef.current.querySelector(`[data-tab-idx="${tab}"]`);
    if(activeBtn&&activeBtn.scrollIntoView){
      try{activeBtn.scrollIntoView({behavior:"smooth",inline:"center",block:"nearest"});}catch{}
    }
  },[tab]);

  if(!mounted)return null;

  // Объединённые вкладки: эмодзи-категории + стикерпаки
  const stickerStart=EMOJI_CATEGORIES.length;
  const isStickerTab=tab>=stickerStart;
  const current=isStickerTab
    ? {...STICKER_PACKS[tab-stickerStart], type:"sticker", icon:STICKER_PACKS[tab-stickerStart].stickers[0]}
    : {...EMOJI_CATEGORIES[tab], type:"emoji"};

  let items;
  if(isStickerTab){
    items=STICKER_PACKS[tab-stickerStart].stickers;
  } else if(current.id==="recent"){
    items=recent;
  } else {
    items=current.emojis||[];
  }

  const handleSelect=(item)=>{
    if(isStickerTab){
      onSticker(item);
    } else {
      // Сохраняем в недавние (но не само поле «Недавние»)
      setRecent(prev=>saveRecentEmoji(item,prev));
      onEmoji(item);
    }
  };

  // КРИТИЧНО: onMouseDown preventDefault — чтобы инпут не терял фокус,
  // не срабатывал onBlur и не сбрасывал state. Это и есть фикс главного бага.
  const noBlur=(e)=>e.preventDefault();

  return(
    <div
      onClick={e=>e.stopPropagation()}
      onMouseDown={noBlur}
      style={{
        background:surface,
        borderTop:`1px solid ${border}`,
        // Скруглений не делаем сверху: панель теперь прилегает прямо к инпуту,
        // как клавиатура. Резкая граница выглядит естественней.
        borderRadius:0,
        boxShadow:"0 -6px 24px rgba(0,0,0,0.3)",
        // ~ высота экранной клавиатуры телефона
        height:300,
        maxHeight:"50vh",
        display:"flex",
        flexDirection:"column",
        overflow:"hidden",
        transformOrigin:"bottom center",
        willChange:"transform,opacity",
        animation:closing
          ? "emojiPanelOut 0.22s cubic-bezier(0.4,0,1,1) forwards"
          // Плавная анимация без overshoot — клавиатуры не «отскакивают»
          : "emojiPanelIn 0.24s cubic-bezier(0.32,0.72,0,1)",
      }}
    >
      {/* Header: drag-индикатор + название категории */}
      <div style={{
        display:"flex",
        alignItems:"center",
        justifyContent:"flex-start",
        padding:"8px 14px 8px",
        borderBottom:`1px solid ${border}`,
        flexShrink:0,
        background:surface,
      }}>
        <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0,flex:1}}>
          <span style={{fontSize:17,lineHeight:1,flexShrink:0}}>{current.icon}</span>
          <span style={{
            color:text,
            fontSize:13,
            fontWeight:700,
            whiteSpace:"nowrap",
            overflow:"hidden",
            textOverflow:"ellipsis"
          }}>
            {isStickerTab?`Стикеры · ${current.name}`:current.name}
          </span>
        </div>
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        className="emoji-grid-scroll"
        style={{
          flex:1,
          overflowY:"auto",
          overflowX:"hidden",
          padding:"8px 6px 6px",
          display:"grid",
          gridTemplateColumns:isStickerTab
            ? "repeat(auto-fill,minmax(58px,1fr))"
            : "repeat(auto-fill,minmax(42px,1fr))",
          // ВАЖНО: явно задаём высоту строк. Без этого браузер пытается
          // вычислить высоту через aspect-ratio детей, что ломается на больших
          // списках (Животные/Еда/Объекты/Символы) — эмодзи накладываются.
          gridAutoRows:isStickerTab?"58px":"42px",
          gap:2,
          alignContent:"start",
          minHeight:0,
          WebkitOverflowScrolling:"touch",
        }}
      >
        {items.length===0?(
          <div style={{
            gridColumn:"1 / -1",
            textAlign:"center",
            color:text2,
            padding:"50px 20px",
            fontSize:13,
            lineHeight:1.5,
            opacity:0.7,
          }}>
            {current.id==="recent"
              ? <>🕒<br/>Здесь появятся недавно<br/>использованные эмодзи</>
              : "Пусто"}
          </div>
        ):items.map((e,i)=>(
          <button
            key={`${current.id}-${i}-${e}`}
            onMouseDown={noBlur}
            onClick={()=>handleSelect(e)}
            style={{
              width:"100%",
              height:"100%",
              borderRadius:10,
              border:"none",
              background:"transparent",
              fontSize:isStickerTab?30:24,
              cursor:"pointer",
              display:"flex",
              alignItems:"center",
              justifyContent:"center",
              padding:0,
              margin:0,
              fontFamily:"inherit",
              lineHeight:1,
              transition:"background 0.12s, transform 0.08s",
              WebkitTapHighlightColor:"transparent",
              userSelect:"none",
            }}
            onMouseEnter={ev=>ev.currentTarget.style.background=surface2}
            onMouseLeave={ev=>{ev.currentTarget.style.background="transparent";ev.currentTarget.style.transform="scale(1)";}}
            onTouchStart={ev=>{ev.currentTarget.style.background=accent+"33";ev.currentTarget.style.transform="scale(1.18)";}}
            onTouchEnd={ev=>{ev.currentTarget.style.background="transparent";ev.currentTarget.style.transform="scale(1)";}}
            onTouchCancel={ev=>{ev.currentTarget.style.background="transparent";ev.currentTarget.style.transform="scale(1)";}}
          >{e}</button>
        ))}
      </div>

      {/* Bottom tabs bar */}
      <div
        ref={tabsRef}
        className="emoji-tabs-row"
        style={{
          display:"flex",
          gap:2,
          padding:"5px 6px 6px",
          paddingBottom:"max(5px,env(safe-area-inset-bottom,5px))",
          overflowX:"auto",
          overflowY:"hidden",
          borderTop:`1px solid ${border}`,
          background:surface,
          flexShrink:0,
          WebkitOverflowScrolling:"touch",
        }}
      >
        {EMOJI_CATEGORIES.map((c,i)=>{
          const active=tab===i;
          return (
            <button
              key={c.id}
              data-tab-idx={i}
              onMouseDown={noBlur}
              onClick={()=>setTab(i)}
              title={c.name}
              style={{
                flexShrink:0,
                width:38,
                height:38,
                borderRadius:10,
                border:"none",
                background:active?accent+"22":"transparent",
                color:active?accent:text2,
                fontSize:19,
                lineHeight:1,
                cursor:"pointer",
                display:"flex",
                alignItems:"center",
                justifyContent:"center",
                position:"relative",
                padding:0,
                fontFamily:"inherit",
                transition:"background 0.15s",
                WebkitTapHighlightColor:"transparent",
                filter:active?"none":"grayscale(0.5) opacity(0.85)",
              }}
            >
              {c.icon}
              {active&&(
                <div style={{
                  position:"absolute",
                  bottom:-3,
                  left:"50%",
                  transform:"translateX(-50%)",
                  width:16,
                  height:2,
                  borderRadius:1,
                  background:accent,
                }}/>
              )}
            </button>
          );
        })}
        {/* Разделитель между эмодзи и стикерами */}
        <div style={{flexShrink:0,width:1,margin:"6px 4px",background:border}}/>
        {STICKER_PACKS.map((p,i)=>{
          const tabIdx=stickerStart+i;
          const active=tab===tabIdx;
          return (
            <button
              key={p.name}
              data-tab-idx={tabIdx}
              onMouseDown={noBlur}
              onClick={()=>setTab(tabIdx)}
              title={`Стикеры: ${p.name}`}
              style={{
                flexShrink:0,
                width:38,
                height:38,
                borderRadius:10,
                border:"none",
                background:active?accent+"22":"transparent",
                color:active?accent:text2,
                fontSize:20,
                lineHeight:1,
                cursor:"pointer",
                display:"flex",
                alignItems:"center",
                justifyContent:"center",
                position:"relative",
                padding:0,
                fontFamily:"inherit",
                transition:"background 0.15s",
                WebkitTapHighlightColor:"transparent",
                filter:active?"none":"grayscale(0.5) opacity(0.85)",
              }}
            >
              {p.stickers[0]}
              {active&&(
                <div style={{
                  position:"absolute",
                  bottom:-3,
                  left:"50%",
                  transform:"translateX(-50%)",
                  width:16,
                  height:2,
                  borderRadius:1,
                  background:accent,
                }}/>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Group Members Modal ────────────────────────────────────────────────────
function GroupMembersModal({chat,currentUser,onClose}){
  const {surface,border,text,text2,accent}=useContext(ThemeCtx);
  const[members,setMembers]=useState([]);
  useEffect(()=>{
    Promise.all((chat.members||[]).map(uid=>getDoc(doc(db,"users",uid))))
      .then(docs=>setMembers(docs.filter(d=>d.exists()).map(d=>d.data())));
  },[]);
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:600,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{background:surface,borderRadius:"22px 22px 0 0",width:"100%",maxHeight:"70vh",display:"flex",flexDirection:"column",animation:"slideUp 0.3s ease"}} onClick={e=>e.stopPropagation()}>
        <div style={{padding:"10px 16px 8px",borderBottom:`1px solid ${border}`}}>
          <div style={{width:36,height:4,background:border,borderRadius:2,margin:"0 auto 10px"}}/>
          <div style={{color:text,fontWeight:700,fontSize:16}}>👥 Участники ({members.length})</div>
        </div>
        <div style={{overflowY:"auto",padding:"6px 0"}}>
          {members.map(m=>(
            <div key={m.uid} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px"}}>
              <Avatar name={m.name} size={44} photo={m.photo}/>
              <div style={{flex:1}}>
                <div style={{color:text,fontWeight:600,fontSize:14}}>{m.name} {m.uid===chat.creatorUid?"👑":""}</div>
                <div style={{color:accent,fontSize:12}}>@{m.tag}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Add Members Modal ────────────────────────────────────────────────────────
function AddMembersModal({chat,currentUser,onClose}){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[q,setQ]=useState(""),[ results,setResults]=useState([]),[ added,setAdded]=useState([]),[ members,setMembers]=useState(chat.members||[]),[ loading,setLoading]=useState(false);
  const search=async()=>{
    if(!q.trim())return;setLoading(true);
    const clean=q.trim().replace(/^@/,"").toLowerCase();
    const byTag=await getDocs(query(collection(db,"users"),where("tag","==",clean)));
    const found=[];byTag.forEach(d=>{if(!members.includes(d.id))found.push(d.data());});
    if(!found.length){const all=await getDocs(collection(db,"users"));all.forEach(d=>{const u=d.data();if(!members.includes(d.id)&&u.name?.toLowerCase().includes(clean))found.push(u);});}
    setResults(found);setLoading(false);
  };
  const addMember=async(person)=>{
    try{await updateDoc(doc(db,"chats",chat.id),{members:arrayUnion(person.uid)});setMembers(m=>[...m,person.uid]);setAdded(a=>[...a,person.uid]);}
    catch(e){alert("Ошибка: "+e.message);}
  };
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:500,display:"flex",alignItems:"flex-end",animation:"fadeIn 0.2s ease"}} onClick={onClose}>
      <div style={{background:surface,borderRadius:"24px 24px 0 0",padding:24,width:"100%",maxHeight:"75dvh",display:"flex",flexDirection:"column",animation:"slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)"}} onClick={e=>e.stopPropagation()}>
        <div style={{width:36,height:4,background:border,borderRadius:2,margin:"0 auto 18px"}}/>
        <div style={{color:text,fontWeight:700,fontSize:17,marginBottom:14}}>👥 Добавить участников</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()} placeholder="@тег или имя" autoFocus style={{flex:1,background:surface2,border:`1.5px solid ${border}`,borderRadius:14,padding:"12px 14px",color:text,fontSize:14,outline:"none",fontFamily:"inherit"}}/>
          <button onClick={search} style={{padding:"0 16px",background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:14,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Найти</button>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          {loading&&<div style={{textAlign:"center",color:text2,padding:20}}>Поиск...</div>}
          {results.map(p=>{const isAdded=added.includes(p.uid)||members.includes(p.uid);return(
            <div key={p.uid} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${border}`}}>
              <Avatar name={p.name} size={44} photo={p.photo}/>
              <div style={{flex:1}}><div style={{color:text,fontWeight:600,fontSize:14}}>{p.name}</div><div style={{color:accent,fontSize:12}}>@{p.tag}</div></div>
              <button onClick={()=>!isAdded&&addMember(p)} style={{padding:"8px 14px",background:isAdded?surface2:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:12,color:isAdded?text2:"#fff",fontSize:13,fontWeight:600,cursor:isAdded?"default":"pointer",fontFamily:"inherit",transition:"all 0.2s"}}>
                {isAdded?"✓ Добавлен":"Добавить"}
              </button>
            </div>
          );})}
        </div>
        <button onClick={onClose} style={{marginTop:14,padding:13,background:surface2,border:"none",borderRadius:14,color:text2,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>Закрыть</button>
      </div>
    </div>
  );
}

// ─── Profile View ─────────────────────────────────────────────────────────────
function StoryViewer({items,startIndex=0,currentUser,profile,onClose}){
  const {surface,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const PHOTO_STORY_MS=10000;
  const[idx,setIdx]=useState(startIndex);
  const[showUi,setShowUi]=useState(true);
  const[paused,setPaused]=useState(false);
  const[storyProgress,setStoryProgress]=useState(0);
  const[liked,setLiked]=useState(false);
  const[views,setViews]=useState([]);
  const[likes,setLikes]=useState([]);
  const[showViews,setShowViews]=useState(false);
  const[showLikes,setShowLikes]=useState(false);
  const[showActions,setShowActions]=useState(false);
  const[actionBusy,setActionBusy]=useState(false);
  const[confirmDelete,setConfirmDelete]=useState(false);
  const[closing,setClosing]=useState(false);
  const videoRef=useRef(null);
  const pausedRef=useRef(false);
  const pressRef=useRef({x:0,y:0,holding:false,t:null,startTime:0,duration:0,dragged:false});
  const story=items[idx];
  const mine=story?.uid===currentUser.uid;
  const close=useCallback(()=>{setClosing(true);setTimeout(()=>onClose?.(),220);},[onClose]);
  const next=useCallback(()=>setIdx(i=>i<items.length-1?i+1:(close(),i)),[items.length,close]);
  const prev=useCallback(()=>setIdx(i=>i>0?i-1:i),[]);

  useEffect(()=>{
    const back=e=>{try{e?.preventDefault?.();e?.stopPropagation?.();}catch{}close();return true;};
    _storyBackHandler=back;
    document.addEventListener("backbutton",back,true);
    let h=null;
    try{window?.Capacitor?.Plugins?.App?.addListener?.("backButton",back).then(x=>h=x).catch(()=>{});}catch{}
    return()=>{
      if(_storyBackHandler===back)_storyBackHandler=null;
      document.removeEventListener("backbutton",back,true);
      try{h?.remove?.();}catch{}
    };
  },[close]);

  useEffect(()=>{
    setShowUi(true);
    setPaused(false);
    setStoryProgress(0);
    setShowViews(false);
    setShowLikes(false);
    setShowActions(false);
  },[idx]);

  useEffect(()=>{pausedRef.current=paused;},[paused]);

  useEffect(()=>{
    if(!story?.id)return;
    let unsubViews=null,unsubLikes=null,dead=false;
    (async()=>{
      try{
        const vr=doc(db,"stories",story.id,"views",currentUser.uid);
        const existed=await getDoc(vr);
        await setDoc(vr,{uid:currentUser.uid,name:profile?.name||"",photo:profile?.photo||"",time:serverTimestamp()},{merge:true});
        if(!existed.exists())updateDoc(doc(db,"stories",story.id),{viewCount:increment(1)}).catch(()=>{});
      }catch{}
      try{
        const ls=await getDoc(doc(db,"stories",story.id,"likes",currentUser.uid));
        if(!dead)setLiked(ls.exists());
      }catch{}
    })();
    unsubViews=onSnapshot(collection(db,"stories",story.id,"views"),s=>setViews(s.docs.map(d=>({id:d.id,...d.data()}))),()=>{});
    unsubLikes=onSnapshot(collection(db,"stories",story.id,"likes"),s=>setLikes(s.docs.map(d=>({id:d.id,...d.data()}))),()=>{});
    return()=>{dead=true;unsubViews?.();unsubLikes?.();};
  },[story?.id,currentUser.uid,profile?.name,profile?.photo]);

  useEffect(()=>{
    if(!story)return;
    let raf=0;
    let start=performance.now();
    let pausedAt=0;
    let pausedTotal=0;
    let wasPaused=pausedRef.current;
    const tick=now=>{
      if(story.mediaType==="video"){
        const v=videoRef.current;
        const dur=v?.duration||0;
        if(Number.isFinite(dur)&&dur>0)setStoryProgress(Math.max(0,Math.min(1,(v.currentTime||0)/dur)));
        raf=requestAnimationFrame(tick);
        return;
      }
      if(pausedRef.current){
        if(!wasPaused){pausedAt=now;wasPaused=true;}
        raf=requestAnimationFrame(tick);
        return;
      }
      if(wasPaused){
        if(pausedAt)pausedTotal+=now-pausedAt;
        pausedAt=0;
        wasPaused=false;
      }
      const p=Math.max(0,Math.min(1,(now-start-pausedTotal)/PHOTO_STORY_MS));
      setStoryProgress(p);
      if(p>=1){next();return;}
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(raf);
  },[story?.id,story?.mediaType,next]);

  useEffect(()=>{
    const v=videoRef.current;
    if(!v)return;
    if(paused)v.pause();else v.play().catch(()=>{});
  },[paused,idx]);

  if(!story)return null;

  const toggleLike=async()=>{
    const r=doc(db,"stories",story.id,"likes",currentUser.uid);
    try{
      if(liked){
        await deleteDoc(r);
        updateDoc(doc(db,"stories",story.id),{likeCount:increment(-1)}).catch(()=>{});
        setLiked(false);
      }else{
        await setDoc(r,{uid:currentUser.uid,name:profile?.name||"",photo:profile?.photo||"",time:serverTimestamp()});
        updateDoc(doc(db,"stories",story.id),{likeCount:increment(1)}).catch(()=>{});
        setLiked(true);
      }
    }catch{}
  };

  const downloadStory=async()=>{
    if(!story?.mediaUrl||actionBusy)return;
    setActionBusy(true);
    try{
      const ext=story.mediaType==="video"?"mp4":"jpg";
      await downloadToDevice(story.mediaUrl,`story_${story.author||"redmrx"}_${Date.now()}.${ext}`);
    }catch{}
    setActionBusy(false);
    setShowActions(false);
  };

  const deleteStory=async()=>{
    if(!mine||!story?.id||actionBusy)return;
    if(!await appConfirm("Удалить эту историю?","Удалить"))return;
    setActionBusy(true);
    try{
      await deleteDoc(doc(db,"stories",story.id));
      setShowActions(false);
      close();
    }catch(e){
      alert("Не удалось удалить историю");
    }
    setActionBusy(false);
  };

  const deleteStoryNow=async()=>{
    if(!mine||!story?.id||actionBusy)return;
    setActionBusy(true);
    try{
      await deleteDoc(doc(db,"stories",story.id));
      setConfirmDelete(false);
      setShowActions(false);
      close();
    }catch(e){
      alert("Не удалось удалить историю");
    }
    setActionBusy(false);
  };

  const storyPointerDown=e=>{
    if(e.target?.closest?.("[data-story-control='1']"))return;
    try{e.currentTarget.setPointerCapture?.(e.pointerId);}catch{}
    const v=videoRef.current;
    const duration=Number.isFinite(v?.duration)?v.duration:0;
    pressRef.current={
      x:e.clientX||0,
      y:e.clientY||0,
      holding:false,
      t:null,
      startTime:v?.currentTime||0,
      duration,
      dragged:false
    };
    pressRef.current.t=setTimeout(()=>{
      pressRef.current.holding=true;
      setPaused(true);
    },180);
  };
  const storyPointerMove=e=>{
    if(e.target?.closest?.("[data-story-control='1']"))return;
    const p=pressRef.current;
    const dx=(e.clientX||0)-p.x;
    const dy=(e.clientY||0)-p.y;
    if(!p.holding){
      if(dy>90&&Math.abs(dy)>Math.abs(dx)*1.3){
        if(p.t)clearTimeout(p.t);
        pressRef.current={x:0,y:0,holding:false,t:null,startTime:0,duration:0,dragged:false};
        close();
      }
      return;
    }
    if(story.mediaType==="video"&&p.duration>0){
      p.dragged=true;
      const ratio=dx/Math.max(1,window.innerWidth);
      const target=Math.max(0,Math.min(p.duration,p.startTime+ratio*p.duration));
      const v=videoRef.current;
      if(v){
        try{v.currentTime=target;}catch{}
      }
      setStoryProgress(Math.max(0,Math.min(1,target/p.duration)));
    }
  };
  const storyPointerUp=e=>{
    if(e.target?.closest?.("[data-story-control='1']"))return;
    const p=pressRef.current;
    if(p.t)clearTimeout(p.t);
    const dx=Math.abs((e.clientX||0)-p.x),dy=Math.abs((e.clientY||0)-p.y);
    if(p.holding){
      setPaused(false);
      pressRef.current={x:0,y:0,holding:false,t:null,startTime:0,duration:0,dragged:false};
      return;
    }
    if((e.clientY||0)-p.y>90&&dy>dx*1.3){
      close();
      pressRef.current={x:0,y:0,holding:false,t:null,startTime:0,duration:0,dragged:false};
      return;
    }
    if(dx<18&&dy<22){
      if(story.mediaType==="video")setPaused(v=>!v);
    }
    pressRef.current={x:0,y:0,holding:false,t:null,startTime:0,duration:0,dragged:false};
  };
  const storyPointerCancel=()=>{
    const p=pressRef.current;
    if(p.t)clearTimeout(p.t);
    if(p.holding)setPaused(false);
    pressRef.current={x:0,y:0,holding:false,t:null,startTime:0,duration:0,dragged:false};
  };

  return createPortal(
    <div className="rmg-story-viewer" onPointerDown={storyPointerDown} onPointerMove={storyPointerMove} onPointerUp={storyPointerUp} onPointerCancel={storyPointerCancel} style={{position:"fixed",inset:0,zIndex:5000,background:"#000",overflow:"hidden",touchAction:"none",animation:closing?"storyOut .22s cubic-bezier(0.4,0,0.2,1) forwards":"storyIn .28s cubic-bezier(0.22,0.61,0.36,1)"}}>
      <style>{`.rmg-story-viewer > button[data-story-control="1"]{display:none!important}`}</style>
      {story.mediaType==="video"?(
        <video ref={videoRef} src={story.mediaUrl} poster={story.videoThumb||""} autoPlay playsInline onEnded={next}
          style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",background:"#000"}}/>
      ):( 
        <img src={story.mediaUrl} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",background:"#000"}}/>
      )}
      <div style={{position:"absolute",left:0,right:0,top:0,zIndex:4,padding:"max(env(safe-area-inset-top,24px),22px) 12px 14px",background:"linear-gradient(to bottom,rgba(0,0,0,.82),transparent)",opacity:showUi?1:0,transform:showUi?"translateY(0)":"translateY(-16px)",transition:"opacity .25s,transform .25s",pointerEvents:showUi?"auto":"none"}}>
        <div style={{display:"flex",gap:4,marginBottom:12}}>
          {items.map((_,i)=>{
            const fill=i<idx?1:i===idx?storyProgress:0;
            return(
              <div key={i} style={{height:3,flex:1,borderRadius:4,background:"rgba(255,255,255,.25)",overflow:"hidden"}}>
                <div style={{height:"100%",width:`${Math.max(0,Math.min(1,fill))*100}%`,borderRadius:4,background:"#fff",transition:story.mediaType==="video"?"width .12s linear":"width .08s linear"}}/>
              </div>
            );
          })}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Avatar name={story.author||"?"} photo={story.authorPhoto} size={38}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{color:"#fff",fontWeight:800,fontSize:14,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{story.author||"Story"}</div>
            <div style={{color:"rgba(255,255,255,.72)",fontSize:11}}>{story.createdAtMs?new Date(story.createdAtMs).toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"}):""}</div>
          </div>
          <button data-story-control="1" onClick={e=>{e.stopPropagation();setShowActions(true);setShowUi(true);}} style={{width:38,height:38,borderRadius:"50%",border:"1px solid rgba(255,255,255,.22)",background:"rgba(255,255,255,.12)",backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",color:"#fff",fontSize:20,lineHeight:1}}>⋯</button>
          <button data-story-control="1" onClick={e=>{e.stopPropagation();close();}} style={{width:38,height:38,borderRadius:"50%",border:"1px solid rgba(255,255,255,.25)",background:"rgba(0,0,0,.35)",color:"#fff",fontSize:18}}>×</button>
        </div>
      </div>
      <button data-story-control="1" onClick={e=>{e.stopPropagation();setShowActions(true);setShowUi(true);}} style={{position:"absolute",top:"max(env(safe-area-inset-top,24px),22px)",right:12,width:38,height:38,borderRadius:"50%",border:"1px solid rgba(255,255,255,.22)",background:"rgba(255,255,255,.12)",backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",color:"#fff",fontSize:20,lineHeight:1,opacity:showUi?1:0,transition:"opacity .25s",pointerEvents:showUi?"auto":"none",zIndex:3}}>⋯</button>
      <div data-story-control="1" style={{position:"absolute",left:0,right:0,bottom:0,padding:"14px 16px max(env(safe-area-inset-bottom,18px),18px)",background:"linear-gradient(to top,rgba(0,0,0,.7),transparent)",display:"flex",alignItems:"center",justifyContent:"space-between",opacity:showUi?1:0,transform:showUi?"translateY(0)":"translateY(16px)",transition:"opacity .25s,transform .25s",pointerEvents:showUi?"auto":"none"}}>
        <button onClick={e=>{e.stopPropagation();toggleLike();}} style={{border:"none",borderRadius:999,padding:"10px 16px",background:liked?`linear-gradient(135deg,${accent},${accent2})`:"rgba(255,255,255,.14)",color:"#fff",fontWeight:800,fontSize:15}}>{liked?"♥":"♡"} {likes.length}</button>
        {mine&&<button onClick={e=>{e.stopPropagation();setShowLikes(true);}} style={{border:"none",borderRadius:999,padding:"10px 16px",background:"rgba(255,255,255,.14)",color:"#fff",fontWeight:800,fontSize:15}}>♥ {likes.length}</button>}
        {mine&&<button onClick={e=>{e.stopPropagation();setShowViews(true);}} style={{border:"none",borderRadius:999,padding:"10px 16px",background:"rgba(255,255,255,.14)",color:"#fff",fontWeight:800,fontSize:15}}>👁 {views.length}</button>}
      </div>
      {showViews&&(
        <div data-story-control="1" onClick={e=>{e.stopPropagation();setShowViews(false);}} style={{position:"absolute",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxHeight:"58vh",overflowY:"auto",background:surface,borderRadius:"22px 22px 0 0",borderTop:`1px solid ${border}`,padding:"12px 0 max(env(safe-area-inset-bottom,18px),18px)",animation:"sheetUp .22s cubic-bezier(.22,.61,.36,1)"}}>
            <div style={{width:42,height:4,borderRadius:3,background:border,margin:"0 auto 12px"}}/>
            <div style={{color:text,fontWeight:800,fontSize:16,padding:"0 18px 10px"}}>Просмотры</div>
            {views.length===0&&<div style={{color:text2,padding:"18px",textAlign:"center"}}>Пока никто не смотрел</div>}
            {views.map(v=><div key={v.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 18px",borderTop:`1px solid ${border}66`}}><Avatar name={v.name||"?"} photo={v.photo} size={42}/><div style={{color:text,fontWeight:700,fontSize:14}}>{v.name||"Пользователь"}</div></div>)}
          </div>
        </div>
      )}
      {showLikes&&(
        <div data-story-control="1" onClick={e=>{e.stopPropagation();setShowLikes(false);}} style={{position:"absolute",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"flex-end",zIndex:2}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxHeight:"58vh",overflowY:"auto",background:surface,borderRadius:"22px 22px 0 0",borderTop:`1px solid ${border}`,padding:"12px 0 max(env(safe-area-inset-bottom,18px),18px)",animation:"sheetUp .22s cubic-bezier(.22,.61,.36,1)"}}>
            <div style={{width:42,height:4,borderRadius:3,background:border,margin:"0 auto 12px"}}/>
            <div style={{color:text,fontWeight:800,fontSize:16,padding:"0 18px 10px"}}>Кто поставил лайк</div>
            {likes.length===0&&<div style={{color:text2,padding:"18px",textAlign:"center"}}>Пока лайков нет</div>}
            {likes.map(v=><div key={v.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 18px",borderTop:`1px solid ${border}66`}}><Avatar name={v.name||"?"} photo={v.photo} size={42}/><div style={{color:text,fontWeight:700,fontSize:14}}>{v.name||"Пользователь"}</div></div>)}
          </div>
        </div>
      )}
      {showActions&&(
        <div data-story-control="1" onClick={e=>{e.stopPropagation();setShowActions(false);}} style={{position:"absolute",inset:0,background:"rgba(0,0,0,.42)",display:"flex",alignItems:"flex-end",zIndex:2}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",background:"rgba(18,18,18,.94)",backdropFilter:"blur(24px)",WebkitBackdropFilter:"blur(24px)",borderRadius:"22px 22px 0 0",borderTop:"1px solid rgba(255,255,255,.12)",padding:"10px 12px max(env(safe-area-inset-bottom,18px),18px)",animation:"sheetUp .22s cubic-bezier(.22,.61,.36,1)"}}>
            <div style={{width:42,height:4,borderRadius:3,background:"rgba(255,255,255,.22)",margin:"0 auto 10px"}}/>
            <button onClick={downloadStory} disabled={actionBusy} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 12px",background:"transparent",border:"none",borderBottom:"1px solid rgba(255,255,255,.08)",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"inherit",opacity:actionBusy?0.7:1}}>
              <span style={{width:26,textAlign:"center"}}>⬇</span> Скачать
            </button>
            {mine&&(
              <button onClick={()=>{setShowActions(false);setConfirmDelete(true);}} disabled={actionBusy} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 12px",background:"transparent",border:"none",borderBottom:"1px solid rgba(255,255,255,.08)",color:"#FF5A5F",fontSize:15,fontWeight:800,fontFamily:"inherit",opacity:actionBusy?0.7:1}}>
                <span style={{width:26,textAlign:"center"}}>✕</span> Удалить историю
              </button>
            )}
            {mine&&(
              <button onClick={()=>{setShowActions(false);setShowViews(true);}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 12px",background:"transparent",border:"none",borderBottom:"1px solid rgba(255,255,255,.08)",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"inherit"}}>
                <span style={{width:26,textAlign:"center"}}>👁</span> Кто смотрел
              </button>
            )}
            {!mine&&(
              <button onClick={()=>{setShowActions(false);alert("Жалоба отправлена");}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 12px",background:"transparent",border:"none",borderBottom:"1px solid rgba(255,255,255,.08)",color:"#fff",fontSize:15,fontWeight:700,fontFamily:"inherit"}}>
                <span style={{width:26,textAlign:"center"}}>!</span> Пожаловаться
              </button>
            )}
            <button onClick={()=>setShowActions(false)} style={{width:"100%",padding:"14px 12px",background:"transparent",border:"none",color:"rgba(255,255,255,.7)",fontSize:15,fontWeight:700,fontFamily:"inherit"}}>Закрыть</button>
          </div>
        </div>
      )}
      {confirmDelete&&(
        <div data-story-control="1" onClick={e=>{e.stopPropagation();setConfirmDelete(false);}} style={{position:"absolute",inset:0,zIndex:4,background:"rgba(0,0,0,.58)",display:"flex",alignItems:"center",justifyContent:"center",padding:22}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"min(360px,100%)",background:"rgba(22,22,22,.96)",border:"1px solid rgba(255,255,255,.12)",borderRadius:20,padding:18,boxShadow:"0 20px 60px rgba(0,0,0,.7)",backdropFilter:"blur(22px)",WebkitBackdropFilter:"blur(22px)",animation:"modalPop .2s cubic-bezier(.22,.61,.36,1)"}}>
            <div style={{color:"#fff",fontWeight:900,fontSize:18,marginBottom:8}}>Удалить историю?</div>
            <div style={{color:"rgba(255,255,255,.72)",fontSize:14,lineHeight:1.45,marginBottom:16}}>Вы действительно хотите удалить историю? Это действие нельзя отменить.</div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmDelete(false)} style={{flex:1,padding:"12px 10px",borderRadius:14,border:"1px solid rgba(255,255,255,.12)",background:"rgba(255,255,255,.08)",color:"#fff",fontWeight:800,fontFamily:"inherit"}}>Отмена</button>
              <button onClick={deleteStoryNow} disabled={actionBusy} style={{flex:1,padding:"12px 10px",borderRadius:14,border:"none",background:"#FF3B30",color:"#fff",fontWeight:900,fontFamily:"inherit",opacity:actionBusy?0.7:1}}>Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

function StoriesBar({currentUser,profile}){
  const {surface,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[contacts,setContacts]=useState([]);
  const[stories,setStories]=useState([]);
  const[rawStories,setRawStories]=useState([]);
  const[nowTick,setNowTick]=useState(Date.now());
  const[viewer,setViewer]=useState(null);
  const[uploading,setUploading]=useState(false);
  const fileRef=useRef(null);

  useEffect(()=>{
    if(!currentUser?.uid)return;
    return onSnapshot(collection(db,"users",currentUser.uid,"contacts"),s=>setContacts(s.docs.map(d=>d.id)),()=>{});
  },[currentUser?.uid]);

  useEffect(()=>{
    const t=setInterval(()=>setNowTick(Date.now()),30000);
    return()=>clearInterval(t);
  },[]);
  useEffect(()=>{
    if(!currentUser?.uid)return;
    return onSnapshot(collection(db,"stories"),snap=>{
      setRawStories(snap.docs.map(d=>({id:d.id,...d.data()})));
    },()=>{});
  },[currentUser?.uid]);
  useEffect(()=>{
    const now=Date.now();
    const expOf=st=>st.expiresAtMs||((st.createdAtMs||0)+24*60*60*1000);
    const list=rawStories
      .filter(st=>expOf(st)>now)
      .filter(st=>st.uid===currentUser?.uid||(Array.isArray(st.audienceUids)&&st.audienceUids.includes(currentUser?.uid))||contacts.includes(st.uid))
      .sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0));
    setStories(list);
  },[rawStories,nowTick,contacts.join("|"),currentUser?.uid]);

  const groups=useMemo(()=>{
    const map=new Map();
    stories.forEach(st=>{
      if(!map.has(st.uid))map.set(st.uid,{uid:st.uid,author:st.author,photo:st.authorPhoto,stories:[]});
      map.get(st.uid).stories.push(st);
    });
    const arr=Array.from(map.values()).map(g=>({...g,latest:g.stories[0]?.createdAtMs||0}));
    arr.sort((a,b)=>a.uid===currentUser.uid?-1:b.uid===currentUser.uid?1:b.latest-a.latest);
    return arr;
  },[stories,currentUser.uid]);

  const publish=async(e)=>{
    const file=e.target.files?.[0];
    e.target.value="";
    if(!file)return;
    const isVideo=file.type.startsWith("video/");
    const isImage=file.type.startsWith("image/");
    if(!isVideo&&!isImage){alert("Можно загрузить фото или видео");return;}
    setUploading(true);
    try{
      const mediaUrl=await uploadFileToFirebase(file,`stories/${currentUser.uid}`);
      const videoThumb=isVideo?await createVideoPoster(file):"";
      const now=Date.now();
      await addDoc(collection(db,"stories"),{
        uid:currentUser.uid,
        author:profile?.name||currentUser.displayName||"RedMrx",
        authorPhoto:profile?.photo||"",
        mediaUrl,
        mediaType:isVideo?"video":"image",
        videoThumb,
        createdAt:serverTimestamp(),
        createdAtMs:now,
        expiresAtMs:now+24*60*60*1000,
        audienceUids:contacts,
        viewCount:0,
        likeCount:0,
      });
    }catch(err){
      alert("Story upload failed in Firebase Storage. "+(err?.message||err));
    }finally{setUploading(false);}
  };

  return(
    <div style={{background:surface,borderBottom:`1px solid ${border}`,padding:"9px 10px 10px",overflowX:"auto",display:"flex",gap:12,flexShrink:0}}>
      <input ref={fileRef} type="file" accept="image/*,video/*" onChange={publish} style={{display:"none"}}/>
      <button onClick={()=>fileRef.current?.click()} disabled={uploading} style={{width:70,flex:"0 0 70px",background:"none",border:"none",padding:0,cursor:uploading?"default":"pointer",fontFamily:"inherit"}}>
        <div style={{position:"relative",width:58,height:58,margin:"0 auto 5px",borderRadius:"50%",padding:2,background:`linear-gradient(135deg,${accent},${accent2})`,overflow:"visible"}}>
          <Avatar name={profile?.name||"?"} photo={profile?.photo} size={54}/>
          <div style={{position:"absolute",right:-7,bottom:2,width:22,height:22,borderRadius:"50%",background:accent,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",border:`3px solid ${surface}`,fontWeight:900,zIndex:3,pointerEvents:"none"}}>+</div>
        </div>
        <div style={{color:text,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{uploading?"Загрузка":"Добавить"}</div>
      </button>
      {groups.map(g=>(
        <button key={g.uid} onClick={()=>setViewer({items:g.stories,startIndex:0})} style={{width:70,flex:"0 0 70px",background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit"}}>
          <div style={{width:58,height:58,margin:"0 auto 5px",borderRadius:"50%",padding:2,background:`linear-gradient(135deg,${g.uid===currentUser.uid?accent:"#34C759"},${accent2})`}}>
            <Avatar name={g.author||"?"} photo={g.photo} size={54}/>
          </div>
          <div style={{color:text2,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{g.uid===currentUser.uid?"Ваша":g.author}</div>
        </button>
      ))}
      {viewer&&<StoryViewer items={viewer.items} startIndex={viewer.startIndex} currentUser={currentUser} profile={profile} onClose={()=>setViewer(null)}/>}
    </div>
  );
}

function ProfileView({uid,myUid,onClose,onStartChat}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[user,setUser]=useState(null);
  const[blocked,setBlocked]=useState(false);
  const[showMenu,setShowMenu]=useState(false);
  const[imgVisible,setImgVisible]=useState(false);
  const[contactAdded,setContactAdded]=useState(false);
  const[profileTone,setProfileTone]=useState(null);
  const[profileStories,setProfileStories]=useState([]);
  const[profileViewer,setProfileViewer]=useState(null);
  const[myProfile,setMyProfile]=useState(null);
  const[qrDataUrl,setQrDataUrl]=useState("");
  const[closing,setClosing]=useState(false);
  const requestClose=useCallback(()=>{
    setClosing(true);
    setTimeout(()=>onClose?.(),240);
  },[onClose]);

  useEffect(()=>{
    _profileBackHandler=requestClose;
    return()=>{if(_profileBackHandler===requestClose)_profileBackHandler=null;};
  },[requestClose]);

  useEffect(()=>{
    if(!uid)return;
    getDoc(doc(db,"users",uid)).then(async s=>{
      const d=s.exists()?{...s.data()}:null;
      if(d&&uid!==myUid&&!(typeof d.photo==="string"&&d.photo.startsWith("data:"))){
        // Фолбэк как в Telegram: берём фото из общего чата, если в профиле пусто/битая ссылка
        try{
          const c=await getDoc(doc(db,"chats",[myUid,uid].sort().join("_")));
          const pMap=c?.exists?.()?(c.data()?.photos||{}):{};
          d.photo=bestPhoto(d.photo,pMap[uid]);
        }catch(e){}
      }
      if(d)setUser(d);
    });
    getDoc(doc(db,"users",myUid)).then(s=>{
      if(s.exists()){
        const d=s.data();
        setBlocked((d?.blocked||[]).includes(uid));
        setMyProfile(d);
      }
    });
    if(uid!==myUid){
      getDoc(doc(db,"users",myUid,"contacts",uid)).then(s=>setContactAdded(s.exists())).catch(()=>{});
    }else{
      setContactAdded(true);
    }
  },[uid,myUid]);

  useEffect(()=>{
    if(!user)return;
    const fallback=colorFor(user.name||"?");
    setProfileTone(fallback);
    if(user.photo){
      dominantColorFromImage(user.photo,fallback).then(setProfileTone);
    }
  },[user?.photo,user?.name]);

  useEffect(()=>{
    if(!uid||!user)return;
    const link=`https://redmrxgram.app/u/${encodeURIComponent(user.tag||uid)}`;
    import("qrcode").then(mod=>{
      const QR=mod.default||mod;
      return QR.toDataURL(link,{width:360,margin:1,color:{dark:"#111111",light:"#ffffff"}});
    }).then(setQrDataUrl).catch(()=>setQrDataUrl(""));
  },[uid,user?.tag]);

  useEffect(()=>{
    if(!uid||!myUid)return;
    return onSnapshot(collection(db,"stories"),snap=>{
      const now=Date.now();
      const list=snap.docs.map(d=>({id:d.id,...d.data()}))
        .filter(st=>st.uid===uid&&(st.expiresAtMs||0)>now)
        .filter(st=>uid===myUid||(Array.isArray(st.audienceUids)&&st.audienceUids.includes(myUid)))
        .sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0));
      setProfileStories(list);
    },()=>{});
  },[uid,myUid]);

  const clearChat=async()=>{
    if(!await appConfirm("Очистить историю чата у себя?","Очистить"))return;
    const chatId=[myUid,uid].sort().join("_");
    try{
      const msgs=await getDocs(collection(db,"chats",chatId,"messages"));
      await Promise.all(msgs.docs.map(d=>updateDoc(doc(db,"chats",chatId,"messages",d.id),{deletedFor:{[myUid]:true}})));
    }catch(e){}
  };

  const toggleBlock=async()=>{
    try{
      const userRef=doc(db,"users",myUid);
      const snap=await getDoc(userRef);
      const list=snap.data()?.blocked||[];
      if(blocked){await updateDoc(userRef,{blocked:list.filter(id=>id!==uid)});setBlocked(false);}
      else{await updateDoc(userRef,{blocked:[...list,uid]});setBlocked(true);}
    }catch(e){}
    setShowMenu(false);
  };

  const downloadAvatar=async()=>{
    if(!user?.photo)return;
    await downloadToDevice(user.photo,`avatar_${user.name||"user"}_${Date.now()}.jpg`);
  };

  const addProfileContact=async()=>{
    if(!user||uid===myUid||contactAdded)return;
    try{
      await setDoc(doc(db,"users",myUid,"contacts",uid),{
        uid,
        name:user.name||"",
        tag:user.tag||"",
        photo:user.photo||"",
        createdAt:serverTimestamp()
      },{merge:true});
      setContactAdded(true);
    }catch(e){}
  };

  if(!user)return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:bg,zIndex:600,
      display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{width:40,height:40,borderRadius:"50%",border:`3px solid ${accent}`,
        borderTopColor:"transparent",animation:"spin 0.8s linear infinite"}}/>
    </div>
  );

  const color=profileTone||colorFor(user.name||"?");
  const profileAccent=color;
  const hasPhoto=!!user.photo;
  const profileLink=`https://redmrxgram.app/u/${encodeURIComponent(user.tag||uid)}`;
  const profileBg=(!bg||bg==="transparent"||String(bg).includes("rgba"))?"#050505":bg;
  const profileSurface=(String(surface).includes("rgba")||surface==="transparent")?"#120203":surface;

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:600,backgroundColor:"#050505",backgroundImage:`linear-gradient(180deg,${alphaColor(profileAccent,.2)} 0%,#050505 290px,${profileBg} 100%)`,
      display:"block",overflowY:"auto",overflowX:"hidden",
      animation:closing?"profileOut .24s cubic-bezier(0.4,0,0.2,1) forwards":"pageSlideIn 0.3s cubic-bezier(0.25,0.46,0.45,0.94)",
      WebkitAnimation:closing?"profileOut .24s cubic-bezier(0.4,0,0.2,1) forwards":"pageSlideIn 0.3s cubic-bezier(0.25,0.46,0.45,0.94)"}}>

      {showMenu&&<div onClick={()=>setShowMenu(false)} style={{position:"fixed",inset:0,zIndex:39,background:"transparent"}}/>}

      <div style={{position:"relative",minHeight:286,padding:"calc(max(env(safe-area-inset-top,24px),24px) + 72px) 18px 20px",overflow:"hidden",
        background:`radial-gradient(circle at 50% -10%,${alphaColor(profileAccent,.42)} 0%,transparent 48%),linear-gradient(180deg,${alphaColor(profileAccent,.16)} 0%,rgba(0,0,0,.78) 72%,#050505 100%),#050505`}}>
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:40,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"max(env(safe-area-inset-top,24px),24px) 18px 10px",background:`linear-gradient(180deg,${alphaColor(profileAccent,.36)} 0%,rgba(5,5,5,.82) 100%)`,backdropFilter:"blur(22px)",WebkitBackdropFilter:"blur(22px)",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
          <button onClick={requestClose} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>←</button>
          <div style={{color:"#fff",fontWeight:900,fontSize:24,letterSpacing:0}}>Профиль</div>
          <div style={{position:"relative"}}>
            <button onClick={e=>{e.stopPropagation();setShowMenu(m=>!m);}} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",fontSize:24,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>⋮</button>
            {showMenu&&(
              <div style={{position:"absolute",top:58,right:0,background:surface,border:`1px solid ${border}`,borderRadius:14,minWidth:190,boxShadow:"0 8px 30px rgba(0,0,0,0.6)",zIndex:41,overflow:"hidden"}} onClick={e=>e.stopPropagation()}>
                {hasPhoto&&<button onClick={downloadAvatar} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:text,fontSize:14,borderBottom:`1px solid ${border}`}}>Скачать фото</button>}
                {uid!==myUid&&<button onClick={clearChat} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:text,fontSize:14,borderBottom:`1px solid ${border}`}}>Очистить чат</button>}
                {uid!==myUid&&<button onClick={toggleBlock} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:"#FF3B30",fontSize:14}}>{blocked?"Разблокировать":"Заблокировать"}</button>}
              </div>
            )}
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center"}}>
          <button onClick={()=>profileStories.length&&setProfileViewer({items:profileStories,startIndex:0})} style={{position:"relative",background:"transparent",border:"none",padding:0,cursor:profileStories.length?"pointer":"default",fontFamily:"inherit"}}>
            <div style={{width:116,height:116,borderRadius:"50%",padding:profileStories.length?3:0,background:profileStories.length?`linear-gradient(135deg,${profileAccent},${accent2})`:"transparent"}}>
              <Avatar name={user.name||"?"} photo={user.photo} size={116}/>
            </div>
            {profileStories.length>0&&<div style={{position:"absolute",right:4,bottom:5,width:26,height:26,borderRadius:"50%",background:accent,color:"#fff",border:`3px solid #050505`,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:16}}>+</div>}
          </button>
          <div style={{color:"#fff",fontWeight:1000,fontSize:30,lineHeight:1.08,marginTop:18,letterSpacing:0}}>{user.name}</div>
          <div style={{color:profileAccent,fontSize:18,fontWeight:800,marginTop:7}}>@{user.tag}</div>
          <div style={{color:"rgba(255,255,255,.55)",fontSize:15,marginTop:8,lineHeight:1.35}}>{user.bio||"Анонимный пользователь"}</div>
        </div>
      </div>

      {/* Cover photo */}
      <div style={{display:"none",position:"relative",flexShrink:0,height:"clamp(260px,50vw,360px)",overflow:"hidden"}}>
        {hasPhoto
          ? <img src={user.photo} alt={user.name}
              style={{width:"100%",height:"100%",objectFit:"cover",display:"block",
                opacity:imgVisible?1:0,transition:"opacity 0.4s ease",filter:"blur(0px)"}}
              onLoad={()=>setImgVisible(true)}/>
          : <div style={{width:"100%",height:"100%",
              background:`linear-gradient(160deg,${color}CC,${color}33)`}}/>
        }
        {/* Gradient overlay */}
        <div style={{position:"absolute",inset:0,
          background:`radial-gradient(circle at 30% 18%,${alphaColor(profileAccent,.55)} 0%,transparent 38%),linear-gradient(to bottom,rgba(0,0,0,0.16) 0%,transparent 42%,rgba(0,0,0,0.84) 100%)`}}/>

        {/* Back button */}
        <button onClick={onClose} style={{position:"absolute",
          top:"max(env(safe-area-inset-top,28px),28px)",left:12,
          width:36,height:36,borderRadius:"50%",
          background:"rgba(0,0,0,0.45)",border:"none",color:"#fff",
          fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",
          justifyContent:"center",backdropFilter:"blur(12px)",
          WebkitBackdropFilter:"blur(12px)",transition:"all 0.2s"}}>←</button>

        {/* 3-dot menu */}
        {uid!==myUid&&(
          <div style={{position:"absolute",top:"max(env(safe-area-inset-top,28px),28px)",right:12}}>
            <button onClick={()=>setShowMenu(m=>!m)} style={{width:36,height:36,borderRadius:"50%",
              background:"rgba(0,0,0,0.45)",border:"none",color:"#fff",
              fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",
              justifyContent:"center",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)"}}>⋮</button>
            {showMenu&&(
              <div style={{position:"absolute",top:44,right:0,background:surface,
                border:`1px solid ${border}`,borderRadius:14,minWidth:180,
                boxShadow:"0 8px 30px rgba(0,0,0,0.6)",zIndex:10,
                animation:"popIn 0.2s cubic-bezier(0.34,1.56,0.64,1)"}}
                onClick={e=>e.stopPropagation()}>
                {hasPhoto&&(
                  <button onClick={downloadAvatar} style={{width:"100%",display:"flex",alignItems:"center",gap:10,
                    padding:"12px 16px",background:"none",border:"none",cursor:"pointer",
                    fontFamily:"inherit",color:text,fontSize:14,borderBottom:`1px solid ${border}`}}>
                    📥 Скачать фото
                  </button>
                )}
                <button onClick={clearChat} style={{width:"100%",display:"flex",alignItems:"center",gap:10,
                  padding:"12px 16px",background:"none",border:"none",cursor:"pointer",
                  fontFamily:"inherit",color:text,fontSize:14,borderBottom:`1px solid ${border}`}}>
                  🗑 Очистить чат
                </button>
                <button onClick={toggleBlock} style={{width:"100%",display:"flex",alignItems:"center",gap:10,
                  padding:"12px 16px",background:"none",border:"none",cursor:"pointer",
                  fontFamily:"inherit",color:"#FF3B30",fontSize:14}}>
                  {blocked?"🔓 Разблокировать":"🚫 Заблокировать"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Name overlay */}
        <div style={{position:"absolute",bottom:16,left:16,right:16}}>
          <div style={{color:"#fff",fontWeight:800,fontSize:24,
            textShadow:"0 1px 8px rgba(0,0,0,0.7)",marginBottom:4,
            animation:"fadeUp 0.4s ease 0.15s both"}}>{user.name}</div>
          <div style={{color:"rgba(255,255,255,0.7)",fontSize:14,
            animation:"fadeUp 0.4s ease 0.25s both"}}>@{user.tag}</div>
          {user.lastSeen&&(
            <div style={{color:"rgba(255,255,255,0.45)",fontSize:12,marginTop:3,
              animation:"fadeUp 0.4s ease 0.3s both"}}>
              был(а) {typeof user.lastSeen==="object"
                ?new Date(user.lastSeen.seconds*1000).toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"})
                :user.lastSeen}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{padding:"14px 14px max(env(safe-area-inset-bottom,18px),18px)"}} onClick={()=>setShowMenu(false)}>
        {profileStories.length>0&&(
          <div style={{background:profileSurface,borderRadius:16,padding:"12px 14px",marginBottom:12,animation:"fadeUp 0.4s ease 0.08s both"}}>
            <div style={{color:text2,fontSize:11,fontWeight:800,letterSpacing:.8,marginBottom:10}}>Истории</div>
            <button onClick={()=>setProfileViewer({items:profileStories,startIndex:0})} style={{display:"flex",alignItems:"center",gap:12,width:"100%",background:"transparent",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
              <div style={{width:58,height:58,borderRadius:"50%",padding:2,background:`linear-gradient(135deg,${profileAccent},${accent2})`,flexShrink:0}}>
                <Avatar name={user.name||"?"} photo={user.photo} size={54}/>
              </div>
              <div style={{minWidth:0}}>
                <div style={{color:text,fontWeight:800,fontSize:15}}>Посмотреть истории</div>
                <div style={{color:text2,fontSize:12,marginTop:2}}>{profileStories.length} за 24 часа</div>
              </div>
            </button>
          </div>
        )}
        {user.bio&&(
          <div style={{background:profileSurface,borderRadius:16,padding:"12px 16px",marginBottom:12,
            animation:"fadeUp 0.4s ease 0.1s both"}}>
            <div style={{color:text2,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:5}}>О СЕБЕ</div>
            <div style={{color:text,fontSize:14,lineHeight:1.6}}>{user.bio}</div>
          </div>
        )}

        <div style={{background:profileSurface,borderRadius:16,overflow:"hidden",marginBottom:14,
          animation:"fadeUp 0.4s ease 0.15s both"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",
            borderBottom:`1px solid ${border}`}}>
            <span style={{fontSize:20}}>🏷️</span>
            <div>
              <div style={{color:text2,fontSize:11,fontWeight:600,letterSpacing:0.5}}>Username</div>
              <div style={{color:profileAccent,fontSize:15,fontWeight:600,marginTop:2}}>@{user.tag}</div>
            </div>
          </div>
        </div>

        <div style={{background:profileSurface,borderRadius:16,overflow:"hidden",marginBottom:14,padding:"18px 14px",textAlign:"center",animation:"fadeUp 0.4s ease 0.18s both"}}>
          <div style={{color:text,fontWeight:900,fontSize:19,marginBottom:14}}>QR-код профиля</div>
          <div style={{display:"flex",justifyContent:"center",marginBottom:14}}>
            <div style={{background:"#fff",borderRadius:22,padding:14,boxShadow:"0 10px 30px rgba(0,0,0,.35)"}}>
              {qrDataUrl?<img src={qrDataUrl} alt="QR" style={{width:190,height:190,display:"block"}}/>:<div style={{width:190,height:190,display:"flex",alignItems:"center",justifyContent:"center",color:"#111",fontWeight:800}}>QR</div>}
            </div>
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>navigator.clipboard?.writeText(profileLink).catch(()=>{})} style={{flex:1,padding:"12px 10px",borderRadius:14,border:`1px solid ${border}`,background:surface2,color:text,fontWeight:800,fontFamily:"inherit"}}>Копировать</button>
            <button onClick={()=>{if(navigator.share)navigator.share({title:user.name,text:user.name,url:profileLink}).catch(()=>{});else navigator.clipboard?.writeText(profileLink).catch(()=>{});}} style={{flex:1,padding:"12px 10px",borderRadius:14,border:"none",background:`linear-gradient(135deg,${profileAccent},${accent2})`,color:"#fff",fontWeight:900,fontFamily:"inherit"}}>Поделиться</button>
          </div>
        </div>

        {uid!==myUid&&(
          <div style={{display:"flex",flexDirection:"column",gap:10,animation:"fadeUp 0.4s ease 0.2s both"}}>
            <button onClick={()=>onStartChat({...user,uid})}
              style={{padding:"15px",background:`linear-gradient(135deg,${profileAccent},${accent2})`,
                border:"none",borderRadius:16,color:"#fff",fontSize:15,fontWeight:700,
                cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 16px ${alphaColor(profileAccent,.28)}`,
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                transition:"transform 0.15s, box-shadow 0.15s",WebkitTapHighlightColor:"transparent"}}
              onMouseDown={e=>e.currentTarget.style.transform="scale(0.97)"}
              onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
              onTouchStart={e=>e.currentTarget.style.transform="scale(0.97)"}
              onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>
              💬 Написать сообщение
            </button>
            <button onClick={addProfileContact} disabled={contactAdded}
              style={{padding:"14px",background:contactAdded?surface2:"transparent",
                border:`1.5px solid ${contactAdded?border:profileAccent}`,borderRadius:16,
                color:contactAdded?text2:profileAccent,fontSize:15,fontWeight:800,
                cursor:contactAdded?"default":"pointer",fontFamily:"inherit",
                display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              {contactAdded?"В контактах":"Добавить в контакты"}
            </button>
          </div>
        )}
      </div>
      {profileViewer&&<StoryViewer items={profileViewer.items} startIndex={profileViewer.startIndex} currentUser={{uid:myUid}} profile={myProfile||{}} onClose={()=>setProfileViewer(null)}/>}
    </div>
  );
}


function FindPeople({currentUser,profile,onClose,onStartChat}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[q,setQ]=useState(""),[ results,setResults]=useState([]),[ loading,setLoading]=useState(false),[ searched,setSearched]=useState(false);
  const[contacts,setContacts]=useState([]);
  useEffect(()=>{
    if(!currentUser?.uid)return;
    return onSnapshot(collection(db,"users",currentUser.uid,"contacts"),snap=>{
      setContacts(snap.docs.map(d=>d.id));
    },()=>{});
  },[currentUser?.uid]);
  const search=async()=>{
    if(!q.trim())return;setLoading(true);setSearched(true);setResults([]);
    const clean=q.trim().replace(/^@/,"").toLowerCase();
    const byTag=await getDocs(query(collection(db,"users"),where("tag","==",clean)));
    const found=[];const seen=new Set();const seenTags=new Set();
    byTag.forEach(d=>{const u=d.data();if(d.id!==currentUser.uid&&!seen.has(d.id)&&!seenTags.has(u.tag)){seen.add(d.id);seenTags.add(u.tag);found.push({...u,uid:u.uid||d.id});}});
    if(!found.length){const all=await getDocs(collection(db,"users"));all.forEach(d=>{const u=d.data();if(d.id!==currentUser.uid&&!seen.has(d.id)&&!seenTags.has(u.tag)&&u.name?.toLowerCase().includes(clean)){seen.add(d.id);seenTags.add(u.tag);found.push({...u,uid:u.uid||d.id});}});}
    setResults(found);setLoading(false);
  };
  const startChat=async(person)=>{
    try{
      const chat=await ensureDirectChat(currentUser,profile,person);
      onStartChat(chat);
    }catch(e){
      alert("Не удалось открыть чат: "+(e?.message||e));
    }
  };
  const addContact=async(person)=>{
    if(!person?.uid)return;
    await setDoc(doc(db,"users",currentUser.uid,"contacts",person.uid),{
      uid:person.uid,name:person.name||"",tag:person.tag||"",photo:person.photo||"",createdAt:serverTimestamp()
    },{merge:true});
  };
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:bg||"#0E0E0E",zIndex:100,display:"flex",flexDirection:"column",overflowY:"auto"}}>
      <div style={{background:bg,height:"100vh",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"13px 15px",background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:11}}>
          <button onClick={onClose} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
          <div style={{color:text,fontWeight:700,fontSize:16}}>🔍 Найти людей</div>
        </div>
        <div style={{padding:14,flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",background:surface2,border:`1.5px solid ${border}`,borderRadius:15,overflow:"hidden"}}>
            <span style={{color:accent,padding:"0 13px",fontSize:17,fontWeight:700}}>@</span>
            <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()} placeholder="тег или имя" autoFocus style={{flex:1,background:"none",border:"none",padding:"13px 4px",color:text,fontSize:14,outline:"none",fontFamily:"inherit"}}/>
            <button onClick={search} style={{background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",padding:"0 18px",height:50,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Найти</button>
          </div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"0 14px"}}>
          {loading&&<div style={{textAlign:"center",color:text2,padding:40}}>🔍</div>}
          {searched&&!loading&&!results.length&&<div style={{textAlign:"center",padding:40}}><div style={{fontSize:46,marginBottom:10}}>🔍</div><div style={{color:text2}}>Никого не найдено</div></div>}
          {results.map((p,i)=>(
            <div key={p.uid} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderBottom:`1px solid ${border}`,animation:`msgIn 0.2s ease ${i*0.05}s both`}}>
              <Avatar name={p.name} size={50} photo={p.photo}/>
              <div style={{flex:1}}><div style={{color:text,fontWeight:600,fontSize:14}}>{p.name}</div><div style={{color:accent,fontSize:12,marginTop:2}}>@{p.tag}</div></div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <button onClick={()=>startChat(p)} style={{background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:13,padding:"8px 14px",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Написать</button>
                <button onClick={()=>addContact(p)} disabled={contacts.includes(p.uid)} style={{background:contacts.includes(p.uid)?surface2:"transparent",border:`1px solid ${contacts.includes(p.uid)?border:accent}`,borderRadius:13,padding:"7px 12px",color:contacts.includes(p.uid)?text2:accent,fontSize:12,fontWeight:700,cursor:contacts.includes(p.uid)?"default":"pointer",fontFamily:"inherit"}}>{contacts.includes(p.uid)?"В контактах":"Добавить"}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContactsTab({currentUser,profile,search="",onOpen,onViewProfile,onFind}){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[contacts,setContacts]=useState([]);
  const[loading,setLoading]=useState(true);
  const[busyUid,setBusyUid]=useState("");

  useEffect(()=>{
    if(!currentUser?.uid)return;
    let alive=true;
    const unsub=onSnapshot(collection(db,"users",currentUser.uid,"contacts"),async snap=>{
      const base=snap.docs.map(d=>({uid:d.id,...d.data()}));
      setContacts(base);
      setLoading(false);
      const enriched=await Promise.all(base.map(async c=>{
        if(c.name||c.tag||c.photo)return c;
        try{
          const s=await getDoc(doc(db,"users",c.uid));
          return s.exists()?{...c,...s.data(),uid:c.uid}:c;
        }catch{
          return c;
        }
      }));
      if(alive)setContacts(enriched);
    },()=>setLoading(false));
    return()=>{alive=false;unsub?.();};
  },[currentUser?.uid]);

  const filtered=contacts.filter(c=>{
    const q=search.trim().toLowerCase();
    if(!q)return true;
    return (c.name||"").toLowerCase().includes(q)||(c.tag||"").toLowerCase().includes(q);
  });

  const openChat=async(c)=>{
    if(!c?.uid||busyUid)return;
    setBusyUid(c.uid);
    try{
      const chat=await ensureDirectChat(currentUser,profile,c);
      onOpen?.(chat);
    }catch(e){
      alert("Не удалось открыть чат: "+(e?.message||e));
    }
    setBusyUid("");
  };

  const removeContact=async(c)=>{
    if(!c?.uid)return;
    if(!await appConfirm(`Удалить ${c.name||"контакт"} из контактов?`,"Удалить"))return;
    setBusyUid(c.uid);
    try{
      await deleteDoc(doc(db,"users",currentUser.uid,"contacts",c.uid));
    }catch(e){
      alert("Не удалось удалить контакт: "+(e?.message||e));
    }
    setBusyUid("");
  };

  if(loading){
    return(
      <div style={{height:"60%",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{width:28,height:28,borderRadius:"50%",border:`3px solid ${accent}33`,borderTopColor:accent,animation:"spin .75s linear infinite"}}/>
      </div>
    );
  }

  if(!filtered.length){
    return(
      <div style={{height:"60%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",padding:24}}>
        <div style={{fontSize:48,opacity:.35,marginBottom:12}}>👥</div>
        <div style={{color:text,fontWeight:800,fontSize:16}}>Контактов пока нет</div>
        <div style={{color:text2,fontSize:13,lineHeight:1.45,marginTop:6,maxWidth:260}}>
          Добавляй людей в контакты, чтобы быстрее писать им и давать доступ к историям.
        </div>
        {onFind&&(
          <button onClick={onFind} style={{marginTop:16,padding:"11px 16px",border:"none",borderRadius:14,background:`linear-gradient(135deg,${accent},${accent2})`,color:"#fff",fontWeight:800,fontFamily:"inherit"}}>
            Найти людей
          </button>
        )}
      </div>
    );
  }

  return(
    <div style={{padding:"4px 0 86px"}}>
      {filtered.map((c,i)=>(
        <div key={c.uid} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderBottom:`1px solid ${border}`,animation:`listIn .2s ease ${Math.min(i*.035,.25)}s both`}}>
          <button onClick={()=>onViewProfile?.(c.uid)} style={{background:"none",border:"none",padding:0,cursor:"pointer",borderRadius:"50%",flexShrink:0}}>
            <Avatar name={c.name||"?"} photo={c.photo||c.photoURL} size={52}/>
          </button>
          <div onClick={()=>onViewProfile?.(c.uid)} style={{flex:1,minWidth:0,cursor:"pointer"}}>
            <div style={{color:text,fontWeight:800,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name||"Без имени"}</div>
            <div style={{color:accent,fontSize:12,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>@{c.tag||"user"}</div>
          </div>
          <div style={{display:"flex",gap:7,flexShrink:0}}>
            <button onClick={()=>openChat(c)} disabled={busyUid===c.uid} style={{width:38,height:38,borderRadius:"50%",border:"none",background:`linear-gradient(135deg,${accent},${accent2})`,color:"#fff",fontSize:17,fontWeight:900,opacity:busyUid===c.uid?0.7:1}}>
              💬
            </button>
            <button onClick={()=>removeContact(c)} disabled={busyUid===c.uid} style={{width:38,height:38,borderRadius:"50%",border:`1px solid ${border}`,background:surface2,color:"#ff6b6b",fontSize:17,opacity:busyUid===c.uid?0.7:1}}>
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Create Modal ─────────────────────────────────────────────────────────────
function CreateModal({type,currentUser,profile,onClose,onCreated}){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[chatName,setChatName]=useState(""),[ desc,setDesc]=useState(""),[ loading,setLoading]=useState(false);
  const[photo,setPhoto]=useState("");
  const photoRef=useRef(null);
  const pickPhoto=async(e)=>{
    const file=e.target.files?.[0];e.target.value="";
    if(!file)return;
    try{
      setLoading(true);
      const url=await uploadFileToFirebase(file,`${type}_avatars/${currentUser.uid}`);
      setPhoto(url);
    }catch(err){alert("Не удалось загрузить аватарку");}
    finally{setLoading(false);}
  };
  const create=async()=>{
    if(!chatName.trim())return;setLoading(true);
    try{const tag2=chatName.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/gi,"")+Math.floor(100+Math.random()*900);
      const r=await addDoc(collection(db,"chats"),{type,name:chatName.trim(),desc,tag:tag2,members:[currentUser.uid],creatorUid:currentUser.uid,creatorName:profile.name,created:serverTimestamp(),lastMsg:"",lastTime:"",photo:photo||null,inviteLink:`https://redmrxgram.app/${type}/${tag2}`});
      onCreated({id:r.id,type,name:chatName.trim(),desc,tag:tag2,photo:photo||null,creatorUid:currentUser.uid,members:[currentUser.uid]});}
    catch(e){alert("Ошибка: "+e.message);}
    setLoading(false);
  };
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:300,display:"flex",alignItems:"flex-end",animation:"fadeIn 0.2s ease"}} onClick={onClose}>
      <div style={{background:surface,borderRadius:"22px 22px 0 0",padding:22,width:"100%",animation:"slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)"}} onClick={e=>e.stopPropagation()}>
        <div style={{width:36,height:4,background:border,borderRadius:2,margin:"0 auto 18px"}}/>
        <div style={{color:text,fontWeight:700,fontSize:17,marginBottom:16}}>{type==="channel"?"📢 Новый канал":"🫂 Новая группа"}</div>
        <input ref={photoRef} type="file" accept="image/*" onChange={pickPhoto} style={{display:"none"}}/>
        <button onClick={()=>photoRef.current?.click()} style={{width:92,height:92,borderRadius:"50%",margin:"0 auto 16px",border:`2px solid ${accent}`,background:surface2,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",color:text2,fontSize:28,cursor:"pointer"}}>
          {photo?<img src={photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:"+"}
        </button>
        <div style={{display:"flex",flexDirection:"column",gap:11,marginBottom:18}}>
          <input value={chatName} onChange={e=>setChatName(e.target.value)} placeholder={type==="channel"?"Название канала":"Название группы"} style={{background:surface2,border:`1.5px solid ${border}`,borderRadius:13,padding:"12px 15px",color:text,fontSize:15,outline:"none",fontFamily:"inherit"}} autoFocus/>
          <textarea value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Описание" rows={2} style={{background:surface2,border:`1.5px solid ${border}`,borderRadius:13,padding:"12px 15px",color:text,fontSize:14,outline:"none",fontFamily:"inherit",resize:"none"}}/>
        </div>
        <div style={{display:"flex",gap:9}}>
          <button onClick={onClose} style={{flex:1,padding:13,background:surface2,border:`1px solid ${border}`,borderRadius:13,color:text2,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>Отмена</button>
          <button onClick={create} disabled={!chatName.trim()||loading} style={{flex:2,padding:13,background:chatName.trim()?`linear-gradient(135deg,${accent},${accent2})`:surface2,border:"none",borderRadius:13,color:"#fff",fontSize:15,fontWeight:700,cursor:chatName.trim()?"pointer":"default",fontFamily:"inherit"}}>
            {loading?"...":(type==="channel"?"📢 Создать":"🫂 Создать")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Splash Screen ──────────────────────────────────────────────────────────
function ChatSettingsModal({chat,currentUser,onClose,onSaved}){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const isChannel=chat?.type==="channel";
  const[title,setTitle]=useState(chat?.name||chat?.title||"");
  const[desc,setDesc]=useState(chat?.desc||"");
  const[tag,setTag]=useState((chat?.tag||"").replace(/^@/,""));
  const[photo,setPhoto]=useState(chat?.photo||"");
  const[busy,setBusy]=useState(false);
  const[status,setStatus]=useState("");
  const[settings,setSettings]=useState(()=>({
    membersCanInvite:chat?.settings?.membersCanInvite!==false,
    adminsOnly:chat?.settings?.adminsOnly??isChannel,
    historyForNewMembers:chat?.settings?.historyForNewMembers!==false,
    joinApproval:!!chat?.settings?.joinApproval,
    reactionsEnabled:chat?.settings?.reactionsEnabled!==false,
  }));
  const photoRef=useRef(null);
  const cleanTag=tag.replace(/^@/,"").replace(/[^a-z0-9_]/gi,"").toLowerCase();
  const inviteLink=`https://redmrxgram.app/${isChannel?"channel":"group"}/${cleanTag||chat?.id}`;
  const canManage=chat?.creatorUid===currentUser?.uid||(chat?.admins||[]).includes(currentUser?.uid);
  const patchSetting=(key)=>setSettings(s=>({...s,[key]:!s[key]}));
  const pickPhoto=async(e)=>{
    const file=e.target.files?.[0];e.target.value="";
    if(!file)return;
    try{
      setBusy(true);setStatus("Загрузка аватарки...");
      const url=await uploadFileToFirebase(file,`${chat.type||"group"}_avatars/${chat.id}`);
      setPhoto(url);
      setStatus("Аватарка готова");
    }catch(err){setStatus("Не удалось загрузить аватарку");}
    finally{setBusy(false);}
  };
  const copyLink=async()=>{
    try{await navigator.clipboard.writeText(inviteLink);setStatus("Ссылка скопирована");}
    catch{setStatus(inviteLink);}
  };
  const shareLink=async()=>{
    try{
      if(navigator.share)await navigator.share({title:title||"RedMrxGram",text:title||"",url:inviteLink});
      else await copyLink();
    }catch{}
  };
  const save=async()=>{
    if(!canManage||!title.trim()||busy)return;
    setBusy(true);setStatus("Сохранение...");
    const patch={name:title.trim(),title:title.trim(),desc:desc.trim(),tag:cleanTag,photo:photo||null,inviteLink,settings:{...(chat?.settings||{}),...settings},updatedAt:serverTimestamp()};
    try{
      await updateDoc(doc(db,"chats",chat.id),patch);
      onSaved?.(patch);
      setStatus("Сохранено");
      setTimeout(onClose,350);
    }catch(err){setStatus("Не удалось сохранить настройки");}
    finally{setBusy(false);}
  };
  const Row=({icon,title,desc,value,onClick,disabled})=>(
    <button onClick={onClick} disabled={disabled} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:"transparent",border:"none",borderBottom:`1px solid ${border}`,color:text,textAlign:"left",fontFamily:"inherit",cursor:disabled?"default":"pointer",opacity:disabled?0.45:1}}>
      <span style={{fontSize:20,width:28,textAlign:"center"}}>{icon}</span>
      <span style={{flex:1}}>
        <span style={{display:"block",fontSize:14,fontWeight:800}}>{title}</span>
        <span style={{display:"block",fontSize:12,color:text2,marginTop:2}}>{desc}</span>
      </span>
      <span className={`rmg-toggle${value?" on":""}`} style={{flexShrink:0}}><span className="rmg-toggle-thumb"/></span>
    </button>
  );
  return createPortal(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",zIndex:800,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{width:"100%",maxHeight:"92vh",overflowY:"auto",background:surface,borderRadius:"24px 24px 0 0",boxShadow:"0 -18px 50px rgba(0,0,0,0.55)"}} onClick={e=>e.stopPropagation()}>
        <div style={{position:"sticky",top:0,zIndex:2,background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:10,padding:"14px 16px"}}>
          <button onClick={onClose} style={{width:38,height:38,borderRadius:"50%",border:`1px solid ${border}`,background:surface2,color:text,fontSize:20,cursor:"pointer"}}>←</button>
          <div style={{flex:1}}>
            <div style={{color:text,fontWeight:900,fontSize:17}}>{isChannel?"Настройки канала":"Настройки группы"}</div>
            <div style={{color:text2,fontSize:12}}>{canManage?"Редактирование и ссылка приглашения":"Только просмотр"}</div>
          </div>
          <button onClick={save} disabled={!canManage||busy||!title.trim()} style={{border:"none",borderRadius:16,padding:"10px 14px",background:canManage&&title.trim()?`linear-gradient(135deg,${accent},${accent2})`:surface2,color:"#fff",fontWeight:900,fontFamily:"inherit",opacity:busy?0.7:1,cursor:canManage?"pointer":"default"}}>{busy?"...":"Готово"}</button>
        </div>
        <div style={{padding:18}}>
          <input ref={photoRef} type="file" accept="image/*" onChange={pickPhoto} style={{display:"none"}}/>
          <button onClick={()=>canManage&&photoRef.current?.click()} style={{width:118,height:118,borderRadius:"50%",margin:"2px auto 18px",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",background:`linear-gradient(135deg,${accent}33,${accent2}33)`,border:`3px solid ${accent}`,color:text,fontSize:34,fontWeight:900,cursor:canManage?"pointer":"default",boxShadow:`0 16px 45px ${accent}35`}}>
            {photo?<img src={photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:"+"}
          </button>

          <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:14}}>
            <input value={title} onChange={e=>setTitle(e.target.value)} disabled={!canManage} placeholder={isChannel?"Название канала":"Название группы"} style={{width:"100%",boxSizing:"border-box",background:surface2,border:`1.5px solid ${border}`,borderRadius:15,padding:"13px 15px",color:text,fontSize:16,fontWeight:800,outline:"none",fontFamily:"inherit"}}/>
            <textarea value={desc} onChange={e=>setDesc(e.target.value)} disabled={!canManage} rows={3} placeholder="Описание" style={{width:"100%",boxSizing:"border-box",background:surface2,border:`1.5px solid ${border}`,borderRadius:15,padding:"13px 15px",color:text,fontSize:14,outline:"none",fontFamily:"inherit",resize:"none"}}/>
            <div style={{display:"flex",alignItems:"center",background:surface2,border:`1.5px solid ${border}`,borderRadius:15,overflow:"hidden",opacity:canManage?1:0.65}}>
              <span style={{padding:"0 0 0 14px",color:accent,fontWeight:900}}>@</span>
              <input value={tag} onChange={e=>setTag(e.target.value.replace(/[^a-z0-9_]/gi,"").toLowerCase())} disabled={!canManage} placeholder="public_link" style={{flex:1,background:"none",border:"none",padding:"13px 12px",color:text,fontSize:14,outline:"none",fontFamily:"inherit"}}/>
            </div>
          </div>

          <div style={{background:surface2,border:`1px solid ${border}`,borderRadius:18,overflow:"hidden",marginBottom:14}}>
            <div style={{padding:"13px 14px",borderBottom:`1px solid ${border}`}}>
              <div style={{color:text,fontWeight:900,fontSize:14}}>Ссылка приглашения</div>
              <div style={{color:accent,fontSize:12,marginTop:5,wordBreak:"break-all"}}>{inviteLink}</div>
            </div>
            <div style={{display:"flex"}}>
              <button onClick={copyLink} style={{flex:1,padding:12,border:"none",background:"transparent",color:text,fontWeight:800,fontFamily:"inherit",borderRight:`1px solid ${border}`}}>Копировать</button>
              <button onClick={shareLink} style={{flex:1,padding:12,border:"none",background:"transparent",color:text,fontWeight:800,fontFamily:"inherit"}}>Поделиться</button>
            </div>
          </div>

          <div style={{background:surface2,border:`1px solid ${border}`,borderRadius:18,overflow:"hidden"}}>
            <Row icon={<IcTabGroups size={20} color="#8e8e93" style={_mi}/>} title="Участники могут приглашать" desc="Разрешить людям добавлять друзей" value={settings.membersCanInvite} onClick={()=>patchSetting("membersCanInvite")} disabled={!canManage}/>
            <Row icon={<IcShield size={20} color="#8e8e93" style={_mi}/>} title={isChannel?"Публикуют только админы":"Пишут только админы"} desc="Полезно для объявлений и больших чатов" value={settings.adminsOnly} onClick={()=>patchSetting("adminsOnly")} disabled={!canManage}/>
            <Row icon={<IcHistory size={20} color="#8e8e93" style={_mi}/>} title="История новым участникам" desc="Новые участники увидят старые сообщения" value={settings.historyForNewMembers} onClick={()=>patchSetting("historyForNewMembers")} disabled={!canManage}/>
            <Row icon={<IcCheckOne size={20} color="#43a047" style={_mi}/>} title="Одобрять вход по ссылке" desc="Заявки перед попаданием в чат" value={settings.joinApproval} onClick={()=>patchSetting("joinApproval")} disabled={!canManage}/>
            <Row icon={<IcHeart size={20} color="#e53935" style={_mi}/>} title="Реакции" desc="Лайки и реакции на сообщения" value={settings.reactionsEnabled} onClick={()=>patchSetting("reactionsEnabled")} disabled={!canManage}/>
          </div>
          {status&&<div style={{color:status.includes("Не удалось")?"#ff6b6b":text2,fontSize:12,textAlign:"center",padding:14}}>{status}</div>}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ChatInfoModal({chat,currentUser,onClose,onOpenSettings}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const isChannel=chat?.type==="channel";
  const canManage=chat?.creatorUid===currentUser?.uid||(chat?.admins||[]).includes(currentUser?.uid);
  const[qrDataUrl,setQrDataUrl]=useState("");
  const tone=colorFor(chat?.name||"?");
  const cleanTag=(chat?.tag||chat?.id||"").replace(/^@/,"");
  const inviteLink=chat?.inviteLink||`https://redmrxgram.app/${isChannel?"channel":"group"}/${cleanTag}`;

  useEffect(()=>{
    if(!inviteLink)return;
    import("qrcode").then(mod=>{
      const QR=mod.default||mod;
      return QR.toDataURL(inviteLink,{width:340,margin:1,color:{dark:"#111111",light:"#ffffff"}});
    }).then(setQrDataUrl).catch(()=>setQrDataUrl(""));
  },[inviteLink]);

  const copyLink=async()=>{
    try{await navigator.clipboard.writeText(inviteLink);}catch{}
  };
  const shareLink=async()=>{
    try{
      if(navigator.share)await navigator.share({title:chat?.name||"RedMrxGram",text:chat?.desc||chat?.name||"",url:inviteLink});
      else await copyLink();
    }catch{}
  };

  return createPortal(
    <div style={{position:"fixed",inset:0,zIndex:790,background:`linear-gradient(180deg,${alphaColor(tone,.22)} 0%,#050505 300px,${bg||"#050505"} 100%)`,overflowY:"auto",overflowX:"hidden"}} onClick={()=>{}}>
      <div style={{position:"relative",padding:"max(env(safe-area-inset-top,24px),24px) 18px 20px",background:`radial-gradient(circle at 50% -10%,${alphaColor(tone,.42)} 0%,transparent 48%),linear-gradient(180deg,${alphaColor(tone,.16)} 0%,rgba(0,0,0,.78) 72%,#050505 100%),#050505`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <button onClick={onClose} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>←</button>
          <div style={{color:"#fff",fontWeight:900,fontSize:23,letterSpacing:0}}>{isChannel?"Канал":"Группа"}</div>
          <button onClick={canManage?onOpenSettings:shareLink} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>{canManage?"⚙":"↗"}</button>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center"}}>
          <div style={{width:116,height:116,borderRadius:"50%",boxShadow:`0 18px 55px ${alphaColor(tone,.24)}`}}>
            <Avatar name={chat?.name||"?"} photo={chat?.photo} size={116}/>
          </div>
          <div style={{color:"#fff",fontWeight:1000,fontSize:28,lineHeight:1.1,marginTop:18,letterSpacing:0}}>{chat?.name||"Без названия"}</div>
          <div style={{color:tone,fontSize:16,fontWeight:800,marginTop:7}}>@{cleanTag||chat?.id}</div>
          <div style={{color:"rgba(255,255,255,.55)",fontSize:14,marginTop:8,lineHeight:1.35}}>{isChannel?"Канал":"Группа"} · {(chat?.members||[]).length||1} участников</div>
        </div>
      </div>

      <div style={{padding:"14px 14px max(env(safe-area-inset-bottom,18px),18px)"}}>
        <div style={{background:surface,borderRadius:16,padding:"13px 16px",marginBottom:12}}>
          <div style={{color:text2,fontSize:11,fontWeight:900,letterSpacing:.8,marginBottom:6}}>ОПИСАНИЕ</div>
          <div style={{color:text,fontSize:14,lineHeight:1.55}}>{chat?.desc||"Описание пока не добавлено"}</div>
        </div>

        <div style={{background:surface,borderRadius:16,overflow:"hidden",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:`1px solid ${border}`}}>
            <span style={{fontSize:20}}>🔗</span>
            <div style={{minWidth:0}}>
              <div style={{color:text2,fontSize:11,fontWeight:700}}>Ссылка</div>
              <div style={{color:tone,fontSize:13,fontWeight:700,wordBreak:"break-all",marginTop:2}}>{inviteLink}</div>
            </div>
          </div>
          <div style={{display:"flex"}}>
            <button onClick={copyLink} style={{flex:1,padding:12,border:"none",background:"transparent",color:text,fontWeight:800,fontFamily:"inherit",borderRight:`1px solid ${border}`}}>Копировать</button>
            <button onClick={shareLink} style={{flex:1,padding:12,border:"none",background:"transparent",color:text,fontWeight:800,fontFamily:"inherit"}}>Поделиться</button>
          </div>
        </div>

        <div style={{background:surface,borderRadius:16,overflow:"hidden",marginBottom:14,padding:"18px 14px",textAlign:"center"}}>
          <div style={{color:text,fontWeight:900,fontSize:19,marginBottom:14}}>QR-код {isChannel?"канала":"группы"}</div>
          <div style={{display:"flex",justifyContent:"center"}}>
            <div style={{background:"#fff",borderRadius:22,padding:14,boxShadow:"0 10px 30px rgba(0,0,0,.35)"}}>
              {qrDataUrl?<img src={qrDataUrl} alt="QR" style={{width:190,height:190,display:"block"}}/>:<div style={{width:190,height:190,display:"flex",alignItems:"center",justifyContent:"center",color:"#111",fontWeight:800}}>QR</div>}
            </div>
          </div>
        </div>

        {canManage&&(
          <button onClick={onOpenSettings} style={{width:"100%",padding:"14px",border:"none",borderRadius:16,background:`linear-gradient(135deg,${tone},${accent2})`,color:"#fff",fontWeight:900,fontSize:15,fontFamily:"inherit",boxShadow:`0 4px 16px ${alphaColor(tone,.28)}`}}>Настройки и аватарка</button>
        )}
      </div>
    </div>,
    document.body
  );
}

function SplashScreen(){
  const[p,setP]=useState(0);
  const[dot,setDot]=useState(0);
  useEffect(()=>{
    const t1=setTimeout(()=>setP(1),60);
    const t2=setTimeout(()=>setP(2),480);
    const t3=setTimeout(()=>setP(3),850);
    const di=setInterval(()=>setDot(d=>(d+1)%3),350);
    return()=>{[t1,t2,t3].forEach(clearTimeout);clearInterval(di);};
  },[]);
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"#000",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:9999,overflow:"hidden"}}>
      <div style={{position:"absolute",width:320,height:320,borderRadius:"50%",background:"radial-gradient(circle,rgba(255,0,0,0.1) 0%,transparent 70%)",opacity:p>=1?1:0,transition:"opacity 1s ease",pointerEvents:"none"}}/>
      <div style={{position:"absolute",width:270,height:270,borderRadius:"50%",border:"1px solid rgba(255,0,0,0.12)",opacity:p>=2?1:0,transition:"opacity 0.6s ease 0.2s"}}/>
      <div style={{position:"absolute",width:210,height:210,borderRadius:"50%",border:"1px solid rgba(255,0,0,0.2)",opacity:p>=2?1:0,transition:"opacity 0.6s ease 0.3s"}}/>
      <div style={{
        position:"relative",marginBottom:28,
        transform:p>=1?"scale(1) rotate(0deg)":"scale(0.15) rotate(-25deg)",
        opacity:p>=1?1:0,
        transition:"transform 0.65s cubic-bezier(0.34,1.56,0.64,1),opacity 0.4s ease"
      }}>
        <div style={{position:"absolute",top:-16,left:-16,right:-16,bottom:-16,borderRadius:"50%",border:"1.5px solid rgba(255,0,0,0.25)",animation:p>=1?"splashRing 2s ease-out infinite":undefined,WebkitAnimation:p>=1?"splashRing 2s ease-out infinite":undefined}}/>
        <div style={{position:"absolute",top:-28,left:-28,right:-28,bottom:-28,borderRadius:"50%",border:"1px solid rgba(255,0,0,0.12)",animation:p>=1?"splashRing 2s ease-out 0.7s infinite":undefined,WebkitAnimation:p>=1?"splashRing 2s ease-out 0.7s infinite":undefined}}/>
        <div style={{width:130,height:130,borderRadius:36,background:"linear-gradient(145deg,#1a0000,#060000)",border:"2px solid rgba(255,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 0 ${p>=1?50:10}px rgba(255,0,0,${p>=1?0.55:0.1}),0 0 ${p>=1?100:20}px rgba(255,0,0,${p>=1?0.15:0})`,transition:"box-shadow 1s ease"}}>
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
            <defs><linearGradient id="mg" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#FF4444"/><stop offset="50%" stopColor="#FF0000"/><stop offset="100%" stopColor="#CC0000"/></linearGradient></defs>
            <path d="M8 68 L8 20 L24 20 L40 48 L56 20 L72 20 L72 68 L60 68 L60 38 L44 64 L36 64 L20 38 L20 68 Z" fill="url(#mg)" style={{filter:"drop-shadow(0 0 12px rgba(255,0,0,0.9))"}}/>
          </svg>
        </div>
      </div>
      <div style={{opacity:p>=2?1:0,transform:p>=2?"translateY(0)":"translateY(18px)",transition:"all 0.45s cubic-bezier(0.25,0.46,0.45,0.94)",textAlign:"center",marginBottom:6}}>
        <div style={{fontWeight:900,fontSize:30,letterSpacing:-1,background:"linear-gradient(135deg,#FF1111 0%,#CC0000 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",filter:"drop-shadow(0 0 12px rgba(255,0,0,0.55))"}}>MrX</div>
      </div>
      <div style={{opacity:p>=3?0.4:0,transition:"opacity 0.4s",color:"#888",fontSize:10,letterSpacing:4,textTransform:"uppercase",marginBottom:60}}>МЕССЕНДЖЕР</div>
      <div style={{position:"absolute",bottom:55,display:"flex",gap:7,opacity:p>=2?1:0,transition:"opacity 0.4s"}}>
        {[0,1,2].map(i=><div key={i} style={{width:i===dot?9:5,height:i===dot?9:5,borderRadius:"50%",background:i===dot?"#FF0000":"#2a2a2a",boxShadow:i===dot?"0 0 8px #FF000088":"none",transition:"all 0.3s ease"}}/>)}
      </div>
    </div>
  );
}


// ─── Error Boundary ──────────────────────────────────────────────────────────
class ChatErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={crashed:false,errorMsg:""};}
  static getDerivedStateFromError(e){return{crashed:true,errorMsg:e.message};}
  componentDidCatch(e,info){
    console.error("ChatScreen error:",e.message,e.stack);
    this.setState({errorMsg:e.message});
  }
  render(){
    if(this.state.crashed){
      return(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"#0E0E0E",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,zIndex:100}}>
          <div style={{fontSize:48}}>⚠️</div>
          <div style={{color:"#fff",fontWeight:700,fontSize:18}}>Ошибка чата</div>
          <div style={{color:"#aaa",fontSize:12,maxWidth:"80%",textAlign:"center",marginTop:8}}>{this.state.errorMsg}</div>
          <button onClick={()=>{this.setState({crashed:false});this.props.onBack();}} style={{background:"#2AABEE",border:"none",borderRadius:14,padding:"12px 28px",color:"#fff",fontWeight:700,fontSize:15,cursor:"pointer"}}>← Назад</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Message Search ──────────────────────────────────────────────────────────
function MsgSearch({chatId,onClose,onJump}){
  const {bg,surface,surface2,border,text,text2,accent}=useContext(ThemeCtx);
  const [q,setQ]=useState("");
  const [results,setResults]=useState([]);
  const [loading,setLoading]=useState(false);

  const search=async()=>{
    if(!q.trim())return;
    setLoading(true);
    try{
      const snap=await getDocs(query(collection(db,"chats",chatId,"messages"),orderBy("createdAt","desc")));
      const found=snap.docs.map(d=>({id:d.id,...d.data()})).filter(m=>m.type==="text"&&m.text?.toLowerCase().includes(q.toLowerCase()));
      setResults(found.slice(0,30));
    }catch(e){}
    setLoading(false);
  };

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:bg,zIndex:200,display:"flex",flexDirection:"column"}}>
      <div style={{paddingTop:"max(env(safe-area-inset-top,28px),28px)",paddingLeft:12,paddingRight:12,paddingBottom:10,background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <button onClick={onClose} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()}
          placeholder="Поиск в чате..." autoFocus
          style={{flex:1,background:surface2,border:`1px solid ${border}`,borderRadius:22,padding:"9px 14px",color:text,fontSize:14,outline:"none",fontFamily:"inherit"}}
          onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
        <button onClick={search} style={{background:accent,border:"none",borderRadius:12,padding:"9px 14px",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Найти</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
        {loading&&<div style={{textAlign:"center",padding:30,color:text2}}>🔍 Поиск...</div>}
        {!loading&&results.length===0&&q&&<div style={{textAlign:"center",padding:30}}><div style={{fontSize:40,marginBottom:8}}>🔍</div><div style={{color:text2}}>Ничего не найдено</div></div>}
        {results.map(m=>(
          <div key={m.id} onClick={()=>{onJump(m.id);onClose();}} style={{padding:"10px 12px",borderBottom:`1px solid ${border}`,cursor:"pointer",borderRadius:10,marginBottom:2,transition:"background 0.15s"}}
            onTouchStart={e=>e.currentTarget.style.background=surface2} onTouchEnd={e=>e.currentTarget.style.background="none"}>
            <div style={{color:accent,fontSize:11,fontWeight:600,marginBottom:3}}>{m.author} · {m.time}</div>
            <div style={{color:text,fontSize:14}}>{m.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Lightbox (fullscreen photo/media viewer) ────────────────────────────────
//
// Полноэкранный просмотрщик в стиле телефонной галереи:
//   • Открытие — анимация zoom-from-thumbnail (FLIP через CSS transform).
//   • Закрытие — обратная анимация. Кнопка «Назад» Android закрывает лайтбокс,
//     а не выходит из чата (см. _lightboxClose выше + App-level back-handler).
//   • Тап по изображению / пустой области — тоггл верхней панели управления
//     + статус-бара + навигационного бара (как в Google Photos / Galaxy Gallery).
//   • Для не-image (файл/аудио/видео — последние два в текущем потоке не приходят
//     сюда, но оставлены как резервный путь) — fade+scale модалка без zoom.
//
// originRect — { left, top, width, height } миниатюры, с которой открыли.
// Если не передан, используем дефолтный масштаб 0.7 от центра.
function Lightbox({src,fileName,fileType,originRect,onClose}){
  const isImage=fileType?.startsWith("image/");
  const isVideo=fileType?.startsWith("video/");
  const isAudio=fileType?.startsWith("audio/")||/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(fileName||"");

  const [downloading,setDownloading]=useState(false);
  // Фазы анимации: "enter" → "in" → "exit"
  // enter — стартовый кадр (image у origin rect, бэкдроп прозрачен)
  // in    — финальный кадр (image на весь экран, бэкдроп чёрный, controls видны)
  // exit  — обратно к enter, после которого вызовется onClose
  const [phase,setPhase]=useState("enter");
  const [controlsVisible,setControlsVisible]=useState(true);
  const closingRef=useRef(false);
  const onCloseRef=useRef(onClose);
  useEffect(()=>{onCloseRef.current=onClose;},[onClose]);

  // ── Системные бары через Capacitor (необязательные) ──────────────────────
  // Динамический импорт пакета — если плагина нет (web-сборка), просто no-op.
  // NavigationBar — отдельный community-плагин, поэтому через Capacitor.Plugins.
  const hidePhoneBars=async()=>{
    try{
      if(window?.Capacitor?.isNativePlatform?.()){
        const{StatusBar}=await import("@capacitor/status-bar").catch(()=>({}));
        if(StatusBar){try{await StatusBar.hide();}catch(e){}}
        try{
          const nbPlugin=window.Capacitor?.Plugins?.NavigationBar;
          if(nbPlugin?.hide)await nbPlugin.hide();
        }catch(e){}
      }
    }catch(e){}
  };
  const showPhoneBars=async()=>{
    try{
      if(window?.Capacitor?.isNativePlatform?.()){
        const{StatusBar}=await import("@capacitor/status-bar").catch(()=>({}));
        if(StatusBar){try{await StatusBar.show();}catch(e){}}
        try{
          const nbPlugin=window.Capacitor?.Plugins?.NavigationBar;
          if(nbPlugin?.show)await nbPlugin.show();
        }catch(e){}
      }
    }catch(e){}
  };

  // Анимированное закрытие. Стабильная ссылка (useCallback с пустыми deps),
  // потому что внутри используем только refs и стабильные сеттеры — стейл-клоужер
  // нам не страшен. Это позволяет смело регистрировать функцию как _lightboxClose.
  const animatedClose=useCallback(()=>{
    if(closingRef.current)return;
    closingRef.current=true;
    setPhase("exit");
    setControlsVisible(false);
    // Восстанавливаем системные бары заранее — чтобы в момент unmount чат уже
    // был с нормальным статус-баром и не было «прыжка» вёрстки.
    showPhoneBars();
    // 320мс — длительность transform-перехода (см. transition ниже).
    setTimeout(()=>{onCloseRef.current?.();},320);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Mount: регистрируем _lightboxClose, включаем оверлей WebView, стартуем
  //    «enter → in» через два RAF (первый кадр должен успеть отрендериться
  //    с originTransform, иначе transition не сработает).
  useEffect(()=>{
    _lightboxClose=animatedClose;

    // Включаем overlay, чтобы изображение уезжало под статус-бар. На unmount
    // вернём как было.
    (async()=>{
      try{
        if(window?.Capacitor?.isNativePlatform?.()){
          const{StatusBar}=await import("@capacitor/status-bar").catch(()=>({}));
          if(StatusBar){try{await StatusBar.setOverlaysWebView({overlay:true});}catch(e){}}
        }
      }catch(e){}
    })();

    let raf2=0;
    const raf1=requestAnimationFrame(()=>{
      raf2=requestAnimationFrame(()=>setPhase("in"));
    });

    return()=>{
      cancelAnimationFrame(raf1);
      if(raf2)cancelAnimationFrame(raf2);
      if(_lightboxClose===animatedClose)_lightboxClose=null;

      // Восстанавливаем нормальный layout WebView и системные бары.
      (async()=>{
        try{
          if(window?.Capacitor?.isNativePlatform?.()){
            const{StatusBar}=await import("@capacitor/status-bar").catch(()=>({}));
            if(StatusBar){
              try{await StatusBar.setOverlaysWebView({overlay:false});}catch(e){}
              try{await StatusBar.show();}catch(e){}
            }
            try{
              const nbPlugin=window.Capacitor?.Plugins?.NavigationBar;
              if(nbPlugin?.show)await nbPlugin.show();
            }catch(e){}
          }
        }catch(e){}
      })();
    };
  },[animatedClose]);

  // Скрытие/показ системных баров вслед за тогглом controlsVisible.
  // Не дёргаем во время exit-фазы (closing) — animatedClose сам уже вызвал show.
  useEffect(()=>{
    if(closingRef.current)return;
    if(controlsVisible)showPhoneBars();
    else hidePhoneBars();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[controlsVisible]);

  // ── Вычисляем CSS transform для phase=enter/exit (от/к миниатюре) ────────
  const vw=typeof window!=="undefined"?window.innerWidth:380;
  const vh=typeof window!=="undefined"?window.innerHeight:800;
  let originTransform="translate3d(0,0,0) scale(0.7)";
  if(originRect){
    const cx=originRect.left+originRect.width/2;
    const cy=originRect.top+originRect.height/2;
    const tx=cx-vw/2;
    const ty=cy-vh/2;
    // Масштаб по ширине — миниатюра ~такой же ширины, как scaled image.
    // Минимум 0.05, чтобы избежать вырожденного случая (rect=0).
    const sc=Math.max(0.05,originRect.width/vw);
    originTransform=`translate3d(${tx}px,${ty}px,0) scale(${sc})`;
  }
  const wrapperTransform=phase==="in"?"translate3d(0,0,0) scale(1)":originTransform;

  // Бэкдроп opacity: 0 на enter/exit, 1 на in
  const inPhase=phase==="in";

  // ── Действия ───────��─────────────────────────────────────────────────────
  const handleBack=(e)=>{e?.stopPropagation?.();animatedClose();};
  const toggleControls=()=>{setControlsVisible(v=>!v);};

  const download=async(e)=>{
    e?.stopPropagation?.();
    if(downloading||!src)return;
    setDownloading(true);
    try{
      let name=fileName||"file";
      if(!/\.[a-z0-9]{1,6}$/i.test(name)){
        const ext=isImage?(fileType?.includes("png")?"png":fileType?.includes("gif")?"gif":fileType?.includes("webp")?"webp":"jpg")
          :isVideo?"mp4"
          :isAudio?"mp3"
          :"bin";
        name=name+"."+ext;
      }
      await downloadToDevice(src,name);
    }catch(e){
      console.warn("Lightbox download error:",e);
      try{
        const a=document.createElement("a");
        a.href=src;a.download=fileName||"file";
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);
      }catch(e2){}
    }
    setDownloading(false);
  };

  // ── Рендер ───────────────────────────────────────────────────────────────
  // Портал в body — гарантирует, что мы НЕ внутри какого-нибудь transformed
  // предка (что сломало бы position:fixed) и поверх всего.
  return createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,
        background:`rgba(0,0,0,${inPhase?0.985:0})`,
        transition:"background-color 0.32s ease",
        overflow:"hidden",
        // Тач-события не пропускаем на чат под нами
        touchAction:"none"}}>

      {/* ── IMAGE: zoom-from-thumbnail wrapper ─────────────────────────── */}
      {isImage&&(
        <div onClick={toggleControls}
          style={{position:"absolute",inset:0,
            display:"flex",alignItems:"center",justifyContent:"center",
            transform:wrapperTransform,
            transition:"transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94)",
            willChange:"transform",
            transformOrigin:"center center"}}>
          <img src={src} alt={fileName||"Фото"}
            draggable={false}
            style={{maxWidth:"100vw",maxHeight:"100vh",objectFit:"contain",display:"block",
              userSelect:"none",WebkitUserSelect:"none",
              // pointerEvents:none — клики проходят на wrapper (toggleControls),
              // а не съедаются картинкой.
              pointerEvents:"none"}}/>
        </div>
      )}

      {/* ── VIDEO: fade + scale (резервный путь, обычно используется VideoPlayer) */}
      {isVideo&&(
        <div onClick={handleBack}
          style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
            transform:wrapperTransform,
            transition:"transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94)",
            willChange:"transform",
            transformOrigin:"center center",
            padding:16}}>
          <video src={src} controls autoPlay playsInline
            onClick={e=>e.stopPropagation()}
            style={{maxWidth:"100%",maxHeight:"100%",borderRadius:8}}/>
        </div>
      )}

      {/* ── AUDIO: модальная кар��очка с плеером ─────────────────────────── */}
      {isAudio&&(
        <div onClick={handleBack}
          style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",padding:16,
            opacity:inPhase?1:0,transition:"opacity 0.3s ease"}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#1a1a1a",borderRadius:20,padding:28,textAlign:"center",width:"100%",maxWidth:320,
              transform:inPhase?"scale(1)":"scale(0.92)",
              transition:"transform 0.3s cubic-bezier(0.34,1.56,0.64,1)"}}>
            <div style={{fontSize:52,marginBottom:16}}>🎵</div>
            <div style={{color:"#fff",fontWeight:600,fontSize:15,marginBottom:20,wordBreak:"break-word"}}>{fileName}</div>
            <audio src={src} controls style={{width:"100%"}}/>
            <button onClick={download} disabled={downloading} style={{marginTop:16,background:"#E53935",border:"none",borderRadius:14,padding:"12px 24px",color:"#fff",fontSize:14,fontWeight:700,cursor:downloading?"default":"pointer",width:"100%",opacity:downloading?0.6:1,transition:"opacity 0.2s"}}>{downloading?"⏳ Сохраняем…":"⬇ Скачать"}</button>
          </div>
        </div>
      )}

      {/* ── FILE: карточка с иконкой и кнопкой «Скачать» ────────────────── */}
      {!isImage&&!isVideo&&!isAudio&&(
        <div onClick={handleBack}
          style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",padding:16,
            opacity:inPhase?1:0,transition:"opacity 0.3s ease"}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#1a1a1a",borderRadius:20,padding:32,textAlign:"center",maxWidth:320,
              transform:inPhase?"scale(1)":"scale(0.92)",
              transition:"transform 0.3s cubic-bezier(0.34,1.56,0.64,1)"}}>
            <div style={{fontSize:52,marginBottom:12}}>📄</div>
            <div style={{color:"#fff",fontWeight:600,fontSize:15,marginBottom:8,wordBreak:"break-word"}}>{fileName}</div>
            <button onClick={download} disabled={downloading} style={{background:"#E53935",border:"none",borderRadius:14,padding:"13px 28px",color:"#fff",fontSize:15,fontWeight:700,cursor:downloading?"default":"pointer",opacity:downloading?0.6:1,transition:"opacity 0.2s",marginTop:12}}>{downloading?"⏳ Сохраняем…":"⬇ Скачать файл"}</button>
          </div>
        </div>
      )}

      {/* ── Верхний бар управления — только для изображений ─────────────── */}
      {/* Полупрозрачный градиент: содержимое (back + filename + download)
          виден поверх картинки, но картинка под ним просвечивает. */}
      {isImage&&(
        <div style={{position:"absolute",top:0,left:0,right:0,
            paddingTop:"max(env(safe-area-inset-top,28px),28px)",
            paddingLeft:14,paddingRight:14,paddingBottom:14,
            background:"linear-gradient(180deg,rgba(0,0,0,0.62) 0%,rgba(0,0,0,0.4) 55%,rgba(0,0,0,0) 100%)",
            display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,
            // controlsVisible && inPhase — скрываем во время enter/exit тоже,
            // чтобы бар не «всплывал» во время zoom-анимации.
            opacity:(controlsVisible&&inPhase)?1:0,
            transform:(controlsVisible&&inPhase)?"translateY(0)":"translateY(-14px)",
            transition:"opacity 0.25s ease,transform 0.25s ease",
            pointerEvents:(controlsVisible&&inPhase)?"auto":"none",
            zIndex:2}}
          onClick={e=>e.stopPropagation()}>
          <button onClick={handleBack}
            style={{background:"rgba(0,0,0,0.42)",border:"1px solid rgba(255,255,255,0.14)",
              borderRadius:"50%",width:40,height:40,color:"#fff",fontSize:20,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
              backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)",
              padding:0,lineHeight:1}}>←</button>
          <div style={{color:"#fff",fontSize:14,fontWeight:600,overflow:"hidden",
              textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0,
              textShadow:"0 1px 4px rgba(0,0,0,0.55)"}}>{fileName||"Фото"}</div>
          <button onClick={download} disabled={downloading}
            style={{background:"rgba(0,0,0,0.42)",border:"1px solid rgba(255,255,255,0.14)",
              borderRadius:"50%",width:40,height:40,color:"#fff",fontSize:18,
              cursor:downloading?"default":"pointer",display:"flex",alignItems:"center",
              justifyContent:"center",flexShrink:0,opacity:downloading?0.65:1,
              backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)",
              transition:"opacity 0.2s",padding:0,lineHeight:1}}>
            {downloading?
              <div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTop:"2px solid #fff",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
              :"⬇"}
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}

// ─── Reply Preview ────────────────────────────────────────────────────────────

// ─── Message Context Menu ────────────────────────────────────────────────────
function MsgContextMenu({msg,myUid,chatId,onClose,onReply,onEdit,onForward,onSave}){
  const {surface,surface2,border,text,text2,accent}=useContext(ThemeCtx);
  const [visible,setVisible]=useState(false);
  const isMe=msg.uid===myUid;

  useEffect(()=>{requestAnimationFrame(()=>setVisible(true));},[]);

  const close=()=>{
    setVisible(false);
    setTimeout(onClose,280);
  };

  const downloadMsg=async()=>{
    const src=msg.videoUrl||msg.videoData||msg.fileUrl||msg.fileData||"";
    if(!src){close();return;}
    const ext=msg.type==="circle"||msg.type==="video"?"mp4"
      :msg.type==="image"?(msg.fileType?.includes("png")?"png":"jpg")
      :msg.type==="voice"?"webm"
      :msg.type==="audio"?(msg.fileName?.split(".").pop()||"mp3")
      :(msg.fileName?.split(".").pop()||"bin");
    await downloadToDevice(src,"rmg_"+msg.type+"_"+Date.now()+"."+ext);
    close();
  };

  const isMedia=["circle","image","video","voice","audio","file"].includes(msg.type);
  const isAudioMsg=msg.type==="audio"||msg.type==="voice"||(msg.type==="file"&&msg.fileType?.startsWith("audio/"));
  const REACTIONS=["❤️","😂","👍","🔥","😮","😢","👎"];
  const audio=useContext(AudioCtx);
  const actions=[
    {ico:<IcReply size={20} color="#8e8e93" style={_mi}/>,lbl:"Ответить",fn:()=>{onReply(msg);close();}},
    {ico:<IcCopy size={20} color="#8e8e93" style={_mi}/>,lbl:"Копировать",fn:()=>{
      const t=msg.type==="text"?msg.text:"[медиа]";
      try{navigator.clipboard.writeText(t);}catch(e){}
      close();
    }},
    {ico:<IcForward size={20} color="#8e8e93" style={_mi}/>,lbl:"Переслать",fn:()=>{onForward&&onForward(msg);close();}},
    {ico:<IcStar size={20} color="#8e8e93" style={_mi}/>,lbl:"Избранное",fn:()=>{onSave&&onSave(msg);close();}},
  ];
  if(isMedia) actions.push({ico:<IcSetDownload size={20} color="#8e8e93" style={_mi}/>,lbl:"Скачать",fn:downloadMsg});
  if(isAudioMsg) actions.push({ico:<IcMusic size={20} color="#8e8e93" style={_mi}/>,lbl:"В плейлист",fn:()=>{
    if(!audio)return;
    const trackId=msg.id||(msg.fileUrl||msg.audioUrl||msg.fileData||msg.audioData||"");
    const src=msg.fileUrl||msg.fileData||msg.audioUrl||msg.audioData||"";
    if(!src){close();return;}
    const track={
      id:trackId,
      src,
      name:(msg.fileName||"Аудио").replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|opus)$/i,""),
      ext:(msg.fileName||"").split(".").pop()?.toUpperCase()||"MP3",
      size:msg.fileSize?fmtSize(msg.fileSize):"",
      chatName:"",author:msg.author||"",
    };
    audio.addToQueue(track);
    close();
  }});
  if(isMe&&msg.type==="text") actions.push({ico:<IcPencilSm size={20} color="#8e8e93" style={_mi}/>,lbl:"Редактировать",fn:()=>{onEdit&&onEdit(msg);close();}});
  actions.push({ico:<IcTrash size={20} color="#ff5252" style={_mi}/>,lbl:"Удалить у себя",red:true,fn:async()=>{
    try{await updateDoc(doc(db,"chats",chatId,"messages",msg.id),{deletedFor:arrayUnion(myUid)});}catch(e){}
    close();
  }});
  if(isMe) actions.push({ico:<IcTrashAll size={20} color="#ff5252" style={_mi}/>,lbl:"Удалить у всех",red:true,fn:async()=>{
    if(!await appConfirm("Удалить это сообщение у всех?","Удалить"))return;
    try{await deleteDoc(doc(db,"chats",chatId,"messages",msg.id));}catch(e){}
    close();
  }});

  return(
    <div style={{
      position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:800,
      background:visible?"rgba(0,0,0,0.55)":"rgba(0,0,0,0)",
      transition:"background 0.3s ease",
      backdropFilter:visible?"blur(3px)":"none",
    }} onClick={close}>
      <div style={{
        position:"fixed",bottom:0,left:0,right:0,
        background:surface,
        borderRadius:"22px 22px 0 0",
        padding:"0 0 32px",
        boxShadow:"0 -12px 40px rgba(0,0,0,0.6)",
        transform:visible?"translateY(0)":"translateY(100%)",
        transition:"transform 0.32s cubic-bezier(0.32,0.72,0,1)",
        willChange:"transform",
      }} onClick={e=>e.stopPropagation()}>
        {/* Handle */}
        <div style={{width:40,height:4,background:border,borderRadius:2,margin:"10px auto 4px"}}/>
        {/* Превью сообщения */}
        <div style={{padding:"8px 18px 10px",borderBottom:`1px solid ${border}`,marginBottom:4}}>
          <div style={{color:accent,fontSize:11,fontWeight:700,marginBottom:2}}>{msg.author}</div>
          <div style={{color:text,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",opacity:0.85}}>
            {msg.type==="text"?msg.text:"📎 медиа"}
          </div>
        </div>
        {/* Реакции */}
        <div style={{display:"flex",justifyContent:"space-around",padding:"10px 12px 12px",borderBottom:`1px solid ${border}`}}>
          {REACTIONS.map((r,i)=>(
            <button key={r} onClick={async()=>{
              try{await updateDoc(doc(db,"chats",chatId,"messages",msg.id),{[`reactions.${myUid}`]:r});}catch(e){}
              close();
            }} style={{
              background:"none",border:"none",fontSize:26,cursor:"pointer",padding:"4px 6px",
              borderRadius:12,transition:"transform 0.2s cubic-bezier(0.34,1.56,0.64,1)",
              animation:`popIn 0.3s cubic-bezier(0.34,1.56,0.64,1) ${i*0.04}s both`,
            }}
            onTouchStart={e=>e.currentTarget.style.transform="scale(1.35)"}
            onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>{r}</button>
          ))}
        </div>
        {/* Действия */}
        {actions.map((a,i)=>(
          <button key={i} onClick={a.fn} style={{
            width:"100%",display:"flex",alignItems:"center",gap:14,
            padding:"14px 22px",background:"none",border:"none",
            cursor:"pointer",fontFamily:"inherit",
            borderBottom:i<actions.length-1?`1px solid ${border}44`:"none",
            animation:`fadeUp 0.25s ease ${0.05+i*0.04}s both`,
          }}
          onTouchStart={e=>e.currentTarget.style.background=surface2}
          onTouchEnd={e=>e.currentTarget.style.background="none"}>
            <span style={{fontSize:20,width:28,textAlign:"center",flexShrink:0}}>{a.ico}</span>
            <span style={{color:a.red?"#ff5252":text,fontSize:15,fontWeight:500}}>{a.lbl}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Message ─────────────────────────────────────────────────────────────────

// ─── Animated Screen Wrapper ──────────────────────────────────────────────────
function Screen({children,dir="right"}){
  const theme=useContext(ThemeCtx);
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:100,
      background:theme?.bg||"#0A0A0A",
      animation:"pageSlideIn 0.28s cubic-bezier(0.25,0.46,0.45,0.94)",
      WebkitAnimation:"pageSlideIn 0.28s cubic-bezier(0.25,0.46,0.45,0.94)"}}>
      {children}
    </div>
  );
}

// ─── Avatar ──────────────────────────────────────────────────────────────────


// ─── Auth ─────────────────────────────────────────────────────────────────────
function AuthScreen({onAuth}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[mode,setMode]=useState("login");
  const[name,setName]=useState(""),[ email,setEmail]=useState(""),[ pass,setPass]=useState(""),[ tag,setTag]=useState(""),[ loginId,setLoginId]=useState(""),[ code,setCode]=useState(""),[ err,setErr]=useState(""),[ info,setInfo]=useState(""),[ loading,setLoading]=useState(false),[ showPass,setShowPass]=useState(false),[ showHelp,setShowHelp]=useState(false),[ helpClosing,setHelpClosing]=useState(false),[ pendingEmail,setPendingEmail]=useState("");
  const pendingProfile=useRef(null);
  const[resetEmail,setResetEmail]=useState("");
  const[resetLogin,setResetLogin]=useState("");
  const[modeAnim,setModeAnim]=useState("in");
  const switchMode=(m)=>{setModeAnim("out");setTimeout(()=>{setMode(m);setModeAnim("in");},160);};
  useEffect(()=>{if(name&&mode==="register")setTag(name.toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9]/gi,"")+Math.floor(1000+Math.random()*9000));},[name]);
  const finishAuth=async(user)=>{
    const snap=await getDoc(doc(db,"users",user.uid));
    if(snap.exists()){onAuth(user,snap.data());return;}
    const pp=pendingProfile.current||{};
    const prof={uid:user.uid,name:pp.name||user.displayName||"Пользователь",email:pp.email||pendingEmail||"",tag:pp.tag||"",bio:"",photo:null,theme:"dark",createdAt:serverTimestamp(),lastSeen:serverTimestamp()};
    await setDoc(doc(db,"users",user.uid),prof);
    onAuth(user,prof);
  };
  const submit=async()=>{
    setErr("");setInfo("");setLoading(true);
    try{
      if(mode==="register"){
        if(!name.trim()){setErr("Введи имя");setLoading(false);return;}
        const ft=(tag.trim()||name.toLowerCase().replace(/[^a-z0-9]/gi,"")+Math.floor(1000+Math.random()*9000)).toLowerCase();
        if(!/^[a-z0-9_]{3,32}$/.test(ft)){setErr("Юзернейм: 3–32 символа, латиница, цифры и _");setLoading(false);return;}
        if(!/^\S+@\S+\.\S+$/.test(email.trim())){setErr("Введи настоящую почту — на неё придёт код");setLoading(false);return;}
        const r=await registerAccount({tag:ft,name:name.trim(),email:email.trim(),password:pass});
        pendingProfile.current={name:name.trim(),tag:ft,email:email.trim().toLowerCase()};
        if(r.pending){setPendingEmail(r.email||email.trim().toLowerCase());setCode("");switchMode("verify");setInfo("Код отправлен! Проверь почту (и папку «Спам»)");}
        else await finishAuth(r.user);
      }else if(mode==="login"){
        const cred=await signInWithEmailAndPassword(auth,loginId,pass);
        await finishAuth(cred.user);
      }else if(mode==="verify"){
        const r=await verifyEmailCode(pendingEmail,code);
        if(!pendingProfile.current&&r.raw)pendingProfile.current={name:r.raw.name||"",tag:r.raw.tag||"",email:pendingEmail};
        await finishAuth(r.user);
      }else if(mode==="reset"){
        const l=(loginId.trim()||email.trim());
        const r=await requestPasswordReset(l);
        if(r&&r.email){setResetLogin(l);setResetEmail(r.email);setCode("");setPass("");switchMode("reset_confirm");setInfo("Код отправлен! Проверь почту (и папку «Спам»)");setErr("");}
        else setInfo("Если аккаунт с такими данными есть — код отправлен");
      }else if(mode==="reset_confirm"){
        if(pass.length<6){setErr("Пароль минимум 6 символов");setLoading(false);return;}
        const r=await confirmPasswordReset(resetLogin,code,pass);
        await finishAuth(r.user);
      }else if(mode==="attach"){
        if(!/^\S+@\S+\.\S+$/.test(email.trim())){setErr("Введи настоящую почту — на неё придёт код");setLoading(false);return;}
        await attachEmail(loginId,pass,email.trim());
        setPendingEmail(email.trim().toLowerCase());setCode("");switchMode("verify");setInfo("Код отправлен! Проверь почту (и папку «Спам»)");
      }
    }catch(e){
      if(e.code==="auth/email-not-verified"){setPendingEmail(e.email||(loginId.includes("@")?loginId.trim().toLowerCase():pendingEmail));setCode("");switchMode("verify");setInfo("Почта ещё не подтверждена — мы отправили новый код");}
      else if(e.code==="auth/email-required"){setEmail("");switchMode("attach");}
      else{
        const m={"auth/weak-password":"Пароль минимум 6 символов","auth/invalid-credential":"Неверный логин или пароль. Логин — это @юзернейм или почта","auth/invalid-code":"Неверный или просроченный код","auth/too-many-requests":"Подожди минуту и попробуй ещё раз"};
        setErr(m[e.code]||e.message);
      }
    }
    setLoading(false);
  };
  const inp={background:surface2,border:`1.5px solid ${border}`,borderRadius:14,padding:"13px 15px",color:text,fontSize:15,outline:"none",fontFamily:"inherit",width:"100%",boxSizing:"border-box",transition:"border-color 0.2s"};
  const[authOnline,setAuthOnline]=useState(navigator.onLine);
  useEffect(()=>{
    const up=()=>setAuthOnline(true),dn=()=>setAuthOnline(false);
    window.addEventListener("online",up);window.addEventListener("offline",dn);
    return()=>{window.removeEventListener("online",up);window.removeEventListener("offline",dn);};
  },[]);
  const canSubmit=mode==="login"?!!(loginId.trim()&&pass):mode==="register"?!!(name.trim()&&email.trim()&&pass):mode==="verify"?code.trim().length===6:mode==="reset"?!!(loginId.trim()||email.trim()):mode==="reset_confirm"?!!(code.trim().length===6&&pass.length>=6):!!email.trim();
  return(
    <div onMouseDown={e=>{if(e.target===e.currentTarget)e.preventDefault();}} style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      {!authOnline&&<OfflineBar fixed/>}
      <div onMouseDown={e=>{if(e.target===e.currentTarget)e.preventDefault();}} style={{background:surface,borderRadius:24,padding:"32px 22px",width:"100%",maxWidth:380,border:`1px solid ${border}`,boxShadow:"0 24px 80px rgba(0,0,0,0.55)",animation:"fadeIn 0.4s ease"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:68,height:68,borderRadius:20,background:"linear-gradient(145deg,#1a0000,#060000)",border:`1.5px solid ${accent}88`,margin:"0 auto 12px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 6px 26px ${accent}55`}}>
            <svg width="42" height="42" viewBox="0 0 80 80" fill="none">
              <defs><linearGradient id="authLogoGrad" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#FF4444"/><stop offset="50%" stopColor="#FF0000"/><stop offset="100%" stopColor="#CC0000"/></linearGradient></defs>
              <path d="M8 68 L8 20 L24 20 L40 48 L56 20 L72 20 L72 68 L60 68 L60 38 L44 64 L36 64 L20 38 L20 68 Z" fill="url(#authLogoGrad)" style={{filter:"drop-shadow(0 0 6px rgba(255,0,0,0.7))"}}/>
            </svg>
          </div>
          <div style={{color:text,fontWeight:800,fontSize:24}}>MrX</div>
          <div key={"sub-"+mode} style={{color:text2,fontSize:13,marginTop:4,animation:"authFadeSlide 0.32s cubic-bezier(0.22,0.61,0.36,1) both"}}>{mode==="login"?"Войди в аккаунт":mode==="register"?"Создай аккаунт":mode==="verify"?"Подтверди почту":mode==="reset"?"Сброс пароля":mode==="reset_confirm"?"Новый пароль":"Привяжи почту"}</div>
        </div>
        {mode==="register"&&<div style={{display:"flex",justifyContent:"center",marginBottom:18}}><Avatar name={name||"?"} size={70}/></div>}
        <div key={"fields-"+mode} onMouseDown={e=>{if(e.target===e.currentTarget)e.preventDefault();}} style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12,animation:(modeAnim==="out"?"authFadeOutUp 0.16s ease both":"authFieldIn 0.32s cubic-bezier(0.22,0.61,0.36,1) both")}}>
          {mode==="register"&&<>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="Имя" style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
            <div style={{display:"flex",alignItems:"center",background:surface2,border:`1.5px solid ${border}`,borderRadius:14,overflow:"hidden"}}>
              <span style={{color:accent,padding:"0 13px",fontSize:16,fontWeight:700}}>@</span>
              <input value={tag} onChange={e=>setTag(e.target.value.replace(/^@/,"").replace(/\s/,""))} placeholder="твой_тег (это твой логин!)" style={{flex:1,background:"none",border:"none",padding:"13px 8px 13px 0",color:text,fontSize:15,outline:"none",fontFamily:"inherit"}}/>
            </div>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Почта (на неё придёт код)" type="email" style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
          </>}
          {mode==="login"&&<input value={loginId} onChange={e=>setLoginId(e.target.value)} placeholder="@юзернейм или почта" type="text" style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>}
          {mode==="reset"&&<input value={loginId} onChange={e=>setLoginId(e.target.value)} placeholder="@юзернейм или почта" type="text" style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>}
          {mode==="reset_confirm"&&<>
            <div style={{color:text2,fontSize:13,lineHeight:1.55,textAlign:"center"}}>Код отправлен на<br/><b style={{color:text}}>{resetEmail}</b><br/>Письма нет? Загляни в папку «Спам».</div>
            <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="••••••" inputMode="numeric" onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,textAlign:"center",letterSpacing:8,fontSize:22,fontWeight:800}} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
            <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Новый пароль (мин. 6 символов)" type={showPass?"text":"password"} onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,paddingRight:46}} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
          </>}
          {mode==="attach"&&<>
            <div style={{color:text2,fontSize:13,lineHeight:1.55}}>Теперь для входа нужна почта — это защита от фейков. Укажи её один раз: придёт код подтверждения, и дальше входи как обычно (по @юзернейму или почте).</div>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Твоя почта" type="email" onKeyDown={e=>e.key==="Enter"&&submit()} style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
          </>}
          {mode==="verify"&&<>
            <div style={{color:text2,fontSize:13,lineHeight:1.55,textAlign:"center"}}>Мы отправили 6-значный код на<br/><b style={{color:text}}>{pendingEmail}</b><br/>Письма нет? Загляни в папку «Спам».</div>
            <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="••••••" inputMode="numeric" onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,textAlign:"center",letterSpacing:8,fontSize:22,fontWeight:800}} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
          </>}
          {(mode==="login"||mode==="register")&&<div style={{position:"relative"}}>
            <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Пароль" type={showPass?"text":"password"} onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,paddingRight:46}} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
            <button onMouseDown={e=>e.preventDefault()} onClick={()=>setShowPass(s=>!s)} style={{position:"absolute",right:13,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:text2,fontSize:15}}>{showPass?"🙈":"👁"}</button>
          </div>}
        </div>
        {info&&<div style={{background:"#00c85315",border:"1px solid #00c85333",borderRadius:12,padding:"9px 13px",color:"#7be3a3",fontSize:13,marginBottom:10}}>✉️ {info}</div>}
        {err&&<div style={{background:"#ff00001a",border:"1px solid #ff000033",borderRadius:12,padding:"9px 13px",color:"#ff6b6b",fontSize:13,marginBottom:10,animation:"shake 0.3s ease"}}>⚠️ {err}</div>}
        <button onClick={submit} disabled={loading||!canSubmit} style={{width:"100%",padding:14,background:canSubmit?`linear-gradient(135deg,${accent},${accent2})`:surface2,border:"none",borderRadius:14,color:"#fff",fontSize:15,fontWeight:700,cursor:canSubmit?"pointer":"default",boxShadow:canSubmit?`0 4px 22px ${accent}55`:"none",fontFamily:"inherit",marginBottom:14,transition:"transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s",animation:(canSubmit&&!loading)?"authBtnPulse 2.6s ease-in-out infinite":"none"}} onMouseDown={e=>{e.preventDefault();if(canSubmit)e.currentTarget.style.transform="scale(0.96)";}} onMouseUp={e=>e.currentTarget.style.transform="scale(1)"} onTouchStart={e=>{if(canSubmit)e.currentTarget.style.transform="scale(0.96)";}} onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>
          {loading?"⏳":mode==="login"?"Войти →":mode==="register"?"Создать 🚀":mode==="verify"?"Подтвердить ✅":mode==="reset"?"Отправить код 📧":mode==="reset_confirm"?"Сохранить пароль 🔑":"Получить код 📧"}
        </button>
        {mode==="register"&&<div style={{color:text2,fontSize:12,textAlign:"center",marginBottom:10}}>Запомни свой @юзернейм — по нему будешь входить</div>}
        {mode==="verify"&&<div style={{textAlign:"center",marginBottom:10,display:"flex",flexDirection:"column",gap:8}}>
          <span onMouseDown={e=>e.preventDefault()} onClick={async()=>{if(loading)return;setErr("");try{await resendEmailCode(pendingEmail);setInfo("Код отправлен ещё раз ✉️");}catch(e){setErr("Подожди минуту перед повторной отправкой");}}} style={{color:accent,fontSize:13,cursor:"pointer",fontWeight:700}}>Отправить код ещё раз</span>
          <span onMouseDown={e=>e.preventDefault()} onClick={()=>{switchMode("login");setErr("");setInfo("");}} style={{color:text2,fontSize:13,cursor:"pointer"}}>← Назад ко входу</span>
        </div>}
        {mode==="attach"&&<div style={{textAlign:"center",marginBottom:10}}><span onMouseDown={e=>e.preventDefault()} onClick={()=>{switchMode("login");setErr("");setInfo("");}} style={{color:text2,fontSize:13,cursor:"pointer"}}>← Назад ко входу</span></div>}
        {(mode==="reset"||mode==="reset_confirm")&&<div style={{textAlign:"center",marginBottom:10,display:"flex",flexDirection:"column",gap:8}}>
          {mode==="reset_confirm"&&<span onMouseDown={e=>e.preventDefault()} onClick={async()=>{if(loading)return;setErr("");try{const r=await requestPasswordReset(resetLogin);if(r&&r.email)setInfo("Код отправлен ещё раз ✉️");}catch(e){setErr("Подожди минуту и попробуй ещё раз");}}} style={{color:accent,fontSize:13,cursor:"pointer",fontWeight:700}}>Отправить код ещё раз</span>}
          <span onMouseDown={e=>e.preventDefault()} onClick={()=>{switchMode("login");setErr("");setInfo("");}} style={{color:text2,fontSize:13,cursor:"pointer"}}>← Назад ко входу</span>
        </div>}
        {(mode==="login"||mode==="register")&&<>
        <div style={{display:"flex",alignItems:"center",gap:8,margin:"10px 0"}}>
          <div style={{flex:1,height:1,background:border}}/><span style={{color:text2,fontSize:11}}>или</span><div style={{flex:1,height:1,background:border}}/>
        </div>
        <button onClick={async()=>{
          setErr("");setLoading(true);
          try{
            const cred=await signInAnonymously(auth);
            const anonName="Гость"+(Math.floor(1000+Math.random()*9000));
            const anonTag="guest"+Math.floor(10000+Math.random()*90000);
            const prof={uid:cred.user.uid,name:anonName,email:"",tag:anonTag,bio:"Анонимный пользователь",photo:null,theme:"dark",createdAt:serverTimestamp(),lastSeen:serverTimestamp(),isAnonymous:true};
            const snap=await getDoc(doc(db,"users",cred.user.uid));
            if(!snap.exists())await setDoc(doc(db,"users",cred.user.uid),prof);
            onAuth(cred.user,snap.exists()?snap.data():prof,true);
          }catch(e){setErr(e.message);}
          setLoading(false);
        }} style={{width:"100%",padding:13,background:surface2,border:`1px solid ${border}`,borderRadius:14,color:text2,fontSize:14,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all 0.2s"}}
          onMouseDown={e=>{e.preventDefault();e.currentTarget.style.transform="scale(0.97)";}}
          onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>
          <IcGhost size={18}/><span>Войти анонимно</span>
        </button>
        <div style={{textAlign:"center"}}>
          <span style={{color:text2,fontSize:13}}>{mode==="login"?"Нет аккаунта? ":"Уже есть? "}</span>
          <span onClick={()=>{switchMode(mode==="login"?"register":"login");setErr("");setInfo("");}} style={{color:accent,fontSize:13,cursor:"pointer",fontWeight:700,transition:"opacity 0.15s"}} onMouseDown={e=>{e.preventDefault();e.currentTarget.style.opacity="0.55";}} onMouseUp={e=>e.currentTarget.style.opacity="1"}>{mode==="login"?"Зарегистрироваться":"Войти"}</span>
        </div>
        {mode==="login"&&<div style={{textAlign:"center",marginTop:4}}>
          <span onMouseDown={e=>e.preventDefault()} onClick={()=>{setLoginId("");setPass("");setErr("");setInfo("");switchMode("reset");}} style={{color:text2,fontSize:12.5,cursor:"pointer",textDecoration:"underline"}}>Забыл пароль?</span>
        </div>}
        <div style={{textAlign:"center",marginTop:12}}>
          <span onMouseDown={e=>e.preventDefault()} onClick={()=>{if(showHelp){setHelpClosing(true);setTimeout(()=>{setShowHelp(false);setHelpClosing(false);},440);}else{setShowHelp(true);}}} style={{color:text2,fontSize:12,cursor:"pointer",textDecoration:"underline",display:"inline-flex",alignItems:"center",gap:4,transition:"color 0.2s"}}><IcHelpQ size={13}/> Как войти? <span style={{display:"inline-block",transition:"transform 0.3s cubic-bezier(0.34,1.56,0.64,1)",transform:(showHelp&&!helpClosing)?"rotate(180deg)":"rotate(0deg)",fontSize:10}}>▾</span></span>
          {showHelp&&<div style={{textAlign:"left",background:surface2,border:`1px solid ${border}`,borderRadius:12,padding:"11px 13px",color:text2,fontSize:12.5,lineHeight:1.6,marginTop:8,overflow:"hidden",animation:helpClosing?"authHelpClose 0.45s cubic-bezier(0.65,0,0.35,1) both":"authHelpOpen 0.55s cubic-bezier(0.32,0.72,0,1) both",transformOrigin:"top center"}}>
            <b style={{color:text}}>Впервые здесь?</b><br/>1. Нажми «Зарегистрироваться»<br/>2. Придумай имя, @юзернейм и пароль, укажи свою почту<br/>3. Введи код из письма — и готово!<br/><br/>
            <b style={{color:text}}>Уже есть аккаунт?</b><br/>Вводи свой @юзернейм (он написан в твоём профиле) или почту — и пароль.<br/><br/>
            <b style={{color:text}}>Забыл юзернейм?</b><br/>Просто войди по почте.<br/><br/><b style={{color:text}}>Забыл пароль?</b><br/>Нажми «Забыл пароль?» ниже — введи @юзернейм или почту, получи код, придумай новый пароль.
          </div>}
        </div>
        </>}
      </div>
    </div>
  );
}

// ─── Edit Profile ─────────────────────────────────────────────────────────────

// ─── Edit Profile ─────────────────────────────────────────────────────────────
function EditProfile({currentUser,profile,onSave,onClose}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[name,setName]=useState(profile?.name||""),[ bio,setBio]=useState(profile?.bio||""),[username,setUsername]=useState(profile?.tag||"");
  const[preview,setPreview]=useState(profile?.photo||null);
  const[uploading,setUploading]=useState(false);
  const[uploadPct,setUploadPct]=useState(0);
  const[err,setErr]=useState("");
  const fileRef=useRef();
  const describeErr=(e)=>{let s=e?.message||String(e||"неизвестная ошибка");if(e?.status)s+=" [HTTP "+e.status+"]";try{if(e?.body)s+=" "+JSON.stringify(e.body).slice(0,180);}catch(x){}return s;};

  const pickPhoto=async(e)=>{
    const file=e.target.files[0];if(!file)return;
    setUploading(true);setUploadPct(0);setErr("");
    // Fast local preview first
    const url=URL.createObjectURL(file);
    const img=new Image();img.src=url;
    img.onerror=()=>{setUploading(false);setErr("Не удалось прочитать это фото — попробуй другое (JPG/PNG).");URL.revokeObjectURL(url);};
    img.onload=async()=>{
      const canvas=document.createElement("canvas"),size=Math.min(img.width,img.height);
      canvas.width=300;canvas.height=300;
      canvas.getContext("2d").drawImage(img,(img.width-size)/2,(img.height-size)/2,size,size,0,0,300,300);
      const localB64=canvas.toDataURL("image/jpeg",0.75);
      setPreview(localB64); // аватарка хранится в профиле (b64) — показывается у всех без загрузки на сервер
      setUploadPct(100);
      setUploading(false);URL.revokeObjectURL(url);
    };
  };

  const save=async()=>{
    if(uploading)return;setUploading(true);setErr("");
    try{
      const updated={...profile,name:name.trim()||profile.name,bio,tag:username.trim()||profile.tag,photo:preview||null};
      // Update Firestore user doc
      // Check tag uniqueness
    const newTag=(updated.tag||"").toLowerCase().trim();
    if(newTag&&newTag!==profile?.tag){
      const tagCheck=await getDocs(query(collection(db,"users"),where("tag","==",newTag)));
      if(!tagCheck.empty){setErr(`@${newTag} уже занят`);setUploading(false);return;}
    }
    // Verify auth before update
      if(!currentUser?.uid){setErr("Не авторизован — перезайди в аккаунт");setUploading(false);return;}
      await setDoc(doc(db,"users",currentUser.uid),{
        name:updated.name,
        bio:updated.bio,
        tag:newTag||updated.tag,
        photo:updated.photo||null,
        lastSeen:serverTimestamp()
      },{merge:true});
      // Update Firebase Auth displayName
      await updateProfile(currentUser,{displayName:updated.name,photoURL:updated.photo||""}).catch(()=>{});
      // Update names in all direct chats
      try{
        const chatsSnap=await getDocs(query(collection(db,"chats"),where("members","array-contains",currentUser.uid)));
        const updates=chatsSnap.docs.map(d=>{
          const data=d.data();
          if(data.type==="direct"&&data.names?.[currentUser.uid]){
            return updateDoc(d.ref,{[`names.${currentUser.uid}`]:updated.name,[`photos.${currentUser.uid}`]:updated.photo||""});
          }
          return null;
        }).filter(Boolean);
        await Promise.all(updates);
      }catch(e2){}
      onSave(updated);
    }catch(e){
      console.error("Profile save error:",e);
      setErr("Не удалось сохранить профиль: "+describeErr(e));
    }
    setUploading(false);
  };

  return(
    <Screen dir="right">
      <div style={{background:bg,height:"100vh",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"13px 15px",background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:13,flexShrink:0}}>
          <button onClick={onClose} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
          <div style={{color:text,fontWeight:700,fontSize:16}}>Редактировать профиль</div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"20px 16px"}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",marginBottom:24}}>
            <div style={{position:"relative",cursor:"pointer",marginBottom:8}} onClick={()=>fileRef.current?.click()}>
              <Avatar name={name||"?"} size={96} photo={preview}/>
              <div style={{position:"absolute",bottom:-6,right:-6,width:32,height:32,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,border:`2.5px solid ${bg}`,zIndex:2}}>
                {uploading?`${uploadPct}%`:"📷"}
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" onChange={pickPhoto} style={{display:"none"}}/>
            {uploading&&<div style={{marginTop:8,color:text2,fontSize:12}}>Загрузка {uploadPct}%</div>}
          </div>
          {err&&<div style={{background:"rgba(229,57,53,0.14)",border:"1.5px solid #E53935",borderRadius:13,padding:"10px 14px",color:"#E53935",fontSize:13,marginBottom:14,wordBreak:"break-word",whiteSpace:"pre-wrap"}}>⚠️ {err}</div>}
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div><label style={{color:text2,fontSize:11,fontWeight:600,marginBottom:5,display:"block",letterSpacing:0.5}}>ИМЯ</label>
              <input value={name} onChange={e=>setName(e.target.value)} style={{width:"100%",background:surface2,border:`1.5px solid ${border}`,borderRadius:13,padding:"12px 15px",color:text,fontSize:15,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
            </div>
            <div><label style={{color:text2,fontSize:11,fontWeight:600,marginBottom:5,display:"block",letterSpacing:0.5}}>USERNAME</label>
              <div style={{display:"flex",alignItems:"center",background:surface2,border:`1.5px solid ${border}`,borderRadius:13,overflow:"hidden"}}>
                <span style={{color:accent,padding:"0 13px",fontSize:16,fontWeight:700}}>@</span>
                <input value={username} onChange={e=>setUsername(e.target.value.replace(/[^a-z0-9_]/gi,"").toLowerCase())} placeholder="твой_тег" style={{flex:1,background:"none",border:"none",padding:"12px 8px 12px 0",color:text,fontSize:15,outline:"none",fontFamily:"inherit"}}/>
              </div></div>
            <div><label style={{color:text2,fontSize:11,fontWeight:600,marginBottom:5,display:"block",letterSpacing:0.5}}>О СЕБЕ</label>
              <textarea value={bio} onChange={e=>setBio(e.target.value)} rows={3} placeholder="Расскажи о себе..." style={{width:"100%",background:surface2,border:`1.5px solid ${border}`,borderRadius:13,padding:"12px 15px",color:text,fontSize:14,outline:"none",fontFamily:"inherit",resize:"none",boxSizing:"border-box"}}/></div>
            <button onClick={save} disabled={uploading} style={{padding:14,background:uploading?surface2:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:14,color:"#fff",fontSize:15,fontWeight:700,cursor:uploading?"default":"pointer",fontFamily:"inherit",transition:"all 0.2s"}}>
              {uploading?"Сохраняю...":"✓ Сохранить"}
            </button>
          </div>
        </div>
      </div>
    </Screen>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// ─── Message ─────────────────────────────────────────────────────────────────
function Msg({msg,myUid,prevMsg,usersCache,chatPhotos,onAvatarClick,onReply,onLongPress,onLongPressEnd,onOpenLightbox,onCircleFs,msgFontSize=14,idx}){
  const {accent,accent2,surface2,text,text2,bg}=useContext(ThemeCtx);
  const fromMe=msg.uid===myUid;
  const showAvatar=!fromMe&&msg.uid!==prevMsg?.uid;
  const photo=bestPhoto(usersCache?.[msg.uid]?.photo,chatPhotos?.[msg.uid]);
  const isSticker=msg.type==="sticker";
  const isCircle=msg.type==="circle";

  // ── Swipe to reply ──────────────────────────────────────────────────────
  const[swipeX,setSwipeX]=useState(0);
  const[swiping,setSwiping]=useState(false);
  const touchRef=useRef({x:0,y:0,active:false,started:false});
  const SWIPE_THRESHOLD=55;
  const MIN_SWIPE_START=8; // минимум пикселей чтобы начать свайп

  const onTStart=e=>{
    touchRef.current={x:e.touches[0].clientX,y:e.touches[0].clientY,active:false,started:true};
    setSwipeX(0);setSwiping(false);
  };
  const onTMove=e=>{
    const r=touchRef.current;
    if(!r.started)return;
    const dx=e.touches[0].clientX-r.x;
    const dy=Math.abs(e.touches[0].clientY-r.y);
    const absDx=Math.abs(dx);

    // Если слишком вертикально — отменяем
    if(!r.active&&dy>absDx*1.2){r.started=false;setSwipeX(0);return;}

    // Проверяем направление: своё — влево, чужое — вправо
    const correctDir=fromMe?(dx<0):(dx>0);
    if(!correctDir){r.started=false;setSwipeX(0);return;}

    // Минимальное расстояние для активации
    if(!r.active&&absDx<MIN_SWIPE_START)return;
    r.active=true;

    const clamped=fromMe
      ?Math.max(-SWIPE_THRESHOLD*1.15,Math.min(0,dx))
      :Math.min(SWIPE_THRESHOLD*1.15,Math.max(0,dx));
    setSwipeX(clamped);setSwiping(true);
    e.stopPropagation(); // не мешаем скроллу чата
  };
  const onTEnd=()=>{
    const r=touchRef.current;
    r.started=false;
    const triggered=fromMe?swipeX<-SWIPE_THRESHOLD:swipeX>SWIPE_THRESHOLD;
    if(triggered&&r.active){if(navigator.vibrate)navigator.vibrate(30);onReply(msg);}
    setSwipeX(0);setSwiping(false);
    r.active=false;
  };

  // ── Long press ──────────────────────────────────────────────────────────
  const lpRef=useRef(null);
  const msgRef=useRef(null);
  const lpStartPos=useRef({x:0,y:0});

  const onPStart=e=>{
    const x=e.touches?.[0]?.clientX??e.clientX;
    const y=e.touches?.[0]?.clientY??e.clientY;
    if(x<30)return;
    lpStartPos.current={x,y};
    lpRef.current=setTimeout(()=>{
      if(navigator.vibrate)navigator.vibrate(42);
      if(typeof lpActiveRef!=="undefined")lpActiveRef.current=true;
      if(msgRef.current){
        msgRef.current.style.transition='transform 0.22s cubic-bezier(0.34,1.56,0.64,1),filter 0.22s ease';
        msgRef.current.style.transform='scale(1.08) translateY(-5px)';
        msgRef.current.style.filter='drop-shadow(0 10px 28px rgba(0,0,0,0.5))';
        msgRef.current.style.zIndex='999';
        msgRef.current.style.position='relative';
        setTimeout(()=>{
          onLongPress&&onLongPress(msg);
          setTimeout(()=>{
            if(msgRef.current){
              msgRef.current.style.transition='transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94),filter 0.32s ease';
              msgRef.current.style.transform='scale(1) translateY(0)';
              msgRef.current.style.filter='none';
              msgRef.current.style.zIndex='';
            }
          },80);
        },220);
      } else {
        onLongPress&&onLongPress(msg);
      }
    },420);
  };

  const onPMove=e=>{
    if(!lpRef.current)return;
    const x=e.touches?.[0]?.clientX??e.clientX;
    const y=e.touches?.[0]?.clientY??e.clientY;
    const dx=Math.abs(x-lpStartPos.current.x);
    const dy=Math.abs(y-lpStartPos.current.y);
    // Если палец сдвинулся больше 8px — это скролл, отменяем лонг-пресс
    if(dx>8||dy>8){
      clearTimeout(lpRef.current);
      lpRef.current=null;
    }
  };

  const onPEnd=()=>{
    clearTimeout(lpRef.current);
    lpRef.current=null;
    onLongPressEnd&&onLongPressEnd();
  };

  const replyOpacity=fromMe?Math.min(1,Math.abs(swipeX)/SWIPE_THRESHOLD):Math.min(1,swipeX/SWIPE_THRESHOLD);

  const renderContent=()=>{
    if(isCircle)return(
      <div onTouchStart={onPStart} onTouchMove={onPMove} onTouchEnd={onPEnd} onMouseDown={onPStart} onMouseUp={onPEnd}>
        <CircleBubble msg={msg} onFullscreen={onCircleFs}/>
      </div>
    );
    if(isSticker)return(
      <div style={{fontSize:52,lineHeight:1,userSelect:"none",filter:"drop-shadow(0 2px 8px rgba(0,0,0,0.3))"}}
        onTouchStart={onPStart} onTouchMove={onPMove} onTouchEnd={onPEnd} onMouseDown={onPStart} onMouseUp={onPEnd}>
        {msg.text}
      </div>
    );
    const bubbleStyle={
      background:fromMe?`linear-gradient(135deg,${accent},${accent2})`:surface2,
      borderRadius:fromMe?"20px 20px 4px 20px":"20px 20px 20px 4px",
      // Видео — тонкая обводка (3px), а не толстая «коробка» из 9/13px.
      // Цвет не трогаем, меняется только визуальная толщина рамки.
      padding:msg.type==="video"?"3px"
        :msg.type==="voice"||msg.type==="file"?"10px 12px"
        :"9px 13px",
      color:text,fontSize:msgFontSize||14,lineHeight:1.55,
      boxShadow:fromMe?`0 3px 14px ${accent}40`:"0 1px 5px rgba(0,0,0,0.18)",
      wordBreak:"break-word",maxWidth:"100%",
    };
    return(
      <div style={bubbleStyle} onTouchStart={onPStart} onTouchMove={onPMove} onTouchEnd={onPEnd} onMouseDown={onPStart} onMouseUp={onPEnd}>
        {msg.forwarded&&(
          <div style={{fontSize:11,fontWeight:700,color:fromMe?"rgba(255,255,255,0.65)":accent,marginBottom:4,display:"flex",alignItems:"center",gap:4}}>
            ↪️ Переслано
          </div>
        )}
        {msg.replyTo&&<ReplyInBubble msg={msg.replyTo} fromMe={fromMe}/>}
        {msg.reactions&&Object.values(msg.reactions||{}).length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:4}}>
            {[...new Set(Object.values(msg.reactions))].map(r=>{
              const cnt=Object.values(msg.reactions).filter(x=>x===r).length;
              return <span key={r} style={{background:"rgba(255,255,255,0.15)",borderRadius:10,padding:"1px 6px",fontSize:12}}>{r}{cnt>1&&<span style={{fontSize:10,marginLeft:2}}>{cnt}</span>}</span>;
            })}
          </div>
        )}
        {msg.type==="voice"?<VoiceBubble msg={msg} fromMe={fromMe}/>
          :msg.type==="audio"?<AudioBubble msg={msg} fromMe={fromMe}/>
          :msg.type==="image"||msg.type==="file"?<FileBubble msg={msg} fromMe={fromMe} onOpenLightbox={onOpenLightbox}/>
          :msg.type==="video"?<FileBubble msg={msg} fromMe={fromMe} onOpenLightbox={onOpenLightbox}/>
          :msg.text}
      </div>
    );
  };

  return(
    <div style={{display:"flex",flexDirection:fromMe?"row-reverse":"row",alignItems:"flex-end",gap:6,
      marginBottom:2,paddingLeft:fromMe?40:0,paddingRight:fromMe?0:40,
      animation:getS("bubbleAnim")===false?undefined:`msgIn 0.22s cubic-bezier(0.34,1.56,0.64,1) ${Math.min(idx*0.016,0.1)}s both`,
      position:"relative"}}
      onTouchStart={onTStart}
      onTouchMove={onTMove}
      onTouchEnd={onTEnd}>
      {!isSticker&&(
        <div style={{position:"absolute",[fromMe?"right":"left"]:"4px",top:"50%",transform:"translateY(-50%)",
          opacity:replyOpacity,fontSize:20,color:accent,transition:swiping?"none":"opacity 0.2s",pointerEvents:"none",zIndex:1}}>↩</div>
      )}
      <div style={{width:28,flexShrink:0}}>
        {!fromMe&&<div style={{opacity:showAvatar?1:0}}><Avatar name={msg.author} size={28} photo={photo} onClick={()=>onAvatarClick?.(msg.uid)}/></div>}
      </div>
      <div ref={msgRef} style={{display:"flex",flexDirection:"column",alignItems:fromMe?"flex-end":"flex-start",maxWidth:"78%",position:"relative",
        transform:`translateX(${swipeX}px)`,transition:swiping?"none":"transform 0.25s cubic-bezier(0.34,1.56,0.64,1)"}}>
        {!fromMe&&msg.uid!==prevMsg?.uid&&!isSticker&&!isCircle&&(
          <div style={{fontSize:11,color:colorFor(msg.author||"?"),marginBottom:2,paddingLeft:3,fontWeight:600}}>{msg.author}</div>
        )}
        {renderContent()}
        {msg._uploading&&(
          <div style={{width:"min(180px,100%)",height:3,borderRadius:3,overflow:"hidden",background:"rgba(255,255,255,0.16)",marginTop:5}}>
            <div style={{height:"100%",width:`${Math.max(6,Math.min(100,msg._uploadPct||8))}%`,borderRadius:3,background:accent,transition:"width 0.18s ease"}}/>
          </div>
        )}
        {!isSticker&&<div style={{fontSize:10,color:"#555",marginTop:2,display:"flex",alignItems:"center",gap:3}}>
          {msg._pending&&<span style={{opacity:0.5,animation:"pulse 1s infinite"}}>⏳</span>}
          {msg.time}
          {fromMe&&(
            <span style={{
              color:msg._pending?"rgba(255,255,255,0.35)":
                ((msg.readBy||[]).some(u=>u!==myUid)&&msg._partnerAllowsReceipts!==false)?"#4CAF50":"#A5D6A7",
              fontSize:11,marginLeft:2,fontWeight:600
            }}>
              {msg._pending?"✓":
                ((msg.readBy||[]).some(u=>u!==myUid)&&msg._partnerAllowsReceipts!==false)?"✓✓":"✓"}
            </span>
          )}
        </div>}
      </div>
    </div>
  );
}


// ─── Auth ─────────────────────────────────────────────────────────────────────

// ─── Settings ─────────────────────────────────────────────────────────────────
function ToggleRow({label,desc,icon,value,onChange,surface2,border,text,text2}){
  const trackRef=useRef(null);
  const thumbRef=useRef(null);
  // Sync DOM when value changes without destroying element
  useEffect(()=>{
    if(!trackRef.current||!thumbRef.current)return;
    if(value){
      trackRef.current.classList.add("on");
    }else{
      trackRef.current.classList.remove("on");
    }
  },[value]);
  return(
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 15px",borderBottom:`1px solid ${border}`,cursor:"pointer"}}
      onClick={onChange}
      onTouchStart={e=>e.currentTarget.style.background=surface2}
      onTouchEnd={e=>e.currentTarget.style.background="transparent"}
      onMouseEnter={e=>e.currentTarget.style.background=surface2}
      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <div style={{fontSize:19,width:26,textAlign:"center",flexShrink:0}}>{icon}</div>
      <div style={{flex:1}}>
        <div style={{color:text,fontSize:14,fontWeight:500}}>{label}</div>
        {desc&&<div style={{color:text2,fontSize:12,marginTop:1}}>{desc}</div>}
      </div>
      <div ref={trackRef} className={`rmg-toggle${value?" on":""}`}>
        <div ref={thumbRef} className="rmg-toggle-thumb"/>
      </div>
    </div>
  );
}


// ─── Settings groups metadata ────────────────────────────────────────────────
// Используется и в SettingsBody (рендер списка групп / экранов), и в ChatList
// (динамический заголовок шапки overlay'я по activeGroup).
const SETTINGS_GROUPS_META = {
  notifications: { icon:"🔔", Ic:IcSetBell,     tint:"#e53935", label:"Уведомления",        subtitle:"Звук, вибрация, шторка" },
  chats:         { icon:"💬", Ic:IcTabChats,    tint:"#039be5", label:"Чаты",                subtitle:"Поведение чатов и кэш" },
  privacy:       { icon:"🔒", Ic:IcSetLock,     tint:"#8e8e93", label:"Конфиденциальность",  subtitle:"Онлайн, последний визит, прочтение" },
  storiesArchive:{ icon:"🕘", Ic:IcSetClock,    tint:"#f4a231", label:"Архив историй",       subtitle:"Твои старые фото и видео из историй" },
  theme:         { icon:"🎨", Ic:IcSetPalette,  tint:"#9c27b0", label:"Темы и оформление",   subtitle:"Тема, обои, размер текста" },
  offline:       { icon:"📥", Ic:IcSetDownload, tint:"#43a047", label:"Оффлайн-сохранение",  subtitle:"Локальный архив чатов и файлов" },
  about:         { icon:"ℹ️", Ic:IcSetInfo,     tint:"#546e7a", label:"О мессенджере",       subtitle:"Версия, разработчики, контакты" },
};

// Глобальный обработчик кнопки «Назад» для вкладки «Настройки».
// ChatList регистрирует здесь функцию через useEffect, когда открыт overlay настроек.
// Возвращает true, если событие обработано (нужно остановить дальнейшую обработку).
// Используется тот же паттерн, что и для _videoFullscreenClose.
let _settingsBackHandler = null;

// Обработчик кнопки «Назад» для модалки «Очистить» (внутри настроек оффлайна).
// Приоритет ВЫШЕ _settingsBackHandler — модалка центрируется поверх overlay'я.
let _offlineClearBackHandler = null;

// ─── Настройки оффлайн-сохранения ────────────────────────────────────────────
// Встраивается в SettingsBody как отдельная группа. В оффлайн-режиме все
// элементы редактирования заблокированы — открыта только кнопка «Очистить»
// (во избежание случайных сбоев локальной базы).
function OfflineSettings({online,allChats,currentUser}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[cfg,setCfg]=useState(()=>getOfflineSettings());
  const[stats,setStats]=useState(null);
  const[busy,setBusy]=useState(false);
  const[status,setStatus]=useState("");
  const[showClear,setShowClear]=useState(false);
  const[clearClosing,setClearClosing]=useState(false);

  const refreshStats=useCallback(()=>{
    OfflineStore.getStats().then(setStats).catch(()=>{});
  },[]);
  useEffect(()=>{refreshStats();},[refreshStats]);

  // Регистрация физической кнопки «Назад» для модалки «Очистить».
  const closeClear=useCallback(()=>{
    if(clearClosing)return;
    setClearClosing(true);
    setTimeout(()=>{setShowClear(false);setClearClosing(false);},220);
  },[clearClosing]);
  useEffect(()=>{
    if(!showClear||clearClosing){_offlineClearBackHandler=null;return;}
    _offlineClearBackHandler=()=>{closeClear();return true;};
    return()=>{_offlineClearBackHandler=null;};
  },[showClear,clearClosing,closeClear]);

  // Сохранение настройки в общий rmg_s.
  const persist=(patch)=>{
    if(!online)return; // в оффлайне редактирование закрыто
    let s={};
    try{s=JSON.parse(localStorage.getItem("rmg_s")||"{}");}catch{}
    const next={...s,...patch};
    localStorage.setItem("rmg_s",JSON.stringify(next));
    setCfg(getOfflineSettings());
  };

  const fmtBytes=(b)=>!b?"0 Б":b>1048576?`${(b/1048576).toFixed(1)} МБ`:b>1024?`${(b/1024).toFixed(0)} КБ`:`${b} Б`;

  // «Сохранить все сейчас» — тянет переписки всех чатов из Firestore и кладёт
  // в локальный архив по текущим правилам (файлы — только если тип «full»).
  // Таймаут на сохранение одного чата (чтобы один "зависший" чат не блокировал всё).
  const CHAT_SAVE_TIMEOUT=60000;

  const saveAllNow=async()=>{
    if(!online||busy)return;
    setBusy(true);setStatus("Сохранение…");
    const settings=getOfflineSettings();
    let okChats=0,okFiles=0;
    for(const c of (allChats||[])){
      try{
        // Оборачиваем сохранение чата в таймаут: если не уложились — логируем и идём дальше.
        const r=await Promise.race([
          (async()=>{
            const snap=await getDocs(query(
              collection(db,"chats",c.id,"messages"),
              orderBy("createdAt","asc")
            ));
            const list=snap.docs.map(d=>({id:d.id,...d.data()}));
            return OfflineStore.saveChat(c.id,list,{
              name:c.name||c.title||"",
              type:c.type||"",
              partnerPhoto:c._partnerPhoto||"",
            });
          })(),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error("chat timeout")),CHAT_SAVE_TIMEOUT))
        ]);
        okChats++;
        if(r)okFiles+=r.savedFiles||0;
      }catch(e){
        console.warn("[offline] saveAllNow: chat save failed/timed out:",c.id,e?.message||e);
      }
    }
    setBusy(false);
    setStatus(`✅ Сохранено: ${okChats} ${okChats===1?"чат":"чатов"}`+
      (settings.type==="full"?`, ${okFiles} ${okFiles===1?"файл":"файлов"}`:" (только текст)"));
    refreshStats();
  };

  // Очистка выбранного раздела локального архива.
  const doClear=async(kind)=>{
    setBusy(true);
    try{
      if(kind==="files")            await OfflineStore.clearFiles();
      else if(kind==="chatsfiles")  await OfflineStore.clearChatsAndFiles();
      else                          await OfflineStore.clearAll();
    }catch(e){}
    setBusy(false);
    closeClear();
    setStatus(kind==="files"?"🗑 Файлы удалены"
            :kind==="chatsfiles"?"🗑 Переписки и файлы удалены"
            :"🗑 Локальная база полностью очищена");
    refreshStats();
  };

  // Заголовок секции (как в группе «Темы»).
  const SectionLabel=({children})=>(
    <div style={{color:text2,fontSize:11,marginBottom:9,letterSpacing:0.3}}>{children}</div>
  );
  // Ряд pill-кнопок выбора (стиль — как переключатели темы/размера текста).
  const Choice=({options,value,onPick,disabled})=>(
    <div style={{display:"flex",gap:7,flexWrap:"wrap",
      opacity:disabled?0.4:1,pointerEvents:disabled?"none":"auto"}}>
      {options.map(o=>{
        const sel=value===o.val;
        return(
          <button key={String(o.val)} onClick={()=>onPick(o.val)}
            style={{flex:o.flex||"1 1 auto",minWidth:o.minWidth||"30%",padding:"9px 10px",
              borderRadius:11,border:sel?`2px solid ${accent}`:`1px solid ${border}`,
              background:sel?accent+"22":surface2,color:sel?accent:text2,
              fontSize:12,fontWeight:sel?700:500,cursor:"pointer",fontFamily:"inherit",
              transition:"all 0.18s"}}>
            {o.label}
          </button>
        );
      })}
    </div>
  );

  const editLocked=!online;

  return(
    <div style={{background:surface,marginTop:8,paddingBottom:8}}>

      {/* Замок — пояснение про блокировку в оффлайне */}
      {editLocked&&(
        <div style={{margin:"12px 15px 4px",padding:"10px 12px",borderRadius:12,
          background:"#FFC40015",border:"1px solid #FFC40044",color:text2,fontSize:12,lineHeight:1.5}}>
          🔒 В оффлайн-режиме изменение настроек локального сохранения недоступно —
          это защита от случайных сбоев. Доступна только кнопка «Очистить».
        </div>
      )}

      {/* Время сохранения */}
      <div style={{padding:"13px 15px",borderBottom:`1px solid ${border}`}}>
        <SectionLabel>ВРЕМЯ СОХРАНЕНИЯ</SectionLabel>
        <Choice
          disabled={editLocked}
          value={cfg.mode}
          onPick={v=>persist({offlineSaveMode:v})}
          options={[
            {val:"always", label:"Всегда"},
            {val:"manual", label:"Только по запросу"},
          ]}/>
        <div style={{color:text2,fontSize:11,marginTop:8,lineHeight:1.5}}>
          {cfg.mode==="always"
            ? "Каждое полученное сообщение при доступном интернете сразу сохраняется локально для оффлайн-просмотра."
            : "Сообщения сохраняются только по нажатию кнопки «Сохранить все сейчас»."}
        </div>
      </div>

      {/* Кнопка «Сохранить все сейчас» — доступна всегда (в оффлайне заблокирована) */}
      <div style={{padding:"13px 15px",borderBottom:`1px solid ${border}`}}>
        <button onClick={saveAllNow} disabled={editLocked||busy}
          style={{width:"100%",padding:13,borderRadius:13,border:"none",
            background:editLocked?surface2:`linear-gradient(135deg,${accent},${accent2})`,
            color:editLocked?text2:"#fff",fontSize:14,fontWeight:700,
            cursor:editLocked||busy?"default":"pointer",fontFamily:"inherit",
            opacity:busy?0.6:1,transition:"all 0.2s"}}>
          {busy?"⏳ Сохранение…":"💾 Сохранить все сейчас"}
        </button>
        <div style={{color:text2,fontSize:11,marginTop:8,lineHeight:1.5}}>
          {cfg.mode==="manual"
            ? "Сохранит все переписки, которые ещё не были сохранены. Файлы — только если выбран тип «Переписки и файлы»."
            : "Принудительно сохранит все переписки прямо сейчас. Файлы — только если выбран тип «Переписки и файлы»."}
        </div>
      </div>

      {/* Тип сохранения */}
      <div style={{padding:"13px 15px",borderBottom:`1px solid ${border}`}}>
        <SectionLabel>ТИП СОХРАНЕНИЯ</SectionLabel>
        <Choice
          disabled={editLocked}
          value={cfg.type}
          onPick={v=>persist({offlineSaveType:v})}
          options={[
            {val:"full", label:"Переписки и файлы"},
            {val:"text", label:"Только текстовые сообщения"},
          ]}/>
        <div style={{color:text2,fontSize:11,marginTop:8,lineHeight:1.5}}>
          {cfg.type==="full"
            ? "Сохраняются переписки и файлы любого формата (с учётом ограничения по весу)."
            : "Сохраняются только текстовые сообщения. Файлы остаются «оболочкой» — видно название, но без загрузки."}
        </div>
      </div>

      {/* Вес файлов — только при типе «Переписки и файлы» */}
      {cfg.type==="full"&&(
        <div style={{padding:"13px 15px",borderBottom:`1px solid ${border}`}}>
          <SectionLabel>ВЕС ФАЙЛОВ</SectionLabel>
          <Choice
            disabled={editLocked}
            value={cfg.fileLimit}
            onPick={v=>persist({offlineFileLimit:v})}
            options={[
              {val:25,  label:"До 25 МБ",  minWidth:"22%"},
              {val:50,  label:"До 50 МБ",  minWidth:"22%"},
              {val:100, label:"До 100 МБ", minWidth:"22%"},
              {val:0,   label:"Безлимит",  minWidth:"22%"},
            ]}/>
          <div style={{color:text2,fontSize:11,marginTop:8,lineHeight:1.5}}>
            Файлы крупнее лимита сохраняются как «оболочка» — без загрузки самого файла.
          </div>
        </div>
      )}

      {/* Статистика локального архива */}
      <div style={{padding:"13px 15px",borderBottom:`1px solid ${border}`}}>
        <SectionLabel>ЛОКАЛЬНЫЙ АРХИВ</SectionLabel>
        <div style={{color:text,fontSize:13}}>
          {stats
            ? `${stats.chatCount} ${stats.chatCount===1?"чат":"чатов"} · ${stats.msgCount} сообщ. · ${stats.fileCount} файлов`
            : "Подсчёт…"}
        </div>
        {stats&&stats.fileCount>0&&(
          <div style={{color:text2,fontSize:11,marginTop:3}}>Размер файлов: {fmtBytes(stats.fileBytes)}</div>
        )}
      </div>

      {/* Кнопка «Очистить» — доступна всегда, в т.ч. в оффлайне */}
      <div style={{padding:"13px 15px"}}>
        <button onClick={()=>setShowClear(true)} disabled={busy}
          style={{width:"100%",padding:13,borderRadius:13,
            border:`1px solid #ff525244`,background:"#ff52521a",
            color:"#ff6b6b",fontSize:14,fontWeight:700,
            cursor:busy?"default":"pointer",fontFamily:"inherit",opacity:busy?0.6:1}}>
          🗑 Очистить
        </button>
      </div>

      {/* Статус последней операции */}
      {status&&(
        <div style={{margin:"0 15px",color:text2,fontSize:12,textAlign:"center",paddingBottom:4}}>{status}</div>
      )}

      {/* ── Модалка «Очистить» ── */}
      {showClear&&(
        <div onClick={closeClear}
          style={{position:"fixed",inset:0,zIndex:400,background:"rgba(0,0,0,0.6)",
            display:"flex",alignItems:"center",justifyContent:"center",padding:20,
            animation:clearClosing?"fadeIn 0.2s reverse forwards":"fadeIn 0.2s ease"}}>
          <div onClick={e=>e.stopPropagation()}
            style={{width:"100%",maxWidth:340,background:surface,borderRadius:20,
              overflow:"hidden",border:`1px solid ${border}`,
              boxShadow:"0 24px 70px rgba(0,0,0,0.6)",
              animation:clearClosing?"popIn 0.2s reverse forwards":"popIn 0.22s cubic-bezier(0.34,1.56,0.64,1)"}}>
            {/* Верхний бар окна */}
            <div style={{padding:"13px 16px",background:surface2,borderBottom:`1px solid ${border}`,
              display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{color:text,fontWeight:700,fontSize:15}}>🗑 Очистить</div>
              <button onClick={closeClear}
                style={{background:"none",border:"none",color:text2,fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            {/* Тело */}
            <div style={{padding:"18px 16px"}}>
              <div style={{color:text,fontSize:14,marginBottom:14,textAlign:"center"}}>
                Что вы желаете очистить?
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:9}}>
                {[
                  {kind:"files",      label:"Файлы",              desc:"Удалить только сохранённые файлы"},
                  {kind:"chatsfiles", label:"Переписки и файлы",  desc:"Удалить сохранённые переписки и файлы"},
                  {kind:"all",        label:"Все",                desc:"Полностью очистить локальную базу"},
                ].map(b=>(
                  <button key={b.kind} onClick={()=>doClear(b.kind)} disabled={busy}
                    style={{textAlign:"left",padding:"11px 13px",borderRadius:12,
                      border:`1px solid ${border}`,background:surface2,cursor:busy?"default":"pointer",
                      fontFamily:"inherit",opacity:busy?0.6:1,transition:"all 0.15s"}}
                    onMouseEnter={e=>{if(!busy)e.currentTarget.style.borderColor="#ff5252";}}
                    onMouseLeave={e=>e.currentTarget.style.borderColor=border}>
                    <div style={{color:"#ff6b6b",fontSize:13,fontWeight:700}}>{b.label}</div>
                    <div style={{color:text2,fontSize:11,marginTop:2}}>{b.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Settings Body (встраивается во вкладку «Настройки» в ChatList) ──────────
// Telegram-style: главная страница — список групп; тап на группу открывает
// отдельный экран с её настройками. activeGroup и onOpenGroup поднимаются
// в ChatList — он же управляет шапкой overlay'я и обработчиком Back.
function StoryArchiveSettings({currentUser,profile}){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[items,setItems]=useState([]);
  const[viewer,setViewer]=useState(null);
  const[loading,setLoading]=useState(true);
  const[rawArch,setRawArch]=useState([]);
  const[nowTick,setNowTick]=useState(Date.now());

  useEffect(()=>{
    const t=setInterval(()=>setNowTick(Date.now()),30000);
    return()=>clearInterval(t);
  },[]);
  useEffect(()=>{
    if(!currentUser?.uid)return;
    setLoading(true);
    return onSnapshot(collection(db,"stories"),snap=>{
      setRawArch(snap.docs.map(d=>({id:d.id,...d.data()})));
      setLoading(false);
    },()=>setLoading(false));
  },[currentUser?.uid]);
  useEffect(()=>{
    const now=Date.now();
    const expOf=st=>st.expiresAtMs||((st.createdAtMs||0)+24*60*60*1000);
    setItems(rawArch
      .filter(st=>st.uid===currentUser?.uid)
      .filter(st=>expOf(st)<=now)
      .sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0)));
  },[rawArch,nowTick,currentUser?.uid]);

  return(
    <div style={{background:surface,marginTop:8,minHeight:260}}>
      <div style={{padding:"14px 15px",borderBottom:`1px solid ${border}`}}>
        <div style={{color:text,fontWeight:800,fontSize:15}}>Архив историй</div>
        <div style={{color:text2,fontSize:12,marginTop:4,lineHeight:1.45}}>
          Здесь хранятся твои истории после 24 часов. Фото и видео можно открыть, скачать или удалить.
        </div>
      </div>
      {loading?(
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:150}}>
          <div style={{width:28,height:28,borderRadius:"50%",border:`3px solid ${accent}33`,borderTopColor:accent,animation:"spin .75s linear infinite"}}/>
        </div>
      ):items.length===0?(
        <div style={{padding:"36px 22px",textAlign:"center"}}>
          <div style={{fontSize:44,opacity:.45,marginBottom:10}}>🕘</div>
          <div style={{color:text,fontWeight:800,fontSize:15}}>Архив пока пустой</div>
          <div style={{color:text2,fontSize:12,marginTop:6,lineHeight:1.45}}>Когда история проживёт 24 часа, она появится здесь.</div>
        </div>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,padding:12}}>
          {items.map((st,i)=>(
            <button key={st.id} onClick={()=>setViewer({items,startIndex:i})}
              style={{position:"relative",aspectRatio:"9/14",border:"none",borderRadius:13,overflow:"hidden",padding:0,background:surface2,cursor:"pointer",boxShadow:"0 3px 12px rgba(0,0,0,.25)"}}>
              {st.mediaType==="video"?(
                <video src={st.mediaUrl} poster={st.videoThumb||""} muted playsInline preload="metadata" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
              ):(
                <img src={st.mediaUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
              )}
              <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(0,0,0,.58),transparent 55%)"}}/>
              <div style={{position:"absolute",left:7,right:7,bottom:7,color:"#fff",fontSize:10,fontWeight:800,textAlign:"left",textShadow:"0 1px 4px rgba(0,0,0,.7)"}}>
                {st.mediaType==="video"?"▶ ":""}{st.createdAtMs?new Date(st.createdAtMs).toLocaleDateString("ru",{day:"2-digit",month:"short"}):"История"}
              </div>
            </button>
          ))}
        </div>
      )}
      {items.length>0&&(
        <div style={{padding:"0 15px 14px",color:text2,fontSize:11}}>
          Всего в архиве: <span style={{color:accent,fontWeight:800}}>{items.length}</span>
        </div>
      )}
      {viewer&&<StoryViewer items={viewer.items} startIndex={viewer.startIndex} currentUser={currentUser} profile={profile} onClose={()=>setViewer(null)}/>}
    </div>
  );
}

function SettingsBody({currentUser,profile,themeName,onChangeTheme,wallpaperId,onChangeWallpaper,accentId,onChangeAccent,msgFontSize=14,onChangeFontSize,onLogout,activeGroup,onOpenGroup,online=true,allChats=[]}){
  const {bg,surface,surface2,border,text,text2,accent}=useContext(ThemeCtx);
  const[s,setS2]=useState(()=>{try{return JSON.parse(localStorage.getItem("rmg_s")||"{}");}catch{return{};}});
  const DEF_ON=["showOnline","showLastSeen","readReceipts","showTyping","notifSound","notifVibro","notifPreview","notifGroups"];
  const isOn=k=>DEF_ON.includes(k)?s[k]!==false:!!s[k];
  const toggle=k=>{
    const next={...s,[k]:!isOn(k)};
    setS2(next);
    localStorage.setItem("rmg_s",JSON.stringify(next));
    if(k==="notifSound"&&!isOn(k))playSound("msg");
    if(["notifSound","notifVibro","notifPreview","notifGroups"].includes(k)){
      // Настройки этого устройства хранятся вместе с UnifiedPush-регистрацией.
      syncPushPreferences(currentUser?.uid).catch(()=>{});
    }
  };
  const T=({k,label,desc,icon})=>(
    <ToggleRow label={label} desc={desc} icon={icon} value={isOn(k)} onChange={()=>toggle(k)}
      surface2={surface2} border={border} text={text} text2={text2}/>
  );
  const Row=({icon,Ic,tint,label,val,onClick,red=false,chevron=true})=>(
    <div onClick={onClick} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 15px",borderBottom:`1px solid ${border}`,cursor:onClick?"pointer":"default",transition:"background 0.13s, transform 0.13s"}}
      onMouseEnter={e=>{if(onClick)e.currentTarget.style.background=surface2;}}
      onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.transform="none";}}
      onTouchStart={e=>{if(onClick){e.currentTarget.style.background=surface2;e.currentTarget.style.transform="scale(0.98)";}}}
      onTouchEnd={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.transform="none";}}>
      {Ic
        ?<div style={{width:30,height:30,borderRadius:8,background:tint||"#8e8e93",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic size={18} color="#fff"/></div>
        :<div style={{fontSize:20,width:28,textAlign:"center",flexShrink:0}}>{icon}</div>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:red?"#ff5252":text,fontSize:14,fontWeight:500}}>{label}</div>
        {val&&<div style={{color:text2,fontSize:12,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{val}</div>}
      </div>
      {onClick&&chevron&&<div style={{color:text2,fontSize:17,flexShrink:0}}>›</div>}
    </div>
  );

  // ── Открытая группа: «Уведомления» ────────────────────────────────────
  if(activeGroup==="notifications"){
    return(
      <div style={{background:surface,marginTop:8}}>
        <T k="notifSound"   icon={<IcSetBell size={20} color="#8e8e93" style={_mi}/>} label="Звук уведомлений"     desc="Звук при новом сообщении"/>
        <T k="notifVibro"   icon={<IcVibro size={20} color="#8e8e93" style={_mi}/>} label="Вибрация"              desc="Вибрация при новом сообщении"/>
        <T k="notifPreview" icon={<IcEye size={20} color="#8e8e93" style={_mi}/>} label="Текст в уведомлении"  desc="Показывать текст сообщения в шторке"/>
        <T k="notifGroups"  icon={<IcTabGroups size={20} color="#8e8e93" style={_mi}/>} label="Уведомления из групп" desc="Получать уведомления из групповых чатов"/>
        <div style={{padding:"13px 16px",borderTop:"1px solid rgba(128,128,128,.25)"}}>
          <div style={{color:text2,fontWeight:800,fontSize:14,marginBottom:6}}>📲 Уведомления на этом устройстве</div>
          <div style={{color:text2,fontSize:12,lineHeight:1.55}}>
            После входа RedMrxGram попросит разрешение Android и подключится к выбранному в телефоне UnifiedPush-дистрибьютору.<br/>
            Если уведомления не приходят, проверь в Android разрешение для RedMrxGram и что дистрибьютор UnifiedPush (например, ntfy) установлен и настроен.
          </div>
        </div>
      </div>
    );
  }

  // ── Открытая группа: «Чаты» ───────────────────────────────────────────
  if(activeGroup==="chats"){
    return(
      <div style={{background:surface,marginTop:8}}>
        <T k="enterSend"  icon={<IcKeys size={20} color="#8e8e93" style={_mi}/>} label="Enter для отправки"   desc="Отправлять сообщение по нажатию Enter"/>
        <T k="bubbleAnim" icon={<IcSpark size={20} color="#8e8e93" style={_mi}/>} label="Анимация сообщений"   desc="Плавное появление сообщений"/>
        <Row Ic={IcTrash} tint="#e53935" label="Очистить кэш" onClick={()=>{localStorage.removeItem("rmg_cache");alert("Готово!");}}/>
        <Row Ic={IcWrench} tint="#546e7a" label="Диагностика аватарок" onClick={async()=>{
          const L=["Сборка fix25"];
          const pv=v=>typeof v==="string"&&v?(v.startsWith("data:")?"OK data: длина="+v.length:"ССЫЛКА "+v.slice(0,42)+"… длина="+v.length):"ПУСТО";
          L.push("Сеть: "+(navigator.onLine?"есть":"НЕТ"));
          try{const s=await getDoc(doc(db,"users",currentUser.uid));L.push("Моё фото (REST): "+(s.exists()?pv(s.data()?.photo):"НЕТ ДОКА"));}catch(e){L.push("Моё фото (REST): ОШИБКА "+((e&&e.message)||e));}
          let lst=allChats&&allChats.length?allChats:[];
          if(!lst.length){try{lst=JSON.parse(localStorage.getItem("rmg_chats_"+currentUser.uid)||"[]");}catch{lst=[];}}
          const directs=lst.filter(c=>c&&c.type==="direct").slice(0,4);
          if(!directs.length)L.push("Личных чатов не найдено");
          for(const c of directs){
            const p=Object.keys(c.names||c.photos||{}).find(k=>k!==currentUser.uid);
            L.push("— Чат: "+(((c.names||{})[p])||String(c.id).slice(0,8)));
            L.push("  фото в списке: "+pv((c.photos||{})[p]));
            try{const s=await getDoc(doc(db,"users",p));L.push("  профиль партнёра (REST): "+(s.exists()?pv(s.data()?.photo):"НЕТ ДОКА"));}catch(e){L.push("  профиль партнёра (REST): ОШИБКА "+((e&&e.message)||e));}
            try{const cd=await getDoc(doc(db,"chats",c.id));L.push("  чат-док (REST): "+(cd.exists()?((Object.entries(cd.data()?.photos||{}).map(([k,v])=>k.slice(0,6)+"→"+pv(v)).join(" | "))||"карта фото пуста"):"НЕТ ДОКА"));}catch(e){L.push("  чат-док (REST): ОШИБКА "+((e&&e.message)||e));}
          }
          try{const m=JSON.parse(localStorage.getItem("mrx_photos")||"{}");L.push("Кэш телефона: "+((Object.entries(m).map(([k,v])=>k.slice(0,6)+"→"+pv(v)).join(" | "))||"пуст"));}catch(e){L.push("Кэш телефона: ошибка чтения");}
          await new Promise(res=>{const im=new Image();im.onload=()=>{L.push("Тест мини data:-картинки: РИСУЕТСЯ");res();};im.onerror=()=>{L.push("Тест мини data:-картинки: ЗАБЛОКИРОВАНО");res();};setTimeout(res,3000);im.src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";});
          try{const pd=directs[0]&&Object.keys(directs[0].names||directs[0].photos||{}).find(k=>k!==currentUser.uid);const s2=pd?await getDoc(doc(db,"users",pd)):null;const ph=s2&&s2.exists()?s2.data()?.photo:null;if(typeof ph==="string"&&ph.startsWith("data:")){await new Promise(res=>{const im=new Image();im.onload=()=>{L.push("Тест РЕАЛЬНОГО фото партнёра: РИСУЕТСЯ "+im.width+"x"+im.height);res();};im.onerror=()=>{L.push("Тест РЕАЛЬНОГО фото: ОШИБКА ЗАГРУЗКИ");res();};setTimeout(res,4000);im.src=ph;});}else{L.push("Тест реального фото: нет data:-фото у партнёра");}}catch(e){L.push("Тест реального фото: ошибка "+((e&&e.message)||e));}
          try{await setDoc(doc(db,"diag","d_"+currentUser.uid),{text:L.join("\n"),ts:Date.now()});L.push("Отчёт отправлен на сервер OK");}catch(e){L.push("Отчёт НЕ отправлен: "+((e&&e.message)||e));}
          const el=document.createElement("div");
          el.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;background:#000;color:#fff;font-family:monospace;font-size:12px;line-height:1.5;padding:28px 16px 60px;overflow:auto;white-space:pre-wrap;word-break:break-all;";
          el.textContent=L.join("\n")+"\n\n[НАЖМИ СЮДА ЧТОБЫ ЗАКРЫТЬ]";
          el.onclick=()=>el.remove();
          document.body.appendChild(el);
        }}/>
      </div>
    );
  }

  // ── Открытая группа: «Конфиденциальность» ─────────────────────────────
  if(activeGroup==="privacy"){
    return(
      <div style={{background:surface,marginTop:8}}>
        <T k="showOnline"   icon={<IcDot size={20} color="#43a047" style={_mi}/>} label="Показывать онлайн"  desc="Другие видят когда ты в сети"/>
        <T k="showLastSeen" icon={<IcSetClock size={20} color="#8e8e93" style={_mi}/>} label="Последний онлайн"   desc="Другие видят когда ты последний раз был в сети"/>
        <T k="readReceipts" icon={<IcEye size={20} color="#8e8e93" style={_mi}/>} label="Статус прочтения"   desc="Собеседник видит что ты прочитал сообщение"/>
        <T k="showTyping"   icon={<IcPencilSm size={20} color="#8e8e93" style={_mi}/>} label="Статус «печатает»" desc="Собеседник видит когда ты печатаешь"/>
      </div>
    );
  }

  // ── Открытая группа: «Темы и оформление» ──────────────────────────────
  if(activeGroup==="storiesArchive"){
    return <StoryArchiveSettings currentUser={currentUser} profile={profile}/>;
  }

  if(activeGroup==="theme"){
    return(
      <div style={{background:surface,marginTop:8}}>
        {/* Theme */}
        <div style={{padding:"12px 15px",borderBottom:`1px solid ${border}`}}>
          <div style={{color:text2,fontSize:11,marginBottom:9}}>ТЕМА</div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            {[{id:"dark",ico:"🌙"},{id:"amoled",ico:"⬛"},{id:"light",ico:"☀️"},{id:"blue",ico:"🌊"},{id:"mrx",ico:"🔴"},{id:"green",ico:"🌿"},{id:"glass",ico:"🫧"},{id:"crystal",ico:"💎"}].map(t=>(
              <button key={t.id} onClick={()=>onChangeTheme(t.id)} style={{flex:1,minWidth:"20%",padding:"8px 3px",borderRadius:11,border:themeName===t.id?`2px solid ${accent}`:`1px solid ${border}`,background:themeName===t.id?accent+"22":surface2,fontSize:19,cursor:"pointer",fontFamily:"inherit",transition:"all 0.2s"}}>{t.ico}</button>
            ))}
          </div>
        </div>
        {/* Accent color */}
        <div style={{padding:"12px 15px",borderBottom:`1px solid ${border}`}}>
          <div style={{color:text2,fontSize:11,marginBottom:9}}>ЦВЕТ АКЦЕНТА</div>
          {!["dark","light"].includes(themeName)&&<div style={{color:text2,fontSize:12,marginBottom:6}}>Акцент доступен только для светлой и тёмной темы</div>}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",opacity:["dark","light"].includes(themeName)?1:0.3,pointerEvents:["dark","light"].includes(themeName)?"auto":"none"}}>
            {ACCENT_COLORS.map(a=>(
              <button key={a.id} onClick={()=>onChangeAccent(a.id)}
                style={{width:32,height:32,borderRadius:"50%",border:accentId===a.id?`3px solid ${text}`:`2px solid transparent`,
                  background:a.color,cursor:"pointer",transition:"all 0.2s",
                  boxShadow:accentId===a.id?`0 0 10px ${a.color}88`:"none"}}
                title={a.label}/>
            ))}
            <button onClick={()=>onChangeAccent("")}
              style={{width:32,height:32,borderRadius:"50%",border:!accentId?`3px solid ${text}`:`1px solid ${border}`,
                background:"transparent",cursor:"pointer",color:text,fontSize:10,fontWeight:700}}>авт</button>
          </div>
        </div>
        {/* Wallpaper */}
        <div style={{padding:"12px 15px",borderBottom:`1px solid ${border}`}}>
          <div style={{color:text2,fontSize:11,marginBottom:9}}>ОБОИ ЧАТА</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {WALLPAPERS.map(w=>(
              <button key={w.id} onClick={()=>onChangeWallpaper(w.id)}
                style={{width:48,height:32,borderRadius:8,
                  border:wallpaperId===w.id?`2px solid ${accent}`:`1px solid ${border}`,
                  background:w.bg||surface2,cursor:"pointer",
                  fontSize:9,color:text2,fontWeight:600,overflow:"hidden"}}>
                {!w.bg&&w.label}
              </button>
            ))}
          </div>
        </div>
        {/* Font size */}
        <div style={{padding:"12px 15px",borderBottom:`1px solid ${border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{color:text2,fontSize:11}}>РАЗМЕР ТЕКСТА</div>
            <div style={{color:accent,fontSize:11,fontWeight:700}}>{msgFontSize}px</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{color:text2,fontSize:10}}>А</span>
            <div style={{flex:1,position:"relative",height:4,background:border,borderRadius:2,cursor:"pointer"}}
              onClick={e=>{
                const rect=e.currentTarget.getBoundingClientRect();
                const ratio=(e.clientX-rect.left)/rect.width;
                const size=Math.round(10+ratio*12);
                onChangeFontSize(size);
              }}>
              <div style={{position:"absolute",top:0,left:0,height:"100%",
                width:`${(msgFontSize-10)/12*100}%`,background:accent,borderRadius:2}}/>
              <div style={{position:"absolute",top:"50%",transform:"translate(-50%,-50%)",
                left:`${(msgFontSize-10)/12*100}%`,
                width:16,height:16,borderRadius:"50%",background:accent,
                boxShadow:`0 0 6px ${accent}`}}/>
            </div>
            <span style={{color:text2,fontSize:16}}>А</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
            {[10,12,14,16,18,20,22].map(s=>(
              <button key={s} onClick={()=>onChangeFontSize(s)}
                style={{padding:"3px 5px",borderRadius:6,border:msgFontSize===s?`1.5px solid ${accent}`:`1px solid ${border}`,
                  background:msgFontSize===s?accent+"22":"transparent",color:msgFontSize===s?accent:text2,
                  fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>{s}</button>
            ))}
          </div>
        </div>
        <T k="compactMode" icon={<IcRuler size={20} color="#8e8e93" style={_mi}/>} label="Компактный режим"/>
      </div>
    );
  }

  // ── Открытая группа: «Оффлайн-сохранение» ─────────────────────────────
  if(activeGroup==="offline"){
    return <OfflineSettings online={online} allChats={allChats} currentUser={currentUser}/>;
  }

  // ── Открытая группа: «О мессенджере» ──────────────────────────────────
  // Рендерится как обычная группа настроек: использует общий заголовок overlay'я,
  // общий обработчик «Назад» (_settingsBackHandler) и общий контекст прокрутки.
  // Тот же SVG-логотип, что и на splash-экране и в окне авторизации.
  if(activeGroup==="about"){
    return(
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"32px 18px 20px",textAlign:"center"}}>
        {/* Логотип MrX — тот же SVG, что и на splash-экране / экране авторизации */}
        <div style={{width:104,height:104,borderRadius:28,background:"linear-gradient(145deg,#1a0000,#060000)",border:`2px solid ${accent}77`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:18,boxShadow:`0 8px 32px ${accent}55, 0 0 24px ${accent}33`}}>
          <svg width="68" height="68" viewBox="0 0 80 80" fill="none">
            <defs><linearGradient id="aboutLogoGrad" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#FF4444"/><stop offset="50%" stopColor="#FF0000"/><stop offset="100%" stopColor="#CC0000"/></linearGradient></defs>
            <path d="M8 68 L8 20 L24 20 L40 48 L56 20 L72 20 L72 68 L60 68 L60 38 L44 64 L36 64 L20 38 L20 68 Z" fill="url(#aboutLogoGrad)" style={{filter:"drop-shadow(0 0 8px rgba(255,0,0,0.7))"}}/>
          </svg>
        </div>
        <div style={{color:text,fontWeight:800,fontSize:22,marginBottom:6}}>MrX Messenger</div>
        <div style={{color:text2,fontSize:13,marginBottom:4}}>Версия 1.0</div>
        <div style={{color:accent,fontSize:14,fontWeight:700,marginBottom:20}}>Разработчики: MrX & AOS</div>
        <div style={{color:text2,fontSize:13,lineHeight:1.65,marginBottom:22,maxWidth:320}}>
          Современный мессенджер с продвинутыми возможностями: голосовые и видео сообщения, кружки, аудиоплеер, темы оформления и многое другое.
        </div>
        {/* Контактные блоки — wider maxWidth + flexShrink, чтобы все 4 пункта помещались целиком */}
        <div style={{width:"100%",maxWidth:360,background:surface,borderRadius:18,overflow:"hidden",border:`1px solid ${border}`}}>
          {[
            {ico:"🌐",lbl:"Сайт",url:"https://redmrxgram.work.gd",display:"redmrxgram.work.gd"},
            {ico:"✈️",lbl:"Канал",url:"https://t.me/redmrxgram",display:"t.me/redmrxgram"},
            {ico:"🎵",lbl:"TikTok",url:"https://tiktok.com/@redmrxgram",display:"tiktok.com/@redmrxgram"},
            {ico:"🤖",lbl:"Бот",url:"https://t.me/redmrx_bot",display:"t.me/redmrx_bot"},
          ].map((r,i,arr)=>(
            <a key={i} href={r.url} target="_blank" rel="noopener noreferrer"
              style={{display:"flex",alignItems:"center",gap:14,padding:"13px 16px",
                borderBottom:i<arr.length-1?`1px solid ${border}44`:"none",
                textDecoration:"none",WebkitTapHighlightColor:"transparent"}}
              onTouchStart={e=>e.currentTarget.style.background=surface2}
              onTouchEnd={e=>e.currentTarget.style.background="transparent"}>
              <span style={{fontSize:20,width:28,textAlign:"center",flexShrink:0}}>{r.ico}</span>
              <div style={{flex:1,minWidth:0,textAlign:"left"}}>
                <div style={{color:text,fontSize:13,fontWeight:600}}>{r.lbl}</div>
                <div style={{color:"#2AABEE",fontSize:12,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.display}</div>
              </div>
              <span style={{color:text2,fontSize:15,flexShrink:0}}>›</span>
            </a>
          ))}
        </div>
        <div style={{color:text2,fontSize:11,marginTop:22,marginBottom:8}}>© 2026 MrX & AOS. Все права защищены.</div>
      </div>
    );
  }

  // ── activeGroup === null: главная страница вкладки «Настройки» ─────────
  // Показываем список групп (каждая открывает свой экран), плюс одиночные
  // кнопки «Выйти из аккаунта» и «О мессенджере».
  return(
    <>
      {/* Список групп */}
      <div style={{background:surface,marginTop:8}}>
        {["notifications","chats","privacy","storiesArchive","theme","offline"].map(gid=>{
          const g=SETTINGS_GROUPS_META[gid];
          return(
            <Row key={gid} icon={g.icon} Ic={g.Ic} tint={g.tint} label={g.label} val={g.subtitle} onClick={()=>onOpenGroup(gid)}/>
          );
        })}
      </div>
      {/* Выйти из аккаунта — отдельная кнопка, не группа */}
      <div style={{background:surface,marginTop:8}}>
        <Row Ic={IcSetLogout} tint="#e53935" label="Выйти из аккаунта" red onClick={onLogout} chevron={false}/>
      </div>
      {/* О мессенджере — открывается как полноценная группа настроек
          (тот же overlay, общий заголовок, общий обработчик «Назад»). */}
      <div style={{background:surface,marginTop:8,marginBottom:30}}>
        <Row Ic={IcSetInfo} tint="#546e7a" label="О мессенджере" onClick={()=>onOpenGroup("about")}/>
      </div>
    </>
  );
}

// ─── Find People ──────────────────────────────────────────────────────────────
// AudioFullPlayerOverlay — renders full-screen player at App root level
function AudioFullPlayerOverlay(){
  const audio=useContext(AudioCtx);
  if(!audio||!audio.showFullPlayer||!audio.track)return null;
  return <AudioPlayerScreen/>;
}

// AudioMiniBar — renders MiniPlayer inline in screen layouts (below headers)
function AudioMiniBar(){
  const audio=useContext(AudioCtx);
  if(!audio||!audio.track)return null;
  return <MiniPlayer/>;
}

// ─── Mini Music Player (global, like Telegram) ────────────────────────────────
function MiniPlayer(){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  if(!audio||!audio.track)return null;
  const {track,playing,progress,openFullPlayer,closeMini,play,pause,next,prev,queue,idx}=audio;
  const hasPrev=idx>0||(audio.repeat==="all"&&queue.length>1);
  const hasNext=idx<queue.length-1||(audio.repeat==="all"&&queue.length>1)||audio.shuffle;

  return(
    <div style={{flexShrink:0,overflow:"hidden"}}>
      {/* Tappable area */}
      <div
        onClick={openFullPlayer}
        style={{
          display:"flex",alignItems:"center",gap:10,
          padding:"8px 12px 6px",
          background:surface+"F0",
          backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)",
          borderBottom:`1px solid ${border}`,
          cursor:"pointer",position:"relative",
        }}>
        {/* Album art */}
        <div style={{width:34,height:34,borderRadius:9,flexShrink:0,overflow:"hidden",
          background:`linear-gradient(135deg,${accent},${accent2})`,
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:playing?`0 0 10px ${accent}55`:"none",transition:"box-shadow 0.3s",
        }}>
          {track.coverUrl
            ?<img src={track.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            :<span style={{fontSize:16}}>🎵</span>}
        </div>
        {/* Info */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:text,fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2}}>
            {track.name||"Аудио"}
          </div>
          <div style={{color:text2,fontSize:10,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {track.ext||"MP3"}{track.size?" · "+track.size:""}
          </div>
        </div>
        {/* Controls — stop propagation so taps on buttons don't open full player */}
        <div style={{display:"flex",alignItems:"center",gap:2,flexShrink:0}} onClick={e=>e.stopPropagation()}>
          {(hasPrev||hasNext)&&(
            <button onClick={e=>{e.stopPropagation();prev();}}
              style={{width:32,height:32,borderRadius:"50%",border:"none",cursor:"pointer",
                background:"none",color:hasPrev?text:text2+"44",fontSize:14,
                display:"flex",alignItems:"center",justifyContent:"center"}}>⏮</button>
          )}
          <button onClick={e=>{e.stopPropagation();playing?pause():play();}}
            style={{width:36,height:36,borderRadius:"50%",border:"none",cursor:"pointer",
              background:`linear-gradient(135deg,${accent},${accent2})`,
              color:"#fff",fontSize:15,
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:`0 2px 8px ${accent}55`}}>
            {playing?"⏸":"▶"}
          </button>
          {(hasPrev||hasNext)&&(
            <button onClick={e=>{e.stopPropagation();next();}}
              style={{width:32,height:32,borderRadius:"50%",border:"none",cursor:"pointer",
                background:"none",color:hasNext?text:text2+"44",fontSize:14,
                display:"flex",alignItems:"center",justifyContent:"center"}}>⏭</button>
          )}
          <button onClick={e=>{e.stopPropagation();closeMini();}}
            style={{width:32,height:32,borderRadius:"50%",border:"none",cursor:"pointer",
              background:"none",color:text2,fontSize:13,
              display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
      </div>
      {/* Progress line */}
      <div style={{height:2,background:border,position:"relative"}}>
        <div style={{position:"absolute",left:0,top:0,bottom:0,
          width:(progress*100)+"%",
          background:`linear-gradient(90deg,${accent},${accent2})`,
          transition:"width 0.3s linear"}}/>
      </div>
    </div>
  );
}

// ─── QueueList — drag-to-reorder track list ──────────────────────────────────
function QueueList({queue,idx,playing,accent,accent2,surface2,text,text2,border,audio}){
  const [dragIdx,setDragIdx]=useState(null);
  const [overIdx,setOverIdx]=useState(null);
  const dragStartY=useRef(0);
  const itemHeight=60; // approximate px per item

  const handleDragStart=(e,i)=>{
    setDragIdx(i);
    dragStartY.current=e.clientY??e.touches?.[0]?.clientY??0;
    if(e.dataTransfer)e.dataTransfer.effectAllowed="move";
  };
  const handleDragOver=(e,i)=>{
    e.preventDefault();
    if(dragIdx===null)return;
    setOverIdx(i);
  };
  const handleDrop=(e,i)=>{
    e.preventDefault();
    if(dragIdx===null||dragIdx===i)return;
    audio.reorderQueue(dragIdx,i);
    setDragIdx(null);setOverIdx(null);
  };
  const handleDragEnd=()=>{setDragIdx(null);setOverIdx(null);};

  // Touch drag support — только от drag-handle (не от всего элемента)
  const handleTouchStart=(e,i)=>{
    // Разрешаем drag только если касание началось на drag-handle
    const handle=e.currentTarget.querySelector("[data-drag-handle]");
    if(handle&&!handle.contains(e.target))return;
    handleDragStart(e,i);
  };
  const handleTouchMove=(e,i)=>{
    if(dragIdx===null)return;
    e.preventDefault(); // Блокируем скролл страницы во время drag
    const touch=e.touches[0];
    const el=document.elementFromPoint(touch.clientX,touch.clientY);
    const overI=el?.closest?.("[data-queue-idx]")?.dataset?.queueIdx;
    if(overI!==undefined)setOverIdx(parseInt(overI));
  };
  const handleTouchEnd=(e,i)=>{
    if(dragIdx===null||overIdx===null||dragIdx===overIdx){setDragIdx(null);setOverIdx(null);return;}
    audio.reorderQueue(dragIdx,overIdx);
    setDragIdx(null);setOverIdx(null);
  };

  return(
    <div style={{marginBottom:16,userSelect:"none"}}>
      {queue.map((t,i)=>{
        const isActive=i===idx;
        const isDragging=dragIdx===i;
        const isOver=overIdx===i&&dragIdx!==null&&dragIdx!==i;
        return(
          <div key={t.id||i}
            data-queue-idx={i}
            draggable
            onDragStart={e=>handleDragStart(e,i)}
            onDragOver={e=>handleDragOver(e,i)}
            onDrop={e=>handleDrop(e,i)}
            onDragEnd={handleDragEnd}
            onTouchStart={e=>handleTouchStart(e,i)}
            onTouchMove={e=>handleTouchMove(e,i)}
            onTouchEnd={e=>handleTouchEnd(e,i)}
            style={{
              display:"flex",alignItems:"center",gap:10,padding:"10px 0",
              borderBottom:`1px solid ${border}44`,
              background:isActive?accent+"11":isOver?accent+"08":"none",
              borderRadius:isActive||isOver?10:0,
              paddingLeft:isActive?8:0,
              cursor:"default",
              opacity:isDragging?0.4:1,
              borderTop:isOver?`2px solid ${accent}`:"2px solid transparent",
              transition:"opacity 0.15s,border-color 0.1s,background 0.15s",
            }}>
            {/* Drag handle — касание только здесь начинает drag */}
            <div data-drag-handle style={{width:20,flexShrink:0,display:"flex",flexDirection:"column",
              alignItems:"center",gap:2.5,opacity:0.35,cursor:"grab",touchAction:"none"}}>
              {[0,1,2].map(j=>(
                <div key={j} style={{width:14,height:2,borderRadius:1,background:text2}}/>
              ))}
            </div>
            {/* Track icon */}
            <div style={{width:36,height:36,borderRadius:9,flexShrink:0,
              background:isActive?`linear-gradient(135deg,${accent},${accent2})`:surface2,
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}
              onClick={()=>!isDragging&&isActive===false&&AUDIO_ENGINE.jumpTo(i)}>
              {isActive?(playing?"▶":"⏸"):"🎵"}
            </div>
            {/* Info */}
            <div style={{flex:1,minWidth:0}}
              onClick={()=>!isDragging&&!isActive&&AUDIO_ENGINE.jumpTo(i)}>
              <div style={{color:isActive?accent:text,fontSize:13,fontWeight:isActive?700:500,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {t.name||"Аудио"}
              </div>
              <div style={{color:text2,fontSize:10,marginTop:1}}>
                {t.ext||"MP3"}{t.size?" · "+t.size:""}
              </div>
            </div>
            {/* Remove */}
            <button onClick={e=>{e.stopPropagation();audio.removeFromQueue(i);}}
              style={{width:28,height:28,borderRadius:"50%",border:"none",cursor:"pointer",
                background:"none",color:text2,fontSize:14,flexShrink:0,
                display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Full Audio Player Screen ────────────────────────────────────────────────
function AudioPlayerScreen(){
  const {surface,surface2,border,text,text2,accent,accent2,bg}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  const [visible,setVisible]=useState(false);
  const [dragging,setDragging]=useState(false);
  const [showQueue,setShowQueue]=useState(false);
  const [buffered,setBuffered]=useState(0);
  const seekBarRef=useRef(null);

  useEffect(()=>{requestAnimationFrame(()=>setVisible(true));},[]);

  // Отслеживаем буферизацию аудиоэлемента
  const trackId=audio?.track?.id;
  useEffect(()=>{
    const update=()=>{
      const el=AUDIO_ENGINE.el;
      if(!el||!el.duration)return;
      let end=0;
      for(let i=0;i<el.buffered.length;i++){
        if(el.buffered.end(i)>end)end=el.buffered.end(i);
      }
      setBuffered(end/el.duration);
    };
    const el=AUDIO_ENGINE.el;
    if(el){el.addEventListener("progress",update);update();}
    return()=>{if(el)el.removeEventListener("progress",update);};
  },[trackId]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(()=>{
    const onKey=(e)=>{
      // Don't intercept when typing in an input
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA")return;
      if(e.key===" "||e.code==="Space"){
        e.preventDefault();
        audio.playing?audio.pause():audio.play();
      }else if(e.key==="ArrowLeft"){
        e.preventDefault();
        const el=AUDIO_ENGINE.el;
        if(el&&el.duration){
          // Используем audio.seek() через контекст — React будет знать об изменении
          audio.seek(Math.max(0,el.currentTime-10)/el.duration);
        }
      }else if(e.key==="ArrowRight"){
        e.preventDefault();
        const el=AUDIO_ENGINE.el;
        if(el&&el.duration){
          audio.seek(Math.min(el.duration,el.currentTime+10)/el.duration);
        }
      }else if(e.key==="ArrowUp"){
        e.preventDefault();audio.prev();
      }else if(e.key==="ArrowDown"){
        e.preventDefault();audio.next();
      }
    };
    document.addEventListener("keydown",onKey);
    return()=>document.removeEventListener("keydown",onKey);
  },[audio]);

  useEffect(()=>{
    if(!audio?.showFullPlayer||!audio?.track)return;
    const closeByBack=()=>{
      setVisible(false);
      setTimeout(()=>audio.closeFullPlayer(),300);
      return true;
    };
    _audioBackHandler=closeByBack;
    return()=>{if(_audioBackHandler===closeByBack)_audioBackHandler=null;};
  },[audio?.showFullPlayer,audio?.track?.id,audio?.closeFullPlayer]);

  if(!audio||!audio.track)return null;
  const {track,playing,progress,currentTime,duration,queue,idx,shuffle,repeat,speed}=audio;

  const fmt=s=>isFinite(s)&&s>0?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`:"0:00";

  const handleSeek=e=>{
    if(!seekBarRef.current)return;
    const rect=seekBarRef.current.getBoundingClientRect();
    const x=(e.clientX??e.touches?.[0]?.clientX??0)-rect.left;
    const ratio=Math.max(0,Math.min(1,x/rect.width));
    audio.seek(ratio);
  };

  const handleSeekStart=e=>{
    audio.setSeekDragging&&audio.setSeekDragging(true);
    setDragging(true);
    handleSeek(e);
  };
  const handleSeekEnd=()=>{
    setDragging(false);
    audio.setSeekDragging&&audio.setSeekDragging(false);
  };

  const SPEEDS=[0.5,0.75,1,1.25,1.5,1.75,2];
  const nextRepeat=()=>audio.setRepeat(repeat==="off"?"all":repeat==="all"?"one":"off");
  const repeatIcon=repeat==="one"?"🔂":repeat==="all"?"🔁":"🔁";
  const repeatActive=repeat!=="off";

  const close=()=>{setVisible(false);setTimeout(()=>audio.closeFullPlayer(),300);};

  return(
    <div style={{
      position:"fixed",inset:0,zIndex:500,
      background:bg,
      transform:visible?"translateY(0)":"translateY(100%)",
      transition:"transform 0.32s cubic-bezier(0.32,0.72,0,1)",
      display:"flex",flexDirection:"column",
      overflow:"hidden",
    }}>
      {/* Tinted background gradient from accent */}
      <div style={{position:"absolute",inset:0,
        background:`radial-gradient(ellipse at 50% 20%,${accent}22 0%,transparent 65%)`,
        pointerEvents:"none"}}/>

      {/* Header */}
      <div style={{
        display:"flex",alignItems:"center",justifyContent:"space-between",
        paddingTop:"max(env(safe-area-inset-top,28px),28px)",
        paddingLeft:16,paddingRight:16,paddingBottom:10,
        flexShrink:0,position:"relative",zIndex:1,
      }}>
        <button onClick={close} style={{width:36,height:36,borderRadius:"50%",border:"none",cursor:"pointer",
          background:surface2,color:text,fontSize:20,display:"flex",alignItems:"center",justifyContent:"center"}}>
          ⌄
        </button>
        <div style={{color:text,fontWeight:700,fontSize:15}}>Аудиоплеер</div>
        <div style={{width:36}}/>
      </div>

      {/* Scrollable content */}
      <div style={{flex:1,overflowY:"auto",paddingBottom:"max(env(safe-area-inset-bottom,20px),20px)",position:"relative",zIndex:1}}>

        {/* Artwork */}
        <div style={{display:"flex",justifyContent:"center",padding:"16px 32px 24px"}}>
          <div style={{
            width:"min(240px,70vw)",height:"min(240px,70vw)",
            borderRadius:24,
            background:`linear-gradient(135deg,${accent}88,${accent2}66)`,
            display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:`0 20px 60px ${accent}44, 0 4px 20px rgba(0,0,0,0.5)`,
            animation:playing?"artPulse 2s ease-in-out infinite":"none",
            overflow:"hidden",flexShrink:0,
          }}>
            {track.coverUrl
              ?<img src={track.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :<span style={{fontSize:72}}>🎵</span>}
          </div>
        </div>

        {/* Track info */}
        <div style={{padding:"0 24px",textAlign:"center",marginBottom:20}}>
          <div style={{color:text,fontSize:19,fontWeight:800,marginBottom:5,
            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {track.name||"Аудио"}
          </div>
          <div style={{color:text2,fontSize:13}}>
            {track.ext||"MP3"}{track.size?" · "+track.size:""}{track.author?" · "+track.author:""}
          </div>
        </div>

        {/* Seek bar */}
        <div style={{padding:"0 24px",marginBottom:8}}>
          <div ref={seekBarRef}
            style={{height:4,background:surface2,borderRadius:2,cursor:"pointer",position:"relative",touchAction:"none"}}
            onClick={handleSeek}
            onMouseDown={e=>{handleSeekStart(e);}}
            onMouseMove={e=>{if(dragging)handleSeek(e);}}
            onMouseUp={handleSeekEnd}
            onMouseLeave={e=>{if(dragging)handleSeekEnd();}}
            onTouchStart={e=>{handleSeekStart(e);}}
            onTouchMove={e=>{if(dragging)handleSeek(e);}}
            onTouchEnd={handleSeekEnd}>
            {/* Buffered bar — реально загруженная часть трека */}
            <div style={{position:"absolute",left:0,top:0,height:"100%",
              width:(buffered*100)+"%",
              background:accent+"33",
              borderRadius:2,transition:"width 0.5s linear"}}/>
            {/* Playback progress bar */}
            <div style={{position:"absolute",left:0,top:0,height:"100%",
              width:(progress*100)+"%",
              background:`linear-gradient(90deg,${accent},${accent2})`,
              borderRadius:2}}/>
            {/* Thumb */}
            <div style={{position:"absolute",top:"50%",left:(progress*100)+"%",
              transform:"translate(-50%,-50%)",
              width:dragging?18:12,height:dragging?18:12,
              borderRadius:"50%",background:accent,
              boxShadow:`0 0 8px ${accent}88`,
              transition:dragging?"none":"width 0.15s,height 0.15s",
              pointerEvents:"none"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
            <span style={{color:text2,fontSize:11}}>{fmt(currentTime)}</span>
            <span style={{color:text2,fontSize:11}}>{fmt(duration)}</span>
          </div>
        </div>

        {/* Main controls */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-evenly",
          padding:"8px 16px 16px"}}>
          <button onClick={()=>audio.setShuffle(!shuffle)}
            style={{width:44,height:44,borderRadius:"50%",border:"none",cursor:"pointer",
              background:shuffle?accent+"22":"none",
              color:shuffle?accent:text2,fontSize:20,
              display:"flex",alignItems:"center",justifyContent:"center"}}>🔀</button>
          <button onClick={()=>audio.prev()}
            style={{width:52,height:52,borderRadius:"50%",border:"none",cursor:"pointer",
              background:surface2,color:text,fontSize:22,
              display:"flex",alignItems:"center",justifyContent:"center"}}>⏮</button>
          <button onClick={()=>playing?audio.pause():audio.play()}
            style={{width:68,height:68,borderRadius:"50%",border:"none",cursor:"pointer",
              background:`linear-gradient(135deg,${accent},${accent2})`,
              color:"#fff",fontSize:28,
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:`0 6px 24px ${accent}55`}}>
            {playing?"⏸":"▶"}
          </button>
          <button onClick={()=>audio.next()}
            style={{width:52,height:52,borderRadius:"50%",border:"none",cursor:"pointer",
              background:surface2,color:text,fontSize:22,
              display:"flex",alignItems:"center",justifyContent:"center"}}>⏭</button>
          <button onClick={nextRepeat}
            style={{width:44,height:44,borderRadius:"50%",border:"none",cursor:"pointer",
              background:repeatActive?accent+"22":"none",
              color:repeatActive?accent:text2,fontSize:20,
              display:"flex",alignItems:"center",justifyContent:"center",
              position:"relative"}}>
            {repeatIcon}
            {repeat==="one"&&<span style={{position:"absolute",bottom:2,fontSize:8,color:accent,fontWeight:800}}>1</span>}
          </button>
        </div>

        {/* Speed controls */}
        <div style={{padding:"0 24px 16px"}}>
          <div style={{color:text2,fontSize:11,fontWeight:600,marginBottom:8,textTransform:"uppercase",letterSpacing:0.5}}>Скорость</div>
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
            {[0.5,0.75,1,1.25,1.5,1.75,2].map(s=>(
              <button key={s} onClick={()=>audio.setSpeed(s)}
                style={{flexShrink:0,padding:"6px 12px",borderRadius:20,border:`1.5px solid ${speed===s?accent:border}`,
                  cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,
                  background:speed===s?accent+"22":"none",
                  color:speed===s?accent:text2,transition:"all 0.2s"}}>
                {formatSpeed(s)}
              </button>
            ))}
          </div>
        </div>

        {/* Queue */}
        <div style={{padding:"0 24px"}}>
          <button onClick={()=>setShowQueue(q=>!q)}
            style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"12px 0",background:"none",border:"none",cursor:"pointer",
              borderTop:`1px solid ${border}`,fontFamily:"inherit"}}>
            <div style={{color:text,fontWeight:700,fontSize:14}}>
              📋 Очередь ({queue.length} {queue.length===1?"трек":queue.length<5?"трека":"треков"})
            </div>
            <div style={{color:text2,fontSize:14,transform:showQueue?"rotate(180deg)":"none",transition:"transform 0.25s"}}>▼</div>
          </button>
          {showQueue&&(
            <QueueList queue={queue} idx={idx} playing={playing} accent={accent} accent2={accent2} surface2={surface2} text={text} text2={text2} border={border} audio={audio}/>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Chat Screen ──────────────────────────────────────────────────────────────
function ChatScreen({isActive=true,chat,currentUser,profile,onBack,onViewProfile,showToast,wallpaperId,msgFontSize=14,chats=[]}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[msgs,setMsgs]=useState([]);
  const[msgsReady,setMsgsReady]=useState(false); // true после первой загрузки — убирает "Напишите первым!" во время загрузки
  const[loadingOlder,setLoadingOlder]=useState(false);
  const[hasOlder,setHasOlder]=useState(true);
  const oldestDocRef=useRef(null);
  const[inputText,setInputText]=useState("");
  const[hasText,setHasText]=useState(false);
  const[replyTo,setReplyTo]=useState(null);
  const[recording,setRecording]=useState(false);
  const[recSec,setRecSec]=useState(0);
  const[recCircle,setRecCircle]=useState(false);
  const[usersCache,setUsersCache]=useState({});
  const[showAddMembers,setShowAddMembers]=useState(false);
  const[showEmoji,setShowEmoji]=useState(false);
  const[showAttach,setShowAttach]=useState(false);
  // Запоминаем, была ли открыта клавиатура в момент открытия панели эмодзи.
  // Используется, чтобы при закрытии эмодзи вернуть клавиатуру (как в WhatsApp/Telegram).
  const[kbWasOpen,setKbWasOpen]=useState(false);
  const[chatData,setChatData]=useState(chat);
  const[typingUsers,setTypingUsers]=useState([]);
  const typingSeenRef=useRef({}); // uid -> {ts, until}: реагируем на ИЗМЕНЕНИЕ метки, а не на разницу часов устройств
  const typingHideRef=useRef(null);
  const[uploading,setUploading]=useState(false);
  const[ctxMsg,setCtxMsg]=useState(null);
  const[showMembers,setShowMembers]=useState(false);
  const[editMsg,setEditMsg]=useState(null);
  const[showChatMenu,setShowChatMenu]=useState(false);
  const[showChatInfo,setShowChatInfo]=useState(false);
  const[showChatSettings,setShowChatSettings]=useState(false);
  const[isMuted,setIsMuted]=useState(()=>!!getS("mute_"+chat.id));
  useEffect(()=>{
    syncPushPreferences(currentUser?.uid).catch(()=>{});
  },[currentUser?.uid,isMuted]);
  const[pinnedMsg,setPinnedMsg]=useState(null);
  const[partnerPhoto,setPartnerPhoto]=useState(null);
  const[showSearch,setShowSearch]=useState(false);
  const[forwardMsg,setForwardMsg]=useState(null);
  const bottomRef=useRef(),timerRef=useRef(),mediaRef=useRef(),voiceStreamRef=useRef(null),chunksRef=useRef([]),inputRef=useRef(),lastCntRef=useRef(0),fileRef=useRef(),lpVoiceRef=useRef(null),galleryRef=useRef(null),localSendingRef=useRef({}),quickRecordStartedRef=useRef(false);

  // ── Свайп назад (как в TG) ──────────────────────────────────────────────────
  const[online,setOnline]=useState(navigator.onLine);
  useEffect(()=>{
    const up=()=>setOnline(true);
    const dn=()=>setOnline(false);
    window.addEventListener("online",up);
    window.addEventListener("offline",dn);
    return()=>{window.removeEventListener("online",up);window.removeEventListener("offline",dn);};
  },[]);

  const lpActiveRef=useRef(false);
  // Флаг: пользователь у низа чата (последние ~5 сообщений)
  const isNearBottomRef=useRef(true);
  // Счётчик новых сообщений пока пользователь не у низа
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(()=>{
    const vv=window.visualViewport;
    if(!vv)return;
    const onResize=()=>{
      const el=msgsRef.current;
      if(!el)return;
      // НЕ пересчитываем isNearBottomRef здесь — onScroll уже выставил его
      // корректно в момент когда пользователь реально прокручивал. После
      // открытия клавиатуры layout viewport уменьшается, что искусственно
      // увеличивало dist и ломало флаг (баг: новое сообщение приходило, но
      // мессенджер думал что пользователь не у низа, и не пролистывал).
      // Если пользователь был у низа — просто докручиваем до низа, чтобы
      // последнее сообщение оставалось видимым над клавиатурой.
      if(isNearBottomRef.current){
        requestAnimationFrame(()=>{
          el.style.scrollBehavior="smooth";
          el.scrollTop=el.scrollHeight+99999;
          setTimeout(()=>{if(el)el.style.scrollBehavior="auto";},260);
        });
      }
    };
    vv.addEventListener("resize",onResize);
    return()=>vv.removeEventListener("resize",onResize);
  },[]);

  // ── Presence: сообщаем серверу что мы в этом чате → сервер не шлёт FCM ──────
  // Дизайн: на сервере presence хранится с временной меткой (TTL 25 сек).
  // Клиент шлёт heartbeat каждые 15 сек пока чат открыт и приложение в
  // foreground. Если приложение свернули — heartbeat останавливаем и шлём
  // leaveChat через sendBeacon (это работает даже когда WebView вот-вот
  // заморозят). Даже если sendBeacon не дойдёт — presence на сервере
  // протухнет за 25 сек и FCM пойдёт нормально.
  useEffect(()=>{
    if(!currentUser?.uid||!chat?.id)return;

    const presenceUrl = "";
    const uid = currentUser.uid;
    const userRef = doc(db,"users",uid);
    const updatePresence = (chatId, active) => {
      updateDoc(userRef,{
        activeChatId: active ? (chatId||chat.id) : "",
        appActive: !!active,
        activeAtMs: Date.now(),
        activeAt: serverTimestamp()
      }).catch(()=>{});
    };

    const sendPresence = (chatId) => {
      updatePresence(chatId, !!chatId);
      if(!presenceUrl)return;
      // keepalive позволяет fetch'у пережить переход страницы/сворачивание
      fetch(presenceUrl,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({uid, chatId}),
        keepalive: true,
      }).catch(()=>{});
    };
    // sendBeacon — самый надёжный способ доставить запрос при сворачивании /
    // закрытии приложения; браузер/WebView гарантирует отправку в фоне.
    const sendPresenceBeacon = (chatId) => {
      updatePresence(chatId, !!chatId);
      if(!presenceUrl)return;
      try{
        if(navigator.sendBeacon){
          const blob = new Blob([JSON.stringify({uid, chatId})], {type:"application/json"});
          if(navigator.sendBeacon(presenceUrl, blob)) return;
        }
      }catch(e){}
      // Fallback на keepalive-fetch.
      sendPresence(chatId);
    };

    const enterChat = () => {
      _activeChatId = chat.id;
      sendPresence(chat.id);
    };
    const leaveChat = () => {
      _activeChatId = null;
      sendPresenceBeacon("");
    };

    // Входим в чат
    enterChat();

    // Heartbeat: пока приложение в foreground и чат открыт, обновляем presence
    // каждые 15 сек. Сервер считает presence несвежим через 25 сек — heartbeat
    // не даёт ему протухнуть.
    const heartbeatId = setInterval(()=>{
      if(document.visibilityState==="visible"){
        sendPresence(chat.id);
      }
    }, 15_000);

    // Visibility — браузерный/PWA путь сворачивания.
    const onVisibility=()=>{
      if(document.visibilityState==="hidden") leaveChat();
      else if(document.visibilityState==="visible") enterChat();
    };
    document.addEventListener("visibilitychange",onVisibility);

    // Capacitor App appStateChange — на нативном Android это надёжнее, чем
    // visibilitychange (последний может не успеть отработать до заморозки).
    let capHandle = null;
    try{
      const CapApp = window?.Capacitor?.Plugins?.App;
      if(CapApp?.addListener){
        CapApp.addListener("appStateChange", ({isActive})=>{
          if(isActive) enterChat();
          else leaveChat();
        }).then(h=>{capHandle=h;}).catch(()=>{});
      }
    }catch(e){}

    // Pagehide — последний шанс отправить leaveChat при полном закрытии.
    const onPagehide = () => leaveChat();
    window.addEventListener("pagehide", onPagehide);

    // Выходим из чата (размонтирование или смена чата)
    return()=>{
      clearInterval(heartbeatId);
      document.removeEventListener("visibilitychange",onVisibility);
      window.removeEventListener("pagehide",onPagehide);
      try{capHandle&&capHandle.remove&&capHandle.remove();}catch(e){}
      leaveChat();
    };
  },[currentUser?.uid,chat?.id]);

  // Сбрасываем непрочитанные при открытии чата
  useEffect(()=>{
    if(!currentUser?.uid||!chat?.id)return;
    updateDoc(doc(db,"chats",chat.id),{
      [`unreadBy.${currentUser.uid}`]:0
    }).catch(()=>{});
    // Баг #7 — убираем уведомления когда чат открыт
    try{
      if(window.Capacitor?.isNativePlatform()) PushNotifications.removeAllDeliveredNotifications().catch(()=>{});
    }catch(e){}
  },[chat.id,currentUser.uid]);

  // Загружаем данные собеседника + онлайн статус (реальный)
  const [partnerData,setPartnerData]=useState(null);
  useEffect(()=>{
    if(chat.type==="direct"&&chat.names){
      const partnerUid=Object.keys(chat.names).find(k=>k!==currentUser.uid);
      if(partnerUid){
        // Fallback: при оффлайн пытаемся достать фото из локального архива.
        if(!navigator.onLine){
          OfflineStore.getChatMeta(chat.id).then(meta=>{
            if(meta&&meta.partnerPhoto) setPartnerPhoto(meta.partnerPhoto);
          }).catch(()=>{});
        }
        // Подписываемся в реальном времени — lastSeen обновляется каждые 30 сек
        const unsub=onSnapshot(doc(db,"users",partnerUid),s=>{
          if(s.exists()){
            const d=s.data();
            setPartnerPhoto(d.photo||null);
            setPartnerData(d);
          }
        });
        return unsub;
      }
    }
  },[chat.id]);

  // fix4: имя/фото собеседника всегда с точки зрения ТЕКУЩЕГО пользователя,
  // а не создателя чата (раньше в шапке мог показываться свой же профиль).
  const partnerUid=(chat.type==="direct"||chatData.type==="direct")
    ?(Object.keys(chatData.names||{}).find(k=>k!==currentUser.uid)
      ||(Array.isArray(chatData.members)?chatData.members.find(m=>m!==currentUser.uid):null))
    :null;
  const headerName=partnerUid
    ?((partnerData&&partnerData.name)||(chatData.names||{})[partnerUid]||chatData.name)
    :chatData.name;
  const headerPhoto=partnerUid
    ?bestPhoto(partnerPhoto,(chatData.photos||{})[partnerUid],chatData._partnerPhoto)
    :(chatData.photo||null);

  useEffect(()=>{return onSnapshot(doc(db,"chats",chat.id),s=>{
    if(s.exists()){
      const d=s.data();
      setChatData(prev=>({...prev,...d}));
      if(d.pinnedMsg)setPinnedMsg(d.pinnedMsg);else setPinnedMsg(null);
      // «Печатает…» без сравнения часов двух телефонов: считаем активным пока метка МЕНЯЕТСЯ
      // (отправитель обновляет её каждые 2.5с), и ещё 6с после последнего изменения.
      const typing=d.typing||{};
      const nowL=Date.now();
      Object.entries(typing).forEach(([u,ts])=>{
        if(u===currentUser.uid)return;
        if(!ts){delete typingSeenRef.current[u];return;}
        const seen=typingSeenRef.current[u];
        if(!seen||seen.ts!==ts)typingSeenRef.current[u]={ts,until:nowL+6000};
      });
      const evalTyping=()=>{
        const now2=Date.now();
        Object.entries(typingSeenRef.current).forEach(([u,v])=>{if(v.until<=now2)delete typingSeenRef.current[u];});
        const act=Object.keys(typingSeenRef.current).map(u=>(d.names?.[u])||"");
        setTypingUsers(act);
      };
      evalTyping();
      clearTimeout(typingHideRef.current);
      typingHideRef.current=setTimeout(evalTyping,6200);
    }
  });},[chat.id,currentUser.uid]);

  // ─── Scroll management ────────────────────────────────────────────────────
  // useLayoutEffect = срабатывает ПОСЛЕ мутации DOM, ДО отрисовки браузером.
  // Скролл происходит невидимо для пользователя — никаких прыжков.

  const msgsRef=useRef(null);
  const prevMsgCount=useRef(0);
  // Якорь: захватываем до prepend, восстанавливаем до отрисовки
  const scrollAnchorRef=useRef(null);
  // Первый onSnapshot должен всегда прокрутить вниз
  const firestoreFirstLoad=useRef(true);
  // Явный сигнал «прокрутить вниз мгновенно» — надёжнее чем prevMsgCount===0
  const shouldScrollBottomRef=useRef(false);
  // Firestore уже ответил → не даём кэшу перезаписать свежие данные
  const firestoreLoadedRef=useRef(false);
  // Синхронная блокировка двойной загрузки старых сообщений (ref, не state)
  const loadingOlderRef=useRef(false);

  useLayoutEffect(()=>{
    const el=msgsRef.current;
    if(!el)return;

    // Приоритет 1: восстановление якоря после prepend (подгрузка старых сообщений)
    // Высота DOM выросла → компенсируем разницу, позиция для пользователя не меняется
    if(scrollAnchorRef.current){
      const{prevHeight,prevTop}=scrollAnchorRef.current;
      el.style.scrollBehavior='auto';
      el.scrollTop=prevTop+(el.scrollHeight-prevHeight);
      scrollAnchorRef.current=null;
      return;
    }

    // Приоритет 2: явный сигнал «прокрутить вниз мгновенно»
    // Устанавливается при первом открытии чата, загрузке кэша и первом onSnapshot
    if(shouldScrollBottomRef.current){
      el.style.scrollBehavior='auto';
      el.scrollTop=el.scrollHeight+99999;
      shouldScrollBottomRef.current=false;
      isNearBottomRef.current=true;
      prevMsgCount.current=msgs.length;
      return;
    }

    if(msgs.length===0)return;

    // Приоритет 3: новое сообщение в реальном времени → скролл только если у дна
    if(msgs.length>prevMsgCount.current&&isNearBottomRef.current){
      el.style.scrollBehavior='auto';
      el.scrollTop=el.scrollHeight+99999;
    }
    prevMsgCount.current=msgs.length;
  }); // без deps — срабатывает на каждый рендер ДО отрисовки браузером (нет flash)

  useEffect(()=>{
    // Полный сброс при смене чата
    prevMsgCount.current=0;
    firestoreFirstLoad.current=true;
    firestoreLoadedRef.current=false;
    shouldScrollBottomRef.current=false;
    scrollAnchorRef.current=null;
    loadingOlderRef.current=false;
    lastCntRef.current=0;
    setMsgsReady(false);
    setMsgs([]);

    let cancelled=false; // защита от гонки при быстрой смене чата

    // Кэш из SQLite — показываем мгновенно, только если Firestore ещё не ответил.
    // В оффлайн-режиме дополнительно подмешиваем локальный архив (OfflineStore).
    (async()=>{
      let cached=[];
      try{cached=await getMsgs(chat.id)||[];}catch(e){cached=[];}
      if(cancelled||firestoreLoadedRef.current)return; // чат сменился / Firestore ответил

      if(!navigator.onLine){
        // Оффлайн: объединяем авто-кэш и архив оффлайн-сохранения
        let archived=[];
        try{archived=await OfflineStore.getChat(chat.id)||[];}catch(e){archived=[];}
        // Подгружаем метаданные чата (в т.ч. фото собеседника) из локального архива.
        try{
          const meta=await OfflineStore.getChatMeta(chat.id);
          if(meta&&meta.partnerPhoto) setPartnerPhoto(meta.partnerPhoto);
        }catch(e){}
        if(cancelled||firestoreLoadedRef.current)return;
        const byId=new Map();
        // сначала кэш, затем архив — архив имеет приоритет (полнее)
        cached.forEach(m=>{if(m&&m.id)byId.set(m.id,m);});
        archived.forEach(m=>{if(m&&m.id)byId.set(m.id,m);});
        const merged=Array.from(byId.values()).sort((a,b)=>{
          const ta=a.unixMs||(a.createdAt?.seconds?a.createdAt.seconds*1000:0)||0;
          const tb=b.unixMs||(b.createdAt?.seconds?b.createdAt.seconds*1000:0)||0;
          return ta-tb;
        });
        if(merged.length>0){
          shouldScrollBottomRef.current=true;
          setMsgs(merged);
        }
        setMsgsReady(true); // оффлайн — других источников не будет
      } else {
        if(cached.length>0&&!firestoreLoadedRef.current){
          shouldScrollBottomRef.current=true; // прокрутим вниз без анимации
          setMsgs(cached);
          setMsgsReady(true);
        }
      }
    })();

    oldestDocRef.current=null;
    setHasOlder(true);

    if(!navigator.onLine)return()=>{cancelled=true;};

    const q=query(collection(db,"chats",chat.id,"messages"),orderBy("createdAt","asc"),limitToLast(20));
    let unsub;
    try{
      unsub=onSnapshot(q,snap=>{
        if(snap.docs.length>0)oldestDocRef.current=snap.docs[0];
        if(snap.docs.length<20)setHasOlder(false);
        const list=snap.docs.map(d=>({id:d.id,...d.data()}));

        const isFirstLoad=firestoreFirstLoad.current;
        if(isFirstLoad){
          // Первый ответ от Firestore — блокируем кэш и требуем прокрутку вниз
          firestoreFirstLoad.current=false;
          firestoreLoadedRef.current=true;
          shouldScrollBottomRef.current=true;
          setMsgsReady(true);
        } else {
          // Реальное новое сообщение
          if(list.length>lastCntRef.current&&lastCntRef.current>0){
            const l=list[list.length-1];
            if(l.uid!==currentUser.uid){
              playSound("msg");
              // Прокручиваем вниз только если пользователь у дна
              if(isNearBottomRef.current){
                shouldScrollBottomRef.current=true;
              } else {
                // Не у дна — увеличиваем счётчик и показываем кнопку
                setNewMsgCount(c=>c+1);
                setShowScrollBtn(true);
              }
            } else {
              // Подтверждение своего сообщения — всегда в дно
              shouldScrollBottomRef.current=true;
            }
          }
        }

        lastCntRef.current=list.length;
        const locals=Object.values(localSendingRef.current||{});
        setMsgs(locals.length?[...list,...locals]:list);
        list.forEach(m=>saveMsg({...m,chatId:chat.id}));
        // Оффлайн-архив: режим "Всегда" — сохраняем каждое полученное сообщение
        try{
          if(getOfflineSettings().mode==="always"){
            OfflineStore.saveChat(chat.id,list,{
              name:chatData?.name||chat?.name||"",
              type:chatData?.type||chat?.type||"direct",
              partnerPhoto:chatData?.partnerPhoto||chat?._partnerPhoto||"",
            }).catch(()=>{});
          }
        }catch(e){}
        // Сообщения от других, ещё не помеченные мной как прочитанные.
        // Пока чат открыт, помечаем их readBy И сразу обнуляем счётчик
        // непрочитанных на уровне чата — иначе в списке чатов остаётся
        // зависший счётчик с сообщений, прочитанных вживую.
        const _hidden=(typeof document!=="undefined"&&document.visibilityState!=="visible")||isActiveRef.current===false;const _unreadAll=list.filter(m=>m.uid!==currentUser.uid&&!m.readBy?.includes(currentUser.uid));unreadRef.current=_hidden?_unreadAll:[];const unreadFromOthers=_hidden?[]:_unreadAll;
        if(unreadFromOthers.length>0){
          const _prv=JSON.parse(localStorage.getItem("rmg_s")||"{}");
          if(_prv.readReceipts!==false)unreadFromOthers.forEach(m=>updateDoc(doc(db,"chats",chat.id,"messages",m.id),{
            readBy:arrayUnion(currentUser.uid)
          }).catch(()=>{}));
          // Сброс счётчика непрочитанных у меня на уровне чата
          updateDoc(doc(db,"chats",chat.id),{
            [`unreadBy.${currentUser.uid}`]:0
          }).catch(()=>{});
        }
        [...new Set(list.map(m=>m.uid).filter(Boolean))].forEach(async uid=>{
          if(!usersCache[uid]){const s=await getDoc(doc(db,"users",uid));if(s.exists())setUsersCache(c=>({...c,[uid]:s.data()}));}
        });
      },err=>{
        console.log("Firestore offline, using SQLite cache");
      });
    }catch(e){}
    return()=>{cancelled=true;unsub?.();};
  },[chat.id,online]);

  // Загрузка старых сообщений при скролле вверх
  const loadOlderMsgs=async()=>{
    // loadingOlderRef — синхронная блокировка (в отличие от state-флага)
    if(loadingOlderRef.current||!hasOlder||!oldestDocRef.current)return;
    loadingOlderRef.current=true;
    setLoadingOlder(true);
    try{
      const q=query(
        collection(db,"chats",chat.id,"messages"),
        orderBy("createdAt","asc"),
        endBefore(oldestDocRef.current),
        limitToLast(15)
      );
      const snap=await getDocs(q);
      if(snap.docs.length===0){
        setHasOlder(false);
        return;
      }
      oldestDocRef.current=snap.docs[0];
      if(snap.docs.length<15)setHasOlder(false);
      const older=snap.docs.map(d=>({id:d.id,...d.data()}));
      // Захватываем якорь ДО setMsgs — useLayoutEffect восстановит позицию до отрисовки
      // Это критично: без этого при prepend страница прыгнет вверх
      const el=msgsRef.current;
      if(el){
        scrollAnchorRef.current={
          prevHeight:el.scrollHeight,
          prevTop:el.scrollTop,
        };
      }
      setMsgs(prev=>[...older,...prev]);
      older.forEach(m=>saveMsg({...m,chatId:chat.id}));
    }catch(e){
      console.error("loadOlder error:",e);
      scrollAnchorRef.current=null; // сброс якоря при ошибке — не ломаем скролл
    }finally{
      loadingOlderRef.current=false;
      setLoadingOlder(false);
    }
  };

  const sendMsg=async(extra)=>{
    const now = new Date();
    const tempId = "tmp_"+Date.now();
    const payload={author:profile?.name||currentUser.displayName||"?",uid:currentUser.uid,time:timeNow(),createdAt:serverTimestamp(),...extra};
    const replyBase=payload._replyTo||replyTo;
    delete payload._replyTo;
    if(replyBase)payload.replyTo={
      id:replyBase.id,author:replyBase.author,uid:replyBase.uid,type:replyBase.type,
      text:replyBase.text||replyBase.fileName||"",
      fileName:replyBase.fileName||"",fileType:replyBase.fileType||"",
      fileUrl:replyBase.fileUrl||"",fileData:replyBase.fileData||"",
      audioUrl:replyBase.audioUrl||"",audioData:replyBase.audioData||"",
      videoUrl:replyBase.videoUrl||"",videoData:replyBase.videoData||"",
      videoThumb:replyBase.videoThumb||"",duration:replyBase.duration||""
    };
    setReplyTo(null);

    // ── Оптимистичное сообщение — появляется мгновенно ──
    const optimistic={...payload,id:tempId,createdAt:{toDate:()=>now,seconds:now.getTime()/1000},_pending:true};
    setMsgs(prev=>[...prev,optimistic]);
    saveMsg({...optimistic,chatId:chat.id});

    try{
      const ref = await addDoc(collection(db,"chats",chat.id,"messages"),payload);
      // Заменяем временное на реальное (onSnapshot тоже придёт, но ключ совпадёт)
      setMsgs(prev=>prev.map(m=>m.id===tempId?{...m,id:ref.id,_pending:false}:m));
      const preview=extra.type==="text"?extra.text:extra.type==="voice"?"🎙 Голосовое":extra.type==="circle"?"⭕ Кружок":extra.type==="sticker"?extra.text:extra.type==="image"?"🖼 Фото":extra.type==="video"?"🎬 Видео":extra.type==="audio"?"🎵 "+(extra.fileName||"Аудио"):extra.type==="file"?(extra.fileType?.startsWith("image/")?"🖼 Фото":"📎 "+extra.fileName):"";
      const allMembers=chatData?.names?Object.keys(chatData.names):chatData?.members||chat?.members||[];
      // Атомарно увеличиваем unreadBy для каждого участника кроме отправителя.
      // increment(1) гарантирует корректный подсчёт даже при одновременной отправке
      // и избегает race condition со stale данными в chatData.
      const unreadUpdate={};
      allMembers.filter(uid=>uid!==currentUser.uid).forEach(uid=>{
        unreadUpdate[`unreadBy.${uid}`]=increment(1);
      });
      updateDoc(doc(db,"chats",chat.id),{
        lastMsg:preview,lastTime:timeNow(),lastTimeMs:Date.now(),lastSender:profile?.name||"",
        ...unreadUpdate,
        ...(allMembers.length>0?{members:allMembers}:{})
      }).catch(()=>{});

      // Push is sent by Firebase Cloud Function on message create.
      return ref.id;


    }catch(e){
      console.error("sendMsg error:",e);
      // Убираем если ошибка
      setMsgs(prev=>prev.filter(m=>m.id!==tempId));
      return null;
    }
  };

  // ── Анимация полёта сообщения из инпута (как в TG) ─────────────────────────
  const saveToFavorites=async(msg)=>{
    try{
      const favId=`favorites_${currentUser.uid}`;
      const favRef=doc(db,"chats",favId);
      const snap=await getDoc(favRef);
      if(!snap.exists()){
        await setDoc(favRef,{id:favId,type:"favorites",name:"Избранное",members:[currentUser.uid],creatorUid:currentUser.uid,created:serverTimestamp(),lastMsg:"",lastTime:"",lastTimeMs:0,photo:null});
      }
      const saved={
        author:msg.author||profile?.name||currentUser.displayName||"?",
        uid:currentUser.uid,
        type:msg.type||"text",
        text:msg.text||"",
        fileUrl:msg.fileUrl||"",fileData:msg.fileData||"",fileName:msg.fileName||"",fileType:msg.fileType||"",fileSize:msg.fileSize||0,
        audioUrl:msg.audioUrl||"",audioData:msg.audioData||"",videoUrl:msg.videoUrl||"",videoData:msg.videoData||"",videoThumb:msg.videoThumb||"",
        waveform:msg.waveform||[],duration:msg.duration||"",
        savedFrom:{chatId:chat.id,msgId:msg.id,author:msg.author||""},
        createdAt:serverTimestamp(),time:timeNow(),saved:true,
      };
      await addDoc(collection(db,"chats",favId,"messages"),saved);
      const preview=saved.type==="text"?saved.text:saved.type==="image"?"Фото":saved.type==="video"?"Видео":saved.type==="audio"?"Аудио":saved.type==="voice"?"Голосовое":saved.type==="circle"?"Кружок":"Файл";
      await updateDoc(favRef,{lastMsg:"⭐ "+preview,lastTime:timeNow(),lastTimeMs:Date.now(),members:[currentUser.uid]});
      showToast?.({msg:"Сохранено в Избранное",type:"ok"});
    }catch(e){console.error("saveToFavorites",e);showToast?.({msg:"Не удалось сохранить",type:"err"});}
  };

  const flyMsg=(text)=>{
    if(getS("bubbleAnim")===false)return;
    const inputEl=inputRef.current;
    if(!inputEl)return;
    const msgsEl=msgsRef.current;
    if(!msgsEl)return;

    const inputRect=inputEl.getBoundingClientRect();
    const msgsRect=msgsEl.getBoundingClientRect();

    // Создаём летящий клон
    const fly=document.createElement("div");
    fly.textContent=text;
    fly.style.cssText=`
      position:fixed;
      right:${window.innerWidth-inputRect.right+8}px;
      top:${inputRect.top}px;
      background:linear-gradient(135deg,#E53935,#B71C1C);
      color:#fff;
      padding:9px 13px;
      border-radius:20px 20px 4px 20px;
      font-size:14px;
      line-height:1.55;
      max-width:72vw;
      word-break:break-word;
      box-shadow:0 3px 14px rgba(229,57,53,0.4);
      z-index:9999;
      pointer-events:none;
      opacity:1;
      transform-origin:bottom right;
      transform:scale(1);
      transition:none;
      will-change:transform,top,opacity;
    `;
    document.body.appendChild(fly);

    const flyRect=fly.getBoundingClientRect();
    // Целевая позиция — нижняя часть списка сообщений
    const targetTop=msgsRect.bottom-flyRect.height-16;
    const dy=targetTop-inputRect.top;

    requestAnimationFrame(()=>{
      fly.style.transition=`top 0.32s cubic-bezier(0.22,0.61,0.36,1), opacity 0.28s ease, transform 0.32s cubic-bezier(0.22,0.61,0.36,1)`;
      fly.style.top=`${targetTop}px`;
      fly.style.opacity="0";
      fly.style.transform="scale(0.88)";
      setTimeout(()=>fly.remove(),350);
    });
  };

  // Само-лечение: если старое «Удалить чат» выкинуло участника из members — возвращаем его
  useEffect(()=>{
    try{
      if(chatData?.type==="direct"&&chatData?.names){
        const need=Object.keys(chatData.names);
        const have=Array.isArray(chatData.members)?chatData.members:[];
        if(need.length>have.length)updateDoc(doc(db,"chats",chat.id),{members:need}).catch(()=>{});
      }
    }catch(e){}
  },[chat.id,chatData?.members?.length]);
  const typingTsRef=useRef(0);const typingClearRef=useRef(null);
  // fix10: "prochitano" only when chat is actually open and app visible
  const isActiveRef=useRef(true);isActiveRef.current=isActive!==false;
  const unreadRef=useRef([]);const markReadRef=useRef(null);
  markReadRef.current=()=>{
    try{
      if(typeof document!=="undefined"&&document.visibilityState!=="visible")return;
      if(isActiveRef.current===false)return;
      const pending=unreadRef.current||[];if(pending.length===0)return;
      unreadRef.current=[];
      const _prv=JSON.parse(localStorage.getItem("rmg_s")||"{}");
      if(_prv.readReceipts!==false)pending.forEach(m=>updateDoc(doc(db,"chats",chat.id,"messages",m.id),{readBy:arrayUnion(currentUser.uid)}).catch(()=>{}));
      updateDoc(doc(db,"chats",chat.id),{[`unreadBy.${currentUser.uid}`]:0}).catch(()=>{});
    }catch(e){}
  };
  useEffect(()=>{
    const onVis=()=>{if(document.visibilityState==="visible"&&markReadRef.current)markReadRef.current();};
    document.addEventListener("visibilitychange",onVis);
    return()=>document.removeEventListener("visibilitychange",onVis);
  },[]);
  useEffect(()=>{
    if(isActive!==false&&markReadRef.current)markReadRef.current();
  },[isActive]);
  const clearTyping=()=>{
    typingTsRef.current=0;
    clearTimeout(typingClearRef.current);
    updateDoc(doc(db,"chats",chat.id),{[`typing.${currentUser.uid}`]:null}).catch(()=>{});
  };
  const publishTyping=()=>{
    try{
      const s=JSON.parse(localStorage.getItem("rmg_s")||"{}");
      if(s.showTyping===false)return;
      const now=Date.now();
      if(now-typingTsRef.current>2500){
        typingTsRef.current=now;
        updateDoc(doc(db,"chats",chat.id),{[`typing.${currentUser.uid}`]:now}).catch(()=>{});
      }
      clearTimeout(typingClearRef.current);
      typingClearRef.current=setTimeout(()=>{clearTyping();},3200);
    }catch(e){}
  };
  useEffect(()=>()=>{try{clearTimeout(typingClearRef.current);clearTimeout(typingHideRef.current);updateDoc(doc(db,"chats",chat.id),{[`typing.${currentUser.uid}`]:null}).catch(()=>{});}catch(e){}},[chat.id]);
  const handleSend=async()=>{
    clearTyping();
    const txt=(inputRef.current?.value||"").trim()||inputText.trim();
    if(!txt)return;
    haptic(12);

    // Запускаем полёт ДО очистки инпута
    flyMsg(txt);

    if(inputRef.current){inputRef.current.value="";requestAnimationFrame(()=>{if(inputRef.current)inputRef.current.focus();});}
    setInputText("");setHasText(false);

    // ── Режим редактирования ─────────────────────────────────────────────
    if(editMsg){
      try{
        await updateDoc(doc(db,"chats",chat.id,"messages",editMsg.id),{text:txt,edited:true});
        updateMsgText(editMsg.id,chat.id,txt);
        setMsgs(prev=>prev.map(m=>m.id===editMsg.id?{...m,text:txt,edited:true}:m));
      }catch(e){console.error("Edit error:",e);}
      setEditMsg(null);
      return;
    }

    sendMsg({type:"text",text:txt});
    playSound("sent");
  };

  // Upload file to Firebase Storage for larger files
  const handleFile=async(e)=>{
    const files=Array.from(e.target.files||[]);if(!files.length)return;
    const MAX=2*1024*1024*1024; // 2GB
    setShowAttach(false);
    for(const file of files){
    if(file.size>MAX){alert(`Файл ${file.name} слишком большой (макс 2ГБ)`);continue;}

    const isAudio=file.type.startsWith("audio/")||/\.(mp3|m4a|aac|wav|ogg|flac|opus|m4b|wma|aiff|ape)$/i.test(file.name);
    const isImage=file.type.startsWith("image/");
    const isVideo=file.type.startsWith("video/");
    const folder=isImage?"photos":isAudio?"music":isVideo?"videos":"files";
    const ext=file.name.split(".").pop()||"bin";

    // ✅ Все файлы — через Go сервер (Telegram). Firebase Storage не используем — ненадёжен.
    setUploading("0%");
    const contentType=file.type||"application/octet-stream";
    const msgType=isImage?"image":isAudio?"audio":isVideo?"video":"file";
    try{
      const fileUrl=await serverUpload(file,pct=>setUploading(pct+"%"));
      const videoThumb=isVideo?await createVideoPoster(file):"";
      await sendMsg({type:msgType,fileName:file.name,fileType:contentType,fileSize:file.size,fileUrl,...(videoThumb?{videoThumb}:{} )});
      playSound("sent");
    }catch(err){
      console.error("Upload error:",err.message);
      alert("Ошибка загрузки: "+err.message);
    }finally{
      setUploading(false);
    }
    }
    e.target.value="";
  };

  const addLocalSending=(msg)=>{
    localSendingRef.current={...localSendingRef.current,[msg.id]:msg};
    setMsgs(prev=>[...prev,msg]);
  };
  const updateLocalSending=(id,patch)=>{
    localSendingRef.current={...localSendingRef.current,[id]:{...(localSendingRef.current[id]||{}),...patch}};
    setMsgs(prev=>prev.map(m=>m.id===id?{...m,...patch}:m));
  };
  const removeLocalSending=(id)=>{
    const next={...localSendingRef.current};
    delete next[id];
    localSendingRef.current=next;
    setMsgs(prev=>prev.filter(m=>m.id!==id));
  };

  const handleFileWithProgress=async(e)=>{
    const files=Array.from(e.target.files||[]);
    if(!files.length)return;
    const MAX=2*1024*1024*1024;
    setShowAttach(false);
    const replySnap=replyTo;
    for(const file of files){
      if(file.size>MAX){alert(`Файл ${file.name} слишком большой (макс 2ГБ)`);continue;}
      const isAudio=file.type.startsWith("audio/")||/\.(mp3|m4a|aac|wav|ogg|flac|opus|m4b|wma|aiff|ape)$/i.test(file.name);
      const isImage=file.type.startsWith("image/");
      const isVideo=file.type.startsWith("video/");
      const contentType=file.type||"application/octet-stream";
      const msgType=isImage?"image":isAudio?"audio":isVideo?"video":"file";
      const localId="local_file_"+Date.now()+"_"+Math.random().toString(36).slice(2,7);
      const localUrl=URL.createObjectURL(file);
      let videoThumb="";
      try{if(isVideo)videoThumb=await createVideoPoster(file);}catch{}
      addLocalSending({
        id:localId,
        author:profile?.name||currentUser.displayName||"?",
        uid:currentUser.uid,
        type:msgType,
        fileName:file.name,
        fileType:contentType,
        fileSize:file.size,
        fileUrl:localUrl,
        ...(videoThumb?{videoThumb}:{}),
        ...(replySnap?{replyTo:replySnap}:{}),
        time:timeNow(),
        createdAt:{toDate:()=>new Date(),seconds:Date.now()/1000},
        _pending:true,
        _uploading:true,
        _uploadPct:3,
      });
      try{
        const fileUrl=await serverUpload(file,pct=>updateLocalSending(localId,{_uploadPct:pct||3}));
        const finalMsg={type:msgType,fileName:file.name,fileType:contentType,fileSize:file.size,fileUrl,...(videoThumb?{videoThumb}:{}),...(replySnap?{_replyTo:replySnap}:{} )};
        removeLocalSending(localId);
        const realId=await sendMsg(finalMsg);
        if(realId){
          const offlineMsg={...finalMsg,id:realId,author:profile?.name||currentUser.displayName||"?",uid:currentUser.uid,time:timeNow(),createdAt:{seconds:Math.floor(Date.now()/1000)}};
          await OfflineStore.saveLocalFile(chat.id,offlineMsg,file);
          await OfflineStore.saveChat(chat.id,[offlineMsg],{
            name:chatData?.name||chat?.name||"",
            type:chatData?.type||chat?.type||"direct",
            partnerPhoto:chatData?.partnerPhoto||chat?._partnerPhoto||"",
          });
        }
        playSound("sent");
      }catch(err){
        removeLocalSending(localId);
        console.error("Upload error:",err?.message||err);
        alert("Ошибка загрузки: "+(err?.message||err));
      }finally{
        setTimeout(()=>URL.revokeObjectURL(localUrl),60000);
      }
    }
    e.target.value="";
  };

  const startVoice=async()=>{
    setShowAttach(false);setShowEmoji(false);setKbWasOpen(false);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:1},sampleRate:{ideal:48000},sampleSize:{ideal:16}}});voiceStreamRef.current=stream;
      const voiceMime=MediaRecorder.isTypeSupported("audio/webm;codecs=opus")?"audio/webm;codecs=opus":"audio/webm";
      const mr=new MediaRecorder(stream,{mimeType:voiceMime,audioBitsPerSecond:192000});mediaRef.current=mr;chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=async()=>{
        // Отпускаем микрофон с задержкой ~0.8с, чтобы хвост записи не обрезался
        setTimeout(()=>{try{stream.getTracks().forEach(t=>t.stop());}catch(e2){}if(voiceStreamRef.current===stream)voiceStreamRef.current=null;},800);
        const blob=new Blob(chunksRef.current,{type:voiceMime});
        const wf=Array.from({length:28},()=>Math.floor(Math.random()*22)+4);
        const dur=`0:${String(recSec).padStart(2,"0")}`;
        const localId="local_voice_"+Date.now();
        const localUrl=URL.createObjectURL(blob);
        addLocalSending({id:localId,author:profile?.name||currentUser.displayName||"?",uid:currentUser.uid,type:"voice",duration:dur,waveform:wf,audioUrl:localUrl,time:timeNow(),createdAt:{toDate:()=>new Date(),seconds:Date.now()/1000},_pending:true,_uploading:true,_uploadPct:8});
        try{
          const storageRef=sRef(storage,`voices/${currentUser.uid}/${Date.now()}.webm`);
          const task=uploadBytesResumable(storageRef,blob,{contentType:voiceMime});
          await new Promise((res,rej)=>task.on("state_changed",snap=>{
            if(snap.totalBytes)updateLocalSending(localId,{_uploadPct:Math.round((snap.bytesTransferred/snap.totalBytes)*100)});
          },rej,res));
          const audioUrl=await getDownloadURL(storageRef);
          removeLocalSending(localId);
          sendMsg({type:"voice",duration:dur,waveform:wf,audioUrl});
        }catch(e){
          const r=new FileReader();r.onloadend=()=>{removeLocalSending(localId);sendMsg({type:"voice",duration:dur,waveform:wf,audioData:r.result});URL.revokeObjectURL(localUrl);};r.readAsDataURL(blob);
        }
        setTimeout(()=>URL.revokeObjectURL(localUrl),60000);
        playSound("sent");
      };
      mr.start(1000);setRecording(true);setRecSec(0);
      timerRef.current=setInterval(()=>setRecSec(s=>s+1),1000);
    }catch(e){alert("Нет доступа к микрофону");}
  };
  const stopVoice=()=>{if(mediaRef.current?.state==="recording")mediaRef.current.stop();setRecording(false);setRecSec(0);clearInterval(timerRef.current);};

  const[circleStream,setCircleStream]=useState(null);
  const[msgSearch,setMsgSearch]=useState("");
  const[showMsgSearch,setShowMsgSearch]=useState(false);
  const[fwdMsg,setFwdMsg]=useState(null); // message to forward
  const[voiceHolding,setVoiceHolding]=useState(false);
  const[quickMode,setQuickMode]=useState("voice");
  const[circleFs,setCircleFs]=useState(null); // fullscreen circle src
  const[lightbox,setLightbox]=useState(null);
  const[facingMode,setFacingMode]=useState("user");
  const circlePreviewRef=useRef(null);

  // Устанавливаем srcObject один раз когда stream появляется — без мерцания
  useEffect(()=>{
    const v=circlePreviewRef.current;
    if(!v)return;
    if(circleStream){
      if(v.srcObject!==circleStream){
        v.srcObject=circleStream;
        v.muted=true;
        v.play().catch(()=>{});
      }
    }else{
      v.srcObject=null;
    }
  },[circleStream]);

  const startCircle=async(facing="user")=>{
    setShowAttach(false);setShowEmoji(false);setKbWasOpen(false);
    try{inputRef.current?.blur();}catch(e2){} // кружок большой — клавиатуру прячем
    try{
      const stream=await navigator.mediaDevices.getUserMedia({
        video:{facingMode:facing,width:{ideal:720},height:{ideal:720},frameRate:{ideal:30,max:30}},
        audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:1},sampleRate:{ideal:48000},sampleSize:{ideal:16}}
      });
      setCircleStream(stream);setFacingMode(facing);
      if(circlePreviewRef.current){
        circlePreviewRef.current.srcObject=stream;
        circlePreviewRef.current.muted=true;
        circlePreviewRef.current.play().catch(()=>{});
      }
      const mimeType=MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")?"video/webm;codecs=vp9,opus":MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")?"video/webm;codecs=vp8,opus":"video/webm";
      const mr=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:4200000,audioBitsPerSecond:192000});mediaRef.current=mr;chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=async()=>{
        stream.getTracks().forEach(t=>t.stop());setCircleStream(null);
        const blob=new Blob(chunksRef.current,{type:mimeType});
        const localId="local_circle_"+Date.now();
        const localUrl=URL.createObjectURL(blob);
        try{
          const circleFile=new File([blob],`circle_${Date.now()}.webm`,{type:mimeType});
          const videoThumb=await createVideoPoster(circleFile);
          addLocalSending({id:localId,author:profile?.name||currentUser.displayName||"?",uid:currentUser.uid,type:"circle",duration:`0:${String(recSec).padStart(2,"0")}`,videoUrl:localUrl,...(videoThumb?{videoThumb}:{}),time:timeNow(),createdAt:{toDate:()=>new Date(),seconds:Date.now()/1000},_pending:true,_uploading:true,_uploadPct:8});
          const videoUrl=await serverUpload(circleFile,pct=>updateLocalSending(localId,{_uploadPct:pct||8}));
          removeLocalSending(localId);
          sendMsg({type:"circle",duration:`0:${String(recSec).padStart(2,"0")}`,videoUrl,...(videoThumb?{videoThumb}:{} )});
          playSound("sent");
        }catch(err){
          // Fallback: base64 (только для совсем маленьких кружков)
          try{
            const reader=new FileReader();
            await new Promise(res=>{reader.onloadend=res;reader.readAsDataURL(blob);});
            removeLocalSending(localId);
            sendMsg({type:"circle",duration:`0:${String(recSec).padStart(2,"0")}`,videoData:reader.result});
            playSound("sent");
          }catch(e2){
            removeLocalSending(localId);
            alert("Ошибка кружка: "+err.message);
          }
        }
        setTimeout(()=>URL.revokeObjectURL(localUrl),60000);
      };
      mr.start(1000);setRecCircle(true);setRecSec(0);
      timerRef.current=setInterval(()=>setRecSec(s=>s+1),1000);
      setTimeout(()=>{if(mr.state==="recording"){mr.stop();setRecCircle(false);setRecSec(0);clearInterval(timerRef.current);}},120000);
    }catch(e){alert("Нет доступа к камере: "+e.message);}
  };
  const stopCircle=()=>{if(mediaRef.current?.state==="recording")mediaRef.current.stop();setRecCircle(false);setRecSec(0);clearInterval(timerRef.current);};
  const cancelCircle=()=>{
    if(mediaRef.current?.state==="recording"){mediaRef.current.ondataavailable=null;mediaRef.current.onstop=null;mediaRef.current.stop();}try{voiceStreamRef.current?.getTracks().forEach(t=>t.stop());}catch(e2){}voiceStreamRef.current=null;
    circleStream?.getTracks().forEach(t=>t.stop());setCircleStream(null);
    setRecCircle(false);setRecSec(0);clearInterval(timerRef.current);chunksRef.current=[];
  };
  const flipCamera=()=>{cancelCircle();setTimeout(()=>startCircle(facingMode==="user"?"environment":"user"),300);};
  const startQuickRecord=()=>quickMode==="voice"?startVoice():startCircle("user");

  if(!chatData)return null;
  const isChannel=chatData.type==="channel";
  const isGroup=chatData.type==="group";
  const canWrite=!isChannel||chatData.creatorUid===currentUser.uid;
  const canManage=(isGroup||isChannel)&&(chatData.creatorUid===currentUser.uid||(chatData.admins||[]).includes(currentUser.uid));
  const openChatHeader=()=>{
    if(isGroup||isChannel){setShowChatInfo(true);return;}
    onViewProfile(partnerUid||Object.keys(chatData.names||{}).find(k=>k!==currentUser.uid)||chatData.uid);
  };

  // ── Логика открытия/закрытия панели эмодзи в стиле WhatsApp/Telegram ──
  // При открытии: запоминаем, открыта ли клавиатура, и закрываем её.
  // При закрытии: если клавиатура была открыта — возвращаем фокус инпуту.
  const openEmojiPanel=()=>{
    const inp=inputRef.current;
    const wasFocused=!!(inp&&typeof document!=="undefined"&&document.activeElement===inp);
    setKbWasOpen(wasFocused);
    if(wasFocused){
      try{inp.blur();}catch{}
    }
    setShowAttach(false);
    setShowEmoji(true);
  };
  const closeEmojiPanel=()=>{
    const shouldRestoreKb=kbWasOpen;
    setShowEmoji(false);
    setKbWasOpen(false);
    if(shouldRestoreKb){
      // На iOS programmatic focus() работает надёжно только в рамках
      // user-gesture (синхронно в обработчике клика). setTimeout ломает контекст,
      // поэтому фокусируем синхронно.
      try{inputRef.current?.focus({preventScroll:true});}catch{
        try{inputRef.current?.focus();}catch{}
      }
    }
  };
  // Закрытие при тапе мимо панели/инпута (вызывается из chat root и messages)
  const closeOverlaysOutside=()=>{
    setShowAttach(false);
    if(showEmoji)closeEmojiPanel();
  };

  useEffect(()=>{
    _chatBackHandler=()=>{
      if(lightbox){setLightbox(null);return true;}
      if(circleFs){setCircleFs(null);return true;}
      if(showChatInfo){setShowChatInfo(false);return true;}
      if(showChatSettings){setShowChatSettings(false);return true;}
      if(showAddMembers){setShowAddMembers(false);return true;}
      if(showMembers){setShowMembers(false);return true;}
      if(showSearch){setShowSearch(false);return true;}
      if(fwdMsg){setFwdMsg(null);return true;}
      if(ctxMsg){setCtxMsg(null);return true;}
      if(showChatMenu){setShowChatMenu(false);return true;}
      if(showAttach){setShowAttach(false);return true;}
      if(showEmoji){closeEmojiPanel();return true;}
      if(replyTo){setReplyTo(null);return true;}
      if(editMsg){setEditMsg(null);setInputText("");return true;}
      if(recording){
        if(mediaRef.current?.state==="recording"){mediaRef.current.ondataavailable=null;mediaRef.current.onstop=null;mediaRef.current.stop();}try{voiceStreamRef.current?.getTracks().forEach(t=>t.stop());}catch(e2){}voiceStreamRef.current=null;
        setRecording(false);setRecSec(0);clearInterval(timerRef.current);return true;
      }
      if(recCircle){cancelCircle();return true;}
      return false;
    };
    return()=>{if(_chatBackHandler)_chatBackHandler=null;};
  },[lightbox,circleFs,showChatInfo,showChatSettings,showAddMembers,showMembers,showSearch,fwdMsg,ctxMsg,showChatMenu,showAttach,showEmoji,replyTo,editMsg,recording,recCircle,closeEmojiPanel]);

  return(
    <div
      style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:bg||"#0E0E0E",display:"flex",flexDirection:"column",zIndex:100,
        animation:"pageSlideIn 0.28s cubic-bezier(0.25,0.46,0.45,0.94)"
      }} onClick={closeOverlaysOutside}>        {/* Pinned Message */}
        {!online&&<OfflineBar/>}
        {pinnedMsg&&<PinnedBar msg={pinnedMsg} canPin={canManage} onUnpin={()=>updateDoc(doc(db,"chats",chat.id),{pinnedMsg:null}).catch(()=>{})}/>}
        {/* Header */}
        <div style={{paddingTop:online?"max(env(safe-area-inset-top,28px),28px)":9,paddingLeft:13,paddingRight:13,paddingBottom:9,background:surface||"#1C1C1E",borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:11,flexShrink:0,boxShadow:"0 1px 6px rgba(0,0,0,0.18)"}} onClick={e=>e.stopPropagation()}>
          <button onClick={onBack} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
          <Avatar name={headerName} size={38} photo={headerPhoto} onClick={openChatHeader}/>
          <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={openChatHeader}>
            <div style={{color:text,fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{isChannel?"📢 ":isGroup?"🫂 ":""}{headerName}</div>
            <div style={{color:(typingUsers.length>0&&getS("showTyping")!==false)?"#4CAF50":text2,fontSize:11,marginTop:1}}>
              {(typingUsers.length>0&&getS("showTyping")!==false)
                ? <span style={{animation:"pulse 1s infinite"}}>✏️ {typingUsers.join(", ")} печатает...</span>
                : isChannel?"канал"
                : isGroup?`${chatData.members?.length||1} участников`
                : (()=>{
                    if(!partnerData)return "личный чат";
                    // Собеседник скрыл онлайн
                    if((typingUsers.length>0&&getS("showTyping")!==false))return <span style={{color:accent,fontWeight:600}}>печатает…</span>;
                    const theirSettings=JSON.parse(localStorage.getItem("rmg_s_"+partnerData.uid)||"{}");
                    const showOnline=partnerData.showOnline!==false&&theirSettings.showOnline!==false;
                    const showLastSeen=partnerData.showLastSeen!==false&&theirSettings.showLastSeen!==false;
                    const ls=partnerData.lastSeen;
                    if(!ls)return "личный чат";
                    const t=ls.seconds?ls.seconds*1000:ls.toDate?.()?.getTime?.()??0;
                    const diff=Date.now()-t;
                    const mins=Math.floor(diff/60000);
                    if(showOnline&&mins<2)return <span style={{color:"#4CAF50",fontWeight:600}}>● онлайн</span>;
                    if(!showLastSeen)return "личный чат";
                    if(mins<60)return `был(а) ${mins} мин назад`;
                    const hours=Math.floor(diff/3600000);
                    if(hours<24)return `был(а) ${hours} ч назад`;
                    const d=new Date(t);
                    const days=Math.floor(diff/86400000);
                    if(days<7)return `был(а) ${d.toLocaleDateString("ru",{weekday:"short"})} в ${d.toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"})}`;
                    return `был(а) ${d.toLocaleDateString("ru",{day:"numeric",month:"short"})}`;
                  })()
              }
            </div>
          </div>
          <button onClick={e=>{e.stopPropagation();setShowSearch(true);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:text2,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><IcSearchSm size={16}/></button>
        {(isGroup||isChannel)&&<button onClick={e=>{e.stopPropagation();setShowMembers(true);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:text2,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IcTabDirect size={16}/></button>}
          {canManage&&<button onClick={e=>{e.stopPropagation();setShowAddMembers(true);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:accent,fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IcTabGroups size={16}/></button>}
          <div style={{position:"relative"}}>
            <button onClick={e=>{e.stopPropagation();setShowChatMenu(m=>!m);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:text2,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>⋮</button>
            {showChatMenu&&(<>
              <div style={{position:"fixed",inset:0,zIndex:199}} onClick={()=>setShowChatMenu(false)}/>
              <div style={{position:"absolute",top:42,right:0,background:surface,border:`1px solid ${border}`,borderRadius:14,zIndex:200,minWidth:190,boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}} onClick={e=>e.stopPropagation()}>
                {[
                  {ico:isMuted?<IcSetBell size={18} color="#8e8e93" style={_mi}/>:<IcMute size={18} color="#8e8e93" style={_mi}/>,lbl:isMuted?"Включить звук":"Выключить звук",fn:()=>{const m=!isMuted;setIsMuted(m);setS("mute_"+chat.id,m);setShowChatMenu(false);}},
                  ...(canManage?[{ico:<IcTabSettings size={18} color="#8e8e93" style={_mi}/>,lbl:"Настройки",fn:()=>{setShowChatMenu(false);setShowChatSettings(true);}}]:[]),
                  {ico:<IcTrash size={18} color="#ff5252" style={_mi}/>,lbl:"Удалить чат",red:true,fn:async()=>{
                    if(await appConfirm("Удалить чат у себя?","Удалить")){
                      updateDoc(doc(db,"chats",chat.id),{members:(chatData.members||[]).filter(m=>m!==currentUser.uid)}).catch(()=>{});
                      setShowChatMenu(false);onBack();
                    }
                  }},
                ].map((item,i)=>(
                  <button key={i} onClick={item.fn} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:item.red?"#ff5252":text,fontSize:14}}>
                    <span>{item.ico}</span><span>{item.lbl}</span>
                  </button>
                ))}
              </div>
              </>
            )}
          </div>
        </div>

        {/* Mini Player — appears below chat header */}
        <AudioMiniBar/>

        {/* Messages */}
        <div ref={msgsRef}
          onScroll={e=>{
            const el=e.target;
            const dist=el.scrollHeight-el.scrollTop-el.clientHeight;
            // Строгий порог "у самого низа" ≈ 80px (≈ высота 1 сообщения).
            // Только в этом случае авто-пролистывание при приходе нового
            // сообщения; иначе показываем кнопку "вниз" + счётчик.
            const near=dist<80;
            isNearBottomRef.current=near;
            if(near){
              setShowScrollBtn(false);
              setNewMsgCount(0);
            } else {
              // Как только пользователь хоть немного выше последнего сообщения —
              // показываем кнопку (как в Telegram).
              setShowScrollBtn(true);
            }
            // loadingOlderRef — синхронная проверка, не ждём setState
            if(el.scrollTop<200&&!loadingOlderRef.current)loadOlderMsgs();
          }}
          style={{flex:1,overflowY:"auto",scrollBehavior:"auto",padding:"10px 8px",display:"flex",flexDirection:"column",
          background:wallpaperId&&wallpaperId!=="none"?(WALLPAPERS.find(w=>w.id===wallpaperId)||{}).bg||"none":"none",
          backgroundSize:"auto",
        }} onMouseDown={e=>{const a=document.activeElement;if(a&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"))e.preventDefault();}} onClick={closeOverlaysOutside}>
          {!msgsReady?(
            // Загрузка — тихо ждём, ничего не показываем (нет flash "Напишите первым!")
            <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{width:24,height:24,borderRadius:"50%",border:`3px solid ${accent}33`,borderTopColor:accent,animation:"spin 0.7s linear infinite"}}/>
            </div>
          ):msgs.length===0?(
            <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",opacity:0.35}}>
              <div style={{fontSize:52,marginBottom:10}}>💬</div>
              <div style={{color:text2,fontSize:14}}>Напишите первым!</div>
            </div>
          ):null}
          {msgs.map((m,i)=>{
            if(m.deletedFor?.[currentUser.uid]||m.deletedForAll)return null;
            return <Msg key={m.id||i} msg={{...m,_partnerAllowsReceipts:partnerData?.readReceipts!==false&&getS("readReceipts")!==false}} myUid={currentUser.uid} prevMsg={i>0?msgs[i-1]:null} usersCache={usersCache} chatPhotos={chatData?.photos} idx={i} onAvatarClick={uid=>uid&&onViewProfile(uid)} onReply={msg=>{setReplyTo(msg);inputRef.current?.focus();}} onOpenLightbox={setLightbox} onLongPress={()=>{lpActiveRef.current=true;setCtxMsg(m);}} onLongPressEnd={()=>{setTimeout(()=>lpActiveRef.current=false,500);}} onCircleFs={src=>setCircleFs(src)} msgFontSize={msgFontSize}/>;
          })}
          <div ref={bottomRef}/>
        </div>

        {/* ── Кнопка «Вниз» — как в Telegram ── */}
        {showScrollBtn&&(
          <div style={{position:"absolute",right:14,bottom:canWrite?80:20,zIndex:150,display:"flex",flexDirection:"column",alignItems:"center",gap:4,animation:"popIn 0.22s cubic-bezier(0.34,1.56,0.64,1)"}}>
            {newMsgCount>0&&(
              <div style={{background:accent,color:"#fff",fontSize:11,fontWeight:800,borderRadius:12,padding:"2px 8px",minWidth:24,textAlign:"center",boxShadow:`0 2px 10px ${accent}88`}}>
                {newMsgCount>99?"99+":newMsgCount}
              </div>
            )}
            <button onClick={()=>{
              const el=msgsRef.current;
              if(el){el.style.scrollBehavior="smooth";el.scrollTop=el.scrollHeight+99999;setTimeout(()=>{if(el)el.style.scrollBehavior="auto";},400);}
              setShowScrollBtn(false);setNewMsgCount(0);isNearBottomRef.current=true;
            }} style={{
              width:42,height:42,borderRadius:"50%",
              background:surface,border:`1px solid ${border}`,
              boxShadow:"0 4px 20px rgba(0,0,0,0.45)",
              cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
              color:accent,fontSize:18,WebkitTapHighlightColor:"transparent",
            }}>↓</button>
          </div>
        )}

        {/* Circle recording overlay */}
        {recCircle&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.93)",zIndex:400,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20}}>
            <div style={{position:"relative",width:240,height:240}}>
              <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,borderRadius:"50%",overflow:"hidden",border:`4px solid ${accent}`,boxShadow:`0 0 60px ${accent}66`}}>
                <video ref={circlePreviewRef}
                  autoPlay muted playsInline style={{width:"100%",height:"100%",objectFit:"cover",transform:facingMode==="user"?"scaleX(-1)":"none"}}/>
              </div>
              <svg width={240} height={240} style={{position:"absolute",top:0,left:0,transform:"rotate(-90deg)",pointerEvents:"none"}}>
                <circle cx={120} cy={120} r={114} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={4}/>
                <circle cx={120} cy={120} r={114} fill="none" stroke={accent} strokeWidth={4}
                  strokeDasharray={2*Math.PI*114} strokeDashoffset={2*Math.PI*114*(1-recSec/60)}
                  strokeLinecap="round" style={{transition:"stroke-dashoffset 1s linear"}}/>
              </svg>
              <div style={{position:"absolute",bottom:8,left:"50%",transform:"translateX(-50%)",background:"rgba(0,0,0,0.7)",borderRadius:20,padding:"3px 12px",color:"#fff",fontSize:13,fontWeight:700}}>● {recSec}с</div>
              <button onClick={flipCamera} style={{position:"absolute",top:8,right:8,width:34,height:34,borderRadius:"50%",background:"rgba(0,0,0,0.6)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>🔄</button>
            </div>
            <div style={{display:"flex",gap:12}}>
              <button onClick={stopCircle} style={{padding:"13px 32px",background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:22,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓ Отправить</button>
              <button onClick={cancelCircle} style={{padding:"13px 20px",background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:22,color:"#fff",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>✕ Отмена</button>
            </div>
          </div>
        )}

        {/* Attach panel */}
        {showAttach&&!showEmoji&&(
          <div style={{background:surface,border:`1px solid ${border}`,borderRadius:"18px 18px 0 0",padding:"14px 12px",boxShadow:"0 -6px 24px rgba(0,0,0,0.3)",animation:"slideUp 0.2s ease"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:9}}>
              {[{ico:<IcImage size={24} color={accent} style={_mi}/>,lbl:"Галерея",fn:()=>{if(galleryRef.current){galleryRef.current.click();}}},{ico:<IcFileDoc size={24} color="#f4a231" style={_mi}/>,lbl:"Файл",fn:()=>fileRef.current?.click()},{ico:<IcMusic size={24} color="#9c27b0" style={_mi}/>,lbl:"Музыка",fn:()=>fileRef.current?.click()},{ico:<IcCircleVid size={24} color="#43a047" style={_mi}/>,lbl:"Кружок",fn:startCircle}].map(b=>(
                <button key={b.lbl} onClick={e=>{e.stopPropagation();b.fn();setShowAttach(false);}} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,padding:"11px 6px",background:surface2,border:`1px solid ${border}`,borderRadius:14,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}} onMouseEnter={e=>e.currentTarget.style.background=accent+"22"} onMouseLeave={e=>e.currentTarget.style.background=surface2}>
                  <span style={{fontSize:24}}>{b.ico}</span>
                  <span style={{color:text2,fontSize:11}}>{b.lbl}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        {canWrite?(
          <div style={{padding:"7px 9px",paddingBottom:showEmoji?7:"max(7px,env(safe-area-inset-bottom,7px))",background:surface+"E8",borderTop:`1px solid ${border}`,backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)",flexShrink:0}} onClick={e=>e.stopPropagation()}>
            {!online&&(
              <div style={{textAlign:"center",color:"#ff9800",fontSize:13,padding:"10px 0",fontWeight:600}}>
                🔒 Отправка недоступна (оффлайн режим)
              </div>
            )}
            {online&&editMsg&&(
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"7px 12px",background:surface2,borderLeft:`3px solid ${accent}`,marginBottom:4}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:accent,fontSize:11,fontWeight:700}}>✏️ Редактирование</div>
                  <div style={{color:text2,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{editMsg.text}</div>
                </div>
                <button onClick={()=>{setEditMsg(null);setInputText("");}} style={{background:"none",border:"none",color:text2,fontSize:18,cursor:"pointer"}}>✕</button>
              </div>
            )}
            {online&&replyTo&&<ReplyBar msg={replyTo} onCancel={()=>setReplyTo(null)}/>}
            {online&&uploading&&<div style={{padding:"4px 10px",color:accent,fontSize:12,fontWeight:600}}>⏳ Загрузка {uploading}... подождите</div>}
            {online&&recording&&(
              <div style={{display:"flex",alignItems:"center",gap:9,background:surface2,borderRadius:22,padding:"9px 14px",animation:"fadeIn 0.2s ease"}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:accent,animation:"pulse 1s infinite",flexShrink:0}}/>
                <span style={{color:text2,fontSize:13,flex:1}}>0:{String(recSec).padStart(2,"0")}</span>
                <button onMouseDown={e=>e.preventDefault()} onClick={stopVoice} style={{background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:18,padding:"6px 14px",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓</button>
                <button onMouseDown={e=>e.preventDefault()} onClick={()=>{if(mediaRef.current?.state==="recording"){mediaRef.current.ondataavailable=null;mediaRef.current.onstop=null;mediaRef.current.stop();}try{voiceStreamRef.current?.getTracks().forEach(t=>t.stop());}catch(e2){}voiceStreamRef.current=null;setRecording(false);setRecSec(0);clearInterval(timerRef.current);}} style={{background:"rgba(255,255,255,0.07)",border:"none",borderRadius:18,padding:"6px 10px",color:text2,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
              </div>
            )}
            {online&&(
              <div style={recording?{position:"absolute",left:-10000,top:0,width:10,height:44,opacity:0,overflow:"hidden",pointerEvents:"none"}:{display:"flex",alignItems:"center",gap:7}}>
                <button onClick={e=>{e.stopPropagation();
                  // Если открываем attach — закрываем эмодзи с учётом kbWasOpen
                  if(showEmoji)closeEmojiPanel();
                  setShowAttach(a=>!a);
                }} style={{width:42,height:42,borderRadius:"50%",background:showAttach?accent+"33":surface2,border:`1.5px solid ${showAttach?accent:border}`,cursor:"pointer",fontSize:19,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>📎</button>
                <button onClick={e=>{e.stopPropagation();
                  if(showEmoji)closeEmojiPanel();
                  else openEmojiPanel();
                }} style={{width:42,height:42,borderRadius:"50%",background:showEmoji?accent+"33":surface2,border:`1.5px solid ${showEmoji?accent:border}`,cursor:"pointer",fontSize:19,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>😊</button>
                <input ref={inputRef}
                  defaultValue=""
                  onInput={e=>{
                    const v=e.target.value;
                    setInputText(v);
                    setHasText(v.length>0);
                    if(v)publishTyping();else clearTyping();
                    e.target.scrollLeft=e.target.scrollWidth;
                  }}
                  onCompositionStart={()=>setHasText(true)}
                  onCompositionUpdate={e=>{
                    setHasText(true);
                    setInputText((e.target.value||"")+(e.data||""));
                  }}
                  onCompositionEnd={e=>{
                    const v=e.target.value;
                    setInputText(v);
                    setHasText(v.length>0);
                    e.target.scrollLeft=e.target.scrollWidth;
                  }}
                  onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&getS("enterSend")){e.preventDefault();handleSend();}}}
                  onKeyUp={e=>{
                    const v=e.target.value;
                    setHasText(v.length>0);
                    if(v.length>0)setInputText(v);
                  }}
                  placeholder="Сообщение..."
                  onClick={e=>{
                    e.stopPropagation();
                    // Тап по инпуту — клавиатура откроется естественно через focus.
                    // Эмодзи закрываем без восстановления, т.к. фокус уже идёт на инпут.
                    setShowEmoji(false);
                    setShowAttach(false);
                    setKbWasOpen(false);
                  }}
                  style={{flex:1,background:surface2,border:`1.5px solid ${border}`,borderRadius:22,padding:"11px 15px",color:text,fontSize:14,outline:"none",fontFamily:"inherit",minWidth:0,overflowX:"auto"}}
                  onFocus={e=>e.target.style.borderColor=accent}
                  onBlur={e=>{
                    e.target.style.borderColor=border;
                    const v=e.target.value;
                    setInputText(v);
                    setHasText(v.length>0);
                  }}/>
                {!hasText&&!inputText.trim()&&(
                  <div style={{display:"flex",gap:6}}>
                    <div style={{position:"relative"}}>
                      {voiceHolding&&[0,1,2].map(i=>(
                        <div key={i} style={{position:"absolute",inset:-i*8-4,borderRadius:"50%",
                          border:`1.5px solid ${accent}`,opacity:0.4-i*0.12,
                          animation:`ripple 1.2s ease-out ${i*0.3}s infinite`,pointerEvents:"none"}}/>
                      ))}
                      <button
                        onMouseDown={e=>{e.preventDefault();quickRecordStartedRef.current=false;setVoiceHolding(true);lpVoiceRef.current=setTimeout(()=>{quickRecordStartedRef.current=true;if(navigator.vibrate)navigator.vibrate(40);startQuickRecord();setVoiceHolding(false);},400);}}
                        onMouseUp={()=>{clearTimeout(lpVoiceRef.current);setVoiceHolding(false);}}
                        onTouchStart={e=>{e.preventDefault();quickRecordStartedRef.current=false;setVoiceHolding(true);lpVoiceRef.current=setTimeout(()=>{quickRecordStartedRef.current=true;if(navigator.vibrate)navigator.vibrate(40);startQuickRecord();setVoiceHolding(false);},400);}}
                        onTouchEnd={()=>{clearTimeout(lpVoiceRef.current);setVoiceHolding(false);}}
                        onClick={e=>{e.stopPropagation();if(quickRecordStartedRef.current){quickRecordStartedRef.current=false;return;}setQuickMode(m=>m==="voice"?"circle":"voice");}}
                        style={{width:42,height:42,borderRadius:"50%",
                          background:voiceHolding?accent+"44":surface2,
                          border:`1.5px solid ${voiceHolding?accent:border}`,
                          cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",
                          justifyContent:"center",flexShrink:0,
                          transition:"all 0.15s",WebkitTapHighlightColor:"transparent",
                          transform:voiceHolding?"scale(1.12)":"scale(1)"}}>{quickMode==="voice"?"🎙":"⭕"}</button>
                    </div>
                  </div>
                )}
                {inputText.trim()&&(
                  <button onClick={uploading?undefined:handleSend} onMouseDown={e=>e.preventDefault()} onTouchEnd={e=>{e.preventDefault();if(!uploading)handleSend();}} disabled={!!uploading} style={{width:42,height:42,borderRadius:"50%",background:uploading?surface2:`linear-gradient(135deg,${accent},${accent2})`,border:"none",cursor:uploading?"not-allowed":"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:uploading?"none":`0 3px 12px ${accent}55`,animation:"popIn 0.18s cubic-bezier(0.34,1.56,0.64,1)",opacity:uploading?0.5:1}}
                  onMouseDown={e=>e.preventDefault()}>➤</button>
                )}
              </div>
            )}
          </div>
        ):(
          <div style={{padding:14,background:surface,borderTop:`1px solid ${border}`,textAlign:"center",color:text2,fontSize:13}}>📢 Только администратор может публиковать</div>
        )}

        {/* Emoji panel — РАСПОЛОЖЕНА ПОД ИНПУТОМ (как в WhatsApp/Telegram).
            Всегда смонтирована, чтобы анимация закрытия проигрывалась корректно. */}
        <div onClick={e=>e.stopPropagation()} onMouseDown={e=>{if(showEmoji)e.preventDefault();}} style={showAttach?{display:"none"}:{flexShrink:0}}>
          <EmojiPanel
            open={showEmoji}
            onEmoji={emoji=>{
              const inp=inputRef.current;
              if(!inp){
                // fallback: только state
                setInputText(t=>t+emoji);
                setHasText(true);
                return;
              }
              // Если inputText был выставлен программно (edit-режим), а DOM-инпут пуст —
              // синхронизируем перед вставкой, чтобы не потерять исходный текст.
              if(!inp.value&&inputText){
                inp.value=inputText;
              }
              const cur=inp.value||"";
              // На мобильном при открытой панели эмодзи инпут НЕ сфокусирован
              // (мы намеренно сняли фокус, чтобы закрыть клавиатуру). В этом случае
              // вставляем эмодзи в конец строки и НЕ вызываем focus() — иначе
              // откроется клавиатура и закроет панель эмодзи.
              const isFocused=(typeof document!=="undefined")&&document.activeElement===inp;
              let start,end;
              if(isFocused){
                start=(typeof inp.selectionStart==="number"?inp.selectionStart:cur.length);
                end=(typeof inp.selectionEnd==="number"?inp.selectionEnd:cur.length);
              } else {
                start=end=cur.length;
              }
              const next=cur.slice(0,start)+emoji+cur.slice(end);
              inp.value=next;
              // Восстанавливаем позицию каретки только если инпут уже сфокусирован
              // (десктоп). На мобильном фокус не вызываем.
              if(isFocused){
                try{
                  const pos=start+emoji.length;
                  inp.setSelectionRange(pos,pos);
                }catch{}
              }
              setInputText(next);
              setHasText(next.length>0);
            }}
            onSticker={e=>{sendMsg({type:"sticker",text:e});playSound("sent");closeEmojiPanel();}}
            onClose={()=>closeEmojiPanel()}/>
        </div>

        <input ref={fileRef} type="file" accept="image/*,audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.opus,.pdf,.doc,.docx,.zip,.txt,.xls,.xlsx" onChange={handleFileWithProgress} style={{display:"none"}}/>
        <input ref={galleryRef} type="file" accept="image/*,video/*" multiple onChange={handleFileWithProgress} style={{display:"none"}}/>
        {lightbox&&<Lightbox src={lightbox.src} fileName={lightbox.fileName} fileType={lightbox.fileType} originRect={lightbox.originRect} onClose={()=>setLightbox(null)}/> }
        {/* Circle fullscreen - renders above everything, messages hidden */}
        {circleFs&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.97)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",animation:"circleExpandIn 0.35s cubic-bezier(0.34,1.56,0.64,1)"}} onClick={()=>setCircleFs(null)}>
            <div style={{position:"relative",width:"min(88vw,88vh)",height:"min(88vw,88vh)"}}>
              <div style={{position:"absolute",inset:0,borderRadius:"50%",overflow:"hidden",border:`4px solid ${accent}`,boxShadow:`0 0 80px ${accent}55,0 20px 80px rgba(0,0,0,0.9)`}}>
                <video src={circleFs} controls autoPlay playsInline style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              </div>
              <button onClick={()=>setCircleFs(null)} style={{position:"absolute",top:-10,right:-10,width:36,height:36,borderRadius:"50%",background:"rgba(0,0,0,0.75)",border:"1.5px solid rgba(255,255,255,0.25)",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>✕</button>
            </div>
          </div>
        )}
        {showAddMembers&&<AddMembersModal chat={chatData} currentUser={currentUser} onClose={()=>setShowAddMembers(false)}/>}
        {showChatInfo&&<ChatInfoModal chat={chatData} currentUser={currentUser} onClose={()=>setShowChatInfo(false)} onOpenSettings={()=>{setShowChatInfo(false);setShowChatSettings(true);}}/>}
        {showChatSettings&&<ChatSettingsModal chat={chatData} currentUser={currentUser} onClose={()=>setShowChatSettings(false)} onSaved={patch=>setChatData(c=>({...c,...patch}))}/>}
        {showSearch&&<MsgSearch chatId={chat.id} onClose={()=>setShowSearch(false)} onJump={()=>{}}/> }
      {showMembers&&<GroupMembersModal chat={chatData} currentUser={currentUser} onClose={()=>setShowMembers(false)}/>}
        {/* Forward Modal */}
      {fwdMsg&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:600,display:"flex",flexDirection:"column"}}>
          <div style={{padding:"16px 20px",borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:12}}>
            <button onClick={()=>setFwdMsg(null)} style={{background:"none",border:"none",color:text,fontSize:22,cursor:"pointer"}}>✕</button>
            <div style={{color:text,fontWeight:700,fontSize:16}}>Переслать в...</div>
          </div>
          <div style={{flex:1,overflowY:"auto"}}>
            {chats.map(c=>{
              const name=c.type==="direct"?Object.values(c.names||{}).find(n=>n!==profile?.name)||c.name:c.name;
              return(
                <div key={c.id} onClick={async()=>{
                  try{
                    // Ensure chat doc exists
                    const chatSnap=await getDoc(doc(db,"chats",c.id));
                    if(!chatSnap.exists()){
                      await setDoc(doc(db,"chats",c.id),{
                        ...c,id:c.id,members:[...new Set([...(c.members||[]),currentUser.uid])],
                        createdAt:serverTimestamp()
                      });
                    } else {
                      // Make sure we're in members list (needed for Firestore rules)
                      if(!(c.members||[]).includes(currentUser.uid)){
                        await updateDoc(doc(db,"chats",c.id),{members:arrayUnion(currentUser.uid)});
                      }
                    }
                    const fwdText=fwdMsg.text||"";
                    await addDoc(collection(db,"chats",c.id,"messages"),{
                      author:profile?.name||currentUser.displayName||"?",
                      uid:currentUser.uid,
                      type:fwdMsg.type||"text",
                      text:fwdText,
                      fileUrl:fwdMsg.fileUrl||"",
                      fileData:fwdMsg.fileData||"",
                      fileName:fwdMsg.fileName||"",
                      fileType:fwdMsg.fileType||"",
                      fileSize:fwdMsg.fileSize||0,
                      audioUrl:fwdMsg.audioUrl||"",
                      audioData:fwdMsg.audioData||"",
                      videoUrl:fwdMsg.videoUrl||"",
                      videoData:fwdMsg.videoData||"",
                      waveform:fwdMsg.waveform||[],
                      duration:fwdMsg.duration||"",
                      forwarded:true,
                      forwardedFrom:"", // скрываем от кого
                      createdAt:serverTimestamp(),
                      time:new Date().toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"}),
                    });
                    await updateDoc(doc(db,"chats",c.id),{
                      lastMsg:"↪️ "+profile?.name,
                      lastTime:timeNow(),
                      lastTimeMs:Date.now(),
                      members:arrayUnion(currentUser.uid)
                    });
                    setFwdMsg(null);
                  }catch(e){alert("Ошибка: "+e.message);}
                }}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 20px",cursor:"pointer",borderBottom:`1px solid ${border}`}}
                onTouchStart={e=>e.currentTarget.style.background=surface2}
                onTouchEnd={e=>e.currentTarget.style.background="transparent"}>
                  <Avatar name={name} size={44} photo={c.photo||null}/>
                  <div style={{color:text,fontSize:15,fontWeight:600}}>{name}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {ctxMsg&&<MsgContextMenu msg={ctxMsg} myUid={currentUser.uid} chatId={chat.id} onClose={()=>setCtxMsg(null)} onReply={msg=>{setReplyTo(msg);inputRef.current?.focus();}} onEdit={msg=>{setEditMsg(msg);setInputText(msg.text);setTimeout(()=>inputRef.current?.focus(),100);}} onForward={msg=>setFwdMsg(msg)} onSave={saveToFavorites}/>}
    </div>
  );
}

// ─── Chat List ────────────────────────────────────────────────────────────────
function ChatList({currentUser,profile,onOpen,onFind,onEditProfile,onViewProfile,onChatsLoad,
  themeName,onChangeTheme,wallpaperId,onChangeWallpaper,accentId,onChangeAccent,
  msgFontSize=14,onChangeFontSize,onLogout,online=true}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const CACHE_KEY="rmg_chats_"+currentUser.uid;
  const cachedChats=()=>{try{const c=JSON.parse(localStorage.getItem(CACHE_KEY)||"[]");const h=readHidden("rmg_hidden_chats_"+currentUser.uid);return c.filter(x=>!isHiddenChat(h,x));}catch{return[];}};
  const[chats,setChats]=useState(cachedChats);
  // true после первого ответа Firestore или если кэш уже есть — убирает flash "Нет чатов"
  const[chatsReady,setChatsReady]=useState(()=>cachedChats().length>0);
  const[chatsError,setChatsError]=useState("");
  const[chatsReloadKey,setChatsReloadKey]=useState(0);
  const[search,setSearch]=useState("");
  const[showArchive,setShowArchive]=useState(false);
  const TABS=[
    {id:"all",icon:"💬",label:"Чаты",Ic:IcTabChats},
    {id:"direct",icon:"👤",label:"Личные",Ic:IcTabDirect},
    {id:"contacts",icon:"👥",label:"Контакты",Ic:IcTabContacts},
    {id:"groups",icon:"🫂",label:"Группы",Ic:IcTabGroups},
    {id:"channels",icon:"📢",label:"Каналы",Ic:IcTabChannels},
  ];
  const[tabIdx,setTabIdx]=useState(0);
  const[showSettingsTab,setShowSettingsTab]=useState(false); // вкладка Настройки внутри ChatList
  const[settingsGroup,setSettingsGroup]=useState(null);      // активная группа внутри вкладки (null=главная)

  // Направление перехода между «главная страница» <-> «группа» — для выбора анимации.
  // forward  = открыли группу (новая группа въезжает справа).
  // backward = вернулись на главную (главная въезжает слева).
  const prevSettingsGroupRef=useRef(settingsGroup);
  const showSettingsTabRef=useRef(showSettingsTab);
  const settingsGroupRef=useRef(settingsGroup);
  useEffect(()=>{showSettingsTabRef.current=showSettingsTab;},[showSettingsTab]);
  useEffect(()=>{settingsGroupRef.current=settingsGroup;},[settingsGroup]);
  const settingsDir=(()=>{
    const prev=prevSettingsGroupRef.current;
    if(prev===settingsGroup)return"none";
    if(prev===null&&settingsGroup!==null)return"forward";
    if(prev!==null&&settingsGroup===null)return"backward";
    return"forward"; // group→group (на практике не используется)
  })();
  useEffect(()=>{prevSettingsGroupRef.current=settingsGroup;},[settingsGroup]);

  // ── Регистрация обработчика физической кнопки «Назад» для overlay настроек ──
  // Логика навигации: если открыта группа → сбросить её (вернуться к списку групп);
  // если на главной странице вкладки → закрыть overlay настроек.
  // Само событие «съедается» возвратом true в App back-button handler.
  // Только ChatList пользуется этим ref'ом, поэтому конфликт регистрации невозможен.
  useEffect(()=>{
    if(!showSettingsTab){
      // overlay закрыт — сбрасываем активную группу (на случай быстрого переключения табов)
      if(settingsGroup)setSettingsGroup(null);
      _settingsBackHandler=null;
      return;
    }
    _settingsBackHandler=()=>{
      if(!showSettingsTabRef.current)return false;
      if(settingsGroupRef.current){
        settingsGroupRef.current=null;
        setSettingsGroup(null);
      }else{
        showSettingsTabRef.current=false;
        setShowSettingsTab(false);
      }
      return true;
    };
    return()=>{_settingsBackHandler=null;};
  },[showSettingsTab,settingsGroup]);

  const[swipeOffset,setSwipeOffset]=useState(0);
  const[isSwiping,setIsSwiping]=useState(false);
  const swipeStartX=useRef(0);
  const swipeStartY=useRef(0);
  const swipeIsHoriz=useRef(null); // null=не определено, true=горизонт, false=вертикаль
  const tab=TABS[tabIdx]?.id||"all";
  const[creating,setCreating]=useState(null);
  const[fab,setFab]=useState(false);

  // Кэш фото пользователей для аватарок
  const[photosCache,setPhotosCache]=useState(()=>{try{const m=JSON.parse(localStorage.getItem("mrx_photos")||"{}");Object.keys(m).forEach(k=>{if(typeof m[k]!=="string"||!m[k].startsWith("data:"))delete m[k];});try{localStorage.setItem("mrx_photos",JSON.stringify(m));}catch{}return m;}catch{return{};}});

  useEffect(()=>{
    if(!currentUser?.uid)return;
    const favId=`favorites_${currentUser.uid}`;
    const favRef=doc(db,"chats",favId);
    getDoc(favRef).then(snap=>{
      if(!snap.exists()){
        return setDoc(favRef,{id:favId,type:"favorites",name:"Избранное",members:[currentUser.uid],creatorUid:currentUser.uid,created:serverTimestamp(),lastMsg:"Сохраняйте сюда сообщения",lastTime:"",lastTimeMs:0,photo:null});
      }
    }).catch(()=>{});
  },[currentUser?.uid]);

  // Снапшот lastTime по каждому чату — для оффлайн-режима «Всегда».
  // На первом snapshot Firestore заполняем без сохранения (иначе при каждом запуске
  // приложения шёл бы массовый бэкап). На последующих — догружаем последние сообщения
  // только тех чатов, у которых lastTime реально изменился. Так получается «фоновое»
  // авто-сохранение всех чатов, а не только открытого, без отдельных подписок.
  const lastTimesRef=useRef(null);
  const chatsSeqRef=useRef(0);

  useEffect(()=>{
    const q=query(collection(db,"chats"),where("members","array-contains",currentUser.uid));
    return onSnapshot(q,async snap=>{
      const _seq=++chatsSeqRef.current;
      const list=snap.docs.map(d=>({id:d.id,...d.data()}));
      setChatsError("");

      // ── Защита кэша от затирания при оффлайне ─────────────────────────────
      // Если сети нет и Firestore вернул пустую выборку (или сработал свой
      // внутренний fromCache) — НЕ обнуляем уже показанный список и НЕ
      // переписываем localStorage пустым массивом. Иначе на следующий запуск
      // пользователь увидит «Нет чатов» вместо ранее сохранённых.
      const fromCache=!!(snap.metadata&&snap.metadata.fromCache);
      if(list.length===0&&(!navigator.onLine||fromCache)){
        // оставляем cachedChats() в state, отмечаем готовность чтобы убрать спиннер
        setChatsReady(true);
        return;
      }

      list.sort((a,b)=>{
        // Основная сортировка — по миллисекундному lastTimeMs (числовому).
        // Это решает проблему сортировки строки "HH:MM" через полночь
        // ("00:15" < "23:30" хотя 00:15 на самом деле новее) и проблему
        // несовместимых типов lastTime (string vs Firestore Timestamp).
        const ma=(typeof a.lastTimeMs==="number"&&a.lastTimeMs>0)?a.lastTimeMs:0;
        const mb=(typeof b.lastTimeMs==="number"&&b.lastTimeMs>0)?b.lastTimeMs:0;
        if(ma||mb) return mb-ma; // больший ms (новее) — выше
        // Backward-compat: старые чаты без lastTimeMs сортируем по строке lastTime.
        const ta=a.lastTime||"";const tb=b.lastTime||"";
        if(!ta&&!tb)return 0;if(!ta)return 1;if(!tb)return -1;
        return tb>ta?1:-1;
      });

      // Fetch ALL partner photos — только при наличии сети; иначе используем
      // уже подгруженный `mrx_photos` из localStorage (инициализирован выше).
      if(navigator.onLine){
        const allPartnerUids=[...new Set(
          list.filter(c=>c.type==="direct"&&c.names)
            .flatMap(c=>Object.keys(c.names||{}).filter(uid=>uid!==currentUser.uid))
        )];
        if(allPartnerUids.length>0){
          const fetched={};
          await Promise.all(allPartnerUids.map(async uid=>{
            try{
              const s=await getDoc(doc(db,"users",uid));
              if(s.exists()){fetched[uid]=s.data()?.photo||s.data()?.photoURL||null;}
            }catch{}
          }));
          if(_seq!==chatsSeqRef.current)return;
          setPhotosCache(prev=>{
            const m={...prev};Object.entries(fetched).forEach(([u,v])=>{if(v)m[u]=v;});
            try{localStorage.setItem("mrx_photos",JSON.stringify(m));}catch{}
            return m;
          });
          // Also force chats re-render with photo data
          setChats(prev=>prev.map(c=>{
            if(c.type==="direct"&&c.names){
              const partnerUid=Object.keys(c.names).find(u=>u!==currentUser.uid);
              if(partnerUid&&fetched[partnerUid]!==undefined){
                return {...c,_partnerPhoto:fetched[partnerUid]};
              }
            }
            return c;
          }));
        }
      }

      // Скрытые чаты прячем только пока нет сообщений новее момента удаления
      if(_seq!==chatsSeqRef.current)return;
      const _hidden=readHidden("rmg_hidden_chats_"+(currentUser.uid));
      const filtered=list.filter(c=>!isHiddenChat(_hidden,c));
      setChats(filtered);onChatsLoad?.(filtered);
      setChatsReady(true);
      // Кэш для оффлайн-запуска. Сохраняем ВСЕ чаты (метаданные мизерные),
      // и только если выборка не пустая — пустой массив никогда не пишем.
      if(list.length>0){
        try{localStorage.setItem(CACHE_KEY,JSON.stringify(list));}catch(e){}
        // Дублируем в IndexedDB — на Android WebView это надёжнее, чем localStorage:
        // localStorage может быть очищен системой/обновлением WebView, IndexedDB — нет.
        OfflineStore.saveChatList(currentUser.uid,list).catch(()=>{});
      }

      // ── Авто-сохранение в режиме «Всегда»: отслеживаем lastTime каждого чата.
      // Если у какого-то чата он изменился (или это новый чат) — фоном тянем
      // последние сообщения и сохраняем в OfflineStore. Так покрываются ВСЕ
      // чаты, а не только открытый. Без дополнительных Firestore-подписок.
      try{
        if(navigator.onLine && getOfflineSettings().mode==="always" && list.length>0){
          const prev=lastTimesRef.current;
          // Первый snapshot после монтирования — только заполняем ref, ничего не качаем.
          // Это защита от массового бэкапа при каждом запуске приложения.
          if(prev===null){
            const m={};
            list.forEach(c=>{ m[c.id]=c.lastTime||""; });
            lastTimesRef.current=m;
          }else{
            const changed=[];
            list.forEach(c=>{
              const cur=c.lastTime||"";
              if(cur && cur!==prev[c.id]) changed.push(c);
            });
            if(changed.length>0){
              // Обновляем ref сразу, чтобы повторный snapshot не запускал то же самое.
              const next={...prev};
              list.forEach(c=>{ next[c.id]=c.lastTime||""; });
              lastTimesRef.current=next;

              // Догружаем последние ~30 сообщений в каждом изменившемся чате.
              // 30 — компромисс: покрывает короткие всплески сообщений, но не качает
              // всю историю. Saver сам решит, скачивать ли файлы (по настройкам).
              changed.forEach(c=>{
                (async()=>{
                  try{
                    const snap2=await getDocs(query(
                      collection(db,"chats",c.id,"messages"),
                      orderBy("createdAt","asc"),
                      limitToLast(30)
                    ));
                    const msgs=snap2.docs.map(d=>({id:d.id,...d.data()}));
                    if(msgs.length>0){
                      await OfflineStore.saveChat(c.id,msgs,{
                        name:c.name||c.title||"",
                        type:c.type||"",
                        partnerPhoto:c._partnerPhoto||"",
                      });
                    }
                  }catch(e){
                    console.warn("[offline] auto-save chat failed:",c.id,e?.message||e);
                  }
                })();
              });
            }else{
              // lastTime ни у кого не изменился — просто обновляем ref для новых чатов.
              const next={...prev};
              list.forEach(c=>{ if(!(c.id in next)) next[c.id]=c.lastTime||""; });
              lastTimesRef.current=next;
            }
          }
        }
      }catch(e){
        console.warn("[offline] auto-save dispatch failed:",e?.message||e);
      }
    },error=>{
      console.warn("⚠️ Не удалось загрузить чаты:",error?.message||error);
      setChatsReady(true);
      if(!navigator.onLine){
        setChatsError("Нет подключения к интернету.");
      }else if(error?.status===401||error?.code==="permission-denied"){
        setChatsError("Сессия устарела. Выйди из аккаунта и войди снова.");
      }else{
        setChatsError("Не удалось загрузить чаты с сервера. Повтори попытку.");
      }
    });
  },[currentUser.uid,chatsReloadKey]);

  // ── Оффлайн-гидрация списка чатов из IndexedDB ──────────────────────────────
  // localStorage на Android-WebView ненадёжен: бывает, что после рестарта
  // приложения / обновления WebView ключ `rmg_chats_<uid>` пропадает, и
  // пользователь видит «Нет чатов» без интернета. IndexedDB-копия списка живёт
  // в `mrx_offline_db.chatLists` и переживает такие случаи. Если localStorage
  // пуст — подтягиваем список оттуда асинхронно сразу после монтирования.
  useEffect(()=>{
    if(!currentUser?.uid)return;
    let cancelled=false;
    OfflineStore.getChatList(currentUser.uid).then(list=>{
      if(cancelled||!Array.isArray(list))return;
      if(list.length>0){
        // Применяем фильтр скрытых чатов так же, как onSnapshot.
        const _hidden=readHidden("rmg_hidden_chats_"+(currentUser.uid));
        const filtered=list.filter(c=>!isHiddenChat(_hidden,c));
        // Заменяем state ТОЛЬКО если он пуст — чтобы не затереть свежие данные
        // Firestore, которые уже могли прийти параллельно.
        setChats(prev=>prev.length===0?filtered:prev);
        onChatsLoad?.(filtered);
        setChatsReady(true);
        // Заодно «лечим» localStorage-кэш на будущее.
        try{localStorage.setItem(CACHE_KEY,JSON.stringify(list));}catch{}
      }else if(!navigator.onLine){
        // Полный оффлайн + ни одного источника кэша → выходим из спиннера,
        // чтобы пользователь хотя бы увидел сообщение «Нет чатов».
        setChatsReady(true);
      }
    }).catch(()=>{
      if(!cancelled && !navigator.onLine) setChatsReady(true);
    });
    return()=>{cancelled=true;};
  },[currentUser?.uid]);

  const[ctxChat,setCtxChat]=useState(null);
  const[ctxPos,setCtxPos]=useState({x:0,y:0});

  const openCtx=(c,e)=>{
    e.preventDefault();
    setCtxChat({...c,name:getName(c)});
  };

  const muteChat=async(c)=>{
    const muted=getS("mute_"+c.id);
    setS("mute_"+c.id,muted?0:1);
    syncPushPreferences(currentUser.uid).catch(()=>{});
    setCtxChat(null);
  };

  const deleteChatForEveryone=async(c)=>{
    try{
      // Delete ALL messages
      const msgs=await getDocs(collection(db,"chats",c.id,"messages"));
      await Promise.all(msgs.docs.map(d=>deleteDoc(doc(db,"chats",c.id,"messages",d.id))));
      // Delete chat doc itself
      await deleteDoc(doc(db,"chats",c.id));
      // Remove from local state
      setChats(prev=>prev.filter(ch=>ch.id!==c.id));
    }catch(e){alert("Ошибка: "+e.message);}
    setCtxChat(null);
  };

  const deleteChat=async(c)=>{
    try{
      // Скрываем чат «до нового сообщения» (как в Telegram): запоминаем момент удаления.
      const key="rmg_hidden_chats_"+currentUser.uid;
      const hidden=readHidden(key);
      hidden[c.id]=Date.now();
      localStorage.setItem(key,JSON.stringify(hidden));
      setChats(prev=>prev.filter(ch=>ch.id!==c.id));
      // ВАЖНО: себя из members НЕ удаляем — иначе новые сообщения собеседника не вернут чат.
      // Если members был сломан раньше — чиним его.
      if(c.type==="direct"&&c.names&&(c.members||[]).length<Object.keys(c.names).length){
        updateDoc(doc(db,"chats",c.id),{members:Object.keys(c.names)}).catch(()=>{});
      }
    }catch(e){console.error("deleteChat:",e);}
    setCtxChat(null);
  };

  const clearChatHistory=async(c)=>{
    try{
      const msgs=await getDocs(collection(db,"chats",c.id,"messages"));
      await Promise.all(msgs.docs.map(d=>
        updateDoc(doc(db,"chats",c.id,"messages",d.id),{deletedFor:{[currentUser.uid]:true}})
      ));
    }catch(e){}
    setCtxChat(null);
  };

  const pinChat=async(c)=>{
    const pinned=getS("pin_"+c.id);
    setS("pin_"+c.id,pinned?0:1);
    setCtxChat(null);
  };

  const markRead=async(c)=>{
    try{
      await updateDoc(doc(db,"chats",c.id),{
        [`unreadBy.${currentUser.uid}`]:0
      });
    }catch(e){}
    setCtxChat(null);
  };

  const getName=c=>{if(c.type==="direct"&&c.names){const o=Object.keys(c.names).find(k=>k!==currentUser.uid);return c.names[o]||c.name;}return c.name;};

  const filtered=chats.filter(c=>tab==="all"||(tab==="direct"&&c.type==="direct")||(tab==="groups"&&c.type==="group")||(tab==="channels"&&c.type==="channel")).filter(c=>(getName(c)||"").toLowerCase().includes(search.toLowerCase()));

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",width:"100%",background:bg||"#0A0A0A",position:"relative"}}>
      {/* Жёлтый мини-бар оффлайн-режима — самый верхний элемент */}
      {!online&&<OfflineBar/>}
      {/* ── Top Header ── */}
      <div style={{paddingTop:online?"max(env(safe-area-inset-top,28px),28px)":9,paddingLeft:14,paddingRight:14,paddingBottom:9,background:surface+"EE",borderBottom:`1px solid ${border}`,backdropFilter:"blur(16px)",WebkitBackdropFilter:"blur(16px)",flexShrink:0}}>
        <div style={{position:"relative",display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:9,minHeight:36}}>
          {/* Left: avatar — click opens EditProfile directly */}
          <button onClick={onEditProfile}
            style={{background:"none",border:"none",padding:0,cursor:"pointer",lineHeight:0,borderRadius:"50%",WebkitTapHighlightColor:"transparent"}}
            aria-label="Редактировать профиль">
            <Avatar name={profile?.name||"?"} size={36} photo={profile?.photo}/>
          </button>
          {/* Center: tab title — absolutely positioned, doesn't intercept clicks */}
          <div style={{position:"absolute",left:"50%",top:"50%",transform:"translate(-50%,-50%)",color:text,fontWeight:800,fontSize:20,display:"flex",alignItems:"center",gap:8,pointerEvents:"none",whiteSpace:"nowrap"}}>
            {tab==="all"&&<span>Чаты</span>}
            {tab==="direct"&&<span>Личные</span>}
            {tab==="contacts"&&<span>Контакты</span>}
            {tab==="groups"&&<span>Группы</span>}
            {tab==="channels"&&<span>Каналы</span>}
          </div>
          {/* Right: action buttons */}
          <div style={{display:"flex",gap:7}}>
            <button onClick={onFind} className="rmg-press" style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:accent,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IcSearchSm size={18}/></button>
            <button onClick={()=>{haptic(8);setFab(f=>!f);}} style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.25s",transform:fab?"rotate(45deg)":"none"}}><IcPencilSm size={17}/></button>
          </div>
        </div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск" style={{width:"100%",background:surface2,border:"none",borderRadius:13,padding:"9px 13px",color:text,fontSize:13,transition:"all 0.3s ease",outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
      </div>
      {/* Mini Player — appears below search bar */}
      <AudioMiniBar/>
      <StoriesBar currentUser={currentUser} profile={profile}/>

      {/* ── Вкладка Настройки — отображается поверх списка чатов, НО внутри ChatList (нижний бар виден) ──
          Telegram-style навигация: главная страница — список групп; тап на группу
          открывает её экран. Кнопка ← в шапке и физический Back делают одно и то же:
          если открыта группа — возвращают на главную; иначе — закрывают весь overlay. */}
      {showSettingsTab&&(
        <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,zIndex:50,background:bg,overflowY:"auto",paddingBottom:72,animation:"pageSlideIn 0.25s cubic-bezier(0.25,0.46,0.45,0.94)"}}>
          {/* Жёлтый мини-бар оффлайн-режима — виден и на экране настроек */}
          {!online&&<OfflineBar/>}
          {/* Заголовок настроек — динамический по settingsGroup */}
          <div style={{position:"sticky",top:0,zIndex:5,paddingTop:online?"max(env(safe-area-inset-top,28px),28px)":9,paddingLeft:15,paddingRight:15,paddingBottom:13,background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:13,flexShrink:0,backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>
            <button onClick={()=>{
              if(settingsGroup)setSettingsGroup(null);
              else setShowSettingsTab(false);
            }} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
            <div style={{color:text,fontWeight:700,fontSize:16}}>
              {settingsGroup
                ? SETTINGS_GROUPS_META[settingsGroup].label
                : "Настройки"}
            </div>
          </div>
          {/* Тело — обёрнуто в div с key, чтобы React ремонтировал блок при смене группы.
              direction:forward — новая группа въезжает справа; backward — главная въезжает слева. */}
          <div key={settingsGroup||"__main"} style={{
            animation: settingsDir==="forward"  ? "pageSlideIn 0.26s cubic-bezier(0.25,0.46,0.45,0.94)"
                     : settingsDir==="backward" ? "pageSlideInLeft 0.26s cubic-bezier(0.25,0.46,0.45,0.94)"
                     : "none",
            willChange:"transform,opacity"
          }}>
          {/* Краткая инфа о пользователе — только на главной странице вкладки (settingsGroup === null) */}
          {!settingsGroup&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"28px 16px 20px",background:surface,marginBottom:0,borderBottom:`1px solid ${border}`}}>
              <Avatar name={profile?.name||"?"} size={80} photo={profile?.photo}/>
              <div style={{color:text,fontWeight:800,fontSize:18,marginTop:12}}>{profile?.name||"—"}</div>
              {profile?.tag&&<div style={{color:accent,fontSize:13,marginTop:3}}>@{profile.tag}</div>}
              {profile?.bio&&<div style={{color:text2,fontSize:13,marginTop:6,textAlign:"center",maxWidth:260}}>{profile.bio}</div>}
              <div style={{color:text2,fontSize:11,marginTop:8,opacity:.55}}>Сборка: fix25</div>
            </div>
          )}
          {/* Тело: список групп или содержимое активной группы */}
          <SettingsBody
            currentUser={currentUser}
            profile={profile}
            themeName={themeName} onChangeTheme={onChangeTheme}
            wallpaperId={wallpaperId} onChangeWallpaper={onChangeWallpaper}
            accentId={accentId} onChangeAccent={onChangeAccent}
            msgFontSize={msgFontSize} onChangeFontSize={onChangeFontSize}
            onLogout={onLogout}
            activeGroup={settingsGroup}
            onOpenGroup={setSettingsGroup}
            online={online}
            allChats={chats}
          />
          </div>
        </div>
      )}

      <div style={{flex:1,overflow:"hidden",position:"relative"}}
        onTouchStart={e=>{
          swipeStartX.current=e.touches[0].clientX;
          swipeStartY.current=e.touches[0].clientY;
          swipeIsHoriz.current=null; // ещё не определено
          setIsSwiping(false);setSwipeOffset(0);
        }}
        onTouchMove={e=>{
          const dx=e.touches[0].clientX-swipeStartX.current;
          const dy=e.touches[0].clientY-swipeStartY.current;
          // Определяем направление по первым 10px движения
          if(swipeIsHoriz.current===null&&(Math.abs(dx)>10||Math.abs(dy)>10)){
            swipeIsHoriz.current=Math.abs(dx)>Math.abs(dy)*1.5;
          }
          // Двигаем таб только если явно горизонтальный свайп
          if(swipeIsHoriz.current&&Math.abs(dx)>10){
            setIsSwiping(true);
            setSwipeOffset(dx/window.innerWidth*100);
          }
        }}
        onTouchEnd={e=>{
          const dx=e.changedTouches[0].clientX-swipeStartX.current;
          setIsSwiping(false);setSwipeOffset(0);
          // Засчитываем только намеренный горизонтальный свайп (>70px, угол подтверждён)
          if(swipeIsHoriz.current&&Math.abs(dx)>70){
            if(dx<0&&tabIdx<TABS.length-1)setTabIdx(i=>i+1);
            else if(dx>0&&tabIdx>0)setTabIdx(i=>i-1);
          }
          swipeIsHoriz.current=null;
        }}>
        <div style={{
          display:"flex",height:"100%",
          transform:`translateX(calc(${-tabIdx*100}% + ${swipeOffset}%))`,
          transition:isSwiping?"none":"transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94)"
        }}>
          {TABS.map((tabDef,ti)=>{
            if(tabDef.id==="contacts"){
              return(
                <div key={tabDef.id} style={{minWidth:"100%",height:"100%",overflowY:"auto",paddingBottom:72}}>
                  <ContactsTab currentUser={currentUser} profile={profile} search={search} onOpen={onOpen} onViewProfile={onViewProfile} onFind={onFind}/>
                </div>
              );
            }
            const tabFiltered=chats.filter(c=>{
              const archived=!!getS("archive_"+c.id);
              if(showArchive)return archived;
              if(archived)return false;
              return(tabDef.id==="all")||
                (tabDef.id==="direct"&&(c.type==="direct"||c.type==="favorites"))||
                (tabDef.id==="groups"&&c.type==="group")||
                (tabDef.id==="channels"&&c.type==="channel");
            }).filter(c=>(getName(c)||"").toLowerCase().includes(search.toLowerCase()));
            return(
              <div key={tabDef.id} style={{minWidth:"100%",height:"100%",overflowY:"auto",paddingBottom:72}}>
                {tabFiltered.length===0?(
                  !chatsReady?(
                    <div style={{padding:"6px 0"}}>
                      {[0,1,2,3,4,5,6].map(i=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 15px",opacity:Math.max(0.15,1-i*0.13)}}>
                          <div className="rmg-skel" style={{width:52,height:52,borderRadius:"50%",flexShrink:0}}/>
                          <div style={{flex:1,minWidth:0}}>
                            <div className="rmg-skel" style={{width:`${45+((i*17)%30)}%`,height:13,borderRadius:7,marginBottom:8}}/>
                            <div className="rmg-skel" style={{width:`${58+((i*23)%27)}%`,height:11,borderRadius:6}}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  ):(
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"60%",textAlign:"center"}}>
                      {tabDef.Ic?<tabDef.Ic size={46} color={text2} style={{opacity:0.35,marginBottom:10}}/>:<div style={{fontSize:46,marginBottom:10,opacity:0.3}}>{tabDef.icon}</div>}
                      <div style={{color:text2,fontSize:14}}>{chatsError||"Нет чатов"}</div>
                      {chatsError&&<button onClick={()=>{setChatsReady(false);setChatsError("");setChatsReloadKey(k=>k+1);}} style={{marginTop:12,padding:"8px 14px",borderRadius:10,border:`1px solid ${border}`,background:surface2,color:accent,fontFamily:"inherit",fontWeight:700,cursor:"pointer"}}>Повторить</button>}
                    </div>
                  )
                ):tabFiltered.map((c,i)=>{
                  const name=getName(c);
                  const myUnread=c.unreadBy?.[currentUser.uid]||0;
                  const isNew=myUnread>0;
                  return(
                    <div key={c.id}
                      onClick={()=>onOpen({...c,name})}
                      onContextMenu={e=>{e.preventDefault();openCtx(c,e);}}
                      onTouchStart={e=>{
                        e.currentTarget.style.background=surface2;
                        e.currentTarget._lp=setTimeout(()=>{openCtx(c,e);e.currentTarget.style.background="transparent";},500);
                      }}
                      onTouchEnd={e=>{clearTimeout(e.currentTarget._lp);e.currentTarget.style.background="transparent";}}
                      onTouchMove={e=>{clearTimeout(e.currentTarget._lp);e.currentTarget.style.background="transparent";}}
                      style={{
                        display:"flex",alignItems:"center",gap:12,padding:"11px 14px",
                        cursor:"pointer",transition:"background 0.13s",
                        borderBottom:`1px solid ${border}`,
                        background:isNew?accent+"0D":"transparent",
                        borderLeft:isNew?`3px solid ${accent}`:"3px solid transparent",
                        animation:`listIn 0.2s ease ${Math.min(i*0.04,0.3)}s both`,
                      }}>
                      <div style={{position:"relative"}}>
                        <Avatar name={name} size={52} photo={
                          c.type==="direct"
                            ?(()=>{const p=Object.keys(c.names||c.photos||{}).find(k=>k!==currentUser.uid);return bestPhoto(p&&photosCache[p],p&&(c.photos||{})[p],c._partnerPhoto);})()
                            :(c.photo||c._partnerPhoto||null)
                        }/>
                        {isNew&&(
                          <div style={{
                            position:"absolute",top:-3,right:-3,minWidth:20,height:20,
                            borderRadius:10,background:accent,zIndex:10,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            fontSize:10,fontWeight:800,color:"#fff",padding:"0 5px",
                            border:`2px solid ${bg}`,boxShadow:`0 0 10px ${accent}99`,
                            animation:"pulse 1.5s ease-in-out infinite"
                          }}>{myUnread>99?"99+":myUnread}</div>
                        )}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:3}}>
                          <div style={{color:text,fontWeight:isNew?800:600,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
                            {c.type==="channel"?"📢 ":c.type==="group"?"🫂 ":""}{name}
                          </div>
                          {c.lastTime&&<div style={{color:isNew?accent:text2+"88",fontSize:10,flexShrink:0,marginLeft:7,fontWeight:isNew?700:400}}>{c.lastTime}</div>}
                        </div>
                        <div style={{color:isNew?text:text2,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:isNew?600:400}}>
                          {c.lastMsg||"Нет сообщений"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {/* FAB dropdown */}
      {fab&&(
        <div style={{position:"fixed",bottom:86,right:18,zIndex:200,display:"flex",flexDirection:"column",gap:9,animation:"slideUp 0.2s ease"}}>
          <button onClick={()=>{setFab(false);setCreating("channel");}} style={{display:"flex",alignItems:"center",gap:9,padding:"10px 18px",background:surface,border:`1px solid ${border}`,borderRadius:18,color:text,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",whiteSpace:"nowrap"}}><IcTabChannels size={17} color={accent}/><span>Создать канал</span></button>
          <button onClick={()=>{setFab(false);setCreating("group");}} style={{display:"flex",alignItems:"center",gap:9,padding:"10px 18px",background:surface,border:`1px solid ${border}`,borderRadius:18,color:text,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",whiteSpace:"nowrap"}}><IcTabGroups size={17} color={accent}/><span>Создать группу</span></button>
        </div>
      )}

      {/* ── Bottom Navigation Bar ── */}
      <div style={{position:"absolute",bottom:0,left:0,right:0,background:surface,borderTop:`1px solid ${border}`,zIndex:100,paddingBottom:"env(safe-area-inset-bottom,0px)"}}>
        {/* Tab indicator — учитываем showSettingsTab: индикатор переезжает
            на позицию "Настройки" (последняя вкладка), когда открыты настройки.
            Это устраняет визуальный баг "выделен старый раздел при открытых настройках". */}
        <div style={{position:"relative",height:2,background:"transparent",overflow:"visible"}}>
          <div style={{
            position:"absolute",top:0,height:2,
            width:`${100/(TABS.length+1)}%`,
            left:`${(showSettingsTab?TABS.length:tabIdx)*(100/(TABS.length+1))}%`,
            background:accent,borderRadius:2,
            boxShadow:`0 0 8px ${accent}88`,
            transition:"left 0.32s cubic-bezier(0.25,0.46,0.45,0.94)"
          }}/>
        </div>
        <div style={{display:"flex",alignItems:"center",height:60}}>
          {[...TABS,{id:"settings",icon:"⚙️",label:"Настройки",Ic:IcTabSettings}].map((t,i)=>{
            const isSettings=t.id==="settings";
            const isActive=isSettings?showSettingsTab:(tabIdx===i&&!showSettingsTab);
            return(
              <button key={t.id} className="rmg-press" onClick={()=>{
                haptic(6);
                if(isSettings){setShowSettingsTab(true);}
                else{setShowSettingsTab(false);setTabIdx(i);}
              }}
                style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                  gap:3,background:"none",border:"none",cursor:"pointer",padding:"4px 2px",
                  fontFamily:"inherit"}}>
                <div style={{lineHeight:0,
                  color:isActive?accent:text2,
                  opacity:isActive?1:0.55,
                  transition:"all 0.22s cubic-bezier(0.34,1.56,0.64,1)",
                  transform:isActive?"scale(1.12) translateY(-1px)":"scale(1)"
                }}>{t.Ic?<t.Ic size={23}/>:<span style={{fontSize:22}}>{t.icon}</span>}</div>
                <div style={{fontSize:10,color:isActive?accent:text2,fontWeight:isActive?700:400,transition:"color 0.2s"}}>{t.label}</div>
              </button>
            );
          })}
        </div>
      </div>
      {creating&&<CreateModal type={creating} currentUser={currentUser} profile={profile} onClose={()=>setCreating(null)} onCreated={c=>{setCreating(null);onOpen(c);}}/>}

      {/* ── Chat Context Menu ── */}
      {ctxChat&&(<><div style={{position:"fixed",inset:0,zIndex:149}} onClick={()=>setCtxChat(null)}/>
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:500,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)"}} onClick={()=>setCtxChat(null)}>
          <div style={{position:"fixed",bottom:0,left:0,right:0,background:surface,borderRadius:"22px 22px 0 0",paddingBottom:"max(env(safe-area-inset-bottom,16px),16px)",boxShadow:"0 -8px 40px rgba(0,0,0,0.6)",animation:"slideUp 0.3s cubic-bezier(0.25,0.46,0.45,0.94)"}} onClick={e=>e.stopPropagation()}>
            {/* Handle */}
            <div style={{width:36,height:4,borderRadius:2,background:border,margin:"10px auto 14px"}}/>
            {/* Chat info */}
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"0 18px 14px",borderBottom:`1px solid ${border}`}}>
              <Avatar name={ctxChat.name} size={46} photo={ctxChat.photo||(ctxChat.type==="direct"&&ctxChat.names?photosCache[Object.keys(ctxChat.names).find(k=>k!==currentUser.uid)]:null)}/>
              <div>
                <div style={{color:text,fontWeight:700,fontSize:15}}>{ctxChat.type==="channel"?"📢 ":ctxChat.type==="group"?"🫂 ":""}{ctxChat.name}</div>
                <div style={{color:text2,fontSize:12,marginTop:2}}>{ctxChat.type==="direct"?"Личный чат":ctxChat.type==="group"?"Группа":"Канал"}</div>
              </div>
            </div>
            {/* Actions */}
            {[
              {ico:<IcTabChats size={19} color="#8e8e93" style={_mi}/>,lbl:"Открыть",fn:()=>{onOpen(ctxChat);setCtxChat(null);}},
              {ico:<IcPin size={19} color="#8e8e93" style={_mi}/>,lbl:getS("pin_"+ctxChat.id)?"Открепить":"Закрепить",fn:()=>pinChat(ctxChat)},
              {ico:<IcArchiveBox size={19} color="#8e8e93" style={_mi}/>,lbl:getS("archive_"+ctxChat.id)?"Из архива":"В архив",fn:()=>{setS("archive_"+ctxChat.id,getS("archive_"+ctxChat.id)?0:1);setCtxChat(null);}},
              {ico:getS("mute_"+ctxChat.id)?<IcSetBell size={19} color="#8e8e93" style={_mi}/>:<IcMute size={19} color="#8e8e93" style={_mi}/>,lbl:getS("mute_"+ctxChat.id)?"Включить звук":"Выключить звук",fn:()=>muteChat(ctxChat)},
              {ico:<IcCheckOne size={19} color="#8e8e93" style={_mi}/>,lbl:"Прочитать",fn:()=>markRead(ctxChat)},
              {ico:<IcTrash size={19} color="#ff5252" style={_mi}/>,lbl:"Очистить у себя",red:true,fn:async()=>{if(await appConfirm("Очистить историю этого чата у себя?","Очистить"))clearChatHistory(ctxChat);}},
              {ico:<IcTrashAll size={19} color="#ff5252" style={_mi}/>,lbl:"Удалить у всех",red:true,fn:async()=>{if(await appConfirm("Удалить переписку у всех участников? Это нельзя отменить!","Удалить"))deleteChatForEveryone(ctxChat);}},
              {ico:<IcDoor size={19} color="#ff5252" style={_mi}/>,lbl:ctxChat.type==="direct"?"Удалить чат":"Покинуть",red:true,fn:async()=>{if(await appConfirm(ctxChat.type==="direct"?"Удалить этот чат?":"Покинуть группу?",ctxChat.type==="direct"?"Удалить":"Покинуть"))deleteChat(ctxChat);}},
            ].map((a,i)=>(
              <button key={i} onClick={a.fn} style={{width:"100%",display:"flex",alignItems:"center",gap:16,padding:"14px 20px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",transition:"background 0.15s"}}
                onTouchStart={e=>e.currentTarget.style.background=surface2}
                onTouchEnd={e=>e.currentTarget.style.background="none"}>
                <span style={{fontSize:20,width:28,textAlign:"center"}}>{a.ico}</span>
                <span style={{color:a.red?"#FF3B30":text,fontSize:15,fontWeight:500}}>{a.lbl}</span>
              </button>
            ))}
          </div>
        </div>
      </>
      )}
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────

// ─── UnifiedPush setup ───────────────────────────────────────────────────────
// VAPID public key is loaded from our server. The private half never leaves it.

function openChatFromPush(chatId) {
  if (!chatId) return;
  window.__rmgPendingPushChatId = String(chatId);
  window.dispatchEvent(new CustomEvent("rmg:open-chat", { detail: { chatId: String(chatId) } }));
}

async function setupPush(uid) {
  if (!uid) return;
  pushRegistrationUid = uid;

  try {
    if (!Capacitor.isNativePlatform()) return;
    const config = await api("/push/vapid");
    if (!config?.publicKey) throw new Error("Сервер не вернул VAPID-ключ");
    await PushNotifications.configure({ vapidKey: config.publicKey });

    // Слушатели ставим до register(): дистрибьютор может вернуть сохранённый
    // endpoint сразу после регистрации.
    if (!nativePushListenersReady) {
      await PushNotifications.addListener("registration", async registration => {
        if (!registration?.endpoint || !pushRegistrationUid) return;
        try {
          await serverSaveUnifiedPush(pushRegistrationUid, registration);
          console.log("✅ UnifiedPush-устройство сохранено");
        } catch (e) {
          console.warn("⚠️ Не удалось сохранить UnifiedPush:", e?.message || e);
        }
      });

      await PushNotifications.addListener("registrationError", err => {
        console.warn("⚠️ Ошибка регистрации UnifiedPush:", err?.error || err);
      });

      await PushNotifications.addListener("pushNotificationReceived", notification => {
        const incomingChatId = String(notification?.data?.chatId || "");
        if (incomingChatId && incomingChatId === _activeChatId && notification?.id != null) {
          PushNotifications.removeDeliveredNotifications({
            notifications: [{ id: Number(notification.id) }],
          }).catch(() => {});
        }
      });

      await PushNotifications.addListener("pushNotificationActionPerformed", action => {
        openChatFromPush(action?.notification?.data?.chatId);
      });
      nativePushListenersReady = true;
    }

    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== "granted") {
      console.warn("⚠️ Уведомления не разрешены в Android");
      return;
    }

    await PushNotifications.createChannel({ id: "messages" }).catch(() => {});
    const saved = await PushNotifications.getRegistration().catch(() => null);
    if (saved?.endpoint) await serverSaveUnifiedPush(uid, saved);
    await PushNotifications.register();

    const launch = await PushNotifications.getLaunchData().catch(() => null);
    if (launch?.chatId) openChatFromPush(launch.chatId);
  } catch (e) {
    console.log("UnifiedPush setup error:", e.message);
  }
}


export default function App(){
  const[fbUser,setFbUser]=useState(undefined);
  const[profile,setProfile]=useState(null);
  const[screen,setScreen]=useState("list");
  const[screenAnim,setScreenAnim]=useState("none"); // "toChat" | "toList" | "none"
  const[appChats,setAppChats]=useState([]); // shared chats for forward
  const[activeChat,setActiveChat]=useState(null);
  const[finding,setFinding]=useState(false);
  const[editing,setEditing]=useState(false);
  const[viewProfileUid,setViewProfileUid]=useState(null);
  const[themeName,setThemeName]=useState(()=>{
    const saved=localStorage.getItem("rmg_theme");
    if(saved)return saved;
    // Auto detect system theme
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches?"dark":"light";
  });
  const[wallpaperId,setWallpaperId]=useState(()=>localStorage.getItem("rmg_wallpaper")||"none");
  const[accentId,setAccentId]=useState(()=>localStorage.getItem("rmg_accent")||"");
  const[msgFontSize,setMsgFontSize]=useState(()=>parseInt(localStorage.getItem("rmg_fontsize")||"14"));
  const[toast,setToast]=useState(null);
  const[online,setOnline]=useState(navigator.onLine);
  const[minSplashDone,setMinSplashDone]=useState(false);
  useEffect(()=>{
    const up=()=>setOnline(true);
    const dn=()=>{setOnline(false);setToast({msg:"Нет интернета — режим оффлайн",type:"warn"});}
    window.addEventListener("online",up);
    window.addEventListener("offline",dn);
    return()=>{window.removeEventListener("online",up);window.removeEventListener("offline",dn);};
  },[]);

  // Открытие нужного чата после тапа по Android/PWA-уведомлению.
  const openPushChat = useCallback(async chatId => {
    const id = String(chatId || "");
    if (!id) return;
    if (!fbUser?.uid) {
      window.__rmgPendingPushChatId = id;
      return;
    }

    window.__rmgPendingPushChatId = "";
    let chat = appChats.find(item => item?.id === id) || null;
    if (!chat) {
      try {
        const snap = await getDoc(doc(db, "chats", id));
        if (!snap.exists()) return;
        chat = { id: snap.id, ...snap.data() };
      } catch (e) {
        console.warn("⚠️ Не удалось открыть чат из уведомления:", e?.message || e);
        return;
      }
    }

    setActiveChat(chat);
    setScreenAnim("toChat");
    setScreen("chat");
  }, [appChats, fbUser?.uid]);

  useEffect(() => {
    const onPushOpen = event => {
      const chatId = event?.detail?.chatId || event?.data?.chatId;
      if (chatId) void openPushChat(chatId);
    };
    const onWorkerMessage = event => {
      if (event?.data?.type === "OPEN_CHAT") onPushOpen(event);
    };

    window.addEventListener("rmg:open-chat", onPushOpen);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);

    const url = new URL(window.location.href);
    const chatId = window.__rmgPendingPushChatId || url.searchParams.get("chatId");
    if (chatId && fbUser?.uid) {
      url.searchParams.delete("chatId");
      window.history.replaceState({}, "", url);
      void openPushChat(chatId);
    }

    return () => {
      window.removeEventListener("rmg:open-chat", onPushOpen);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
    };
  }, [fbUser?.uid, openPushChat]);

  // Audio player state is managed by AudioCtxProvider wrapping the whole app
  const baseTheme=THEMES[themeName]||THEMES.dark;
  // Apply custom accent for light/dark themes only
  const theme=useMemo(()=>{
    if(accentId&&["dark","light"].includes(themeName)){
      const acc=ACCENT_COLORS.find(a=>a.id===accentId);
      if(acc)return{...baseTheme,accent:acc.color,accent2:acc.color2};
    }
    return baseTheme;
  },[themeName,accentId]);

  // Refs for back button (always fresh values, no stale closure)
  const screenRef=useRef("list");
  const findingRef=useRef(false);
  const editingRef=useRef(false);
  const viewProfileRef=useRef(null);
  // Init SQLite on mount
  useEffect(()=>{
    initSQLite();
    OfflineStore.init().catch(()=>{});
  },[]);

  // Минимальная длительность заставки — проигрывается даже без интернета
  useEffect(()=>{
    const t=setTimeout(()=>setMinSplashDone(true),950);
    return()=>clearTimeout(t);
  },[]);

  // Аварийный фолбэк: если за 4с авторизация не разрешилась (нет сети и т.п.) —
  // открываем мессенджер из кэшированной сессии, чтобы оффлайн-режим работал.
  useEffect(()=>{
    if(fbUser!==undefined)return;
    const t=setTimeout(()=>{
      let prof=null;
      try{prof=JSON.parse(localStorage.getItem("rmg_cached_profile")||"null");}catch(e){}
      setFbUser(prev=>{
        if(prev!==undefined)return prev;
        try{
          const uid=localStorage.getItem("rmg_cached_uid");
          if(uid){
            if(prof&&typeof prof==="object"){
              setProfile(p=>p||prof);
              if(prof.theme)setThemeName(tn=>tn||prof.theme);
            }
            return{uid,_offline:true,displayName:prof?.name,isAnonymous:false,...(prof&&typeof prof==="object"?prof:{})};
          }
        }catch(e){}
        return null;
      });
    },4000);
    return()=>clearTimeout(t);
  },[fbUser]);

  useEffect(()=>{screenRef.current=screen;},[screen]);
  useEffect(()=>{findingRef.current=finding;},[finding]);
  useEffect(()=>{editingRef.current=editing;},[editing]);
  useEffect(()=>{viewProfileRef.current=viewProfileUid;},[viewProfileUid]);

  const changeTheme=t=>{setThemeName(t);localStorage.setItem("rmg_theme",t);if(fbUser)updateDoc(doc(db,"users",fbUser.uid),{theme:t}).catch(()=>{});};

  // ── Back button (simple, no Capacitor async) ─────────────────────────────
  useEffect(()=>{
    const handler=(e)=>{
      // Всегда перехватываем — никогда не выходим по кнопке назад
      if(e && e.preventDefault) e.preventDefault();
      // Анти-дубль: один жест «назад» присылает 2-3 события сразу
      // (Capacitor backButton + DOM backbutton + popstate) — обрабатываем только одно
      const nowTs=Date.now();
      if(nowTs-(window.__rmgLastBack||0)<600)return;
      window.__rmgLastBack=nowTs;

      if(_storyBackHandler){
        try{ if(_storyBackHandler())return; }catch(err){}
      }

      // ── ПРИОРИТЕТ 1: открыт полноэкранный видеоплеер? ─────────────────
      // Закрываем его и возвращаемся в чат, а не уходим на главный экран.
      if(_videoFullscreenClose){
        try{ _videoFullscreenClose(); }catch(err){}
        return;
      }

      // ── ПРИОРИТЕТ 2: открыт лайтбокс (просмотрщик изображений)? ───────
      // Закрываем его с обратной анимацией zoom-to-thumbnail. Без этой
      // проверки кнопка «Назад» уходила бы из чата на список — а пользователь
      // ожидает возврата из просмотра фото в сам чат.
      if(_lightboxClose){
        try{ _lightboxClose(); }catch(err){}
        return;
      }

      if(_audioBackHandler){
        try{ if(_audioBackHandler())return; }catch(err){}
      }

      if(_profileBackHandler){
        try{ _profileBackHandler(); }catch(err){setViewProfileUid(null);}
        return;
      }
      if(viewProfileRef.current){setViewProfileUid(null);return;}
      if(findingRef.current){setFinding(false);return;}
      if(editingRef.current){setEditing(false);return;}
      // Модалка «Очистить» (оффлайн-настройки) — самая верхняя, закрывается первой
      if(_offlineClearBackHandler){try{ if(_offlineClearBackHandler())return; }catch(err){}}
      // Overlay «Настройки» (внутри ChatList) — закрывает группу или весь overlay
      if(_settingsBackHandler){try{ if(_settingsBackHandler())return; }catch(err){}}
      if(_chatBackHandler){try{ if(_chatBackHandler())return; }catch(err){}}
      if(screenRef.current==="chat"){setScreenAnim("toList");setTimeout(()=>setScreen("list"),320);return;}
      // На главном экране — сворачиваем, НЕ выходим
      try{
        if(window?.Capacitor?.Plugins?.App?.minimizeApp){
          window.Capacitor.Plugins.App.minimizeApp();
        }
      }catch(e){}
    };

    // Стандартный DOM backbutton (Capacitor/Cordova)
    document.addEventListener("backbutton", handler, false);

    // Capacitor addListener
    let capHandle = null;
    try{
      const CapApp = window?.Capacitor?.Plugins?.App;
      if(CapApp?.addListener){
        CapApp.addListener("backButton", handler).then(h=>{
          capHandle = h;
        }).catch(()=>{});
      }
    }catch(e){}

    // Браузерный popstate (жест назад в браузере/Android gesture nav)
    // Добавляем фиктивную запись в history чтобы ловить жест
    window.history.pushState({mrx:true}, "");
    const popHandler = (e)=>{
      handler(e);
      // Снова добавляем запись чтобы следующий жест тоже поймался
      window.history.pushState({mrx:true}, "");
    };
    window.addEventListener("popstate", popHandler, false);

    return()=>{
      document.removeEventListener("backbutton", handler, false);
      window.removeEventListener("popstate", popHandler, false);
      try{capHandle?.remove();}catch(e){}
    };
  },[]);
  // ── Отправка push через Firestore (Cloud Function подхватит) ──────────────
  const sendPushNotif=async(recipientUid,title,body,chatId,chatName,chatType)=>{
    try{
      const snap=await getDoc(doc(db,"users",recipientUid));
      const token=snap.data()?.fcmToken;
      if(!token)return;
      await addDoc(collection(db,"notifications"),{
        to:token,recipientUid,title,body,
        data:{chatId,chatName,chatType},
        createdAt:serverTimestamp()
      });
    }catch(e){}
  };

  useEffect(()=>onAuthStateChanged(auth,async user=>{
    if(user){
      // Try to get profile from Firestore
      try{
        const s=await getDoc(doc(db,"users",user.uid));
        const d=s.data();
        if(d){
          setProfile(d);
          if(d?.theme&&d.theme!=="light")setThemeName(d.theme);
          // Register on Go server
          serverRegister({uid:user.uid,...d});
          // Cache profile locally for offline
          localStorage.setItem("rmg_cached_profile",JSON.stringify(d));
          localStorage.setItem("rmg_cached_uid",user.uid);
        }
      }catch(e){
        // Offline - load cached profile
        const cached=localStorage.getItem("rmg_cached_profile");
        if(cached){const d=JSON.parse(cached);setProfile(d);if(d?.theme)setThemeName(d.theme);}
      }
      setFbUser(user);
    }
    else{
      // Check if we have cached session for offline mode
      const cachedUid=localStorage.getItem("rmg_cached_uid");
      const cachedProfile=localStorage.getItem("rmg_cached_profile");
      if(cachedUid&&cachedProfile&&!navigator.onLine){
        // Offline - use cached data
        const d=JSON.parse(cachedProfile);
        setProfile(d);
        if(d?.theme)setThemeName(d.theme);
        // Create a fake user object for offline mode
        setFbUser({uid:cachedUid,displayName:d.name,isAnonymous:false,_offline:true});
      }else{
        setFbUser(null);setProfile(null);
      }
    }
  }),[]);

  // fix10: avto-sinhronizaciya moej avatarki vo vse lichnye chaty
  useEffect(()=>{
    if(!fbUser||!profile?.photo||!String(profile.photo).startsWith("data:"))return;
    (async()=>{
      try{
        const snap=await getDocs(query(collection(db,"chats"),where("members","array-contains",fbUser.uid)));
        snap.docs.forEach(d=>{
          const data=d.data();
          if(data.type==="direct"&&(data.photos||{})[fbUser.uid]!==profile.photo){
            updateDoc(d.ref,{[`photos.${fbUser.uid}`]:profile.photo,[`names.${fbUser.uid}`]:profile.name||data.names?.[fbUser.uid]||""}).catch(()=>{});
          }
        });
      }catch(e){}
    })();
  },[fbUser,profile?.photo]);
  useEffect(()=>{
    if(!fbUser)return;
    const hb=()=>{
      const s=JSON.parse(localStorage.getItem("rmg_s")||"{}");
      updateDoc(doc(db,"users",fbUser.uid),{
        lastSeen:serverTimestamp(),
        showOnline:s.showOnline!==false,
        showLastSeen:s.showLastSeen!==false,
        readReceipts:s.readReceipts!==false,
        showTyping:s.showTyping!==false,
      }).catch(()=>{});
    };
    hb();const id=setInterval(hb,30000);
    // ✅ Настраиваем настоящий FCM после входа. Старый ntfy-топик не является
    setupPush(fbUser.uid).catch(e=>console.warn("⚠️ Не удалось настроить push:",e?.message||e));
    return()=>clearInterval(id);
  },[fbUser]);

  useEffect(()=>{
    if(!fbUser)return;
    const seen={};
    const q=query(collection(db,"chats"),where("members","array-contains",fbUser.uid));
    return onSnapshot(q,snap=>{
      const isFirst=!seen.__init;seen.__init=true;
      snap.docs.forEach(docSnap=>{
        if(true){
          const d=docSnap.data(),chatId=docSnap.id;
          // Используем lastTimeMs (если есть) для более точного определения
          // изменения — миллисекундное разрешение ловит сообщения отправленные
          // в одну и ту же минуту. Fallback на lastTime для старых записей.
          const sig=d.lastTimeMs||d.lastTime;
          if(d.lastMsg&&sig&&sig!==seen[chatId]){
            seen[chatId]=sig;
            if(isFirst)return;
            // 1) Не показываем тост для текущего открытого чата.
            if(screen==="chat"&&activeChat?.id===chatId)return;
            // 2) Не показываем тост на свои же сообщения.
            if(d.lastSender&&profile?.name&&d.lastSender===profile.name)return;
            // 3) Этот чат замьючен пользователем — ни звука, ни баннера.
            if(getS("mute_"+chatId))return;
            // 4) Это групповой чат, а уведомления из групп выключены.
            if(d.type==="group"&&getS("notifGroups")===false)return;
            const cname=d.type==="direct"&&d.names?Object.values(d.names).find(n=>n!==profile?.name)||d.name:d.name;
            // 5) В шторке системы prefix скрываем по настройке notifPreview.
            const previewText=getS("notifPreview")===false?"Новое сообщение":d.lastMsg;
            playSound("msg"); // playSound сам проверяет notifSound
            setToast({icon:"💬",title:cname||"Новое сообщение",body:previewText,onClick:()=>{setActiveChat({id:chatId,...d,name:cname});setScreen("chat");setToast(null);}});
          }
        }
      });
    });
  },[fbUser,screen,activeChat?.id,profile?.name]);

  const startChatWithUser=async(person)=>{
    try{
      const chat=await ensureDirectChat(fbUser,profile,person);
      setViewProfileUid(null);
      setFinding(false);
      setActiveChat(chat);
      setScreenAnim("toChat");
      setScreen("chat");
    }catch(e){
      setToast({icon:"!",title:"Чат не открыт",body:e?.message||String(e)});
    }
  };

  const isGlass = themeName === "glass" || themeName === "crystal";
  const isCrystal = themeName === "crystal";

  const CSS=`
    :root{--sat:env(safe-area-inset-top,28px)}
    *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
    html,body{height:100%;overflow:hidden;overscroll-behavior:none;background-color:${theme.bg}}
    body{background:${theme.bg};font-family:'SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;contain:strict;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
    *{-webkit-overflow-scrolling:touch}
    .msgs-list{will-change:scroll-position;contain:paint layout}
    #root{height:100%;width:100%}
    ::-webkit-scrollbar{width:2px}::-webkit-scrollbar-thumb{background:${theme.border};border-radius:4px}
    @keyframes msgIn{0%{opacity:0;transform:translateY(16px) scale(0.92)}50%{opacity:1;transform:translateY(-2px) scale(1.01)}100%{opacity:1;transform:none}}
    @keyframes bubbleIn{from{opacity:0;transform:scale(0.88) translateY(6px)}to{opacity:1;transform:none}}
    @keyframes splashRing{from{transform:scale(0.88);opacity:0.7}to{transform:scale(1.3);opacity:0}}
    @keyframes circleIn{from{opacity:0;transform:scale(0.65)}to{opacity:1;transform:scale(1)}}
    @keyframes circleExpandIn{0%{opacity:0;transform:scale(0.3)}60%{transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
    @keyframes emojiPanelIn{0%{opacity:0;transform:translateY(100%)}60%{opacity:1}100%{opacity:1;transform:translateY(0)}}
    @keyframes emojiPanelOut{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(100%)}}
    @keyframes emojiPop{0%{transform:scale(0.6);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
    .emoji-tabs-row::-webkit-scrollbar{display:none}
    .emoji-tabs-row{scrollbar-width:none;-ms-overflow-style:none}
    .emoji-grid-scroll::-webkit-scrollbar{width:4px}
    .emoji-grid-scroll::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.35);border-radius:4px}
    @keyframes popIn{from{opacity:0;transform:scale(0.35)}to{opacity:1;transform:scale(1)}}
    @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
    @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(-18px) scale(0.92)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
    @keyframes toastOut{from{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}to{opacity:0;transform:translateX(-50%) translateY(-12px) scale(0.96)}}
    @keyframes toastProgress{from{transform:scaleX(1)}to{transform:scaleX(0)}}
    @keyframes storyIn{from{opacity:0;transform:scale(1.025)}to{opacity:1;transform:scale(1)}}
    @keyframes storyOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(0.985)}}
    @keyframes profileOut{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(34px)}}
    @keyframes sheetUp{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:translateY(0)}}
    @keyframes authCardIn{from{opacity:0;transform:translateY(24px) scale(0.97)}to{opacity:1;transform:none}}
    @keyframes authLogoPop{0%{opacity:0;transform:scale(0.4) rotate(-12deg)}60%{transform:scale(1.08) rotate(3deg)}100%{opacity:1;transform:scale(1) rotate(0deg)}}
    @keyframes authFadeSlide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
    @keyframes authFadeOutUp{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-8px)}}
    @keyframes authHelpOpen{0%{opacity:0;max-height:0;transform:translateY(-10px) scale(0.98)}100%{opacity:1;max-height:460px;transform:none}}
    @keyframes authHelpClose{0%{opacity:1;max-height:460px;transform:none}100%{opacity:0;max-height:0;transform:translateY(-10px) scale(0.98)}}
    @keyframes authFieldIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes authBtnPulse{0%{box-shadow:0 4px 22px rgba(255,0,0,0.35)}50%{box-shadow:0 4px 30px rgba(255,0,0,0.6)}100%{box-shadow:0 4px 22px rgba(255,0,0,0.35)}}
    @keyframes modalPop{from{opacity:0;transform:scale(0.92) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
    @keyframes pageSlideIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
    @keyframes pageSlideInLeft{from{opacity:0;transform:translateX(-40px)}to{opacity:1;transform:none}}
    @keyframes pageSlideOut{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(100%)}}
    @keyframes chatSlideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
    @keyframes chatSlideOut{0%{transform:translateX(0)}100%{transform:translateX(100%)}}
    @keyframes listSlideOut{from{transform:translateX(0);filter:brightness(1)}to{transform:translateX(-28%);filter:brightness(0.72)}}
    @keyframes listSlideIn{0%{transform:translateX(-28%);filter:brightness(0.72)}100%{transform:translateX(0);filter:brightness(1)}}
    @keyframes chatSwipeBack{from{transform:translateX(var(--swipe-x,0px));opacity:1}to{transform:translateX(100%);opacity:0}}
    @keyframes bottomNavIn{from{transform:translateY(100%)}to{transform:none}}
    @keyframes listIn{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes ripple{0%{transform:scale(1);opacity:0.5}100%{transform:scale(1.8);opacity:0}}
    @keyframes artPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
    @keyframes miniSlideDown{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:none}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    @keyframes scalePress{from{transform:scale(1)}to{transform:scale(0.94)}}
    @keyframes glassOrb1{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(60px,-40px) scale(1.15)}66%{transform:translate(-40px,50px) scale(0.9)}}
    @keyframes glassOrb2{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(-70px,30px) scale(0.85)}66%{transform:translate(50px,-60px) scale(1.2)}}
    @keyframes glassOrb3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(40px,70px) scale(1.1)}}
    @keyframes glassShimmer{0%{background-position:200% center}100%{background-position:-200% center}}
    input::placeholder,textarea::placeholder{color:${theme.text2}55}
    button{-webkit-user-select:none;user-select:none}
    .rmg-press{transition:transform 0.16s cubic-bezier(0.34,1.56,0.64,1),opacity 0.16s}
    .rmg-press:active{transform:scale(0.88);opacity:0.7}
    .rmg-skel{background:linear-gradient(90deg,rgba(128,128,128,0.14) 25%,rgba(128,128,128,0.3) 50%,rgba(128,128,128,0.14) 75%);background-size:200% 100%;animation:skelShimmer 1.15s linear infinite}
    @keyframes skelShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    input,textarea{transition:border-color 0.25s ease,box-shadow 0.25s ease,background 0.25s ease}

    ${isGlass ? `
    /* ── Liquid Glass Theme ── */
    .glass-surface{
      background: rgba(255,255,255,0.08) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
      border: 1px solid rgba(255,255,255,0.18) !important;
    }
    .glass-bubble-me{
      background: linear-gradient(135deg, rgba(125,211,252,0.55), rgba(56,189,248,0.4)) !important;
      backdrop-filter: blur(20px) !important;
      -webkit-backdrop-filter: blur(20px) !important;
      border: 1px solid rgba(255,255,255,0.35) !important;
      box-shadow: 0 4px 24px rgba(125,211,252,0.25), inset 0 1px 0 rgba(255,255,255,0.4) !important;
    }
    .glass-bubble-other{
      background: rgba(255,255,255,0.1) !important;
      backdrop-filter: blur(20px) !important;
      -webkit-backdrop-filter: blur(20px) !important;
      border: 1px solid rgba(255,255,255,0.2) !important;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.25) !important;
    }
    .glass-btn{
      background: rgba(255,255,255,0.12) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
      border: 1px solid rgba(255,255,255,0.2) !important;
    }
    .glass-nav{
      background: rgba(10,10,26,0.7) !important;
      backdrop-filter: blur(32px) saturate(200%) !important;
      -webkit-backdrop-filter: blur(32px) saturate(200%) !important;
      border-top: 1px solid rgba(255,255,255,0.12) !important;
    }
    ` : ''}

    ${isCrystal ? `
    /* ── Crystal Theme — всё прозрачное ── */
    .glass-surface, [class*="glass"]{
      background: rgba(255,255,255,0.03) !important;
      backdrop-filter: blur(40px) saturate(120%) brightness(1.1) !important;
      -webkit-backdrop-filter: blur(40px) saturate(120%) brightness(1.1) !important;
      border: 1px solid rgba(255,255,255,0.09) !important;
    }
    .glass-bubble-me{
      background: rgba(255,255,255,0.12) !important;
      backdrop-filter: blur(30px) brightness(1.2) !important;
      -webkit-backdrop-filter: blur(30px) brightness(1.2) !important;
      border: 1px solid rgba(255,255,255,0.25) !important;
      box-shadow: 0 2px 20px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.3) !important;
    }
    .glass-bubble-other{
      background: rgba(255,255,255,0.05) !important;
      backdrop-filter: blur(30px) !important;
      -webkit-backdrop-filter: blur(30px) !important;
      border: 1px solid rgba(255,255,255,0.1) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.15) !important;
    }
    .glass-nav{
      background: rgba(0,0,0,0.25) !important;
      backdrop-filter: blur(50px) saturate(150%) !important;
      -webkit-backdrop-filter: blur(50px) saturate(150%) !important;
      border-top: 1px solid rgba(255,255,255,0.07) !important;
    }
    /* Headers полностью прозрачные */
    div[style*="background:surface"], div[style*="background: surface"]{
      background: transparent !important;
    }
    ` : ''}
  `;

  // undefined=loading, null=logged out, object=logged in
  if(fbUser===undefined||!minSplashDone)return(
    <AudioCtxProvider>
    <ThemeCtx.Provider value={theme}>
      <style>{CSS+`
        @keyframes splashRing{from{transform:scale(0.85);opacity:0.8;}to{transform:scale(1.25);opacity:0;}}
      `}</style>
      <SplashScreen/>
    </ThemeCtx.Provider>
    </AudioCtxProvider>
  );

  return(
    <AudioCtxProvider>
    <ThemeCtx.Provider value={theme}>
      <style>{CSS}</style>
      <ConfirmHost/>
      <div style={{height:"100vh",position:"relative",overflow:"hidden",animation:"fadeIn 0.4s ease both"}}>

        {/* ── Liquid Glass animated background ── */}
        {isGlass&&(
          <div style={{position:"fixed",inset:0,zIndex:0,overflow:"hidden",pointerEvents:"none"}}>
            {/* Deep bg */}
            {!isCrystal&&<div style={{position:"absolute",inset:0,background:"linear-gradient(135deg,#0a0a2e 0%,#0d1a3a 40%,#0a0a1a 100%)"}}/>}
            {isCrystal&&<div style={{position:"absolute",inset:0,background:"linear-gradient(135deg,#000510 0%,#030818 50%,#000305 100%)"}}/>}
            {/* Orb 1 */}
            <div style={{position:"absolute",width:isCrystal?500:380,height:isCrystal?500:380,borderRadius:"50%",background:isCrystal?"radial-gradient(circle,rgba(224,242,254,0.12) 0%,transparent 70%)":"radial-gradient(circle,rgba(59,130,246,0.45) 0%,transparent 70%)",top:"5%",left:"10%",animation:"glassOrb1 12s ease-in-out infinite",filter:`blur(${isCrystal?60:40}px)`}}/>
            {/* Orb 2 */}
            <div style={{position:"absolute",width:isCrystal?420:320,height:isCrystal?420:320,borderRadius:"50%",background:isCrystal?"radial-gradient(circle,rgba(186,230,253,0.1) 0%,transparent 70%)":"radial-gradient(circle,rgba(139,92,246,0.4) 0%,transparent 70%)",top:"40%",right:"5%",animation:"glassOrb2 15s ease-in-out infinite",filter:`blur(${isCrystal?55:35}px)`}}/>
            {/* Orb 3 */}
            <div style={{position:"absolute",width:isCrystal?360:280,height:isCrystal?360:280,borderRadius:"50%",background:isCrystal?"radial-gradient(circle,rgba(240,249,255,0.08) 0%,transparent 70%)":"radial-gradient(circle,rgba(6,182,212,0.35) 0%,transparent 70%)",bottom:"10%",left:"20%",animation:"glassOrb3 10s ease-in-out infinite",filter:`blur(${isCrystal?50:30}px)`}}/>
            {/* Orb 4 */}
            <div style={{position:"absolute",width:isCrystal?300:200,height:isCrystal?300:200,borderRadius:"50%",background:isCrystal?"radial-gradient(circle,rgba(255,255,255,0.06) 0%,transparent 70%)":"radial-gradient(circle,rgba(236,72,153,0.25) 0%,transparent 70%)",top:"60%",left:"55%",animation:"glassOrb1 18s ease-in-out 3s infinite",filter:`blur(${isCrystal?45:28}px)`}}/>
            {/* Crystal extra shimmer orbs */}
            {isCrystal&&<>
              <div style={{position:"absolute",width:200,height:200,borderRadius:"50%",background:"radial-gradient(circle,rgba(255,255,255,0.05) 0%,transparent 70%)",top:"25%",left:"60%",animation:"glassOrb2 8s ease-in-out infinite",filter:"blur(35px)"}}/>
              <div style={{position:"absolute",width:150,height:150,borderRadius:"50%",background:"radial-gradient(circle,rgba(224,242,254,0.08) 0%,transparent 70%)",top:"70%",right:"30%",animation:"glassOrb3 14s ease-in-out 2s infinite",filter:"blur(25px)"}}/>
            </>}
            {/* Noise grain */}
            <div style={{position:"absolute",inset:0,opacity:isCrystal?0.015:0.03,backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`}}/>
          </div>
        )}

        <div style={{position:"relative",zIndex:1,height:"100%"}}>
        {toast&&<Toast toast={toast} onClose={()=>setToast(null)}/>}
        <AudioFullPlayerOverlay/>

        {/* Profile layer - always on top */}
        {viewProfileUid&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:600}}>
            <ProfileView uid={viewProfileUid} myUid={fbUser?.uid} onClose={()=>setViewProfileUid(null)} onStartChat={startChatWithUser}/>
          </div>
        )}

        {/* Main layer */}
        {!fbUser?(
          <AuthScreen onAuth={(user,prof,isAnon)=>{setFbUser(user);setProfile(prof);if(isAnon)setEditing(true);}}/>
        ):editing?(
          <EditProfile currentUser={fbUser} profile={profile} onSave={updated=>{setProfile(updated);setEditing(false);}} onClose={()=>setEditing(false)}/>
        ):finding?(
          <FindPeople currentUser={fbUser} profile={profile} onClose={()=>setFinding(false)} onStartChat={chat=>{setFinding(false);setActiveChat(chat);setScreenAnim("toChat");setScreen("chat");}}/>
        ):(
          <div style={{position:"relative",width:"100%",height:"100%",overflow:"hidden"}}>
            {/* ChatList — уходит влево при входе в чат, возвращается справа при выходе */}
            <div style={{
              position:"absolute",inset:0,willChange:"transform",
              animation:screenAnim==="toChat"?"listSlideOut 0.34s cubic-bezier(0.32,0.72,0,1) forwards"
                :screenAnim==="toList"?"listSlideIn 0.34s cubic-bezier(0.32,0.72,0,1) forwards":"none",
              pointerEvents:screen==="chat"?"none":"auto",
              zIndex:screen==="list"?1:0,
            }}>
              <ChatList currentUser={fbUser} profile={profile}
                online={online}
                onOpen={chat=>{setActiveChat(chat);setScreenAnim("toChat");setScreen("chat");}}
                onFind={()=>setFinding(true)}
                onEditProfile={()=>setEditing(true)}
                onViewProfile={uid=>setViewProfileUid(uid)}
                onChatsLoad={setAppChats}
                themeName={themeName} onChangeTheme={changeTheme}
                wallpaperId={wallpaperId} onChangeWallpaper={id=>{setWallpaperId(id);localStorage.setItem("rmg_wallpaper",id);}}
                accentId={accentId} onChangeAccent={id=>{setAccentId(id);localStorage.setItem("rmg_accent",id);}}
                msgFontSize={msgFontSize} onChangeFontSize={s=>{setMsgFontSize(s);localStorage.setItem("rmg_fontsize",s);}}
                onLogout={async()=>{
                  await clearPushRegistration(fbUser?.uid);
                  await signOut(auth);
                }}/>
            </div>
            {/* ChatScreen — въезжает справа, уезжает вправо */}
            {activeChat&&(
              <div style={{
                position:"absolute",inset:0,willChange:"transform",boxShadow:"-12px 0 36px rgba(0,0,0,0.35)",
                animation:screenAnim==="toChat"?"chatSlideIn 0.34s cubic-bezier(0.32,0.72,0,1) forwards"
                  :screenAnim==="toList"?"chatSlideOut 0.34s cubic-bezier(0.32,0.72,0,1) forwards":"none",
                pointerEvents:screen==="list"?"none":"auto",
                zIndex:screen==="chat"?1:0,
              }}>
                <ChatErrorBoundary onBack={()=>{setScreenAnim("toList");setTimeout(()=>setScreen("list"),320);}}>
                  <ChatScreen key={activeChat.id} chat={activeChat} currentUser={fbUser} profile={profile} isActive={screen==="chat"}
                    onBack={()=>{setScreenAnim("toList");setTimeout(()=>setScreen("list"),320);}}
                    onViewProfile={uid=>setViewProfileUid(uid)} showToast={setToast}
                    wallpaperId={wallpaperId} msgFontSize={msgFontSize} chats={appChats}/>
                </ChatErrorBoundary>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </ThemeCtx.Provider>
    </AudioCtxProvider>
  );
}
