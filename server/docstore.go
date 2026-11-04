package main

// ─────────────────────────────────────────────────────────────────────────────
// docstore.go — универсальное JSON-хранилище документов (замена Firestore)
//
//   REST:
//     GET    /d/{docPath}          — прочитать документ
//     PUT    /d/{docPath}          — setDoc  (body: {data, merge})
//     PATCH  /d/{docPath}          — updateDoc (документ должен существовать)
//     DELETE /d/{docPath}          — deleteDoc
//     POST   /d/{collectionPath}   — addDoc (авто-id)
//     POST   /q                    — запрос коллекции (where/orderBy/limit/курсоры)
//   WS:
//     /dws?token=JWT               — realtime-подписки (onSnapshot)
//
//   Спец-значения внутри JSON-данных:
//     {"__ts__": ms}          — метка времени (Timestamp)
//     {"__srvts__": true}     — serverTimestamp() → сервер подставит текущее время
//     {"__arrayUnion__": [..]}— arrayUnion()
//     {"__inc__": n}          — increment(n)
//
//   Пуши: при создании документа в chats/{id}/messages сервер шлёт ntfy
//   всем участникам чата, кроме отправителя и тех, кто сейчас в этом чате.
// ─────────────────────────────────────────────────────────────────────────────

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

func init() {
	http.HandleFunc("/d/", docHandler)
	http.HandleFunc("/q", dsQueryHandler)
	http.HandleFunc("/dws", dwsHandler)
}

func ensureDocsTable() {
	applySchema(`
		CREATE TABLE IF NOT EXISTS docs (
			path TEXT PRIMARY KEY,
			parent TEXT NOT NULL,
			id TEXT NOT NULL,
			data TEXT NOT NULL,
			created INTEGER NOT NULL,
			updated INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_docs_parent ON docs(parent);
	`)
}

// ── Пути ─────────────────────────────────────────────────────────────────────

func splitDocPath(p string) (parent, id string, ok bool) {
	p = strings.Trim(p, "/")
	segs := strings.Split(p, "/")
	if len(segs) < 2 || len(segs)%2 != 0 {
		return "", "", false
	}
	return strings.Join(segs[:len(segs)-1], "/"), segs[len(segs)-1], true
}

var docWriteMu sync.Mutex

// ── Уникальность юзернейма ──────────────────────────────────────────────────

// tagTakenBy — занят ли юзернейм другим пользователем (docs users/* + таблица users).
func tagTakenBy(tag, selfUid string) bool {
	lt := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(tag), "@"))
	if lt == "" {
		return false
	}
	rows, err := db.Query("SELECT path, data FROM docs WHERE path LIKE 'users/%'")
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var p, raw string
			if rows.Scan(&p, &raw) != nil {
				continue
			}
			segs := strings.Split(strings.Trim(p, "/"), "/")
			if len(segs) != 2 || segs[1] == selfUid {
				continue
			}
			var m map[string]interface{}
			if json.Unmarshal([]byte(raw), &m) != nil {
				continue
			}
			if t, ok := m["tag"].(string); ok && strings.ToLower(strings.TrimPrefix(t, "@")) == lt {
				return true
			}
		}
	}
	var id string
	if db.QueryRow("SELECT id FROM users WHERE LOWER(REPLACE(tag,'@',''))=? AND id<>?", lt, selfUid).Scan(&id) == nil && id != "" {
		return true
	}
	return false
}

func checkUserTag(path, uid string, data map[string]interface{}) string {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	if len(segs) != 2 || segs[0] != "users" {
		return ""
	}
	if t, ok := data["tag"].(string); ok && tagTakenBy(t, uid) {
		return "юзернейм уже занят"
	}
	return ""
}

func syncUserTag(path, uid string, data map[string]interface{}) {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	if len(segs) != 2 || segs[0] != "users" {
		return
	}
	if t, ok := data["tag"].(string); ok {
		t = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(t), "@"))
		if t != "" {
			db.Exec("UPDATE users SET tag=? WHERE id=?", t, uid)
		}
	}
}

