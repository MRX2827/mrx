package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

var googleDeploymentPath = regexp.MustCompile(`^/macros/s/[A-Za-z0-9_-]+/exec$`)

func googleMailConfigured() bool {
	u, err := url.Parse(cfgGoogleMailURL)
	return err == nil && u.Scheme == "https" && u.Host == "script.google.com" &&
		u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		googleDeploymentPath.MatchString(u.Path) && len(cfgGoogleMailKey) >= 32
}

type googleMailPayload struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Recipient string `json:"recipient"`
	Code      string `json:"code"`
}

func googleMailEnvelope(email, code, secret string, now time.Time) ([]byte, string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, "", err
	}
	id := hex.EncodeToString(nonce[:])
	payload, err := json.Marshal(googleMailPayload{id, now.Unix(), email, code})
	if err != nil {
		return nil, "", err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("mrx-mail-v1\n"))
	mac.Write(payload)
	body, err := json.Marshal(struct {
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}{string(payload), hex.EncodeToString(mac.Sum(nil))})
	return body, id, err
}

func sendGoogleMailCode(email, code string) error {
	if !validEmail(email) || len(code) != 6 {
		return errMailDelivery
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return errMailDelivery
		}
	}
	body, id, err := googleMailEnvelope(email, code, cfgGoogleMailKey, time.Now())
	if err != nil {
		return errMailDelivery
	}
	client := &http.Client{
		Timeout: 25 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// ContentService redirects to a Google-hosted GET result. Never
			// resend the signed request body to a different host (307/308).
			if len(via) > 3 || req.Method != http.MethodGet || req.URL.Scheme != "https" ||
				(req.URL.Host != "script.googleusercontent.com" && req.URL.Host != "script.google.com") {
				return fmt.Errorf("unexpected mail bridge redirect")
			}
			return nil
		},
	}
	if err := postGoogleMail(client, cfgGoogleMailURL, body, id); err != nil {
		// URLs and response bodies can include signed Google result links,
		// recipient addresses, or diagnostics. Do not put them in logs.
		log.Println("MAIL: Google Apps Script delivery not acknowledged")
		return errMailDelivery
	}
	return nil
}

func postGoogleMail(client *http.Client, endpoint string, body []byte, id string) error {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return errMailDelivery
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return errMailDelivery
	}
	defer resp.Body.Close()
	var acknowledgement struct {
		OK bool   `json:"ok"`
		ID string `json:"id"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&acknowledgement) != nil ||
		!acknowledgement.OK || acknowledgement.ID != id {
		return errMailDelivery
	}
	return nil
}
