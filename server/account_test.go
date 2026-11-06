package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestAccountSecurity(t *testing.T) {
	t.Setenv("TURSO_DATABASE_URL", "")
	t.Setenv("TURSO_AUTH_TOKEN", "")
	t.Setenv("RENDER", "")
	t.Setenv("ALLOW_REGISTRATION", "1")
	oldDB, oldPath, oldSecret, oldKey, oldFrom, oldSender := db, cfgDBPath, cfgJWTSecret, cfgBrevoKey, cfgMailFrom, mailCodeSender
	cfgDBPath, cfgJWTSecret = filepath.Join(t.TempDir(), "test.db"), []byte("local account test signing key only")
	cfgBrevoKey, cfgMailFrom = "", ""
	initDB()
	migrateMail()
	t.Cleanup(func() {
		db.Close()
		db, cfgDBPath, cfgJWTSecret, cfgBrevoKey, cfgMailFrom, mailCodeSender = oldDB, oldPath, oldSecret, oldKey, oldFrom, oldSender
	})
	password := "old pass"
	hash, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	for _, user := range []struct{ id, tag, email string }{
		{"owner", "owner", "old@example.test"},
		{"other", "other", "other@example.test"},
	} {
		if _, err := db.Exec("INSERT INTO users(id,tag,email,email_ok,pass_hash) VALUES (?,?,?,?,?)", user.id, user.tag, user.email, 1, string(hash)); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for path, handler := range map[string]http.HandlerFunc{
		"/auth/account":               accountEndpoint(http.MethodGet, accountDetails),
		"/auth/account/password":      accountEndpoint(http.MethodPost, accountPassword),
		"/auth/account/email":         accountEndpoint(http.MethodPost, accountEmail),
		"/auth/account/email/confirm": accountEndpoint(http.MethodPost, accountEmailConfirm),
		"/auth/login":                 authLoginHandler,
		"/auth/verify":                authVerifyHandler,
		"/auth/attach":                authAttachHandler,
		"/auth/reset":                 authResetHandler,
		"/auth/reset/confirm":         authResetConfirmHandler,
		"/user":                       userHandler,
	} {
		mux.HandleFunc(path, handler)
	}
	call := func(method, path, uid string, body map[string]string, status int) map[string]interface{} {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		if uid != "" {
			req.Header.Set("Authorization", "Bearer "+makeToken(uid))
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s %s: got %d, expected %d, response %s", method, path, w.Code, status, w.Body.String())
		}
		var data map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &data)
		return data
	}
	call("GET", "/auth/account", "", nil, 401)
	if data := call("GET", "/user?id=owner", "other", nil, 200); data["email"] != nil {
		t.Fatal("public profile leaked email")
	}
	if data := call("GET", "/auth/account?id=other", "owner", nil, 200); data["email"] != "old@example.test" || data["emailVerified"] != true {
		t.Fatal("account details must show only the owner email")
	}
	call("POST", "/auth/account/password", "owner", map[string]string{"currentPassword": "wrong", "newPassword": "new pass"}, 401)
	call("POST", "/auth/account/password", "owner", map[string]string{"currentPassword": password, "newPassword": strings.Repeat("я", 37)}, 400)
	call("POST", "/auth/account/password", "owner", map[string]string{"currentPassword": password, "newPassword": "new pass"}, 200)
	call("POST", "/auth/login", "", map[string]string{"tag": "owner", "password": password}, 401)
	password = "new pass"
	login := map[string]string{"tag": "old@example.test", "password": password}
	call("POST", "/auth/login", "", login, 200)
	call("POST", "/auth/account/email", "owner", map[string]string{"email": "other@example.test", "currentPassword": password}, 409)
	change := map[string]string{"email": "NEW@example.test", "currentPassword": password}
	state := call("POST", "/auth/account/email", "owner", change, 200)
	if state["email"] != "old@example.test" || state["pendingEmail"] != "new@example.test" || state["codeSent"] != false {
		t.Fatal("without mail, new address should stay pending and old one should remain active")
	}
	call("POST", "/auth/login", "", login, 200)
	call("POST", "/auth/login", "", map[string]string{"tag": "new@example.test", "password": password}, 401)
	call("POST", "/auth/reset", "", map[string]string{"login": "owner"}, 503)

	cfgBrevoKey, cfgMailFrom = "test", "mailer@example.test"
	mailCodeSender = func(string, string) error { return errors.New("provider failure") }
	call("POST", "/auth/account/email", "owner", change, 503)
	var mailedCode string
	mailCodeSender = func(_ string, code string) error { mailedCode = code; return nil }
	call("POST", "/auth/account/email", "owner", change, 200)
	confirmation := map[string]string{"email": "new@example.test", "code": mailedCode}
	call("POST", "/auth/account/email/confirm", "other", confirmation, 401)
	call("POST", "/auth/verify", "", confirmation, 401)
	call("POST", "/auth/account/email/confirm", "owner", confirmation, 200)
	call("POST", "/auth/account/email/confirm", "owner", confirmation, 401)
	call("POST", "/auth/login", "", login, 401)
	login["tag"] = "new@example.test"
	call("POST", "/auth/login", "", login, 200)
	call("POST", "/auth/attach", "", map[string]string{"tag": "owner", "password": password, "email": "unsafe@example.test"}, 403)

	call("POST", "/auth/reset", "", map[string]string{"login": "@owner"}, 200)
	reset := map[string]string{"login": "new@example.test", "code": mailedCode, "password": "reset pass"}
	if _, err := db.Exec("UPDATE mail_codes SET ts=? WHERE uid=?", time.Now().Add(-16*time.Minute).UnixMilli(), "owner"); err != nil {
		t.Fatal(err)
	}
	call("POST", "/auth/reset/confirm", "", reset, 401)
	if _, err := db.Exec("UPDATE mail_codes SET ts=? WHERE uid=?", time.Now().UnixMilli(), "owner"); err != nil {
		t.Fatal(err)
	}
	call("POST", "/auth/reset/confirm", "", reset, 200)
	call("POST", "/auth/reset/confirm", "", reset, 401)
	login["password"] = "reset pass"
	call("POST", "/auth/login", "", login, 200)
}