// ── Чтение / запись ──────────────────────────────────────────────────────────

func loadDocData(path string) (map[string]interface{}, bool) {
	var raw string
	err := db.QueryRow("SELECT data FROM docs WHERE path=?", path).Scan(&raw)
	if err != nil {
		return nil, false
	}
	var m map[string]interface{}
	if json.Unmarshal([]byte(raw), &m) != nil {
		return nil, false
	}
	return m, true
}

func dsTransform(old, v interface{}, now int64) interface{} {
	m, ok := v.(map[string]interface{})
	if !ok {
		return v
	}
	if _, s := m["__srvts__"]; s {
		return map[string]interface{}{"__ts__": now}
	}
	if arr, s := m["__arrayUnion__"]; s {
		existing, _ := old.([]interface{})
		add, _ := arr.([]interface{})
		for _, a := range add {
			ab, _ := json.Marshal(a)
			found := false
			for _, e := range existing {
				eb, _ := json.Marshal(e)
				if string(eb) == string(ab) {
					found = true
					break
				}
			}
			if !found {
				existing = append(existing, a)
			}
		}
		if existing == nil {
			existing = []interface{}{}
		}
		return existing
	}
	if n, s := m["__inc__"]; s {
		base := 0.0
		if f, ok2 := old.(float64); ok2 {
			base = f
		}
		nf, _ := n.(float64)
		return base + nf
	}
	oldm, _ := old.(map[string]interface{})
	res := map[string]interface{}{}
	for k, vv := range m {
		var o interface{}
		if oldm != nil {
			o = oldm[k]
		}
		res[k] = dsTransform(o, vv, now)
	}
	return res
}

func writeDocData(path string, patch map[string]interface{}, merge, mustExist bool) (created bool, final map[string]interface{}, err error) {
	parent, id, ok := splitDocPath(path)
	if !ok {
		return false, nil, fmt.Errorf("bad doc path")
	}
	old, exists := loadDocData(path)
	if mustExist && !exists {
		return false, nil, fmt.Errorf("not found")
	}
	now := time.Now().UnixMilli()
	applied := map[string]interface{}{}
	for k, v := range patch {
		var o interface{}
		if old != nil {
			o = getDotValue(old, k)
		}
		applied[k] = dsTransform(o, v, now)
	}
	if (merge || mustExist) && exists {
		final = old
	} else {
		final = map[string]interface{}{}
	}
	for k, v := range applied {
		setDotValue(final, k, v)
	}
	b, _ := json.Marshal(final)
	if exists {
		_, err = db.Exec("UPDATE docs SET data=?, updated=? WHERE path=?", string(b), now, path)
	} else {
		_, err = db.Exec("INSERT INTO docs (path,parent,id,data,created,updated) VALUES (?,?,?,?,?,?)",
			path, parent, id, string(b), now, now)
	}
	if err != nil {
		return false, nil, err
	}
	notifyDocChange(path, parent)
	return !exists, final, nil
}

// ── Запросы ──────────────────────────────────────────────────────────────────

type dsWhere struct {
	Field string      `json:"field"`
	Op    string      `json:"op"`
	Value interface{} `json:"value"`
}

type dsOrder struct {
	Field string `json:"field"`
	Dir   string `json:"dir"`
}

type dsQuery struct {
	Collection  string    `json:"collection"`
	Wheres      []dsWhere `json:"wheres"`
	OrderBy     []dsOrder `json:"orderBy"`
	Limit       int       `json:"limit"`
	LimitToLast int       `json:"limitToLast"`
	CursorID    string    `json:"cursorId"`
	CursorPos   string    `json:"cursorPos"` // "after" | "before"
}

type dsDoc struct {
	ID      string
	Data    map[string]interface{}
	Created int64
}

