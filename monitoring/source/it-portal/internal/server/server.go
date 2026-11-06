package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

type Server struct {
	connectorCredentials *connectorCredentialService
	Modules              *modules.Manager
	Store                *store.Store
	Config               Config
	Providers            *providers.Registry
	oidcMu               sync.Mutex
	localAuthMu          sync.Mutex
	provider             *oidc.Provider
	oidcClient           *http.Client
	Hub                  *Hub
	applications         managedApplicationHandlers
	formsHandler         http.Handler
	doskaHandler         http.Handler
	doskaDirectorySync   *DoskaDirectorySync
	SFTPAdminOIDC        *sftpAdminOIDC
	SFTPAdminGateway     *sftpAdminGateway
}

func New(s *store.Store, c Config, p *providers.Registry, client *http.Client) *Server {
	if p != nil {
		p.SetICMPExecutor(c.ICMPExecutorURL)
		if guard, err := netguard.New(c.ICMPCIDRs, nil, ""); err == nil {
			if c.ICMPPolicyMode == "interactive" {
				guard = guard.InteractiveChecks()
			}
			p.SetICMPGuard(guard)
		}
	}
	return &Server{Store: s, Config: c, Providers: p, oidcClient: client, Hub: NewHub()}
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]string{"error": code, "message": message})
}
func (s *Server) fail(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, store.ErrConflict):
		problem(w, 409, "revision_conflict", "Запись изменилась. Обновите данные и повторите сохранение.")
	case errors.Is(e, store.ErrManagedModule):
		problem(w, 409, "managed_module", "Измените управляемый объект на странице модулей")
	case errors.Is(e, store.ErrNotFound):
		problem(w, 404, "not_found", "Запись не найдена")
	case errors.Is(e, store.ErrInvalid):
		problem(w, 400, "invalid_data", "Некорректные данные")
	default:
		slog.Error("request_failed", "error_type", fmt.Sprintf("%T", e))
		problem(w, 500, "internal_error", "Не удалось выполнить запрос")
	}
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/v1/modules/catalog", s.moduleAuth(s.moduleCatalog))
	m.HandleFunc("GET /api/v1/modules/{id}/mailcow", s.moduleAuth(s.mailcowSnapshot))
	m.HandleFunc("PUT /api/v1/modules/{id}/mailcow/settings", s.moduleAuth(s.mailcowSettings))
	m.HandleFunc("GET /api/v1/modules/{id}/alertmanager/configuration", s.moduleAuth(s.getAlertmanagerConfiguration))
	m.HandleFunc("PUT /api/v1/modules/{id}/alertmanager/configuration", s.moduleAuth(s.saveAlertmanagerConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/alertmanager/configuration/validate", s.moduleAuth(s.validateAlertmanagerConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/alertmanager/configuration/apply", s.moduleAuth(s.applyAlertmanagerConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/alertmanager/configuration/retry", s.moduleAuth(s.retryAlertmanagerConfiguration))
	m.HandleFunc("GET /api/v1/modules/{id}/alertmanager/status", s.moduleAuth(s.getAlertmanagerStatus))
	m.HandleFunc("POST /api/v1/modules/{id}/alertmanager/email/preview", s.moduleAuth(s.previewAlertmanagerEmail))
	m.HandleFunc("POST /api/v1/modules/{id}/alertmanager/message/preview", s.moduleAuth(s.previewAlertmanagerMessage))
	m.HandleFunc("POST /api/v1/modules/{id}/alertmanager/email/test", s.moduleAuth(s.testAlertmanagerEmail))
	m.HandleFunc("GET /api/v1/modules/{id}/xray/configuration", s.moduleAuth(s.getXrayConfiguration))
	m.HandleFunc("PUT /api/v1/modules/{id}/xray/configuration", s.moduleAuth(s.saveXrayConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/xray/configuration/validate", s.moduleAuth(s.validateXrayConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/xray/configuration/apply", s.moduleAuth(s.applyXrayConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/xray/configuration/retry", s.moduleAuth(s.retryXrayConfiguration))
	m.HandleFunc("GET /api/v1/modules/{id}/xray/status", s.moduleAuth(s.getXrayStatus))
	m.HandleFunc("GET /api/v1/modules", s.moduleAuth(s.listModules))
	m.HandleFunc("POST /api/v1/modules", s.moduleAuth(s.createModule))
	m.HandleFunc("POST /api/v1/modules/{id}/actions", s.moduleAuth(s.moduleAction))
	m.HandleFunc("GET /api/v1/modules/{id}/prometheus/{path...}", s.moduleAuth(s.modulePrometheus))
	m.HandleFunc("GET /api/v1/modules/{id}/configuration", s.moduleAuth(s.getPrometheusConfiguration))
	m.HandleFunc("PUT /api/v1/modules/{id}/configuration", s.moduleAuth(s.savePrometheusConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/configuration/validate", s.moduleAuth(s.validatePrometheusConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/configuration/apply", s.moduleAuth(s.applyPrometheusConfiguration))
	m.HandleFunc("POST /api/v1/modules/{id}/configuration/retry", s.moduleAuth(s.retryPrometheusConfiguration))
	if s.Config.PortableRelease {
		// Nginx forwards native Grafana traffic directly. This route only resolves
		// the installed container and removes the unrelated Platform cookie.
		m.HandleFunc("GET /internal/routing/grafana", s.grafanaNativeUpstream)
		m.HandleFunc("GET /internal/routing/bookstack", s.moduleAuth(s.bookstackNativeUpstream))
		m.HandleFunc("GET /internal/startup/grafana", s.grafanaNativeStartup)
		m.HandleFunc("GET /internal/startup/bookstack", s.moduleAuth(s.bookstackNativeStartup))
		m.HandleFunc(bookstackExternalPrefix+"/", s.bookstackExternalProxy)
		m.HandleFunc("/netmap", s.netmapGateway)
		m.HandleFunc("/netmap/", s.netmapGateway)
		m.HandleFunc("GET /api/v1/modules/{id}/netmap/{path...}", s.moduleAuth(s.netmapModuleAPI))
		m.HandleFunc("POST /api/v1/modules/{id}/netmap/{path...}", s.moduleAuth(s.netmapModuleAPI))
		m.HandleFunc("POST /api/v1/modules/{id}/initial-login", s.moduleAuth(s.moduleInitialLogin))
	} else {
		grafana := s.grafanaGateway()
		m.Handle("/grafana", grafana)
		m.Handle("/grafana/", grafana)
	}
	forms := s.formsHandler
	if forms == nil {
		forms, _ = s.newFormsGateway(nil)
	}
	forms = s.managedApplication("forms", forms)
	m.Handle("/forms", forms)
	m.Handle("/forms/", forms)
	doska := s.doskaHandler
	if doska == nil {
		doska = http.NotFoundHandler()
	}
	doska = s.managedApplication("doska", doska)
	m.Handle("/doska", doska)
	m.Handle("/doska/", doska)
	m.HandleFunc("GET /api/v1/modules/{id}/doska-directory/{kind}", s.moduleDirectory)
	if !s.Config.PortableRelease {
		s.registerSFTPRoutes(m)
	}
	if s.SFTPAdminOIDC != nil {
		s.SFTPAdminOIDC.registerRoutes(m)
	}
	if s.SFTPAdminGateway != nil {
		s.SFTPAdminGateway.registerRoutes(m)
	} else {
		m.HandleFunc("GET /api/v1/sftp-adm", s.auth(func(w http.ResponseWriter, r *http.Request) {
			respond(w, 200, map[string]any{"configured": false, "can_admin": false, "can_access_files": false})
		}, false))
	}
	s.registerSFTPGoModuleRoutes(m)
	s.registerProviderBrowseRoutes(m)
	s.RegisterSettingsWorkspace(m)
	s.RegisterADSettingsRoutes(m)
	s.RegisterDeliveryRoutes(m)
	s.RegisterInstallationRoutes(m)
	s.RegisterSettingsProbe(m)
	s.RegisterConfigurationHistoryRoutes(m)
	s.registerWorkspaceRoutes(m)
	if s.Providers != nil {
		h := s.WaylineProxy(s.Config.WaylineIntegrationID, s.Providers.WaylineProxyTransport)
		m.Handle("/wayline", h)
		m.Handle("/wayline/", h)
	}
	gateways := append([]ServiceGatewayConfig(nil), s.Config.ServiceGateways...)
	hasDirectory := false
	for _, gateway := range gateways {
		if gateway.Audience == "directory" {
			hasDirectory = true
		}
	}
	if !hasDirectory {
		gateways = append(gateways, ServiceGatewayConfig{Audience: "directory", AssertionVersion: 2})
	}
	for _, prefix := range []string{"/audit", "/audit-arch"} {
		configured := false
		for _, gateway := range gateways {
			if gatewayConfigPrefix(gateway) == prefix {
				configured = true
			}
		}
		if !configured {
			h := s.managedAuditorGateway(prefix)
			m.Handle(prefix, h)
			m.Handle(prefix+"/", h)
		}
	}
	for _, gateway := range gateways {
		if s.Providers != nil {
			gateway.Transport, _ = s.Providers.ServiceGatewayTransport(gateway.Upstream)
		}
		h := s.ServiceGateway(gateway)
		prefix := gatewayConfigPrefix(gateway)
		m.Handle(prefix, h)
		m.Handle(prefix+"/", h)
	}
	m.HandleFunc("GET /internal/auth/dozzle", s.dozzleAuth)
	m.HandleFunc("GET /api/v1/legacy-proxy-auth", s.legacyProxyAuth)
	m.HandleFunc("GET /api/v1/monitoring-proxy-auth", s.monitoringProxyAuth)

	m.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	m.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if e := s.Store.Pool.Ping(ctx); e != nil {
			problem(w, 503, "database_unavailable", "База данных недоступна")
			return
		}
		respond(w, 200, map[string]string{"status": "ready"})
	})
	m.HandleFunc("GET /auth/login", s.login)
	m.HandleFunc("GET /auth/callback", s.callback)
	m.HandleFunc("POST /auth/demo", s.demoLogin)
	m.HandleFunc("POST /auth/local", s.localLogin)
	m.HandleFunc("POST /auth/ad", s.adLogin)
	m.HandleFunc("POST /auth/logout", s.auth(s.logout, false))
	m.HandleFunc("GET /api/v1/session", s.sessionAPI)
	m.HandleFunc("POST /api/v1/local-admin/password", s.auth(s.changeLocalAdminPassword, true))
	m.HandleFunc("GET /api/v1/local-users", s.localUsersAuth(s.listLocalUsers, true))
	m.HandleFunc("POST /api/v1/local-users", s.localUsersAuth(s.createLocalUser, true))
	m.HandleFunc("PATCH /api/v1/local-users/{id}", s.localUsersAuth(s.updateLocalUser, true))
	m.HandleFunc("POST /api/v1/local-users/{id}/password", s.localUsersAuth(s.resetLocalUserPassword, true))
	m.HandleFunc("POST /api/v1/local-users/me/password", s.localUsersAuth(s.changeOwnLocalUserPassword, false))
	for _, path := range []string{"identity", "employees", "departments", "changes"} {
		m.HandleFunc("GET /api/v1/doska-directory/"+path, func(w http.ResponseWriter, r *http.Request) {
			s.machineAuth(s.doskaDirectory, w, r)
		})
	}
	m.HandleFunc("GET /api/v1/board", s.board)
	m.HandleFunc("GET /api/v1/dashboard-layout", s.auth(s.dashboardLayout, false))
	m.HandleFunc("PUT /api/v1/dashboard-layout", s.auth(s.dashboardLayout, false))
	m.HandleFunc("GET /api/v1/help-state", s.auth(s.helpState, false))
	m.HandleFunc("PATCH /api/v1/help-state", s.auth(s.updateHelpState, false))
	a := func(pattern string, h http.HandlerFunc) { m.HandleFunc(pattern, s.auth(h, true)) }
	a("GET /api/v1/edge/status", s.edgeStatusHandler(s.Config.Edge))
	proxyControl := s.proxyControlHandler()
	a("GET /api/v1/proxy-control/status", proxyControl)
	a("GET /api/v1/proxy-control/observability", s.proxyObservabilityHandler())
	a("GET /api/v1/proxy-control/history", proxyControl)
	a("POST /api/v1/proxy-control/mode", proxyControl)
	a("GET /api/v1/resources", s.resources)
	a("GET /api/v1/search", s.resources)
	a("POST /api/v1/resources", s.saveResource)
	a("GET /api/v1/resources/{id}", s.getResource)
	a("GET /api/v1/resources/{id}/inventory", s.resourceInventory)
	a("PUT /api/v1/resources/{id}", s.saveResource)
	a("DELETE /api/v1/resources/{id}", s.archiveResource)
	for _, route := range []struct{ path, kind string }{{"collections", "collection"}, {"integrations", "integration"}} {
		path, kind := route.path, route.kind
		a("GET /api/v1/"+path, func(w http.ResponseWriter, r *http.Request) { s.list(w, r, kind) })
		a("POST /api/v1/"+path, func(w http.ResponseWriter, r *http.Request) { s.saveObject(w, r, kind) })
		a("PUT /api/v1/"+path+"/{id}", func(w http.ResponseWriter, r *http.Request) { s.saveObject(w, r, kind) })
		a("DELETE /api/v1/"+path+"/{id}", func(w http.ResponseWriter, r *http.Request) {
			if kind == "integration" {
				old, e := store.Get[model.Integration](r.Context(), s.Store, kind, r.PathValue("id"))
				if e != nil {
					s.fail(w, e)
					return
				}
				if old.ManagedModuleID != "" {
					problem(w, 409, "managed_module", "Удалите подключение на странице модулей")
					return
				}
			}
			rev, e := strconv.ParseInt(strings.Trim(r.Header.Get("If-Match"), "\""), 10, 64)
			if e != nil || rev < 1 {
				problem(w, 428, "revision_required", "Укажите If-Match с текущей revision")
				return
			}
			if e = s.Store.Delete(r.Context(), kind, r.PathValue("id"), rev, current(r).User.ID); e != nil {
				s.fail(w, e)
				return
			}
			s.Hub.Notify(path)
			w.WriteHeader(204)
		})
	}
	for _, kind := range []string{"preferences", "settings", "dictionaries"} {
		k := kind
		a("GET /api/v1/"+k, func(w http.ResponseWriter, r *http.Request) { s.getSingleton(w, r, k) })
		a("PUT /api/v1/"+k, func(w http.ResponseWriter, r *http.Request) { s.saveObject(w, r, k) })
	}
	a("GET /api/v1/candidates", func(w http.ResponseWriter, r *http.Request) { s.list(w, r, "candidate") })
	a("POST /api/v1/candidates/resolve", s.resolveCandidates)
	a("GET /api/v1/problems", s.problems)
	a("GET /api/v1/problems/{id}/links", s.problemLinks)
	a("PUT /api/v1/problems/{id}/links", s.problemLinks)
	a("GET /api/v1/chart-settings", s.chartSettings)
	a("PUT /api/v1/chart-settings", s.chartSettings)
	a("PUT /api/v1/problems/{id}/visibility", s.problemVisibility)
	a("GET /api/v1/reports", func(w http.ResponseWriter, r *http.Request) { s.list(w, r, "report") })
	a("GET /api/v1/wayline", s.wayline)
	a("GET /api/v1/events", s.events)
	a("GET /api/v1/audit", s.events)
	a("GET /api/v1/event-journal", s.eventJournal)
	a("GET /api/v1/event-journal/{id}", s.eventJournalDetail)
	a("POST /api/v1/event-journal/view", s.eventJournalView)
	a("GET /api/v1/export", s.export)
	a("POST /api/v1/import/preview", s.importPreview)
	a("POST /api/v1/import/apply", s.importApply)
	a("GET /api/v1/jobs", s.jobs)
	a("GET /api/v1/jobs/{id}", s.jobs)
	a("GET /api/v1/jobs/{id}/output", s.jobOutput)
	a("POST /api/v1/jobs", s.enqueue)
	a("POST /api/v1/integrations/{id}/refresh", s.refresh)
	a("GET /api/v1/stream", s.stream)
	a("GET /api/v1/time", serverTime)
	a("GET /api/v1/runtime", s.runtimeSettings)

	protected := s.maintenanceGate(s.bootstrapPasswordGate(m))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		protected.ServeHTTP(w, r)
	})
}
func (s *Server) resources(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p, _ := store.Get[model.Preferences](r.Context(), s.Store, "preferences", current(r).User.ID)
	items, e := s.Store.Search(r.Context(), model.Filter{Q: q.Get("q"), Direction: q.Get("direction"), Site: q.Get("site"), Environment: q.Get("environment"), Tag: q.Get("tag"), Collection: q.Get("collection"), Lifecycle: q.Get("lifecycle"), Sort: q.Get("sort")}, p.Favorites)
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, items)
}
func (s *Server) getResource(w http.ResponseWriter, r *http.Request) {
	b, e := s.Store.Get(r.Context(), "resource", r.PathValue("id"))
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, b)
}
func (s *Server) saveResource(w http.ResponseWriter, r *http.Request) {
	var input struct {
		model.Resource
		Icon json.RawMessage `json:"icon"`
	}
	if !decode(w, r, &input) {
		return
	}
	v := input.Resource
	if len(input.Icon) > 0 {
		icon, err := parseResourceIcon(input.Icon)
		if err != nil {
			problem(w, 400, "invalid_resource", err.Error())
			return
		}
		v.Icon = icon
	}
	if v.ManagedModuleID != "" {
		problem(w, 409, "managed_module", "Карточкой управляет модуль")
		return
	}
	now := time.Now().UTC()
	if r.Method == "POST" {
		if strings.HasPrefix(current(r).User.ID, "machine:") && (len(v.Operations) > 0 || v.ExecutorTarget != "" || v.Check != (model.Check{}) || (v.Lifecycle != "" && v.Lifecycle != "active")) {
			problem(w, 403, "machine_scope", "MCP может создавать только карточки каталога без операций и настроек проверок")
			return
		}
		v.ID = uuid.NewString()
		v.Revision = 0
		v.CreatedAt = now
		v.Source = "manual"
		v.ExternalIDs = []string{}
	} else {
		old, e := store.Get[model.Resource](r.Context(), s.Store, "resource", r.PathValue("id"))
		if e != nil {
			s.fail(w, e)
			return
		}
		if old.ManagedModuleID != "" {
			problem(w, 409, "managed_module", "Измените модуль на странице модулей")
			return
		}
		if v.Revision < 1 {
			problem(w, 428, "revision_required", "Укажите текущую revision")
			return
		}
		if strings.HasPrefix(current(r).User.ID, "machine:") && (!reflect.DeepEqual(v.Operations, old.Operations) || v.ExecutorTarget != old.ExecutorTarget || v.Check != old.Check || v.Lifecycle != old.Lifecycle) {
			problem(w, 403, "machine_scope", "MCP не меняет операции, проверки или жизненный цикл ресурса")
			return
		}
		if len(input.Icon) == 0 {
			v.Icon = old.Icon
		}
		v.ID = old.ID
		v.CreatedAt = old.CreatedAt
		v.Source = old.Source
		v.ExternalIDs = old.ExternalIDs
	}
	v.UpdatedAt = now
	if e := validateResource(&v); e != nil {
		problem(w, 400, "invalid_resource", e.Error())
		return
	}
	for _, rel := range v.Relations {
		if _, e := s.Store.Get(r.Context(), "resource", rel.ResourceID); e != nil {
			problem(w, 400, "invalid_relation", "Связанный ресурс не найден")
			return
		}
	}
	b, e := s.Store.Save(r.Context(), "resource", v.ID, v.Revision, v, current(r).User.ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify("resources")
	_ = s.Store.Event(r.Context(), "resource.saved", "Сохранён ресурс: "+v.Name, v.ID, current(r).User.ID, nil, false)
	status := 200
	if r.Method == "POST" {
		status = 201
	}
	respond(w, status, b)
}
func (s *Server) archiveResource(w http.ResponseWriter, r *http.Request) {
	v, e := store.Get[model.Resource](r.Context(), s.Store, "resource", r.PathValue("id"))
	if e != nil {
		s.fail(w, e)
		return
	}
	if v.ManagedModuleID != "" {
		problem(w, 409, "managed_module", "Удалите модуль на странице модулей")
		return
	}
	rev, e := strconv.ParseInt(strings.Trim(r.Header.Get("If-Match"), "\""), 10, 64)
	if e != nil || rev < 1 {
		problem(w, 428, "revision_required", "Укажите If-Match")
		return
	}
	v.Lifecycle = "archived"
	v.UpdatedAt = time.Now().UTC()
	if _, e = s.Store.Save(r.Context(), "resource", v.ID, rev, v, current(r).User.ID); e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify("resources")
	w.WriteHeader(204)
}
func (s *Server) list(w http.ResponseWriter, r *http.Request, kind string) {
	bs, e := s.Store.List(r.Context(), kind)
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, bs)
}
func (s *Server) getSingleton(w http.ResponseWriter, r *http.Request, kind string) {
	id := "global"
	if kind == "preferences" {
		id = current(r).User.ID
	}
	b, e := s.Store.Get(r.Context(), kind, id)
	if e != nil {
		if kind == "preferences" && errors.Is(e, store.ErrNotFound) {
			respond(w, 200, model.Preferences{Favorites: []string{}, HiddenSections: []string{}})
			return
		}
		s.fail(w, e)
		return
	}
	respond(w, 200, b)
}
func (s *Server) saveObject(w http.ResponseWriter, r *http.Request, kind string) {
	id := r.PathValue("id")
	if id == "" {
		id = uuid.NewString()
	}
	if kind == "settings" || kind == "dictionaries" {
		id = "global"
	}
	if kind == "preferences" {
		id = current(r).User.ID
	}
	var value any
	var rev int64
	switch kind {
	case "collection":
		var v model.Collection
		if !decode(w, r, &v) {
			return
		}
		v.ID = id
		if v.Mode == "" {
			v.Mode = "manual"
		}
		if v.Mode != "manual" && v.Mode != "filter" {
			problem(w, 400, "invalid_collection", "Неизвестный тип подборки")
			return
		}
		rev = v.Revision
		if strings.TrimSpace(v.Name) == "" || len(v.Name) > 160 || len(v.ResourceIDs) > 1000 {
			problem(w, 400, "invalid_collection", "Укажите название подборки")
			return
		}
		if v.ResourceIDs == nil {
			v.ResourceIDs = []string{}
		}
		if (v.Mode == "manual" && v.Filter != model.Filter{}) || (v.Mode == "filter" && len(v.ResourceIDs) > 0) {
			problem(w, 400, "invalid_collection", "Выберите ручную подборку или фильтр")
			return
		}
		for _, rid := range v.ResourceIDs {
			if _, e := s.Store.Get(r.Context(), "resource", rid); e != nil {
				problem(w, 400, "invalid_resource", "Ресурс подборки не найден")
				return
			}
		}
		value = v
	case "integration":
		var v model.Integration
		if !decode(w, r, &v) {
			return
		}
		if v.ManagedModuleID != "" {
			problem(w, 409, "managed_module", "Интеграцией управляет модуль")
			return
		}
		v.ID = id
		rev = v.Revision
		if e := validateIntegration(&v); e != nil {
			problem(w, 400, "invalid_integration", e.Error())
			return
		}
		v.Status = "unconfigured"
		if !s.validateIntegrationBindings(w, r, v) {
			return
		}
		v.LastSuccess = nil
		v.LastAttempt = nil
		v.Error = ""
		v.Capabilities = providers.Capabilities(v.Kind)
		if r.Method == "PUT" {
			old, e := store.Get[model.Integration](r.Context(), s.Store, kind, id)
			if e != nil {
				s.fail(w, e)
				return
			}
			if old.ManagedModuleID != "" {
				problem(w, 409, "managed_module", "Измените подключение на странице модулей")
				return
			}
			v.Status = old.Status
			v.LastSuccess = old.LastSuccess
			v.LastAttempt = old.LastAttempt
			v.Error = old.Error
		}
		if !v.Enabled {
			v.Status = "disabled"
		}
		value = v
	case "preferences":
		var v model.Preferences
		if !decode(w, r, &v) {
			return
		}
		rev = v.Revision
		if len(v.SectionOrder) > 9 {
			problem(w, 400, "invalid_section_order", "Слишком много разделов")
			return
		}
		seenSections := map[string]bool{}
		for _, section := range v.SectionOrder {
			if !store.Contains([]string{"favorites", "problems", "directions", "events", "reports", "tools", "integrations", "grafana", "wayline"}, section) || seenSections[section] {
				problem(w, 400, "invalid_section_order", "Некорректный порядок разделов")
				return
			}
			seenSections[section] = true
		}
		if v.SectionOrder == nil {
			v.SectionOrder = []string{}
		}
		if len(v.Favorites) > 1000 || len(v.HiddenSections) > 10 || len(v.WaylineCards) > 100 {

			problem(w, 400, "invalid_preferences", "Слишком много предпочтений")
			return
		}
		for _, section := range v.HiddenSections {
			if !store.Contains([]string{"favorites", "events", "reports", "tools", "directions", "integrations", "wayline"}, section) {
				problem(w, 400, "invalid_section", "Этот раздел нельзя скрыть")
				return
			}
		}
		if v.Favorites == nil {
			v.Favorites = []string{}
		}
		if v.HiddenSections == nil {
			v.HiddenSections = []string{}
		}
		seenCards := map[model.WaylineCard]bool{}
		for _, card := range v.WaylineCards {
			if card.IntegrationID == "" || len(card.IntegrationID) > 160 || card.TargetID < 1 || seenCards[card] {
				problem(w, 400, "invalid_preferences", "Некорректная или повторная карточка Wayline")
				return
			}
			seenCards[card] = true
		}
		if v.WaylineCards == nil {
			v.WaylineCards = []model.WaylineCard{}
		}
		previous, err := store.Get[model.Preferences](r.Context(), s.Store, "preferences", id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, err)
			return
		}
		if !s.validateServiceCardAdditions(w, r, v.Favorites, previous.Favorites) {
			return
		}
		value = v
	case "settings":
		var v model.Settings
		if !decode(w, r, &v) {
			return
		}
		rev = v.Revision
		if e := validateSettings(v); e != nil {
			problem(w, 400, "invalid_settings", e.Error())
			return
		}
		previous, err := store.Get[model.Settings](r.Context(), s.Store, "settings", id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, err)
			return
		}
		if !s.validateServiceCardAdditions(w, r, v.BoardResourceIDs, previous.BoardResourceIDs) {
			return
		}
		value = v
	case "dictionaries":
		var v model.Dictionaries
		if !decode(w, r, &v) {
			return
		}
		rev = v.Revision
		for _, list := range [][]string{v.Directions, v.Sites, v.Environments, v.Types, v.RelationTypes} {
			if len(list) > 200 {
				problem(w, 400, "invalid_dictionary", "Слишком много значений")
				return
			}
			for _, item := range list {
				if strings.TrimSpace(item) == "" || len(item) > 100 {
					problem(w, 400, "invalid_dictionary", "Некорректное значение справочника")
					return
				}
			}
		}
		if v.RelationTypes == nil {
			previous, err := store.Get[model.Dictionaries](r.Context(), s.Store, "dictionaries", "global")
			if err != nil {
				s.fail(w, err)
				return
			}
			v.RelationTypes = previous.RelationTypes
			if v.RelationTypes == nil {
				v.RelationTypes = []string{}
			}
		}
		value = v
	}
	if r.Method == "POST" {
		rev = 0
	} else if rev < 1 && kind != "preferences" {
		problem(w, 428, "revision_required", "Укажите текущую revision")
		return
	}
	b, e := s.Store.Save(r.Context(), kind, id, rev, value, current(r).User.ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify(kind)
	status := 200
	if r.Method == "POST" {
		status = 201
	}
	respond(w, status, b)
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	s.reconcileDelivery(r.Context())
	items, e := s.Store.Events(r.Context(), strings.HasSuffix(r.URL.Path, "/audit"))
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, items)
}
func (s *Server) problems(w http.ResponseWriter, r *http.Request) {
	items, e := s.Store.Problems(r.Context())
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, items)
}
func (s *Server) board(w http.ResponseWriter, r *http.Request) {
	settings, e := store.Get[model.Settings](r.Context(), s.Store, "settings", "global")
	if e != nil {
		s.fail(w, e)
		return
	}
	if !settings.BoardEnabled {
		problem(w, 403, "board_disabled", "Ограниченный board выключен")
		return
	}
	viewer, sessionErr := s.readSession(r)
	authenticated := sessionErr == nil && viewer.User.ID != ""
	if !settings.BoardAnonymous {
		if !authenticated {
			problem(w, 401, "login_required", "Войдите для просмотра board")
			return
		}
	}
	problems, e := s.Store.Problems(r.Context())
	if e != nil {
		s.fail(w, e)
		return
	}
	items := []map[string]any{}
	for _, id := range settings.BoardResourceIDs {
		resource, e := store.Get[model.Resource](r.Context(), s.Store, "resource", id)
		if e != nil || resource.Lifecycle != "active" || !isServiceCardResource(resource, s.Config.PublicURL) {
			continue
		}
		status := "unknown"
		for _, p := range problems {
			if (p.ResourceID == id || store.Contains(p.ResourceIDs, id)) && p.Status == "firing" {
				status = "problem"
				if p.Stale {
					status = "stale"
				}
				break
			}
		}
		items = append(items, projectBoardResource(resource, status, authenticated, s.Config.PublicURL))
	}
	respond(w, 200, map[string]any{"title": settings.BoardTitle, "items": items})
}
