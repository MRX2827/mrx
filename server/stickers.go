package main

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

var stickerPackID = regexp.MustCompile("^[a-f0-9]{32}$")
var stickerMediaPath = regexp.MustCompile("^/media/[a-f0-9]{64}$")

func validStickerPack(uid string, data map[string]interface{}) bool {
	name, _ := data["name"].(string)
	count := utf8.RuneCountInString(strings.TrimSpace(name))
	items, ok := data["stickers"].([]interface{})
	if !fieldsOnly(data, "owner", "name", "stickers") || data["owner"] != uid ||
		count < 1 || count > 60 || !ok || len(items) < 1 || len(items) > 30 {
		return false
	}
	for _, item := range items {
		path, ok := item.(string)
		if !ok || !stickerMediaPath.MatchString(path) {
			return false
		}
	}
	return true
}

func init() {
	http.HandleFunc("/stickers/", stickerPackLink)
}

func stickerPackLink(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/stickers/")
	if !stickerPackID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
	fmt.Fprintf(w, `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Набор стикеров MRX</title><style>body{color-scheme:dark;background:#101114;color:#fff;font:16px system-ui;max-width:26rem;margin:20vh auto;padding:1.5rem}a{display:inline-block;background:#fff;color:#111;text-decoration:none;padding:.75rem 1.15rem;border-radius:1rem;font-weight:700}</style><h1>Набор стикеров MRX</h1><p>Открой набор в MRX, чтобы посмотреть стикеры и добавить их себе.</p><a href="mrx://stickers/%s">Открыть в MRX</a></html>`, id)
}
