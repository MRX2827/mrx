// ───────────────────────────────────────────────────────────────────────────
// core.js — ядро связи с собственным сервером RedMrxGram (вместо Firebase).
// Здесь НЕТ никаких секретов — только публичный адрес сервера.
// ───────────────────────────────────────────────────────────────────────────

export const SERVER_HTTP = "https://redmrxgram.duckdns.org";
export const SERVER_WS = SERVER_HTTP.replace(/^http/, "ws") + "/dws";

const LS_AUTH = "rmg_auth_v1";
const LS_TOPIC = "rmg_push_topic";

// ── Авторизация (токен + текущий пользователь) ────────────────────────────

let _auth;
let _authLoaded = false;
const authListeners = new Set();

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
  const headers = { ...(opts.headers || {}) };
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (!isForm) headers["Content-Type"] = "application/json";
  const tok = authToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(SERVER_HTTP + path, {
    ...opts,
    headers,
    body: isForm ? opts.body : opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  let out = null;
  try {
    out = await res.json();
  } catch (e) {}
  if (!res.ok) {
    const err = new Error((out && out.error) || "HTTP " + res.status);
    err.status = res.status;
    err.body = out;
    throw err;
  }
  return out;
}

// ── WebSocket-подписки (автопереподключение + автопереподписка) ────────────

let ws = null;
let wsTimer = null;
let backoff = 1000;
let subSeq = 0;
let pingTimer = null;
const subs = new Map(); // id -> {msg, cb}

function wsSend(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }
}

function wsConnect() {
  const tok = authToken();
  if (!tok || ws) return;
  try {
    ws = new WebSocket(SERVER_WS + "?token=" + encodeURIComponent(tok));
  } catch (e) {
    ws = null;
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoff = 1000;
    subs.forEach((s) => wsSend(s.msg));
    if (!pingTimer) {
      pingTimer = setInterval(() => wsSend({ type: "ping" }), 30000);
    }
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (!m || !m.id) return;
    const s = subs.get(m.id);
    if (!s) return;
    try {
      s.cb(m);
    } catch (e) {}
  };
  ws.onclose = () => {
    ws = null;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      if (ws) ws.close();
    } catch (e) {}
  };
}

function scheduleReconnect() {
  if (wsTimer || !subs.size || !authToken()) return;
  wsTimer = setTimeout(() => {
    wsTimer = null;
    wsConnect();
  }, backoff);
  backoff = Math.min(backoff * 1.7, 15000);
}

export function wsReset() {
  try {
    if (ws) ws.close();
  } catch (e) {}
  ws = null;
  if (authToken() && subs.size) wsConnect();
}

// subscribe — оформляет подписку; cb получает сообщения {type:"snap"|"doc", ...}
export function subscribe(body, cb) {
  const id = "s" + ++subSeq;
  const msg = { type: "sub", id, ...body };
  subs.set(id, { msg, cb });
  if (!ws) wsConnect();
  else wsSend(msg);
  return () => {
    subs.delete(id);
    wsSend({ type: "unsub", id });
  };
}
