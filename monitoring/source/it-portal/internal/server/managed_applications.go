package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

type managedApplicationHandlers struct {
	sync.Mutex
	handlers     map[string]*managedApplicationHandler
	constructors map[string]*sync.Mutex
}

func (h *managedApplicationHandlers) instanceConstructor(id string) *sync.Mutex {
	h.Lock()
	defer h.Unlock()
	if h.constructors == nil {
		h.constructors = map[string]*sync.Mutex{}
	}
	lock := h.constructors[id]
	if lock == nil {
		lock = &sync.Mutex{}
		h.constructors[id] = lock
	}
	return lock
}

// A cached native gateway owns its spool lock and every request admitted through
// it. Revocation cancels those requests before releasing the native resources.
type managedApplicationHandler struct {
	handler  http.Handler
	lifetime context.Context
	cancel   context.CancelFunc
	once     sync.Once
}

func newManagedApplicationHandler(handler http.Handler) *managedApplicationHandler {
	ctx, cancel := context.WithCancel(context.Background())
	return &managedApplicationHandler{handler: handler, lifetime: ctx, cancel: cancel}
}

func (h *managedApplicationHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(h.lifetime, cancel)
	defer func() { stop(); cancel() }()
	if h.lifetime.Err() != nil {
		problem(w, 503, "module_unavailable", "Модуль приложения отключён")
		return
	}
	h.handler.ServeHTTP(w, r.Clone(ctx))
}

func (h *managedApplicationHandler) Close() error {
	var err error
	h.once.Do(func() {
		h.cancel()
		if closer, ok := h.handler.(io.Closer); ok {
			err = closer.Close()
		}
	})
	return err
}

// Caller holds applications.Mutex; closing before constructing a replacement
// releases the old native spool lock for this exact instance.
func (s *Server) revokeManagedApplicationLocked(id string) {
	for key, handler := range s.applications.handlers {
		if strings.HasPrefix(key, id+"/") {
			delete(s.applications.handlers, key)
			_ = handler.Close()
		}
	}
}

func (s *Server) cachedManagedApplicationLocked(v model.ModuleInstance) *managedApplicationHandler {
	key := v.ID + "/" + v.Version
	if handler := s.applications.handlers[key]; handler != nil {
		return handler
	}
	s.revokeManagedApplicationLocked(v.ID)
	return nil
}

func (s *Server) revokeManagedApplication(id string) {
	construction := s.applications.instanceConstructor(id)
	construction.Lock()
	defer construction.Unlock()
	s.applications.Lock()
	defer s.applications.Unlock()
	s.revokeManagedApplicationLocked(id)
}

func (s *Server) managedApplication(kind string, fallback http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Modules == nil {
			fallback.ServeHTTP(w, r)
			return
		}
		instance, err := s.Modules.FindApplication(r.Context(), kind)
		if errors.Is(err, modules.ErrApplicationNotInstalled) {
			fallback.ServeHTTP(w, r)
			return
		}
		if err != nil {
			if s.tryModuleStartupPage(w, r, kind, "", true) {
				return
			}
			problem(w, 503, "module_unavailable", "Модуль приложения не готов или отключён")
			return
		}
		handler, err := s.applicationHandler(r.Context(), instance)
		if err != nil {
			if s.tryModuleStartupPage(w, r, kind, instance.ID, true) {
				return
			}
			problem(w, 503, "module_unavailable", "Не удалось подтвердить конфигурацию модуля")
			return
		}
		handler.ServeHTTP(w, r)
	})
}