func dsFieldValue(data map[string]interface{}, field string) interface{} {
	cur := interface{}(data)
	for _, part := range strings.Split(field, ".") {
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = m[part]
	}
	return cur
}

func dsEqual(a, b interface{}) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

// dsSortKey: kind 0=nil, 1=число/время/bool, 2=строка
func dsSortKey(v interface{}) (num float64, str string, kind int) {
	switch t := v.(type) {
	case nil:
		return 0, "", 0
	case float64:
		return t, "", 1
	case bool:
		if t {
			return 1, "", 1
		}
		return 0, "", 1
	case string:
		return 0, t, 2
	case map[string]interface{}:
		if ts, ok := t["__ts__"].(float64); ok {
			return ts, "", 1
		}
		return 0, "", 0
	default:
		return 0, "", 0
	}
}

func dsCompare(a, b interface{}) int {
	an, as, ak := dsSortKey(a)
	bn, bs, bk := dsSortKey(b)
	if ak != bk {
		if ak < bk {
			return -1
		}
		return 1
	}
	switch ak {
	case 1:
		if an < bn {
			return -1
		} else if an > bn {
			return 1
		}
		return 0
	case 2:
		return strings.Compare(as, bs)
	}
	return 0
}

func dsMatch(data map[string]interface{}, w dsWhere) bool {
	v := dsFieldValue(data, w.Field)
	switch w.Op {
	case "==":
		return dsEqual(v, w.Value)
	case "!=":
		return !dsEqual(v, w.Value)
	case "array-contains":
		arr, ok := v.([]interface{})
		if !ok {
			return false
		}
		for _, e := range arr {
			if dsEqual(e, w.Value) {
				return true
			}
		}
		return false
	case ">", ">=", "<", "<=":
		c := dsCompare(v, w.Value)
		switch w.Op {
		case ">":
			return c > 0
		case ">=":
			return c >= 0
		case "<":
			return c < 0
		case "<=":
			return c <= 0
		}
	}
	return false
}

func runDsQuery(uid string, q dsQuery) []dsDoc {
	q.Collection = strings.Trim(q.Collection, "/")
	if !readableCollection(uid, q.Collection) {
		return nil
	}
	rows, err := db.Query("SELECT id, data, created FROM docs WHERE parent=?", strings.Trim(q.Collection, "/"))
	if err != nil {
		return nil
	}
	defer rows.Close()
	var docs []dsDoc
	for rows.Next() {
		var d dsDoc
		var raw string
		if rows.Scan(&d.ID, &raw, &d.Created) != nil {
			continue
		}
		if json.Unmarshal([]byte(raw), &d.Data) != nil {
			continue
		}
		d.Data = visibleDoc(uid, q.Collection+"/"+d.ID, d.Data)
		if d.Data == nil {
			continue
		}
		okDoc := true
		for _, wc := range q.Wheres {
			if !dsMatch(d.Data, wc) {
				okDoc = false
				break
			}
		}
		if okDoc {
			docs = append(docs, d)
		}
	}
	sort.SliceStable(docs, func(i, j int) bool {
		for _, ob := range q.OrderBy {
			c := dsCompare(dsFieldValue(docs[i].Data, ob.Field), dsFieldValue(docs[j].Data, ob.Field))
			if c == 0 {
				continue
			}
			if strings.HasPrefix(strings.ToLower(ob.Dir), "desc") {
				return c > 0
			}
			return c < 0
		}
		return docs[i].Created < docs[j].Created
	})
	if q.CursorID != "" {
		idx := -1
		for i, d := range docs {
			if d.ID == q.CursorID {
				idx = i
				break
			}
		}
		if idx >= 0 {
			if q.CursorPos == "before" {
				docs = docs[:idx]
			} else {
				docs = docs[idx+1:]
			}
		}
	}
	if q.LimitToLast > 0 && len(docs) > q.LimitToLast {
		docs = docs[len(docs)-q.LimitToLast:]
	}
	if q.Limit > 0 && len(docs) > q.Limit {
		docs = docs[:q.Limit]
	}
	return docs
}

