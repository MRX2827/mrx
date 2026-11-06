package main

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

var sharedLinkID = regexp.MustCompile("^[A-Za-z0-9_-]{1,180}$")

func init() {
	for kind, title := range map[string]string{
		"u": "Профиль MRX", "group": "Группа MRX",
		"channel": "Канал MRX", "chat": "Чат MRX",
	} {
		http.HandleFunc("GET /"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) {
			id := strings.TrimPrefix(r.PathValue("id"), "@")
			if !sharedLinkID.MatchString(id) {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
			fmt.Fprintf(w, `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>%[1]s</title><style>body{color-scheme:dark;background:#101114;color:#fff;font:16px system-ui;max-width:26rem;margin:20vh auto;padding:1.5rem}a{display:inline-block;background:#fff;color:#111;text-decoration:none;padding:.75rem 1.15rem;border-radius:1rem;font-weight:700}</style><h1>%[1]s</h1><p>Эта ссылка откроет нужный экран в приложении MRX.</p><a href="mrx://%[2]s/%[3]s">Открыть в MRX</a></html>`, title, kind, id)
		})
	}
	http.HandleFunc("GET /.well-known/assetlinks.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.redmrxgram.app.fdroid.recovery",
    "sha256_cert_fingerprints": ["43:D5:3F:2E:8B:83:29:25:05:06:13:51:30:9D:94:45:9A:45:FF:34:38:F4:9B:A8:81:72:A2:84:EC:D7:BF:0C"]
  }
}]`)
	})
}
