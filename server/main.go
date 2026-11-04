package main

// ─────────────────────────────────────────────────────────────────────────────
// RedMrxGram Server v2 — self-hosted, полностью без Google
//
// Отличия от v1:
//   - SQLite-персистентность: users, messages, chat_members переживают рестарт
//   - Собственная авторизация: bcrypt-пароли + JWT (HS256)
//   - ВСЕ секреты — только из переменных окружения (.env), в коде ничего нет
//   - Файлы — Telegram Storage (как раньше), пуши — ntfy/UnifiedPush (опционально, без Google)
// ─────────────────────────────────────────────────────────────────────────────

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tursodatabase/libsql-client-go/libsql"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

// ── Config ────────────────────────────────────────────────────────────────────

var (
	cfgPort      string
	cfgJWTSecret []byte
	cfgNtfyURL   string
	cfgNtfyToken string
	cfgDBPath    string
	cfgBrevoKey  string
	cfgMailFrom  string
)

func getenv(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func mustGetenv(key string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		log.Fatalf("❌ Переменная окружения %s не задана (смотри .env.example)", key)
	}
	return v
}

// loadDotEnv подхватывает файл .env из рабочей папки (если он есть)
func loadDotEnv() {
	data, err := os.ReadFile(".env")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"`)
		if os.Getenv(k) == "" {
			os.Setenv(k, v)
		}
	}
}

func loadConfig() {
	loadDotEnv()
	cfgPort = getenv("PORT", "8080")
	cfgJWTSecret = []byte(mustGetenv("JWT_SECRET"))
	if len(cfgJWTSecret) < 32 {
		log.Fatal("JWT_SECRET must contain at least 32 bytes")
	}
	cfgNtfyURL = strings.TrimRight(getenv("NTFY_URL", ""), "/")
	cfgNtfyToken = getenv("NTFY_TOKEN", "")
	cfgDBPath = getenv("DB_PATH", "rmg.db")
	cfgBrevoKey = getenv("BREVO_API_KEY", "")
	cfgMailFrom = getenv("MAIL_FROM", "")
	if cfgNtfyURL == "" {
		log.Println("⚠️  NTFY_URL не задан — push-уведомления отключены")
	}
}

// ── Database ──────────────────────────────────────────────────────────────────

var db *sql.DB

