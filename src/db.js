// ─── RedMrxGram — SQLite Database Layer ──────────────────────────────────────
// Автоматически использует SQLite на Android и localStorage в браузере

let _db = null;
let _ready = false;

// ─── Init ─────────────────────────────────────────────────────────────────────
export async function initDB() {
  try {
    const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
    const sqlite = new SQLiteConnection(CapacitorSQLite);

    // Проверяем поддержку
    const isAvailable = await sqlite.isAvailable();
    if (!isAvailable.result) throw new Error("SQLite not available");

    _db = await sqlite.createConnection("rmg", false, "no-encryption", 1, false);
    await _db.open();
    await _createTables();
    _ready = true;
    console.log("✅ SQLite ready");
  } catch (e) {
    console.log("⚠️ SQLite fallback to localStorage:", e.message);
    _ready = false;
  }
  return _ready;
}

async function _createTables() {
  await _db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL,
      sender_id   TEXT DEFAULT '',
      author      TEXT DEFAULT '',
      type        TEXT DEFAULT 'text',
      text        TEXT DEFAULT '',
      file_data   TEXT DEFAULT '',
      file_url    TEXT DEFAULT '',
      file_name   TEXT DEFAULT '',
      file_type   TEXT DEFAULT '',
      file_size   INTEGER DEFAULT 0,
      duration    TEXT DEFAULT '',
      waveform    TEXT DEFAULT '[]',
      reply_to    TEXT DEFAULT 'null',
      reactions   TEXT DEFAULT '{}',
      video_url   TEXT DEFAULT '',
      video_data  TEXT DEFAULT '',
      time        TEXT DEFAULT '',
      unix_ms     INTEGER DEFAULT 0,
      pending     INTEGER DEFAULT 0,
      edited      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat
      ON messages(chat_id, unix_ms ASC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT DEFAULT 'null'
    );
  `);
}

// ─── Messages ─────────────────────────────────────────────────────────────────
export async function saveMsg(msg) {
  if (!_ready || !_db) {
    return _ls_saveMsg(msg);
  }
  try {
    const chatId = msg.chatId || msg.chat_id || "";
    await _db.run(
      `INSERT OR REPLACE INTO messages
       (id, chat_id, sender_id, author, type, text,
        file_data, file_url, file_name, file_type, file_size,
        duration, waveform, reply_to, reactions,
        video_url, video_data, time, unix_ms, pending, edited)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        msg.id || String(Date.now()),
        chatId,
        msg.uid || msg.sender_id || "",
        msg.author || "",
        msg.type || "text",
        msg.text || "",
        msg.fileData || "",
        msg.fileUrl || "",
        msg.fileName || "",
        msg.fileType || "",
        Number(msg.fileSize) || 0,
        msg.duration || "",
        JSON.stringify(msg.waveform || []),
        JSON.stringify(msg.replyTo || null),
        JSON.stringify(msg.reactions || {}),
        msg.videoUrl || "",
        msg.videoData || "",
        msg.time || "",
        Number(msg.unixMs || msg.unix_ms) || Date.now(),
        msg._pending ? 1 : 0,
        msg.edited ? 1 : 0,
      ]
    );
  } catch (e) {
    console.warn("saveMsg error:", e.message);
  }
}

export async function getMsgs(chatId, limit = 200) {
  if (!_ready || !_db) return _ls_getMsgs(chatId);
  try {
    const res = await _db.query(
      `SELECT * FROM messages WHERE chat_id=? ORDER BY unix_ms ASC LIMIT ?`,
      [chatId, limit]
    );
    return (res.values || []).map(_rowToMsg);
  } catch (e) {
    console.warn("getMsgs error:", e.message);
    return [];
  }
}

export async function deleteMsg(msgId, chatId) {
  if (!_ready || !_db) return _ls_deleteMsg(msgId, chatId);
  try {
    await _db.run(`DELETE FROM messages WHERE id=?`, [msgId]);
  } catch (e) {
    console.warn("deleteMsg error:", e.message);
  }
}

export async function updateMsgReactions(msgId, chatId, reactions) {
  if (!_ready || !_db) {
    const msgs = await getMsgs(chatId);
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx >= 0) { msgs[idx].reactions = reactions; _ls_setAll(chatId, msgs); }
    return;
  }
  try {
    await _db.run(
      `UPDATE messages SET reactions=? WHERE id=?`,
      [JSON.stringify(reactions), msgId]
    );
  } catch {}
}

