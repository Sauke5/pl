package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

const sftpAdminPrefix = "/sftp-adm"
const sftpAdminMaxUpload = int64(1 << 30)
const sftpAdminMaxSessions = 1000

var sftpAdminObjectName = regexp.MustCompile(`^[\p{L}\p{N}_.@~ -]{1,200}$`)
var sftpAdminAssetPath = regexp.MustCompile(`^/sftp-adm/static/[A-Za-z0-9_./@+~-]+$`)
var sftpAdminPermissions = []string{"add_users", "edit_users", "del_users", "view_users", "manage_groups", "manage_folders", "quota_scans", "view_status", "view_conns", "close_conns", "view_defender"}

type sftpAdminPending struct {
	Mode    string
	Expires time.Time
}
type sftpAdminBrowser struct {
	Expires time.Time
	Jars    map[string]*cookiejar.Jar
	Pending map[string]sftpAdminPending
}

// The native cookies never leave the backend. Both the Portal session and the
// view are part of their namespace; another Portal login cannot reuse them.
type sftpAdminGateway struct {
	server      *Server
	cfg         SFTPAdminConfig
	issuer      *sftpAdminOIDC
	upstream    *url.URL
	client      *http.Client
	mu          sync.Mutex
	provisionMu sync.Mutex
	browsers    map[string]*sftpAdminBrowser
	readSession func(*http.Request) (session, error)
	beginFlow   func(http.ResponseWriter, *http.Request, string, string) error
}

