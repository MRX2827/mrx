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
    tag: a.tag || "",
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
  const result = await registerAccount({
    tag, password, name: extra.name || "", email: extra.email || "",
    isAnonymous: !!extra.isAnonymous,
  });
  if (result.pending && extra.isAnonymous) {
    throw fbError("auth/registration-unavailable", "Не удалось открыть гостевой аккаунт. Повтори попытку.");
  }
  return result;
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
      err.codeSent = e.body?.codeSent !== false;
      throw err;
    }
    if (e.status === 403 && be === "email_required")
      throw fbError("auth/email-required", "Нужно привязать почту");
    if (e.status === 401 || e.status === 404 || e.status === 400)
      throw fbError("auth/invalid-credential", "Неверный логин или пароль");
    throw registrationError(e);
  }
  setAuth({
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    email: String(email).includes("@") && !String(email).startsWith("@") ? String(email).trim().toLowerCase() : null,
    tag: r.user?.tag || "",
    displayName: (r.user && r.user.name) || null,
    isAnonymous: r.user?.isAnonymous === true,
  });
  return { user: authObj.currentUser };
}

export async function signInAnonymously(_auth) {
  const storageKey = "rmg_anon_creds";
  let credentials;
  try {
    credentials = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (credentials && !credentials.uid) {
      const cached = JSON.parse(localStorage.getItem("rmg_cached_profile") || "null");
      if (cached?.isAnonymous) credentials.uid = cached.uid;
    }
  } catch { /* A new guest can be created if no saved identity exists. */ }
  if (credentials?.tag && credentials.password) {
    try {
      const result = await api("/auth/login", {
        method: "POST",
        body: { tag: credentials.tag, password: credentials.password, guestUid: credentials.uid || "" },
      });
      const uid = result.user.id || result.user.uid;
      const tag = result.user.tag || credentials.tag;
      localStorage.setItem(storageKey, JSON.stringify({ ...credentials, uid, tag }));
      setAuth({ uid, tag, token: result.token, email: null, displayName: result.user.name || null, isAnonymous: true });
      return { user: authObj.currentUser };
    } catch (error) {
      if (error.status !== 401 && error.status !== 404) throw registrationError(error);
    }
  }
  const random = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
  const tag = "anon_" + random().slice(0, 16);
  const password = random();
  const name = "Гость" + Math.floor(1000 + Math.random() * 9000);
  // Persist before the request so a lost response can be resumed without
  // replacing an already-created guest identity.
  localStorage.setItem(storageKey, JSON.stringify({ tag, password }));
  const result = await doRegister(tag, password, { name, isAnonymous: true });
  localStorage.setItem(storageKey, JSON.stringify({ tag, password, uid: result.user.uid }));
  return result;
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

function registrationError(error) {
  const reason = error.body?.error || error.message;
  if (reason === "tag taken") return fbError("auth/email-already-in-use", "Этот @юзернейм уже занят. Попробуй войти или выбери другой.");
  if (reason === "email taken") return fbError("auth/email-already-in-use", "Эта почта уже привязана. Попробуй войти.");
  if (reason === "invalid new password") return fbError("auth/weak-password", "Пароль должен содержать минимум 6 символов и быть не длиннее 72 байт.");
  if (reason === "email invalid") return fbError("auth/invalid-email", "Проверь, правильно ли указан адрес почты.");
  if (reason === "invalid tag") return fbError("auth/invalid-tag", "Проверь имя пользователя.");
  if (reason === "registration is closed" || reason === "guest registration is closed") {
    return fbError("auth/registration-unavailable", "Регистрация временно недоступна. Повтори позже.");
  }
  if (error.status === 429) return fbError("auth/too-many-requests", "Подожди минуту перед повторной отправкой кода.");
  if (reason === "mail provider inactive") {
    return fbError("auth/mail-unavailable", "Отправка кодов ещё не активирована почтовым сервисом MRX. Адрес менять не нужно. Регистрация станет доступна после активации; пока можно войти гостем.");
  }
  if (error.status === 503 || reason === "mail send failed" || reason === "mail unavailable") {
    return fbError("auth/mail-unavailable", "Письмо пока не удалось отправить. Попробуй ещё раз — юзернейм и почту менять не нужно.");
  }
  return fbError("auth/network-request-failed", "Нет связи с сервером. Проверь интернет и повтори попытку.");
}

export async function registerAccount({ tag, name, email, password, isAnonymous = false }) {
  if (!password || Array.from(password).length < 6 || new TextEncoder().encode(password).length > 72) {
    throw registrationError({ message: "invalid new password" });
  }
  let result;
  try {
    result = await api("/auth/register", {
      method: "POST",
      body: { tag: normLogin(tag), name: name || "", email: String(email || "").trim().toLowerCase(), password },
    });
  } catch (error) {
    throw registrationError(error);
  }
  if (result.pending) return { pending: true, email: result.email, codeSent: result.codeSent !== false };
  if (!result.user || !result.token) throw registrationError({ message: "invalid response" });
  setAuth({
    uid: result.user.id || result.user.uid,
    tag: result.user.tag || normLogin(tag),
    token: result.token,
    email: email || null,
    displayName: result.user.name || name || null,
    isAnonymous: isAnonymous || result.user.isAnonymous === true,
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
    if (e.status === 429) throw fbError("auth/too-many-requests", "Слишком много попыток. Запроси новый код.");
    throw registrationError(e);
  }
  setAuth({
    uid: r.user && (r.user.id || r.user.uid),
    token: r.token,
    tag: r.user?.tag || "",
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
  } catch (error) {
    throw registrationError(error);
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
    if (e.status === 503) throw fbError("auth/mail-unavailable", "Отправка писем сейчас недоступна.");
    throw fbError("auth/network-request-failed", e.message);
  }
}

export async function requestPasswordReset(login) {
  try {
    return await api("/auth/reset", {
      method: "POST",
      body: { login: normLogin(login) },
    });
  } catch (error) {
    if (error.status === 503) throw fbError("auth/mail-unavailable", "Отправка писем сейчас недоступна.");
    if (error.status === 429) throw fbError("auth/too-many-requests", "Подожди минуту и попробуй ещё раз.");
    throw error;
  }
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
