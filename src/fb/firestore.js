// ────────────────────────────────────────────────────────────────────────────
// firestore.js — замена firebase/firestore, работает через собственный сервер.
// Реализован ровно тот набор функций, который использует App.jsx.
// ────────────────────────────────────────────────────────────────────────────

import { api, subscribe } from "./core.js";

// ── Timestamp ───────────────────────────────────────────────────────────────────

export class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds || 0;
  }
  static fromMillis(ms) {
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }
  static fromDate(d) {
    return Timestamp.fromMillis(d.getTime());
  }
  static now() {
    return Timestamp.fromMillis(Date.now());
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  toDate() {
    return new Date(this.toMillis());
  }
}

// сериализация значений перед отправкой на сервер
function ser(v) {
  if (v instanceof Timestamp) return { __ts__: v.toMillis() };
  if (v instanceof Date) return { __ts__: v.getTime() };
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") {
    if (v.__srvts__ || v.__arrayUnion__ || v.__inc__ !== undefined) return v;
    const out = {};
    for (const k of Object.keys(v)) {
      const s = ser(v[k]);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return v;
}

// оживление значений, пришедших с сервера
function rev(v) {
  if (Array.isArray(v)) return v.map(rev);
  if (v && typeof v === "object") {
    if (typeof v.__ts__ === "number" && Object.keys(v).length === 1) {
      return Timestamp.fromMillis(v.__ts__);
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = rev(v[k]);
    return out;
  }
  return v;
}

// ── Ссылки ───────────────────────────────────────────────────────────────────────

export function getFirestore() {
  return { __rmgdb: true };
}

function joinPath(segs) {
  return segs
    .filter((s) => s !== undefined && s !== null && s !== "")
    .map((s) => String(s).replace(/^\/+|\/+$/g, ""))
    .join("/");
}

export function collection(parent, ...segs) {
  let base = "";
  if (parent && parent.__type === "doc") base = parent.__path;
  else if (parent && parent.__type === "collection") base = parent.__path;
  const path = joinPath([base, ...segs]);
  return { __type: "collection", __path: path, id: path.split("/").pop(), path };
}

function randomId() {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function doc(parent, ...segs) {
  let base = "";
  if (parent && (parent.__type === "collection" || parent.__type === "doc")) {
    base = parent.__path;
  }
  let path = joinPath([base, ...segs]);
  // doc(collectionRef) без id — сгенерировать новый id
  if (path.split("/").length % 2 !== 0) path = path + "/" + randomId();
  return { __type: "doc", __path: path, id: path.split("/").pop(), path };
}

// ── Констрейнты запросов ───────────────────────────────────────────────────────

export function where(field, op, value) {
  return { __c: "where", field, op, value: ser(value) };
}
export function orderBy(field, dir) {
  return { __c: "orderBy", field, dir: dir || "asc" };
}
export function limit(n) {
  return { __c: "limit", n };
}
export function limitToLast(n) {
  return { __c: "limitToLast", n };
}
export function startAfter(snapOrId) {
  return { __c: "cursor", pos: "after", id: snapOrId && snapOrId.id ? snapOrId.id : snapOrId };
}
export function endBefore(snapOrId) {
  return { __c: "cursor", pos: "before", id: snapOrId && snapOrId.id ? snapOrId.id : snapOrId };
}

export function query(base, ...constraints) {
  const q = {
    __type: "query",
    __path: base.__path,
    wheres: [...(base.wheres || [])],
    orderBys: [...(base.orderBys || [])],
    limit: base.limit || 0,
    limitToLast: base.limitToLast || 0,
    cursorId: base.cursorId || "",
    cursorPos: base.cursorPos || "",
  };
  for (const c of constraints) {
    if (!c) continue;
    if (c.__c === "where") q.wheres.push({ field: c.field, op: c.op, value: c.value });
    else if (c.__c === "orderBy") q.orderBys.push({ field: c.field, dir: c.dir });
    else if (c.__c === "limit") q.limit = c.n;
    else if (c.__c === "limitToLast") q.limitToLast = c.n;
    else if (c.__c === "cursor") {
      q.cursorId = c.id;
      q.cursorPos = c.pos;
    }
  }
  return q;
}

function toServerQuery(q) {
  return {
    collection: q.__path,
    wheres: (q.wheres || []).map((w) => ({ field: w.field, op: w.op, value: w.value })),
    orderBy: (q.orderBys || []).map((o) => ({ field: o.field, dir: o.dir })),
    limit: q.limit || 0,
    limitToLast: q.limitToLast || 0,
    cursorId: q.cursorId || "",
    cursorPos: q.cursorPos || "",
  };
}

// ── Снимки ─────────────────────────────────────────────────────────────────────

const META = { fromCache: false, hasPendingWrites: false };

function makeDocSnap(id, exists, data, path) {
  const d = exists ? rev(data || {}) : undefined;
  return {
    id,
    ref: { __type: "doc", __path: path, id, path },
    exists: () => exists,
    data: () => d,
    get: (f) => (d ? d[f] : undefined),
    metadata: META,
  };
}

function makeQuerySnap(docsRaw, colPath, prevMap) {
  const docs = (docsRaw || []).map((r) =>
    makeDocSnap(r.id, true, r.data, colPath + "/" + r.id)
  );
  const snap = {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (fn) => docs.forEach(fn),
    metadata: META,
    docChanges: () => {
      const changes = [];
      const seen = new Set();
      docs.forEach((dSnap, i) => {
        seen.add(dSnap.id);
        if (!prevMap) {
          changes.push({ type: "added", doc: dSnap, newIndex: i, oldIndex: -1 });
        } else if (!prevMap.has(dSnap.id)) {
          changes.push({ type: "added", doc: dSnap, newIndex: i, oldIndex: -1 });
        } else if (prevMap.get(dSnap.id) !== JSON.stringify(docsRaw[i].data)) {
          changes.push({ type: "modified", doc: dSnap, newIndex: i, oldIndex: i });
        }
      });
      if (prevMap) {
        prevMap.forEach((_v, id) => {
          if (!seen.has(id)) {
            changes.push({
              type: "removed",
              doc: makeDocSnap(id, false, null, colPath + "/" + id),
              newIndex: -1,
              oldIndex: -1,
            });
          }
        });
      }
      return changes;
    },
  };
  snap.__map = new Map((docsRaw || []).map((r) => [r.id, JSON.stringify(r.data)]));
  return snap;
}

// ── Чтение / запись ─────────────────────────────────────────────────────────────

export async function getDoc(ref) {
  const r = await api("/d/" + ref.__path);
  return makeDocSnap(r.id, !!r.exists, r.data, ref.__path);
}

export async function getDocs(q) {
  const sq = q.__type === "query" ? toServerQuery(q) : toServerQuery(query(q));
  const r = await api("/q", { method: "POST", body: sq });
  return makeQuerySnap(r.docs || [], sq.collection, null);
}

export async function setDoc(ref, data, opts) {
  await api("/d/" + ref.__path, {
    method: "PUT",
    body: { data: ser(data), merge: !!(opts && opts.merge) },
  });
}

export async function updateDoc(ref, data) {
  await api("/d/" + ref.__path, { method: "PATCH", body: { data: ser(data) } });
}

export async function addDoc(colRef, data) {
  const r = await api("/d/" + colRef.__path, { method: "POST", body: { data: ser(data) } });
  return { __type: "doc", __path: colRef.__path + "/" + r.id, id: r.id, path: colRef.__path + "/" + r.id };
}

export async function deleteDoc(ref) {
  await api("/d/" + ref.__path, { method: "DELETE" });
}

// ── Подписки ─────────────────────────────────────────────────────────────────

export function onSnapshot(refOrQuery, onNext, onError) {
  const cb = typeof onNext === "function" ? onNext : onNext && onNext.next;
  const ecb = typeof onNext === "function" ? onError : onNext && onNext.error;

  if (refOrQuery.__type === "doc") {
    let delivered = false;
    const unsub = subscribe(
      { kind: "doc", path: refOrQuery.__path },
      (m) => {
        if (m.type !== "doc" || !m.doc) return;
        delivered = true;
        try {
          cb(makeDocSnap(m.doc.id, !!m.doc.exists, m.doc.data, refOrQuery.__path));
        } catch (e) {}
      }
    );
    // REST-дубль на случай, если WS ещё не успел подключиться
    getDoc(refOrQuery)
      .then((s) => {
        if (!delivered) {
          delivered = true;
          cb(s);
        }
      })
      .catch((e) => {
        if (ecb && !delivered) ecb(e);
      });
    return unsub;
  }

  const q = refOrQuery.__type === "query" ? refOrQuery : query(refOrQuery);
  const sq = toServerQuery(q);
  let prevMap = null;
  let delivered = false;
  const deliver = (docsRaw) => {
    const snap = makeQuerySnap(docsRaw || [], sq.collection, prevMap);
    prevMap = snap.__map;
    delivered = true;
    try {
      cb(snap);
    } catch (e) {}
  };
  const unsub = subscribe({ kind: "query", query: sq }, (m) => {
    if (m.type === "snap") deliver(m.docs);
  });
  api("/q", { method: "POST", body: sq })
    .then((r) => {
      if (!delivered) deliver(r.docs);
    })
    .catch((e) => {
      if (ecb && !delivered) ecb(e);
    });
  return unsub;
}

// ── Спец-значения ──────────────────────────────────────────────────────────────

export function serverTimestamp() {
  return { __srvts__: true };
}
export function arrayUnion(...items) {
  return { __arrayUnion__: items.map(ser) };
}
export function increment(n) {
  return { __inc__: n };
}