export async function updateMsgText(msgId, chatId, text) {
  if (!_ready || !_db) {
    const msgs = await getMsgs(chatId);
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx >= 0) { msgs[idx].text = text; msgs[idx].edited = true; _ls_setAll(chatId, msgs); }
    return;
  }
  try {
    await _db.run(
      `UPDATE messages SET text=?, edited=1 WHERE id=?`,
      [text, msgId]
    );
  } catch {}
}

export async function searchMsgs(chatId, query) {
  if (!_ready || !_db) {
    const msgs = await getMsgs(chatId);
    return msgs.filter(m => m.text?.toLowerCase().includes(query.toLowerCase()) && m.type === "text");
  }
  try {
    const res = await _db.query(
      `SELECT * FROM messages
       WHERE chat_id=? AND type='text' AND text LIKE ?
       ORDER BY unix_ms DESC LIMIT 50`,
      [chatId, `%${query}%`]
    );
    return (res.values || []).map(_rowToMsg);
  } catch { return []; }
}

export async function clearChatMsgs(chatId) {
  if (!_ready || !_db) {
    localStorage.removeItem(`rmg_msgs_${chatId}`);
    return;
  }
  try { await _db.run(`DELETE FROM messages WHERE chat_id=?`, [chatId]); } catch {}
}

// ─── Settings ─────────────────────────────────────────────────────────────────
export async function getSetting(key, def = null) {
  if (!_ready || !_db) {
    try {
      const s = JSON.parse(localStorage.getItem("rmg_s") || "{}");
      return s[key] !== undefined ? s[key] : def;
    } catch { return def; }
  }
  try {
    const res = await _db.query(
      `SELECT value FROM settings WHERE key=?`, [key]
    );
    if (res.values?.length) return JSON.parse(res.values[0].value);
    return def;
  } catch { return def; }
}

export async function setSetting(key, value) {
  if (!_ready || !_db) {
    try {
      const s = JSON.parse(localStorage.getItem("rmg_s") || "{}");
      s[key] = value;
      localStorage.setItem("rmg_s", JSON.stringify(s));
    } catch {}
    return;
  }
  try {
    await _db.run(
      `INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)`,
      [key, JSON.stringify(value)]
    );
  } catch {}
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function _rowToMsg(row) {
  return {
    id:        row.id,
    chatId:    row.chat_id,
    uid:       row.sender_id,
    author:    row.author,
    type:      row.type,
    text:      row.text,
    fileData:  row.file_data,
    fileUrl:   row.file_url,
    fileName:  row.file_name,
    fileType:  row.file_type,
    fileSize:  row.file_size,
    duration:  row.duration,
    waveform:  _parse(row.waveform, []),
    replyTo:   _parse(row.reply_to, null),
    reactions: _parse(row.reactions, {}),
    videoUrl:  row.video_url,
    videoData: row.video_data,
    time:      row.time,
    unixMs:    row.unix_ms,
    _pending:  row.pending === 1,
    edited:    row.edited === 1,
  };
}

function _parse(str, def) {
  try { return JSON.parse(str); } catch { return def; }
}

// ─── localStorage fallbacks ───────────────────────────────────────────────────
function _ls_saveMsg(msg) {
  try {
    const key = `rmg_msgs_${msg.chatId || msg.chat_id}`;
    const arr = _parse(localStorage.getItem(key), []);
    const idx = arr.findIndex(m => m.id === msg.id);
    if (idx >= 0) arr[idx] = msg; else arr.push(msg);
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {}
}

function _ls_getMsgs(chatId) {
  try { return _parse(localStorage.getItem(`rmg_msgs_${chatId}`), []); } catch { return []; }
}

function _ls_deleteMsg(msgId, chatId) {
  try {
    const key = `rmg_msgs_${chatId}`;
    const arr = _parse(localStorage.getItem(key), []).filter(m => m.id !== msgId);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {}
}

function _ls_setAll(chatId, msgs) {
  try { localStorage.setItem(`rmg_msgs_${chatId}`, JSON.stringify(msgs)); } catch {}
}

export const isReady = () => _ready;
