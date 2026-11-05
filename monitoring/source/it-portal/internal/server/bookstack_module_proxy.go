package server

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

// This route is registered through moduleAuth. Nginx overwrites X-Original-*
// in an internal auth_request; no browser target URL is routing authority.
func (s *Server) bookstackNativeUpstream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.Config.PortableRelease {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet || r.URL.RawQuery != "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	sess := current(r)
	if sess.User.ID == "" || !sess.ExpiresAt.After(time.Now()) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if !sess.User.Admin {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	for _, name := range []string{"X-Original-Method", "X-Original-URI"} {
		if len(r.Header.Values(name)) != 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
	}
	for _, name := range []string{"X-Original-Origin", "X-Original-Upgrade", "X-Original-Sec-Fetch-Site"} {
		if len(r.Header.Values(name)) > 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
	}
	method, uri := r.Header.Get("X-Original-Method"), r.Header.Get("X-Original-URI")
	if !bookstackNativeRoute(method, uri) || r.Header.Get("X-Original-Upgrade") != "" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	origin := r.Header.Get("X-Original-Origin")
	unsafe := method != http.MethodGet && method != http.MethodHead
	if (unsafe && origin == "") || (origin != "" && origin != s.Config.PublicURL) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if site := r.Header.Get("X-Original-Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	cookies, ok := bookstackNativeCookies(r.Header.Values("Cookie"))
	if !ok {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if s.Store == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	// Exactly one alias owner across both modes. Do not poll a root controller
	// or let Nginx resolve an administrator-provided external destination.
	integration, selected, err := s.bookstackNativeSource(r)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	upstream, valid := bookstackNativeContainerUpstream(integration, selected)
	if selected.Mode == "external" && s.Modules != nil {
		client, err := s.Modules.BookStack.Client(integration, s.Config.PublicURL)
		if err == nil {
			client.CloseIdleConnections()
			upstream, valid = "http://api:8080"+bookstackExternalPrefix, true
			// Only the fixed API hop receives the Pl cookie, so that it can
			// independently recheck the session. It strips it before egress.
			cookies = strings.Join(r.Header.Values("Cookie"), "; ")
		}
	}
	if !valid {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("X-Pl-Bookstack-Upstream", upstream)
	w.Header().Set("X-Pl-Bookstack-Cookie", cookies)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) bookstackNativeSource(r *http.Request) (model.Integration, model.ModuleInstance, error) {
	integration, err := s.connectorSource(r, "bookstack", "")
	if err != nil {
		return integration, model.ModuleInstance{}, err
	}
	instances, err := store.List[model.ModuleInstance](r.Context(), s.Store, "module_instance")
	if err != nil {
		return integration, model.ModuleInstance{}, err
	}
	var selected model.ModuleInstance
	count := 0
	for _, instance := range instances {
		if instance.ModuleID == "bookstack" {
			selected = instance
			count++
		}
	}
	id, idErr := uuid.Parse(selected.ID)
	if count != 1 || idErr != nil || id.String() != selected.ID || integration.ManagedModuleID != selected.ID || selected.IntegrationID != integration.ID || selected.DesiredState != "enabled" || selected.ObservedState != "running" || (selected.Mode != "local" && selected.Mode != "external") {
		return integration, selected, modules.ErrBookStackConnection
	}
	if selected.Mode == "external" && selected.Endpoint != integration.URL {
		return integration, selected, modules.ErrBookStackConnection
	}
	return integration, selected, nil
}

func bookstackNativeContainerUpstream(integration model.Integration, instance model.ModuleInstance) (string, bool) {
	id, err := uuid.Parse(instance.ID)
	if err != nil || id.String() != instance.ID || integration.ID == "" || integration.Kind != "bookstack" || !integration.Enabled || integration.ManagedModuleID != instance.ID || instance.IntegrationID != integration.ID || instance.ModuleID != "bookstack" || instance.Mode != "local" || instance.DesiredState != "enabled" || instance.ObservedState != "running" {
		return "", false
	}
	return "http://pl-bookstack-" + instance.ID + ":80", true
}

func bookstackNativeRoute(method, originalURI string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	if !gatewayString(originalURI, 8192, true) || strings.ContainsAny(originalURI, " #") || !strings.HasPrefix(originalURI, "/wiki/") {
		return false
	}
	u, err := url.ParseRequestURI(originalURI)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/wiki/") || !gatewayString(u.Path, 8192, false) || strings.ContainsAny(u.Path, "\\%?#") || strings.Contains(u.Path, "//") {
		return false
	}
	rawPath, _, _ := strings.Cut(originalURI, "?")
	lowerPath := strings.ToLower(rawPath)
	if strings.Contains(lowerPath, "%2f") || strings.Contains(lowerPath, "%5c") {
		return false
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	query, err := url.QueryUnescape(u.RawQuery)
	return err == nil && gatewayString(query, 8192, false)
}

// Preserve native sessions, remember-me, CSRF and extensions. Platform's cookie
// terminates at the auth subrequest. Nginx separately clears identity headers on
// the actual proxy request; this metadata response never copies request headers.
func bookstackNativeCookies(headers []string) (string, bool) {
	var native []string
	size := 0
	for _, header := range headers {
		size += len(header)
		if size > 16384 || !gatewayString(header, 16384, true) {
			return "", false
		}
		for _, part := range strings.Split(header, ";") {
			part = strings.TrimSpace(part)
			name, _, _ := strings.Cut(part, "=")
			if part != "" && strings.TrimSpace(name) != "portal_session" {
				native = append(native, part)
			}
		}
	}
	return strings.Join(native, "; "), true
}