func initDB() {
	dbURL, token := os.Getenv("TURSO_DATABASE_URL"), os.Getenv("TURSO_AUTH_TOKEN")
	if dbURL != "" || token != "" {
		u, err := url.Parse(dbURL)
		if err != nil || (u.Scheme != "libsql" && u.Scheme != "https") || u.Host == "" ||
			u.User != nil || u.RawQuery != "" || token == "" {
			log.Fatal("invalid Turso configuration")
		}
		connector, err := libsql.NewConnector(dbURL, libsql.WithAuthToken(token))
		if err != nil {
			log.Fatal("Turso connector failed")
		}
		db = sql.OpenDB(connector)
		db.SetMaxOpenConns(4)
	} else {
		if os.Getenv("RENDER") == "true" {
			log.Fatal("Turso is required on Render")
		}
		var err error
		db, err = sql.Open("sqlite", "file:"+cfgDBPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
		if err != nil {
			log.Fatal("open SQLite failed")
		}
		db.SetMaxOpenConns(1)
	}
	schema := `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  tag        TEXT UNIQUE NOT NULL,
  name       TEXT DEFAULT '',
  bio        TEXT DEFAULT '',
  photo_url  TEXT DEFAULT '',
  pass_hash  TEXT DEFAULT '',
  fcm_token  TEXT DEFAULT '',
  last_seen  INTEGER DEFAULT 0,
  created    INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  chat_id   TEXT NOT NULL,
  sender_id TEXT DEFAULT '',
  author    TEXT DEFAULT '',
  type      TEXT DEFAULT 'text',
  text      TEXT DEFAULT '',
  file_url  TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  file_type TEXT DEFAULT '',
  file_size INTEGER DEFAULT 0,
  duration  TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  reply_to  TEXT DEFAULT 'null',
  time      TEXT DEFAULT '',
  unix_ms   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, unix_ms);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
`
	applySchema(schema)
}

func applySchema(schema string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for statement := range strings.SplitSeq(schema, ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err := db.ExecContext(ctx, statement); err != nil {
			log.Fatal("db schema:", err)
		}
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

type User struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Tag      string `json:"tag"`
	Bio      string `json:"bio"`
	PhotoURL string `json:"photoUrl"`
	Online   bool   `json:"online"`
	LastSeen int64  `json:"lastSeen"`
	Email    string `json:"-"`
	EmailOk  int    `json:"-"`
}

type Message struct {
	ID       string      `json:"id"`
	ChatID   string      `json:"chatId"`
	SenderID string      `json:"senderId"`
	Author   string      `json:"author"`
	Type     string      `json:"type"`
	Text     string      `json:"text"`
	FileURL  string      `json:"fileUrl,omitempty"`
	FileName string      `json:"fileName,omitempty"`
	FileType string      `json:"fileType,omitempty"`
	FileSize int64       `json:"fileSize,omitempty"`
	Duration string      `json:"duration,omitempty"`
	VideoURL string      `json:"videoUrl,omitempty"`
	ReplyTo  interface{} `json:"replyTo,omitempty"`
	Time     string      `json:"time"`
	UnixMs   int64       `json:"unixMs"`
}

type WSMessage struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
}

type Client struct {
	userID string
	conn   *websocket.Conn
	send   chan []byte
}

// ── Runtime state (только presence/online — остальное в SQLite) ──────────────

var (
	mu            sync.RWMutex
	clients       = make(map[string]*Client)
	activeChats   = make(map[string]string)
	activeChatsTs = make(map[string]int64)
)

const activeChatTTLMs = 25_000

// ── Auth: bcrypt + JWT (HS256) ────────────────────────────────────────────────

func b64u(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func makeToken(uid string) string {
	header := b64u([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]interface{}{
		"uid": uid,
		"exp": time.Now().Add(30 * 24 * time.Hour).Unix(),
	})
	body := header + "." + b64u(claims)
	mac := hmac.New(sha256.New, cfgJWTSecret)
	mac.Write([]byte(body))
	return body + "." + b64u(mac.Sum(nil))
}

func parseToken(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("bad token")
	}
	mac := hmac.New(sha256.New, cfgJWTSecret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return "", errors.New("bad signature")
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("bad claims")
	}
	var claims struct {
		UID string `json:"uid"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		return "", errors.New("bad claims json")
	}
	if claims.Exp < time.Now().Unix() {
		return "", errors.New("token expired")
	}
	if claims.UID == "" {
		return "", errors.New("no uid")
	}
	return claims.UID, nil
}

// authUID validates HTTP bearer tokens. WebSocket auth is handled separately.
func authUID(r *http.Request) (string, error) {
	token := ""
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		token = strings.TrimPrefix(h, "Bearer ")
	}
	if token == "" {
		return "", errors.New("no token")
	}
	return parseToken(token)
}

func newUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("u%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ── User helpers ──────────────────────────────────────────────────────────────

func scanUser(row interface{ Scan(...interface{}) error }) (*User, string, error) {
	var u User
	var passHash string
	err := row.Scan(&u.ID, &u.Tag, &u.Name, &u.Bio, &u.PhotoURL, &passHash, &u.LastSeen, &u.Email, &u.EmailOk)
	if err != nil {
		return nil, "", err
	}
	mu.RLock()
	_, u.Online = clients[u.ID]
	mu.RUnlock()
	return &u, passHash, nil
}

const userCols = "id, tag, name, bio, photo_url, pass_hash, last_seen, email, email_ok"

func getUserByID(id string) (*User, string, error) {
	return scanUser(db.QueryRow("SELECT "+userCols+" FROM users WHERE id=?", id))
}

func getUserByTag(tag string) (*User, string, error) {
	return scanUser(db.QueryRow("SELECT "+userCols+" FROM users WHERE tag=?", strings.ToLower(strings.TrimSpace(tag))))
}

// В колонке fcm_token теперь хранится ntfy-топик пользователя (имя оставлено для совместимости БД)
func getPushTopic(uid string) string {
	var t string
	_ = db.QueryRow("SELECT fcm_token FROM users WHERE id=?", uid).Scan(&t)
	return t
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
	w.Header().Set("Content-Type", "application/json")
}

func limitRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedWebSocketOrigin(r) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if r.URL.Path != "/upload" {
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		}
		if !strings.HasPrefix(r.URL.Path, "/media/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

func authRegisterHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	var req struct {
		Tag      string `json:"tag"`
		Name     string `json:"name"`
		Bio      string `json:"bio"`
		PhotoURL string `json:"photoUrl"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	if os.Getenv("ALLOW_REGISTRATION") != "1" && !mailEnabled() {
		jsonErr(w, 403, "registration is closed")
		return
	}
	if os.Getenv("ALLOW_REGISTRATION") != "1" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Tag)), "anon_") {
		jsonErr(w, 403, "guest registration is closed")
		return
	}
	req.Tag = strings.ToLower(strings.TrimSpace(req.Tag))
	if req.Tag == "" || len(req.Password) < 6 {
		jsonErr(w, 400, "tag required, password min 6 chars")
		return
	}
	db.Exec("DELETE FROM users WHERE email_ok=0 AND email<>'' AND created < ?", time.Now().UnixMilli()-30*60000)
	if existing, _, _ := getUserByTag(req.Tag); existing != nil {
		jsonErr(w, 409, "tag taken")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	isAnon := strings.HasPrefix(req.Tag, "anon_")
	needMail := mailEnabled() && !isAnon
	if needMail {
		if !validEmail(req.Email) {
			jsonErr(w, 400, "email invalid")
			return
		}
		var n int
		db.QueryRow("SELECT COUNT(*) FROM users WHERE email=? AND email_ok=1", req.Email).Scan(&n)
		if n > 0 {
			jsonErr(w, 409, "email taken")
			return
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		jsonErr(w, 500, "hash failed")
		return
	}
	uid := newUID()
	emailOK := 1
	if needMail {
		emailOK = 0
	}
	_, err = db.Exec(
		"INSERT INTO users (id, tag, name, bio, photo_url, pass_hash, created, email, email_ok) VALUES (?,?,?,?,?,?,?,?,?)",
		uid, req.Tag, req.Name, req.Bio, req.PhotoURL, string(hash), time.Now().UnixMilli(), req.Email, emailOK,
	)
	if err != nil {
		jsonErr(w, 409, "tag taken")
		return
	}
	if needMail {
		if err := issueMailCode(req.Email, uid); err != nil {
			db.Exec("DELETE FROM users WHERE id=?", uid)
			jsonErr(w, 500, "mail send failed")
			return
		}
		log.Println("Account awaits verification")
		json.NewEncoder(w).Encode(map[string]interface{}{"pending": true, "email": req.Email})
		return
	}
	u, _, _ := getUserByID(uid)
	log.Println("Account registered")
	json.NewEncoder(w).Encode(map[string]interface{}{"user": u, "token": makeToken(uid)})
}

func authLoginHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	var req struct {
		Tag      string `json:"tag"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	login := strings.ToLower(strings.TrimSpace(req.Tag))
	var u *User
	var passHash string
	var lerr error
	if strings.Contains(login, "@") {
		u, passHash, lerr = scanUser(db.QueryRow("SELECT "+userCols+" FROM users WHERE email=? ORDER BY email_ok DESC LIMIT 1", login))
	} else {
		u, passHash, lerr = getUserByTag(login)
	}
	if lerr != nil || u == nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passHash), []byte(req.Password)) != nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	if mailEnabled() && !strings.HasPrefix(u.Tag, "anon_") {
		var uEmail string
		var uOK int
		db.QueryRow("SELECT email, email_ok FROM users WHERE id=?", u.ID).Scan(&uEmail, &uOK)
		if uEmail == "" {
			jsonErr(w, 403, "email_required")
			return
		}
		if uOK == 0 {
			issueMailCode(uEmail, u.ID)
			w.WriteHeader(403)
			json.NewEncoder(w).Encode(map[string]interface{}{"error": "email_not_verified", "email": uEmail})
			return
		}
	}
	log.Printf("🔑 Login: @%s", u.Tag)
	json.NewEncoder(w).Encode(map[string]interface{}{"user": u, "token": makeToken(u.ID)})
}

// ── User handlers ─────────────────────────────────────────────────────────────

func updateUserHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	uid, err := authUID(r)
	if err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	target := strings.TrimPrefix(r.URL.Path, "/user/")
	if target != uid {
		jsonErr(w, 403, "can only update own profile")
		return
	}
	var update map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	set := func(col string, key string) {
		if v, ok := update[key].(string); ok {
			db.Exec("UPDATE users SET "+col+"=? WHERE id=?", v, uid)
		}
	}
	set("fcm_token", "pushTopic")
	set("name", "name")
	set("bio", "bio")
	set("photo_url", "photoUrl")
	w.Write([]byte(`{"ok":true}`))
}

func userHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if _, err := authUID(r); err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	if id := r.URL.Query().Get("id"); id != "" {
		if u, _, err := getUserByID(id); err == nil {
			json.NewEncoder(w).Encode(u)
			return
		}
	}
	if tag := r.URL.Query().Get("tag"); tag != "" {
		if u, _, err := getUserByTag(tag); err == nil {
			json.NewEncoder(w).Encode(u)
			return
		}
	}
	jsonErr(w, 404, "not found")
}

func searchHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if _, err := authUID(r); err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if q == "" {
		fmt.Fprint(w, "[]")
		return
	}
	rows, err := db.Query(
		"SELECT "+userCols+" FROM users WHERE tag LIKE ? OR lower(name) LIKE ? LIMIT 20",
		"%"+q+"%", "%"+q+"%",
	)
	if err != nil {
		fmt.Fprint(w, "[]")
		return
	}
	defer rows.Close()
	result := []*User{}
	for rows.Next() {
		if u, _, err := scanUser(rows); err == nil {
			result = append(result, u)
		}
	}
	json.NewEncoder(w).Encode(result)
}

// ── Chat / history ────────────────────────────────────────────────────────────

func saveMembers(chatID string, members []string) {
	for _, uid := range members {
		if uid != "" {
			db.Exec("INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?,?)", chatID, uid)
		}
	}
}

func getMembers(chatID string) []string {
	rows, err := db.Query("SELECT user_id FROM chat_members WHERE chat_id=?", chatID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var uid string
		if rows.Scan(&uid) == nil {
			out = append(out, uid)
		}
	}
	return out
}

func isMember(chatID, uid string) bool {
	var n int
	db.QueryRow("SELECT COUNT(*) FROM chat_members WHERE chat_id=? AND user_id=?", chatID, uid).Scan(&n)
	return n > 0
}

func saveMessage(msg *Message) {
	replyTo, _ := json.Marshal(msg.ReplyTo)
	_, err := db.Exec(`INSERT OR REPLACE INTO messages
		(id, chat_id, sender_id, author, type, text, file_url, file_name, file_type, file_size, duration, video_url, reply_to, time, unix_ms)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		msg.ID, msg.ChatID, msg.SenderID, msg.Author, msg.Type, msg.Text,
		msg.FileURL, msg.FileName, msg.FileType, msg.FileSize, msg.Duration,
		msg.VideoURL, string(replyTo), msg.Time, msg.UnixMs)
	if err != nil {
		log.Println("saveMessage:", err)
	}
}

func historyHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	uid, err := authUID(r)
	if err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	chatID := r.URL.Query().Get("chatId")
	if chatID == "" {
		fmt.Fprint(w, "[]")
		return
	}
	members := getMembers(chatID)
	if len(members) > 0 && !isMember(chatID, uid) {
		jsonErr(w, 403, "not a member")
		return
	}
	rows, err := db.Query(`SELECT id, chat_id, sender_id, author, type, text, file_url, file_name, file_type, file_size, duration, video_url, reply_to, time, unix_ms
		FROM (SELECT * FROM messages WHERE chat_id=? ORDER BY unix_ms DESC LIMIT 100)
		ORDER BY unix_ms ASC`, chatID)
	if err != nil {
		fmt.Fprint(w, "[]")
		return
	}
	defer rows.Close()
	msgs := []Message{}
	for rows.Next() {
		var m Message
		var replyTo string
		if err := rows.Scan(&m.ID, &m.ChatID, &m.SenderID, &m.Author, &m.Type, &m.Text,
			&m.FileURL, &m.FileName, &m.FileType, &m.FileSize, &m.Duration,
			&m.VideoURL, &replyTo, &m.Time, &m.UnixMs); err == nil {
			json.Unmarshal([]byte(replyTo), &m.ReplyTo)
			msgs = append(msgs, m)
		}
	}
	json.NewEncoder(w).Encode(msgs)
}

