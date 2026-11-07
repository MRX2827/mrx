package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGoogleMailConfiguration(t *testing.T) {
	oldURL, oldKey, oldFrom, oldBrevo, oldSMTPLogin, oldSMTPKey := cfgGoogleMailURL, cfgGoogleMailKey, cfgMailFrom, cfgBrevoKey, cfgBrevoSMTPLogin, cfgBrevoSMTPKey
	t.Cleanup(func() {
		cfgGoogleMailURL, cfgGoogleMailKey, cfgMailFrom, cfgBrevoKey, cfgBrevoSMTPLogin, cfgBrevoSMTPKey = oldURL, oldKey, oldFrom, oldBrevo, oldSMTPLogin, oldSMTPKey
	})
	cfgGoogleMailKey = "test-only-secret-with-at-least-32-characters"
	cfgMailFrom, cfgBrevoKey, cfgBrevoSMTPLogin, cfgBrevoSMTPKey = "", "", "", ""
	for _, endpoint := range []string{
		"https://script.google.com/macros/s/deployment_test/exec",
		"http://script.google.com/macros/s/deployment_test/exec",
		"https://script.google.com.evil.example/macros/s/deployment/exec",
		"https://script.google.com/macros/s/deployment/dev",
		"https://script.google.com/macros/s/deployment/exec?secret=not-allowed",
	} {
		cfgGoogleMailURL = endpoint
		want := endpoint == "https://script.google.com/macros/s/deployment_test/exec"
		if googleMailConfigured() != want || mailEnabled() != want {
			t.Fatalf("unexpected configuration acceptance for %s", endpoint)
		}
	}
}

func TestGoogleMailSignedRequest(t *testing.T) {
	secret := "test-only-secret-with-at-least-32-characters"
	now := time.Unix(1800000000, 0)
	body, id, err := googleMailEnvelope("reader+tag@tuta.io", "001234", secret, now)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct{ Payload, Signature string }
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	var request googleMailPayload
	if err := json.Unmarshal([]byte(envelope.Payload), &request); err != nil {
		t.Fatal(err)
	}
	if request.Recipient != "reader+tag@tuta.io" || request.Code != "001234" || request.Timestamp != now.Unix() || request.ID != id || len(id) != 32 {
		t.Fatal("request must preserve leading zeros, timestamp, recipient and nonce")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("mrx-mail-v1\n" + envelope.Payload))
	if envelope.Signature != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("bridge signature mismatch")
	}
	if strings.Contains(string(body), secret) {
		t.Fatal("secret must never be sent")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("unexpected request method or encoding")
		}
		actual, _ := io.ReadAll(r.Body)
		if string(actual) != string(body) {
			t.Error("request bytes changed")
		}
		fmt.Fprintf(w, `{"ok":true,"id":%q}`, id)
	}))
	defer server.Close()
	if err := postGoogleMail(server.Client(), server.URL, body, id); err != nil {
		t.Fatal("valid acknowledgement rejected")
	}
	for _, response := range []string{
		`{"ok":false,"error":"quota"}`, `{"ok":true,"id":"wrong"}`,
		`<html>Sign in with Google</html>`, `{}`, `{"ok":true}`,
	} {
		t.Run(response, func(t *testing.T) {
			bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, response) }))
			defer bad.Close()
			if postGoogleMail(bad.Client(), bad.URL, body, id) == nil {
				t.Fatal("mail must not succeed without matching acknowledgement")
			}
		})
	}
}
