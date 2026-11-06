package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
)

const scopedModuleStatusLimit = 64 << 10

var scopedDoskaDocument = regexp.MustCompile(`^/doska(?:/|/(?:projects(?:/[A-Za-z0-9_-]{1,128})?|my-tasks|overview|search|invitations|management))?$`)

// Names and prefixes are public product metadata, never saved instance names.
func scopedModuleGateway(path string) (kind, name string) {
	for _, item := range []struct{ prefix, kind, name string }{
		{"/doska", "doska", "Doska"}, {"/forms", "forms", "Forms"},
		{"/wayline", "wayline", "Wayline"}, {"/netmap", "netmap", "NetMap"},
		{"/grafana", "grafana", "Grafana"}, {"/wiki", "bookstack", "Wiki"},
	} {
		if path == item.prefix || strings.HasPrefix(path, item.prefix+"/") {
			return item.kind, item.name
		}
	}
	return "", ""
}

func (s *Server) scopedModuleOperation(kind string) bool {
	path := filepath.Join(s.Config.MaintenanceDir, "status.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > scopedModuleStatusLimit {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	current, err := file.Stat()
	if err != nil || !os.SameFile(info, current) || !current.Mode().IsRegular() {
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(file, scopedModuleStatusLimit+1))
	if err != nil || len(raw) > scopedModuleStatusLimit {
		return false
	}
	var status struct {
		Active    bool                       `json:"active"`
		Operation *modules.DeliveryOperation `json:"operation"`
	}
	if json.Unmarshal(raw, &status) != nil || !status.Active || status.Operation == nil {
		return false
	}
	op := status.Operation
	id, err := uuid.Parse(op.OperationID)
	if err != nil || id.String() != op.OperationID || op.Scope != "module" || op.Kind != "module_upgrade" || op.ModuleID != kind {
		return false
	}
	switch op.Phase {
	case "queued", "queued_recovery", "downloading", "preparing_host", "quiescing", "snapshot", "applying", "verifying_host", "verifying", "restoring", "recovery_required", "resuming", "reconciling":
		return true
	}
	return false
}

func scopedModuleDocument(r *http.Request, kind string) bool {
	if !gatewayDocumentRequest(r) || r.URL.RawPath != "" || r.URL.ForceQuery || r.URL.Fragment != "" || len(r.Header.Values("Upgrade")) != 0 || !gatewayString(r.URL.RequestURI(), 4096, true) {
		return false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "document" && dest != "iframe" && dest != "frame" {
		return false
	}
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" && mode != "navigate" {
		return false
	}
	switch kind {
	case "doska":
		return scopedDoskaDocument.MatchString(r.URL.Path)
	case "forms":
		if r.URL.Path == "/forms" && r.URL.RawQuery == "" {
			return true
		}
		route, ok := formsMatchRoute(r)
		return ok && route.media == "text/html"
	case "wayline":
		if r.URL.Path == "/wayline" && r.URL.RawQuery == "" {
			return true
		}
		path, _, ok := waylineRoute(r)
		return ok && path == "/"
	case "netmap":
		if r.URL.Path == "/netmap" && r.URL.RawQuery == "" {
			return true
		}
		route, ok := netmapMatchRoute(r)
		return ok && route.media == "text/html"
	case "grafana", "bookstack":
		prefix := "/grafana"
		if kind == "bookstack" {
			prefix = "/wiki"
		}
		tail := strings.TrimPrefix(r.URL.Path, prefix)
		for _, segment := range strings.Split(tail, "/") {
			if segment == "." || segment == ".." || segment == "api" || segment == "assets" || segment == "public" || segment == "dist" || segment == "uploads" || segment == "images" {
				return false
			}
		}
		return !strings.Contains(tail, "//") && !strings.ContainsAny(tail, "\\%")
	}
	return false
}

func (s *Server) scopedModuleMaintenance(w http.ResponseWriter, r *http.Request) bool {
	request := r
	kind, name := scopedModuleGateway(r.URL.Path)
	for _, native := range []struct{ kind, name string }{{"grafana", "Grafana"}, {"bookstack", "Wiki"}} {
		if r.URL.Path == "/internal/routing/"+native.kind {
			kind, name = native.kind, native.name
		} else if r.URL.Path == "/internal/startup/"+native.kind {
			if len(r.Header.Values("X-Original-URI")) != 1 || len(r.Header.Values("X-Original-Method")) != 1 || r.Header.Get("X-Original-Upgrade") != "" {
				return false
			}
			uri, err := url.ParseRequestURI(r.Header.Get("X-Original-URI"))
			if err != nil || uri.IsAbs() || uri.Host != "" || uri.RawPath != "" || uri.ForceQuery || uri.Fragment != "" {
				return false
			}
			originalKind, originalName := scopedModuleGateway(uri.Path)
			if originalKind != native.kind {
				return false
			}
			kind, name = originalKind, originalName
			request = r.Clone(r.Context())
			request.URL, request.RequestURI, request.Method = uri, uri.RequestURI(), r.Header.Get("X-Original-Method")
		}
	}
	if kind == "" || !s.scopedModuleOperation(kind) {
		return false
	}
	documentKind, _ := scopedModuleGateway(request.URL.Path)
	if documentKind == kind && scopedModuleDocument(request, kind) {
		renderModuleStartupPage(w, request, model.ModuleInstance{Name: name}, moduleStartupUpdating)
	} else {
		w.Header().Set("Retry-After", "2")
		w.Header().Set("Cache-Control", "no-store")
		problem(w, http.StatusServiceUnavailable, "module_updating", "Модуль обновляется. Повторите запрос после завершения обновления.")
	}
	return true
}