func newSFTPAdminGateway(s *Server, c SFTPAdminConfig, issuer *sftpAdminOIDC) (*sftpAdminGateway, error) {
	u, e := url.Parse(c.UpstreamURL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("invalid SFTP administration HTTPS upstream")
	}
	if c.CAFile == "" || c.AdminKeyFile == "" || !path.IsAbs(c.DataRoot) || path.Clean(c.DataRoot) != c.DataRoot || c.DataRoot == "/" {
		return nil, errors.New("invalid SFTP administration storage or credentials")
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	pem, e := os.ReadFile(c.CAFile)
	if e != nil || !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("invalid SFTP administration CA")
	}
	if _, e = sftpAdminReadKey(c.AdminKeyFile); e != nil {
		return nil, e
	}
	guard, e := sftpAdminGuard(&c)
	if e != nil {
		return nil, e
	}
	tr := &http.Transport{Proxy: nil, DialContext: guard.DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxIdleConnsPerHost: 8, MaxConnsPerHost: 24}
	g := &sftpAdminGateway{server: s, cfg: c, issuer: issuer, upstream: u, client: &http.Client{Transport: tr, Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, browsers: make(map[string]*sftpAdminBrowser), readSession: s.readSession}
	if issuer != nil {
		g.beginFlow = issuer.beginFlow
	}
	return g, nil
}

func sftpAdminReadKey(filename string) (string, error) {
	f, e := os.Open(filename)
	if e != nil {
		return "", errors.New("SFTP administration credential unavailable")
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0007 != 0 || info.Mode().Perm()&0020 != 0 {
		return "", errors.New("insecure SFTP administration credential file")
	}
	b, e := io.ReadAll(io.LimitReader(f, 4097))
	k := strings.TrimSpace(string(b))
	if e != nil || len(b) > 4096 || len(k) < 32 || strings.ContainsAny(k, "\r\n\x00") {
		return "", errors.New("invalid SFTP administration credential")
	}
	return k, nil
}

func (g *sftpAdminGateway) registerRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/sftp-adm", g.capabilities)
	m.HandleFunc("/sftp-adm/open/", g.open)
	m.HandleFunc("/sftp-adm/web/", g.proxy)
	m.HandleFunc("/sftp-adm/static/", g.proxy)
}

func (g *sftpAdminGateway) authenticated(w http.ResponseWriter, r *http.Request) (session, bool) {
	v, e := g.readSession(r)
	if e != nil || v.User.ID == "" || v.CSRF == "" || !v.ExpiresAt.After(time.Now()) {
		problem(w, 401, "session_expired", "Войдите в Платформу")
		return session{}, false
	}
	return v, true
}
func (g *sftpAdminGateway) capabilities(w http.ResponseWriter, r *http.Request) {
	v, ok := g.authenticated(w, r)
	if !ok {
		return
	}
	respond(w, 200, map[string]any{"configured": true, "can_admin": v.User.Admin, "can_access_files": true, "native_username": sftpAdminNativeUsername(v.User.ID), "files_reason": "Общие папки доступны по назначенным правам"})
}
func (g *sftpAdminGateway) open(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.NotFound(w, r)
		return
	}
	mode := strings.TrimPrefix(r.URL.Path, "/sftp-adm/open/")
	if mode != "admin" && mode != "files" {
		http.NotFound(w, r)
		return
	}
	v, ok := g.authenticated(w, r)
	if !ok {
		return
	}
	if mode == "admin" && !v.User.Admin {
		problem(w, 403, "forbidden", "Недостаточно прав для администрирования")
		return
	}
	g.launch(w, r, v, mode)
}
func (g *sftpAdminGateway) launch(w http.ResponseWriter, r *http.Request, v session, mode string) {
	if !g.server.sameOrigin(r) {
		problem(w, 403, "csrf", "Недопустимый источник входа")
		return
	}
	if g.beginFlow == nil {
		problem(w, 503, "sftp_unavailable", "Вход SFTP временно недоступен")
		return
	}
	if e := g.ensureIdentity(r.Context(), v, mode); e != nil {
		problem(w, 503, "sftp_identity_unavailable", "Не удалось открыть учётную запись SFTP")
		return
	}
	if e := g.beginFlow(w, r, mode, sftpAdminNativeUsername(v.User.ID)); e != nil {
		problem(w, 503, "sftp_auth_unavailable", "Не удалось начать вход SFTP")
		return
	}
	if g.server.Store != nil {
		if err := g.server.Store.Event(r.Context(), "sftp_adm.open", "Открытие SFTP", "", v.User.ID, map[string]any{"mode": mode, "native_username": sftpAdminNativeUsername(v.User.ID)}, true); err != nil {
			problem(w, 503, "sftp_audit_unavailable", "Не удалось записать вход SFTP")
			return
		}
	}
	view := "client"
	if mode == "admin" {
		view = "admin"
	}
	target := sftpAdminPrefix + "/web/" + view + "/oidclogin"
	cloned := r.Clone(r.Context())
	u := *r.URL
	u.Path = target
	u.RawPath = ""
	u.RawQuery = ""
	cloned.URL = &u
	g.forward(w, cloned, v, mode, true)
}
func sftpAdminSessionKey(r *http.Request, v session) string {
	// CSRF is random per login and immutable; bind token hash too when present.
	token := ""
	if c, e := r.Cookie("portal_session"); e == nil {
		token = c.Value
	}
	sum := sha256.Sum256([]byte(v.User.ID + "\x00" + v.CSRF + "\x00" + token))
	return hex.EncodeToString(sum[:])
}
func (g *sftpAdminGateway) browser(r *http.Request, v session) (*sftpAdminBrowser, error) {
	key := sftpAdminSessionKey(r, v)
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	for k, b := range g.browsers {
		if !b.Expires.After(now) {
			delete(g.browsers, k)
		}
	}
	if b, ok := g.browsers[key]; ok {
		return b, nil
	}
	if len(g.browsers) >= sftpAdminMaxSessions {
		return nil, errors.New("SFTP session capacity reached")
	}
	a, _ := cookiejar.New(nil)
	b, _ := cookiejar.New(nil)
	entry := &sftpAdminBrowser{Expires: v.ExpiresAt, Jars: map[string]*cookiejar.Jar{"admin": a, "files": b}, Pending: map[string]sftpAdminPending{}}
	g.browsers[key] = entry
	return entry, nil
}

