// ────────────────────────────────────────────────────────────────────────────
// auth.js — замена firebase/auth. Работает через /auth/register и /auth/login
// собственного сервера. Сессия хранится в localStorage.
// ────────────────────────────────────────────────────────────────────────────

import { api, loadAuth, setAuth, onAuthChange } from "./core.js";

function fbError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function makeUser(a) {
  if (!a) return null;
  return {
    uid: a.uid,
    email: a.email || null,
    displayName: a.displayName || null,
    photoURL: a.photoURL || null,
    isAnonymous: !!a.isAnonymous,
  };
}

const authObj = {
  currentUser: makeUser(loadAuth()),
};

onAuthChange((a) => {
  authObj.currentUser = makeUser(a);
});

export function getAuth() {
  return authObj;
}

async function doRegister(tag, password, extra) {
  let r;
  try {
    r = await api("/auth/register", {
      method: "POST",
      body: { tag, name: extra.name || "", email: extra.email || "", password },
    });
  } catch (e) {
    if (e.status === 409) throw fbError("auth/email-already-in-use", "Аккаунт уже существует");
    if (e.status === 400 && password.length < 6)
      throw fbError("auth/weak-password", "Слишком короткий пароль");
    throw fbError("auth/network-request-failed", e.message);
  }
  const a = {
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    email: extra.email || null,
    displayName: extra.name || null,
    isAnonymous: !!extra.isAnonymous,
  };
  setAuth(a);
  return { user: authObj.currentUser };
}

export async function createUserWithEmailAndPassword(_auth, email, password) {
  if (!password || password.length < 6)
    throw fbError("auth/weak-password", "Пароль минимум 6 символов");
  return doRegister(String(email).trim().toLowerCase(), password, { email });
}

export async function signInWithEmailAndPassword(_auth, email, password) {
  let r;
  try {
    r = await api("/auth/login", {
      method: "POST",
      body: { tag: String(email).trim().toLowerCase().replace(/^@/,""), password },
    });
  } catch (e) {
    const be = e.body && e.body.error;
    if (e.status === 403 && be === "email_not_verified") {
      const err = fbError("auth/email-not-verified", "Почта не подтверждена");
      err.email = (e.body && e.body.email) || null;
      throw err;
    }
    if (e.status === 403 && be === "email_required")
      throw fbError("auth/email-required", "Нужно привязать почту");
    if (e.status === 401 || e.status === 404 || e.status === 400)
      throw fbError("auth/invalid-credential", "Неверный логин или пароль");
    throw fbError("auth/network-request-failed", e.message);
  }
  setAuth({
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    email,
    displayName: (r.user && r.user.name) || null,
    isAnonymous: false,
  });
  return { user: authObj.currentUser };
}

export async function signInAnonymously(_auth) {
  const LS = "rmg_anon_creds";
  let creds = null;
  try {
    creds = JSON.parse(localStorage.getItem(LS) || "null");
  } catch (e) {}
  if (creds && creds.tag && creds.password) {
    try {
      const r = await api("/auth/login", {
        method: "POST",
        body: { tag: creds.tag, password: creds.password },
      });
      setAuth({
        uid: r.user && (r.user.id || r.user.uid),
        token: r.token,
        email: null,
        displayName: (r.user && r.user.name) || null,
        isAnonymous: true,
      });
      return { user: authObj.currentUser };
    } catch (e) {
      // старый анонимный аккаунт не подошёл — создаём новый
    }
  }
  const rand = () =>
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const tag = "anon_" + rand().slice(0, 12);
  const password = rand() + rand();
  const res = await doRegister(tag, password, { isAnonymous: true });
  try {
    localStorage.setItem(LS, JSON.stringify({ tag, password }));
  } catch (e) {}
  return res;
}

export function onAuthStateChanged(_auth, cb) {
  const off = onAuthChange((a) => {
    try {
      cb(makeUser(a));
    } catch (e) {}
  });
  // сразу сообщаем текущее состояние (как делает Firebase)
  Promise.resolve().then(() => {
    try {
      cb(authObj.currentUser);
    } catch (e) {}
  });
  return off;
}

export async function updateProfile(user, updates) {
  const a = loadAuth();
  if (!a) return;
  if (updates && "displayName" in updates) a.displayName = updates.displayName;
  if (updates && "photoURL" in updates) a.photoURL = updates.photoURL;
  setAuth(a);
  if (user) {
    if (updates && "displayName" in updates) user.displayName = updates.displayName;
    if (updates && "photoURL" in updates) user.photoURL = updates.photoURL;
  }
}

