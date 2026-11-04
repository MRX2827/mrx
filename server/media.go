package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const mediaChunk = 256 << 10
const mediaLimit = 50_000_000
const mediaBudget = 1_000_000_000

var uploadSlots = make(chan struct{}, 2)

func initMedia() {
	applySchema(`
		CREATE TABLE IF NOT EXISTS media_objects (
			id TEXT PRIMARY KEY,
			mime TEXT NOT NULL,
			size INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS media_chunks (
			id TEXT NOT NULL,
			part INTEGER NOT NULL,
			data BLOB NOT NULL,
			PRIMARY KEY (id, part)
		);
	`)
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if r.Method != http.MethodPost {
		jsonErr(w, 405, "method not allowed")
		return
	}
	if _, err := authUID(r); err != nil {
		jsonErr(w, 401, "unauthorized")
		return
	}
	select {
	case uploadSlots <- struct{}{}:
		defer func() { <-uploadSlots }()
	default:
		jsonErr(w, 429, "uploads busy")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, mediaLimit+65536)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		jsonErr(w, 400, "invalid upload or exceeds 50 MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		jsonErr(w, 400, "file required")
		return
	}
	defer file.Close()
	if header.Size < 1 || header.Size > mediaLimit {
		jsonErr(w, 413, "file limit is 50 MB")
		return
	}
	var sniff [512]byte
	n, _ := io.ReadFull(file, sniff[:])
	mime := http.DetectContentType(sniff[:n])
	switch {
	case strings.HasPrefix(mime, "image/"), strings.HasPrefix(mime, "audio/"), strings.HasPrefix(mime, "video/"):
	default:
		// WebM and Ogg sniffers may return a generic type. Allow only safe media types.
		declared, _, _ := strings.Cut(strings.ToLower(header.Header.Get("Content-Type")), ";")
		switch declared {
		case "video/webm", "video/mp4", "audio/webm", "audio/ogg", "audio/mp4":
			mime = declared
		default:
			mime = "application/octet-stream"
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		jsonErr(w, 400, "invalid file")
		return
	}

	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		jsonErr(w, 503, "storage unavailable")
		return
	}
	id := hex.EncodeToString(key[:])
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonErr(w, 503, "storage unavailable")
		return
	}
	defer tx.Rollback()
	// Reserve bytes on the same transaction that publishes the chunks.
	result, err := tx.ExecContext(r.Context(), `
		INSERT INTO media_objects(id, mime, size)
		SELECT ?, ?, ? WHERE (SELECT COALESCE(SUM(size), 0) FROM media_objects) <= ?
	`, id, mime, header.Size, mediaBudget-header.Size)
	if err != nil {
		jsonErr(w, 503, "storage unavailable")
		return
	}
	count, err := result.RowsAffected()
	if err != nil || count == 0 {
		jsonErr(w, 507, "media quota reached")
		return
	}
	for offset, part := int64(0), 0; offset < header.Size; {
		// Keep each Turso request under a few MB including protocol overhead.
		values := make([]string, 0, 8)
		args := make([]interface{}, 0, 24)
		for len(values) < 8 && offset < header.Size {
			chunk := make([]byte, min(mediaChunk, header.Size-offset))
			if _, err := io.ReadFull(file, chunk); err != nil {
				jsonErr(w, 400, "incomplete file")
				return
			}
			values = append(values, "(?,?,?)")
			args = append(args, id, part, chunk)
			offset += int64(len(chunk))
			part++
		}
		if _, err := tx.ExecContext(r.Context(), "INSERT INTO media_chunks(id,part,data) VALUES "+
			strings.Join(values, ","), args...); err != nil {
			jsonErr(w, 503, "storage unavailable")
			return
		}
	}
	if tx.Commit() != nil {
		jsonErr(w, 503, "storage unavailable")
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"url": "/media/" + id})
}

func mediaHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(405)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/media/")
	if _, err := hex.DecodeString(id); len(id) != 64 || err != nil {
		http.NotFound(w, r)
		return
	}
	var mime string
	var size int64
	err := db.QueryRowContext(r.Context(), "SELECT mime, size FROM media_objects WHERE id=?", id).Scan(&mime, &size)
	if err == sql.ErrNoRows {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "storage unavailable", 503)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	if mime == "application/octet-stream" {
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Content-Type", mime)
	http.ServeContent(w, r, "", time.Time{}, &mediaReader{r: r, id: id, size: size, part: -1})
}

// ServeContent handles HEAD, byte ranges and media seeking over immutable chunks.
type mediaReader struct {
	r               *http.Request
	id              string
	size, pos, part int64
	data            []byte
}

func (m *mediaReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekCurrent:
		offset += m.pos
	case io.SeekEnd:
		offset += m.size
	}
	if offset < 0 {
		return 0, fmt.Errorf("negative position")
	}
	m.pos = offset
	return offset, nil
}

func (m *mediaReader) Read(out []byte) (int, error) {
	if m.pos >= m.size {
		return 0, io.EOF
	}
	part := m.pos / mediaChunk
	if part != m.part {
		if err := db.QueryRowContext(m.r.Context(),
			"SELECT data FROM media_chunks WHERE id=? AND part=?", m.id, part).Scan(&m.data); err != nil {
			return 0, err
		}
		m.part = part
	}
	offset := m.pos % mediaChunk
	if offset >= int64(len(m.data)) {
		return 0, io.ErrUnexpectedEOF
	}
	n := copy(out, m.data[offset:])
	m.pos += int64(n)
	return n, nil
}
