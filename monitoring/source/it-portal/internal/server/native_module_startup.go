package server

import (
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// Nginx calls these fixed endpoints only after native routing fails. Grafana
// retains native authentication; BookStack registers through moduleAuth.
func (s *Server) grafanaNativeStartup(w http.ResponseWriter, r *http.Request) {
	s.nativeModuleStartup(w, r, "grafana")
}

func (s *Server) bookstackNativeStartup(w http.ResponseWriter, r *http.Request) {
	s.nativeModuleStartup(w, r, "bookstack")
}

func nativeStartupDocument(r *http.Request, kind string) (*http.Request, bool) {
	if r.Method != http.MethodGet || r.URL.RawQuery != "" || len(r.Header.Values("X-Original-URI")) != 1 || len(r.Header.Values("X-Original-Method")) != 1 {
		return nil, false
	}
	uri, err := url.ParseRequestURI(r.Header.Get("X-Original-URI"))
	if err != nil || uri.IsAbs() || uri.Host != "" || uri.RawPath != "" || uri.RawQuery != "" || uri.ForceQuery || uri.Fragment != "" {
		return nil, false
	}
	request := r.Clone(r.Context())
	request.URL, request.RequestURI, request.Method = uri, uri.RequestURI(), r.Header.Get("X-Original-Method")
	if !gatewayDocumentRequest(request) || r.Header.Get("X-Original-Upgrade") != "" {
		return nil, false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "document" && dest != "iframe" && dest != "frame" {
		return nil, false
	}
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" && mode != "navigate" {
		return nil, false
	}
	// Only finite entry documents are known before the native app is ready.
	// API, assets, websocket, native auth callbacks and arbitrary SPA routes keep
	// the existing JSON failure response and their own routing policies.
	if kind == "grafana" && (uri.Path == "/grafana/" || uri.Path == "/grafana/login") || kind == "bookstack" && (uri.Path == "/wiki/" || uri.Path == "/wiki/login") {
		return request, true
	}
	return nil, false
}

func (s *Server) nativeModuleStartup(w http.ResponseWriter, r *http.Request, kind string) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.Config.PortableRelease {
		http.NotFound(w, r)
		return
	}
	document, ok := nativeStartupDocument(r, kind)
	if ok && s.Store != nil {
		if instance, selected := s.nativeStartupInstance(r, kind); selected {
			stage := moduleStartupFailed
			if instance.LastJobID != "" {
				if job, err := s.Store.Job(r.Context(), instance.LastJobID); err == nil {
					stage = moduleStartupStageForJob(instance, job)
				}
			}
			if kind == "grafana" {
				// This endpoint deliberately accepts anonymous Grafana visitors.
				// Never expose administrator-chosen names, IDs or stored errors.
				instance = model.ModuleInstance{Name: "Grafana"}
			}
			renderModuleStartupPage(w, document, instance, stage)
			return
		}
	}
	code, message := "grafana_unavailable", "Локальная Grafana не установлена, отключена, выбрана неоднозначно или недоступна"
	if kind == "bookstack" {
		code, message = "wiki_unavailable", "Wiki не установлена, отключена или недоступна"
	}
	respond(w, http.StatusServiceUnavailable, map[string]string{"error": code, "message": message})
}

func (s *Server) nativeStartupInstance(r *http.Request, kind string) (model.ModuleInstance, bool) {
	rows, err := store.List[model.ModuleInstance](r.Context(), s.Store, "module_instance")
	if err != nil {
		return model.ModuleInstance{}, false
	}
	var selected model.ModuleInstance
	for _, instance := range rows {
		if instance.ModuleID != kind || instance.DesiredState == "removed" {
			continue
		}
		if selected.ID != "" {
			return model.ModuleInstance{}, false
		}
		selected = instance
	}
	id, err := uuid.Parse(selected.ID)
	if err != nil || id.String() != selected.ID || selected.Mode != "local" || selected.DesiredState != "enabled" {
		return model.ModuleInstance{}, false
	}
	// Installation jobs initially have no integration. If an alias owner
	// already exists, require the same unique reciprocal binding as native
	// routing; a foreign/disabled connection cannot masquerade as progress.
	integrations, err := store.List[model.Integration](r.Context(), s.Store, "integration")
	if err != nil {
		return model.ModuleInstance{}, false
	}
	owners := 0
	for _, integration := range integrations {
		if integration.Kind != kind || !integration.Enabled {
			continue
		}
		owners++
		if owners > 1 || integration.ID != selected.IntegrationID || integration.ManagedModuleID != selected.ID {
			return model.ModuleInstance{}, false
		}
	}
	return selected, owners == 1 || selected.IntegrationID == ""
}
