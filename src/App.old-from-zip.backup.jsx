import React, { useState, useEffect, useLayoutEffect, useRef, createContext, useContext, useCallback, useMemo } from "react";
import { initDB, saveMsg, getMsgs, deleteMsg, updateMsgReactions, updateMsgText, getSetting, setSetting, clearChatMsgs, searchMsgs } from "./db.js";

// ─── Go Server ────────────────────────────────────────────────────────────────
const SERVER_HTTP = "https://server-production-ecd3.up.railway.app";
const SERVER_WS   = "wss://server-production-ecd3.up.railway.app/ws";

// Upload file to Go server (for video/large files)
async function serverUpload(file, onProgress) {
  const formData = new FormData();
  formData.append("file", file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", SERVER_HTTP + "/upload");
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded/e.total*100));
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        resolve(data.url);
      } else {
        reject(new Error("Upload failed: " + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData);
  });
}

// Register user on Go server
async function serverRegister(user) {
  try {
    const res = await fetch(`${SERVER_HTTP}/register`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        id: user.uid,
        name: user.name,
        tag: user.tag,
        bio: user.bio || "",
        photoUrl: user.photo || "",
      }),
    });
    if (res.status === 409) return {error: "tag taken"};
    return await res.json();
  } catch(e) {
    console.log("Server offline:", e.message);
    return null;
  }
}

// Search users on Go server
async function serverSearch(query) {
  try {
    const res = await fetch(`${SERVER_HTTP}/search?q=${encodeURIComponent(query)}`);
    return await res.json();
  } catch(e) { return []; }
}

// Save FCM token to Go server
async function serverSaveFCM(userId, token) {
  try {
    await fetch(`${SERVER_HTTP}/user/${userId}`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({fcmToken: token}),
    });
  } catch(e) {}
}

// ─── SQLite (via @capacitor-community/sqlite) ─────────────────────────────
// Fallback to localStorage if SQLite not available (web browser)
let _db = null;
let _sqliteReady = false;

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
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, signInAnonymously } from "firebase/auth";
import { collection, doc, setDoc, getDoc, addDoc, query, orderBy, onSnapshot, where, getDocs, serverTimestamp, updateDoc, arrayUnion, limitToLast, startAfter, endBefore, deleteDoc } from "firebase/firestore";
import { getMessaging, getToken, onMessage } from "firebase/messaging";

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


const ThemeCtx = createContext({bg:'#000',surface:'#111',surface2:'#1a1a1a',border:'#222',text:'#fff',text2:'#888',accent:'#E53935',accent2:'#B71C1C'});

// ─── Global Music Player ─────────────────────────────────────────────────────
const PlayerCtx = createContext({track:null,setTrack:()=>{}});
const GLOBAL_AUDIO = { 
  el: null, 
  track: null,
  listeners: new Set(),
  notify(track){ 
    this.track=track; 
    try{this.listeners.forEach(fn=>{try{fn(track);}catch(e){}});}catch(e){}
  }
};

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
const initials=n=>(n||"?").split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
const timeNow=()=>new Date().toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"});
const fmtSize=b=>b>1048576?`${(b/1048576).toFixed(1)}MB`:b>1024?`${(b/1024).toFixed(0)}KB`:`${b}B`;

