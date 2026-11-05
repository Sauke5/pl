package server

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// legacyProxyRoute is only a gate for two fixed nginx upstreams. It does not
// implement a user assertion or grant access to any other portal operation.
func legacyProxyRoute(method, originalURI string) bool {
	if !gatewayString(originalURI, 4096, true) || !strings.HasPrefix(originalURI, "/") || strings.HasPrefix(originalURI, "//") {
		return false
	}
	u, err := url.ParseRequestURI(originalURI)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || u.RawPath != "" || strings.ContainsAny(u.Path, "\\%") || strings.Contains(u.Path, "//") {
		return false
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	if strings.HasPrefix(u.Path, "/netmap/") {
		path := strings.TrimPrefix(u.Path, "/netmap")
		if method == "HEAD" {
			return legacyNetmapSite.MatchString(path)
		}
		return method == "GET" && legacyNetmapPath(path)
	}
	if strings.HasPrefix(u.Path, "/audit/") {
		path := strings.TrimPrefix(u.Path, "/audit")
		read := method == "GET" || method == "HEAD"
		if read {
			switch path {
			case "/", "/health", "/favicon.svg", "/api/dashboard", "/api/departments", "/api/intelligence/overview", "/api/scans/current", "/api/scans/latest", "/api/scans", "/hubs/scan-progress":
				return true
			}
			return legacyAuditPath.MatchString(path) || legacyAuditAsset.MatchString(path)
		}
		if method == "POST" {
			return path == "/api/scans" || path == "/hubs/scan-progress/negotiate" || path == "/hubs/scan-progress"
		}
		if method == "OPTIONS" {
			return path == "/api/scans" || path == "/hubs/scan-progress/negotiate" || path == "/hubs/scan-progress"
		}
	}

	return false
}

var legacyAuditPath = regexp.MustCompile(`^/(departments/[0-9]+|api/departments/[0-9]+|api/intelligence/departments/[0-9]+(/simulate)?)$`)
var legacyAuditAsset = regexp.MustCompile(`^/assets/[A-Za-z0-9_./-]+$`)
var legacyNetmapSite = regexp.MustCompile(`^/api/sites/[a-z][a-z0-9-]{0,63}$`)

func legacyNetmapPath(path string) bool {
	switch path {
	case "/", "/index.html", "/app.js", "/style.css", "/theme-init.js", "/office-view.js", "/api/topology", "/api/health", "/api/wan", "/api/wan/health":
		return true
	default:
		return legacyNetmapSite.MatchString(path)
	}
}

// Nginx must overwrite X-Original-* in its internal auth_request location. The
// original browser credentials terminate here and must never reach legacy apps.
// Calling this endpoint directly still requires a live administrator session;
// its empty response is not a reusable credential and contains no upstream URL.
func (s *Server) legacyProxyAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sess, err := s.readSession(r)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if !sess.User.Admin {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	for _, name := range []string{"X-Original-Method", "X-Original-URI", "X-Original-Upgrade"} {
		if len(r.Header.Values(name)) > 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
	}
	method, uri := r.Header.Get("X-Original-Method"), r.Header.Get("X-Original-URI")
	if !legacyProxyRoute(method, uri) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	upgrade := r.Header.Get("X-Original-Upgrade")
	if upgrade != "" && (!strings.EqualFold(upgrade, "websocket") || method != "GET" || !strings.HasPrefix(uri, "/audit/hubs/scan-progress") || !s.gatewayOrigin(r)) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if method == "POST" {
		tokens := r.Header.Values("X-CSRF-Token")
		if len(tokens) != 1 || sess.CSRF == "" || !s.gatewayOrigin(r) || subtle.ConstantTimeCompare([]byte(tokens[0]), []byte(sess.CSRF)) != 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