// Finite native UI routes; no native REST API, local login, reset, import,
// administrator-management, hooks, shares or arbitrary proxy routes.
func sftpAdminRoute(method, p string) (mode string, allowed bool) {
	if path.Clean(p) != p || strings.Contains(p, "//") || strings.ContainsAny(p, "\\%") || len(p) > 2048 {
		return "", false
	}
	read := method == "GET" || method == "HEAD"
	if sftpAdminAssetPath.MatchString(p) {
		return "", read
	}
	if p == "/sftp-adm/web/oidc/redirect" {
		return "callback", method == "GET"
	}
	for _, view := range []struct{ path, mode string }{{"admin", "admin"}, {"client", "files"}} {
		base := "/sftp-adm/web/" + view.path
		if p == base {
			return view.mode, read
		}
		if !strings.HasPrefix(p, base+"/") {
			continue
		}
		tail := strings.TrimPrefix(p, base+"/")
		if tail == "login" || tail == "oidclogin" || tail == "logout" {
			return view.mode, read
		}
		if view.mode == "files" {
			if read {
				switch tail {
				case "files", "dirs", "file", "ping", "editfile", "viewpdf", "getpdf":
					return view.mode, true
				}
			}
			if method == "POST" {
				switch tail {
				case "file", "exist", "dirs", "downloadzip", "file-actions/move", "file-actions/copy":
					return view.mode, true
				}
			}
			if method == "DELETE" && (tail == "files" || tail == "dirs") {
				return view.mode, true
			}
			if read && strings.HasPrefix(tail, "tasks/") && sftpAdminObjectName.MatchString(strings.TrimPrefix(tail, "tasks/")) {
				return view.mode, true
			}
			return "", false
		}
		if read {
			switch tail {
			case "users", "users/json", "groups", "groups/json", "folders", "folders/json", "connections", "connections/json", "status", "events", "events/fs", "events/provider", "events/logs", "defender", "defender/hosts", "user", "group", "folder":
				return view.mode, true
			}
		}
		if method == "POST" && (tail == "user" || tail == "group" || tail == "folder") {
			return view.mode, true
		}
		parts := strings.Split(tail, "/")
		if len(parts) == 2 && sftpAdminObjectName.MatchString(parts[1]) {
			if parts[0] == "user" || parts[0] == "group" || parts[0] == "folder" {
				return view.mode, read || method == "POST" || method == "DELETE"
			}
			if parts[0] == "connections" {
				return view.mode, method == "DELETE"
			}
		}
		if len(parts) == 3 && parts[0] == "quotas" && (parts[1] == "scanfolder" || parts[1] == "scanuser") && sftpAdminObjectName.MatchString(parts[2]) {
			return view.mode, method == "POST"
		}
		return "", false
	}
	return "", false
}