export async function signOut(_auth) {
  setAuth(null);
}

function normLogin(s) {
  return String(s || "").trim().toLowerCase().replace(/^@/, "");
}

export async function registerAccount({ tag, name, email, password }) {
  if (!password || password.length < 6)
    throw fbError("auth/weak-password", "Пароль минимум 6 символов");
  let r;
  try {
    r = await api("/auth/register", {
      method: "POST",
      body: { tag: normLogin(tag), name: name || "", email: String(email || "").trim().toLowerCase(), password },
    });
  } catch (e) {
    const be = e.body && e.body.error;
    if (e.status === 409)
      throw fbError("auth/email-already-in-use", be === "email taken" ? "Эта почта уже занята — попробуй войти" : "Этот @юзернейм уже занят — поменяй его");
    if (e.status === 400)
      throw fbError("auth/invalid-email", "Похоже, в почте опечатка — проверь её");
    if (e.status === 500)
      throw fbError("auth/invalid-email", "Не удалось отправить письмо на эту почту — проверь адрес");
    throw fbError("auth/network-request-failed", e.message);
  }
  if (r.pending) return { pending: true, email: r.email };
  setAuth({
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    email: email || null,
    displayName: name || null,
    isAnonymous: false,
  });
  return { pending: false, user: authObj.currentUser };
}

export async function verifyEmailCode(email, code) {
  let r;
  try {
    r = await api("/auth/verify", {
      method: "POST",
      body: { email: String(email || "").trim().toLowerCase(), code: String(code || "").trim() },
    });
  } catch (e) {
    if (e.status === 400 || e.status === 401 || e.status === 404)
      throw fbError("auth/invalid-code", "Неверный или просроченный код");
    throw fbError("auth/network-request-failed", e.message);
  }
  setAuth({
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    email: String(email || "").trim().toLowerCase(),
    displayName: (r.user && r.user.name) || null,
    isAnonymous: false,
  });
  return { user: authObj.currentUser, raw: r.user || null };
}

export async function resendEmailCode(email) {
  try {
    await api("/auth/resend", {
      method: "POST",
      body: { email: String(email || "").trim().toLowerCase() },
    });
  } catch (e) {
    throw fbError("auth/too-many-requests", "Подожди минуту и попробуй ещё раз");
  }
}

export async function attachEmail(login, password, email) {
  try {
    await api("/auth/attach", {
      method: "POST",
      body: { tag: normLogin(login), password, email: String(email || "").trim().toLowerCase() },
    });
  } catch (e) {
    if (e.status === 409) throw fbError("auth/email-already-in-use", "Эта почта уже занята");
    if (e.status === 401) throw fbError("auth/invalid-credential", "Неверный логин или пароль");
    if (e.status === 429) throw fbError("auth/too-many-requests", "Подожди минуту и попробуй ещё раз");
    if (e.status === 400) throw fbError("auth/invalid-email", "Похоже, в почте опечатка — проверь её");
    throw fbError("auth/network-request-failed", e.message);
  }
}

export async function requestPasswordReset(login) {
  const r = await api("/auth/reset", {
    method: "POST",
    body: { login: String(login || "").trim().toLowerCase().replace(/^@/, "") },
  });
  // r.email = masked email, r.hint = vague message if not found
  return r;
}

export async function confirmPasswordReset(login, code, password) {
  let r;
  try {
    r = await api("/auth/reset/confirm", {
      method: "POST",
      body: {
        login: String(login || "").trim().toLowerCase().replace(/^@/, ""),
        code: String(code || "").trim(),
        password,
      },
    });
  } catch (e) {
    const be = e.body && e.body.error;
    if (e.status === 401 || e.status === 404)
      throw fbError("auth/invalid-code", be === "code expired" ? "Код устарел — запроси новый" : "Неверный код");
    if (e.status === 429)
      throw fbError("auth/too-many-requests", "Слишком много попыток — запроси новый код");
    if (e.status === 400)
      throw fbError("auth/weak-password", "Пароль минимум 6 символов");
    throw fbError("auth/network-request-failed", e.message);
  }
  setAuth({
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    email: login.includes("@") ? login : null,
    displayName: (r.user && r.user.name) || null,
    isAnonymous: false,
  });
  return { user: authObj.currentUser };
}
