package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func init() {
	http.HandleFunc("/auth/account", accountEndpoint(http.MethodGet, accountDetails))
	http.HandleFunc("/auth/account/password", accountEndpoint(http.MethodPost, accountPassword))
	http.HandleFunc("/auth/account/email", accountEndpoint(http.MethodPost, accountEmail))
	http.HandleFunc("/auth/account/email/confirm", accountEndpoint(http.MethodPost, accountEmailConfirm))
}

func accountEndpoint(method string, handler func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != method {
			jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		uid, err := authUID(r)
		if err != nil {
			jsonErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		handler(w, r, uid)
	}
}

type accountEmailState struct {
	Email        string `json:"email"`
	Verified     bool   `json:"emailVerified"`
	PendingEmail string `json:"pendingEmail"`
	MailEnabled  bool   `json:"mailEnabled"`
	CodeSent     bool   `json:"codeSent"`
}

func accountDetails(w http.ResponseWriter, r *http.Request, uid string) {
	var state accountEmailState
	var verified int
	err := db.QueryRowContext(r.Context(), `SELECT COALESCE(u.email,''), COALESCE(u.email_ok,0), COALESCE(c.email,'')
		FROM users u LEFT JOIN account_email_changes c ON c.uid=u.id WHERE u.id=?`, uid).
		Scan(&state.Email, &verified, &state.PendingEmail)
	if errors.Is(err, sql.ErrNoRows) {
		jsonErr(w, 404, "account not found")
		return
	}
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	state.Verified = verified == 1 && state.Email != ""
	state.MailEnabled = mailEnabled()
	json.NewEncoder(w).Encode(state)
}

func accountPassword(w http.ResponseWriter, r *http.Request, uid string) {
	var req struct {
		Current string `json:"currentPassword"`
		New     string `json:"newPassword"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	if !validNewPassword(req.New) {
		jsonErr(w, 400, "invalid new password")
		return
	}
	_, currentHash, err := getUserByID(uid)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(req.Current)) != nil {
		jsonErr(w, 401, "invalid password")
		return
	}
	if req.Current == req.New {
		jsonErr(w, 400, "password unchanged")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.New), bcrypt.DefaultCost)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), "UPDATE users SET pass_hash=? WHERE id=? AND pass_hash=?", string(hash), uid, currentHash)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		jsonErr(w, 409, "password changed concurrently")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM mail_codes WHERE uid=? AND purpose='reset'", uid); err != nil || tx.Commit() != nil {
		jsonErr(w, 500, "server error")
		return
	}
	w.Write([]byte(`{"ok":true}`))
}

func validNewPassword(password string) bool {
	return len([]rune(password)) >= 6 && len(password) <= 72
}

func accountEmail(w http.ResponseWriter, r *http.Request, uid string) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"currentPassword"`
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
	user, hash, err := getUserByID(uid)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		jsonErr(w, 401, "invalid password")
		return
	}
	if strings.EqualFold(user.Email, email) && user.EmailOk == 1 {
		jsonErr(w, 409, "email unchanged")
		return
	}
	var taken bool
	if err := db.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(email)=? AND email_ok=1 AND id<>?)", email, uid).Scan(&taken); err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	if taken {
		jsonErr(w, 409, "email taken")
		return
	}

	// The pending address is separate from the address used for login and recovery.
	result, err := db.ExecContext(r.Context(), `INSERT INTO account_email_changes(uid,email)
		SELECT id,? FROM users WHERE id=? AND pass_hash=?
		ON CONFLICT(uid) DO UPDATE SET email=excluded.email`, email, uid, hash)
	if err != nil {
		jsonErr(w, 500, "server error")
		return
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		jsonErr(w, 409, "password changed concurrently")
		return
	}
	state := accountEmailState{
		Email: user.Email, Verified: user.EmailOk == 1 && user.Email != "",
		PendingEmail: email, MailEnabled: mailEnabled(),
	}
	if state.MailEnabled {
		if err := issueMailCode(email, uid, "change"); err != nil {
			reportMailError(w, err)
			return
		}
		state.CodeSent = true
	}
	json.NewEncoder(w).Encode(state)
}

func accountEmailConfirm(w http.ResponseWriter, r *http.Request, uid string) {
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		jsonErr(w, 400, "bad request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !consumeMailCode(w, r, email, uid, strings.TrimSpace(req.Code), []string{"change"}, func(tx *sql.Tx, uid string) error {
		result, err := tx.ExecContext(r.Context(), `UPDATE users SET email=?,email_ok=1 WHERE id=?
			AND EXISTS(SELECT 1 FROM account_email_changes WHERE uid=? AND email=?)
			AND NOT EXISTS(SELECT 1 FROM users WHERE LOWER(email)=? AND email_ok=1 AND id<>?)`, email, uid, uid, email, email, uid)
		if err != nil {
			return err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return errMailConflict
		}
		if _, err := tx.ExecContext(r.Context(), "DELETE FROM account_email_changes WHERE uid=?", uid); err != nil {
			return err
		}
		_, err = tx.ExecContext(r.Context(), "DELETE FROM mail_codes WHERE uid=? AND purpose='reset'", uid)
		return err
	}) {
		return
	}
	json.NewEncoder(w).Encode(accountEmailState{Email: email, Verified: true, MailEnabled: mailEnabled()})
}
