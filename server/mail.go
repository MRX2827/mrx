package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/mail"
	"slices"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const mailCodeLifetime = 15 * time.Minute

var (
	errMailDisabled = errors.New("mail unavailable")
	errMailCooldown = errors.New("wait a minute")
	errMailDelivery = errors.New("mail send failed")
	errMailInactive = errors.New("mail provider inactive")
	errMailConflict = errors.New("email conflict")
	mailCodeSender  = sendMailCode
)

func brevoSMTPConfigured() bool {
	return cfgBrevoSMTPLogin != "" && cfgBrevoSMTPKey != ""
}

func mailEnabled() bool {
	return googleMailConfigured() || (validEmail(cfgMailFrom) && (brevoSMTPConfigured() || cfgBrevoKey != ""))
}

func validEmail(email string) bool {
	if len(email) < 5 || len(email) > 254 || strings.Count(email, "@") != 1 || strings.ContainsAny(email, " \t\r\n") {
		return false
	}
	address, err := mail.ParseAddress(email)
	_, domain, _ := strings.Cut(email, "@")
	return err == nil && address.Address == email && strings.Contains(domain, ".")
}

func migrateMail() {
	for _, statement := range []string{
		"ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''",
		"ALTER TABLE users ADD COLUMN email_ok INTEGER DEFAULT 0",
		"CREATE TABLE IF NOT EXISTS mail_codes (email TEXT PRIMARY KEY, code TEXT DEFAULT '', uid TEXT DEFAULT '', ts INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, tries INTEGER DEFAULT 0, purpose TEXT NOT NULL DEFAULT 'legacy')",
		"ALTER TABLE mail_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'legacy'",
		"CREATE TABLE IF NOT EXISTS account_email_changes (uid TEXT PRIMARY KEY, email TEXT NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
			log.Fatal("account schema migration failed")
		}
	}
	if googleMailConfigured() {
		log.Println("OK: verification sender configured (Google Apps Script)")
	} else if mailEnabled() {
		log.Println("OK: verification sender configured (Brevo)")
	} else {
		log.Println("WARN: verification sender not configured; ordinary registration remains unavailable")
	}
}

