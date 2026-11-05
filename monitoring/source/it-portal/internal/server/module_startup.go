package server

import (
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"unicode"

	"pl/portal/internal/model"
)

// The gateway selects this page only after authorization and document-route
// validation. API, assets, authentication failures and ready apps keep their
// normal handlers. A startup page is a real 503, never an application health signal.
type moduleStartupStage string

const (
	moduleStartupQueued     moduleStartupStage = "queued"
	moduleStartupInstalling moduleStartupStage = "installing"
	moduleStartupStarting   moduleStartupStage = "starting"
	moduleStartupFailed     moduleStartupStage = "failed"
)

const moduleStartupCSS = `html,body{margin:0;min-height:100%;}body{color:var(--pl-ui-text,CanvasText);background:var(--pl-ui-bg,Canvas);font:400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}*{box-sizing:border-box}.module-startup{min-height:100vh;display:flex;flex-direction:column}.module-startup-header{padding:28px 40px;border-bottom:1px solid var(--pl-ui-border);background:var(--pl-ui-surface)}.module-startup-header a{color:inherit;text-decoration:none}.module-startup-header strong{font-size:22px;letter-spacing:-.4px}.module-startup-header span{margin-left:12px;font-size:11px;letter-spacing:2px;color:var(--pl-ui-muted)}.module-startup-main{flex:1;display:grid;place-items:center;padding:48px 24px}.module-startup-card{width:min(100%,620px);padding:40px;border:1px solid var(--pl-ui-border);border-radius:20px;background:var(--pl-ui-surface);box-shadow:0 16px 56px #0001}.module-startup-label{margin:0 0 16px;color:var(--pl-ui-muted);font-size:13px;overflow-wrap:anywhere}.module-startup-card h1{margin:0 0 14px;font-size:30px;line-height:1.2;font-weight:600;letter-spacing:-.6px}.module-startup-copy{margin:0;color:var(--pl-ui-muted)}.module-startup-status{display:flex;align-items:center;gap:10px;margin:28px 0;color:var(--pl-ui-muted);font-size:13px}.module-startup-spinner{width:16px;height:16px;flex:none;border:2px solid var(--pl-ui-border);border-top-color:var(--pl-ui-accent);border-radius:50%;animation:module-startup-spin 1s linear infinite}.module-startup-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.module-startup-actions a{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 16px;border:1px solid var(--pl-ui-border);border-radius:10px;color:var(--pl-ui-text);background:var(--pl-ui-hover);text-decoration:none;font-size:13px;font-weight:500}.module-startup-actions a:hover{background:var(--pl-ui-raised)}.module-startup-actions a:focus-visible{outline:2px solid var(--pl-ui-focus);outline-offset:3px}@keyframes module-startup-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.module-startup-spinner{animation:none}}@media(max-width:600px){.module-startup-header{padding:20px 24px}.module-startup-card{padding:28px}.module-startup-card h1{font-size:26px}}`

// Trusted, fixed code only: no instance, error or request text enters JavaScript.
// Reload preserves the current URL and the gateway rechecks its cheap stored state.
const moduleStartupReloadJS = `window.setTimeout(function(){window.location.reload();},2000);`

var moduleStartupTemplate = template.Must(template.New("module-startup").Parse(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{.Name}} · PL</title>
<script src="/ecosystem/theme-catalog.js"></script><script src="/ecosystem/theme-runtime.js"></script>
<link rel="stylesheet" href="/ecosystem/ui-v1.css"><link rel="stylesheet" href="/ecosystem/theme-menu.css">
<style>` + moduleStartupCSS + `</style></head><body><div class="module-startup">
<header class="module-startup-header"><a href="/" aria-label="Платформа"><strong>PL</strong><span>PLATFORM</span></a></header>
<main class="module-startup-main"><section class="module-startup-card" aria-labelledby="module-startup-title">
<p class="module-startup-label">{{.Name}}</p><h1 id="module-startup-title">{{.Title}}</h1><p class="module-startup-copy">{{.Description}}</p>
{{if .Automatic}}<p class="module-startup-status" role="status"><span class="module-startup-spinner" aria-hidden="true"></span>Проверяем готовность каждые 2 секунды</p>{{end}}
<nav class="module-startup-actions" aria-label="Действия"><a href="{{.RetryURL}}">Проверить сейчас</a><a href="/#modules">К модулям</a></nav>
</section></main></div>{{if .Automatic}}<script>` + moduleStartupReloadJS + `</script>{{end}}</body></html>`))

func moduleStartupHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

// Keep a manual retry on this origin. The automatic retry never interpolates a
// URL; this validation also makes the renderer safe for isolated callers/tests.
func moduleStartupRetryURL(r *http.Request) string {
	if r.URL == nil {
		return "/#modules"
	}
	path := r.URL.EscapedPath()
	decoded, err := url.PathUnescape(path)
	if err != nil || !strings.HasPrefix(decoded, "/") || strings.HasPrefix(decoded, "//") || strings.Contains(decoded, "\\") || strings.IndexFunc(decoded, unicode.IsControl) >= 0 {
		return "/#modules"
	}
	return (&url.URL{Path: decoded, RawQuery: r.URL.RawQuery}).RequestURI()
}

func renderModuleStartupPage(w http.ResponseWriter, r *http.Request, instance model.ModuleInstance, stage moduleStartupStage) {
	name := strings.TrimSpace(instance.Name)
	if name == "" {
		name = "Модуль"
	}
	data := struct {
		Name, Title, Description, RetryURL string
		Automatic                          bool
	}{Name: name, RetryURL: moduleStartupRetryURL(r)}
	switch stage {
	case moduleStartupQueued:
		data.Title = "Модуль ожидает запуска"
		data.Description = "Задание принято и ожидает выполнения. Приложение откроется автоматически, когда будет готово."
		data.Automatic = true
	case moduleStartupInstalling:
		data.Title = "Устанавливаем модуль"
		data.Description = "Установка ещё не завершена. Приложение откроется автоматически, когда будет готово."
		data.Automatic = true
	case moduleStartupStarting:
		data.Title = "Модуль запускается"
		data.Description = "Ожидаем готовности приложения. Как только оно запустится, эта страница откроет его автоматически."
		data.Automatic = true
	default:
		data.Title = "Не удалось запустить модуль"
		data.Description = "Проверьте состояние модуля в Платформе. После устранения ошибки вернитесь сюда или проверьте готовность ещё раз."
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	scriptPolicy := "script-src 'self'"
	if data.Automatic {
		h.Set("Retry-After", "2")
		scriptPolicy += " " + moduleStartupHash(moduleStartupReloadJS)
	} else {
		h.Del("Retry-After")
	}
	h.Set("Content-Security-Policy", "default-src 'none'; "+scriptPolicy+"; style-src 'self' "+moduleStartupHash(moduleStartupCSS)+"; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'")
	w.WriteHeader(http.StatusServiceUnavailable)
	if r.Method != http.MethodHead {
		_ = moduleStartupTemplate.Execute(w, data)
	}
}