func (g *sftpAdminGateway) proxy(w http.ResponseWriter, r *http.Request) {
	mode, allowed := sftpAdminRoute(r.Method, r.URL.Path)
	if !allowed || !sftpAdminEscapedPath(r.URL) || len(r.URL.RawQuery) > 16384 {
		http.NotFound(w, r)
		return
	}
	v, ok := g.authenticated(w, r)
	if !ok {
		return
	}
	if mode == "admin" && !v.User.Admin {
		problem(w, 403, "forbidden", "Недостаточно прав для администрирования")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && !g.server.gatewayOrigin(r) {
		problem(w, 403, "csrf", "Недопустимый источник запроса")
		return
	}
	if mode == "admin" && r.Method == "POST" && sftpAdminStorageMutation(r.URL.Path) {
		if err := g.validateStorageForm(r); err != nil {
			problem(w, 403, "sftp_storage_boundary", "Каталоги должны находиться внутри файлового хранилища SFTP. Доступны локальные папки.")
			return
		}
	}
	if strings.HasSuffix(r.URL.Path, "/logout") {
		b, e := g.browser(r, v)
		if e != nil {
			problem(w, 503, "sftp_capacity", "SFTP временно недоступен")
			return
		}
		g.mu.Lock()
		jar, _ := cookiejar.New(nil)
		b.Jars[mode] = jar
		g.mu.Unlock()
		http.Redirect(w, r, "/sftp-adm", http.StatusSeeOther)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/login") || strings.HasSuffix(r.URL.Path, "/oidclogin") {
		g.launch(w, r, v, mode)
		return
	}
	auditOperation := r.Method != "GET" && r.Method != "HEAD" || r.Method == "GET" && (r.URL.Path == "/sftp-adm/web/client/file" || r.URL.Path == "/sftp-adm/web/client/getpdf")
	if auditOperation && g.server.Store != nil {
		if err := g.server.Store.Event(r.Context(), "sftp_adm.operation", "Операция SFTP", "", v.User.ID, map[string]any{"method": r.Method, "path": r.URL.Path, "mode": mode}, true); err != nil {
			problem(w, 503, "sftp_audit_unavailable", "Не удалось записать операцию SFTP")
			return
		}
	}
	recorder := &sftpAdminResponseWriter{ResponseWriter: w}
	g.forward(recorder, r, v, mode, false)
	if auditOperation && g.server.Store != nil {
		if err := g.server.Store.Event(r.Context(), "sftp_adm.operation_result", "Результат операции SFTP", "", v.User.ID, map[string]any{"method": r.Method, "path": r.URL.Path, "mode": mode, "status": recorder.status}, true); err != nil {
			slog.Error("sftp_adm_audit_result_failed", "actor", v.User.ID, "error_type", fmt.Sprintf("%T", err))
		}
	}
}

type sftpAdminResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *sftpAdminResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *sftpAdminResponseWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.ResponseWriter.Write(b)
}
func (w *sftpAdminResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (g *sftpAdminGateway) forward(w http.ResponseWriter, r *http.Request, v session, mode string, login bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	r = r.WithContext(ctx)
	b, e := g.browser(r, v)
	if e != nil {
		problem(w, 503, "sftp_capacity", "SFTP временно недоступен")
		return
	}
	if mode == "callback" {
		state := r.URL.Query().Get("state")
		g.mu.Lock()
		pending, ok := b.Pending[state]
		delete(b.Pending, state)
		g.mu.Unlock()
		if !ok || !pending.Expires.After(time.Now()) || (pending.Mode == "admin" && !v.User.Admin) {
			problem(w, 403, "sftp_flow_invalid", "Вход SFTP устарел. Откройте раздел заново.")
			return
		}
		mode = pending.Mode
	}
	g.mu.Lock()
	jar := b.Jars[mode]
	g.mu.Unlock()
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(10 * time.Minute))
	_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, sftpAdminMaxUpload)
	public, _ := url.Parse(g.server.Config.PublicURL)
	target := *g.upstream
	target.Path = r.URL.Path
	target.RawPath = ""
	target.RawQuery = r.URL.RawQuery
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(g.upstream)
			pr.Out.URL.Path = target.Path
			pr.Out.URL.RawPath = ""
			pr.Out.URL.RawQuery = target.RawQuery
			for name := range pr.Out.Header {
				low := strings.ToLower(name)
				if low == "cookie" || low == "authorization" || low == "proxy-authorization" || low == "forwarded" || strings.HasPrefix(low, "x-forwarded-") || strings.HasPrefix(low, "x-pl-") || strings.HasPrefix(low, "x-auth-") || strings.HasPrefix(low, "remote-") || strings.HasPrefix(low, "x-sftpgo-") {
					pr.Out.Header.Del(name)
				}
			}
			if jar != nil {
				for _, c := range jar.Cookies(&target) {
					pr.Out.AddCookie(c)
				}
			}
			pr.Out.Host = g.upstream.Host
			pr.Out.Header.Set("X-Forwarded-Host", public.Host)
			pr.Out.Header.Set("X-Forwarded-Proto", public.Scheme)
			ip, _, err := net.SplitHostPort(pr.In.RemoteAddr)
			if err != nil {
				ip = pr.In.RemoteAddr
			}
			if net.ParseIP(ip) != nil {
				pr.Out.Header.Set("X-Forwarded-For", ip)
			}
		},
		Transport:     g.client.Transport,
		FlushInterval: -1,
		ModifyResponse: func(resp *http.Response) error {
			cookies := resp.Cookies()
			resp.Header.Del("Set-Cookie")
			if len(cookies) > 16 {
				return errors.New("too many native cookies")
			}
			if jar != nil {
				jar.SetCookies(&target, cookies)
			}
			resp.Header.Set("Cache-Control", "no-store")
			resp.Header.Set("X-Content-Type-Options", "nosniff")
			resp.Header.Set("Referrer-Policy", "no-referrer")
			// Uploaded content is never executable on the Platform origin.
			if r.URL.Path == "/sftp-adm/web/client/file" || r.URL.Path == "/sftp-adm/web/client/getpdf" {
				if !strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Disposition")), "attachment") {
					resp.Header.Set("Content-Disposition", "attachment")
				}
				resp.Header.Set("Content-Security-Policy", "sandbox; default-src 'none'")
			}
			if loc := resp.Header.Get("Location"); loc != "" {
				normalized, u, e := g.safeLocation(loc)
				if e != nil {
					return e
				}
				resp.Header.Set("Location", normalized)
				if u.Path == "/auth/sftp-adm/oidc/authorize" {
					if !login || (mode != "admin" && mode != "files") {
						return errors.New("unexpected native authorization redirect")
					}
					state := u.Query().Get("state")
					if len(state) < 16 || len(state) > 512 {
						return errors.New("invalid native authorization state")
					}
					g.mu.Lock()
					defer g.mu.Unlock()
					now := time.Now()
					for k, p := range b.Pending {
						if !p.Expires.After(now) {
							delete(b.Pending, k)
						}
					}
					if len(b.Pending) >= 8 {
						return errors.New("too many native authorization requests")
					}
					b.Pending[state] = sftpAdminPending{Mode: mode, Expires: now.Add(time.Minute)}
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) {
			problem(w, 502, "sftp_upstream_unavailable", "SFTP временно недоступен")
		},
	}
	proxy.ServeHTTP(w, r)
}
func (g *sftpAdminGateway) safeLocation(location string) (string, *url.URL, error) {
	u, e := url.Parse(location)
	if e != nil || u.User != nil || u.Fragment != "" || len(location) > 16384 {
		return "", nil, errors.New("invalid native redirect")
	}
	pub, _ := url.Parse(g.server.Config.PublicURL)
	if u.IsAbs() {
		if u.Scheme+"://"+u.Host != pub.Scheme+"://"+pub.Host {
			return "", nil, errors.New("external native redirect")
		}
	} else if u.Host != "" || !strings.HasPrefix(u.Path, "/") {
		return "", nil, errors.New("invalid relative native redirect")
	}
	if u.Path != "/auth/sftp-adm/oidc/authorize" {
		if _, ok := sftpAdminRoute("GET", u.Path); !ok {
			return "", nil, errors.New("native redirect outside UI")
		}
	}
	u.Scheme = ""
	u.Host = ""
	return u.String(), u, nil
}