func sendMailCode(email, code string) error {
	if googleMailConfigured() {
		return sendGoogleMailCode(email, code)
	}
	if brevoSMTPConfigured() {
		return sendBrevoSMTPCode(email, code)
	}
	payload := map[string]interface{}{
		"sender":      map[string]string{"name": "MRX", "email": cfgMailFrom},
		"to":          []map[string]string{{"email": email}},
		"subject":     "MRX: код подтверждения",
		"textContent": "Код подтверждения MRX: " + code + "\nКод действует 15 минут.",
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", "https://api.brevo.com/v3/smtp/email", bytes.NewReader(body))
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
		log.Printf("MAIL: Brevo returned %d", resp.StatusCode)
		var failure struct {
			Message string `json:"message"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&failure) == nil && inactiveMailPlatform(failure.Message) {
			return errMailInactive
		}
		return errMailDelivery
	}
	return nil
}

func inactiveMailPlatform(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "smtp account is not yet activated") || strings.Contains(lower, "sending platform is currently disabled")
}

func issueMailCode(email, uid, purpose string) error {
	if !mailEnabled() {
		return errMailDisabled
	}
	value, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return err
	}
	code := fmt.Sprintf("%06d", value.Int64())
	now := time.Now().UnixMilli()
	result, err := db.Exec(`INSERT INTO mail_codes (email,code,uid,ts,sent,tries,purpose) VALUES (?,?,?,?,?,0,?)
		ON CONFLICT(email) DO UPDATE SET code=excluded.code,uid=excluded.uid,ts=excluded.ts,
		sent=excluded.sent,tries=0,purpose=excluded.purpose WHERE mail_codes.sent<=?`,
		email, code, uid, now, now, purpose, now-time.Minute.Milliseconds())
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil {
		return err
	} else if count == 0 {
		return errMailCooldown
	}
	if err := mailCodeSender(email, code); err != nil {
		// Allow an immediate retry after a delivery failure.
		db.Exec("DELETE FROM mail_codes WHERE email=? AND uid=? AND ts=? AND code=?", email, uid, now, code)
		if errors.Is(err, errMailInactive) {
			return errMailInactive
		}
		return errMailDelivery
	}
	return nil
}

func reportMailError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errMailDisabled), errors.Is(err, errMailDelivery), errors.Is(err, errMailInactive):
		jsonErr(w, 503, err.Error())
	case errors.Is(err, errMailCooldown):
		jsonErr(w, 429, err.Error())
	default:
		jsonErr(w, 500, "server error")
	}
}

func mailPost(w http.ResponseWriter, r *http.Request) bool {
	cors(w)
	if r.Method == http.MethodOptions {
		return false
	}
	if r.Method != http.MethodPost {
		jsonErr(w, 405, "method not allowed")
		return false
	}
	return true
}

func consumeMailCode(w http.ResponseWriter, r *http.Request, email, account, code string, purposes []string, apply func(*sql.Tx, string) error) bool {
	var stored, uid, purpose string
	var issued int64
	var tries int
	if err := db.QueryRowContext(r.Context(), "SELECT code,uid,purpose,ts,tries FROM mail_codes WHERE email=?", email).
		Scan(&stored, &uid, &purpose, &issued, &tries); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonErr(w, 401, "invalid code")
		} else {
			jsonErr(w, 500, "server error")
		}
		return false
	}
	if (account != "" && account != uid) || !slices.Contains(purposes, purpose) {
		jsonErr(w, 401, "invalid code")
		return false
	}
	cutoff := time.Now().Add(-mailCodeLifetime).UnixMilli()
	if issued < cutoff {
		jsonErr(w, 401, "code expired")
		return false
	}
	if tries >= 5 {
		jsonErr(w, 429, "too many attempts")
		return false
	}
	if code == "" || subtle.ConstantTimeCompare([]byte(code), []byte(stored)) != 1 {
		db.ExecContext(r.Context(), "UPDATE mail_codes SET tries=tries+1 WHERE email=? AND uid=? AND code=? AND ts=? AND tries<5", email, uid, stored, issued)
		jsonErr(w, 401, "invalid code")
		return false
	}

	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonErr(w, 500, "server error")
		return false
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), "DELETE FROM mail_codes WHERE email=? AND uid=? AND purpose=? AND code=? AND ts=? AND tries<5", email, uid, purpose, stored, issued)
	if err != nil {
		jsonErr(w, 500, "server error")
		return false
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		jsonErr(w, 401, "invalid code")
		return false
	}
	if err := apply(tx, uid); err != nil {
		if errors.Is(err, errMailConflict) {
			jsonErr(w, 409, "email conflict")
		} else {
			jsonErr(w, 500, "server error")
		}
		return false
	}
	if tx.Commit() != nil {
		jsonErr(w, 500, "server error")
		return false
	}
	return true
}

func authVerifyHandler(w http.ResponseWriter, r *http.Request) {
	if !mailPost(w, r) {
		return
	}
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	var verifiedUID string
	if !consumeMailCode(w, r, email, "", strings.TrimSpace(req.Code), []string{"verify", "attach", "legacy"}, func(tx *sql.Tx, uid string) error {
		verifiedUID = uid
		result, err := tx.ExecContext(r.Context(), `UPDATE users SET email=?,email_ok=1
			WHERE id=? AND (COALESCE(email_ok,0)<>1 OR COALESCE(email,'')='')
			AND NOT EXISTS(SELECT 1 FROM users WHERE LOWER(email)=? AND email_ok=1 AND id<>?)`, email, uid, email, uid)
		if err != nil {
			return err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return errMailConflict
		}
		_, err = tx.ExecContext(r.Context(), "DELETE FROM account_email_changes WHERE uid=?", uid)
		return err
	}) {
		return
	}
	writeLoginResponse(w, verifiedUID)
}

func authResendHandler(w http.ResponseWriter, r *http.Request) {
	if !mailPost(w, r) {
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	var uid, purpose string
	err := db.QueryRow(`SELECT c.uid,c.purpose FROM mail_codes c JOIN users u ON c.uid=u.id WHERE c.email=?
		AND c.purpose IN ('verify','attach','legacy') AND COALESCE(u.email_ok,0)<>1`, email).Scan(&uid, &purpose)
	if errors.Is(err, sql.ErrNoRows) {
		purpose = "verify"
		err = db.QueryRow("SELECT id FROM users WHERE email=? AND email_ok=0", email).Scan(&uid)
	}
	if err != nil {
		jsonErr(w, 404, "not found")
		return
	}
	if purpose == "legacy" {
		purpose = "verify"
	}
	if err := issueMailCode(email, uid, purpose); err != nil {
		reportMailError(w, err)
		return
	}
	w.Write([]byte(`{"ok":true}`))
}

func authAttachHandler(w http.ResponseWriter, r *http.Request) {
	if !mailPost(w, r) {
		return
	}
	var req struct {
		Tag      string `json:"tag"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !validEmail(email) {
		jsonErr(w, 400, "email invalid")
		return
	}
	user, hash, err := getUserByTag(strings.TrimPrefix(strings.TrimSpace(req.Tag), "@"))
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		jsonErr(w, 401, "invalid credentials")
		return
	}
	if user.EmailOk == 1 && user.Email != "" {
		jsonErr(w, 403, "use account settings")
		return
	}
	var taken bool
	if err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(email)=? AND email_ok=1 AND id<>?)", email, user.ID).Scan(&taken); err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	if taken {
		jsonErr(w, 409, "email taken")
		return
	}
	if err := issueMailCode(email, user.ID, "attach"); err != nil {
		reportMailError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"pending": true, "email": email})
}