// ── Telegram Storage ──────────────────────────────────────────────────────────

type TGResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
}

// ── ntfy (UnifiedPush) — пуши без Google ─────────────────────────────────────────

func sendNtfy(topic, title, body, chatID, senderID string) {
	if cfgNtfyURL == "" || topic == "" {
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"topic":    topic,
		"title":    title,
		"message":  body,
		"priority": 4,
		"tags":     []string{"speech_balloon"},
	})
	req, _ := http.NewRequest("POST", cfgNtfyURL, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	if cfgNtfyToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfgNtfyToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Println("ntfy send error:", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		log.Printf("🔔 ntfy sent: %s", title)
	} else {
		b, _ := io.ReadAll(resp.Body)
		log.Printf("ntfy error %d: %s", resp.StatusCode, string(b))
	}
}

func notifyOffline(chatID string, msg Message) {
	title := msg.Author
	body := msg.Text
	switch msg.Type {
	case "voice":
		body = "🎙 Голосовое сообщение"
	case "circle":
		body = "⭕ Видео-кружок"
	case "image":
		body = "🖼 Фото"
	case "video":
		body = "🎥 Видео"
	case "file":
		body = "📎 " + msg.FileName
	case "audio":
		body = "🎵 Аудио"
	}
	if len(body) > 100 {
		body = body[:100]
	}
	for _, uid := range getMembers(chatID) {
		if uid == msg.SenderID {
			continue
		}
		mu.RLock()
		_, online := clients[uid]
		activeChat := activeChats[uid]
		activeTs := activeChatsTs[uid]
		mu.RUnlock()
		fresh := time.Now().UnixMilli()-activeTs < activeChatTTLMs
		if activeChat == chatID && fresh {
			continue
		}
		if !online {
			if topic := getPushTopic(uid); topic != "" {
				go sendNtfy(topic, title, body, chatID, msg.SenderID)
			}
		}
	}
}