// ─── Стикеры (5 паков) ──────────────────────────────────────────────────────────
const STICKER_PACKS = [
  { name:"Смайлы", stickers:["😀","😂","🥹","😍","🤩","😎","🥳","😏","😒","😤","🤬","😭","🥺","😱","🤯","🤔","😴","🤤","🤑","😈","👻","💀","🤡","👾","🤖"] },
  { name:"Жесты", stickers:["👍","👎","👏","🙌","🤝","✌️","🤞","🤙","💪","🙏","👋","🤜","🫶","❤️","🔥","💯","✅","⭐","🎉","🎊","🎁","💎","🏆","👑","💫"] },
  { name:"Животные", stickers:["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴"] },
  { name:"Еда", stickers:["🍕","🍔","🌮","🌯","🥙","🍜","🍣","🍱","🍦","🍩","🍪","🎂","🍰","🧁","🍫","🍭","🍬","🥤","☕","🧋","🍵","🥛","🍺","🥂","🍾"] },
  { name:"Активность", stickers:["⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥊","🎯","🎮","🎲","🎸","🎹","🎺","🎻","🥁","🎤","🎧","🎨","🖼️","📸","🎬"] },
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
  useEffect(()=>{const t=setTimeout(onClose,4000);return()=>clearTimeout(t);},[]);
  return(
    <div onClick={toast.onClick} style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",zIndex:9999,width:"min(380px, calc(100vw - 24px))",background:"rgba(18,18,18,0.97)",backdropFilter:"blur(24px)",borderRadius:20,padding:"11px 14px",display:"flex",alignItems:"center",gap:11,boxShadow:"0 8px 40px rgba(0,0,0,0.7)",border:"1px solid rgba(255,255,255,0.07)",cursor:toast.onClick?"pointer":"default",animation:"toastIn 0.32s cubic-bezier(0.34,1.56,0.64,1)"}}>
      <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{toast.icon||"💬"}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:"#fff",fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{toast.title}</div>
        <div style={{color:"rgba(255,255,255,0.55)",fontSize:12,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{toast.body}</div>
      </div>
      <button onClick={e=>{e.stopPropagation();onClose();}} style={{background:"none",border:"none",color:"rgba(255,255,255,0.35)",fontSize:15,cursor:"pointer",flexShrink:0}}>✕</button>
    </div>
  );
}

// ─── Animated Screen Wrapper ──────────────────────────────────────────────────

// ─── Avatar ──────────────────────────────────────────────────────────────────
function Avatar({name,size=42,online=false,photo=null,onClick=null}){
  const {bg}=useContext(ThemeCtx);
  const c=colorFor(name||"?");
  const[loaded,setLoaded]=useState(false);
  const[err,setErr]=useState(false);

  useEffect(()=>{setLoaded(false);setErr(false);},[photo]);

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
            style={{position:"absolute",inset:0,width:"100%",height:"100%",
              objectFit:"cover",zIndex:1,
              opacity:1}}
            onLoad={()=>setLoaded(true)}
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
      a.ontimeupdate=()=>{
        if(a.duration&&isFinite(a.duration)&&a.duration>0)
          setProg(a.currentTime/a.duration);
      };
      a.onended=()=>{setPlaying(false);setProg(0);aRef.current=null;};
      a.onerror=(e)=>{console.log("Audio error:",e);setErr(true);stop();};
      a.oncanplay=()=>{
        const tick=()=>{
          if(aRef.current&&!aRef.current.paused&&!aRef.current.ended){
            if(aRef.current.duration)setProg(aRef.current.currentTime/aRef.current.duration);
            raf.current=requestAnimationFrame(tick);
          }
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
  const wf=msg.waveform||Array.from({length:28},()=>Math.floor(Math.random()*18)+5);

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
  const[playing,setPlaying]=useState(false);
  const[prog,setProg]=useState(0);
  const[dur,setDur]=useState("0:00");
  const[err,setErr]=useState(false);
  const aRef=useRef(null),rafRef=useRef(null);
  const stop=()=>{
    try{if(aRef.current){aRef.current.pause();aRef.current.src="";aRef.current=null;}}catch(e){}
    cancelAnimationFrame(rafRef.current);setPlaying(false);setProg(0);
  };
  const toggle=()=>{
    if(playing){stop();return;}
    const src=msg.fileUrl||msg.fileData||msg.audioUrl||msg.audioData;
    if(!src){setErr(true);return;}
    setErr(false);
    try{
      const a=new Audio(src);aRef.current=a;
      a.onloadedmetadata=()=>{if(a.duration&&isFinite(a.duration))setDur(Math.floor(a.duration/60)+":"+String(Math.floor(a.duration%60)).padStart(2,"0"));};
      a.onended=()=>{setPlaying(false);setProg(0);aRef.current=null;};
      a.onerror=()=>{setErr(true);stop();};
      a.oncanplay=()=>{const tick=()=>{if(aRef.current&&!aRef.current.paused&&!aRef.current.ended){if(aRef.current.duration)setProg(aRef.current.currentTime/aRef.current.duration);rafRef.current=requestAnimationFrame(tick);}};tick();};
      a.play().then(()=>setPlaying(true)).catch(()=>{setErr(true);aRef.current=null;});
    }catch(e){setErr(true);}
  };
  useEffect(()=>()=>stop(),[]);
  const name=msg.fileName||"Аудио";
  const ext=name.split(".").pop()?.toUpperCase()||"MP3";
  const sizeMb=msg.fileSize?(msg.fileSize/1024/1024).toFixed(1)+"MB":"";
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:220,maxWidth:280}}>
      <button onClick={toggle} style={{width:46,height:46,borderRadius:"50%",border:"none",cursor:"pointer",flexShrink:0,background:err?"rgba(255,59,48,0.3)":fromMe?"rgba(255,255,255,0.22)":accent,color:"#fff",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.15s",transform:playing?"scale(0.88)":"scale(1)"}}>
        {err?"✕":playing?"⏸":"▶"}
      </button>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:fromMe?"#fff":text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginBottom:4}}>🎵 {name}</div>
        <div style={{height:3,background:fromMe?"rgba(255,255,255,0.25)":"rgba(0,0,0,0.15)",borderRadius:2,overflow:"hidden",marginBottom:4}}>
          <div style={{height:"100%",width:prog*100+"%",background:fromMe?"rgba(255,255,255,0.85)":accent,borderRadius:2,transition:"width 0.1s linear"}}/>
        </div>
        <div style={{fontSize:10,color:fromMe?"rgba(255,255,255,0.5)":text2,display:"flex",gap:6}}>
          <span>{dur}</span>{sizeMb&&<span>· {sizeMb}</span>}<span>· {ext}</span>
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
  const SIZE=165;
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
    if(playing){v.pause();cancelAnimationFrame(raf.current);setPlaying(false);setProg(0);v.currentTime=0;return;}
    if(!v.src||v.src!==src)v.src=src;
    v.play().catch(()=>{});setPlaying(true);
    const tick=()=>{
      if(v&&!v.paused&&!v.ended){
        if(v.duration)setProg(v.currentTime/v.duration);
        raf.current=requestAnimationFrame(tick);
      }
    };
    v.onplay=()=>tick();
    v.onended=()=>{setPlaying(false);setProg(0);};
  };

  useEffect(()=>()=>{if(vRef.current)vRef.current.pause();cancelAnimationFrame(raf.current);},[]);

  return(
    <div style={{position:"relative",width:SIZE,height:SIZE,cursor:"pointer",flexShrink:0}}
      onClick={toggle}
      onDoubleClick={()=>{onFullscreen&&onFullscreen(src);}}>

      {/* Outer glow ring */}
      <div style={{position:"absolute",inset:-3,borderRadius:"50%",
        background:`conic-gradient(${accent} ${prog*360}deg, transparent ${prog*360}deg)`,
        opacity:playing?1:0.6,transition:"opacity 0.3s",
        filter:`blur(1px) drop-shadow(0 0 6px ${accent}88)`}}/>

      {/* Video circle */}
      <div style={{position:"absolute",inset:4,borderRadius:"50%",overflow:"hidden",
        boxShadow:`0 4px 20px rgba(0,0,0,0.5),0 0 0 2px ${playing?accent:"rgba(255,255,255,0.15)"}`}}>

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
          {playing?`${Math.floor(prog*(parseInt(msg.duration?.split(":")[1]||0)))}s`:msg.duration}
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
  const {accent,text2,surface2,text,border}=useContext(ThemeCtx);
  const player=useContext(PlayerCtx)||null;
  const[playing,setPlaying]=useState(false);
  const[prog,setProg]=useState(0);
  const[cur,setCur]=useState("0:00");
  const[dur,setDur]=useState("0:00");
  const[loaded,setLoaded]=useState(false);
  const src=msg.fileUrl||msg.fileData||"";
  const name=msg.fileName||"Аудио";
  const size=msg.fileSize?fmtSize(msg.fileSize):"";

  // Sync with global player
  useEffect(()=>{
    const fn=(track)=>{
      if(track?.src!==src) setPlaying(false);
    };
    GLOBAL_AUDIO.listeners.add(fn);
    return()=>GLOBAL_AUDIO.listeners.delete(fn);
  },[src]);

  const fmt=(s)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

  const toggle=()=>{
    if(!src)return;
    if(playing){
      GLOBAL_AUDIO.el?.pause();
      setPlaying(false);
      return;
    }
    // Stop whatever is playing
    if(GLOBAL_AUDIO.el&&GLOBAL_AUDIO.track?.src!==src){
      GLOBAL_AUDIO.el.pause();
      GLOBAL_AUDIO.el=null;
    }
    // Create or reuse audio
    if(!GLOBAL_AUDIO.el||GLOBAL_AUDIO.track?.src!==src){
      const a=new Audio(src);
      GLOBAL_AUDIO.el=a;
      GLOBAL_AUDIO.notify({src,name,size,fromMe});
      a.onloadedmetadata=()=>{setDur(fmt(a.duration));setLoaded(true);};
      a.ontimeupdate=()=>{setCur(fmt(a.currentTime));if(a.duration)setProg(a.currentTime/a.duration);if(player)player.setTrack({src,name,size,prog:a.currentTime/a.duration,cur:fmt(a.currentTime),dur:fmt(a.duration),playing:true,toggle});};
      a.onended=()=>{setPlaying(false);setProg(0);setCur("0:00");if(player)player.setTrack(t=>t?.src===src?{...t,playing:false}:t);};
    }else{
      GLOBAL_AUDIO.notify({src,name,size,fromMe});
    }
    GLOBAL_AUDIO.el.play().catch(()=>{});
    setPlaying(true);
    if(player)player.setTrack({src,name,size,prog,cur,dur,playing:true,toggle});

    // Continuous update
    const tick=()=>{
      const a=GLOBAL_AUDIO.el;
      if(a&&!a.paused&&!a.ended){
        setCur(fmt(a.currentTime));
        if(a.duration)setProg(a.currentTime/a.duration);
        if(player)player.setTrack(t=>t?.src===src?{...t,prog:a.currentTime/a.duration,cur:fmt(a.currentTime)}:t);
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  };

  // Waveform bars
  const wf=msg.waveform||Array.from({length:36},(_,i)=>8+Math.sin(i*0.7)*6+Math.random()*8);

  return(
    <div style={{minWidth:220,maxWidth:280}}>
      {/* Top row: album art + info */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
        {/* Album art / play button */}
        <div style={{position:"relative",flexShrink:0}}>
          <div style={{width:46,height:46,borderRadius:12,
            background:fromMe?`rgba(255,255,255,0.15)`:accent+"22",
            display:"flex",alignItems:"center",justifyContent:"center",
            overflow:"hidden",boxShadow:playing?`0 0 14px ${accent}66`:"none",
            transition:"box-shadow 0.3s"}}>
            {msg.coverUrl
              ? <img src={msg.coverUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              : <span style={{fontSize:22}}>🎵</span>
            }
          </div>
          {/* Overlay play button */}
          <button onClick={toggle} style={{position:"absolute",inset:0,borderRadius:12,
            border:"none",cursor:"pointer",
            background:playing?"rgba(0,0,0,0.4)":"rgba(0,0,0,0.25)",
            color:"#fff",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",
            transition:"all 0.15s",WebkitTapHighlightColor:"transparent"}}>
            {playing?"⏸":"▶"}
          </button>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:fromMe?"#fff":text,fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name.replace(/\.(mp3|m4a|flac|wav|aac|ogg|wma|aiff|ape)$/i,"")}</div>
          <div style={{color:fromMe?"rgba(255,255,255,0.55)":text2,fontSize:11,marginTop:1}}>{size}{size?" · ":""}Аудио</div>
        </div>
      </div>
      {/* Waveform progress */}
      <div style={{display:"flex",alignItems:"flex-end",gap:2,height:28,marginBottom:4,cursor:"pointer"}}
        onClick={e=>{
          const a=GLOBAL_AUDIO.el;
          if(!a||!a.duration)return;
          const rect=e.currentTarget.getBoundingClientRect();
          const ratio=(e.clientX-rect.left)/rect.width;
          a.currentTime=ratio*a.duration;
          setProg(ratio);
        }}>
        {wf.map((h,i)=>(
          <div key={i} style={{flex:1,borderRadius:2,height:Math.max(3,h),background:i/wf.length<prog?(fromMe?"rgba(255,255,255,0.9)":accent):(fromMe?"rgba(255,255,255,0.25)":accent+"33"),transition:"background 0.08s"}}/>
        ))}
      </div>
      {/* Time */}
      <div style={{display:"flex",justifyContent:"space-between"}}>
        <span style={{color:fromMe?"rgba(255,255,255,0.5)":text2,fontSize:10}}>{cur}</span>
        <span style={{color:fromMe?"rgba(255,255,255,0.5)":text2,fontSize:10}}>{dur}</span>
      </div>
    </div>
  );
}


// ─── File Bubble ─────────────────────────────────────────────────────────────
// ─── Custom Video Player ───────────────────────────────────────────────────────
function VideoPlayer({src,fileName,fromMe}){
  const {accent,accent2}=useContext(ThemeCtx);
  const videoRef=useRef(null);
  const [playing,setPlaying]=useState(false);
  const [prog,setProg]=useState(0);
  const [dur,setDur]=useState(0);
  const [showCtrl,setShowCtrl]=useState(true);
  const [fullscreen,setFullscreen]=useState(false);
  const [buffered,setBuffered]=useState(0);
  const rafRef=useRef(null);
  const ctrlTimer=useRef(null);

  const fmt=s=>{
    if(!s||!isFinite(s))return"0:00";
    return`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;
  };

  const tick=()=>{
    const v=videoRef.current;if(!v)return;
    if(v.duration){
      setProg(v.currentTime/v.duration);
      if(v.buffered.length)setBuffered(v.buffered.end(v.buffered.length-1)/v.duration);
    }
    if(!v.paused&&!v.ended)rafRef.current=requestAnimationFrame(tick);
  };

  const revealCtrl=()=>{
    setShowCtrl(true);
    clearTimeout(ctrlTimer.current);
    if(playing)ctrlTimer.current=setTimeout(()=>setShowCtrl(false),2800);
  };

  const toggle=e=>{
    e.stopPropagation();revealCtrl();
    const v=videoRef.current;if(!v)return;
    if(v.paused){v.play();setPlaying(true);rafRef.current=requestAnimationFrame(tick);}
    else{v.pause();setPlaying(false);cancelAnimationFrame(rafRef.current);}
  };

  const seek=e=>{
    e.stopPropagation();
    const v=videoRef.current;if(!v||!v.duration)return;
    const r=e.currentTarget.getBoundingClientRect();
    v.currentTime=((e.clientX-r.left)/r.width)*v.duration;
    setProg(v.currentTime/v.duration);revealCtrl();
  };

  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);clearTimeout(ctrlTimer.current);},[]);

  if(fullscreen)return(
    <VideoFullscreen src={src} fileName={fileName} videoRef={videoRef}
      playing={playing} setPlaying={setPlaying} prog={prog} setProg={setProg}
      dur={dur} fmt={fmt} tick={tick} onClose={()=>setFullscreen(false)}/>
  );

  return(
    <div style={{width:245,borderRadius:16,overflow:"hidden",background:"#0a0a0a",
      position:"relative",cursor:"pointer",userSelect:"none",
      boxShadow:"0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)"}}
      onClick={toggle} onTouchStart={revealCtrl}>

      <video ref={videoRef} src={src} playsInline preload="metadata"
        style={{width:"100%",height:175,display:"block",objectFit:"cover",background:"#000"}}
        onLoadedMetadata={e=>setDur(e.target.duration)}
        onEnded={()=>{setPlaying(false);setProg(0);cancelAnimationFrame(rafRef.current);setShowCtrl(true);}}
        onError={()=>{}}/>

      {/* Gradient overlay */}
      <div style={{position:"absolute",inset:0,background:"linear-gradient(to bottom, transparent 40%, rgba(0,0,0,0.75) 100%)",pointerEvents:"none"}}/>

      {/* Center play button */}
      <div style={{
        position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
        opacity:showCtrl?1:0,transition:"opacity 0.25s ease",pointerEvents:showCtrl?"auto":"none"
      }}>
        <div style={{
          width:56,height:56,borderRadius:"50%",
          background:"rgba(0,0,0,0.52)",
          backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",
          border:"1.5px solid rgba(255,255,255,0.22)",
          display:"flex",alignItems:"center",justifyContent:"center",
          transition:"transform 0.2s cubic-bezier(0.34,1.56,0.64,1),opacity 0.15s ease",
          transform:playing?"scale(0.85)":"scale(1)",
        }}>
          {playing
            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            : <svg width="22" height="22" viewBox="0 0 24 24" fill="white" style={{marginLeft:3}}><path d="M8 5v14l11-7z"/></svg>
          }
        </div>
      </div>

      {/* Bottom controls */}
      <div style={{
        position:"absolute",bottom:0,left:0,right:0,padding:"0 10px 8px",
        opacity:showCtrl?1:0,transition:"opacity 0.25s ease",
      }} onClick={e=>e.stopPropagation()}>

        {/* Progress */}
        <div style={{position:"relative",height:20,display:"flex",alignItems:"center",cursor:"pointer",marginBottom:2}} onClick={seek}>
          <div style={{position:"absolute",left:0,right:0,height:3,borderRadius:2,background:"rgba(255,255,255,0.18)"}}>
            {/* Buffered */}
            <div style={{position:"absolute",left:0,top:0,height:"100%",borderRadius:2,background:"rgba(255,255,255,0.22)",width:buffered*100+"%",transition:"width 0.3s ease"}}/>
            {/* Played */}
            <div style={{position:"absolute",left:0,top:0,height:"100%",borderRadius:2,
              background:`linear-gradient(90deg,${accent},${accent2})`,
              width:prog*100+"%",transition:"width 0.08s linear"}}/>
            {/* Thumb */}
            <div style={{
              position:"absolute",top:"50%",
              left:prog*100+"%",
              transform:"translate(-50%,-50%)",
              width:12,height:12,borderRadius:"50%",
              background:"#fff",boxShadow:"0 1px 6px rgba(0,0,0,0.5)",
              transition:"left 0.08s linear",
            }}/>
          </div>
        </div>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{color:"rgba(255,255,255,0.75)",fontSize:11,fontWeight:600,fontVariantNumeric:"tabular-nums"}}>
            {fmt(videoRef.current?.currentTime||0)} / {fmt(dur)}
          </span>
          <button onClick={e=>{e.stopPropagation();setFullscreen(true);}}
            style={{background:"none",border:"none",color:"rgba(255,255,255,0.75)",cursor:"pointer",
              padding:4,display:"flex",alignItems:"center",lineHeight:1}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Fullscreen Video Player ───────────────────────────────────────────────────
// ─── Fullscreen Video Player ───────────────────────────────────────────────────
function VideoFullscreen({src,fileName,videoRef:extRef,playing,setPlaying,prog,setProg,dur,fmt,tick,onClose}){
  const {accent,accent2}=useContext(ThemeCtx);
  const localRef=useRef(null);
  const vRef=extRef||localRef;
  const [showCtrl,setShowCtrl]=useState(true);
  const [localProg,setLocalProg]=useState(prog||0);
  const [localDur,setLocalDur]=useState(dur||0);
  const [localPlaying,setLocalPlaying]=useState(playing||false);
  const [swipeY,setSwipeY]=useState(0);
  const [swipeStart,setSwipeStart]=useState(null);
  const [downloading,setDownloading]=useState(false);
  const ctrlTimer=useRef(null);
  const rafRef=useRef(null);

  const localFmt=s=>{if(!s||!isFinite(s))return"0:00";const m=Math.floor(s/60),sec=Math.floor(s%60);return`${m}:${String(sec).padStart(2,"0")}`;};

  const showControls=()=>{
    setShowCtrl(true);
    clearTimeout(ctrlTimer.current);
    ctrlTimer.current=setTimeout(()=>setShowCtrl(false),3500);
  };

  const tickLocal=()=>{
    const v=vRef.current;if(!v)return;
    setLocalProg(v.currentTime/v.duration||0);
    if(!v.paused&&!v.ended)rafRef.current=requestAnimationFrame(tickLocal);
  };

  useEffect(()=>{
    const v=vRef.current;if(!v)return;
    v.play().then(()=>{setLocalPlaying(true);rafRef.current=requestAnimationFrame(tickLocal);}).catch(()=>{});
    showControls();
    return()=>{cancelAnimationFrame(rafRef.current);clearTimeout(ctrlTimer.current);};
  },[]);

  const toggle=e=>{
    e.stopPropagation();
    const v=vRef.current;if(!v)return;
    if(v.paused){v.play();setLocalPlaying(true);rafRef.current=requestAnimationFrame(tickLocal);}
    else{v.pause();setLocalPlaying(false);cancelAnimationFrame(rafRef.current);}
    showControls();
  };

  const seek=e=>{
    e.stopPropagation();
    const v=vRef.current;if(!v||!v.duration)return;
    const r=e.currentTarget.getBoundingClientRect();
    v.currentTime=((e.clientX-r.left)/r.width)*v.duration;
    setLocalProg(v.currentTime/v.duration);
    showControls();
  };

  const nativeDownload=async()=>{
    setDownloading(true);
    try{
      if(window?.Capacitor?.isNativePlatform()){
        const {Filesystem,Directory}=await import("@capacitor/filesystem");
        await Filesystem.requestPermissions().catch(()=>{});
        if(src.startsWith("data:")){
          await Filesystem.writeFile({path:fileName,data:src.split(",")[1],directory:Directory.Documents,recursive:true});
        }else{
          await Filesystem.downloadFile({url:src,path:fileName,directory:Directory.Documents});
        }
        alert("✅ Сохранено: "+fileName);
      }else{
        const a=document.createElement("a");a.href=src;a.download=fileName;
        document.body.appendChild(a);a.click();document.body.removeChild(a);
      }
    }catch(e){alert("Ошибка: "+e.message);}
    setDownloading(false);
  };

  const opacity=Math.max(0,1-swipeY/200);
  const scale=Math.max(0.88,1-swipeY/800);

  return(
    <div style={{
      position:"fixed",inset:0,zIndex:3000,background:`rgba(0,0,0,${opacity})`,
      display:"flex",alignItems:"center",justifyContent:"center",
      transform:`translateY(${swipeY}px) scale(${scale})`,
      transition:swipeY===0?"transform 0.3s cubic-bezier(0.25,0.46,0.45,0.94)":"none",
    }}
    onTouchStart={e=>{setSwipeStart(e.touches[0].clientY);}}
    onTouchMove={e=>{
      if(swipeStart===null)return;
      const dy=e.touches[0].clientY-swipeStart;
      if(dy>0)setSwipeY(dy);
    }}
    onTouchEnd={()=>{
      if(swipeY>120){
        vRef.current?.pause();
        onClose();
      }else{
        setSwipeY(0);
      }
      setSwipeStart(null);
    }}
    onClick={()=>{showControls();}}>

      {/* Video */}
      <video ref={extRef?extRef:localRef} src={extRef?undefined:src} playsInline
        style={{width:"100%",height:"100%",objectFit:"contain",display:"block"}}
        onLoadedMetadata={e=>setLocalDur(e.target.duration)}
        onEnded={()=>{setLocalPlaying(false);cancelAnimationFrame(rafRef.current);}}/>

      {/* Top controls */}
      <div style={{
        position:"absolute",top:0,left:0,right:0,
        padding:"max(env(safe-area-inset-top,20px),20px) 16px 32px",
        background:"linear-gradient(rgba(0,0,0,0.72),transparent)",
        display:"flex",alignItems:"center",gap:12,
        opacity:showCtrl?1:0,transition:"opacity 0.3s ease",
        pointerEvents:showCtrl?"auto":"none",
      }} onClick={e=>e.stopPropagation()}>
        {/* Close */}
        <button onClick={onClose} style={{
          width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",
          background:"rgba(255,255,255,0.12)",backdropFilter:"blur(12px)",
          color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
        </button>
        {/* Title */}
        <div style={{flex:1,color:"#fff",fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",opacity:0.9}}>
          {fileName}
        </div>
        {/* Download */}
        <button onClick={e=>{e.stopPropagation();nativeDownload();}} style={{
          width:40,height:40,borderRadius:"50%",border:"none",cursor:"pointer",
          background:"rgba(255,255,255,0.12)",backdropFilter:"blur(12px)",
          color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",
          opacity:downloading?0.5:1}}>
          {downloading
            ?<div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTop:"2px solid #fff",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            :<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          }
        </button>
      </div>

      {/* Center play/pause */}
      <div style={{
        position:"absolute",
        opacity:showCtrl?1:0,transition:"opacity 0.3s ease",
        pointerEvents:showCtrl?"auto":"none",
      }} onClick={toggle}>
        <div style={{
          width:72,height:72,borderRadius:"50%",
          background:"rgba(0,0,0,0.5)",
          backdropFilter:"blur(16px)",WebkitBackdropFilter:"blur(16px)",
          border:"1.5px solid rgba(255,255,255,0.2)",
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
          transform:showCtrl?"scale(1)":"scale(0.8)",
          transition:"transform 0.25s cubic-bezier(0.34,1.56,0.64,1)",
        }}>
          {localPlaying
            ?<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            :<svg width="30" height="30" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          }
        </div>
      </div>

      {/* Bottom controls */}
      <div style={{
        position:"absolute",bottom:0,left:0,right:0,
        padding:"32px 16px max(env(safe-area-inset-bottom,20px),20px)",
        background:"linear-gradient(transparent,rgba(0,0,0,0.75))",
        opacity:showCtrl?1:0,transition:"opacity 0.3s ease",
        pointerEvents:showCtrl?"auto":"none",
      }} onClick={e=>e.stopPropagation()}>
        {/* Progress bar */}
        <div style={{height:4,background:"rgba(255,255,255,0.22)",borderRadius:2,marginBottom:10,cursor:"pointer",position:"relative"}}
          onClick={seek}>
          <div style={{
            position:"absolute",top:0,left:0,height:"100%",borderRadius:2,
            background:`linear-gradient(90deg,${accent},${accent2})`,
            width:localProg*100+"%",
          }}/>
          <div style={{
            position:"absolute",top:"50%",transform:"translate(-50%,-50%)",
            left:localProg*100+"%",
            width:14,height:14,borderRadius:"50%",background:"#fff",
            boxShadow:"0 2px 8px rgba(0,0,0,0.5)",
          }}/>
        </div>
        {/* Time */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{color:"rgba(255,255,255,0.75)",fontSize:13,fontVariantNumeric:"tabular-nums"}}>
            {localFmt(vRef.current?.currentTime||0)}
          </span>
          <span style={{color:"rgba(255,255,255,0.4)",fontSize:11}}>свайп вниз — закрыть</span>
          <span style={{color:"rgba(255,255,255,0.75)",fontSize:13,fontVariantNumeric:"tabular-nums"}}>
            {localFmt(localDur||dur)}
          </span>
        </div>
      </div>
    </div>
  );
}

function FileBubble({msg,fromMe,onOpenLightbox}){
  const {accent,text2,text}=useContext(ThemeCtx);
  const src=msg.fileUrl||msg.fileData||"";

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
      onClick={()=>onOpenLightbox?onOpenLightbox({src,fileName:msg.fileName,fileType:msg.fileType||"image/jpeg"}):window.open(src,"_blank")}>
      <img src={src} alt={msg.fileName||"Фото"}
        style={{width:"100%",display:"block",maxHeight:320,objectFit:"cover"}}
        onError={e=>{e.target.style.display="none";}}/>
    </div>
  );

  if(isAudio)return <AudioPlayer msg={msg} fromMe={fromMe}/>;

  if(isVideo)return <VideoPlayer src={src} fileName={msg.fileName||"video.mp4"} fromMe={fromMe}/>;

  const ext=(msg.fileName||"FILE").split(".").pop().toUpperCase().slice(0,5);
  return(
    <div style={{display:"flex",alignItems:"center",gap:10,minWidth:180,cursor:"pointer"}}
      onClick={()=>src&&window.open(src,"_blank")}>
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
  const preview=msg.type==="voice"?"🎙 Голосовое":msg.type==="circle"?"⭕ Кружок":msg.type==="sticker"?msg.text:msg.type==="file"?(msg.fileType?.startsWith("image/")?"🖼 Фото":"📎 "+msg.fileName):msg.text||"";
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
  const isImg=msg.type==="file"&&msg.fileType?.startsWith("image/");
  const isVoice=msg.type==="voice";
  const isCircle=msg.type==="circle";
  const preview=isVoice?"🎙 Голосовое":isCircle?"⭕ Кружок":msg.type==="sticker"?msg.text:isImg?"🖼 Фото":msg.type==="file"?"📎 "+(msg.fileName||"Файл"):msg.text||"";
  const thumbSrc=isImg?(msg.fileData||msg.fileUrl):isCircle?(msg.videoUrl||msg.videoData):null;
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
function EmojiPanel({onEmoji,onSticker,onClose}){
  const {surface,surface2,border,text,text2,accent}=useContext(ThemeCtx);
  const[tab,setTab]=useState(0); // 0=emoji, 1..5=sticker packs
  const EMOJIS=["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😙","😚","🤗","🤭","🤫","🤔","😐","😑","😶","😏","😒","🙄","😬","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😠","😡","🤬","😈","👿","💀","🤡","👽","🤖","😺","😸","😻","❤️","🧡","💛","💚","💙","💜","🖤","❤️‍🔥","💯","🔥","⭐","✨","💫","🎉","🎊","🎁","🎈","🏆","🥇","👍","👎","👋","🤝","🙏","💪","✌️","🤞","💅","🫶"];
  const tabs=[{ico:"😀",lbl:"Смайлы"},...STICKER_PACKS.map(p=>({ico:p.stickers[0],lbl:p.name}))];

  return(
    <div style={{background:surface,border:`1px solid ${border}`,borderRadius:"20px 20px 0 0",padding:"10px 0 0",maxHeight:300,display:"flex",flexDirection:"column",boxShadow:"0 -8px 30px rgba(0,0,0,0.3)"}}>
      {/* Tabs */}
      <div style={{display:"flex",gap:4,padding:"0 12px 8px",overflowX:"auto",borderBottom:`1px solid ${border}`,flexShrink:0}}>
        {tabs.map((t,i)=>(
          <button key={i} onClick={()=>setTab(i)} style={{flexShrink:0,padding:"5px 10px",borderRadius:10,border:"none",background:tab===i?accent+"22":"transparent",color:tab===i?accent:text2,fontSize:tab===i?11:16,fontWeight:tab===i?700:400,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s",whiteSpace:"nowrap"}}>
            {i===0?t.ico:<span style={{fontSize:18}}>{t.ico}</span>}{tab===i&&i>0?<span style={{marginLeft:4}}>{t.lbl}</span>:""}
          </button>
        ))}
      </div>
      {/* Grid */}
      <div style={{flex:1,overflowY:"auto",padding:10,display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(38px,1fr))",gap:4}}>
        {(tab===0?EMOJIS:STICKER_PACKS[tab-1].stickers).map((e,i)=>(
          <button key={i} onClick={()=>{tab===0?onEmoji(e):onSticker(e);}} style={{width:"100%",aspectRatio:"1",borderRadius:10,border:"none",background:"transparent",fontSize:tab===0?22:26,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"background 0.15s"}} onMouseEnter={e2=>e2.currentTarget.style.background=surface2} onMouseLeave={e2=>e2.currentTarget.style.background="transparent"}>
            {e}
          </button>
        ))}
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
function ProfileView({uid,myUid,onClose,onStartChat}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[user,setUser]=useState(null);
  const[blocked,setBlocked]=useState(false);
  const[showMenu,setShowMenu]=useState(false);
  const[imgVisible,setImgVisible]=useState(false);

  useEffect(()=>{
    if(!uid)return;
    getDoc(doc(db,"users",uid)).then(s=>{if(s.exists())setUser(s.data());});
    getDoc(doc(db,"users",myUid)).then(s=>{
      if(s.exists())setBlocked((s.data()?.blocked||[]).includes(uid));
    });
  },[uid,myUid]);

  const clearChat=async()=>{
    if(!window.confirm("Очистить историю чата у себя?"))return;
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

  if(!user)return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:bg,zIndex:600,
      display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{width:40,height:40,borderRadius:"50%",border:`3px solid ${accent}`,
        borderTopColor:"transparent",animation:"spin 0.8s linear infinite"}}/>
    </div>
  );

  const color=colorFor(user.name||"?");
  const hasPhoto=!!user.photo;

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:600,background:bg,
      display:"flex",flexDirection:"column",
      animation:"pageSlideIn 0.3s cubic-bezier(0.25,0.46,0.45,0.94)",
      WebkitAnimation:"pageSlideIn 0.3s cubic-bezier(0.25,0.46,0.45,0.94)"}}>

      {/* Cover photo */}
      <div style={{position:"relative",flexShrink:0,height:"clamp(260px,50vw,360px)",overflow:"hidden"}}>
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
          background:"linear-gradient(to bottom,rgba(0,0,0,0.3) 0%,transparent 40%,rgba(0,0,0,0.8) 100%)"}}/>

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
      <div style={{flex:1,overflowY:"auto",padding:"14px"}} onClick={()=>setShowMenu(false)}>
        {user.bio&&(
          <div style={{background:surface,borderRadius:16,padding:"12px 16px",marginBottom:12,
            animation:"fadeUp 0.4s ease 0.1s both"}}>
            <div style={{color:text2,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:5}}>О СЕБЕ</div>
            <div style={{color:text,fontSize:14,lineHeight:1.6}}>{user.bio}</div>
          </div>
        )}

        <div style={{background:surface,borderRadius:16,overflow:"hidden",marginBottom:14,
          animation:"fadeUp 0.4s ease 0.15s both"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",
            borderBottom:`1px solid ${border}`}}>
            <span style={{fontSize:20}}>🏷️</span>
            <div>
              <div style={{color:text2,fontSize:11,fontWeight:600,letterSpacing:0.5}}>Username</div>
              <div style={{color:accent,fontSize:15,fontWeight:600,marginTop:2}}>@{user.tag}</div>
            </div>
          </div>
/* email hidden from other users */
        </div>

        {uid!==myUid&&(
          <div style={{display:"flex",flexDirection:"column",gap:10,animation:"fadeUp 0.4s ease 0.2s both"}}>
            <button onClick={()=>onStartChat(user)}
              style={{padding:"15px",background:`linear-gradient(135deg,${accent},${accent2})`,
                border:"none",borderRadius:16,color:"#fff",fontSize:15,fontWeight:700,
                cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 16px ${accent}44`,
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                transition:"transform 0.15s, box-shadow 0.15s",WebkitTapHighlightColor:"transparent"}}
              onMouseDown={e=>e.currentTarget.style.transform="scale(0.97)"}
              onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
              onTouchStart={e=>e.currentTarget.style.transform="scale(0.97)"}
              onTouchEnd={e=>e.currentTarget.style.transform="scale(1)"}>
              💬 Написать сообщение
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


function FindPeople({currentUser,profile,onClose,onStartChat}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[q,setQ]=useState(""),[ results,setResults]=useState([]),[ loading,setLoading]=useState(false),[ searched,setSearched]=useState(false);
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
    const chatId=[currentUser.uid,person.uid].sort().join("_");
    const chatRef=doc(db,"chats",chatId);
    if(!(await getDoc(chatRef)).exists())await setDoc(chatRef,{id:chatId,type:"direct",members:[currentUser.uid,person.uid],names:{[currentUser.uid]:profile.name,[person.uid]:person.name},created:serverTimestamp(),lastMsg:"",lastTime:""});
    onStartChat({id:chatId,type:"direct",name:person.name,tag:person.tag,uid:person.uid});
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
              <button onClick={()=>startChat(p)} style={{background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:13,padding:"8px 16px",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Написать</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Create Modal ─────────────────────────────────────────────────────────────
function CreateModal({type,currentUser,profile,onClose,onCreated}){
  const {surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const[chatName,setChatName]=useState(""),[ desc,setDesc]=useState(""),[ loading,setLoading]=useState(false);
  const create=async()=>{
    if(!chatName.trim())return;setLoading(true);
    try{const tag2=chatName.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/gi,"")+Math.floor(100+Math.random()*900);
      const r=await addDoc(collection(db,"chats"),{type,name:chatName.trim(),desc,tag:tag2,members:[currentUser.uid],creatorUid:currentUser.uid,creatorName:profile.name,created:serverTimestamp(),lastMsg:"",lastTime:"",photo:null});
      onCreated({id:r.id,type,name:chatName.trim(),desc,tag:tag2,creatorUid:currentUser.uid,members:[currentUser.uid]});}
    catch(e){alert("Ошибка: "+e.message);}
    setLoading(false);
  };
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:300,display:"flex",alignItems:"flex-end",animation:"fadeIn 0.2s ease"}} onClick={onClose}>
      <div style={{background:surface,borderRadius:"22px 22px 0 0",padding:22,width:"100%",animation:"slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)"}} onClick={e=>e.stopPropagation()}>
        <div style={{width:36,height:4,background:border,borderRadius:2,margin:"0 auto 18px"}}/>
        <div style={{color:text,fontWeight:700,fontSize:17,marginBottom:16}}>{type==="channel"?"📢 Новый канал":"🫂 Новая группа"}</div>
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
function Lightbox({src,fileName,fileType,onClose}){
  const isImage=fileType?.startsWith("image/");
  const isVideo=fileType?.startsWith("video/");
  const isAudio=fileType?.startsWith("audio/")||/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(fileName||"");

  const download=()=>{
    const a=document.createElement("a");
    a.href=src;a.download=fileName||"file";
    a.target="_blank";
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);
  };

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.97)",zIndex:2000,display:"flex",flexDirection:"column"}}
      onClick={onClose}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 16px",flexShrink:0,paddingTop:"max(env(safe-area-inset-top,28px),28px)"}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{background:"rgba(255,255,255,0.1)",border:"none",borderRadius:"50%",width:38,height:38,color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>←</button>
        <div style={{color:"#fff",fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"60%"}}>{fileName}</div>
        <button onClick={download} style={{background:"rgba(229,57,53,0.8)",border:"none",borderRadius:20,padding:"8px 16px",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
          ⬇ Скачать
        </button>
      </div>

      {/* Content */}
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",padding:16}} onClick={e=>e.stopPropagation()}>
        {isImage&&(
          <img src={src} alt={fileName}
            style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",borderRadius:8}}/>
        )}
        {isVideo&&(
          <video src={src} controls autoPlay playsInline
            style={{maxWidth:"100%",maxHeight:"100%",borderRadius:8}}/>
        )}
        {isAudio&&(
          <div style={{background:"#1a1a1a",borderRadius:20,padding:28,textAlign:"center",width:"100%",maxWidth:320}}>
            <div style={{fontSize:52,marginBottom:16}}>🎵</div>
            <div style={{color:"#fff",fontWeight:600,fontSize:15,marginBottom:20}}>{fileName}</div>
            <audio src={src} controls style={{width:"100%"}}/>
            <button onClick={download} style={{marginTop:16,background:"#E53935",border:"none",borderRadius:14,padding:"12px 24px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",width:"100%"}}>⬇ Скачать</button>
          </div>
        )}
        {!isImage&&!isVideo&&!isAudio&&(
          <div style={{background:"#1a1a1a",borderRadius:20,padding:32,textAlign:"center"}}>
            <div style={{fontSize:52,marginBottom:12}}>📄</div>
            <div style={{color:"#fff",fontWeight:600,fontSize:15,marginBottom:8}}>{fileName}</div>
            <button onClick={download} style={{background:"#E53935",border:"none",borderRadius:14,padding:"13px 28px",color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>⬇ Скачать файл</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Reply Preview ────────────────────────────────────────────────────────────

// ─── Message Context Menu ────────────────────────────────────────────────────
function MsgContextMenu({msg,myUid,chatId,onClose,onReply,onEdit,onForward}){
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
  const REACTIONS=["❤️","😂","👍","🔥","😮","😢","👎"];
  const actions=[
    {ico:"↩️",lbl:"Ответить",fn:()=>{onReply(msg);close();}},
    {ico:"📋",lbl:"Копировать",fn:()=>{
      const t=msg.type==="text"?msg.text:"[медиа]";
      try{navigator.clipboard.writeText(t);}catch(e){}
      close();
    }},
    {ico:"↪️",lbl:"Переслать",fn:()=>{onForward&&onForward(msg);close();}},
  ];
  if(isMedia) actions.push({ico:"⬇️",lbl:"Скачать",fn:downloadMsg});
  if(isMe&&msg.type==="text") actions.push({ico:"✏️",lbl:"Редактировать",fn:()=>{onEdit&&onEdit(msg);close();}});
  actions.push({ico:"🗑",lbl:"Удалить у себя",red:true,fn:async()=>{
    try{await updateDoc(doc(db,"chats",chatId,"messages",msg.id),{deletedFor:arrayUnion(myUid)});}catch(e){}
    close();
  }});
  if(isMe) actions.push({ico:"💣",lbl:"Удалить у всех",red:true,fn:async()=>{
    if(!window.confirm("Удалить у всех?"))return;
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
  const[name,setName]=useState(""),[ email,setEmail]=useState(""),[ pass,setPass]=useState(""),[ tag,setTag]=useState(""),[ err,setErr]=useState(""),[ loading,setLoading]=useState(false),[ showPass,setShowPass]=useState(false);
  useEffect(()=>{if(name)setTag(name.toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9]/gi,"")+Math.floor(1000+Math.random()*9000));},[name]);
  const submit=async()=>{
    setErr("");setLoading(true);
    try{
      if(mode==="register"){
        if(!name.trim()){setErr("Введи имя");setLoading(false);return;}
        const ft=(tag.trim()||name.toLowerCase().replace(/[^a-z0-9]/gi,"")+Math.floor(1000+Math.random()*9000)).toLowerCase();
        // Create auth account FIRST, then check tag (user must be authenticated for Firestore)
        const cred=await createUserWithEmailAndPassword(auth,email,pass);
        await updateProfile(cred.user,{displayName:name.trim()});
        // Now check tag uniqueness (user is authenticated)
        const tagCheck=await getDocs(query(collection(db,"users"),where("tag","==",ft)));
        if(!tagCheck.empty){
          // Tag taken - still save but with random suffix
          const finalTag=ft+Math.floor(10+Math.random()*90);
          const prof={uid:cred.user.uid,name:name.trim(),email,tag:finalTag,bio:"",photo:null,theme:"dark",createdAt:serverTimestamp(),lastSeen:serverTimestamp()};
          await setDoc(doc(db,"users",cred.user.uid),prof);
        } else {
          const prof={uid:cred.user.uid,name:name.trim(),email,tag:ft,bio:"",photo:null,theme:"dark",createdAt:serverTimestamp(),lastSeen:serverTimestamp()};
          await setDoc(doc(db,"users",cred.user.uid),prof);
        }
        onAuth(cred.user,prof);
      }else{
        const cred=await signInWithEmailAndPassword(auth,email,pass);
        const snap=await getDoc(doc(db,"users",cred.user.uid));
        onAuth(cred.user,snap.data());
      }
    }catch(e){
      const m={"auth/email-already-in-use":"Email уже занят","auth/weak-password":"Пароль минимум 6 символов","auth/user-not-found":"Пользователь не найден","auth/wrong-password":"Неверный пароль","auth/invalid-email":"Неверный email","auth/invalid-credential":"Неверный email или пароль"};
      setErr(m[e.code]||e.message);
    }
    setLoading(false);
  };
  const inp={background:surface2,border:`1.5px solid ${border}`,borderRadius:14,padding:"13px 15px",color:text,fontSize:15,outline:"none",fontFamily:"inherit",width:"100%",boxSizing:"border-box",transition:"border-color 0.2s"};
  return(
    <div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}>
      <div style={{background:surface,borderRadius:24,padding:"32px 22px",width:"100%",maxWidth:380,border:`1px solid ${border}`,boxShadow:"0 24px 80px rgba(0,0,0,0.55)",animation:"fadeIn 0.4s ease"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:68,height:68,borderRadius:20,background:`linear-gradient(135deg,${accent},${accent2})`,margin:"0 auto 12px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:34,boxShadow:`0 6px 26px ${accent}55`}}>🔴</div>
          <div style={{color:text,fontWeight:800,fontSize:24}}>MrX</div>
          <div style={{color:text2,fontSize:13,marginTop:4}}>{mode==="login"?"Войди в аккаунт":"Создай аккаунт"}</div>
        </div>
        {mode==="register"&&<div style={{display:"flex",justifyContent:"center",marginBottom:18}}><Avatar name={name||"?"} size={70}/></div>}
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12}}>
          {mode==="register"&&<>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="Имя" style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
            <div style={{display:"flex",alignItems:"center",background:surface2,border:`1.5px solid ${border}`,borderRadius:14,overflow:"hidden"}}>
              <span style={{color:accent,padding:"0 13px",fontSize:16,fontWeight:700}}>@</span>
              <input value={tag} onChange={e=>setTag(e.target.value.replace(/^@/,"").replace(/\s/,""))} placeholder="твой_тег" style={{flex:1,background:"none",border:"none",padding:"13px 8px 13px 0",color:text,fontSize:15,outline:"none",fontFamily:"inherit"}}/>
            </div>
          </>}
          <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" style={inp} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
          <div style={{position:"relative"}}>
            <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Пароль" type={showPass?"text":"password"} onKeyDown={e=>e.key==="Enter"&&submit()} style={{...inp,paddingRight:46}} onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=border}/>
            <button onClick={()=>setShowPass(s=>!s)} style={{position:"absolute",right:13,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:text2,fontSize:15}}>{showPass?"🙈":"👁"}</button>
          </div>
        </div>
        {err&&<div style={{background:"#ff00001a",border:"1px solid #ff000033",borderRadius:12,padding:"9px 13px",color:"#ff6b6b",fontSize:13,marginBottom:10,animation:"shake 0.3s ease"}}>⚠️ {err}</div>}
        <button onClick={submit} disabled={loading||!email||!pass} style={{width:"100%",padding:14,background:email&&pass?`linear-gradient(135deg,${accent},${accent2})`:surface2,border:"none",borderRadius:14,color:"#fff",fontSize:15,fontWeight:700,cursor:email&&pass?"pointer":"default",boxShadow:email&&pass?`0 4px 22px ${accent}55`:"none",fontFamily:"inherit",marginBottom:14}}>
          {loading?"⏳":mode==="login"?"Войти →":"Создать 🚀"}
        </button>
        {/* Divider */}
        <div style={{display:"flex",alignItems:"center",gap:8,margin:"10px 0"}}>
          <div style={{flex:1,height:1,background:border}}/><span style={{color:text2,fontSize:11}}>или</span><div style={{flex:1,height:1,background:border}}/>
        </div>
        {/* Anonymous login */}
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
          onMouseDown={e=>e.currentTarget.style.transform="scale(0.97)"}
          onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}>
          👻 Войти анонимно
        </button>
        <div style={{textAlign:"center"}}>
          <span style={{color:text2,fontSize:13}}>{mode==="login"?"Нет аккаунта? ":"Уже есть? "}</span>
          <span onClick={()=>{setMode(mode==="login"?"register":"login");setErr("");}} style={{color:accent,fontSize:13,cursor:"pointer",fontWeight:700}}>{mode==="login"?"Зарегистрироваться":"Войти"}</span>
        </div>
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
  const fileRef=useRef();

  const pickPhoto=async(e)=>{
    const file=e.target.files[0];if(!file)return;
    setUploading(true);setUploadPct(0);
    // Fast local preview first
    const url=URL.createObjectURL(file);
    const img=new Image();img.src=url;
    img.onload=async()=>{
      const canvas=document.createElement("canvas"),size=Math.min(img.width,img.height);
      canvas.width=300;canvas.height=300;
      canvas.getContext("2d").drawImage(img,(img.width-size)/2,(img.height-size)/2,size,size,0,0,300,300);
      const localB64=canvas.toDataURL("image/jpeg",0.75);
      setPreview(localB64); // instant preview
      canvas.toBlob(async blob=>{
        try{
          const storageRef=sRef(storage,`avatars/${currentUser.uid}.jpg`);
          const task=uploadBytesResumable(storageRef,blob,{contentType:"image/jpeg"});
          task.on("state_changed",snap=>setUploadPct(Math.round(snap.bytesTransferred/snap.totalBytes*100)));
          await task;
          const photoURL=await getDownloadURL(storageRef);
          setPreview(photoURL);
        }catch{/* keep local b64 */}
        setUploading(false);URL.revokeObjectURL(url);
      },"image/jpeg",0.8);
    };
  };

  const save=async()=>{
    if(uploading)return;setUploading(true);
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
      if(!currentUser?.uid){setErr("Не авторизован");setUploading(false);return;}
      await updateDoc(doc(db,"users",currentUser.uid),{
        name:updated.name,
        bio:updated.bio,
        tag:newTag||updated.tag,
        photo:updated.photo||null,
        lastSeen:serverTimestamp()
      });
      // Update Firebase Auth displayName
      await updateProfile(currentUser,{displayName:updated.name,photoURL:updated.photo||""}).catch(()=>{});
      // Update names in all direct chats
      try{
        const chatsSnap=await getDocs(query(collection(db,"chats"),where("members","array-contains",currentUser.uid)));
        const updates=chatsSnap.docs.map(d=>{
          const data=d.data();
          if(data.type==="direct"&&data.names?.[currentUser.uid]){
            return updateDoc(d.ref,{[`names.${currentUser.uid}`]:updated.name});
          }
          return null;
        }).filter(Boolean);
        await Promise.all(updates);
      }catch(e2){}
      onSave(updated);
    }catch(e){
                    console.error("Forward error:",e);
                    alert("Не удалось переслать: "+e.message);
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
              <div style={{position:"absolute",bottom:-6,right:-6,width:32,height:32,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,border:`2.5px solid ${bg}`,boxShadow:"0 2px 8px rgba(0,0,0,0.4)",zIndex:2}}>
                {uploading?`${uploadPct}%`:"📷"}
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" onChange={pickPhoto} style={{display:"none"}}/>
            {uploading&&<div style={{marginTop:8,color:text2,fontSize:12}}>Загрузка {uploadPct}%</div>}
          </div>
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
function Msg({msg,myUid,prevMsg,usersCache,onAvatarClick,onReply,onLongPress,onLongPressEnd,onOpenLightbox,onCircleFs,msgFontSize=14,idx}){
  const {accent,accent2,surface2,text,text2,bg}=useContext(ThemeCtx);
  const fromMe=msg.uid===myUid;
  const showAvatar=!fromMe&&msg.uid!==prevMsg?.uid;
  const photo=usersCache?.[msg.uid]?.photo||null;
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
      padding:msg.type==="voice"||msg.type==="file"?"10px 12px":"9px 13px",
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
      onTouchStart={isCircle?undefined:onTStart}
      onTouchMove={isCircle?undefined:onTMove}
      onTouchEnd={isCircle?undefined:onTEnd}>
      {!isCircle&&!isSticker&&(
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
        {!isSticker&&<div style={{fontSize:10,color:"#555",marginTop:2,display:"flex",alignItems:"center",gap:3}}>
          {msg._pending&&<span style={{opacity:0.5,animation:"pulse 1s infinite"}}>⏳</span>}
          {msg.time}
          {fromMe&&(
            <span style={{
              color:msg._pending?"rgba(255,255,255,0.35)":
                (msg.readBy?.length>1&&msg._partnerAllowsReceipts!==false)?"#4CAF50":"#A5D6A7",
              fontSize:11,marginLeft:2,fontWeight:600
            }}>
              {msg._pending?"✓":
                (msg.readBy?.length>1&&msg._partnerAllowsReceipts!==false)?"✓✓":"✓"}
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

function SettingsScreen({currentUser,profile,themeName,onChangeTheme,wallpaperId,onChangeWallpaper,accentId,onChangeAccent,msgFontSize=14,onChangeFontSize,onEditProfile,onClose,onLogout}){
  const {bg,surface,surface2,border,text,text2,accent}=useContext(ThemeCtx);
  const[s,setS2]=useState(()=>{try{return JSON.parse(localStorage.getItem("rmg_s")||"{}");}catch{return{};}});
  const toggle=k=>{const next={...s,[k]:!s[k]};setS2(next);localStorage.setItem("rmg_s",JSON.stringify(next));if(k==="notifSound"&&!s[k])playSound("msg");};
  const T=({k,label,desc,icon})=>(
    <ToggleRow label={label} desc={desc} icon={icon} value={!!s[k]} onChange={()=>toggle(k)}
      surface2={surface2} border={border} text={text} text2={text2}/>
  );
  const Row=({icon,label,val,onClick,red=false})=>(
    <div onClick={onClick} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 15px",borderBottom:`1px solid ${border}`,cursor:onClick?"pointer":"default"}} onMouseEnter={e=>{if(onClick)e.currentTarget.style.background=surface2;}} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <div style={{fontSize:19,width:26,textAlign:"center",flexShrink:0}}>{icon}</div>
      <div style={{flex:1}}><div style={{color:red?"#ff5252":text,fontSize:14,fontWeight:500}}>{label}</div>{val&&<div style={{color:text2,fontSize:12,marginTop:1}}>{val}</div>}</div>
      {onClick&&<div style={{color:text2,fontSize:17}}>›</div>}
    </div>
  );
  const H=({t})=><div style={{padding:"12px 15px 5px",color:accent,fontSize:10,fontWeight:700,letterSpacing:1.2}}>{t}</div>;
  return(
    <Screen dir="right">
      <div style={{background:bg,height:"100vh",display:"flex",flexDirection:"column"}}>
        <div style={{paddingTop:"max(env(safe-area-inset-top,28px),28px)",paddingLeft:15,paddingRight:15,paddingBottom:13,background:surface,borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:13,flexShrink:0}}>
          <button onClick={onClose} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
          <div style={{color:text,fontWeight:700,fontSize:16}}>⚙️ Настройки</div>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          <div onClick={onEditProfile} style={{display:"flex",alignItems:"center",gap:13,padding:"16px 15px",background:surface,borderBottom:`1px solid ${border}`,cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background=surface2} onMouseLeave={e=>e.currentTarget.style.background=surface}>
            <Avatar name={profile?.name||"?"} size={60} photo={profile?.photo} online/>
            <div style={{flex:1}}><div style={{color:text,fontWeight:700,fontSize:16}}>{profile?.name}</div><div style={{color:accent,fontSize:12,marginTop:2}}>@{profile?.tag}</div><div style={{color:text2,fontSize:12,marginTop:1}}>{profile?.bio||"Нет описания"}</div></div>
            <div style={{color:text2,fontSize:19}}>›</div>
          </div>
          <H t="УВЕДОМЛЕНИЯ"/>
          <div style={{background:surface,marginBottom:5}}>
            <T k="notifSound" icon="🔔" label="Звук уведомлений" desc="Звук при новом сообщении"/>
            <T k="notifVibro" icon="📳" label="Вибрация" desc="Вибрация при новом сообщении"/>
            <T k="notifPreview" icon="👁" label="Текст в уведомлении" desc="Показывать текст сообщения в шторке"/>
            <T k="notifGroups" icon="🫂" label="Уведомления из групп" desc="Получать уведомления из групповых чатов"/>
          </div>
          <H t="ЧАТЫ"/>
          <div style={{background:surface,marginBottom:5}}>
            <T k="enterSend" icon="⌨️" label="Enter для отправки" desc="Отправлять сообщение по нажатию Enter"/>
            <T k="bubbleAnim" icon="✨" label="Анимация сообщений" desc="Плавное появление сообщений"/>
            <Row icon="🗑" label="Очистить кэш" onClick={()=>{localStorage.removeItem("rmg_cache");alert("Готово!");}}/>
          </div>
          <H t="КОНФИДЕНЦИАЛЬНОСТЬ"/>
          <div style={{background:surface,marginBottom:5}}>
            <T k="showOnline" icon="🟢" label="Показывать онлайн" desc="Другие видят когда ты в сети"/>
            <T k="showLastSeen" icon="🕐" label="Последний онлайн" desc="Другие видят когда ты последний раз был в сети"/>
            <T k="readReceipts" icon="👁" label="Статус прочтения" desc="Собеседник видит что ты прочитал сообщение"/>
          </div>
          <H t="ТЕМЫ И ОФОРМЛЕНИЕ"/>
          <div style={{background:surface,marginBottom:5}}>
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
                {/* Reset to theme default */}
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
                    const size=Math.round(10+ratio*12); // 10-22px
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
            <T k="compactMode" icon="📐" label="Компактный режим"/>
          </div>
          <H t="АККАУНТ"/>
          <div style={{background:surface,marginBottom:30}}>
            <Row icon="🚪" label="Выйти из аккаунта" red onClick={onLogout}/>
          </div>
        </div>
      </div>
    </Screen>
  );
}

// ─── Find People ──────────────────────────────────────────────────────────────
// ─── Mini Music Player (global, like Telegram) ────────────────────────────────
function MiniPlayer({track,onClose}){
  const {surface,border,text,text2,accent,accent2,bg}=useContext(ThemeCtx);
  const[playing,setPlaying]=useState(track?.playing||false);
  const[prog,setProg]=useState(track?.prog||0);
  const[cur,setCur]=useState(track?.cur||"0:00");

  useEffect(()=>{
    setPlaying(track?.playing||false);
    setProg(track?.prog||0);
    setCur(track?.cur||"0:00");
  },[track]);

  // Live updates from global audio
  useEffect(()=>{
    const tick=()=>{
      const a=GLOBAL_AUDIO.el;
      if(a&&!a.paused&&!a.ended){
        if(a.duration){
          setProg(a.currentTime/a.duration);
          setCur(`${Math.floor(a.currentTime/60)}:${String(Math.floor(a.currentTime%60)).padStart(2,"0")}`);
        }
        requestAnimationFrame(tick);
      }
    };
    if(playing) requestAnimationFrame(tick);
  },[playing]);

  if(!track)return null;

  const togglePlay=()=>{
    const a=GLOBAL_AUDIO.el;
    if(!a)return;
    if(playing){a.pause();setPlaying(false);}
    else{a.play().catch(()=>{});setPlaying(true);}
  };

  const fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

  return(
    <div style={{
      position:"fixed",bottom:72,left:8,right:8,zIndex:300,
      background:surface,
      border:`1px solid ${border}`,
      borderRadius:18,
      padding:"10px 14px",
      boxShadow:"0 8px 32px rgba(0,0,0,0.5)",
      backdropFilter:"blur(20px)",
      WebkitBackdropFilter:"blur(20px)",
      animation:"slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)"
    }}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {/* Album art placeholder */}
        <div style={{width:44,height:44,borderRadius:12,background:`linear-gradient(135deg,${accent},${accent2})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0,boxShadow:`0 4px 12px ${accent}44`}}>🎵</div>
        
        {/* Track info */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:text,fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {(track.name||"Аудио").replace(/\.(mp3|m4a|flac|wav|aac|ogg)$/i,"")}
          </div>
          <div style={{color:text2,fontSize:11,marginTop:1}}>{track.size||""} · {cur} / {track.dur||"--:--"}</div>
        </div>

        {/* Controls */}
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <button onClick={togglePlay} style={{width:38,height:38,borderRadius:"50%",border:"none",cursor:"pointer",background:`linear-gradient(135deg,${accent},${accent2})`,color:"#fff",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 3px 10px ${accent}55`}}>
            {playing?"⏸":"▶"}
          </button>
          <button onClick={()=>{GLOBAL_AUDIO.el?.pause();GLOBAL_AUDIO.el=null;GLOBAL_AUDIO.notify(null);onClose();}} style={{width:30,height:30,borderRadius:"50%",border:"none",cursor:"pointer",background:"rgba(255,255,255,0.08)",color:text2,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
      </div>

      {/* Progress bar - clickable */}
      <div style={{marginTop:8,height:3,background:border,borderRadius:2,cursor:"pointer",position:"relative"}}
        onClick={e=>{
          const a=GLOBAL_AUDIO.el;
          if(!a||!a.duration)return;
          const rect=e.currentTarget.getBoundingClientRect();
          a.currentTime=(e.clientX-rect.left)/rect.width*a.duration;
        }}>
        <div style={{position:"absolute",top:0,left:0,height:"100%",width:`${prog*100}%`,background:`linear-gradient(90deg,${accent},${accent2})`,borderRadius:2,transition:"width 0.1s linear"}}/>
        <div style={{position:"absolute",top:-4,left:`${prog*100}%`,transform:"translateX(-50%)",width:10,height:10,borderRadius:"50%",background:accent,boxShadow:`0 0 8px ${accent}`,transition:"left 0.1s linear"}}/>
      </div>
    </div>
  );
}

// ─── Chat Screen ──────────────────────────────────────────────────────────────
function ChatScreen({chat,currentUser,profile,onBack,onViewProfile,showToast,wallpaperId,msgFontSize=14,chats=[]}){
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
  const[chatData,setChatData]=useState(chat);
  const[typingUsers,setTypingUsers]=useState([]);
  const[uploading,setUploading]=useState(false);
  const[ctxMsg,setCtxMsg]=useState(null);
  const[showMembers,setShowMembers]=useState(false);
  const[editMsg,setEditMsg]=useState(null);
  const[showChatMenu,setShowChatMenu]=useState(false);
  const[isMuted,setIsMuted]=useState(()=>!!getS("mute_"+chat.id));
  const[pinnedMsg,setPinnedMsg]=useState(null);
  const[partnerPhoto,setPartnerPhoto]=useState(null);
  const[showSearch,setShowSearch]=useState(false);
  const[forwardMsg,setForwardMsg]=useState(null);
  const bottomRef=useRef(),timerRef=useRef(),mediaRef=useRef(),chunksRef=useRef([]),inputRef=useRef(),lastCntRef=useRef(0),fileRef=useRef(),lpVoiceRef=useRef(null),galleryRef=useRef(null);

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

  useEffect(()=>{
    const vv=window.visualViewport;
    if(!vv)return;
    const onResize=()=>{
      const el=msgsRef.current;
      if(!el)return;
      // Скроллим вниз ТОЛЬКО если пользователь уже был у низа чата
      // Если листал историю вверх — не трогаем позицию
      if(isNearBottomRef.current){
        requestAnimationFrame(()=>{
          el.scrollTop=el.scrollHeight+99999;
        });
      }
    };
    vv.addEventListener("resize",onResize);
    return()=>vv.removeEventListener("resize",onResize);
  },[]);

  // ── Presence: сообщаем серверу что мы в этом чате → сервер не шлёт FCM ──────
  useEffect(()=>{
    if(!currentUser?.uid||!chat?.id)return;
    // Входим в чат
    fetch(`${SERVER_HTTP}/presence`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({uid:currentUser.uid,chatId:chat.id})
    }).catch(()=>{});
    // Выходим из чата (размонтирование или смена чата)
    return()=>{
      fetch(`${SERVER_HTTP}/presence`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({uid:currentUser.uid,chatId:""})
      }).catch(()=>{});
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
      if(window.Capacitor?.isNativePlatform()){
        import("@capacitor/push-notifications").then(({PushNotifications})=>{
          PushNotifications.removeAllDeliveredNotifications().catch(()=>{});
        }).catch(()=>{});
      }
    }catch(e){}
  },[chat.id,currentUser.uid]);

  // Загружаем данные собеседника + онлайн статус (реальный)
  const [partnerData,setPartnerData]=useState(null);
  useEffect(()=>{
    if(chat.type==="direct"&&chat.names){
      const partnerUid=Object.keys(chat.names).find(k=>k!==currentUser.uid);
      if(partnerUid){
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

  useEffect(()=>{return onSnapshot(doc(db,"chats",chat.id),s=>{
    if(s.exists()){
      const d=s.data();
      setChatData(prev=>({...prev,...d}));
      if(d.pinnedMsg)setPinnedMsg(d.pinnedMsg);else setPinnedMsg(null);
      const typing=d.typing||{};
      const others=Object.entries(typing).filter(([uid,name])=>uid!==currentUser.uid&&name).map(([,name])=>name);
      setTypingUsers(Array.isArray(others)?others:[]);
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

    // Кэш из SQLite — показываем мгновенно, только если Firestore ещё не ответил
    getMsgs(chat.id).then(cached=>{
      if(cached.length>0&&!firestoreLoadedRef.current){
        shouldScrollBottomRef.current=true; // прокрутим вниз без анимации
        setMsgs(cached);
        setMsgsReady(true);
      }
    });

    oldestDocRef.current=null;
    setHasOlder(true);

    if(!navigator.onLine)return;

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
              if(isNearBottomRef.current)shouldScrollBottomRef.current=true;
            } else {
              // Подтверждение своего сообщения — всегда в дно
              shouldScrollBottomRef.current=true;
            }
          }
        }

        lastCntRef.current=list.length;
        setMsgs(list);
        list.forEach(m=>saveMsg({...m,chatId:chat.id}));
        list.filter(m=>m.uid!==currentUser.uid&&!m.readBy?.includes(currentUser.uid))
          .forEach(m=>updateDoc(doc(db,"chats",chat.id,"messages",m.id),{
            readBy:arrayUnion(currentUser.uid)
          }).catch(()=>{}));
        [...new Set(list.map(m=>m.uid).filter(Boolean))].forEach(async uid=>{
          if(!usersCache[uid]){const s=await getDoc(doc(db,"users",uid));if(s.exists())setUsersCache(c=>({...c,[uid]:s.data()}));}
        });
      },err=>{
        console.log("Firestore offline, using SQLite cache");
      });
    }catch(e){}
    return()=>{unsub?.();};
  },[chat.id]);

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
    if(replyTo)payload.replyTo={id:replyTo.id,author:replyTo.author,uid:replyTo.uid,text:replyTo.text,type:replyTo.type};
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
      const allMembers=chatData?.names?Object.keys(chatData.names):chatData?.members||[];
      // Считаем непрочитанные для каждого участника кроме отправителя
      const unreadUpdate={};
      allMembers.filter(uid=>uid!==currentUser.uid).forEach(uid=>{
        unreadUpdate[`unreadBy.${uid}`]=(chatData?.unreadBy?.[uid]||0)+1;
      });
      updateDoc(doc(db,"chats",chat.id),{
        lastMsg:preview,lastTime:timeNow(),lastSender:profile?.name||"",
        ...unreadUpdate,
        ...(allMembers.length>0?{members:allMembers}:{})
      }).catch(()=>{});

      // Notify Go server → sends FCM to offline users
      // КРИТИЧНО: не менять эту логику — токены берутся из Firestore
      const mySettings=JSON.parse(localStorage.getItem("rmg_s")||"{}");
      const notifText=mySettings.notifPreview===false?"Новое сообщение":preview;
      const recipientTokens={};
      await Promise.all(
        allMembers.filter(u=>u!==currentUser.uid).map(async uid=>{
          try{
            const snap=await getDoc(doc(db,"users",uid));
            const t=snap.data()?.fcmToken;
            if(t)recipientTokens[uid]=t;
          }catch(e){}
        })
      );
      fetch(`${SERVER_HTTP}/notify`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          chatId:chat.id,
          senderId:currentUser.uid,
          senderName:profile?.name||"?",
          members:allMembers,
          tokens:recipientTokens,
          text:notifText,
          type:extra?.type||"text",
        })
      }).catch(()=>{});

    }catch(e){
      console.error("sendMsg error:",e);
      // Убираем если ошибка
      setMsgs(prev=>prev.filter(m=>m.id!==tempId));
    }
  };

  // ── Анимация полёта сообщения из инпута (как в TG) ─────────────────────────
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

  const handleSend=async()=>{
    const txt=(inputRef.current?.value||"").trim()||inputText.trim();
    if(!txt)return;

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
      await sendMsg({type:msgType,fileName:file.name,fileType:contentType,fileSize:file.size,fileUrl});
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

  const startVoice=async()=>{
    setShowAttach(false);setShowEmoji(false);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mr=new MediaRecorder(stream);mediaRef.current=mr;chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=async()=>{
        stream.getTracks().forEach(t=>t.stop());
        const blob=new Blob(chunksRef.current,{type:"audio/webm"});
        const wf=Array.from({length:28},()=>Math.floor(Math.random()*22)+4);
        const dur=`0:${String(recSec).padStart(2,"0")}`;
        try{
          const storageRef=sRef(storage,`voices/${currentUser.uid}/${Date.now()}.webm`);
          const task=uploadBytesResumable(storageRef,blob,{contentType:"audio/webm"});
          await new Promise((res,rej)=>task.on("state_changed",null,rej,res));
          const audioUrl=await getDownloadURL(storageRef);
          sendMsg({type:"voice",duration:dur,waveform:wf,audioUrl});
        }catch(e){
          const r=new FileReader();r.onloadend=()=>sendMsg({type:"voice",duration:dur,waveform:wf,audioData:r.result});r.readAsDataURL(blob);
        }
        playSound("sent");
      };
      mr.start();setRecording(true);setRecSec(0);
      timerRef.current=setInterval(()=>setRecSec(s=>s+1),1000);
    }catch(e){alert("Нет доступа к микрофону");}
  };
  const stopVoice=()=>{if(mediaRef.current?.state==="recording")mediaRef.current.stop();setRecording(false);setRecSec(0);clearInterval(timerRef.current);};

  const[circleStream,setCircleStream]=useState(null);
  const[msgSearch,setMsgSearch]=useState("");
  const[showMsgSearch,setShowMsgSearch]=useState(false);
  const[fwdMsg,setFwdMsg]=useState(null); // message to forward
  const[voiceHolding,setVoiceHolding]=useState(false);
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
    setShowAttach(false);setShowEmoji(false);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing,width:{ideal:400},height:{ideal:400}},audio:true});
      setCircleStream(stream);setFacingMode(facing);
      if(circlePreviewRef.current){
        circlePreviewRef.current.srcObject=stream;
        circlePreviewRef.current.muted=true;
        circlePreviewRef.current.play().catch(()=>{});
      }
      const mimeType=MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")?"video/webm;codecs=vp8,opus":"video/webm";
      const mr=new MediaRecorder(stream,{mimeType});mediaRef.current=mr;chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=async()=>{
        stream.getTracks().forEach(t=>t.stop());setCircleStream(null);
        const blob=new Blob(chunksRef.current,{type:"video/webm"});
        setUploading(true);
        try{
          // ✅ Через Go сервер (Telegram) — надёжно, не зависит от Firebase Storage
          const circleFile=new File([blob],`circle_${Date.now()}.webm`,{type:"video/webm"});
          const videoUrl=await serverUpload(circleFile,()=>{});
          sendMsg({type:"circle",duration:`0:${String(recSec).padStart(2,"0")}`,videoUrl});
          playSound("sent");
        }catch(err){
          // Fallback: base64 (только для совсем маленьких кружков)
          try{
            const reader=new FileReader();
            await new Promise(res=>{reader.onloadend=res;reader.readAsDataURL(blob);});
            sendMsg({type:"circle",duration:`0:${String(recSec).padStart(2,"0")}`,videoData:reader.result});
            playSound("sent");
          }catch(e2){
            alert("Ошибка кружка: "+err.message);
          }
        }
        setUploading(false);
      };
      mr.start(100);setRecCircle(true);setRecSec(0);
      timerRef.current=setInterval(()=>setRecSec(s=>s+1),1000);
      setTimeout(()=>{if(mr.state==="recording"){mr.stop();setRecCircle(false);setRecSec(0);clearInterval(timerRef.current);}},120000);
    }catch(e){alert("Нет доступа к камере: "+e.message);}
  };
  const stopCircle=()=>{if(mediaRef.current?.state==="recording")mediaRef.current.stop();setRecCircle(false);setRecSec(0);clearInterval(timerRef.current);};
  const cancelCircle=()=>{
    if(mediaRef.current?.state==="recording"){mediaRef.current.ondataavailable=null;mediaRef.current.onstop=null;mediaRef.current.stop();}
    circleStream?.getTracks().forEach(t=>t.stop());setCircleStream(null);
    setRecCircle(false);setRecSec(0);clearInterval(timerRef.current);chunksRef.current=[];
  };
  const flipCamera=()=>{cancelCircle();setTimeout(()=>startCircle(facingMode==="user"?"environment":"user"),300);};

  if(!chatData)return null;
  const isChannel=chatData.type==="channel";
  const isGroup=chatData.type==="group";
  const canWrite=!isChannel||chatData.creatorUid===currentUser.uid;
  const canManage=(isGroup||isChannel)&&chatData.creatorUid===currentUser.uid;

  return(
    <div
      style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:bg||"#0E0E0E",display:"flex",flexDirection:"column",zIndex:100,
        animation:"pageSlideIn 0.28s cubic-bezier(0.25,0.46,0.45,0.94)"
      }} onClick={()=>{setShowEmoji(false);setShowAttach(false);}}>        {/* Pinned Message */}
        {!online&&(
          <div style={{background:"#ff9800",color:"#000",fontSize:12,fontWeight:700,textAlign:"center",padding:"5px 12px",flexShrink:0,letterSpacing:0.3}}>
            📵 Офлайн — показаны кэшированные сообщения
          </div>
        )}
        {pinnedMsg&&<PinnedBar msg={pinnedMsg} canPin={canManage} onUnpin={()=>updateDoc(doc(db,"chats",chat.id),{pinnedMsg:null}).catch(()=>{})}/>}
        {/* Header */}
        <div style={{paddingTop:"max(env(safe-area-inset-top,28px),28px)",paddingLeft:13,paddingRight:13,paddingBottom:9,background:surface||"#1C1C1E",borderBottom:`1px solid ${border}`,display:"flex",alignItems:"center",gap:11,flexShrink:0,boxShadow:"0 1px 6px rgba(0,0,0,0.18)"}} onClick={e=>e.stopPropagation()}>
          <button onClick={onBack} style={{background:"none",border:"none",color:accent,fontSize:22,cursor:"pointer"}}>←</button>
          <Avatar name={chatData.name} size={38} photo={chatData.photo||partnerPhoto||chatData._partnerPhoto} onClick={()=>onViewProfile(chatData.uid||Object.keys(chatData.names||{}).find(k=>k!==currentUser.uid))}/>
          <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>onViewProfile(chatData.uid||Object.keys(chatData.names||{}).find(k=>k!==currentUser.uid))}>
            <div style={{color:text,fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{isChannel?"📢 ":isGroup?"🫂 ":""}{chatData.name}</div>
            <div style={{color:typingUsers.length>0?"#4CAF50":text2,fontSize:11,marginTop:1}}>
              {typingUsers.length>0
                ? <span style={{animation:"pulse 1s infinite"}}>✏️ {typingUsers.join(", ")} печатает...</span>
                : isChannel?"канал"
                : isGroup?`${chatData.members?.length||1} участников`
                : (()=>{
                    if(!partnerData)return "личный чат";
                    // Собеседник скрыл онлайн
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
          <button onClick={e=>{e.stopPropagation();setShowSearch(true);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:text2,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🔍</button>
        {(isGroup||isChannel)&&<button onClick={e=>{e.stopPropagation();setShowMembers(true);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:text2,fontSize:15,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>👤</button>}
          {canManage&&<button onClick={e=>{e.stopPropagation();setShowAddMembers(true);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:accent,fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>👥</button>}
          <div style={{position:"relative"}}>
            <button onClick={e=>{e.stopPropagation();setShowChatMenu(m=>!m);}} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:text2,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>⋮</button>
            {showChatMenu&&(<>
              <div style={{position:"fixed",inset:0,zIndex:199}} onClick={()=>setShowChatMenu(false)}/>
              <div style={{position:"absolute",top:42,right:0,background:surface,border:`1px solid ${border}`,borderRadius:14,zIndex:200,minWidth:190,boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}} onClick={e=>e.stopPropagation()}>
                {[
                  {ico:isMuted?"🔔":"🔇",lbl:isMuted?"Включить звук":"Выключить звук",fn:()=>{const m=!isMuted;setIsMuted(m);setS("mute_"+chat.id,m);setShowChatMenu(false);}},
                  {ico:"🗑",lbl:"Удалить чат",red:true,fn:()=>{
                    if(window.confirm("Удалить чат у себя?")){
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

        {/* Messages */}
        <div ref={msgsRef}
          onScroll={e=>{
            const el=e.target;
            // Обновляем флаг близости к низу (порог ~300px ≈ 5 сообщений)
            isNearBottomRef.current=(el.scrollHeight-el.scrollTop-el.clientHeight)<300;
            // loadingOlderRef — синхронная проверка, не ждём setState
            if(el.scrollTop<200&&!loadingOlderRef.current)loadOlderMsgs();
          }}
          style={{flex:1,overflowY:"auto",scrollBehavior:"auto",padding:"10px 8px",display:"flex",flexDirection:"column",
          background:wallpaperId&&wallpaperId!=="none"?(WALLPAPERS.find(w=>w.id===wallpaperId)||{}).bg||"none":"none",
          backgroundSize:"auto",
        }} onClick={()=>{setShowEmoji(false);setShowAttach(false);}}>
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
            if(m.deletedFor?.[currentUser.uid]||m.deletedForAll)return(
              <div key={m.id||i} style={{textAlign:"center",color:"#555",fontSize:11,margin:"4px 0",fontStyle:"italic"}}>Сообщение удалено</div>
            );
            return <Msg key={m.id||i} msg={{...m,_partnerAllowsReceipts:partnerData?.readReceipts!==false}} myUid={currentUser.uid} prevMsg={i>0?msgs[i-1]:null} usersCache={usersCache} idx={i} onAvatarClick={uid=>uid&&onViewProfile(uid)} onReply={msg=>{setReplyTo(msg);inputRef.current?.focus();}} onOpenLightbox={setLightbox} onLongPress={()=>{lpActiveRef.current=true;setCtxMsg(m);}} onLongPressEnd={()=>{setTimeout(()=>lpActiveRef.current=false,500);}} onCircleFs={src=>setCircleFs(src)} msgFontSize={msgFontSize}/>;
          })}
          <div ref={bottomRef}/>
        </div>

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

        {/* Emoji panel */}
        {showEmoji&&(
          <div onClick={e=>e.stopPropagation()}>
            <EmojiPanel
              onEmoji={e=>{setInputText(t=>t+e);inputRef.current?.focus();}}
              onSticker={e=>{sendMsg({type:"sticker",text:e});playSound("sent");}}
              onClose={()=>setShowEmoji(false)}/>
          </div>
        )}

        {/* Attach panel */}
        {showAttach&&!showEmoji&&(
          <div style={{background:surface,border:`1px solid ${border}`,borderRadius:"18px 18px 0 0",padding:"14px 12px",boxShadow:"0 -6px 24px rgba(0,0,0,0.3)",animation:"slideUp 0.2s ease"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:9}}>
              {[{ico:"🖼",lbl:"Галерея",fn:()=>{if(galleryRef.current){galleryRef.current.click();}}},{ico:"📁",lbl:"Файл",fn:()=>fileRef.current?.click()},{ico:"🎵",lbl:"Музыка",fn:()=>fileRef.current?.click()},{ico:"⭕",lbl:"Кружок",fn:startCircle}].map(b=>(
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
          <div style={{padding:"7px 9px",paddingBottom:"max(7px,env(safe-area-inset-bottom,7px))",background:surface+"E8",borderTop:`1px solid ${border}`,backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)",flexShrink:0}} onClick={e=>e.stopPropagation()}>
            {!online&&(
              <div style={{textAlign:"center",color:"#ff9800",fontSize:13,padding:"10px 0",fontWeight:600}}>
                📵 Отправка недоступна без интернета
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
            {online&&(recording?(
              <div style={{display:"flex",alignItems:"center",gap:9,background:surface2,borderRadius:22,padding:"9px 14px",animation:"fadeIn 0.2s ease"}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:accent,animation:"pulse 1s infinite",flexShrink:0}}/>
                <span style={{color:text2,fontSize:13,flex:1}}>0:{String(recSec).padStart(2,"0")}</span>
                <button onClick={stopVoice} style={{background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",borderRadius:18,padding:"6px 14px",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✓</button>
                <button onClick={()=>{if(mediaRef.current?.state==="recording"){mediaRef.current.ondataavailable=null;mediaRef.current.onstop=null;mediaRef.current.stop();}setRecording(false);setRecSec(0);clearInterval(timerRef.current);}} style={{background:"rgba(255,255,255,0.07)",border:"none",borderRadius:18,padding:"6px 10px",color:text2,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
              </div>
            ):(
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <button onClick={e=>{e.stopPropagation();setShowAttach(a=>!a);setShowEmoji(false);}} style={{width:42,height:42,borderRadius:"50%",background:showAttach?accent+"33":surface2,border:`1.5px solid ${showAttach?accent:border}`,cursor:"pointer",fontSize:19,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>📎</button>
                <button onClick={e=>{e.stopPropagation();setShowEmoji(a=>!a);setShowAttach(false);}} style={{width:42,height:42,borderRadius:"50%",background:showEmoji?accent+"33":surface2,border:`1.5px solid ${showEmoji?accent:border}`,cursor:"pointer",fontSize:19,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>😊</button>
                <input ref={inputRef}
                  defaultValue=""
                  onInput={e=>{
                    const v=e.target.value;
                    setInputText(v);
                    setHasText(v.length>0);
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
                  onClick={e=>{e.stopPropagation();setShowEmoji(false);setShowAttach(false);}}
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
                        onMouseDown={e=>{e.preventDefault();setVoiceHolding(true);lpVoiceRef.current=setTimeout(()=>{if(navigator.vibrate)navigator.vibrate(40);startVoice();setVoiceHolding(false);},400);}}
                        onMouseUp={()=>{clearTimeout(lpVoiceRef.current);setVoiceHolding(false);}}
                        onTouchStart={e=>{e.preventDefault();setVoiceHolding(true);lpVoiceRef.current=setTimeout(()=>{if(navigator.vibrate)navigator.vibrate(40);startVoice();setVoiceHolding(false);},400);}}
                        onTouchEnd={()=>{clearTimeout(lpVoiceRef.current);setVoiceHolding(false);}}
                        onClick={startVoice}
                        style={{width:42,height:42,borderRadius:"50%",
                          background:voiceHolding?accent+"44":surface2,
                          border:`1.5px solid ${voiceHolding?accent:border}`,
                          cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",
                          justifyContent:"center",flexShrink:0,
                          transition:"all 0.15s",WebkitTapHighlightColor:"transparent",
                          transform:voiceHolding?"scale(1.12)":"scale(1)"}}>🎙</button>
                    </div>
                    <button onClick={()=>startCircle("user")}
                      style={{width:42,height:42,borderRadius:"50%",background:surface2,border:`1.5px solid ${border}`,cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s",WebkitTapHighlightColor:"transparent"}}
                      onMouseEnter={e=>{e.currentTarget.style.background=accent+"33";e.currentTarget.style.borderColor=accent;}}
                      onMouseLeave={e=>{e.currentTarget.style.background=surface2;e.currentTarget.style.borderColor=border;}}>⭕</button>
                  </div>
                )}
                {inputText.trim()&&(
                  <button onClick={uploading?undefined:handleSend} disabled={!!uploading} style={{width:42,height:42,borderRadius:"50%",background:uploading?surface2:`linear-gradient(135deg,${accent},${accent2})`,border:"none",cursor:uploading?"not-allowed":"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:uploading?"none":`0 3px 12px ${accent}55`,animation:"popIn 0.18s cubic-bezier(0.34,1.56,0.64,1)",opacity:uploading?0.5:1}}
                  onMouseDown={e=>e.preventDefault()}>➤</button>
                )}
              </div>
            ))}
          </div>
        ):(
          <div style={{padding:14,background:surface,borderTop:`1px solid ${border}`,textAlign:"center",color:text2,fontSize:13}}>📢 Только администратор может публиковать</div>
        )}

        <input ref={fileRef} type="file" accept="image/*,audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.opus,.pdf,.doc,.docx,.zip,.txt,.xls,.xlsx" onChange={handleFile} style={{display:"none"}}/>
        <input ref={galleryRef} type="file" accept="image/*,video/*" multiple onChange={handleFile} style={{display:"none"}}/>
        {lightbox&&<Lightbox src={lightbox.src} fileName={lightbox.fileName} fileType={lightbox.fileType} onClose={()=>setLightbox(null)}/> }
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
                      lastTime:serverTimestamp(),
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
      {ctxMsg&&<MsgContextMenu msg={ctxMsg} myUid={currentUser.uid} chatId={chat.id} onClose={()=>setCtxMsg(null)} onReply={msg=>{setReplyTo(msg);inputRef.current?.focus();}} onEdit={msg=>{setEditMsg(msg);setInputText(msg.text);setTimeout(()=>inputRef.current?.focus(),100);}} onForward={msg=>setFwdMsg(msg)}/>}
    </div>
  );
}

// ─── Chat List ────────────────────────────────────────────────────────────────
function ChatList({currentUser,profile,onOpen,onFind,onEditProfile,onSettings,onChatsLoad}){
  const {bg,surface,surface2,border,text,text2,accent,accent2}=useContext(ThemeCtx);
  const CACHE_KEY="rmg_chats_"+currentUser.uid;
  const cachedChats=()=>{try{const c=JSON.parse(localStorage.getItem(CACHE_KEY)||"[]");return c;}catch{return[];}};
  const[chats,setChats]=useState(cachedChats);
  // true после первого ответа Firestore или если кэш уже есть — убирает flash "Нет чатов"
  const[chatsReady,setChatsReady]=useState(()=>cachedChats().length>0);
  const[search,setSearch]=useState("");
  const[showArchive,setShowArchive]=useState(false);
  const TABS=[
    {id:"all",icon:"💬",label:"Чаты"},
    {id:"direct",icon:"👤",label:"Личные"},
    {id:"groups",icon:"🫂",label:"Группы"},
    {id:"channels",icon:"📢",label:"Каналы"},
  ];
  const[tabIdx,setTabIdx]=useState(0);
  const[swipeOffset,setSwipeOffset]=useState(0);
  const[isSwiping,setIsSwiping]=useState(false);
  const swipeStartX=useRef(0);
  const swipeStartY=useRef(0);
  const swipeIsHoriz=useRef(null); // null=не определено, true=горизонт, false=вертикаль
  const tab=TABS[tabIdx]?.id||"all";
  const[creating,setCreating]=useState(null);
  const[fab,setFab]=useState(false);

  // Кэш фото пользователей для аватарок
  const[photosCache,setPhotosCache]=useState(()=>{try{return JSON.parse(localStorage.getItem("mrx_photos")||"{}");}catch{return{};}});

  useEffect(()=>{
    const q=query(collection(db,"chats"),where("members","array-contains",currentUser.uid));
    return onSnapshot(q,async snap=>{
      const list=snap.docs.map(d=>({id:d.id,...d.data()}));
      list.sort((a,b)=>{
        const ta=a.lastTime||"";const tb=b.lastTime||"";
        if(!ta&&!tb)return 0;if(!ta)return 1;if(!tb)return -1;
        return tb>ta?1:-1;
      });

      // Fetch ALL partner photos
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
        setPhotosCache(prev=>{
          const m={...prev,...fetched};
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

      // Filter hidden chats using localStorage
      const _hidden=JSON.parse(localStorage.getItem("rmg_hidden_chats_"+(currentUser.uid))||"[]");
      const filtered=list.filter(c=>!_hidden.includes(c.id));
      setChats(filtered);onChatsLoad?.(filtered);
      setChatsReady(true);
      try{localStorage.setItem(CACHE_KEY,JSON.stringify(list.slice(0,50)));}catch(e){}
    });
  },[currentUser.uid]);

  const[ctxChat,setCtxChat]=useState(null);
  const[ctxPos,setCtxPos]=useState({x:0,y:0});

  const openCtx=(c,e)=>{
    e.preventDefault();
    setCtxChat({...c,name:getName(c)});
  };

  const muteChat=async(c)=>{
    const muted=getS("mute_"+c.id);
    setS("mute_"+c.id,muted?0:1);
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
      // Save to localStorage FIRST (persists after re-login)
      const key="rmg_hidden_chats_"+currentUser.uid;
      const hidden=JSON.parse(localStorage.getItem(key)||"[]");
      if(!hidden.includes(c.id)){hidden.push(c.id);}
      localStorage.setItem(key,JSON.stringify(hidden));
      // Remove from local state immediately
      setChats(prev=>prev.filter(ch=>ch.id!==c.id));
      // Remove self from members in Firestore
      await updateDoc(doc(db,"chats",c.id),{
        members:(c.members||[]).filter(m=>m!==currentUser.uid),
      }).catch(()=>{});
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
      await updateDoc(doc(db,"chats",c.id),{unread:0});
    }catch(e){}
    setCtxChat(null);
  };

  const getName=c=>{if(c.type==="direct"&&c.names){const o=Object.keys(c.names).find(k=>k!==currentUser.uid);return c.names[o]||c.name;}return c.name;};

  const filtered=chats.filter(c=>tab==="all"||(tab==="direct"&&c.type==="direct")||(tab==="groups"&&c.type==="group")||(tab==="channels"&&c.type==="channel")).filter(c=>(getName(c)||"").toLowerCase().includes(search.toLowerCase()));

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",width:"100%",background:bg||"#0A0A0A",position:"relative"}}>
      {/* ── Top Header ── */}
      <div style={{paddingTop:"max(env(safe-area-inset-top,28px),28px)",paddingLeft:14,paddingRight:14,paddingBottom:9,background:surface+"EE",borderBottom:`1px solid ${border}`,backdropFilter:"blur(16px)",WebkitBackdropFilter:"blur(16px)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:9}}>
          <div style={{color:text,fontWeight:800,fontSize:20,display:"flex",alignItems:"center",gap:8}}>
            {tab==="all"&&<>💬 <span>Чаты</span></>}
            {tab==="direct"&&<>👤 <span>Личные</span></>}
            {tab==="groups"&&<>🫂 <span>Группы</span></>}
            {tab==="channels"&&<>📢 <span>Каналы</span></>}
          </div>
          <div style={{display:"flex",gap:7}}>
            <button onClick={onFind} style={{width:36,height:36,borderRadius:"50%",background:surface2,border:`1px solid ${border}`,color:accent,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>🔍</button>
            <button onClick={()=>setFab(f=>!f)} style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${accent},${accent2})`,border:"none",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform 0.25s",transform:fab?"rotate(45deg)":"none"}}>✏️</button>
          </div>
        </div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍  Поиск..." style={{width:"100%",background:surface2,border:"none",borderRadius:13,padding:"9px 13px",color:text,fontSize:13,transition:"all 0.3s ease",outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
      </div>
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
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"60%",textAlign:"center"}}>
                    {!chatsReady?(
                      // Ещё загружается — тихий спиннер вместо "Нет чатов"
                      <div style={{width:28,height:28,borderRadius:"50%",border:`3px solid ${accent}33`,borderTopColor:accent,animation:"spin 0.7s linear infinite"}}/>
                    ):(
                      <>
                        <div style={{fontSize:46,marginBottom:10,opacity:0.3}}>{tabDef.icon}</div>
                        <div style={{color:text2,fontSize:14}}>Нет чатов</div>
                      </>
                    )}
                  </div>
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
                          c.photo||c._partnerPhoto||
                          (c.type==="direct"&&c.names?photosCache[Object.keys(c.names).find(k=>k!==currentUser.uid)]:null)
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
          <button onClick={()=>{setFab(false);setCreating("channel");}} style={{display:"flex",alignItems:"center",gap:9,padding:"10px 18px",background:surface,border:`1px solid ${border}`,borderRadius:18,color:text,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",whiteSpace:"nowrap"}}>📢 Создать канал</button>
          <button onClick={()=>{setFab(false);setCreating("group");}} style={{display:"flex",alignItems:"center",gap:9,padding:"10px 18px",background:surface,border:`1px solid ${border}`,borderRadius:18,color:text,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",whiteSpace:"nowrap"}}>🫂 Создать группу</button>
        </div>
      )}

      {/* ── Bottom Navigation Bar ── */}
      <div style={{position:"absolute",bottom:0,left:0,right:0,background:surface,borderTop:`1px solid ${border}`,zIndex:100,paddingBottom:"env(safe-area-inset-bottom,0px)"}}>
        {/* Tab indicator */}
        <div style={{position:"relative",height:2,background:"transparent",overflow:"visible"}}>
          <div style={{
            position:"absolute",top:0,height:2,
            width:`${100/5}%`,
            left:`${tabIdx*(100/5)}%`,
            background:accent,borderRadius:2,
            boxShadow:`0 0 8px ${accent}88`,
            transition:"left 0.32s cubic-bezier(0.25,0.46,0.45,0.94)"
          }}/>
        </div>
        <div style={{display:"flex",alignItems:"center",height:60}}>
          {[...TABS,{id:"profile",icon:null,label:"Профиль"}].map((t,i)=>(
            <button key={t.id} onClick={()=>{if(t.id==="profile"){onSettings();}else setTabIdx(i);}}
              style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                gap:3,background:"none",border:"none",cursor:"pointer",padding:"4px 2px",
                fontFamily:"inherit",transition:"all 0.18s"}}>
              {t.id==="profile"
                ? <Avatar name={profile?.name||"?"} size={26} photo={profile?.photo}/>
                : <div style={{fontSize:22,lineHeight:1,
                    filter:tabIdx===i?"none":"grayscale(0.4)",
                    opacity:tabIdx===i?1:0.4,
                    transition:"all 0.2s",
                    transform:tabIdx===i?"scale(1.1)":"scale(1)"
                  }}>{t.icon}</div>
              }
              <div style={{fontSize:10,color:tabIdx===i?accent:text2,fontWeight:tabIdx===i?700:400,transition:"color 0.2s"}}>{t.label}</div>
            </button>
          ))}
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
              {ico:"💬",lbl:"Открыть",fn:()=>{onOpen(ctxChat);setCtxChat(null);}},
              {ico:getS("pin_"+ctxChat.id)?"📌":"📌",lbl:getS("pin_"+ctxChat.id)?"Открепить":"Закрепить",fn:()=>pinChat(ctxChat)},
              {ico:getS("archive_"+ctxChat.id)?"📤":"🗄",lbl:getS("archive_"+ctxChat.id)?"Из архива":"В архив",fn:()=>{setS("archive_"+ctxChat.id,getS("archive_"+ctxChat.id)?0:1);setCtxChat(null);}},
              {ico:getS("mute_"+ctxChat.id)?"🔔":"🔇",lbl:getS("mute_"+ctxChat.id)?"Включить звук":"Выключить звук",fn:()=>muteChat(ctxChat)},
              {ico:"✓",lbl:"Прочитать",fn:()=>markRead(ctxChat)},
              {ico:"🗑",lbl:"Очистить у себя",red:true,fn:()=>{if(window.confirm("Очистить историю у себя?"))clearChatHistory(ctxChat);}},
              {ico:"💣",lbl:"Удалить у всех",red:true,fn:()=>{if(window.confirm("Удалить переписку у ВСЕХ участников? Это нельзя отменить!"))deleteChatForEveryone(ctxChat);}},
              {ico:"🚪",lbl:ctxChat.type==="direct"?"Удалить чат":"Покинуть",red:true,fn:()=>{if(window.confirm(ctxChat.type==="direct"?"Удалить чат?":"Покинуть?"))deleteChat(ctxChat);}},
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

// ─── Push Notifications Setup ────────────────────────────────────────────────
// VAPID key from Firebase Console → Project Settings → Cloud Messaging → Web Push
const VAPID_KEY = "BFpVpThleFei4uBXJrDcpkH57YIvJ6DHUxaeXK280vYMstLwDB75dDSzIA-uUNt4fygeVvxtxpt7hosyI-2bM_Q";

async function setupFCM(uid) {
  try {
    if (window?.Capacitor?.isNativePlatform?.()) {
      try {
        const { PushNotifications } = window.Capacitor.Plugins;
        if (PushNotifications) {
          const perm = await PushNotifications.requestPermissions();
          if (perm.receive === "granted") {
            await PushNotifications.register();

            // Создаём канал уведомлений для Android 8+
            try {
              await PushNotifications.createChannel({
                id: "default",
                name: "MrX",
                description: "Сообщения",
                importance: 5, // IMPORTANCE_HIGH
                visibility: 1,
                sound: "default",
                vibration: true,
                lights: true,
                lightColor: "#E53935",
              });
            } catch(e){}

            PushNotifications.addListener("registration", async token => {
              if (token?.value && uid) {
                await updateDoc(doc(db, "users", uid), { fcmToken: token.value }).catch(() => {});
                serverSaveFCM(uid, token.value);
                console.log("✅ FCM token saved:", token.value.slice(0,20)+"...");
              }
            });

            // Foreground — только звук
            PushNotifications.addListener("pushNotificationReceived", notification => {
              playSound("msg");
            });

            // Тап по уведомлению когда приложение свёрнуто/закрыто
            PushNotifications.addListener("pushNotificationActionPerformed", action => {
              console.log("📲 Notification tapped:", action);
              // Можно добавить навигацию в нужный чат по action.notification.data.chatId
            });

            PushNotifications.addListener("registrationError", err => {
              console.log("FCM error:", err);
            });
          }
        }
      } catch (capErr) {
        console.log("Capacitor push error:", capErr.message);
      }
      return;
    }

    // Web / PWA
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return;

    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return;

    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;

    try {
      const { getApps } = await import("firebase/app").catch(() => ({}));
      const { getMessaging: getMsg, getToken: getT, onMessage: onMsg } = await import("firebase/messaging").catch(() => ({}));
      if (!getMsg) return;
      const apps = getApps ? getApps() : [];
      if (!apps.length) return;
      const messaging = getMsg(apps[0]);
      const token = await getT(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (token && uid) {
        await updateDoc(doc(db, "users", uid), { fcmToken: token }).catch(() => {});
      }
      // Приложение открыто — только звук, без popup уведомления
      onMsg(messaging, payload => {
        playSound("msg");
        // НЕ создаём new Notification() — только звук
      });
    } catch (e) {
      console.log("FCM messaging error:", e.message);
    }
  } catch (e) {
    console.log("FCM setup error:", e.message);
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
  const[showSettings,setShowSettings]=useState(false);
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
  useEffect(()=>{
    const up=()=>setOnline(true);
    const dn=()=>{setOnline(false);setToast({msg:"Нет интернета — режим оффлайн",type:"warn"});}
    window.addEventListener("online",up);
    window.addEventListener("offline",dn);
    return()=>{window.removeEventListener("online",up);window.removeEventListener("offline",dn);};
  },[]);
  const[miniTrack,setMiniTrack]=useState(null);
  const playerCtx={track:miniTrack,setTrack:setMiniTrack};
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
  const showSettingsRef=useRef(false);
  const viewProfileRef=useRef(null);
  // Init SQLite on mount
  useEffect(()=>{
    initSQLite();
  },[]);

  useEffect(()=>{screenRef.current=screen;},[screen]);
  useEffect(()=>{findingRef.current=finding;},[finding]);
  useEffect(()=>{editingRef.current=editing;},[editing]);
  useEffect(()=>{showSettingsRef.current=showSettings;},[showSettings]);
  useEffect(()=>{viewProfileRef.current=viewProfileUid;},[viewProfileUid]);

  const changeTheme=t=>{setThemeName(t);localStorage.setItem("rmg_theme",t);if(fbUser)updateDoc(doc(db,"users",fbUser.uid),{theme:t}).catch(()=>{});};

  // ── Back button (simple, no Capacitor async) ─────────────────────────────
  useEffect(()=>{
    const handler=(e)=>{
      // Всегда перехватываем — никогда не выходим по кнопке назад
      if(e && e.preventDefault) e.preventDefault();

      if(viewProfileRef.current){setViewProfileUid(null);return;}
      if(findingRef.current){setFinding(false);return;}
      if(editingRef.current){setEditing(false);return;}
      if(showSettingsRef.current){setShowSettings(false);return;}
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

  useEffect(()=>{
    if(!fbUser)return;
    const hb=()=>{
      const s=JSON.parse(localStorage.getItem("rmg_s")||"{}");
      updateDoc(doc(db,"users",fbUser.uid),{
        lastSeen:serverTimestamp(),
        showOnline:s.showOnline!==false,
        showLastSeen:s.showLastSeen!==false,
        readReceipts:s.readReceipts!==false,
      }).catch(()=>{});
    };
    hb();const id=setInterval(hb,30000);
    // Setup push notifications
    setupFCM(fbUser.uid);
    // Re-save existing FCM token to Go server on every login
    getDoc(doc(db,"users",fbUser.uid)).then(s=>{
      const t=s.data()?.fcmToken;
      if(t)serverSaveFCM(fbUser.uid,t);
    }).catch(()=>{});
    // Re-register token on every app open
    try{
      if(window?.Capacitor?.isNativePlatform?.()&&window.Capacitor.Plugins.PushNotifications){
        const {PushNotifications}=window.Capacitor.Plugins;
        PushNotifications.register().catch(()=>{});
      }
    }catch(e){}
    return()=>clearInterval(id);
  },[fbUser]);

  useEffect(()=>{
    if(!fbUser)return;
    const seen={};
    const q=query(collection(db,"chats"),where("members","array-contains",fbUser.uid));
    return onSnapshot(q,snap=>{
      snap.docChanges().forEach(ch=>{
        if(ch.type==="modified"){
          const d=ch.doc.data(),chatId=ch.doc.id;
          if(d.lastMsg&&d.lastTime&&d.lastTime!==seen[chatId]){
            seen[chatId]=d.lastTime;
            if(screen!=="chat"||activeChat?.id!==chatId){
              const cname=d.type==="direct"&&d.names?Object.values(d.names).find(n=>n!==profile?.name)||d.name:d.name;
              playSound("msg");
              setToast({icon:"💬",title:cname||"Новое сообщение",body:d.lastMsg,onClick:()=>{setActiveChat({id:chatId,...d,name:cname});setScreen("chat");setToast(null);}});
            }
          }
        }
      });
    });
  },[fbUser,screen,activeChat?.id,profile?.name]);

  const startChatWithUser=async(person)=>{
    const chatId=[fbUser.uid,person.uid].sort().join("_");
    const chatRef=doc(db,"chats",chatId);
    if(!(await getDoc(chatRef)).exists())await setDoc(chatRef,{id:chatId,type:"direct",members:[fbUser.uid,person.uid],names:{[fbUser.uid]:profile.name,[person.uid]:person.name},created:serverTimestamp(),lastMsg:"",lastTime:""});
    setViewProfileUid(null);
    setActiveChat({id:chatId,type:"direct",name:person.name,tag:person.tag,uid:person.uid});
    setScreen("chat");
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
    @keyframes popIn{from{opacity:0;transform:scale(0.35)}to{opacity:1;transform:scale(1)}}
    @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
    @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(-18px) scale(0.92)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
    @keyframes pageSlideIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
    @keyframes pageSlideOut{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(100%)}}
    @keyframes chatSlideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
    @keyframes chatSlideOut{0%{transform:translateX(0)}100%{transform:translateX(100%)}}
    @keyframes listSlideOut{from{transform:translateX(0)}to{transform:translateX(-28%)}}
    @keyframes listSlideIn{0%{transform:translateX(-28%)}100%{transform:translateX(0)}}
    @keyframes chatSwipeBack{from{transform:translateX(var(--swipe-x,0px));opacity:1}to{transform:translateX(100%);opacity:0}}
    @keyframes bottomNavIn{from{transform:translateY(100%)}to{transform:none}}
    @keyframes listIn{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes ripple{0%{transform:scale(1);opacity:0.5}100%{transform:scale(1.8);opacity:0}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    @keyframes scalePress{from{transform:scale(1)}to{transform:scale(0.94)}}
    @keyframes glassOrb1{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(60px,-40px) scale(1.15)}66%{transform:translate(-40px,50px) scale(0.9)}}
    @keyframes glassOrb2{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(-70px,30px) scale(0.85)}66%{transform:translate(50px,-60px) scale(1.2)}}
    @keyframes glassOrb3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(40px,70px) scale(1.1)}}
    @keyframes glassShimmer{0%{background-position:200% center}100%{background-position:-200% center}}
    input::placeholder,textarea::placeholder{color:${theme.text2}55}
    button{-webkit-user-select:none;user-select:none}

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
  if(fbUser===undefined)return(
    <PlayerCtx.Provider value={{track:null,setTrack:()=>{}}}>
    <ThemeCtx.Provider value={theme}>
      <style>{CSS+`
        @keyframes splashRing{from{transform:scale(0.85);opacity:0.8;}to{transform:scale(1.25);opacity:0;}}
      `}</style>
      <SplashScreen/>
    </ThemeCtx.Provider>
    </PlayerCtx.Provider>
  );

  return(
    <PlayerCtx.Provider value={playerCtx}>
    <ThemeCtx.Provider value={theme}>
      <style>{CSS}</style>
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
        {miniTrack&&<MiniPlayer track={miniTrack} onClose={()=>setMiniTrack(null)}/>}

        {/* Profile layer - always on top */}
        {viewProfileUid&&(
          <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:600}}>
            <ProfileView uid={viewProfileUid} myUid={fbUser?.uid} onClose={()=>setViewProfileUid(null)} onStartChat={startChatWithUser}/>
          </div>
        )}

        {/* Main layer */}
        {!fbUser?(
          <AuthScreen onAuth={(user,prof,isAnon)=>{setFbUser(user);setProfile(prof);if(isAnon)setEditing(true);}}/>
        ):showSettings?(
          <SettingsScreen currentUser={fbUser} profile={profile} themeName={themeName} onChangeTheme={changeTheme} wallpaperId={wallpaperId} onChangeWallpaper={id=>{setWallpaperId(id);localStorage.setItem("rmg_wallpaper",id);}} accentId={accentId} onChangeAccent={id=>{setAccentId(id);localStorage.setItem("rmg_accent",id);}} msgFontSize={msgFontSize} onChangeFontSize={s=>{setMsgFontSize(s);localStorage.setItem("rmg_fontsize",s);}} onEditProfile={()=>{setShowSettings(false);setEditing(true);}} onClose={()=>setShowSettings(false)} onLogout={()=>{setShowSettings(false);signOut(auth);}}/>
        ):editing?(
          <EditProfile currentUser={fbUser} profile={profile} onSave={updated=>{setProfile(updated);setEditing(false);}} onClose={()=>setEditing(false)}/>
        ):finding?(
          <FindPeople currentUser={fbUser} profile={profile} onClose={()=>setFinding(false)} onStartChat={chat=>{setFinding(false);setActiveChat(chat);setScreenAnim("toChat");setScreen("chat");}}/>
        ):(
          <div style={{position:"relative",width:"100%",height:"100%",overflow:"hidden"}}>
            {/* ChatList — уходит влево при входе в чат, возвращается справа при выходе */}
            <div style={{
              position:"absolute",inset:0,willChange:"transform",
              animation:screenAnim==="toChat"?"listSlideOut 0.3s cubic-bezier(0.4,0,0.2,1) forwards"
                :screenAnim==="toList"?"listSlideIn 0.34s cubic-bezier(0.32,0.72,0,1) forwards":"none",
              pointerEvents:screen==="chat"?"none":"auto",
              zIndex:screen==="list"?1:0,
            }}>
              <ChatList currentUser={fbUser} profile={profile} onOpen={chat=>{setActiveChat(chat);setScreenAnim("toChat");setScreen("chat");}} onFind={()=>setFinding(true)} onEditProfile={()=>setEditing(true)} onSettings={()=>setShowSettings(true)} onChatsLoad={setAppChats}/>
            </div>
            {/* ChatScreen — въезжает справа, уезжает вправо */}
            {activeChat&&(
              <div style={{
                position:"absolute",inset:0,willChange:"transform",
                animation:screenAnim==="toChat"?"chatSlideIn 0.3s cubic-bezier(0.4,0,0.2,1) forwards"
                  :screenAnim==="toList"?"chatSlideOut 0.34s cubic-bezier(0.32,0.72,0,1) forwards":"none",
                pointerEvents:screen==="list"?"none":"auto",
                zIndex:screen==="chat"?1:0,
              }}>
                <ChatErrorBoundary onBack={()=>{setScreenAnim("toList");setTimeout(()=>setScreen("list"),320);}}>
                  <ChatScreen key={activeChat.id} chat={activeChat} currentUser={fbUser} profile={profile}
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
    </PlayerCtx.Provider>
  );
}
