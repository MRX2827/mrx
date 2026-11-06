// ───────────────────────────────────────────────────────────────────────────
// core.js — ядро связи с собственным сервером RedMrxGram (вместо Firebase).
// Здесь НЕТ никаких секретов — только публичный адрес сервера.
// ───────────────────────────────────────────────────────────────────────────

import { initializeRoutes, onRouteChange, refreshRoutes, route } from "./routing.js";

export function apiBase() {
  return route.apiBase;
}

const mediaPath = /^\/media\/[a-f0-9]{64}$/;

export function mediaUrl(value) {
  return typeof value === "string" && mediaPath.test(value) ? apiBase() + value : value;
}

export function portableMediaUrl(value) {
  if (typeof value !== "string") return value;
  const path = value.slice(apiBase().length);
  return value.startsWith(apiBase()) && mediaPath.test(path) ? path : value;
}

const LS_AUTH = "rmg_auth_v1";
const LS_TOPIC = "rmg_push_topic";

// ── Авторизация (токен + текущий пользователь) ────────────────────────────

let _auth;
let _authLoaded = false;
const authListeners = new Set();
const pendingReads = new Map();

export function loadAuth() {
  if (_authLoaded) return _auth;
  try {
    _auth = JSON.parse(localStorage.getItem(LS_AUTH) || "null");
  } catch (e) {
    _auth = null;
  }
  _authLoaded = true;
  return _auth;
}

export function setAuth(a) {
  pendingReads.clear();
  _auth = a;
  _authLoaded = true;
  try {
    if (a) localStorage.setItem(LS_AUTH, JSON.stringify(a));
    else localStorage.removeItem(LS_AUTH);
  } catch (e) {}
  authListeners.forEach((cb) => {
    try {
      cb(a);
    } catch (e) {}
  });
  wsReset();
}

export function onAuthChange(cb) {
  authListeners.add(cb);
  return () => authListeners.delete(cb);
}

export function authToken() {
  const a = loadAuth();
  return a ? a.token : null;
}

// ── Топик для пушей (ntfy) — генерируется один раз на устройство ───────────

export function pushTopic() {
  let t = null;
  try {
    t = localStorage.getItem(LS_TOPIC);
  } catch (e) {}
  if (!t) {
    const rnd = (
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now() + "" + Math.random()
    ).replace(/[^a-zA-Z0-9]/g, "");
    t = "rmg" + rnd;
    try {
      localStorage.setItem(LS_TOPIC, t);
    } catch (e) {}
  }
  return t;
}

// ── REST ────────────────────────────────────────────────────────────────────

export async function api(path, opts = {}) {
  await initializeRoutes();
  const headers = { ...(opts.headers || {}) };
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (!isForm) headers["Content-Type"] = "application/json";
  const tok = authToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const url = apiBase() + path;
  const method = (opts.method || "GET").toUpperCase();
  const body = isForm ? opts.body : opts.body != null ? JSON.stringify(opts.body) : undefined;
  const read = !opts.signal && (method === "GET" || (method === "POST" && path === "/q"));
  const key = read ? JSON.stringify([url, method, tok, body, headers]) : null;
  if (key && pendingReads.has(key)) return pendingReads.get(key);
  if (!read && method !== "GET") pendingReads.clear();

  const request = (async () => {
    const res = await fetch(url, {
      ...opts, redirect: "error", credentials: "omit", headers, body,
      signal: opts.signal || AbortSignal.timeout?.(60_000),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(out?.error || "HTTP " + res.status);
      err.status = res.status;
      err.body = out;
      throw err;
    }
    return out;
  })();
  if (key) pendingReads.set(key, request);
  try {
    return await request;
  } finally {
    if (key && pendingReads.get(key) === request) pendingReads.delete(key);
  }
}

// ── WebSocket-подписки (автопереподключение + автопереподписка) ────────────

let ws = null;
let wsTimer = null;
let backoff = 1000;
let subSeq = 0;
let pingTimer = null;
let wsReady = false;
const subs = new Map(); // id -> {msg, cb}

// Состояние соединения — наружу, чтобы UI мог показать "Обновление..." как в
// Telegram, пока WS переподключается (а не только офлайн/онлайн по navigator).
function _emitWsState(state) {
  try {
    window.dispatchEvent(new CustomEvent("rmg:ws", { detail: state }));
  } catch (e) {}
}

function wsSend(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }
}

async function wsConnect() {
  await initializeRoutes();
  if (ws || !subs.size) return;
  const token = authToken();
  if (!token) return;
  _emitWsState("connecting");
  const endpoint = new URL(route.apiBase + "/dws");
  endpoint.protocol = "wss:";
  const useMessage = route.wsAuth === "message";
  if (!useMessage) endpoint.searchParams.set("token", token);

  let socket;
  try {
    socket = new WebSocket(endpoint);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  let ready = false;
  let lastSeen = Date.now();
  const openTimeout = setTimeout(() => { if (!ready) socket.close(); }, 12000);
  function onReady() {
    ready = wsReady = true;
    clearTimeout(openTimeout);
    backoff = 1000;
    _emitWsState("open");
    subs.forEach(s => wsSend(s.msg));
    pingTimer = setInterval(() => {
      if (Date.now() - lastSeen > 65000) socket.close();
      else wsSend({ type: "ping" });
    }, 25000);
  }

  socket.onopen = () => {
    if (ws !== socket) return;
    if (useMessage) wsSend({ type: "auth", token });
    else onReady();
  };
  socket.onmessage = ev => {
    if (ws !== socket) return;
    let message;
    try { message = JSON.parse(ev.data); } catch { return; }
    lastSeen = Date.now();
    if (!ready && useMessage && message?.type === "ready") onReady();
    const sub = ready && subs.get(message?.id);
    if (sub) {
      try { sub.cb(message); } catch { /* isolate UI callbacks */ }
    }
  };
  socket.onclose = () => {
    clearTimeout(openTimeout);
    if (ws !== socket) return;
    ws = null;
    wsReady = false;
    _emitWsState("closed");
    clearInterval(pingTimer);
    pingTimer = null;
    scheduleReconnect();
  };
  socket.onerror = () => socket.close();
}

function scheduleReconnect() {
  if (wsTimer || !subs.size || !authToken()) return;
  wsTimer = setTimeout(() => {
    wsTimer = null;
    void refreshRoutes().catch(() => {});
    void wsConnect();
  }, backoff * (0.75 + Math.random() * 0.25));
  backoff = Math.min(backoff * 1.7, 15000);
}

export function wsReset() {
  const previous = ws;
  ws = null;
  wsReady = false;
  previous?.close();
  clearTimeout(wsTimer);
  clearInterval(pingTimer);
  wsTimer = pingTimer = null;
  if (authToken() && subs.size) void wsConnect();
}

onRouteChange(wsReset);
if (typeof window !== "undefined") {
  const refresh = () => { void refreshRoutes().catch(() => {}); };
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 300000);
}

export function snapshotFallbackDelay() {
  return wsReady ? 1400 : 500;
}

export function subscribe(body, cb) {
  const id = "s" + ++subSeq;
  const msg = { type: "sub", id, ...body };
  subs.set(id, { msg, cb });
  if (!ws) wsConnect();
  else if (wsReady) wsSend(msg);
  return () => {
    subs.delete(id);
    wsSend({ type: "unsub", id });
  };
}