func maskEmail(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	if !ok {
		return "***"
	}
	runes := []rune(local)
	return string(runes[:min(2, len(runes))]) + "*****@" + domain
}

func verifiedAccount(login string) (*User, string, error) {
	login = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(login)), "@")
	if strings.Contains(login, "@") {
		return scanUser(db.QueryRow("SELECT "+userCols+" FROM users WHERE LOWER(email)=? AND email_ok=1 LIMIT 1", login))
	}
	return getUserByTag(login)
}

func authResetHandler(w http.ResponseWriter, r *http.Request) {
	if !mailPost(w, r) {
		return
	}
	var req struct {
		Login string `json:"login"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || strings.TrimSpace(req.Login) == "" {
		jsonErr(w, 400, "login required")
		return
	}
	if !mailEnabled() {
		reportMailError(w, errMailDisabled)
		return
	}
	user, _, err := verifiedAccount(req.Login)
	if err != nil || user.Email == "" || user.EmailOk != 1 {
		json.NewEncoder(w).Encode(map[string]string{"hint": "if that account exists, a code was sent"})
		return
	}
	if err := issueMailCode(user.Email, user.ID, "reset"); err != nil {
		reportMailError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"email": maskEmail(user.Email)})
}

func authResetConfirmHandler(w http.ResponseWriter, r *http.Request) {
	if !mailPost(w, r) {
		return
	}
	var req struct {
		Login    string `json:"login"`
		Code     string `json:"code"`
		Password string `json:"password"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || !validNewPassword(req.Password) {
		jsonErr(w, 400, "invalid new password")
		return
	}
	user, _, err := verifiedAccount(req.Login)
	if err != nil || user.Email == "" || user.EmailOk != 1 {
		jsonErr(w, 401, "invalid code")
		return
	}
	if !consumeMailCode(w, r, user.Email, user.ID, strings.TrimSpace(req.Code), []string{"reset"}, func(tx *sql.Tx, uid string) error {
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), "UPDATE users SET pass_hash=? WHERE id=?", string(hash), uid)
		return err
	}) {
		return
	}
	writeLoginResponse(w, user.ID)
}

func writeLoginResponse(w http.ResponseWriter, uid string) {
	user, _, err := getUserByID(uid)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"user": user, "token": makeToken(uid)})
}
