package server

import (
	"io"
	"net/http"
	"strings"
)

// directoryUnavailable handles browser navigation only; API callers retain JSON errors.
func directoryUnavailable(w http.ResponseWriter, r *http.Request, _ int) bool {
	if (r.Method != http.MethodGet && r.Method != http.MethodHead) || strings.Contains(r.URL.Path, "/api/") || !strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html") {
		return false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "document" && dest != "iframe" {
		return false
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "30")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusServiceUnavailable)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, directoryUnavailableHTML)
	}
	return true
}

const directoryUnavailableHTML = `<!doctype html><html lang="ru" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0c1522"><title>Адресная книга · Platform</title><script src="/theme-init.js"></script><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:38px;font:15px/1.5 "Segoe UI",Arial,sans-serif;color:#e6edf6;background:radial-gradient(ellipse at 20% 15%,#29445d66,transparent 55%),radial-gradient(ellipse at 85% 90%,#23475644,transparent 60%),#0c1522}main{width:100%;max-width:650px;padding:40px;border:1px solid #a3c9ed30;border-radius:18px;background:linear-gradient(130deg,#708fb31d,#597c9d13);backdrop-filter:blur(32px) saturate(135%);box-shadow:inset 0 1px 0 #ffffff12,0 24px 100px #0005}.brand{font-size:22px;font-weight:650;letter-spacing:-.4px;color:#83c5ff;margin-bottom:32px}h1{font-size:30px;line-height:1.3;font-weight:560;letter-spacing:-.9px;margin:0 0 16px}p{color:#9caec6;margin:0 0 28px}.actions{display:flex;gap:12px;flex-wrap:wrap}a{display:inline-flex;align-items:center;justify-content:center;min-height:39px;padding:9px 14px;border:1px solid #a3c9ed38;border-radius:9px;color:inherit;text-decoration:none;font-size:13px;font-weight:500}a:first-child{background:#518cb04d}a:hover{background:#83c5ff25}a:focus-visible{outline:2px solid #83c5ff;outline-offset:4px}[data-theme=light] body{color:#21354b;background:radial-gradient(ellipse at 20% 15%,#cce1f199,transparent 55%),#edf2f7}[data-theme=light] main{background:linear-gradient(130deg,#ffffffcc,#f6faff94);border-color:#789bb333;box-shadow:inset 0 1px 0 #ffffffc9,0 24px 100px #26415c30}[data-theme=light] p{color:#566c82}[data-theme=light] .brand{color:#286b9f}[data-theme=light] a{border-color:#789bb366}[data-theme=light] a:first-child{background:#286b9f;color:white}@media(prefers-reduced-transparency:reduce){main{background:#182738;backdrop-filter:none}[data-theme=light] main{background:#f6faff}}
</style></head><body><main><div class="brand">Pl · Platform</div><h1>Адресная книга временно недоступна</h1><p>Не удалось подключиться к сервису. Попробуйте ещё раз немного позже или вернитесь на главную Платформы.</p><div class="actions"><a href="/directory/">Попробовать снова</a><a href="/">На главную</a></div></main></body></html>`
