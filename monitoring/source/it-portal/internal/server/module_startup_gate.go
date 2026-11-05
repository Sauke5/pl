package server

import (
	"net/http"
	"net/url"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// Only stable entry documents are known before a module's release manifest is
// available. Never widen the app route allowlist to arbitrary SPA paths here.
func moduleStartupDocument(r *http.Request, kind string) bool {
	if !gatewayDocumentRequest(r) || len(r.Header.Values("Upgrade")) != 0 || r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.Fragment != "" {
		return false
	}
	switch kind {
	case "forms":
		route, allowed := formsMatchRoute(r)
		return allowed && route.media == "text/html"
	case "doska":
		return r.URL.Path == "/doska" || r.URL.Path == "/doska/"
	case "wayline":
		path, _, allowed := waylineRoute(r)
		return allowed && path == "/"
	}
	return false
}

// tryModuleStartupPage uses only durable local state, never host-controller RPC.
// Call it only on an unavailable native app, or for Wayline's document entry.
// A ready app returns to its existing gateway; assets/API never query this state.
func (s *Server) tryModuleStartupPage(w http.ResponseWriter, r *http.Request, kind, expectedID string, unavailable bool) bool {
	if s.Store == nil || !moduleStartupDocument(r, kind) {
		return false
	}
	// Match existing app identity policy before revealing an instance name/state.
	sess, err := s.readSession(r)
	if err != nil {
		target := "/401?return_to=" + url.QueryEscape(r.URL.Path)
		if kind == "forms" {
			target = "/401?return_to=%2Fforms%2F"
		} else if kind == "doska" && r.URL.Path == "/doska" {
			target = "/401?return_to=%2Fdoska%2F"
		} else if kind == "wayline" {
			target = "/"
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, target, http.StatusSeeOther)
		return true
	}
	if kind == "wayline" && !sess.User.Admin {
		problem(w, http.StatusForbidden, "forbidden", "Доступ только для IT-группы")
		return true
	}
	rows, err := store.List[model.ModuleInstance](r.Context(), s.Store, "module_instance")
	if err != nil {
		return false
	}
	var selected model.ModuleInstance
	for _, row := range rows {
		if row.ModuleID != kind || row.Mode != "local" || row.DesiredState != "enabled" {
			continue
		}
		if selected.ID != "" {
			return false // An ambiguous installation is not startup progress.
		}
		selected = row
	}
	if selected.ID == "" || expectedID != "" && selected.ID != expectedID || !unavailable && selected.ObservedState == "running" {
		return false
	}
	stage := moduleStartupFailed
	if selected.LastJobID != "" {
		job, e := s.Store.Job(r.Context(), selected.LastJobID)
		if e == nil {
			stage = moduleStartupStageForJob(selected, job)
		}
	}
	renderModuleStartupPage(w, r, selected, stage)
	return true
}

func moduleStartupStageForJob(instance model.ModuleInstance, job model.Job) moduleStartupStage {
	if job.ID != instance.LastJobID || job.Kind != "module" || job.Parameters["instance_id"] != instance.ID || (job.Parameters["action"] != "install" && job.Parameters["action"] != "enable") || (job.Status != "queued" && job.Status != "running") {
		return moduleStartupFailed
	}
	if job.Status == "queued" {
		return moduleStartupQueued
	}
	if job.Parameters["action"] == "install" {
		return moduleStartupInstalling
	}
	return moduleStartupStarting
}
