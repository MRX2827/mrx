import React, { useState, useEffect, useLayoutEffect, useRef, createContext, useContext, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { initDB, saveMsg, getMsgs, deleteMsg, updateMsgReactions, updateMsgText, getSetting, setSetting, clearChatMsgs, searchMsgs } from "./db.js";
import { getCachedMediaSrc, ensureMediaDownloaded, pauseMediaDownloads, resumeMediaDownloads } from "./media.js";

// ─── Media: локальный (скачанный) src вместо remote_url, если уже есть на диске ─
// Возвращает то же самое, что раньше давало "msg.xUrl||msg.xData" — то есть
// сразу что-то показывающееся, — но параллельно проверяет SQLite-таблицу media
// и, если файл уже скачан на диск, подменяет src на локальный (file://…), а если
// не скачан — тихо запускает скачивание в фоне через media.js для будущего офлайн-
// доступа. В браузере (не Android) media.js — no-op, ничего не меняется.
function useMediaSrc(chatId, msg, remote, kind) {
  const [src,setSrc]=useState(remote);

  useEffect(()=>{
    let cancelled=false;
    setSrc(remote);
    if(!chatId||!msg.id||!remote){
      if(remote)console.log("[media] hook skip, no chatId/msg.id:",chatId,msg.id,kind);
      return;
    }
    (async()=>{
      const cached=await getCachedMediaSrc(chatId,msg.id);
      if(cancelled)return;
      if(cached){console.log("[media] cache hit:",chatId,msg.id,kind);setSrc(cached);return;}
      const local=await ensureMediaDownloaded(chatId,msg.id,remote,kind,msg.fileType||"",msg.fileSize||0);
      if(!cancelled&&local)setSrc(local);
    })();
    return ()=>{cancelled=true;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[chatId,msg.id,remote,kind]);

  return src;
}

// ─── Go Server ────────────────────────────────────────────────────────────────
const SERVER_HTTP = "https://redmrxgram.duckdns.org";
const SERVER_WS   = "wss://redmrxgram.duckdns.org";

// Совместимые вызовы данных и файлов идут на собственный сервер.
// Firebase используется отдельно для FCM, поэтому push-плагин не алиасится.
async function serverUpload(file, onProgress) {
  pauseMediaDownloads();
  try {
    return await uploadFileToFirebase(file, "chat", onProgress);
  } finally {
    resumeMediaDownloads();
  }
}
async function serverRegister(user) {
  return user || null;
}
async function serverSearch(query) {
  return [];
}

const PUSH_TOPIC_KEY = "rmg_push_topic";
let pushRegistrationUid = "";
let nativePushListenersReady = false;

// Топик генерируется один раз на устройство и живёт в localStorage —
// сервер публикует уведомления в него через ntfy, когда получатель оффлайн.
function getPushTopic() {
  let t = "";
  try { t = localStorage.getItem(PUSH_TOPIC_KEY) || ""; } catch (e) {}
  if (t) return t;
  const raw = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}${Math.random()}`;
  t = `rmg${String(raw).replace(/[^a-zA-Z0-9]/g, "")}`;
  try { localStorage.setItem(PUSH_TOPIC_KEY, t); } catch (e) {}
  return t;
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

async function serverSaveTopic(userId, topic) {
  if (!userId || !topic) return;
  await api(`/user/${userId}`, { method: "POST", body: { pushTopic: topic } });
  // docstore.go шлёт пуш при создании сообщения, беря токен из документа
  // users/{uid}.fcmToken — это отдельное хранилище от SQL-таблицы users,
  // поэтому топик нужно продублировать и туда.
  await setDoc(doc(db, "users", userId), { fcmToken: topic }, { merge: true });
}

// Мьют/звук/вибро сейчас применяются только локально в самом уведомлении —
// сервер про эти настройки не знает и шлёт всё как есть в топик. Заглушка
// оставлена на случай, если сервер научится их учитывать (см. mutedChatIds).
async function syncPushPreferences(userId) {
  if (!userId) return;
}

async function clearPushRegistration(userId) {
  if (!userId) return;
  try { await api(`/user/${userId}`, { method: "POST", body: { pushTopic: "" } }); } catch (e) {}
  try { await setDoc(doc(db, "users", userId), { fcmToken: "" }, { merge: true }); } catch (e) {}
  if (Capacitor.isNativePlatform()) {
    NativePush.stop().catch(() => {});
  }
  if (pushRegistrationUid === userId) pushRegistrationUid = "";
}

// Текущий открытый чат (для подавления Android-уведомлений в foreground)
let _activeChatId = null;

import { auth, db, storage } from "./firebase";
import { ref as sRef, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, signInAnonymously, registerAccount, verifyEmailCode, resendEmailCode, attachEmail, requestPasswordReset, confirmPasswordReset } from "firebase/auth";
import { collection, doc, setDoc, getDoc, addDoc, query, orderBy, onSnapshot, where, getDocs, serverTimestamp, updateDoc, arrayUnion, limitToLast, startAfter, endBefore, deleteDoc, increment } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { NativePush } from "./native-push.js";
import { api } from "./fb/core.js";

// ── Скрытые (удалённые у себя) чаты: {chatId: момент удаления ms}. Старый формат-массив мигрируем.
function readHidden(key){
  try{
    const raw=JSON.parse(localStorage.getItem(key)||"{}");
    if(Array.isArray(raw)){const m={};const now=Date.now();raw.forEach(id=>{m[id]=now;});try{localStorage.setItem(key,JSON.stringify(m));}catch(e){}return m;}
    return raw&&typeof raw==="object"?raw:{};
  }catch(e){return{};}
}
function isHiddenChat(hiddenLocal,uid,c){
  // Проверяем ОБА источника: старый локальный (localStorage — только на этом
  // устройстве, стирается при переустановке приложения) и серверный —
  // c.hiddenFor[uid], поле самого документа чата в Firestore. Серверный
  // переживает переустановку и синхронизируется между устройствами одного
  // аккаунта, поэтому именно на него теперь основная надежда; локальный
  // оставлен для обратной совместимости с уже накопленными записями.
  const atLocal=hiddenLocal?.[c?.id];
  const atServer=c?.hiddenFor?.[uid];
  const at=Math.max(atLocal||0,atServer||0);
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
      <IcCloud size={15} color="#fff"/>
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
    try{localStorage.setItem("rmg_audio_positions_v2",JSON.stringify(this.posCache));}catch(e){}
  },

  jumpTo(i,fromPrev=false,skipSave=false){
    if(!skipSave)this._savePos();
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
    // Сохраняем позицию СТАРОГО трека здесь, ДО того как queue изменится —
    // иначе jumpTo() ниже посчитает this.track уже по новому (вставленному)
    // треку, а this.el всё ещё содержит старую позицию, и она ошибочно
    // запишется под id нового трека — из-за этого новый трек стартовал
    // с той же секунды, на которой остановился предыдущий.
    this._savePos();
    // Insert new track at current position, shift old
    if(this.idx===-1){
      this.queue=[track];
      this.idx=0;
    }else{
      this.queue.splice(this.idx,0,track);
    }
    this.jumpTo(this.idx,false,true); // skipSave — уже сохранили выше корректно
    this._persist();
  },

  // Заменяет всю очередь списком треков (например, все аудио из текущего чата)
  // и сразу переходит на выбранный трек по его id.
  playTrackList(tracks,trackId){
    // Аналогично playTrack: сохраняем позицию ДО подмены очереди, и просим
    // jumpTo не сохранять повторно (после подмены this.track указывал бы
    // не на тот трек).
    this._savePos();
    this.queue=tracks;
    this.historyStack=[]; // новая очередь — старая история переходов больше не актуальна
    const i=Math.max(0,tracks.findIndex(t=>t.id===trackId));
    this.jumpTo(i,false,true);
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
      // Ключ версионирован (_v2): старые записи писались багованной логикой
      // (позиция одного трека утекала под id другого при переключении) и
      // не заслуживают доверия. Просто игнорируем старый ключ — новый
      // пишется только корректной логикой из этой версии.
      const pos=JSON.parse(localStorage.getItem("rmg_audio_positions_v2")||"{}");
      this.queue=q;this.idx=i;
      this.shuffle=s.shuffle||false;this.repeat=s.repeat||"off";this.speed=s.speed||1;
      this.posCache=pos;
      try{localStorage.removeItem("rmg_audio_positions");}catch(e){}
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

  // Анимация появления/закрытия мини-плеера. Живёт здесь, в единственном
  // глобальном провайдере (не в самом MiniPlayer/AudioMiniBar), потому что
  // MiniPlayer рендерится отдельно на КАЖДОМ экране — при переходах между
  // экранами такой компонент может размонтироваться и смонтироваться заново,
  // и локальное состояние анимации попросту терялось. Здесь оно переживает
  // любые переходы между экранами.
  //
  // ВАЖНО: раньше открытие анимировалось через CSS @keyframes (animation),
  // а закрытие — через CSS transition. Смена с animation на transition НА
  // ОДНОМ И ТОМ ЖЕ элементе в одном рендере ненадёжно работает в некоторых
  // Android WebView (браузер иногда просто «схлопывает» состояние без
  // интерполяции). Поэтому теперь ОБА направления идут через один и тот же
  // механизм — только transition, без единого CSS animation. miniPhase:
  // "hidden" (плеера нет) → "entering" (только что смонтирован, стоит в
  // начальном положении) → "shown" (в раскрытом состоянии, тут и играет
  // transition при переходе из entering) → "exiting" (едет обратно в
  // свёрнутое положение) → снова "hidden".
  const [miniPhase,setMiniPhase]=useState("hidden"); // hidden|entering|shown|exiting
  const [miniSnap,setMiniSnap]=useState(null);
  const prevTrackRef=useRef(null);
  if(state.track){
    prevTrackRef.current={track:state.track,playing:state.playing,progress:state.progress,queue:state.queue,idx:state.idx};
    if(miniPhase==="hidden")setMiniPhase("entering");
    else if(miniPhase==="exiting")setMiniPhase("shown"); // передумали закрывать — трек снова играет
  }else if(miniPhase==="shown"||miniPhase==="entering"){
    setMiniSnap(prevTrackRef.current);
    setMiniPhase("exiting");
  }
  useEffect(()=>{
    if(miniPhase==="entering"){
      // Даём браузеру отрисовать «свёрнутое» начальное положение ХОТЯ БЫ
      // один кадр, и только потом просим ехать в раскрытое — иначе это будет
      // первое и единственное состояние узла, transition играть не от чего.
      let raf2;
      const raf1=requestAnimationFrame(()=>{raf2=requestAnimationFrame(()=>setMiniPhase("shown"));});
      return ()=>{cancelAnimationFrame(raf1);if(raf2)cancelAnimationFrame(raf2);};
    }
    if(miniPhase==="exiting"){
      const t=setTimeout(()=>setMiniPhase("hidden"),320);
      return ()=>clearTimeout(t);
    }
  },[miniPhase]);

  const ctx={
    ...state,
    miniPhase,miniSnap,
    playTrack:(track)=>{AUDIO_ENGINE.playTrack(track);setState(prev=>({...prev,showMini:true}));},
    playTrackList:(tracks,trackId)=>{AUDIO_ENGINE.playTrackList(tracks,trackId);setState(prev=>({...prev,showMini:true}));},
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
  crystal: { bg:"transparent", surface:"rgba(255,255,255,0.05)", surface2:"rgba(255,255,255,0.09)", border:"rgba(255,255,255,0.14)", text:"#FFFFFF", text2:"rgba(255,255,255,0.55)", accent:"#FFFFFF", accent2:"#D8D8DC", _glass:true, _crystal:true },
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
// Чёрный или белый текст поверх заливки цветом accent — чтобы не потерять
// читаемость, если выбранный акцент светлый (например, белый).
const contrastOn=hex=>{
  const h=(hex||"").replace("#","");
  if(h.length!==6)return"#fff";
  const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
  return(0.299*r+0.587*g+0.114*b)/255>0.6?"#000":"#fff";
};
// Полупрозрачный чёрный/белый поверх "своего" пузыря сообщения — подбирается
// по тому же принципу, что и contrastOn(), чтобы вспомогательный текст/иконки
// (время, реплай, реакции и т.п.) не терялись, если акцентный цвет светлый
// (например тема с белым акцентом даёт светлый градиент пузыря).
const mineRgba=(accentHex,a)=>contrastOn(accentHex)==="#000"?`rgba(0,0,0,${a})`:`rgba(255,255,255,${a})`;
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
  const c=fromMe?mineRgba(accent,0.9):accent;
  return(
    <div style={{display:"flex",alignItems:"center",gap:2,height:24}}>
      {(wf||[]).map((h,i)=><div key={i} style={{width:3,borderRadius:3,height:Math.max(3,h),background:i/wf.length<progress?c:`${c}28`}}/>)}
    </div>
  );
}

// ─── Voice Bubble ────────────────────────────────────────────────────────────
function VoiceBubble({msg,fromMe,chatId}){
  const {accent,text2}=useContext(ThemeCtx);
  const[playing,setPlaying]=useState(false);
  const[prog,setProg]=useState(0);
  const[dur,setDur]=useState(msg.duration||"0:00");
  const[err,setErr]=useState(false);
  const aRef=useRef(null),raf=useRef(null);
  const src=useMediaSrc(chatId,msg,msg.audioUrl||msg.audioData||msg.fileUrl||msg.fileData||"","audio");

  const stop=()=>{
    try{if(aRef.current){aRef.current.pause();aRef.current.src="";aRef.current=null;}}catch(e){}
    cancelAnimationFrame(raf.current);
    setPlaying(false);setProg(0);
  };

  const toggle=()=>{
    if(playing){stop();return;}
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
      <button onClick={toggle} style={{width:42,height:42,borderRadius:"50%",border:"none",cursor:"pointer",background:err?"rgba(255,59,48,0.3)":fromMe?mineRgba(accent,0.2):accent,color:fromMe?contrastOn(accent):"#fff",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"transform 0.15s",transform:playing?"scale(0.88)":"scale(1)"}}>
        {err?"✕":playing?"⏸":"▶"}
      </button>
      <div style={{flex:1}}>
        <Waveform wf={wf} progress={prog} fromMe={fromMe}/>
        <div style={{fontSize:11,color:fromMe?mineRgba(accent,0.45):text2,marginTop:2}}>{dur}</div>
      </div>
    </div>
  );
}


function AudioBubble({msg,fromMe,audioMsgs,chatId}){
  const {accent,text,text2}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  const cachedSrc=useMediaSrc(chatId,msg,msg.fileUrl||msg.fileData||msg.audioUrl||msg.audioData||"","audio");
  const trackId=msg.id||(msg.fileUrl||msg.audioUrl||msg.fileData||msg.audioData||"");
  const isActive=audio?.track?.id===trackId;
  const isPlaying=isActive&&audio?.playing;
  const progress=isActive?(audio?.progress||0):0;
  const curTime=isActive?(audio?.currentTime||0):0;
  const fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

  // Для очереди (audioMsgs) пока берём src как раньше — у каждого из этих
  // сообщений есть свой собственный <AudioBubble>, который сам скачивает
  // себя в фоне; здесь же, для ТЕКУЩЕГО msg, если локальный файл уже готов,
  // подставляем его вместо сетевого URL.
  const buildTrackFrom=(m)=>({
    id:m.id||(m.fileUrl||m.audioUrl||m.fileData||m.audioData||""),
    src:(m.id===msg.id&&cachedSrc)?cachedSrc:(m.fileUrl||m.fileData||m.audioUrl||m.audioData||""),
    name:(m.fileName||"Аудио").replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|opus|aiff|ape)$/i,""),
    ext:(m.fileName||"").split(".").pop()?.toUpperCase()||"MP3",
    size:m.fileSize?fmtSize(m.fileSize):"",
    chatName:"",author:m.author||"",
  });
  const buildTrack=()=>buildTrackFrom(msg);

  const toggle=()=>{
    if(!audio)return;
    const src=cachedSrc;
    if(!src)return;
    if(isActive){isPlaying?audio.pause():audio.play();}
    else if(audioMsgs&&audioMsgs.length>1){
      // Собираем очередь из всех аудио этого чата, а не только из одного сообщения
      audio.playTrackList(audioMsgs.map(buildTrackFrom),trackId);
    }else{
      audio.playTrack(buildTrack());
    }
  };

  const name=msg.fileName||"Аудио";
  const ext=name.split(".").pop()?.toUpperCase()||"MP3";
  const sizeMb=msg.fileSize?(msg.fileSize/1024/1024).toFixed(1)+"MB":"";
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:220,maxWidth:280}}>
      <button onClick={toggle} style={{width:46,height:46,borderRadius:"50%",border:"none",cursor:"pointer",flexShrink:0,background:fromMe?mineRgba(accent,0.22):accent,color:fromMe?contrastOn(accent):"#fff",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.15s",transform:isPlaying?"scale(0.88)":"scale(1)"}}>
        {isPlaying?"⏸":"▶"}
      </button>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:fromMe?contrastOn(accent):text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginBottom:4}}>🎵 {name}</div>
        <div style={{height:3,background:fromMe?mineRgba(accent,0.25):"rgba(0,0,0,0.15)",borderRadius:2,overflow:"hidden",marginBottom:4}}>
          <div style={{height:"100%",width:(progress*100)+"%",background:fromMe?mineRgba(accent,0.85):accent,borderRadius:2,transition:"width 0.1s linear"}}/>
        </div>
        <div style={{fontSize:10,color:fromMe?mineRgba(accent,0.5):text2,display:"flex",gap:6}}>
          <span>{isActive?fmt(curTime):"0:00"}</span>{sizeMb&&<span>· {sizeMb}</span>}<span>· {ext}</span>
        </div>
      </div>
    </div>
  );
}

function CircleBubble({msg,onFullscreen,chatId}){
  const {accent,accent2}=useContext(ThemeCtx);
  const[playing,setPlaying]=useState(false);
  const[prog,setProg]=useState(0);
  const[thumb,setThumb]=useState(null);
  const vRef=useRef(null),raf=useRef(null);
  const BASE_SIZE=138;
  const ACTIVE_SIZE=188;
  const size=playing?ACTIVE_SIZE:BASE_SIZE;
  const src=useMediaSrc(chatId,msg,msg.videoUrl||msg.videoData||"","video");

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
    v.play().catch(e=>console.warn("[circle] play() rejected:",e?.name,e?.message));setPlaying(true);
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
          onError={e=>console.warn("[circle] video error:",e?.target?.error?.code,e?.target?.error?.message,"src=",e?.target?.currentSrc)}
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
            background:fromMe?mineRgba(accent,0.15):accent+"22",
            display:"flex",alignItems:"center",justifyContent:"center",
            overflow:"hidden",boxShadow:isPlaying?`0 0 14px ${accent}66`:"none",transition:"box-shadow 0.3s"}}>
            {msg.coverUrl
              ?<img src={msg.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :<IcMusicNote size={22} color={fromMe?contrastOn(accent):accent}/>}
          </div>
          <button onClick={toggle} style={{position:"absolute",inset:0,borderRadius:12,border:"none",cursor:"pointer",
            background:isPlaying?"rgba(0,0,0,0.4)":"rgba(0,0,0,0.25)",color:"#fff",fontSize:14,
            display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s",WebkitTapHighlightColor:"transparent"}}>
            {isPlaying?"⏸":"▶"}
          </button>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:fromMe?contrastOn(accent):text,fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name.replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|aiff|ape)$/i,"")}</div>
          <div style={{color:fromMe?mineRgba(accent,0.55):text2,fontSize:11,marginTop:1}}>{size}{size?" · ":""}Аудио</div>
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
            background:i/wf.length<progress?(fromMe?mineRgba(accent,0.9):accent):(fromMe?mineRgba(accent,0.25):accent+"33"),
            transition:"background 0.08s"}}/>
        ))}
      </div>
      <div style={{display:"flex",justifyContent:"space-between"}}>
        <span style={{color:fromMe?mineRgba(accent,0.5):text2,fontSize:10}}>{fmt(curTime)}</span>
        <span style={{color:fromMe?mineRgba(accent,0.5):text2,fontSize:10}}>{fmt(durTime)}</span>
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
// ─── Audio player icons ───────────────────────────────────────────────────
const IcAudioPrev=_ic("M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z");
const IcAudioNext=_ic("M4 18l8.5-6L4 6v12zm9-12v12h2V6h-2z");
const IcAudioPlay=_ic("M8 5v14l11-7z");
const IcAudioPause=_ic("M6 19h4V5H6v14zm8-14v14h4V5h-4z");
const IcAudioClose=_ic("M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z");
const IcAudioShuffle=_ic("M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z");
const IcAudioRepeat=_ic("M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z");
const IcAudioDownload=_ic("M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z");
const IcChevronDown=_ic("M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z");
const IcMusicNote=_ic("M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z");
const IcClipboard=_ic("M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 16H5V5h2v3h10V5h2v14z");

// ─── Player screen (Мимоза-style) icons ──────────────────────────────────────
const IcMoreH=_ic("M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z");
const IcAddCircle=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z");
const IcSpeedGauge=_ic("M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z");
const IcEqualizer=_ic("M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z");
const IcDeviceSm=_ic("M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V4h10v15z");
const IcGlobe=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm7.93 9h-3.02c-.15-2.19-.65-4.16-1.4-5.62A8.03 8.03 0 0 1 19.93 11zM12 4.06c.87 1.15 1.7 3.14 1.93 6.94h-3.86c.23-3.8 1.06-5.79 1.93-6.94zM4.07 13h3.02c.15 2.19.65 4.16 1.4 5.62A8.03 8.03 0 0 1 4.07 13zm3.02-2H4.07a8.03 8.03 0 0 1 4.42-5.62C7.74 6.84 7.24 8.81 7.09 11zM12 19.94c-.87-1.15-1.7-3.14-1.93-6.94h3.86c-.23 3.8-1.06 5.79-1.93 6.94zM13.91 13h3.02a8.03 8.03 0 0 1-4.42 5.62c.75-1.46 1.25-3.43 1.4-5.62z");
const IcSend=_ic("M2.01 21L23 12 2.01 3 2 10l15 2-15 2z");
const IcRobot=_ic("M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7v1h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1H4v-1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1v-1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2zM8.5 12a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z");
const IcCloud=_ic("M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z");
const IcVolume=_ic("M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z");
const IcPaperclip=_ic("M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z");
const IcMic=_ic("M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z");
const IcTag=_ic("M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z");
const IcLink=_ic("M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z");
const IcWarning=_ic("M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z");
const IcSun=_ic("M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z");
const IcFastForward=_ic("M4 18l8.5-6L4 6v12zm9-12v12l8.5-6z");
const IcFastRewind=_ic("M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z");
const IcEye=_ic("M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z");
const IcEyeOff=_ic("M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z");
const IcMailAuth=_ic("M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z");
const IcLockAuth=_ic("M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm3 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z");
const IcUserAuth=_ic("M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.67-5.33-4-8-4z");
const IcCircleOutline=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z");

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
// Иконка "фон" — стопка фото (photo_library), визуально отличается от обычной
// галереи (IcImage) при выборе фонового изображения профиля.
const IcImageBg=_ic("M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zM11 12l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z");
const IcFileDoc=_ic("M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z");
const IcCircleVid=_ic("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-2-12.5v9l6-4.5-6-4.5z");
const IcPin=_ic("M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z");
const IcArchiveBox=_ic("M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z");
const IcMute=_ic("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z");
const IcCheckOne=_ic("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z");
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
// ─── Profile achievements screen icons ───────────────────────────────────────
const IcShareOut=_ic("M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L7.04 9.81C6.5 9.31 5.79 9 5 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z");
const IcTrophy=_ic("M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V18H7v2h10v-2h-4v-2.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z");
const IcCalendarSm=_ic("M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z");

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

// ── Плавная клавиатура (IME): «док поверх списка» (финальная схема) ──────────
// Корень чата НИКОГДА не меняет размеры (нет paddingBottom) → сообщения
// нарисованы по весь экран всегда, чёрной пустой полосы за клавиатурой
// не существует в принципе. Панель ввода (док) — абсолютная, ездит
// композиторным transform'ом поверх списка. Распорка внизу списка
// (высота = dockH + текущая высота клавиатуры) держит последнее
// сообщение над панелью; клэмп scrollTop — без чтения scrollHeight.
// В settle перестройки НЕТ вообще: все значения уже финальные.
let _imeR={dock:null,list:null,spacer:null,near:null,onSettle:null};
let _imePad=0,_imeNear=null,_imeDockH=0;
window.__rmgImeMoving=false; // true, пока длится IME-анимация (см. onScroll)
window.__rmgImeHasDock=()=>!!_imeR.dock; // нативный слой спрашивает, кому вести IME
window.__rmgImeFrame=(h,sys)=>{
  const pad=Math.max(0,(h||0)-(sys||0));
  window.__rmgImeMoving=true;
  if(!_imeR.dock)return;
  // «У низа?» и высоту дока захватываем ОДИН раз за анимацию.
  if(_imeNear===null){
    _imeNear=!!(_imeR.near&&_imeR.near());
    _imeDockH=_imeR.dock.offsetHeight||0;
  }
  _imePad=pad;
  _imeR.dock.style.transform=pad?`translateY(${-pad}px)`:"";
  if(_imeR.spacer)_imeR.spacer.style.height=Math.round(_imeDockH+pad)+"px";
  if(_imeNear){const el=_imeR.list;if(el)el.scrollTop=1000000000;}
};
window.__rmgImeSettle=(h,sys)=>{
  const pad=Math.max(0,(h||0)-(sys||0));
  window.__rmgImeMoving=false;
  if(_imeR.dock){
    _imeDockH=_imeR.dock.offsetHeight||0;
    _imePad=pad;
    _imeR.dock.style.transform=pad?`translateY(${-pad}px)`:"";
    if(_imeR.spacer)_imeR.spacer.style.height=Math.round(_imeDockH+pad)+"px";
    if(_imeNear){const el=_imeR.list;if(el)el.scrollTop=1000000000;}
  }
  _imeNear=null;
  if(_imeR.onSettle)_imeR.onSettle();
};
window.__rmgImeLayout=()=>{
  if(!_imeR.dock)return;
  _imeDockH=_imeR.dock.offsetHeight||0;
  if(_imeR.spacer)_imeR.spacer.style.height=Math.round(_imeDockH+_imePad)+"px";
};
window.rmgRegisterImeDock=(cfg)=>{
  _imeR={dock:cfg?.dock||null,list:cfg?.list||null,spacer:cfg?.spacer||null,near:cfg?.near||null,onSettle:cfg?.onSettle||null};
  _imePad=0;_imeNear=null;_imeDockH=0;window.__rmgImeMoving=false;
  if(_imeR.dock)_imeR.dock.style.transform="";
  if(_imeR.dock&&_imeR.spacer){
    _imeDockH=_imeR.dock.offsetHeight||0;
    _imeR.spacer.style.height=_imeDockH+"px";
  }
};

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
  const IconComp = type==="volume"?IcVolume:type==="brightness"?IcSun:(value>0?IcFastForward:IcFastRewind);
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
      <span style={{ display:"flex",alignItems:"center" }}><IconComp size={22} color="#fff"/></span>
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
              <span style={{ display:"flex",alignItems:"center" }}><IcVolume size={13} color="#fff"/></span>
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

function FileBubble({msg,fromMe,onOpenLightbox,chatId}){
  const {accent,text2,text}=useContext(ThemeCtx);
  const src=useMediaSrc(chatId,msg,msg.fileUrl||msg.fileData||"",msg.type==="video"?"video":msg.type==="image"?"image":"file");

  // Оболочка файла: сохранён офлайн без загрузки (тип "Только текстовые"
  // или файл превысил лимит размера). Показываем как есть, без скачивания.
  if(msg._shell&&!src){
    const shExt=(msg.fileName||"FILE").split(".").pop().toUpperCase().slice(0,5);
    return(
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:180,opacity:0.85}}>
        <div style={{width:44,height:44,borderRadius:12,
          background:fromMe?mineRgba(accent,0.14):accent+"22",
          display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <IcPaperclip size={20} color={fromMe?contrastOn(accent):accent}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:fromMe?mineRgba(accent,0.9):text,fontSize:13,fontWeight:600,
            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>
            {msg.fileName||(shExt!=="FILE"?shExt+"-файл":"Файл")}
          </div>
          <div style={{color:fromMe?mineRgba(accent,0.5):text2,fontSize:11,marginTop:2}}>
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
        background:fromMe?mineRgba(accent,0.18):accent+"33",
        display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <span style={{color:fromMe?contrastOn(accent):accent,fontSize:10,fontWeight:800}}>{ext}</span>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:fromMe?mineRgba(accent,0.9):text,fontSize:13,fontWeight:600,
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>
          {msg.fileName||"Файл"}
        </div>
        <div style={{color:fromMe?mineRgba(accent,0.5):text2,fontSize:11,marginTop:2}}>
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
  const mineDark=fromMe&&contrastOn(accent)==="#000";
  const mineSoft=(a)=>mineDark?`rgba(0,0,0,${a})`:`rgba(255,255,255,${a})`;
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
    <div style={{display:"flex",alignItems:"center",gap:6,borderLeft:`2.5px solid ${fromMe?mineSoft(0.5):accent}`,paddingLeft:7,marginBottom:6,opacity:0.88}}>
      {thumbSrc&&(
        <div style={{width:32,height:32,borderRadius:6,overflow:"hidden",flexShrink:0}}>
          {isCircle
            ? <video src={thumbSrc} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            : <img src={thumbSrc} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          }
        </div>
      )}
      {isVoice&&<IcMic size={15} color={fromMe?mineSoft(0.75):accent}/>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:fromMe?mineSoft(0.75):accent,fontSize:11,fontWeight:700,marginBottom:1}}>{msg.author}</div>
        <div style={{color:fromMe?mineSoft(0.55):text2,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>{preview}</div>
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

function fmtListenTime(totalSec){
  const h=Math.floor((totalSec||0)/3600), m=Math.floor(((totalSec||0)%3600)/60);
  if(!h&&!m)return "0 мин";
  return (h?`${h} ч `:"")+`${m} мин`;
}
function fmtJoinedDate(ms){
  if(!ms)return "";
  const d=new Date(ms);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}
const CREATOR_UID="738cdd2c759b7fd3204d9dffcae0e176";
const hasAllAchievements=u=>u?.uid===CREATOR_UID;
const achievementIsUnlocked=(u,id,condition=false)=>hasAllAchievements(u)||(Array.isArray(u?.achievementIds)&&u.achievementIds.includes(id))||condition;
const ach=(id,title,tier,desc,color,check,current=()=>0,target=1,extra={})=>({
  id,title,tier,desc,color,...extra,
  unlocked:u=>achievementIsUnlocked(u,id,check(u)),
  progress:u=>Math.min(1,current(u)/target),
  progressLabel:u=>target===1?(current(u)?"Готово":"0/1"):String(current(u))+"/"+String(target)+(extra.unit||"")
});

const ACHIEVEMENTS=[
  ach("avatar","Лицо с обложки","ОБЫЧНОЕ","Поставить фото или картинку на аватар","#8c96a3",u=>!!u.photo,u=>u.photo?1:0),
  ach("profile_complete","Расскажи о себе","ОБЫЧНОЕ","Полностью заполнить профиль","#8c96a3",u=>!!(u.photo&&u.name&&u.tag&&u.bio),u=>[u.photo,u.name,u.tag,u.bio].filter(Boolean).length,4),
  ach("first_contact","Первый контакт","ОБЫЧНОЕ","Добавить кого-нибудь в контакты","#8c96a3",u=>(u.contactsAddedCount||0)>0,u=>u.contactsAddedCount||0),
  ach("first_voice","Голос за кадром","ОБЫЧНОЕ","Отправить первое голосовое сообщение","#8c96a3",u=>(u.voiceMessagesSentCount||0)>0,u=>u.voiceMessagesSentCount||0),
  ach("photographer","Фотограф","ОБЫЧНОЕ","Отправить 10 фотографий","#8c96a3",u=>(u.photosSentCount||0)>=10,u=>u.photosSentCount||0,10),
  ach("reactions","Эмоции на максимум","ОБЫЧНОЕ","Поставить 10 разных реакций","#8c96a3",u=>(u.reactionTypes||[]).length>=10,u=>(u.reactionTypes||[]).length,10),
  ach("in_thread","В теме","ОБЫЧНОЕ","Ответить на сообщение через «Ответить»","#8c96a3",u=>!!u.hasReplied,u=>u.hasReplied?1:0),
  ach("pin","Закреп","ОБЫЧНОЕ","Закрепить сообщение или чат","#8c96a3",u=>!!u.hasPinned,u=>u.hasPinned?1:0),
  ach("custom_style","Свой стиль","ОБЫЧНОЕ","Сменить тему оформления","#f28c28",u=>!!u.hasChangedTheme,u=>u.hasChangedTheme?1:0),
  ach("night_owl","Ночная сова","ОБЫЧНОЕ","Отправить сообщение между 03:00 и 05:00","#32363d",u=>!!u.hasNightMessage,u=>u.hasNightMessage?1:0),
  ach("notes","Заметки на полях","ОБЫЧНОЕ","Сохранить 10 сообщений в «Избранное»","#8c96a3",u=>(u.favoritesSavedCount||0)>=10,u=>u.favoritesSavedCount||0,10),
  ach("dj","Диджей","ОБЫЧНОЕ","Поделиться треком с другом","#8c96a3",u=>!!u.hasSharedTrack,u=>u.hasSharedTrack?1:0),
  ach("login_streak","Вернулся!","ПРОДВИНУТОЕ","Заходить 90 дней подряд","#ff9f0a",u=>(u.loginStreak||0)>=90,u=>u.loginStreak||0,90,{unit:" дней",colorOf:u=>{const s=u.loginStreak||0;return s>=90?"#f28c28":s>=60?"#34c759":s>=30?"#ffd60a":"#8c96a3";}}),
  ach("social_soul","Душа компании","ПРОДВИНУТОЕ","Набрать 50 контактов","#34c759",u=>(u.contactsAddedCount||0)>=50,u=>u.contactsAddedCount||0,50),
  ach("referral","Сарафанное радио","ПРОДВИНУТОЕ","Пригласить 5 друзей, которые зарегистрировались","#0a84ff",u=>(u.referralsRegisteredCount||0)>=5,u=>u.referralsRegisteredCount||0,5),
  ach("organizer","Организатор","ЭЛИТНОЕ","Создать группу, в которой больше 100 участников","#f28c28",u=>(u.largestGroupMembers||0)>100,u=>u.largestGroupMembers||0,101),
  ach("talker","Болтун","ЭЛИТНОЕ","Отправить 10 000 сообщений","#ff453a",u=>(u.messagesSentCount||0)>=10000,u=>u.messagesSentCount||0,10000),
  ach("phoenix","Феникс","ЭЛИТНОЕ","Вернуться после 90 дней отсутствия","#f5f5f7",u=>!!u.hasReturnedAfter90Days,u=>u.hasReturnedAfter90Days?1:0),
  ach("veteran","Ветеран","ЭЛИТНОЕ","365 дней с мессенджером","#ff453a",u=>(u.accountAgeDays||0)>=365,u=>u.accountAgeDays||0,365,{unit:" дней"}),
  ach("founder","Основатель","ЭЛИТНОЕ","Быть в числе первых 1000 пользователей","#ff375f",u=>!!u.isFounder,u=>u.isFounder?1:0,1,{rainbow:true}),
  ach("team","Теперь на «мы»!","ЭКСКЛЮЗИВНОЕ","Быть в команде RedMrxGram","#f5f5f7",u=>!!u.isTeamMember,u=>u.isTeamMember?1:0,1,{exclusive:true}),
  ach("creator","Создатель","ЭКСКЛЮЗИВНОЕ","Создатель RedMrxGram","#f5f5f7",u=>u.uid===CREATOR_UID,u=>u.uid===CREATOR_UID?1:0,1,{exclusive:true}),
];
const ACHIEVEMENTS_PAGE_SIZE=4;
const ACHIEVEMENTS_EQUIP_CAP=15;
function ProfileView({uid,myUid,onClose,onStartChat,onProfileChange}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
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
  const[avatarBusy,setAvatarBusy]=useState(false);
  const[achPage,setAchPage]=useState(0);
  const[draftName,setDraftName]=useState("");
  const[draftTag,setDraftTag]=useState("");
  const[draftBio,setDraftBio]=useState("");
  const[profileSaving,setProfileSaving]=useState(false);
  const[profileError,setProfileError]=useState("");
  const isMe=uid===myUid;
  const avatarFileRef=useRef();
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
    // Свой профиль слушаем в реальном времени — счётчик прослушивания/пин трека
    // должны обновляться сразу без перезахода на экран.
    if(uid===myUid){
      return onSnapshot(doc(db,"users",uid),s=>{
        if(s.exists())setUser({uid,...s.data()});
      },()=>{});
    }
    getDoc(doc(db,"users",uid)).then(async s=>{
      const d=s.exists()?{uid,...s.data()}:null;
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
  },[uid,myUid]);

  useEffect(()=>{
    if(!myUid)return;
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
    if(!isMe||!user)return;
    setDraftName(user.name||"");
    setDraftTag(user.tag||"");
    setDraftBio(user.bio||"");
  },[isMe,user?.name,user?.tag,user?.bio]);

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
      updateDoc(doc(db,"users",myUid),{contactsAddedCount:increment(1)}).catch(()=>{});
    }catch(e){}
  };

  // ── Своя аватарка: смена/удаление прямо с экрана профиля ─────────────────
  // Та же логика ресайза в 300×300 base64, что и в EditProfile — фото
  // хранится прямо в документе пользователя, без отдельной загрузки на сервер.
  const pickAvatar=(e)=>{
    const file=e.target.files[0];if(!file)return;
    e.target.value="";
    setAvatarBusy(true);
    const url=URL.createObjectURL(file);
    const img=new Image();img.src=url;
    img.onerror=()=>{setAvatarBusy(false);URL.revokeObjectURL(url);};
    img.onload=async()=>{
      const canvas=document.createElement("canvas"),size=Math.min(img.width,img.height);
      canvas.width=300;canvas.height=300;
      canvas.getContext("2d").drawImage(img,(img.width-size)/2,(img.height-size)/2,size,size,0,0,300,300);
      const b64=canvas.toDataURL("image/jpeg",0.75);
      URL.revokeObjectURL(url);
      await saveAvatar(b64);
    };
  };
  const saveAvatar=async(photoOrNull)=>{
    const previousPhoto=user?.photo||null;
    setProfileError("");
    setUser(prev=>prev?{...prev,photo:photoOrNull}:prev);
    onProfileChange?.({photo:photoOrNull});
    try{
      await setDoc(doc(db,"users",myUid),{photo:photoOrNull,lastSeen:serverTimestamp()},{merge:true});
      await updateProfile(auth.currentUser,{photoURL:photoOrNull||""}).catch(()=>{});
      try{
        const chatsSnap=await getDocs(query(collection(db,"chats"),where("members","array-contains",myUid)));
        await Promise.all(chatsSnap.docs.map(d=>{
          const data=d.data();
          if(data.type==="direct"&&data.names?.[myUid])return updateDoc(d.ref,{[`photos.${myUid}`]:photoOrNull||""});
          return null;
        }).filter(Boolean));
      }catch(e2){}
    }catch(e){
      console.error("Avatar save error:",e);
      setUser(prev=>prev?{...prev,photo:previousPhoto}:prev);
      onProfileChange?.({photo:previousPhoto});
      setProfileError("Не удалось обновить фото профиля.");
    }finally{
      setAvatarBusy(false);
    }
  };
  const removeAvatar=async()=>{
    if(!user?.photo)return;
    if(!await appConfirm("Удалить фото профиля?","Удалить"))return;
    setAvatarBusy(true);
    await saveAvatar(null);
  };

  // ── Фон профиля (баннер за аватаркой) — отдельное поле bgPhoto, не квадрат:
  // ужимаем по ширине до 800px с сохранением пропорций, а не кропаем в квадрат.
  const[bgBusy,setBgBusy]=useState(false);
  const bgFileRef=useRef();
  const saveBackground=async(bgPhoto)=>{
    const previousBg=user?.bgPhoto||null;
    setProfileError("");
    setUser(prev=>prev?{...prev,bgPhoto}:prev);
    onProfileChange?.({bgPhoto});
    try{
      await setDoc(doc(db,"users",myUid),{bgPhoto},{merge:true});
    }catch(e){
      console.error("Profile background save error:",e);
      setUser(prev=>prev?{...prev,bgPhoto:previousBg}:prev);
      onProfileChange?.({bgPhoto:previousBg});
      setProfileError("Не удалось обновить фон профиля.");
    }finally{
      setBgBusy(false);
    }
  };
  const pickBg=(e)=>{
    const file=e.target.files[0];if(!file)return;
    e.target.value="";
    setBgBusy(true);
    const url=URL.createObjectURL(file);
    const img=new Image();img.src=url;
    img.onerror=()=>{setBgBusy(false);URL.revokeObjectURL(url);};
    img.onload=async()=>{
      const maxW=800,scale=Math.min(1,maxW/img.width);
      const w=Math.round(img.width*scale),h=Math.round(img.height*scale);
      const canvas=document.createElement("canvas");
      canvas.width=w;canvas.height=h;
      canvas.getContext("2d").drawImage(img,0,0,w,h);
      const b64=canvas.toDataURL("image/jpeg",0.75);
      URL.revokeObjectURL(url);
      await saveBackground(b64);
    };
  };
  const toggleBg=async()=>{
    if(bgBusy)return;
    if(user?.bgPhoto){
      if(!await appConfirm("Убрать фон профиля?","Убрать"))return;
      setBgBusy(true);
      await saveBackground(null);
    }else{
      bgFileRef.current?.click();
    }
  };

  const saveProfileDetails=async()=>{
    if(profileSaving)return;
    const name=draftName.trim()||user.name||"";
    const enteredTag=draftTag.trim().replace(/^@/,"").toLowerCase();
    const tag=enteredTag||user.tag||"";
    const bio=draftBio;
    const previous={name:user.name||"",tag:user.tag||"",bio:user.bio||""};
    const tagChanged=tag!==String(user.tag||"").toLowerCase();

    setProfileSaving(true);
    setProfileError("");
    try{
      if(tagChanged&&tag){
        const tagCheck=await getDocs(query(collection(db,"users"),where("tag","==",tag)));
        if(tagCheck.docs.some(d=>d.id!==myUid)){
          setProfileError(`@${tag} уже занят`);
          return;
        }
      }

      const patch={name,tag,bio};
      setUser(prev=>prev?{...prev,...patch}:prev);
      onProfileChange?.(patch);
      await setDoc(doc(db,"users",myUid),{...patch,lastSeen:serverTimestamp()},{merge:true});
      await updateProfile(auth.currentUser,{displayName:name}).catch(()=>{});

      try{
        const chatsSnap=await getDocs(query(collection(db,"chats"),where("members","array-contains",myUid)));
        await Promise.all(chatsSnap.docs.map(d=>{
          const data=d.data();
          if(data.type==="direct"&&data.names?.[myUid]){
            return updateDoc(d.ref,{[`names.${myUid}`]:name});
          }
          return null;
        }).filter(Boolean));
      }catch(e2){}
    }catch(e){
      console.error("Profile details save error:",e);
      setUser(prev=>prev?{...prev,...previous}:prev);
      onProfileChange?.(previous);
      setProfileError("Не удалось сохранить данные профиля.");
    }finally{
      setProfileSaving(false);
    }
  };

  const unpinTrack=async()=>{
    try{await setDoc(doc(db,"users",myUid),{pinnedTrack:null},{merge:true});}catch(e){}
  };

  // Значки под именем — теперь их выбирает сам пользователь ("одевает"/"снимает"),
  // а не просто показываются все разблокированные подряд. При первом заходе,
  // пока equippedIds ещё не задан, надеваем то, что уже разблокировано (не больше лимита),
  // дальше — только вручную через toggleEquip.
  useEffect(()=>{
    if(!isMe||!user)return;
    if(user.uid===CREATOR_UID){
      const allIds=ACHIEVEMENTS.map(a=>a.id);
      const equipped=["creator","team","founder","veteran","phoenix","talker","organizer","referral","social_soul","login_streak","night_owl","custom_style","dj","notes","reactions"];
      if((user.achievementIds||[]).length!==allIds.length||user.equippedIds==null){
        setDoc(doc(db,"users",myUid),{achievementIds:allIds,...(user.equippedIds==null?{equippedIds:equipped}:{})},{merge:true}).catch(()=>{});
      }
      return;
    }
    if(user.equippedIds!=null)return;
    const initial=ACHIEVEMENTS.filter(a=>a.unlocked(user)).slice(0,ACHIEVEMENTS_EQUIP_CAP).map(a=>a.id);
    if(!initial.length)return;
    setDoc(doc(db,"users",myUid),{equippedIds:initial},{merge:true}).catch(()=>{});
  },[isMe,myUid,user]);

  const toggleEquip=async(id)=>{
    if(!isMe)return;
    const cur=user.equippedIds||[];
    const next=cur.includes(id)?cur.filter(x=>x!==id):(cur.length>=ACHIEVEMENTS_EQUIP_CAP?cur:[...cur,id]);
    if(next===cur)return; // лимит достигнут — молча игнорируем
    try{await setDoc(doc(db,"users",myUid),{equippedIds:next},{merge:true});}catch(e){}
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
  const unlockedAchievements=ACHIEVEMENTS.filter(a=>a.unlocked(user));
  const pinnedIsPlaying=!!(user.pinnedTrack&&audio?.track?.id===user.pinnedTrack.id&&audio?.playing);
  const equippedAchievements=(user.equippedIds||[]).map(id=>ACHIEVEMENTS.find(a=>a.id===id)).filter(Boolean);
  const achPageCount=Math.ceil(ACHIEVEMENTS.length/ACHIEVEMENTS_PAGE_SIZE);
  const pagedAchievements=ACHIEVEMENTS.slice(achPage*ACHIEVEMENTS_PAGE_SIZE,(achPage+1)*ACHIEVEMENTS_PAGE_SIZE);

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:600,backgroundColor:"#050505",backgroundImage:`linear-gradient(180deg,${alphaColor(profileAccent,.2)} 0%,#050505 290px,${profileBg} 100%)`,
      display:"block",overflowY:"auto",overflowX:"hidden",
      animation:closing?"profileOut .24s cubic-bezier(0.4,0,0.2,1) forwards":"pageSlideIn 0.3s cubic-bezier(0.25,0.46,0.45,0.94)",
      WebkitAnimation:closing?"profileOut .24s cubic-bezier(0.4,0,0.2,1) forwards":"pageSlideIn 0.3s cubic-bezier(0.25,0.46,0.45,0.94)"}}>

      {showMenu&&<div onClick={()=>setShowMenu(false)} style={{position:"fixed",inset:0,zIndex:39,background:"transparent"}}/>}
      <input ref={avatarFileRef} type="file" accept="image/*" onChange={pickAvatar} style={{display:"none"}}/>
      <input ref={bgFileRef} type="file" accept="image/*" onChange={pickBg} style={{display:"none"}}/>

      <div style={{position:"relative",minHeight:286,padding:"calc(max(env(safe-area-inset-top,24px),24px) + 72px) 18px 20px",overflow:"hidden",
        background:`radial-gradient(circle at 50% -10%,${alphaColor(profileAccent,.42)} 0%,transparent 48%),linear-gradient(180deg,${alphaColor(profileAccent,.16)} 0%,rgba(0,0,0,.78) 72%,#050505 100%),#050505`}}>
        {user.bgPhoto&&(
          <>
            <img src={user.bgPhoto} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:0,pointerEvents:"none"}}/>
            <div style={{position:"absolute",inset:0,zIndex:1,pointerEvents:"none",
              background:`radial-gradient(circle at 50% -10%,${alphaColor(profileAccent,.32)} 0%,transparent 48%),linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,.82) 72%,#050505 100%)`}}/>
          </>
        )}
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:40,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"max(env(safe-area-inset-top,24px),24px) 18px 10px",background:`linear-gradient(180deg,${alphaColor(profileAccent,.36)} 0%,rgba(5,5,5,.82) 100%)`,backdropFilter:"blur(22px)",WebkitBackdropFilter:"blur(22px)",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
          <button onClick={requestClose} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}><IcChevronDown size={22} style={{transform:"rotate(90deg)"}}/></button>
          <div style={{color:"#fff",fontWeight:900,fontSize:24,letterSpacing:0}}>Профиль</div>
          {isMe?(
            <div style={{display:"flex",gap:8}}>
              <button onClick={toggleBg} disabled={bgBusy} style={{width:44,height:44,borderRadius:"50%",background:user.bgPhoto?"rgba(255,255,255,.22)":"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)",opacity:bgBusy?0.6:1}}>{user.bgPhoto?<IcTrash size={19}/>:<IcImageBg size={19}/>}</button>
              <button onClick={()=>avatarFileRef.current?.click()} disabled={avatarBusy} style={{width:44,height:44,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)",opacity:avatarBusy?0.6:1}}><IcImage size={20}/></button>
              <button onClick={removeAvatar} disabled={avatarBusy||!hasPhoto} style={{width:44,height:44,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)",opacity:(avatarBusy||!hasPhoto)?0.4:1}}><IcTrash size={20}/></button>
            </div>
          ):(
            <div style={{position:"relative"}}>
              <button onClick={e=>{e.stopPropagation();setShowMenu(m=>!m);}} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}><IcMoreH size={22}/></button>
              {showMenu&&(
                <div style={{position:"absolute",top:58,right:0,background:surface,border:`1px solid ${border}`,borderRadius:14,minWidth:190,boxShadow:"0 8px 30px rgba(0,0,0,0.6)",zIndex:41,overflow:"hidden"}} onClick={e=>e.stopPropagation()}>
                  {hasPhoto&&<button onClick={downloadAvatar} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:text,fontSize:14,borderBottom:`1px solid ${border}`}}><IcSetDownload size={17}/>Скачать фото</button>}
                  <button onClick={clearChat} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:text,fontSize:14,borderBottom:`1px solid ${border}`}}><IcTrash size={17}/>Очистить чат</button>
                  <button onClick={toggleBlock} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",color:"#FF3B30",fontSize:14}}><IcSetLock size={17} color="#FF3B30"/>{blocked?"Разблокировать":"Заблокировать"}</button>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{position:"relative",zIndex:2,display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center"}}>
          <button onClick={()=>profileStories.length&&setProfileViewer({items:profileStories,startIndex:0})} style={{position:"relative",background:"transparent",border:"none",padding:0,cursor:profileStories.length?"pointer":"default",fontFamily:"inherit"}}>
            <div style={{width:116,height:116,borderRadius:"50%",padding:profileStories.length?3:0,background:profileStories.length?`linear-gradient(135deg,${profileAccent},${accent2})`:"transparent"}}>
              <Avatar name={user.name||"?"} photo={user.photo} size={116}/>
            </div>
            {profileStories.length>0&&<div style={{position:"absolute",right:4,bottom:5,width:26,height:26,borderRadius:"50%",background:accent,color:"#fff",border:`3px solid #050505`,display:"flex",alignItems:"center",justifyContent:"center"}}><IcAddCircle size={16} color="#fff"/></div>}
          </button>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:18}}>
            <div style={{color:"#fff",fontWeight:1000,fontSize:30,lineHeight:1.08,letterSpacing:0}}>{user.name}</div>
          </div>
          <div style={{color:profileAccent,fontSize:18,fontWeight:800,marginTop:7}}>@{user.tag}</div>
          <div style={{color:"rgba(255,255,255,.55)",fontSize:15,marginTop:8,lineHeight:1.35}}>{user.bio||"Анонимный пользователь"}</div>

          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,marginTop:14}}>
            <div style={{color:"rgba(255,255,255,.75)",fontSize:14,fontWeight:700}}>{fmtListenTime(user.totalListenSec)} прослушано</div>
          </div>

          {equippedAchievements.length>0&&(
            <div style={{display:"flex",flexWrap:"wrap",justifyContent:"center",gap:8,marginTop:16}}>
              {equippedAchievements.map(a=>{
                const bc=(typeof a.colorOf==="function"?a.colorOf(user):null)||a.color||profileAccent;
                return(
                <div key={a.id} style={{padding:"9px 16px",borderRadius:20,
                  background:a.exclusive?"linear-gradient(110deg,#050505 0%,#343434 34%,#050505 52%,#555 72%,#050505 100%)":(a.rainbow?"linear-gradient(110deg,#ff375f,#ff9f0a,#34c759,#0a84ff,#bf5af2)":alphaColor(bc,.28)),
                  backgroundSize:(a.exclusive||a.rainbow)?"220% 100%":undefined,animation:(a.exclusive||a.rainbow)?"creatorSheen 3.5s linear infinite":undefined,
                  border:a.exclusive?"1px solid rgba(255,255,255,.52)":("1px solid "+alphaColor(bc,.72)),color:"#fff",fontSize:13,fontWeight:700,
                  boxShadow:a.exclusive?"0 0 14px rgba(255,255,255,.2),inset 0 1px rgba(255,255,255,.16)":("0 0 12px "+alphaColor(bc,.22))}}>{a.title}</div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{padding:"14px 14px max(env(safe-area-inset-bottom,18px),18px)"}} onClick={()=>setShowMenu(false)}>
        {isMe&&(
          <div style={{background:profileSurface,borderRadius:16,padding:"14px",marginBottom:12,animation:"fadeUp 0.4s ease 0.06s both"}}>
            <div style={{color:text2,fontSize:11,fontWeight:800,letterSpacing:.8,marginBottom:12}}>ДАННЫЕ ПРОФИЛЯ</div>
            {profileError&&<div style={{background:"rgba(229,57,53,.14)",border:"1px solid rgba(229,57,53,.46)",borderRadius:10,padding:"9px 11px",color:"#ff6b6b",fontSize:13,marginBottom:12}}>{profileError}</div>}
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div>
                <label style={{display:"block",color:text2,fontSize:11,fontWeight:700,marginBottom:5}}>ИМЯ</label>
                <input value={draftName} maxLength={64} onChange={e=>{setDraftName(e.target.value);setProfileError("");}} style={{width:"100%",boxSizing:"border-box",background:surface2,border:`1px solid ${border}`,borderRadius:10,padding:"11px 12px",color:text,fontSize:15,outline:"none",fontFamily:"inherit"}}/>
              </div>
              <div>
                <label style={{display:"block",color:text2,fontSize:11,fontWeight:700,marginBottom:5}}>ЮЗЕРНЕЙМ</label>
                <div style={{display:"flex",alignItems:"center",background:surface2,border:`1px solid ${border}`,borderRadius:10,overflow:"hidden"}}>
                  <span style={{color:profileAccent,padding:"0 10px 0 12px",fontSize:16,fontWeight:800}}>@</span>
                  <input value={draftTag} maxLength={32} onChange={e=>{setDraftTag(e.target.value.replace(/^@/,"").replace(/[^a-z0-9_]/gi,"").toLowerCase());setProfileError("");}} style={{flex:1,minWidth:0,background:"transparent",border:"none",padding:"11px 12px 11px 0",color:text,fontSize:15,outline:"none",fontFamily:"inherit"}}/>
                </div>
              </div>
              <div>
                <label style={{display:"block",color:text2,fontSize:11,fontWeight:700,marginBottom:5}}>О СЕБЕ</label>
                <textarea value={draftBio} maxLength={240} rows={3} onChange={e=>{setDraftBio(e.target.value);setProfileError("");}} style={{width:"100%",boxSizing:"border-box",background:surface2,border:`1px solid ${border}`,borderRadius:10,padding:"11px 12px",color:text,fontSize:14,outline:"none",fontFamily:"inherit",resize:"none"}}/>
              </div>
              <button onClick={saveProfileDetails} disabled={profileSaving} style={{minHeight:44,display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:profileSaving?surface2:`linear-gradient(135deg,${profileAccent},${accent2})`,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:800,cursor:profileSaving?"default":"pointer",fontFamily:"inherit",opacity:profileSaving?0.72:1}}>
                <IcCheckOne size={17} color="#fff"/>{profileSaving?"Сохраняю...":"Сохранить"}
              </button>
            </div>
          </div>
        )}
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

        {user.pinnedTrack&&(
          <div style={{background:profileSurface,borderRadius:16,padding:"12px 14px",marginBottom:12,animation:"fadeUp 0.4s ease 0.09s both"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6,color:text2,fontSize:11,fontWeight:800,letterSpacing:.8}}>
                <IcPin size={13} color={text2}/>ЗАКРЕПЛЁННЫЙ ТРЕК
              </div>
              {isMe&&<button onClick={unpinTrack} style={{background:"none",border:"none",color:profileAccent,fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Открепить</button>}
            </div>
            <button onClick={()=>pinnedIsPlaying?audio.pause():audio.playTrack(user.pinnedTrack)}
              style={{display:"flex",alignItems:"center",gap:12,width:"100%",background:"transparent",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",textAlign:"left",WebkitTapHighlightColor:"transparent",transition:"transform 0.15s"}}
              onMouseDown={e=>e.currentTarget.style.transform="scale(0.98)"}
              onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
              onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}
              onTouchStart={e=>e.currentTarget.style.transform="scale(0.98)"}
              onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>
              <div style={{width:52,height:52,borderRadius:12,background:`linear-gradient(135deg,${profileAccent}88,${accent2}66)`,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",flexShrink:0}}>
                {user.pinnedTrack.coverUrl?<img src={user.pinnedTrack.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<IcMusicNote size={22} color="#fff"/>}
              </div>
              <div style={{minWidth:0,flex:1}}>
                <div style={{color:text,fontWeight:800,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.pinnedTrack.name||"Трек"}</div>
                <div style={{color:text2,fontSize:12,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.pinnedTrack.author||""}</div>
              </div>
              <div style={{width:36,height:36,borderRadius:"50%",background:pinnedIsPlaying?profileAccent:surface2,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.2s"}}>
                {pinnedIsPlaying?<IcAudioPause size={16} color={contrastOn(profileAccent)}/>:<IcAudioPlay size={16}/>}
              </div>
            </button>
          </div>
        )}

        <div style={{background:profileSurface,borderRadius:16,padding:"14px 16px",marginBottom:12,animation:"fadeUp 0.4s ease 0.11s both"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <div style={{display:"flex",alignItems:"center",gap:8,color:text,fontWeight:900,fontSize:16}}><IcTrophy size={18} color={profileAccent}/>Достижения</div>
            <div style={{color:text2,fontSize:12,fontWeight:700}}>Открыто {unlockedAchievements.length} из {ACHIEVEMENTS.length}</div>
          </div>
          {achPageCount>1&&(
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:8}}>
              <button onClick={()=>setAchPage(p=>Math.max(0,p-1))} disabled={achPage===0} style={{background:"none",border:"none",cursor:achPage===0?"default":"pointer",opacity:achPage===0?0.3:1,display:"flex",alignItems:"center",justifyContent:"center",width:28,height:28}}><IcChevronDown size={18} color={text2} style={{transform:"rotate(90deg)"}}/></button>
              <div style={{color:text2,fontSize:11,fontWeight:700}}>{achPage+1} / {achPageCount}</div>
              <button onClick={()=>setAchPage(p=>Math.min(achPageCount-1,p+1))} disabled={achPage===achPageCount-1} style={{background:"none",border:"none",cursor:achPage===achPageCount-1?"default":"pointer",opacity:achPage===achPageCount-1?0.3:1,display:"flex",alignItems:"center",justifyContent:"center",width:28,height:28}}><IcChevronDown size={18} color={text2} style={{transform:"rotate(-90deg)"}}/></button>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {pagedAchievements.map(a=>{
              const done=a.unlocked(user);
              const frac=a.progress(user);
              const equipped=(user.equippedIds||[]).includes(a.id);
              const exclusive=done&&(a.exclusive||a.rainbow);
              const ac=(typeof a.colorOf==="function"?a.colorOf(user):null)||a.color||profileAccent;
              return(
                <div key={a.id} style={{background:exclusive?"linear-gradient(110deg,#050505 0%,#2d2d2d 34%,#050505 52%,#454545 72%,#050505 100%)":(done?surface2:"transparent"),backgroundSize:exclusive?"220% 100%":undefined,animation:exclusive?"creatorSheen 3.5s linear infinite":undefined,border:`1px solid ${exclusive?"rgba(255,255,255,.48)":(done?alphaColor(ac,.5):"transparent")}`,borderRadius:14,padding:"12px 14px",opacity:done?1:0.75,boxShadow:exclusive?"0 0 18px rgba(255,255,255,.16),inset 0 1px rgba(255,255,255,.13)":(done?`0 0 14px ${alphaColor(ac,.16)}`:undefined)}}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                    <div style={{width:40,height:40,borderRadius:"50%",background:exclusive?"linear-gradient(135deg,#080808,#666,#080808)":(done?(a.rainbow?"linear-gradient(135deg,#ff375f,#ff9f0a,#34c759,#0a84ff,#bf5af2)":`linear-gradient(135deg,${ac},${alphaColor(ac,.66)})`):surface2),border:exclusive?"1px solid rgba(255,255,255,.52)":"none",boxShadow:exclusive?"none":(done?`0 0 10px ${alphaColor(ac,.35)}`:"none"),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      {done?<IcStar size={18} color="#fff"/>:<IcSetLock size={16} color={text2}/>}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                        <div style={{color:done?text:text2,fontWeight:800,fontSize:14}}>{a.title}</div>
                        <div style={{color:text2,fontSize:10,fontWeight:800,letterSpacing:.6,whiteSpace:"nowrap"}}>{a.tier}</div>
                      </div>
                      <div style={{color:text2,fontSize:12.5,marginTop:3}}>{a.desc}</div>
                      {!done&&(
                        <div style={{marginTop:8}}>
                          <div style={{height:5,borderRadius:3,background:border,overflow:"hidden"}}>
                            <div style={{height:"100%",width:(frac*100)+"%",borderRadius:3,background:`linear-gradient(90deg,${alphaColor(ac,.75)},${ac})`}}/>
                          </div>
                          <div style={{textAlign:"right",color:text2,fontSize:11,marginTop:4}}>{a.progressLabel(user)}</div>
                        </div>
                      )}
                      {done&&isMe&&(
                        <button onClick={()=>toggleEquip(a.id)} style={{marginTop:6,background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",
                          color:equipped?"#4CAF50":profileAccent,fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:5}}>
                          {equipped?<><IcCheckOne size={13} color="#4CAF50"/>Надето — снять</>:"Надеть"}
                        </button>
                      )}
                      {done&&!isMe&&<div style={{color:"#4CAF50",fontSize:12,fontWeight:700,marginTop:4,display:"flex",alignItems:"center",gap:5}}><IcCheckOne size={13} color="#4CAF50"/>Получено</div>}
                    </div>
                  </div>
                </div>
              );

            })}
          </div>
        </div>

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
            <IcTag size={20} color={profileAccent}/>
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
            <button onClick={()=>navigator.clipboard?.writeText(profileLink).catch(()=>{})} style={{flex:1,padding:"12px 10px",borderRadius:14,border:`1px solid ${border}`,background:surface2,color:text,fontWeight:800,fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><IcCopy size={16} color={text}/>Копировать</button>
            <button onClick={()=>{if(navigator.share)navigator.share({title:user.name,text:user.name,url:profileLink}).catch(()=>{});else navigator.clipboard?.writeText(profileLink).catch(()=>{});}} style={{flex:1,padding:"12px 10px",borderRadius:14,border:"none",background:`linear-gradient(135deg,${profileAccent},${accent2})`,color:"#fff",fontWeight:900,fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><IcShareOut size={16} color="#fff"/>Поделиться</button>
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
              <IcSend size={17} color="#fff"/>Написать сообщение
            </button>
            <button onClick={addProfileContact} disabled={contactAdded}
              style={{padding:"14px",background:contactAdded?surface2:"transparent",
                border:`1.5px solid ${contactAdded?border:profileAccent}`,borderRadius:16,
                color:contactAdded?text2:profileAccent,fontSize:15,fontWeight:800,
                cursor:contactAdded?"default":"pointer",fontFamily:"inherit",
                display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              {contactAdded?<><IcCheckOne size={16} color={text2}/>В контактах</>:"Добавить в контакты"}
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
      if(type==="group")updateDoc(doc(db,"users",currentUser.uid),{hasCreatedGroup:true}).catch(()=>{});
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
  const[closing,setClosing]=useState(false);
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
  const requestClose=useCallback(()=>{
    if(closing)return;
    setClosing(true);
  },[closing]);
  const finishClose=useCallback(e=>{
    if(closing&&e.animationName==="chatSlideOut")onClose?.();
  },[closing,onClose]);
  useEffect(()=>{
    const closeFromSystemBack=()=>requestClose();
    window.addEventListener("rmg-chat-modal-close",closeFromSystemBack);
    return()=>window.removeEventListener("rmg-chat-modal-close",closeFromSystemBack);
  },[requestClose]);
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
      setTimeout(requestClose,350);
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
    <div onAnimationEnd={finishClose} style={{position:"fixed",inset:0,zIndex:800,background:surface,overflowY:"auto",overflowX:"hidden",willChange:"transform",animation:closing?"chatSlideOut .48s cubic-bezier(0.32,0.72,0,1) forwards":"chatSlideIn .32s cubic-bezier(0.32,0.72,0,1) both",WebkitAnimation:closing?"chatSlideOut .48s cubic-bezier(0.32,0.72,0,1) forwards":"chatSlideIn .32s cubic-bezier(0.32,0.72,0,1) both"}}>
      <div style={{minHeight:"100%",background:surface}}>
        <div style={{position:"sticky",top:0,zIndex:2,background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:10,padding:"14px 16px"}}>
          <button onClick={requestClose} style={{width:38,height:38,borderRadius:"50%",border:`1px solid ${border}`,background:surface2,color:text,fontSize:20,cursor:"pointer"}}>←</button>
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
  const[closing,setClosing]=useState(false);
  const[closeToSettings,setCloseToSettings]=useState(false);
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

  const requestClose=useCallback(()=>{
    if(closing)return;
    setClosing(true);
  },[closing]);
  useEffect(()=>{
    const closeFromSystemBack=()=>requestClose();
    window.addEventListener("rmg-chat-modal-close",closeFromSystemBack);
    return()=>window.removeEventListener("rmg-chat-modal-close",closeFromSystemBack);
  },[requestClose]);

  const requestOpenSettings=useCallback(()=>{
    if(closing)return;
    setCloseToSettings(true);
    setClosing(true);
  },[closing]);
  const finishClose=useCallback(e=>{
    if(!closing||e.animationName!=="chatSlideOut")return;
    onClose?.();
    if(closeToSettings)onOpenSettings?.();
  },[closing,closeToSettings,onClose,onOpenSettings]);

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
    <div onAnimationEnd={finishClose} style={{position:"fixed",inset:0,zIndex:790,background:`linear-gradient(180deg,${alphaColor(tone,.22)} 0%,#050505 300px,${bg||"#050505"} 100%)`,overflowY:"auto",overflowX:"hidden",willChange:"transform",animation:closing?"chatSlideOut .48s cubic-bezier(0.32,0.72,0,1) forwards":"chatSlideIn .32s cubic-bezier(0.32,0.72,0,1) both",WebkitAnimation:closing?"chatSlideOut .48s cubic-bezier(0.32,0.72,0,1) forwards":"chatSlideIn .32s cubic-bezier(0.32,0.72,0,1) both"}} onClick={e=>e.stopPropagation()}>
      <div style={{position:"relative",padding:"max(env(safe-area-inset-top,24px),24px) 18px 20px",background:`radial-gradient(circle at 50% -10%,${alphaColor(tone,.42)} 0%,transparent 48%),linear-gradient(180deg,${alphaColor(tone,.16)} 0%,rgba(0,0,0,.78) 72%,#050505 100%),#050505`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <button onClick={requestClose} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>←</button>
          <div style={{color:"#fff",fontWeight:900,fontSize:23,letterSpacing:0}}>{isChannel?"Канал":"Группа"}</div>
          <button onClick={canManage?requestOpenSettings:shareLink} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.1)",color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(18px)",WebkitBackdropFilter:"blur(18px)"}}>{canManage?"⚙":"↗"}</button>
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
            <IcLink size={20} color={tone}/>
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
          <button onClick={requestOpenSettings} style={{width:"100%",padding:"14px",border:"none",borderRadius:16,background:`linear-gradient(135deg,${tone},${accent2})`,color:"#fff",fontWeight:900,fontSize:15,fontFamily:"inherit",boxShadow:`0 4px 16px ${alphaColor(tone,.28)}`}}>Настройки и аватарка</button>
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
          <IcWarning size={48} color="#ff6b6b"/>
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
            <div style={{marginBottom:16,display:"flex",justifyContent:"center"}}><IcMusicNote size={52} color="#E53935"/></div>
            <div style={{color:"#fff",fontWeight:600,fontSize:15,marginBottom:20,wordBreak:"break-word"}}>{fileName}</div>
            <audio src={src} controls style={{width:"100%"}}/>
            <button onClick={download} disabled={downloading} style={{marginTop:16,background:"#E53935",border:"none",borderRadius:14,padding:"12px 24px",color:"#fff",fontSize:14,fontWeight:700,cursor:downloading?"default":"pointer",width:"100%",opacity:downloading?0.6:1,transition:"opacity 0.2s",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>{downloading?"Сохраняем…":(<><IcAudioDownload size={16}/>Скачать</>)}</button>
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
// Поле экрана входа: иконка + нижняя линия. Обязательно объявлен вне
// AuthScreen — если такой компонент создаётся заново на каждый рендер,
// React считает его "другим" компонентом и пересоздаёт <input> в DOM при
// каждом нажатии клавиши, из-за чего слетает фокус и закрывается клавиатура.
function AuthField({icon,children}){
  return(
    <div className="rmg-auth-field" style={{display:"flex",alignItems:"center",gap:12,borderBottom:"1.5px solid #2a2a2e",padding:"10px 2px"}}>
      <span style={{color:"#8f8f96",display:"flex",flexShrink:0}}>{icon}</span>
      {children}
    </div>
  );
}
function AuthScreen({onAuth}){
  // Экран входа всегда монохромный (тёмный фон, белые акценты) — не зависит
  // от темы приложения: свою тему пользователь выбирает уже после входа.
  const bg="#0a0a0a",border="#2a2a2e",text="#ffffff",text2="#8f8f96",accent="#ffffff",accent2="#ffffff",surface2="#18181b";
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
  // Поле ввода — просто нижняя линия + иконка слева, без рамки-коробки
  const inp={background:"transparent",border:"none",padding:"2px 0",color:text,fontSize:15.5,outline:"none",fontFamily:"inherit",width:"100%",boxSizing:"border-box"};
  const focusField=e=>{e.currentTarget.parentElement.style.borderColor=accent;};
  const blurField=e=>{e.currentTarget.parentElement.style.borderColor=border;};
  const[authOnline,setAuthOnline]=useState(navigator.onLine);
  useEffect(()=>{
    const up=()=>setAuthOnline(true),dn=()=>setAuthOnline(false);
    window.addEventListener("online",up);window.addEventListener("offline",dn);
    return()=>{window.removeEventListener("online",up);window.removeEventListener("offline",dn);};
  },[]);
  const canSubmit=mode==="login"?!!(loginId.trim()&&pass):mode==="register"?!!(name.trim()&&email.trim()&&pass):mode==="verify"?code.trim().length===6:mode==="reset"?!!(loginId.trim()||email.trim()):mode==="reset_confirm"?!!(code.trim().length===6&&pass.length>=6):!!email.trim();
  return(
    <div onMouseDown={e=>{if(e.target===e.currentTarget)e.preventDefault();}} style={{minHeight:"100vh",background:bg,position:"relative",overflow:"hidden"}}>
      <style>{`.rmg-auth-field{transition:border-color 0.2s}`}</style>
      {!authOnline&&<OfflineBar fixed/>}
      {/* Мягкое радиальное свечение сверху — акцентным цветом темы */}
      <div style={{position:"absolute",top:-120,left:"50%",transform:"translateX(-50%)",width:520,height:420,background:`radial-gradient(closest-side, ${accent}30, transparent)`,pointerEvents:"none"}}/>
      <div onMouseDown={e=>{if(e.target===e.currentTarget)e.preventDefault();}} style={{position:"relative",maxWidth:400,margin:"0 auto",padding:"64px 24px 40px",animation:"fadeIn 0.4s ease"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:30}}>
          <div style={{width:44,height:44,borderRadius:13,background:"linear-gradient(145deg,#1a0000,#060000)",border:"1.5px solid #FF000088",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 6px 20px #FF000044"}}>
            <svg width="26" height="26" viewBox="0 0 80 80" fill="none">
              <defs><linearGradient id="authLogoGrad" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#FF4444"/><stop offset="50%" stopColor="#FF0000"/><stop offset="100%" stopColor="#CC0000"/></linearGradient></defs>
              <path d="M8 68 L8 20 L24 20 L40 48 L56 20 L72 20 L72 68 L60 68 L60 38 L44 64 L36 64 L20 38 L20 68 Z" fill="url(#authLogoGrad)"/>
            </svg>
          </div>
          <div>
            <div style={{color:text,fontWeight:800,fontSize:21,lineHeight:1.15}}>MrX</div>
            <div key={"sub-"+mode} style={{color:text2,fontSize:12.5,animation:"authFadeSlide 0.32s cubic-bezier(0.22,0.61,0.36,1) both"}}>{mode==="login"?"Войди в аккаунт":mode==="register"?"Создай аккаунт":mode==="verify"?"Подтверди почту":mode==="reset"?"Сброс пароля":mode==="reset_confirm"?"Новый пароль":"Привяжи почту"}</div>
          </div>
        </div>
        {(mode==="login"||mode==="register")&&(
          <div style={{position:"relative",display:"flex",background:surface2,borderRadius:999,padding:4,marginBottom:26}}>
            <div style={{position:"absolute",top:4,bottom:4,left:4,width:"calc(50% - 4px)",borderRadius:999,background:"#fff",transition:"transform 0.32s cubic-bezier(0.65,0,0.35,1)",transform:mode==="register"?"translateX(100%)":"translateX(0)"}}/>
            <button onClick={()=>{switchMode("login");setErr("");setInfo("");}} style={{flex:1,position:"relative",zIndex:1,padding:"11px 0",border:"none",background:"none",borderRadius:999,fontFamily:"inherit",fontSize:14,fontWeight:700,cursor:"pointer",color:mode==="login"?"#0a0a0a":text2,transition:"color 0.25s"}}>Вход</button>
            <button onClick={()=>{switchMode("register");setErr("");setInfo("");}} style={{flex:1,position:"relative",zIndex:1,padding:"11px 0",border:"none",background:"none",borderRadius:999,fontFamily:"inherit",fontSize:14,fontWeight:700,cursor:"pointer",color:mode==="register"?"#0a0a0a":text2,transition:"color 0.25s"}}>Регистрация</button>
          </div>
        )}
        {mode==="register"&&<div style={{display:"flex",justifyContent:"center",marginBottom:18}}><Avatar name={name||"?"} size={64}/></div>}
        <div key={"fields-"+mode} onMouseDown={e=>{if(e.target===e.currentTarget)e.preventDefault();}} style={{display:"flex",flexDirection:"column",gap:16,marginBottom:14,animation:(modeAnim==="out"?"authFadeOutUp 0.16s ease both":"authFieldIn 0.32s cubic-bezier(0.22,0.61,0.36,1) both")}}>
          {mode==="register"&&<>
            <AuthField icon={<IcUserAuth size={19}/>}><input value={name} onChange={e=>setName(e.target.value)} placeholder="Отображаемое имя" style={inp} onFocus={focusField} onBlur={blurField}/></AuthField>
            <AuthField icon={<span style={{fontSize:17,fontWeight:700}}>@</span>}><input value={tag} onChange={e=>setTag(e.target.value.replace(/^@/,"").replace(/\s/,""))} placeholder="Имя пользователя" style={inp} onFocus={focusField} onBlur={blurField}/></AuthField>
            <AuthField icon={<IcMailAuth size={18}/>}><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" style={inp} onFocus={focusField} onBlur={blurField}/></AuthField>
          </>}
          {mode==="login"&&<AuthField icon={<IcMailAuth size={18}/>}><input value={loginId} onChange={e=>setLoginId(e.target.value)} placeholder="Email" type="text" style={inp} onFocus={focusField} onBlur={blurField}/></AuthField>}
          {mode==="reset"&&<AuthField icon={<IcMailAuth size={18}/>}><input value={loginId} onChange={e=>setLoginId(e.target.value)} placeholder="@юзернейм или почта" type="text" style={inp} onFocus={focusField} onBlur={blurField}/></AuthField>}
          {mode==="reset_confirm"&&<>
            <div style={{color:text2,fontSize:13,lineHeight:1.55}}>Код отправлен на<br/><b style={{color:text}}>{resetEmail}</b><br/>Письма нет? Загляни в папку «Спам».</div>
            <AuthField icon={<IcCircleOutline size={18}/>}><input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="Код из письма" inputMode="numeric" onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,letterSpacing:6,fontSize:19,fontWeight:800}} onFocus={focusField} onBlur={blurField}/></AuthField>
            <AuthField icon={<IcLockAuth size={18}/>}>
              <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Новый пароль (мин. 6 символов)" type={showPass?"text":"password"} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp} onFocus={focusField} onBlur={blurField}/>
              <button onMouseDown={e=>e.preventDefault()} onClick={()=>setShowPass(s=>!s)} style={{background:"none",border:"none",cursor:"pointer",color:text2,display:"flex",alignItems:"center",flexShrink:0}}>{showPass?<IcEyeOff size={17}/>:<IcEye size={17}/>}</button>
            </AuthField>
          </>}
          {mode==="attach"&&<>
            <div style={{color:text2,fontSize:13,lineHeight:1.55}}>Теперь для входа нужна почта — это защита от фейков. Укажи её один раз: придёт код подтверждения, и дальше входи как обычно (по @юзернейму или почте).</div>
            <AuthField icon={<IcMailAuth size={18}/>}><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Твоя почта" type="email" onKeyDown={e=>e.key==="Enter"&&submit()} style={inp} onFocus={focusField} onBlur={blurField}/></AuthField>
          </>}
          {mode==="verify"&&<>
            <div style={{color:text2,fontSize:13,lineHeight:1.55}}>Мы отправили 6-значный код на<br/><b style={{color:text}}>{pendingEmail}</b><br/>Письма нет? Загляни в папку «Спам».</div>
            <AuthField icon={<IcCircleOutline size={18}/>}><input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="Код из письма" inputMode="numeric" onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,letterSpacing:6,fontSize:19,fontWeight:800}} onFocus={focusField} onBlur={blurField}/></AuthField>
          </>}
          {(mode==="login"||mode==="register")&&(
            <AuthField icon={<IcLockAuth size={18}/>}>
              <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Пароль" type={showPass?"text":"password"} onKeyDown={e=>e.key==="Enter"&&submit()} style={inp} onFocus={focusField} onBlur={blurField}/>
              <button onMouseDown={e=>e.preventDefault()} onClick={()=>setShowPass(s=>!s)} style={{background:"none",border:"none",cursor:"pointer",color:text2,display:"flex",alignItems:"center",flexShrink:0}}>{showPass?<IcEyeOff size={17}/>:<IcEye size={17}/>}</button>
            </AuthField>
          )}
        </div>
        {mode==="login"&&<div style={{textAlign:"right",marginTop:-8,marginBottom:18}}>
          <span onMouseDown={e=>e.preventDefault()} onClick={()=>{setLoginId("");setPass("");setErr("");setInfo("");switchMode("reset");}} style={{color:text2,fontSize:12.5,cursor:"pointer"}}>Забыли пароль?</span>
        </div>}
        {info&&<div style={{background:"#00c85315",border:"1px solid #00c85333",borderRadius:12,padding:"9px 13px",color:"#7be3a3",fontSize:13,marginBottom:14,display:"flex",alignItems:"center",gap:8}}><IcSend size={14}/>{info}</div>}
        {err&&<div style={{background:"#ff00001a",border:"1px solid #ff000033",borderRadius:12,padding:"9px 13px",color:"#ff6b6b",fontSize:13,marginBottom:14,animation:"shake 0.3s ease",display:"flex",alignItems:"center",gap:8}}><IcWarning size={14} color="#ff6b6b"/>{err}</div>}
        <button onClick={submit} disabled={loading||!canSubmit} style={{width:"100%",padding:16,background:canSubmit?"#fff":surface2,border:"none",borderRadius:16,color:canSubmit?"#0a0a0a":text2,fontSize:15,fontWeight:800,cursor:canSubmit?"pointer":"default",fontFamily:"inherit",marginBottom:18,transition:"transform 0.15s cubic-bezier(0.34,1.56,0.64,1), background 0.2s"}} onMouseDown={e=>{e.preventDefault();if(canSubmit)e.currentTarget.style.transform="scale(0.97)";}} onMouseUp={e=>e.currentTarget.style.transform="scale(1)"} onTouchStart={e=>{if(canSubmit)e.currentTarget.style.transform="scale(0.97)";}} onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>
          {loading?"Подождите…":mode==="login"?"Войти":mode==="register"?"Зарегистрироваться":mode==="verify"?"Подтвердить":mode==="reset"?"Отправить код":mode==="reset_confirm"?"Сохранить пароль":"Получить код"}
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
        <div style={{display:"flex",alignItems:"center",gap:10,margin:"6px 0 20px"}}>
          <div style={{flex:1,height:1,background:border}}/><span style={{color:text2,fontSize:12}}>или войдите через</span><div style={{flex:1,height:1,background:border}}/>
        </div>
        <div style={{display:"flex",justifyContent:"center",marginBottom:22}}>
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
          }} title="Войти анонимно" style={{width:56,height:56,borderRadius:"50%",background:"#fff",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.2s"}}
            onMouseDown={e=>{e.preventDefault();e.currentTarget.style.transform="scale(0.93)";}}
            onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>
            <IcGhost size={24} color="#0a0a0a"/>
          </button>
        </div>
        <div style={{textAlign:"center",marginTop:-10}}>
          <span onMouseDown={e=>e.preventDefault()} onClick={()=>{if(showHelp){setHelpClosing(true);setTimeout(()=>{setShowHelp(false);setHelpClosing(false);},440);}else{setShowHelp(true);}}} style={{color:text2,fontSize:12,cursor:"pointer",textDecoration:"underline",display:"inline-flex",alignItems:"center",gap:4,transition:"color 0.2s"}}><IcHelpQ size={13}/> Как войти? <span style={{display:"inline-block",transition:"transform 0.3s cubic-bezier(0.34,1.56,0.64,1)",transform:(showHelp&&!helpClosing)?"rotate(180deg)":"rotate(0deg)",fontSize:10}}>▾</span></span>
          {showHelp&&<div style={{textAlign:"left",background:surface2,border:`1px solid ${border}`,borderRadius:12,padding:"11px 13px",color:text2,fontSize:12.5,lineHeight:1.6,marginTop:8,overflow:"hidden",animation:helpClosing?"authHelpClose 0.45s cubic-bezier(0.65,0,0.35,1) both":"authHelpOpen 0.55s cubic-bezier(0.32,0.72,0,1) both",transformOrigin:"top center"}}>
            <b style={{color:text}}>Впервые здесь?</b><br/>1. Нажми «Регистрация» вверху<br/>2. Придумай имя, @юзернейм и пароль, укажи свою почту<br/>3. Введи код из письма — и готово!<br/><br/>
            <b style={{color:text}}>Уже есть аккаунт?</b><br/>Вводи свой @юзернейм (он написан в твоём профиле) или почту — и пароль.<br/><br/>
            <b style={{color:text}}>Забыл юзернейм?</b><br/>Просто войди по почте.<br/><br/><b style={{color:text}}>Забыл пароль?</b><br/>Нажми «Забыли пароль?» над кнопкой входа — введи @юзернейм или почту, получи код, придумай новый пароль.
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
          {err&&<div style={{background:"rgba(229,57,53,0.14)",border:"1.5px solid #E53935",borderRadius:13,padding:"10px 14px",color:"#E53935",fontSize:13,marginBottom:14,wordBreak:"break-word",whiteSpace:"pre-wrap",display:"flex",alignItems:"flex-start",gap:8}}><IcWarning size={14} color="#E53935"/><span>{err}</span></div>}
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
function Msg({msg,myUid,prevMsg,usersCache,chatPhotos,onAvatarClick,onReply,onLongPress,onLongPressEnd,onOpenLightbox,onCircleFs,msgFontSize=14,idx,audioMsgs,chatId}){
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
        <CircleBubble msg={msg} onFullscreen={onCircleFs} chatId={chatId}/>
      </div>
    );
    if(isSticker)return(
      <div style={{fontSize:52,lineHeight:1,userSelect:"none",filter:"drop-shadow(0 2px 8px rgba(0,0,0,0.3))"}}
        onTouchStart={onPStart} onTouchMove={onPMove} onTouchEnd={onPEnd} onMouseDown={onPStart} onMouseUp={onPEnd}>
        {msg.text}
      </div>
    );
    const mineFg=fromMe?contrastOn(accent):text;
    const mineSoft=(a)=>mineFg==="#000"?`rgba(0,0,0,${a})`:`rgba(255,255,255,${a})`;
    const bubbleStyle={
      background:fromMe?`linear-gradient(135deg,${accent},${accent2})`:surface2,
      borderRadius:fromMe?"20px 20px 4px 20px":"20px 20px 20px 4px",
      // Видео — тонкая обводка (3px), а не толстая «коробка» из 9/13px.
      // Цвет не трогаем, меняется только визуальная толщина рамки.
      padding:msg.type==="video"?"3px"
        :msg.type==="voice"||msg.type==="file"?"10px 12px"
        :"9px 13px",
      color:mineFg,fontSize:msgFontSize||14,lineHeight:1.55,
      boxShadow:fromMe?`0 3px 14px ${accent}40`:"0 1px 5px rgba(0,0,0,0.18)",
      wordBreak:"break-word",maxWidth:"100%",
    };
    return(
      <div style={bubbleStyle} onTouchStart={onPStart} onTouchMove={onPMove} onTouchEnd={onPEnd} onMouseDown={onPStart} onMouseUp={onPEnd}>
        {msg.forwarded&&(
          <div style={{fontSize:11,fontWeight:700,color:fromMe?mineSoft(0.65):accent,marginBottom:4,display:"flex",alignItems:"center",gap:4}}>
            ↪️ Переслано
          </div>
        )}
        {msg.replyTo&&<ReplyInBubble msg={msg.replyTo} fromMe={fromMe}/>}
        {msg.reactions&&Object.values(msg.reactions||{}).length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:4}}>
            {[...new Set(Object.values(msg.reactions))].map(r=>{
              const cnt=Object.values(msg.reactions).filter(x=>x===r).length;
              return <span key={r} style={{background:fromMe?mineSoft(0.15):"rgba(255,255,255,0.15)",borderRadius:10,padding:"1px 6px",fontSize:12}}>{r}{cnt>1&&<span style={{fontSize:10,marginLeft:2}}>{cnt}</span>}</span>;
            })}
          </div>
        )}
        {msg.type==="voice"?<VoiceBubble msg={msg} fromMe={fromMe} chatId={chatId}/>
          :msg.type==="audio"?<AudioBubble msg={msg} fromMe={fromMe} audioMsgs={audioMsgs} chatId={chatId}/>
          :msg.type==="image"||msg.type==="file"?<FileBubble msg={msg} fromMe={fromMe} onOpenLightbox={onOpenLightbox} chatId={chatId}/>
          :msg.type==="video"?<FileBubble msg={msg} fromMe={fromMe} onOpenLightbox={onOpenLightbox} chatId={chatId}/>
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
            {Ico:IcGlobe,lbl:"Сайт",url:"https://redmrxgram.work.gd",display:"redmrxgram.work.gd"},
            {Ico:IcSend,lbl:"Канал",url:"https://t.me/redmrxgram",display:"t.me/redmrxgram"},
            {Ico:IcMusicNote,lbl:"TikTok",url:"https://tiktok.com/@redmrxgram",display:"tiktok.com/@redmrxgram"},
            {Ico:IcRobot,lbl:"Бот",url:"https://t.me/redmrx_bot",display:"t.me/redmrx_bot"},
          ].map((r,i,arr)=>(
            <a key={i} href={r.url} target="_blank" rel="noopener noreferrer"
              style={{display:"flex",alignItems:"center",gap:14,padding:"13px 16px",
                borderBottom:i<arr.length-1?`1px solid ${border}44`:"none",
                textDecoration:"none",WebkitTapHighlightColor:"transparent"}}
              onTouchStart={e=>e.currentTarget.style.background=surface2}
              onTouchEnd={e=>e.currentTarget.style.background="transparent"}>
              <span style={{width:28,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:accent}}><r.Ico size={20}/></span>
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
function AudioFullPlayerOverlay({currentUser}){
  const audio=useContext(AudioCtx);
  if(!audio||!audio.showFullPlayer||!audio.track)return null;
  return <AudioPlayerScreen currentUser={currentUser}/>;
}

// Копит реальное время прослушивания (тикает раз в секунду, только пока играет)
// и периодически шлёт дельту на сервер через increment() — атомарно, без гонок
// между несколькими устройствами одного аккаунта. Рендерится один раз в корне.
function ListenTimeTracker({uid}){
  const audio=useContext(AudioCtx);
  const pendingRef=useRef(0);
  const uidRef=useRef(uid);
  uidRef.current=uid;

  const flush=useCallback(()=>{
    const sec=Math.floor(pendingRef.current);
    if(sec<=0||!uidRef.current)return;
    pendingRef.current-=sec;
    updateDoc(doc(db,"users",uidRef.current),{totalListenSec:increment(sec)}).catch(()=>{
      pendingRef.current+=sec; // не ушло — вернём в копилку, попробуем на следующем тике
    });
  },[]);

  useEffect(()=>{
    if(!audio?.playing||!uid)return;
    const tick=setInterval(()=>{pendingRef.current+=1;},1000);
    const flushTimer=setInterval(flush,20000);
    return()=>{clearInterval(tick);clearInterval(flushTimer);flush();};
  },[audio?.playing,uid,flush]);

  useEffect(()=>{
    const onHide=()=>flush();
    document.addEventListener("visibilitychange",onHide);
    window.addEventListener("beforeunload",onHide);
    return()=>{document.removeEventListener("visibilitychange",onHide);window.removeEventListener("beforeunload",onHide);flush();};
  },[flush]);

  return null;
}

// AudioMiniBar — renders MiniPlayer inline in screen layouts (below headers)
function AudioMiniBar(){
  const audio=useContext(AudioCtx);
  if(!audio)return null;
  if(audio.miniPhase==="hidden")return null;
  return <MiniPlayer/>;
}

// ─── Mini Music Player (global, like Telegram) ────────────────────────────────
function MiniPlayer(){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  if(!audio)return null;
  const phase=audio.miniPhase; // entering|shown|exiting
  const snap=audio.miniSnap;
  const live=audio.track?audio:null;
  const track=live?live.track:snap?.track;
  if(!track)return null;
  const playing=live?live.playing:(snap?.playing||false);
  const progress=live?live.progress:(snap?.progress||0);
  const queue=live?live.queue:(snap?.queue||[]);
  const idx=live?live.idx:(snap?.idx||0);
  const {openFullPlayer,closeMini,play,pause,next,prev}=audio;
  const hasPrev=idx>0||(audio.repeat==="all"&&queue.length>1);
  const hasNext=idx<queue.length-1||(audio.repeat==="all"&&queue.length>1)||audio.shuffle;
  const collapsed=phase==="entering"||phase==="exiting";

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
          pointerEvents:collapsed?"none":"auto",
          opacity:collapsed?0:1,
          transform:collapsed?"translateY(-100%) scale(0.96)":"translateY(0) scale(1)",
          transformOrigin:"top center",
          transition:"opacity 0.32s cubic-bezier(.32,.72,0,1),transform 0.32s cubic-bezier(.32,.72,0,1)",
        }}>
        {/* Album art */}
        <div style={{width:34,height:34,borderRadius:9,flexShrink:0,overflow:"hidden",
          background:`linear-gradient(135deg,${accent},${accent2})`,
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:playing?`0 0 10px ${accent}55`:"none",transition:"box-shadow 0.3s",
        }}>
          {track.coverUrl
            ?<img src={track.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            :<IcMusicNote size={16} color="#fff"/>}
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
            <button className="rmg-audio-btn" onClick={e=>{e.stopPropagation();prev();}}
              style={{width:32,height:32,borderRadius:"50%",border:"none",cursor:"pointer",
                background:"none",color:hasPrev?text:text2+"44",
                display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioPrev size={18}/></button>
          )}
          <button className="rmg-audio-btn" onClick={e=>{e.stopPropagation();playing?pause():play();}}
            style={{width:36,height:36,borderRadius:"50%",border:"none",cursor:"pointer",
              background:`linear-gradient(135deg,${accent},${accent2})`,
              color:"#fff",
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:`0 2px 8px ${accent}55`,
              "--rmg-accent-a":`${accent}55`,"--rmg-accent-b":`${accent}44`,
              animation:playing?"rmgPlayPulse 1.8s ease-out infinite":"none"}}>
            {playing?<IcAudioPause size={18}/>:<IcAudioPlay size={18}/>}
          </button>
          {(hasPrev||hasNext)&&(
            <button className="rmg-audio-btn" onClick={e=>{e.stopPropagation();next();}}
              style={{width:32,height:32,borderRadius:"50%",border:"none",cursor:"pointer",
                background:"none",color:hasNext?text:text2+"44",
                display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioNext size={18}/></button>
          )}
          <button className="rmg-audio-btn" onClick={e=>{e.stopPropagation();closeMini();}}
            style={{width:32,height:32,borderRadius:"50%",border:"none",cursor:"pointer",
              background:"none",color:text2,
              display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioClose size={16}/></button>
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
              animation:`rmgRowIn 0.3s cubic-bezier(.22,1,.36,1) both`,
              animationDelay:`${Math.min(i,8)*0.03}s`,
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
              display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",
              transition:"background 0.2s"}}
              onClick={()=>!isDragging&&isActive===false&&AUDIO_ENGINE.jumpTo(i)}>
              {isActive?(playing?<IcAudioPause size={16}/>:<IcAudioPlay size={16}/>):<IcMusicNote size={15} color={text2}/>}
            </div>
            {/* Info */}
            <div style={{flex:1,minWidth:0}}
              onClick={()=>!isDragging&&!isActive&&AUDIO_ENGINE.jumpTo(i)}>
              <div style={{color:isActive?accent:text,fontSize:13,fontWeight:isActive?700:500,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",transition:"color 0.2s"}}>
                {t.name||"Аудио"}
              </div>
              <div style={{color:text2,fontSize:10,marginTop:1}}>
                {t.ext||"MP3"}{t.size?" · "+t.size:""}
              </div>
            </div>
            {/* Remove */}
            <button className="rmg-audio-btn" onClick={e=>{e.stopPropagation();audio.removeFromQueue(i);}}
              style={{width:28,height:28,borderRadius:"50%",border:"none",cursor:"pointer",
                background:"none",color:text2,flexShrink:0,
                display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioClose size={13}/></button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Full Audio Player Screen ────────────────────────────────────────────────
function AudioPlayerScreen({currentUser}){
  const {surface,surface2,border,text,text2,accent,accent2,bg}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  const [visible,setVisible]=useState(false);
  const [dragging,setDragging]=useState(false);
  const [activeTab,setActiveTab]=useState("player"); // "player" | "queue"
  const [showSpeedPopup,setShowSpeedPopup]=useState(false);
  const [liked,setLiked]=useState(false);
  const [buffered,setBuffered]=useState(0);
  const [pinnedId,setPinnedId]=useState(null);
  const [pinBusy,setPinBusy]=useState(false);
  const seekBarRef=useRef(null);

  useEffect(()=>{requestAnimationFrame(()=>setVisible(true));},[]);

  const trackId=audio?.track?.id;
  useEffect(()=>{setLiked(false);setShowSpeedPopup(false);},[trackId]);

  // Следим за закреплённым треком в профиле, чтобы кнопка "Закрепить"
  // сразу показывала актуальное состояние (в т.ч. если открепили с экрана профиля).
  useEffect(()=>{
    if(!currentUser?.uid)return;
    return onSnapshot(doc(db,"users",currentUser.uid),s=>{
      setPinnedId(s.exists()?(s.data()?.pinnedTrack?.id||null):null);
    },()=>{});
  },[currentUser?.uid]);

  const togglePin=async()=>{
    if(!currentUser?.uid||!audio?.track||pinBusy)return;
    setPinBusy(true);
    try{
      const t=audio.track;
      if(pinnedId===t.id){
        await setDoc(doc(db,"users",currentUser.uid),{pinnedTrack:null},{merge:true});
      }else{
        await setDoc(doc(db,"users",currentUser.uid),{pinnedTrack:{id:t.id,name:t.name||"",author:t.author||"",coverUrl:t.coverUrl||"",src:t.src||"",ext:t.ext||""}},{merge:true});
      }
    }catch(e){}
    setPinBusy(false);
  };

  // Отслеживаем буферизацию аудиоэлемента
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
      if(showSpeedPopup){setShowSpeedPopup(false);return true;}
      setVisible(false);
      setTimeout(()=>audio.closeFullPlayer(),300);
      return true;
    };
    _audioBackHandler=closeByBack;
    return()=>{if(_audioBackHandler===closeByBack)_audioBackHandler=null;};
  },[audio?.showFullPlayer,audio?.track?.id,audio?.closeFullPlayer,showSpeedPopup]);

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
      {/* Header */}
      <div style={{
        display:"flex",alignItems:"center",justifyContent:"space-between",
        paddingTop:"max(env(safe-area-inset-top,28px),28px)",
        paddingLeft:16,paddingRight:16,paddingBottom:14,
        flexShrink:0,position:"relative",zIndex:1,
      }}>
        <button className="rmg-audio-btn" onClick={close} style={{width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",
          background:surface2,color:text,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <IcChevronDown size={22}/>
        </button>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:20,
          background:surface2,color:text,fontSize:13,fontWeight:700}}>
          <IcMusicNote size={15}/>
          Плеер
        </div>
        <button className="rmg-audio-btn" onClick={()=>setShowSpeedPopup(v=>!v)} style={{width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",
          background:surface2,color:text,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <IcMoreH size={22}/>
        </button>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",padding:"0 24px",gap:28,flexShrink:0,position:"relative",zIndex:1}}>
        {[["player","Плеер"],["queue",`Очередь${queue.length?" ("+queue.length+")":""}`]].map(([key,label])=>(
          <button key={key} onClick={()=>setActiveTab(key)} style={{background:"none",border:"none",cursor:"pointer",
            fontFamily:"inherit",padding:"0 0 10px",fontSize:15,fontWeight:700,
            color:activeTab===key?text:text2}}>
            {label}
            <div style={{marginTop:8,height:3,borderRadius:2,background:activeTab===key?text:"transparent"}}/>
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div style={{flex:1,overflowY:"auto",paddingBottom:"max(env(safe-area-inset-bottom,20px),20px)",position:"relative",zIndex:1}}>
        {activeTab==="queue"?(
          <div style={{padding:"12px 24px 0",animation:"rmgQueueOpen 0.32s cubic-bezier(.22,1,.36,1) both"}}>
            <QueueList queue={queue} idx={idx} playing={playing} accent={accent} accent2={accent2} surface2={surface2} text={text} text2={text2} border={border} audio={audio}/>
          </div>
        ):(<>
        {/* Artwork */}
        <div style={{display:"flex",justifyContent:"center",padding:"20px 32px 24px"}}>
          <div style={{
            width:"min(320px,78vw)",height:"min(320px,78vw)",
            borderRadius:20,
            background:`linear-gradient(135deg,${accent}88,${accent2}66)`,
            display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:"0 20px 50px rgba(0,0,0,0.5)",
            overflow:"hidden",flexShrink:0,
          }}>
            {track.coverUrl
              ?<img src={track.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :<IcMusicNote size={64} color="#fff"/>}
          </div>
        </div>

        {/* Track info */}
        <div style={{padding:"0 24px",display:"flex",alignItems:"center",gap:12,marginBottom:22}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{color:text,fontSize:20,fontWeight:800,marginBottom:4,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {track.name||"Аудио"}
            </div>
            <div style={{color:text2,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {track.author||track.ext||"MP3"}{track.size?" · "+track.size:""}
            </div>
          </div>
          <button className="rmg-audio-btn" style={{width:34,height:34,borderRadius:8,border:"none",cursor:"pointer",background:"none",
            color:text2,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <IcDeviceSm size={19}/>
          </button>
          <button className={"rmg-audio-btn rmg-audio-toggle"+(liked?" on":"")} onClick={()=>setLiked(v=>!v)} style={{width:34,height:34,borderRadius:8,border:"none",cursor:"pointer",background:"none",
            color:liked?accent:text2,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <IcHeart size={20}/>
          </button>
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
              background:text2+"55",
              borderRadius:2,transition:"width 0.5s linear"}}/>
            {/* Playback progress bar */}
            <div style={{position:"absolute",left:0,top:0,height:"100%",
              width:(progress*100)+"%",
              background:text,
              borderRadius:2}}/>
            {/* Thumb */}
            <div style={{position:"absolute",top:"50%",left:(progress*100)+"%",
              transform:"translate(-50%,-50%)",
              width:dragging?18:12,height:dragging?18:12,
              borderRadius:"50%",background:text,
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
          padding:"8px 16px 20px"}}>
          <button className={"rmg-audio-btn rmg-audio-toggle"+(shuffle?" on":"")} onClick={()=>audio.setShuffle(!shuffle)}
            style={{width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",
              background:"none",color:shuffle?accent:text2,
              display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioShuffle size={20}/></button>
          <button className="rmg-audio-btn" onClick={()=>audio.prev()}
            style={{width:48,height:48,borderRadius:"50%",border:"none",cursor:"pointer",
              background:"none",color:text,
              display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioPrev size={28}/></button>
          <button className="rmg-audio-btn rmg-audio-btn-lg" onClick={()=>playing?audio.pause():audio.play()}
            style={{width:64,height:64,borderRadius:"50%",border:"none",cursor:"pointer",
              background:text,color:bg,
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:"0 6px 20px rgba(0,0,0,0.35)",
              "--rmg-accent-a":"rgba(0,0,0,0.35)","--rmg-accent-b":"rgba(0,0,0,0.35)",
              animation:playing?"rmgPlayPulse 1.8s ease-out infinite":"none"}}>
            {playing?<IcAudioPause size={26}/>:<IcAudioPlay size={26}/>}
          </button>
          <button className="rmg-audio-btn" onClick={()=>audio.next()}
            style={{width:48,height:48,borderRadius:"50%",border:"none",cursor:"pointer",
              background:"none",color:text,
              display:"flex",alignItems:"center",justifyContent:"center"}}><IcAudioNext size={28}/></button>
          <button className={"rmg-audio-btn rmg-audio-toggle"+(repeatActive?" on":"")} onClick={nextRepeat}
            style={{width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",
              background:"none",color:repeatActive?accent:text2,
              display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
            <IcAudioRepeat size={20}/>
            {repeat==="one"&&<span style={{position:"absolute",bottom:2,fontSize:8,color:accent,fontWeight:800}}>1</span>}
          </button>
        </div>

        {/* Bottom secondary actions */}
        <div style={{display:"flex",justifyContent:"space-evenly",padding:"4px 16px 8px"}}>
          {[
            {icon:IcPin,label:pinnedId===trackId?"Открепить":"Закрепить",onClick:togglePin,disabled:pinBusy||!currentUser?.uid,active:pinnedId===trackId},
            {icon:IcSpeedGauge,label:"Скорость",onClick:()=>setShowSpeedPopup(true),disabled:false,valueBadge:formatSpeed(speed)},
            {icon:IcEqualizer,label:"Эквалайзер",onClick:()=>{},disabled:true},
          ].map(({icon:Icon,label,onClick,disabled,valueBadge,active},i)=>(
            <button key={i} className="rmg-audio-btn" onClick={disabled?undefined:onClick} style={{background:"none",border:"none",
              cursor:disabled?"default":"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",
              alignItems:"center",gap:6,opacity:disabled&&!active?0.4:1,padding:"4px 8px"}}>
              <div style={{width:44,height:44,borderRadius:"50%",background:active?accent:surface2,
                display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                <Icon size={19} color={active?bg:text}/>
                {valueBadge&&<span style={{position:"absolute",bottom:-4,right:-4,background:accent,color:bg,
                  fontSize:9,fontWeight:800,borderRadius:8,padding:"1px 4px"}}>{valueBadge}</span>}
              </div>
              <span style={{color:active?accent:text2,fontSize:11}}>{label}</span>
            </button>
          ))}
        </div>
        </>)}
      </div>

      {/* Speed popover */}
      {showSpeedPopup&&(
        <div onClick={()=>setShowSpeedPopup(false)} style={{position:"fixed",inset:0,zIndex:10,
          background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",background:surface,
            borderRadius:"20px 20px 0 0",padding:"20px 20px max(env(safe-area-inset-bottom,20px),20px)",
            animation:"rmgQueueOpen 0.28s cubic-bezier(.22,1,.36,1) both"}}>
            <div style={{color:text,fontWeight:700,fontSize:15,marginBottom:14}}>Скорость воспроизведения</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {SPEEDS.map(s=>(
                <button key={s} className="rmg-audio-btn" onClick={()=>{audio.setSpeed(s);setShowSpeedPopup(false);}}
                  style={{padding:"8px 16px",borderRadius:20,border:`1.5px solid ${speed===s?accent:border}`,
                    cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,
                    background:speed===s?accent:"none",
                    color:speed===s?bg:text2}}>
                  {formatSpeed(s)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Chat Screen ──────────────────────────────────────────────────────────────
function ChatScreen({isActive=true,chat,currentUser,profile,onBack,onViewProfile,showToast,wallpaperId,msgFontSize=14,chats=[]}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const audio=useContext(AudioCtx);
  const[msgs,setMsgs]=useState([]);
  const audioMsgs=useMemo(()=>msgs.filter(m=>m.type==="audio"&&!m.deletedForAll&&!m.deletedFor?.[currentUser.uid]),[msgs,currentUser.uid]);
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
  const[attachMounted,setAttachMounted]=useState(false);
  const[attachClosing,setAttachClosing]=useState(false);
  useEffect(()=>{
    let t;
    if(showAttach){
      setAttachMounted(true);
      setAttachClosing(false);
    } else if(attachMounted){
      setAttachClosing(true);
      t=setTimeout(()=>{setAttachMounted(false);setAttachClosing(false);},200);
    }
    return ()=>{if(t)clearTimeout(t);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[showAttach]);
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
  const bottomRef=useRef(),timerRef=useRef(),mediaRef=useRef(),voiceStreamRef=useRef(null),chunksRef=useRef([]),inputRef=useRef(),lastCntRef=useRef(0),fileRef=useRef(),lpVoiceRef=useRef(null),galleryRef=useRef(null),localSendingRef=useRef({}),quickRecordStartedRef=useRef(false),confirmedTempIdsRef=useRef(new Set());

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
  // ── IME: чат регистрируется в механизме «док поверх списка»:
  // панель ввода абсолютная и ездит transform'ом ПОВЕРХ всегда-fullного
  // списка сообщений; распорка внизу списка держит последнее сообщение
  // над панелью. Корень чата никогда не меняет размеры → чёрной полосе
  // (пустому фону за клавиатурой) неоткуда взяться, и в settle нет
  // перестройки вообще.
  const imeDockRef=useRef(null), imeSpacerRef=useRef(null);
  useEffect(()=>{
    if(typeof window.rmgRegisterImeDock!=="function")return;
    const anchor=()=>{
      const el=msgsRef.current;
      if(el&&isNearBottomRef.current)el.scrollTop=1000000000;
    };
    window.rmgRegisterImeDock({
      dock:imeDockRef.current,
      list:msgsRef.current,
      spacer:imeSpacerRef.current,
      near:()=>isNearBottomRef.current,
      onSettle:anchor,
    });
    return()=>{window.rmgRegisterImeDock({});};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // Флаг: пользователь у низа чата (последние ~5 сообщений)
  const isNearBottomRef=useRef(true);
  // Счётчик новых сообщений пока пользователь не у низа
  const [newMsgCount, setNewMsgCount] = useState(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(()=>{
    const vv=window.visualViewport;
    if(!vv)return;
    let settleTimer;
    let settleFrame=null;
    const settleAtBottom=()=>{
      // Клэмп к низу: большое значение scrollTop браузер сам ограничит
      // по текущему низу, без чтения scrollHeight из JS.
      settleFrame=requestAnimationFrame(()=>{
        settleFrame=null;
        const el=msgsRef.current;
        if(el&&isNearBottomRef.current)el.scrollTop=1000000000;
      });
    };
    const onResize=()=>{
      // На Android движет нативный механизм (__rmgImeFrame/__rmgImeSettle) —
      // этот браузерный путь пропускаем (в браузере/PWA работает как раньше).
      if(window.Capacitor?.isNativePlatform?.())return;
      // НЕ пересчитываем isNearBottomRef здесь — onScroll уже выставил его
      // корректно в момент когда пользователь реально прокручивал.
      if(isNearBottomRef.current){
        clearTimeout(settleTimer);
        settleTimer=setTimeout(settleAtBottom,120);
      }
    };
    vv.addEventListener("resize",onResize);
    return()=>{
      vv.removeEventListener("resize",onResize);
      clearTimeout(settleTimer);
      if(settleFrame!==null)cancelAnimationFrame(settleFrame);
    };
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
      if(window.Capacitor?.isNativePlatform()) NativePush.removeAllDeliveredNotifications().catch(()=>{});
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
  // Компенсация «прыжка» переписки при появлении/исчезновении мини-плеера
  // над списком сообщений. Мини-плеер — сосед скролл-контейнера в flex-
  // колонке, и когда он появляется, контейнер сообщений СЖИМАЕТСЯ по
  // высоте, а scrollTop остаётся прежним в пикселях — из-за этого, если
  // пользователь был внизу переписки, вид визуально «съезжает» и требует
  // долистать руками. Подгоняем scrollTop сразу же, синхронно с изменением
  // раскладки (useLayoutEffect — до отрисовки кадра, без видимого прыжка).
  useLayoutEffect(()=>{
    const el=msgsRef.current;
    if(!el)return;
    if(isNearBottomRef.current){
      el.scrollTop=el.scrollHeight;
    }
  },[audio?.miniPhase]);
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
        const list=snap.docs.map(d=>({id:d.id,...d.data()}));

        const isFirstLoad=firestoreFirstLoad.current;
        if(isFirstLoad){
          // Первый ответ от Firestore — блокируем кэш и требуем прокрутку вниз.
          // oldestDocRef/hasOlder тоже выставляем ТОЛЬКО здесь: это единственный
          // момент, когда окно «последние 20» совпадает с полным списком,
          // который у нас загружен. На последующих срабатываниях этого же
          // слушателя (например, из-за readBy на одном из последних 20
          // сообщений) трогать их нельзя — иначе пагинация «откатывается»
          // назад к границе последних 20 при каждом чужом прочтении.
          if(snap.docs.length>0)oldestDocRef.current=snap.docs[0];
          if(snap.docs.length<20)setHasOlder(false);
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
        if(isFirstLoad){
          // Первая загрузка — заменяем целиком (кэш уже отработал своё выше).
          setMsgs(locals.length?[...list,...locals]:list);
        }else{
          // Последующие срабатывания слушателя «последних 20» — СЛИВАЕМ с уже
          // загруженной историей, а не затираем её. Иначе любое сообщение
          // старше этого окна (загруженное через loadOlderMsgs при скролле
          // вверх) пропадает при первом же изменении в последних 20
          // документах (новое сообщение, readBy, реакция и т.п.) —
          // из-за этого переписка «то грузится, то нет».
          const freshIds=new Set(list.map(m=>m.id));
          setMsgs(prev=>{
            const older=prev.filter(m=>
              !freshIds.has(m.id)&&
              !locals.some(l=>l.id===m.id)&&
              // Гонка: оптимистичное сообщение (tmp_...) ещё не успело
              // переименоваться в реальный id (см. sendMsg), а слушатель уже
              // принёс это же сообщение в list — без этой проверки на экране
              // на секунду появляются два одинаковых сообщения.
              !(String(m.id||"").startsWith("tmp_")&&confirmedTempIdsRef.current.has(m.id))
            );
            const merged=[...older,...list,...locals];
            merged.sort((a,b)=>{
              const ta=a.createdAt?.seconds?a.createdAt.seconds*1000:(a.unixMs||0);
              const tb=b.createdAt?.seconds?b.createdAt.seconds*1000:(b.unixMs||0);
              return ta-tb;
            });
            return merged;
          });
        }
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

    // Если чат был скрыт у меня («удалён»), снимаем скрытие ТОЛЬКО сейчас —
    // при реальной отправке сообщения, а не просто при открытии чата/профиля.
    try{
      const hk="rmg_hidden_chats_"+currentUser.uid;
      const hm=readHidden(hk);
      if(hm[chat.id]){delete hm[chat.id];localStorage.setItem(hk,JSON.stringify(hm));}
    }catch(e){}

    try{
      const ref = await addDoc(collection(db,"chats",chat.id,"messages"),payload);
      // Заменяем временное на реальное (onSnapshot тоже придёт, но ключ совпадёт).
      // Если живой слушатель уже успел принести этот же документ (гонка с
      // WebSocket — часто на нестабильной связи), НЕ переименовываем tempId в
      // ref.id (это дало бы два сообщения с одинаковым id на экране), а просто
      // убираем временную заглушку — настоящая копия уже в списке.
      confirmedTempIdsRef.current.add(tempId);
      setMsgs(prev=>{
        const hasReal=prev.some(m=>m.id===ref.id);
        if(hasReal)return prev.filter(m=>m.id!==tempId);
        return prev.map(m=>m.id===tempId?{...m,id:ref.id,_pending:false}:m);
      });
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
        // Если чат был скрыт у меня («удалён»), снимаем скрытие ИМЕННО здесь —
        // при реальной отправке сообщения, а не просто при открытии чата/
        // профиля. Пишем в сам документ чата (не только localStorage), чтобы
        // отметка синхронизировалась между устройствами и не терялась при
        // переустановке приложения. (deleteField недоступен в локальной
        // обёртке firestore — просто перезаписываем в null, isHiddenChat
        // трактует falsy-значение как «не скрыт».)
        ["hiddenFor."+currentUser.uid]:null,
        ...unreadUpdate,
        ...(allMembers.length>0?{members:allMembers}:{})
      }).catch(()=>{});

      // Счётчики для достижений профиля — не блокируют отправку, тихо игнорируем ошибку.
      updateDoc(doc(db,"users",currentUser.uid),{
        messagesSentCount:increment(1),
        ...(extra.type==="voice"?{voiceMessagesSentCount:increment(1)}:{})
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
      background:linear-gradient(135deg,${accent},${accent2});
      color:${contrastOn(accent)==="#000"?"#000":"#fff"};
      padding:9px 13px;
      border-radius:20px 20px 4px 20px;
      font-size:14px;
      line-height:1.55;
      max-width:72vw;
      word-break:break-word;
      box-shadow:0 3px 14px ${accent}66;
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
  // Перемеряем распорку дока, когда меняется высота панели (эмодзи/attach,
  // ответ/редактирование/запись голосового) или право записи. Стоит ПОСЛЕ
  // объявления canWrite — в deps он вычисляется на рендере (раньше стоял
  // выше объявления и падал с "Cannot access before initialization").
  useLayoutEffect(()=>{
    if(typeof window.__rmgImeLayout==="function")window.__rmgImeLayout();
  },[showEmoji,showAttach,replyTo,editMsg,recording,uploading,canWrite]);
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
      if(showChatInfo||showChatSettings){window.dispatchEvent(new Event("rmg-chat-modal-close"));return true;}
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
            // Во время движения клавиатуры список крутится программно
            // (IME-механизм якорит низ) — пропускаем всю тяжёлую обработку,
            // она всё равно не нужна, пока пользователь не скроллит сам.
            if(window.__rmgImeMoving)return;
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
            return <Msg key={m.id||i} msg={{...m,_partnerAllowsReceipts:partnerData?.readReceipts!==false&&getS("readReceipts")!==false}} myUid={currentUser.uid} prevMsg={i>0?msgs[i-1]:null} usersCache={usersCache} chatPhotos={chatData?.photos} idx={i} onAvatarClick={uid=>uid&&onViewProfile(uid)} onReply={msg=>{setReplyTo(msg);inputRef.current?.focus();}} onOpenLightbox={src=>{try{inputRef.current?.blur();}catch(e){} setLightbox(src);}} onLongPress={()=>{lpActiveRef.current=true;setCtxMsg(m);}} onLongPressEnd={()=>{setTimeout(()=>lpActiveRef.current=false,500);}} onCircleFs={src=>setCircleFs(src)} msgFontSize={msgFontSize} audioMsgs={audioMsgs} chatId={chat.id}/>;
          })}
          <div ref={bottomRef}/>
          <div ref={imeSpacerRef} style={{flexShrink:0}}/>
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


        {/* Input */}
        {canWrite?(
          <div ref={imeDockRef} data-rmg-dock="" style={{position:"absolute",left:0,right:0,bottom:0,zIndex:120}}>
          {/* Attach panel */}
        {attachMounted&&!showEmoji&&(
          <div style={{background:surface,border:`1px solid ${border}`,borderRadius:"18px 18px 0 0",padding:"14px 12px",boxShadow:"0 -6px 24px rgba(0,0,0,0.3)",animation:attachClosing?"slideDown 0.2s ease forwards":"slideUp 0.2s ease"}} onClick={e=>e.stopPropagation()}>
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
          <div style={{padding:"7px 9px",paddingBottom:showEmoji?7:"max(7px,env(safe-area-inset-bottom,7px))",background:surface,borderTop:`1px solid ${border}`,flexShrink:0}} onClick={e=>e.stopPropagation()}>
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
            {(
              <div style={recording?{position:"absolute",left:-10000,top:0,width:10,height:44,opacity:0,overflow:"hidden",pointerEvents:"none"}:{display:"flex",alignItems:"center",gap:7}}>
                <button onClick={e=>{e.stopPropagation();
                  // Если открываем attach — закрываем эмодзи с учётом kbWasOpen
                  if(showEmoji)closeEmojiPanel();
                  setShowAttach(a=>!a);
                }} style={{width:42,height:42,borderRadius:"50%",background:showAttach?accent+"33":surface2,border:`1.5px solid ${showAttach?accent:border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s",color:showAttach?accent:text2}}><IcPaperclip size={19}/></button>
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
                          cursor:"pointer",display:"flex",alignItems:"center",
                          justifyContent:"center",flexShrink:0,color:text2,
                          transition:"all 0.15s",WebkitTapHighlightColor:"transparent",
                          transform:voiceHolding?"scale(1.12)":"scale(1)"}}>{quickMode==="voice"?<IcMic size={18}/>:<IcCircleOutline size={18}/>}</button>
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
          </div>
        ):(
          <div style={{padding:14,background:surface,borderTop:`1px solid ${border}`,textAlign:"center",color:text2,fontSize:13}}>📢 Только администратор может публиковать</div>
        )}



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
function ChatList({currentUser,profile,onOpen,onFind,onViewProfile,onChatsLoad,
  themeName,onChangeTheme,wallpaperId,onChangeWallpaper,accentId,onChangeAccent,
  msgFontSize=14,onChangeFontSize,onLogout,online=true,wsState="open"}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const CACHE_KEY="rmg_chats_"+currentUser.uid;
  const cachedChats=()=>{try{const c=JSON.parse(localStorage.getItem(CACHE_KEY)||"[]");const h=readHidden("rmg_hidden_chats_"+currentUser.uid);return c.filter(x=>!isHiddenChat(h,currentUser.uid,x));}catch{return[];}};
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
      const filtered=list.filter(c=>!isHiddenChat(_hidden,currentUser.uid,c));
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
        const filtered=list.filter(c=>!isHiddenChat(_hidden,currentUser.uid,c));
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
      const patch={["hiddenFor."+currentUser.uid]:Date.now()};
      if(c.type==="direct"&&c.names&&(c.members||[]).length<Object.keys(c.names).length){
        patch.members=Object.keys(c.names);
      }
      // Пишем отметку скрытия СЕРВЕРНО (в сам документ чата), а не только в
      // localStorage — иначе при переустановке приложения (или входе с
      // другого устройства) localStorage стирается, и «удалённые» чаты
      // возвращаются, потому что на сервере их никто не помечал скрытыми.
      updateDoc(doc(db,"chats",c.id),patch).catch(()=>{});
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
      {/* ── Top Header ── */}
      <div style={{paddingTop:online?"max(env(safe-area-inset-top,28px),28px)":9,paddingLeft:14,paddingRight:14,paddingBottom:9,background:surface+"EE",borderBottom:`1px solid ${border}`,backdropFilter:"blur(16px)",WebkitBackdropFilter:"blur(16px)",flexShrink:0}}>
        <div style={{position:"relative",display:"flex",alignItems:"center",justifyContent:"flex-end",marginBottom:9,minHeight:36}}>
          {/* Center: tab title — absolutely positioned, doesn't intercept clicks */}
          <div style={{position:"absolute",left:"50%",top:"50%",transform:"translate(-50%,-50%)",color:text,fontWeight:800,fontSize:20,display:"flex",alignItems:"center",gap:8,pointerEvents:"none",whiteSpace:"nowrap"}}>
            {tab==="all"&&(
              <span>{!online?"ожидание сети":wsState!=="open"?"Обновление...":(profile?.name||"Чаты")}</span>
            )}
            {tab==="direct"&&<span>Личные</span>}
            {tab==="contacts"&&<span>Контакты</span>}
            {tab==="groups"&&<span>Группы</span>}
            {tab==="channels"&&<span>Каналы</span>}
          </div>
          {/* Right: action buttons */}
          <div style={{display:"flex",gap:7}}>
            <button onClick={onFind} className="rmg-press" style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:accent,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IcSearchSm size={18}/></button>
            <button onClick={()=>{haptic(8);setFab(f=>!f);}} style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",color:contrastOn(accent),fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.25s",transform:fab?"rotate(45deg)":"none"}}><IcPencilSm size={17}/></button>
          </div>
        </div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск" style={{width:"100%",background:surface2,border:"none",borderRadius:14,padding:"11px 15px",color:text,fontSize:14,transition:"all 0.3s ease",outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
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
            <div onClick={()=>onViewProfile?.(currentUser.uid)} style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"28px 16px 20px",background:surface,marginBottom:0,borderBottom:`1px solid ${border}`,cursor:"pointer",WebkitTapHighlightColor:"transparent"}}>
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
                    <div style={{padding:"6px 12px"}}>
                      {[0,1,2,3,4,5,6].map(i=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",marginBottom:9,borderRadius:18,background:surface2,opacity:Math.max(0.15,1-i*0.13)}}>
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
                ):(
                <div style={{padding:"8px 12px 0"}}>
                {tabFiltered.map((c,i)=>{
                  const name=getName(c);
                  const myUnread=c.unreadBy?.[currentUser.uid]||0;
                  const isNew=myUnread>0;
                  return(
                    <div key={c.id}
                      onClick={()=>onOpen({...c,name})}
                      onContextMenu={e=>{e.preventDefault();openCtx(c,e);}}
                      onTouchStart={e=>{
                        e.currentTarget.style.background=border;
                        e.currentTarget._lp=setTimeout(()=>{openCtx(c,e);e.currentTarget.style.background=surface2;},500);
                      }}
                      onTouchEnd={e=>{clearTimeout(e.currentTarget._lp);e.currentTarget.style.background=surface2;}}
                      onTouchMove={e=>{clearTimeout(e.currentTarget._lp);e.currentTarget.style.background=surface2;}}
                      style={{
                        display:"flex",alignItems:"center",gap:13,padding:"11px 13px",
                        marginBottom:9,borderRadius:18,background:surface2,
                        cursor:"pointer",transition:"background 0.13s",
                        animation:`listIn 0.2s ease ${Math.min(i*0.04,0.3)}s both`,
                      }}>
                      <div style={{position:"relative",flexShrink:0}}>
                        <Avatar name={name} size={50} photo={
                          c.type==="direct"
                            ?(()=>{const p=Object.keys(c.names||c.photos||{}).find(k=>k!==currentUser.uid);return bestPhoto(p&&photosCache[p],p&&(c.photos||{})[p],c._partnerPhoto);})()
                            :(c.photo||c._partnerPhoto||null)
                        }/>
                        {isNew&&(
                          <div style={{
                            position:"absolute",bottom:-2,right:-2,minWidth:19,height:19,
                            borderRadius:10,background:accent,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            fontSize:10,fontWeight:700,color:contrastOn(accent),padding:"0 5px",
                            border:`2.5px solid ${surface2}`,
                          }}>{myUnread>99?"99+":myUnread}</div>
                        )}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                          <div style={{color:text,fontWeight:isNew?700:500,fontSize:15,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,letterSpacing:-0.1}}>
                            {c.type==="channel"?"📢 ":c.type==="group"?"🫂 ":""}{name}
                          </div>
                          {c.lastTime&&<div style={{color:text2,fontSize:11,flexShrink:0,marginLeft:8}}>{c.lastTime}</div>}
                        </div>
                        <div style={{color:isNew?text2:text2+"cc",fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:400}}>
                          {c.lastMsg||"Нет сообщений"}
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
                )}
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

// ─── Push setup (встроенный ntfy, без сторонних приложений) ──────────────────
// Топик генерируется на устройстве и сохраняется на сервере. Дальше нативный
// сервис сам держит постоянное соединение с ntfy и показывает уведомления —
// никакого UnifiedPush-дистрибьютора и никакого Google не требуется.

function openChatFromPush(chatId) {
  if (!chatId) return;
  window.__rmgPendingPushChatId = String(chatId);
  window.dispatchEvent(new CustomEvent("rmg:open-chat", { detail: { chatId: String(chatId) } }));
}

async function setupPush(uid) {
  if (!uid) return;
  if (pushRegistrationUid === uid && nativePushListenersReady) return;
  pushRegistrationUid = uid;

  try {
    if (!Capacitor.isNativePlatform()) return;

    if (!nativePushListenersReady) {
      await NativePush.addListener("registrationError", err => {
        console.warn("⚠️ Push: ошибка запуска:", err?.error || err);
      });

      await NativePush.addListener("pushNotificationReceived", notification => {
        const incomingChatId = String(notification?.data?.chatId || "");
        if (incomingChatId && incomingChatId === _activeChatId && notification?.id != null) {
          NativePush.removeDeliveredNotifications({
            notifications: [{ id: Number(notification.id) }],
          }).catch(() => {});
        }
      });

      await NativePush.addListener("pushNotificationActionPerformed", action => {
        openChatFromPush(action?.notification?.data?.chatId);
      });
      nativePushListenersReady = true;
    }

    let permission = await NativePush.checkPermissions();
    if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
      permission = await NativePush.requestPermissions();
    }
    if (permission.receive !== "granted") {
      console.warn("⚠️ Уведомления не разрешены в Android");
      return;
    }

    await NativePush.createChannel({ id: "messages" }).catch(() => {});

    const topic = getPushTopic();
    await serverSaveTopic(uid, topic).catch(e => console.warn("⚠️ Не удалось сохранить топик:", e?.message || e));
    await NativePush.start({ topic });

    const launch = await NativePush.getLaunchData().catch(() => null);
    if (launch?.chatId) openChatFromPush(launch.chatId);
  } catch (e) {
    console.log("Push setup error:", e.message);
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
    // "crystal" даёт красивый эффект, но её прозрачный bg ломает все места
    // в приложении, которые рассчитывают на сплошную заливку для перекрытия
    // экрана (настройки, профиль и т.д.) — контент отовсюду просвечивал друг
    // сквозь друга. Пока по умолчанию — надёжная сплошная тёмная тема.
    return "dark";
  });
  const[wallpaperId,setWallpaperId]=useState(()=>localStorage.getItem("rmg_wallpaper")||"none");
  const[accentId,setAccentId]=useState(()=>localStorage.getItem("rmg_accent")||"white");
  const[msgFontSize,setMsgFontSize]=useState(()=>parseInt(localStorage.getItem("rmg_fontsize")||"14"));
  const[toast,setToast]=useState(null);
  const[online,setOnline]=useState(navigator.onLine);
  const[wsState,setWsState]=useState("open"); // "open" | "connecting" | "closed" — для заголовка как в Telegram
  const[minSplashDone,setMinSplashDone]=useState(false);
  const updateProfileLocal=useCallback(patch=>{
    if(!patch||typeof patch!=="object")return;
    setProfile(prev=>{
      const next={...(prev||{}),...patch};
      try{localStorage.setItem("rmg_cached_profile",JSON.stringify(next));}catch(e){}
      return next;
    });
    setFbUser(prev=>{
      if(!prev)return prev;
      const next={...prev};
      if(Object.prototype.hasOwnProperty.call(patch,"name"))next.displayName=patch.name||"";
      if(Object.prototype.hasOwnProperty.call(patch,"photo"))next.photoURL=patch.photo||null;
      return next;
    });
  },[]);
  useEffect(()=>{
    const up=()=>setOnline(true);
    const dn=()=>setOnline(false);
    window.addEventListener("online",up);
    window.addEventListener("offline",dn);
    return()=>{window.removeEventListener("online",up);window.removeEventListener("offline",dn);};
  },[]);
  useEffect(()=>{
    const onWs=e=>setWsState(e.detail);
    window.addEventListener("rmg:ws",onWs);
    return()=>window.removeEventListener("rmg:ws",onWs);
  },[]);

  // При возврате приложения из фона активный DOM-фокус (например, поле ввода
  // сообщения в чате, который был открыт до сворачивания) может остаться
  // "залипшим", даже если сейчас видим список чатов — Android снова
  // показывает клавиатуру для этого невидимого поля. Снимаем фокус, если
  // видим именно список чатов.
  useEffect(()=>{
    const onVis=()=>{
      if(document.visibilityState==="visible"&&screen==="list"){
        const el=document.activeElement;
        if(el&&(el.tagName==="INPUT"||el.tagName==="TEXTAREA")){
          try{el.blur();}catch(e){}
        }
      }
    };
    document.addEventListener("visibilitychange",onVis);
    return()=>document.removeEventListener("visibilitychange",onVis);
  },[screen]);

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

  useEffect(()=>{
    if(!fbUser?.uid||fbUser._offline)return;
    return onSnapshot(doc(db,"users",fbUser.uid),snap=>{
      if(!snap.exists())return;
      const next={...snap.data()};
      setProfile(next);
      try{localStorage.setItem("rmg_cached_profile",JSON.stringify(next));}catch(e){}
    },()=>{});
  },[fbUser?.uid,fbUser?._offline]);

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
    // ✅ Встроенный push (ntfy) после входа — без стороннего приложения-дистрибьютора.
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
            // Внутренний баннер "Новое сообщение" убран по просьбе — обычных
            // push-уведомлений достаточно, звук внутри приложения оставлен.
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
    .rmg-audio-btn{transition:transform 0.16s cubic-bezier(.34,1.56,.64,1),opacity 0.16s,background 0.2s,color 0.2s}
    .rmg-audio-btn:active{transform:scale(0.82);opacity:0.7}
    .rmg-audio-btn-lg:active{transform:scale(0.9)}
    .rmg-audio-toggle{transition:transform 0.25s cubic-bezier(.34,1.56,.64,1),background 0.2s,color 0.2s}
    .rmg-audio-toggle.on{animation:rmgTogglePop 0.32s cubic-bezier(.34,1.56,.64,1)}
    @keyframes rmgTogglePop{0%{transform:scale(1)}45%{transform:scale(1.22)}100%{transform:scale(1)}}
    @keyframes rmgQueueOpen{from{opacity:0;transform:translateY(-8px) scaleY(0.94);transform-origin:top}to{opacity:1;transform:none}}
    @keyframes rmgQueueClose{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-8px) scaleY(0.94);transform-origin:top}}
    @keyframes rmgPlayPulse{0%{box-shadow:0 6px 24px var(--rmg-accent-a),0 0 0 0 var(--rmg-accent-b)}70%{box-shadow:0 6px 24px var(--rmg-accent-a),0 0 0 14px transparent}100%{box-shadow:0 6px 24px var(--rmg-accent-a),0 0 0 0 transparent}}
    @keyframes rmgRowIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
    @keyframes msgIn{0%{opacity:0;transform:translateY(16px) scale(0.92)}50%{opacity:1;transform:translateY(-2px) scale(1.01)}100%{opacity:1;transform:none}}
    @keyframes bubbleIn{from{opacity:0;transform:scale(0.88) translateY(6px)}to{opacity:1;transform:none}}
    @keyframes splashRing{from{transform:scale(0.88);opacity:0.7}to{transform:scale(1.3);opacity:0}}
    @keyframes circleIn{from{opacity:0;transform:scale(0.65)}to{opacity:1;transform:scale(1)}}
    @keyframes circleExpandIn{0%{opacity:0;transform:scale(0.3)}60%{transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
    @keyframes slideDown{from{opacity:1;transform:none}to{opacity:0;transform:translateY(20px)}}
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
    @keyframes creatorSheen{0%{background-position:220% center}100%{background-position:-20% center}}
    input::placeholder,textarea::placeholder{color:${theme.text2}55}
    button{-webkit-user-select:none;user-select:none}
    .rmg-press{transition:transform 0.16s cubic-bezier(0.34,1.56,0.64,1),opacity 0.16s}
    .rmg-press:active{transform:scale(0.88);opacity:0.7}
    .rmg-skel{background:linear-gradient(90deg,rgba(128,128,128,0.14) 25%,rgba(128,128,128,0.3) 50%,rgba(128,128,128,0.14) 75%);background-size:200% 100%;animation:skelShimmer 1.15s linear infinite}
    @keyframes skelShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    /* Плавная клавиатура: на время движения IME отключаем дорогой backdrop-filter
       у нижних блоков чата — пересчёт блюра на каждом кадре давал «30 fps».
       Фон панели подменяем полупрозрачным цветом, чтобы не было просветов. */
    /* Док ездит композиторным transform'ом с очень коротким переходом
       (сглаживает батчинг нативных кадров, не отставая от клавиатуры).
       Список НЕ трансформируется: он скроллится (дёшево, без GPU-слоёв). */

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
        <AudioFullPlayerOverlay currentUser={fbUser}/>
        <ListenTimeTracker uid={fbUser?.uid}/>

        {/* Profile layer - always on top */}
        {viewProfileUid&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:600}}>
            <ProfileView uid={viewProfileUid} myUid={fbUser?.uid} onClose={()=>setViewProfileUid(null)} onStartChat={startChatWithUser} onProfileChange={updateProfileLocal}/>
          </div>
        )}

        {/* Main layer */}
        {!fbUser?(
          <AuthScreen onAuth={(user,prof,isAnon)=>{setFbUser(user);updateProfileLocal(prof);if(isAnon)setEditing(true);}}/>
        ):editing?(
          <EditProfile currentUser={fbUser} profile={profile} onSave={updated=>{updateProfileLocal(updated);setEditing(false);}} onClose={()=>setEditing(false)}/>
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
                online={online} wsState={wsState}
                onOpen={chat=>{setActiveChat(chat);setScreenAnim("toChat");setScreen("chat");}}
                onFind={()=>setFinding(true)}
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