func (g *sftpAdminGateway) nativeJSON(ctx context.Context, method, endpoint string, input, output any) error {
	if !strings.HasPrefix(endpoint, "/api/v2/") {
		return errors.New("invalid native API endpoint")
	}
	var body io.Reader
	if input != nil {
		b, e := json.Marshal(input)
		if e != nil {
			return e
		}
		body = bytes.NewReader(b)
	}
	u := *g.upstream
	u.Path = endpoint
	req, e := http.NewRequestWithContext(ctx, method, u.String(), body)
	if e != nil {
		return e
	}
	key, e := sftpAdminReadKey(g.cfg.AdminKeyFile)
	if e != nil {
		return e
	}
	req.Header.Set("X-SFTPGO-API-KEY", key)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, e := g.client.Do(req)
	if e != nil {
		return errors.New("native API unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		return os.ErrNotExist
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return errors.New("native API request rejected")
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(output)
	}
	_, e = io.Copy(io.Discard, io.LimitReader(response.Body, 2<<20))
	return e
}

type sftpAdminIdentity struct {
	Username       string         `json:"username"`
	Status         int            `json:"status"`
	Description    string         `json:"description"`
	AdditionalInfo string         `json:"additional_info"`
	HomeDir        string         `json:"home_dir"`
	Permissions    any            `json:"permissions"`
	QuotaSize      int64          `json:"quota_size"`
	Password       string         `json:"password,omitempty"`
	Filters        map[string]any `json:"filters"`
	Filesystem     map[string]any `json:"filesystem,omitempty"`
}

func (g *sftpAdminGateway) ensureIdentity(ctx context.Context, v session, mode string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if mode != "admin" && mode != "files" || mode == "admin" && !v.User.Admin {
		return errors.New("invalid native identity role")
	}
	g.provisionMu.Lock()
	defer g.provisionMu.Unlock()
	name := sftpAdminNativeUsername(v.User.ID)
	marker := "pl:sftp-adm:" + strings.TrimPrefix(name, "pl-")
	kind := "users"
	if mode == "admin" {
		kind = "admins"
	}
	endpoint := "/api/v2/" + kind + "/" + name
	var got sftpAdminIdentity
	e := g.nativeJSON(ctx, "GET", endpoint, nil, &got)
	if e == nil {
		return sftpAdminIdentityMatches(got, name, marker, mode)
	}
	if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	secret := make([]byte, 48)
	if _, e = rand.Read(secret); e != nil {
		return e
	}
	want := sftpAdminIdentity{Username: name, Status: 1, Description: v.User.Name, AdditionalInfo: marker, Password: base64.RawURLEncoding.EncodeToString(secret)}
	if mode == "admin" {
		want.Permissions = sftpAdminPermissions
		want.Filters = map[string]any{"allow_api_key_auth": false}
	} else {
		want.HomeDir = path.Join(g.cfg.DataRoot, "users", name)
		want.QuotaSize = 10 << 30
		perms := []string{"list", "download"}
		if v.User.Admin {
			perms = []string{"list", "download", "upload", "overwrite", "create_dirs", "rename", "delete"}
		}
		want.Permissions = map[string][]string{"/": perms}
		want.Filesystem = map[string]any{"provider": 0}
		want.Filters = map[string]any{"allow_api_key_auth": false, "denied_protocols": []string{"SSH", "FTP", "DAV"}, "web_client": []string{"publickey-change-disabled", "password-change-disabled", "api-key-auth-change-disabled", "mfa-disabled", "shares-disabled"}}
	}
	createErr := g.nativeJSON(ctx, "POST", "/api/v2/"+kind, want, nil)
	// A timed-out POST may have succeeded. Read back exactly once; never retry it.
	got = sftpAdminIdentity{}
	if e = g.nativeJSON(ctx, "GET", endpoint, nil, &got); e != nil {
		if createErr != nil {
			return createErr
		}
		return e
	}
	return sftpAdminIdentityMatches(got, name, marker, mode)
}
func sftpAdminIdentityMatches(got sftpAdminIdentity, name, marker, mode string) error {
	identityMarker := got.AdditionalInfo
	if got.Username != name || got.Status != 1 || identityMarker != marker {
		return fmt.Errorf("native %s identity conflict", mode)
	}
	return nil
}

// Native admins administer data, not the service's readable TLS/SSO secrets.
// These are the exact scalar fields read by SFTPGo 2.7.6 webadmin.go for
// users, groups and virtual folders. Raw multipart bytes are forwarded intact.
func sftpAdminStorageMutation(p string) bool {
	for _, object := range []string{"user", "group", "folder"} {
		base := "/sftp-adm/web/admin/" + object
		if p == base || strings.HasPrefix(p, base+"/") {
			return true
		}
	}
	return false
}
func (g *sftpAdminGateway) storagePath(value string, empty bool) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return empty
	}
	if !path.IsAbs(value) || path.Clean(value) != value || strings.ContainsAny(value, "\\%\x00\r\n") {
		return false
	}
	return value == g.cfg.DataRoot || strings.HasPrefix(value, g.cfg.DataRoot+"/")
}
func (g *sftpAdminGateway) validateStorageForm(r *http.Request) error {
	const limit = 2 << 20
	media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || media != "multipart/form-data" {
		return errors.New("native multipart form required")
	}
	body, e := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if e != nil || len(body) > limit {
		return errors.New("native administrative form too large")
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	clone := r.Clone(r.Context())
	clone.Body = io.NopCloser(bytes.NewReader(body))
	if e = clone.ParseMultipartForm(limit); e != nil {
		return errors.New("invalid native administrative form")
	}
	defer clone.MultipartForm.RemoveAll()
	values := clone.PostForm
	query, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return errors.New("invalid administrative query")
	}
	for _, key := range []string{"fs_provider", "home_dir", "mapped_path"} {
		if len(values[key]) > 1 || len(query[key]) != 0 {
			return errors.New("ambiguous native storage field")
		}
	}
	// Remote/HTTP backends would also permit outbound requests to arbitrary
	// internal services. This instance is the requested local file server.
	if provider := strings.TrimSpace(values.Get("fs_provider")); provider != "" && provider != "0" {
		return errors.New("nonlocal filesystem unavailable")
	}
	if r.URL.Path == "/sftp-adm/web/admin/folder" || strings.HasPrefix(r.URL.Path, "/sftp-adm/web/admin/folder/") {
		if !g.storagePath(values.Get("mapped_path"), false) {
			return errors.New("folder escapes storage")
		}
	} else if !g.storagePath(values.Get("home_dir"), true) {
		return errors.New("home escapes storage")
	}
	return nil
}

// Decode once through net/url, then constrain the decoded native route. UTF-8
// object names are valid; encoded separators, controls and double escapes are not.
func sftpAdminEscapedPath(u *url.URL) bool {
	escaped := strings.ToLower(u.EscapedPath())
	if strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") || strings.Contains(escaped, "%25") {
		return false
	}
	for _, r := range u.Path {
		if r < 32 || r == 127 {
			return false
		}
	}
	if u.RawPath != "" {
		decoded, e := url.PathUnescape(u.RawPath)
		if e != nil || decoded != u.Path {
			return false
		}
	}
	return true
}
