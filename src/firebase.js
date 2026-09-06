// ────────────────────────────────────────────────────────────────────────────
// firebase.js — совместимая точка входа для старого UI. Несмотря на имя,
// здесь нет Firebase: авторизация, чаты и файлы работают с собственным Go API.
// ────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "./fb/app.js";
import { getAuth } from "./fb/auth.js";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const app = initializeApp({});
export const auth = getAuth();
export const db = getFirestore(app);
export const storage = getStorage(app);