func (s *Server) applicationHandler(ctx context.Context, v model.ModuleInstance) (http.Handler, error) {
	construction := s.applications.instanceConstructor(v.ID)
	construction.Lock()
	defer construction.Unlock()
	// Revalidate after taking the cache lock: a request may have selected this
	// instance immediately before disable/remove/version replacement committed.
	current, currentErr := s.Modules.FindApplication(ctx, v.ModuleID)
	s.applications.Lock()
	if s.applications.handlers == nil {
		s.applications.handlers = map[string]*managedApplicationHandler{}
	}
	if currentErr != nil || current.ID != v.ID {
		s.revokeManagedApplicationLocked(v.ID)
		s.applications.Unlock()
		return nil, modules.ErrApplicationUnavailable
	}
	if current.Version != v.Version {
		staleKey := v.ID + "/" + v.Version
		if stale := s.applications.handlers[staleKey]; stale != nil {
			delete(s.applications.handlers, staleKey)
			_ = stale.Close()
		}
		s.applications.Unlock()
		return nil, modules.ErrApplicationUnavailable
	}
	cacheKey := v.ID + "/" + v.Version
	if handler := s.cachedManagedApplicationLocked(v); handler != nil {
		s.applications.Unlock()
		return handler, nil
	}
	// A cold native manifest/readiness request can be slow. Serialize only this
	// instance's construction; other ready applications retain their fast path.
	s.applications.Unlock()
	key, err := s.Modules.ApplicationKey(ctx, v.ID)
	if err != nil {
		return nil, err
	}
	tr := s.Modules.ApplicationTransport(v.ID, v.ModuleID)
	var handler http.Handler
	if v.ModuleID == "forms" {
		handler, err = s.newFormsGateway(&FormsGatewayConfig{Key: key, Upstream: "http://module-forms", Transport: tr})
	} else if v.ModuleID == "doska" {
		raw, e := s.Modules.ApplicationManifest(ctx, v.ID)
		if e != nil {
			return nil, e
		}
		var manifest DoskaGatewayManifest
		if e = doskaStrictJSON(raw, &manifest); e != nil {
			return nil, e
		}
		spool := filepath.Join(os.TempDir(), "pl-doska-"+v.ID)
		if e = os.Mkdir(spool, 0700); e != nil && !os.IsExist(e) {
			return nil, e
		}
		handler, err = s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://module-api", WebUpstream: "http://module-web", Key: key, Manifest: manifest, Transport: tr, Events: true, Attachments: &DoskaAttachmentConfig{SpoolDirectory: spool}})
	} else {
		return nil, modules.ErrApplicationUnavailable
	}
	if err != nil {
		return nil, err
	}
	wrapped := newManagedApplicationHandler(handler)
	s.applications.Lock()
	s.applications.handlers[cacheKey] = wrapped
	s.applications.Unlock()
	return wrapped, nil
}

func (s *Server) moduleDirectory(w http.ResponseWriter, r *http.Request) {
	if s.Modules == nil || r.Method != http.MethodGet || len(r.Header.Values("Authorization")) != 1 || len(r.Header.Values("Cookie")) != 0 || len(r.Header.Values("Origin")) != 0 || !s.Modules.AuthenticateDirectory(r.Context(), r.PathValue("id"), modules.BearerDirectoryToken(r.Header.Get("Authorization"))) {
		problem(w, 401, "directory_auth", "Служебная авторизация недействительна")
		return
	}
	kind := r.PathValue("kind")
	if kind != "identity" && kind != "employees" && kind != "departments" && kind != "changes" {
		problem(w, 404, "not_found", "Маршрут не найден")
		return
	}
	request := r.Clone(context.WithValue(r.Context(), sessionKey, session{User: model.User{ID: "machine:doska-directory-local", Name: "Локальный модуль Doska"}}))
	u := *r.URL
	u.Path = "/api/v1/doska-directory/" + kind
	u.RawPath = ""
	request.URL = &u
	s.doskaDirectory(w, request)
}

func (s *Server) applicationFeatures(ctx context.Context) (map[string]bool, error) {
	legacySFTP := !s.Config.PortableRelease && s.Config.SFTP != nil
	features := map[string]bool{"forms": s.Config.Forms != nil, "doska": s.Config.Doska != nil, "sftp": legacySFTP, "sftp_exchange": legacySFTP}
	if s.Modules == nil {
		return features, nil
	}
	rows, err := store.List[model.ModuleInstance](ctx, s.Store, "module_instance")
	if err != nil {
		return nil, err
	}
	for _, v := range rows {
		if (v.ModuleID == "forms" || v.ModuleID == "doska") && v.Mode == "local" && v.DesiredState != "removed" && (v.ObservedState == "running" || v.ObservedState == "disabled" || v.LastSuccess != nil) {
			features[v.ModuleID] = true
		}
	}
	return features, nil
}