// ── Presence ──────────────────────────────────────────────────────────────────

func presenceHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	uid, err := authUID(r)
	if err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	var req struct {
		ChatID string `json:"chatId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	mu.Lock()
	if req.ChatID == "" {
		delete(activeChats, uid)
		delete(activeChatsTs, uid)
	} else {
		activeChats[uid] = req.ChatID
		activeChatsTs[uid] = time.Now().UnixMilli()
	}
	mu.Unlock()
	fmt.Fprint(w, `{"ok":true}`)
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func broadcast(chatID, senderID string, data []byte) {
	for _, uid := range getMembers(chatID) {
		if uid == senderID {
			continue
		}
		mu.RLock()
		c := clients[uid]
		mu.RUnlock()
		if c != nil {
			select {
			case c.send <- data:
			default:
			}
		}
	}
}

func mustMarshal(v interface{}) json.RawMessage { b, _ := json.Marshal(v); return b }

func wsHandler(w http.ResponseWriter, r *http.Request) {
	userID, err := authUID(r) // WS подключается с ?token=<jwt>
	if err != nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &Client{userID: userID, conn: conn, send: make(chan []byte, 512)}
	mu.Lock()
	clients[userID] = client
	mu.Unlock()
	log.Printf("✅ Connected: %s | Online: %d", userID, len(clients))

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer func() { ticker.Stop(); conn.Close() }()
		for {
			select {
			case msg, ok := <-client.send:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if !ok {
					conn.WriteMessage(websocket.CloseMessage, nil)
					return
				}
				conn.WriteMessage(websocket.TextMessage, msg)
			case <-ticker.C:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var ws WSMessage
		if err := json.Unmarshal(raw, &ws); err != nil {
			continue
		}
		switch ws.Event {
		case "join":
			var p struct {
				ChatID  string   `json:"chatId"`
				Members []string `json:"members"`
			}
			json.Unmarshal(ws.Payload, &p)
			if p.ChatID == "" {
				continue
			}
			if len(p.Members) > 0 {
				saveMembers(p.ChatID, p.Members)
			} else {
				saveMembers(p.ChatID, []string{userID})
			}
		case "message":
			var msg Message
			json.Unmarshal(ws.Payload, &msg)
			msg.SenderID = userID
			msg.UnixMs = time.Now().UnixMilli()
			if msg.Time == "" {
				msg.Time = time.Now().Format("15:04")
			}
			if msg.ID == "" {
				msg.ID = newUID()
			}
			if msg.ChatID == "" {
				continue
			}
			if !isMember(msg.ChatID, userID) {
				saveMembers(msg.ChatID, []string{userID})
			}
			saveMessage(&msg)
			data, _ := json.Marshal(WSMessage{Event: "message", Payload: mustMarshal(msg)})
			broadcast(msg.ChatID, userID, data)
			go notifyOffline(msg.ChatID, msg)
		case "typing":
			var p struct {
				ChatID string `json:"chatId"`
			}
			json.Unmarshal(ws.Payload, &p)
			data, _ := json.Marshal(WSMessage{Event: "typing", Payload: ws.Payload})
			broadcast(p.ChatID, userID, data)
		case "ping":
			client.send <- []byte(`{"event":"pong"}`)
		}
	}

	mu.Lock()
	delete(clients, userID)
	delete(activeChats, userID)
	delete(activeChatsTs, userID)
	mu.Unlock()
	db.Exec("UPDATE users SET last_seen=? WHERE id=?", time.Now().UnixMilli(), userID)
	log.Printf("❌ Disconnected: %s | Online: %d", userID, len(clients))
}

// ── Health ───���────────────────────────────────────────────────────────────────

func healthHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var ok int
	if err := db.QueryRowContext(ctx, "SELECT 1").Scan(&ok); err != nil {
		jsonErr(w, 503, "storage unavailable")
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func allowedWebSocketOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	for value := range strings.SplitSeq(getenv("MRX_ORIGINS", "https://localhost,https://mrx2827.github.io"), ",") {
		if strings.TrimSpace(value) == origin {
			return true
		}
	}
	return false
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	loadConfig()
	initDB()
	migrateMail()
	ensureDocsTable()
	initMedia()

	http.HandleFunc("/auth/register", authRegisterHandler)
	http.HandleFunc("/auth/login", authLoginHandler)
	http.HandleFunc("/auth/verify", authVerifyHandler)
	http.HandleFunc("/auth/resend", authResendHandler)
	http.HandleFunc("/auth/attach", authAttachHandler)
	http.HandleFunc("/auth/reset", authResetHandler)
	http.HandleFunc("/auth/reset/confirm", authResetConfirmHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/media/", mediaHandler)
	http.HandleFunc("/search", searchHandler)
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/user/", updateUserHandler)
	http.HandleFunc("/user", userHandler)

	host := getenv("HOST", "127.0.0.1")
	if os.Getenv("RENDER") == "true" {
		host = "0.0.0.0"
	}
	server := &http.Server{Addr: host + ":" + cfgPort, ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 90 * time.Second, Handler: limitRequests(http.DefaultServeMux)}
	log.Printf("MRX API listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}

// ---- Email verification (Brevo) ----

func mailEnabled() bool { return cfgBrevoKey != "" && cfgMailFrom != "" }

func validEmail(e string) bool {
	if len(e) < 5 || len(e) > 120 || strings.ContainsAny(e, " \t\r\n") {
		return false
	}
	at := strings.Index(e, "@")
	dot := strings.LastIndex(e, ".")
	return at > 0 && dot > at+1 && dot < len(e)-1
}

func migrateMail() {
	for _, statement := range []string{
		"ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''",
		"ALTER TABLE users ADD COLUMN email_ok INTEGER DEFAULT 0",
		"CREATE TABLE IF NOT EXISTS mail_codes (email TEXT PRIMARY KEY, code TEXT DEFAULT '', uid TEXT DEFAULT '', ts INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, tries INTEGER DEFAULT 0)",
	} {
		if _, err := db.Exec(statement); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
			log.Fatal("account schema migration failed")
		}
	}
	if mailEnabled() {
		log.Println("OK: mail verification enabled (Brevo)")
	} else {
		log.Println("WARN: BREVO_API_KEY/MAIL_FROM not set - mail verification disabled")
	}
}

func newMailCode() string {
	b := make([]byte, 4)
	rand.Read(b)
	n := (int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1000000)
}

func sendMailCode(email, code string) error {
	payload := map[string]interface{}{
		"sender":      map[string]string{"name": "RedMrxGram", "email": cfgMailFrom},
		"to":          []map[string]string{{"email": email}},
		"subject":     "RedMrxGram: " + code,
		"htmlContent": "<div style=\"font-family:sans-serif;max-width:420px\"><h2 style=\"color:#c00\">RedMrxGram</h2><p>Tvoj kod podtverzhdeniya:</p><div style=\"font-size:34px;font-weight:bold;letter-spacing:8px\">" + code + "</div><p style=\"color:#666\">Kod dejstvuet 15 minut.</p></div>",
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", "https://api.brevo.com/v3/smtp/email", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("api-key", cfgBrevoKey)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		rb, _ := io.ReadAll(resp.Body)
		log.Printf("MAIL: Brevo error %d: %s", resp.StatusCode, string(rb))
		return errors.New("mail send failed")
	}
	log.Printf("MAIL: code sent to %s", email)
	return nil
}

func issueMailCode(email, uid string, kind ...string) error {
	var lastSent int64
	db.QueryRow("SELECT sent FROM mail_codes WHERE email=?", email).Scan(&lastSent)
	if time.Now().UnixMilli()-lastSent < 60000 {
		return errors.New("too soon")
	}
	code := newMailCode()
	now := time.Now().UnixMilli()
	db.Exec("INSERT INTO mail_codes (email, code, uid, ts, sent, tries) VALUES (?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET code=excluded.code, uid=excluded.uid, ts=excluded.ts, sent=excluded.sent, tries=0", email, code, uid, now, now)
	return sendMailCode(email, code)
}

func authVerifyHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Code = strings.TrimSpace(req.Code)
	var code, uid string
	var ts int64
	var tries int
	err := db.QueryRow("SELECT code, uid, ts, tries FROM mail_codes WHERE email=?", req.Email).Scan(&code, &uid, &ts, &tries)
	if err != nil {
		jsonErr(w, 404, "code not found")
		return
	}
	if tries >= 5 || time.Now().UnixMilli()-ts > 15*60000 {
		jsonErr(w, 400, "code expired")
		return
	}
	if req.Code == "" || req.Code != code {
		db.Exec("UPDATE mail_codes SET tries=tries+1 WHERE email=?", req.Email)
		jsonErr(w, 401, "wrong code")
		return
	}
	db.Exec("UPDATE users SET email=?, email_ok=1 WHERE id=?", req.Email, uid)
	db.Exec("DELETE FROM mail_codes WHERE email=?", req.Email)
	u, _, _ := getUserByID(uid)
	if u == nil {
		jsonErr(w, 404, "user not found")
		return
	}
	log.Printf("MAIL: verified %s (@%s)", req.Email, u.Tag)
	json.NewEncoder(w).Encode(map[string]interface{}{"user": u, "token": makeToken(uid)})
}

func authResendHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	var uid string
	db.QueryRow("SELECT uid FROM mail_codes WHERE email=?", req.Email).Scan(&uid)
	if uid == "" {
		db.QueryRow("SELECT id FROM users WHERE email=? AND email_ok=0", req.Email).Scan(&uid)
	}
	if uid == "" {
		jsonErr(w, 404, "not found")
		return
	}
	if err := issueMailCode(req.Email, uid); err != nil {
		jsonErr(w, 429, "wait a minute")
		return
	}
	w.Write([]byte(`{"ok":true}`))
}

func authAttachHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	var req struct {
		Tag      string `json:"tag"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if !validEmail(req.Email) {
		jsonErr(w, 400, "email invalid")
		return
	}
	u, passHash, err := getUserByTag(req.Tag)
	if err != nil || u == nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passHash), []byte(req.Password)) != nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	var n int
	db.QueryRow("SELECT COUNT(*) FROM users WHERE email=? AND email_ok=1 AND id<>?", req.Email, u.ID).Scan(&n)
	if n > 0 {
		jsonErr(w, 409, "email taken")
		return
	}
	if err := issueMailCode(req.Email, u.ID); err != nil {
		jsonErr(w, 429, "wait a minute")
		return
	}
	db.Exec("UPDATE users SET email=?, email_ok=0 WHERE id=?", req.Email, u.ID)
	json.NewEncoder(w).Encode(map[string]interface{}{"pending": true, "email": req.Email})
}

