package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pl/portal/internal/modules"
)

// Nginx receives this fixed target for an external connection. It never receives
// the remote endpoint or performs its DNS/TLS handling. This route is not exposed
// by the public Nginx locations, and also authenticates independently of Nginx.
const bookstackExternalPrefix = "/internal/proxy/bookstack"

// Keep one MiB for multipart framing around a native file of up to 100 MiB.
const bookstackNativeBodyLimit = 101 << 20

func (s *Server) bookstackExternalProxy(w http.ResponseWriter, r *http.Request) {
	if !s.Config.PortableRelease || s.Store == nil || s.Modules == nil {
		http.NotFound(w, r)
		return
	}
	// Authorization belongs to the native API only. It must neither authenticate
	// Pl nor cause the session reader to select the machine-token path.
	gateRequest := r.Clone(r.Context())
	gateRequest.Header.Del("Authorization")
	sess, err := s.readSession(gateRequest)
	if err != nil {
		problem(w, 401, "session_expired", "Войдите в Платформу")
		return
	}
	if !sess.User.Admin {
		problem(w, 403, "forbidden", "Доступ только для администратора")
		return
	}
	uri := r.URL.RequestURI()
	if !strings.HasPrefix(uri, bookstackExternalPrefix+"/") {
		problem(w, 403, "invalid_wiki_route", "Недопустимый маршрут Wiki")
		return
	}
	originalURI := "/wiki" + strings.TrimPrefix(uri, bookstackExternalPrefix)
	unsafe := r.Method != http.MethodGet && r.Method != http.MethodHead
	if !bookstackNativeRoute(r.Method, originalURI) || len(r.Header.Values("Origin")) > 1 || len(r.Header.Values("Authorization")) > 1 || len(r.Header.Values("Sec-Fetch-Site")) > 1 || len(r.Header.Values("Upgrade")) > 1 || r.Header.Get("Upgrade") != "" || (unsafe && r.Header.Get("Origin") == "") || !s.sameOrigin(r) {
		problem(w, 403, "invalid_wiki_request", "Запрос Wiki не прошёл проверку источника")
		return
	}
	cookies, valid := bookstackNativeCookies(r.Header.Values("Cookie"))
	if !valid {
		problem(w, 403, "invalid_wiki_cookies", "Недопустимые cookies Wiki")
		return
	}
	integration, instance, err := s.bookstackNativeSource(r)
	if err != nil || instance.Mode != "external" {
		problem(w, 503, "wiki_unavailable", "Внешняя Wiki отключена, недоступна или выбрана неоднозначно")
		return
	}
	client, err := s.Modules.BookStack.Client(integration, s.Config.PublicURL)
	if err != nil {
		problem(w, 503, "wiki_unavailable", modules.ErrBookStackConnection.Error())
		return
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.ContentLength > bookstackNativeBodyLimit {
		problem(w, http.StatusRequestEntityTooLarge, "wiki_upload_limit", "Файл превышает допустимый размер Wiki")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, bookstackNativeBodyLimit)
	public, _ := url.Parse(s.Config.PublicURL)
	nativeURI, _ := url.ParseRequestURI(originalURI)
	request, err := http.NewRequestWithContext(ctx, r.Method, integration.URL+strings.TrimPrefix(originalURI, "/wiki"), r.Body)
	if err != nil {
		problem(w, 503, "wiki_unavailable", modules.ErrBookStackConnection.Error())
		return
	}
	request.ContentLength, request.GetBody, request.Host = r.ContentLength, nil, public.Host
	if r.ContentLength == 0 {
		request.Body = http.NoBody
	}
	// Rebuild a finite native header set. Incoming forwarded, identity, routing
	// metadata and other service credentials cannot reach the external server.
	for _, name := range bookstackNativeRequestHeaders {
		if !bookstackConnectionHeader(r.Header, name) {
			request.Header[name] = append([]string(nil), r.Header.Values(name)...)
		}
	}
	request.Header.Set("Cookie", cookies)
	request.Header.Set("X-Forwarded-Host", public.Host)
	request.Header.Set("X-Forwarded-Proto", public.Scheme)
	// Do uses the bounded client timeout and does not forward interim response
	// headers. Redirects remain responses and never select another destination.
	response, err := client.Do(request)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			problem(w, http.StatusRequestEntityTooLarge, "wiki_upload_limit", "Файл превышает допустимый размер Wiki")
			return
		}
		problem(w, 503, "wiki_unavailable", modules.ErrBookStackConnection.Error())
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 599 || bookstackExternalResponse(response, public, nativeURI) != nil {
		problem(w, 503, "wiki_unavailable", modules.ErrBookStackConnection.Error())
		return
	}
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if _, err := io.Copy(w, response.Body); err != nil {
		// Headers may already be sent. Terminate a truncated download instead
		// of appending JSON to native bytes or falsely completing the response.
		panic(http.ErrAbortHandler)
	}
}

var bookstackNativeRequestHeaders = []string{
	"Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Content-Type", "Content-Encoding",
	"If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "Range", "If-Range",
	"Origin", "Referer", "User-Agent", "X-Csrf-Token", "X-Xsrf-Token", "X-Requested-With",
}

func bookstackConnectionHeader(headers http.Header, name string) bool {
	for _, line := range headers.Values("Connection") {
		for _, field := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(field), name) {
				return true
			}
		}
	}
	return false
}

// Native cookies and redirects must already use APP_URL=<Pl origin>/wiki.
// Rewriting a misconfigured remote host would hide a broken BookStack contract.
func bookstackExternalResponse(response *http.Response, public, nativeURI *url.URL) error {
	if values := response.Header.Values("Location"); len(values) > 1 {
		return modules.ErrBookStackConnection
	} else if len(values) == 1 {
		location, err := url.Parse(values[0])
		if err != nil {
			return modules.ErrBookStackConnection
		}
		base := *public
		base.Path, base.RawPath, base.RawQuery = nativeURI.Path, nativeURI.RawPath, nativeURI.RawQuery
		resolved := base.ResolveReference(location)
		path := resolved.EscapedPath()
		if path == "/wiki" {
			path += "/"
		}
		if resolved.RawQuery != "" {
			path += "?" + resolved.RawQuery
		}
		if resolved.Scheme != public.Scheme || resolved.Host != public.Host || resolved.User != nil || !bookstackNativeRoute(http.MethodGet, path) {
			return modules.ErrBookStackConnection
		}
	}
	filtered := http.Header{}
	for _, name := range []string{"Content-Type", "Content-Disposition", "Content-Language", "Content-Encoding", "Content-Length", "Etag", "Last-Modified", "Cache-Control", "Expires", "Vary", "Accept-Ranges", "Content-Range", "Location", "Content-Security-Policy", "Referrer-Policy", "X-Frame-Options", "X-Content-Type-Options"} {
		filtered[name] = append([]string(nil), response.Header.Values(name)...)
	}
	for _, line := range response.Header.Values("Set-Cookie") {
		cookie, err := http.ParseSetCookie(line)
		if err != nil {
			return modules.ErrBookStackConnection
		}
		if cookie.Name == "portal_session" {
			continue
		}
		if (cookie.Path != "/wiki" && !strings.HasPrefix(cookie.Path, "/wiki/")) || (cookie.Domain != "" && !strings.EqualFold(strings.TrimPrefix(cookie.Domain, "."), public.Hostname())) {
			return modules.ErrBookStackConnection
		}
		cookie.Domain = ""
		filtered.Add("Set-Cookie", cookie.String())
	}
	response.Header = filtered
	response.Trailer = nil
	return nil
}