func dsDocsOut(docs []dsDoc) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(docs))
	for _, d := range docs {
		out = append(out, map[string]interface{}{"id": d.ID, "data": d.Data})
	}
	return out
}

// ── HTTP-обработчики ─────────────────────────────────────────────────────────

func docHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	uid, err := authUID(r)
	if err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/d/"), "/")
	if path == "" {
		jsonErr(w, 400, "path required")
		return
	}
	segs := strings.Split(path, "/")
	isDoc := len(segs)%2 == 0
	if r.Method != "GET" {
		docWriteMu.Lock()
		defer docWriteMu.Unlock()
	}

	switch r.Method {
	case "GET":
		if !isDoc {
			jsonErr(w, 400, "doc path required")
			return
		}
		if !readableDocument(uid, path) {
			jsonErr(w, 403, "forbidden")
			return
		}
		data, _ := loadDocData(path)
		data = visibleDoc(uid, path, data)
		exists := data != nil
		json.NewEncoder(w).Encode(map[string]interface{}{"id": segs[len(segs)-1], "exists": exists, "data": data})

	case "POST": // addDoc в коллекцию
		if isDoc {
			jsonErr(w, 400, "collection path required")
			return
		}
		var body struct {
			Data map[string]interface{} `json:"data"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Data == nil {
			jsonErr(w, 400, "bad request")
			return
		}
		id := newUID()
		docPath := path + "/" + id
		if !allowedWrite(uid, docPath, "POST", body.Data) {
			jsonErr(w, 403, "forbidden")
			return
		}
		_, final, werr := writeDocData(docPath, body.Data, false, false)
		if werr != nil {
			jsonErr(w, 400, werr.Error())
			return
		}
		dsMaybeNotify(path, uid, final)
		json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "data": final})

	case "PUT": // setDoc
		if !isDoc {
			jsonErr(w, 400, "doc path required")
			return
		}
		var body struct {
			Data  map[string]interface{} `json:"data"`
			Merge bool                   `json:"merge"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Data == nil {
			jsonErr(w, 400, "bad request")
			return
		}
		method := "PUT"
		if body.Merge {
			method = "MERGE"
		}
		if !allowedWrite(uid, path, method, body.Data) {
			jsonErr(w, 403, "forbidden")
			return
		}
		if msg := checkUserTag(path, uid, body.Data); msg != "" {
			jsonErr(w, 409, msg)
			return
		}
		created, final, werr := writeDocData(path, body.Data, body.Merge, false)
		if werr != nil {
			jsonErr(w, 400, werr.Error())
			return
		}
		syncUserTag(path, uid, body.Data)
		if created {
			parent, _, _ := splitDocPath(path)
			dsMaybeNotify(parent, uid, final)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})

	case "PATCH": // updateDoc
		if !isDoc {
			jsonErr(w, 400, "doc path required")
			return
		}
		var body struct {
			Data map[string]interface{} `json:"data"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Data == nil {
			jsonErr(w, 400, "bad request")
			return
		}
		method := "PATCH"
		if !allowedWrite(uid, path, method, body.Data) {
			jsonErr(w, 403, "forbidden")
			return
		}
		if msg := checkUserTag(path, uid, body.Data); msg != "" {
			jsonErr(w, 409, msg)
			return
		}
		_, _, werr := writeDocData(path, body.Data, true, true)
		if werr != nil {
			if werr.Error() == "not found" {
				jsonErr(w, 404, "not found")
			} else {
				jsonErr(w, 400, werr.Error())
			}
			return
		}
		syncUserTag(path, uid, body.Data)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})

	case "DELETE":
		if !isDoc {
			jsonErr(w, 400, "doc path required")
			return
		}
		if !allowedWrite(uid, path, "DELETE", nil) {
			jsonErr(w, 403, "forbidden")
			return
		}
		parent, _, _ := splitDocPath(path)
		if _, err := db.Exec("DELETE FROM docs WHERE path=?", path); err != nil {
			jsonErr(w, 503, "storage unavailable")
			return
		}
		notifyDocChange(path, parent)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})

	default:
		jsonErr(w, 405, "method not allowed")
	}
}

func dsQueryHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == "OPTIONS" {
		return
	}
	uid, err := authUID(r)
	if err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	var q dsQuery
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.Collection == "" {
		jsonErr(w, 400, "bad request")
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"docs": dsDocsOut(runDsQuery(uid, q))})
}

// ── WebSocket-подписки ───────────────────────────────────────────────────────

var dwsUpgrader = websocket.Upgrader{CheckOrigin: allowedWebSocketOrigin}

type dwsSub struct {
	ID   string
	Kind string // "doc" | "query"
	Path string
	Q    dsQuery
}

type dwsClient struct {
	conn *websocket.Conn
	uid  string
	mu   sync.Mutex
	subs map[string]*dwsSub
}

var (
	dwsClients   = map[*dwsClient]bool{}
	dwsClientsMu sync.RWMutex
)

func (c *dwsClient) write(v interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(8 * time.Second))
	c.conn.WriteJSON(v)
}

func (c *dwsClient) sendSub(s *dwsSub) {
	if s.Kind == "doc" {
		var data map[string]interface{}
		if readableDocument(c.uid, s.Path) {
			data, _ = loadDocData(s.Path)
			data = visibleDoc(c.uid, s.Path, data)
		}
		exists := data != nil
		_, id, _ := splitDocPath(s.Path)
		c.write(map[string]interface{}{"type": "doc", "id": s.ID,
			"doc": map[string]interface{}{"id": id, "exists": exists, "data": data}})
	} else {
		c.write(map[string]interface{}{"type": "snap", "id": s.ID, "docs": dsDocsOut(runDsQuery(c.uid, s.Q))})
	}
}

func dwsHandler(w http.ResponseWriter, r *http.Request) {
	legacy := os.Getenv("ALLOW_LEGACY_WS_QUERY") == "1" && r.URL.Query().Get("token") != ""
	var uid string
	if legacy {
		var err error
		uid, err = parseToken(r.URL.Query().Get("token"))
		if err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
	}
	conn, err := dwsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(32768)
	if !legacy {
		var auth struct {
			Type  string `json:"type"`
			Token string `json:"token"`
		}
		conn.SetReadDeadline(time.Now().Add(8 * time.Second))
		if conn.ReadJSON(&auth) != nil || auth.Type != "auth" {
			return
		}
		uid, err = parseToken(auth.Token)
		if err != nil {
			return
		}
		if err := conn.WriteJSON(map[string]string{"type": "ready"}); err != nil {
			return
		}
	}
	c := &dwsClient{conn: conn, uid: uid, subs: map[string]*dwsSub{}}
	dwsClientsMu.Lock()
	dwsClients[c] = true
	dwsClientsMu.Unlock()
	defer func() {
		dwsClientsMu.Lock()
		delete(dwsClients, c)
		dwsClientsMu.Unlock()
		conn.Close()
	}()
	for {
		var msg struct {
			Type  string  `json:"type"`
			ID    string  `json:"id"`
			Kind  string  `json:"kind"`
			Path  string  `json:"path"`
			Query dsQuery `json:"query"`
		}
		conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case "sub":
			if msg.ID == "" || (msg.Kind != "doc" && msg.Kind != "query") {
				continue
			}
			s := &dwsSub{ID: msg.ID, Kind: msg.Kind, Path: strings.Trim(msg.Path, "/"), Q: msg.Query}
			c.mu.Lock()
			if len(c.subs) >= 128 && c.subs[msg.ID] == nil {
				c.mu.Unlock()
				return
			}
			c.subs[msg.ID] = s
			c.mu.Unlock()
			c.sendSub(s)
		case "unsub":
			c.mu.Lock()
			delete(c.subs, msg.ID)
			c.mu.Unlock()
		case "ping":
			c.write(map[string]interface{}{"type": "pong"})
		}
	}
}

// notifyDocChange — рассылаем свежие снимки всем подписчикам затронутого
// документа/коллекции.
func notifyDocChange(path, parent string) {
	go func() {
		dwsClientsMu.RLock()
		clients := make([]*dwsClient, 0, len(dwsClients))
		for c := range dwsClients {
			clients = append(clients, c)
		}
		dwsClientsMu.RUnlock()
		for _, c := range clients {
			c.mu.Lock()
			subs := make([]*dwsSub, 0, len(c.subs))
			for _, s := range c.subs {
				subs = append(subs, s)
			}
			c.mu.Unlock()
			for _, s := range subs {
				if (s.Kind == "doc" && s.Path == path) ||
					(s.Kind == "query" && strings.Trim(s.Q.Collection, "/") == parent) {
					c.sendSub(s)
				}
			}
		}
	}()
}

// ── Пуши на новые сообщения ──────────────────────────────────────────────────

func dsUserInChat(uid, parent string) bool {
	dwsClientsMu.RLock()
	defer dwsClientsMu.RUnlock()
	for c := range dwsClients {
		if c.uid != uid {
			continue
		}
		c.mu.Lock()
		for _, s := range c.subs {
			if s.Kind == "query" && strings.Trim(s.Q.Collection, "/") == parent {
				c.mu.Unlock()
				return true
			}
		}
		c.mu.Unlock()
	}
	return false
}

func dsMaybeNotify(parent, senderUID string, data map[string]interface{}) {
	segs := strings.Split(strings.Trim(parent, "/"), "/")
	if len(segs) != 3 || segs[0] != "chats" || segs[2] != "messages" {
		return
	}
	chatID := segs[1]
	go func() {
		chat, ok := loadDocData("chats/" + chatID)
		if !ok {
			return
		}
		membersRaw, _ := chat["members"].([]interface{})
		author, _ := data["author"].(string)
		if author == "" {
			author = "Новое сообщение"
		}
		body, _ := data["text"].(string)
		if t, _ := data["type"].(string); t != "" && t != "text" {
			switch t {
			case "voice":
				body = "🎙 Голосовое сообщение"
			case "circle":
				body = "⭕ Видео-кружок"
			case "image":
				body = "🖼 Фото"
			case "video":
				body = "🎬 Видео"
			case "file":
				body = "📎 Файл"
			}
		}
		if body == "" {
			body = "Новое сообщение"
		}
		if len(body) > 120 {
			body = body[:120]
		}
		for _, mRaw := range membersRaw {
			m, _ := mRaw.(string)
			if m == "" || m == senderUID {
				continue
			}
			if dsUserInChat(m, strings.Trim(parent, "/")) {
				continue // пользователь сейчас в этом чате — не шлём
			}
			u, ok := loadDocData("users/" + m)
			if !ok {
				continue
			}
			topic, _ := u["fcmToken"].(string)
			if topic == "" {
				continue
			}
			sendNtfy(topic, author, body, chatID, senderUID)
		}
	}()
}

// ── Dot-path helpers: ключи вида "names.<uid>" в updateDoc (как в Firestore) ──
func getDotValue(m map[string]interface{}, key string) interface{} {
	if !strings.Contains(key, ".") {
		return m[key]
	}
	cur := interface{}(m)
	for _, p := range strings.Split(key, ".") {
		mm, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = mm[p]
	}
	return cur
}

func setDotValue(m map[string]interface{}, key string, v interface{}) {
	if !strings.Contains(key, ".") {
		m[key] = v
		return
	}
	parts := strings.Split(key, ".")
	cur := m
	for i := 0; i < len(parts)-1; i++ {
		next, ok := cur[parts[i]].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			cur[parts[i]] = next
		}
		cur = next
	}
	cur[parts[len(parts)-1]] = v
}