// maskEmail: laughangels4@tutamail.com -> la*****@tutamail.com
func maskEmail(email string) string {
	idx := strings.Index(email, "@")
	if idx < 0 {
		return "***"
	}
	local := email[:idx]
	domain := email[idx:]
	if len(local) <= 2 {
		return local + "*****" + domain
	}
	return local[:2] + "*****" + domain
}

// POST /auth/reset  body: {login}
func authResetHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	if r.Method != "POST" {
		jsonErr(w, 405, "method not allowed")
		return
	}
	var req struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	login := strings.TrimSpace(strings.ToLower(req.Login))
	login = strings.TrimPrefix(login, "@")
	if login == "" {
		jsonErr(w, 400, "login required")
		return
	}
	var uid string
	var uEmail string
	var uEmailOk int
	var err error
	if strings.Contains(login, "@") {
		err = db.QueryRow("SELECT id, email, email_ok FROM users WHERE LOWER(email)=? AND email_ok=1 LIMIT 1", login).Scan(&uid, &uEmail, &uEmailOk)
	} else {
		var u *User
		u, _, err = getUserByTag(login)
		if err == nil {
			uid = u.ID
			uEmail = u.Email
			uEmailOk = u.EmailOk
		}
	}
	if err != nil {
		// vague to prevent enumeration
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"hint": "if that account exists, a code was sent"})
		return
	}
	if uEmail == "" || uEmailOk == 0 {
		jsonErr(w, 403, "no verified email on this account")
		return
	}
	if err2 := issueMailCode(uEmail, uid, "reset"); err2 != nil {
		jsonErr(w, 429, err2.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"email": maskEmail(uEmail)})
}

