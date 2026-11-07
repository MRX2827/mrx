package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestRegistrationAndGuestRecovery(t *testing.T) {
	t.Setenv("TURSO_DATABASE_URL", "")
	t.Setenv("TURSO_AUTH_TOKEN", "")
	t.Setenv("RENDER", "")
	t.Setenv("ALLOW_REGISTRATION", "1")
	oldDB, oldPath, oldSecret, oldKey, oldFrom, oldSender := db, cfgDBPath, cfgJWTSecret, cfgBrevoKey, cfgMailFrom, mailCodeSender
	oldLogin, oldSMTP := cfgBrevoSMTPLogin, cfgBrevoSMTPKey
	cfgDBPath = filepath.Join(t.TempDir(), "auth.db")
	cfgJWTSecret = []byte("local registration regression signing key only")
	cfgBrevoKey, cfgMailFrom, cfgBrevoSMTPLogin, cfgBrevoSMTPKey = "test", "sender@example.test", "", ""
	initDB()
	migrateMail()
	ensureDocsTable()
	t.Cleanup(func() {
		db.Close()
		db, cfgDBPath, cfgJWTSecret, cfgBrevoKey, cfgMailFrom, mailCodeSender = oldDB, oldPath, oldSecret, oldKey, oldFrom, oldSender
		cfgBrevoSMTPLogin, cfgBrevoSMTPKey = oldLogin, oldSMTP
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/register", authRegisterHandler)
	mux.HandleFunc("/auth/login", authLoginHandler)
	mux.HandleFunc("/auth/verify", authVerifyHandler)
	mux.HandleFunc("/auth/resend", authResendHandler)
	mux.HandleFunc("/d/", docHandler)
	call := func(path, method, token string, input interface{}, status int) map[string]interface{} {
		t.Helper()
		payload, _ := json.Marshal(input)
		request := httptest.NewRequest(method, path, bytes.NewReader(payload))
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("%s %s got %d, expected %d: %s", method, path, response.Code, status, response.Body.String())
		}
		var result map[string]interface{}
		json.Unmarshal(response.Body.Bytes(), &result)
		return result
	}
	type fields = map[string]interface{}
	codes := map[string]string{}
	deliveries := 0
	mailCodeSender = func(email, code string) error {
		codes[email] = code
		deliveries++
		return nil
	}
	for _, email := range []string{"reader@proton.me", "reader@gmail.com"} {
		tag := "reader_" + string(rune('a'+deliveries))
		input := fields{"tag": tag, "email": email, "password": "registration pass", "name": "Reader"}
		pending := call("/auth/register", "POST", "", input, 200)
		if pending["pending"] != true || pending["token"] != nil {
			t.Fatal("new account must await email verification")
		}
		sentBeforeRetry := deliveries
		retry := call("/auth/register", "POST", "", input, 200)
		if deliveries != sentBeforeRetry || retry["codeSent"] != false {
			t.Fatal("repeated registration should reuse the existing code and account")
		}
		call("/auth/register", "POST", "", fields{"tag": tag, "email": email, "password": "wrong password"}, 409)
		unverified := call("/auth/login", "POST", "", fields{"tag": "@" + tag, "password": "registration pass"}, 403)
		if unverified["codeSent"] != false {
			t.Fatal("unverified login should preserve an already delivered code")
		}
		call("/auth/resend", "POST", "", fields{"email": email}, 429)
		call("/auth/verify", "POST", "", fields{"email": email, "code": "wrong"}, 401)
		session := call("/auth/verify", "POST", "", fields{"email": email, "code": codes[email]}, 200)
		if session["token"] == nil {
			t.Fatal("verification must establish a session")
		}
		call("/auth/login", "POST", "", fields{"tag": "@" + tag, "password": "registration pass"}, 200)
		call("/auth/login", "POST", "", fields{"tag": email, "password": "registration pass"}, 200)
		call("/auth/login", "POST", "", fields{"tag": email, "password": "wrong password"}, 401)
	}

	mailCodeSender = func(string, string) error { return errors.New("temporary SMTP failure") }
	interrupted := fields{"tag": "retry_user", "email": "retry@proton.me", "password": "registration pass"}
	call("/auth/register", "POST", "", interrupted, 503)
	original, _, err := getUserByTag("retry_user")
	if err != nil {
		t.Fatal(err)
	}
	mailCodeSender = func(email, code string) error { codes[email] = code; return nil }
	call("/auth/register", "POST", "", interrupted, 200)
	recovered, _, _ := getUserByTag("retry_user")
	if recovered.ID != original.ID {
		t.Fatal("a mail failure must preserve the pending identity")
	}
	call("/auth/verify", "POST", "", fields{"email": "retry@proton.me", "code": codes["retry@proton.me"]}, 200)

	guestInput := fields{"tag": "anon_savedguest", "password": "guest random password"}
	t.Setenv("ALLOW_REGISTRATION", "0")
	call("/auth/register", "POST", "", guestInput, 403)
	t.Setenv("ALLOW_REGISTRATION", "1")
	guest := call("/auth/register", "POST", "", guestInput, 200)
	user := guest["user"].(map[string]interface{})
	uid := user["id"].(string)
	token := guest["token"].(string)
	if user["isAnonymous"] != true {
		t.Fatal("guest session must be identified as anonymous")
	}
	retried := call("/auth/register", "POST", "", guestInput, 200)
	if retried["user"].(map[string]interface{})["id"] != uid {
		t.Fatal("a lost guest registration response must be recoverable")
	}
	call("/d/users/"+uid, "PUT", token, fields{"data": fields{"uid": uid, "tag": "guest_legacy", "isAnonymous": true}}, 200)
	legacy := call("/auth/login", "POST", "", fields{"tag": "anon_savedguest", "password": "guest random password", "guestUid": uid}, 200)
	if legacy["user"].(map[string]interface{})["id"] != uid || legacy["user"].(map[string]interface{})["isAnonymous"] != true {
		t.Fatal("legacy renamed guest must resume the same identity")
	}
	call("/auth/login", "POST", "", fields{"tag": "anon_savedguest", "password": "wrong password", "guestUid": uid}, 401)
	call("/d/users/"+uid, "PATCH", token, fields{"data": fields{"tag": "guest_renamed_again"}}, 200)
	call("/auth/login", "POST", "", fields{"tag": "guest_legacy", "password": "guest random password", "guestUid": uid}, 200)
	call("/auth/register", "GET", "", nil, 405)
	call("/auth/login", "GET", "", nil, 405)
}