// POST /auth/reset/confirm  body: {login, code, password}
// NOTE: login must be resolved to the real account email server-side --
// the client only ever sees the MASKED email (for display), so it can
// never send back the real address. Resolve login -> real email here,
// exactly like authResetHandler does.
func authResetConfirmHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	if r.Method != "POST" {
		jsonErr(w, 405, "method not allowed")
		return
	}
	var req struct {
		Login    string `json:"login"`
		Code     string `json:"code"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	login := strings.TrimSpace(strings.ToLower(req.Login))
	login = strings.TrimPrefix(login, "@")
	req.Code = strings.TrimSpace(req.Code)
	if login == "" || req.Code == "" {
		jsonErr(w, 400, "login and code required")
		return
	}
	if len(req.Password) < 6 {
		jsonErr(w, 400, "password too short")
		return
	}
	var uid string
	var uEmail string
	var rerr error
	if strings.Contains(login, "@") {
		rerr = db.QueryRow("SELECT id, email FROM users WHERE LOWER(email)=? AND email_ok=1 LIMIT 1", login).Scan(&uid, &uEmail)
	} else {
		var u *User
		u, _, rerr = getUserByTag(login)
		if rerr == nil {
			uid = u.ID
			uEmail = u.Email
		}
	}
	if rerr != nil || uEmail == "" {
		jsonErr(w, 401, "invalid or expired code")
		return
	}
	var storedCode, codeUid string
	var ts int64
	var tries int
	err := db.QueryRow("SELECT code, uid, ts, tries FROM mail_codes WHERE email=?", uEmail).Scan(&storedCode, &codeUid, &ts, &tries)
	if err != nil {
		jsonErr(w, 401, "invalid or expired code")
		return
	}
	if tries >= 5 {
		jsonErr(w, 429, "too many attempts - request a new code")
		return
	}
	now := time.Now().Unix()
	if now-ts > 900 {
		db.Exec("DELETE FROM mail_codes WHERE email=?", uEmail)
		jsonErr(w, 401, "code expired")
		return
	}
	if req.Code != storedCode {
		db.Exec("UPDATE mail_codes SET tries=tries+1 WHERE email=?", uEmail)
		jsonErr(w, 401, "invalid code")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	_, err = db.Exec("UPDATE users SET pass_hash=? WHERE id=?", string(hash), uid)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	db.Exec("DELETE FROM mail_codes WHERE email=?", uEmail)
	var u *User
	u, _, err = getUserByID(uid)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	token := makeToken(u.ID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"token": token, "user": u})
}
