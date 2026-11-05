package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"pl/portal/internal/organization"
	"pl/portal/internal/store"
)

func (s *Server) localDoskaDirectorySource() store.LocalDirectoryConfig {
	return store.LocalDirectoryConfig{UsersEnabled: s.Config.LocalUsersEnabled, BuiltinEnabled: s.Config.LocalAdminHashFile != ""}
}

// Gateway assertions and native Directory reads share the same source, revision
// and lease. A Portal admin claim never substitutes for a current account.
func (s *Server) localDoskaIdentity(ctx context.Context, subject string, now time.Time) (organization.Projection, error) {
	identity, err := s.Store.LocalDirectoryIdentity(ctx, s.localDoskaDirectorySource(), subject, now)
	if errors.Is(err, store.ErrNotFound) {
		return organization.Projection{}, organization.ErrNotFound
	}
	if err != nil {
		return organization.Projection{}, err
	}
	candidates := []string{}
	if identity.PrimaryDepartmentID != nil {
		candidates = append(candidates, *identity.PrimaryDepartmentID)
	}
	return organization.Project(organization.Identity{
		Subject: identity.Subject, Name: identity.Name, Revision: uint64(identity.Revision),
		AccountState:      organization.AccountState(identity.State),
		Department:        organization.ResolveDepartment(candidates, nil),
		HeadDepartmentIDs: append([]string{}, identity.HeadDepartmentIDs...), LastSuccessAt: identity.ObservedAt,
	}, now, identity.ValidUntil.Sub(identity.ObservedAt)), nil
}

// The module controller authenticates its per-instance bearer before assigning
// this principal. The legacy AD directory principal retains its existing source.
func (s *Server) localDoskaDirectory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if current(r).User.ID != "machine:doska-directory-local" {
		problem(w, 403, "machine_scope", "Локальный справочник недоступен этой учётной записи")
		return
	}
	if len(r.Header.Values("Cookie")) != 0 || len(r.Header.Values("Origin")) != 0 {
		problem(w, 403, "machine_scope", "Локальный справочник доступен только служебному клиенту")
		return
	}
	if r.Method != http.MethodGet {
		problem(w, 405, "method_not_allowed", "Допустим только GET")
		return
	}
	var allowed []string
	var kind string
	switch r.URL.Path {
	case "/api/v1/doska-directory/identity":
		allowed = []string{"sub"}
	case "/api/v1/doska-directory/employees":
		allowed = []string{"cursor", "limit"}
		kind = "employees"
	case "/api/v1/doska-directory/departments":
		allowed = []string{"cursor", "limit"}
		kind = "departments"
	case "/api/v1/doska-directory/changes":
		allowed = []string{"after", "limit"}
	default:
		problem(w, 404, "not_found", "Маршрут локального справочника не найден")
		return
	}
	query, err := doskaDirectoryQuery(r, allowed)
	if err != nil {
		problem(w, 400, "invalid_query", "Некорректные параметры локального справочника")
		return
	}
	if s.Store == nil || s.Store.Pool == nil {
		problem(w, 503, "directory_unavailable", "Локальный справочник недоступен")
		return
	}
	source := s.localDoskaDirectorySource()
	now := time.Now().UTC()
	if r.URL.Path == "/api/v1/doska-directory/identity" {
		identity, e := s.Store.LocalDirectoryIdentity(r.Context(), source, query.Get("sub"), now)
		if e != nil {
			s.localDoskaDirectoryError(w, e)
			return
		}
		respond(w, 200, identity)
		return
	}
	var page store.LocalDirectoryPage
	if kind != "" {
		page, err = s.Store.LocalDirectorySnapshot(r.Context(), source, kind, query.Get("cursor"), doskaDirectoryLimit(query), now)
	} else {
		page, err = s.Store.LocalDirectoryChanges(r.Context(), source, query.Get("after"), doskaDirectoryLimit(query), now)
	}
	if err != nil {
		s.localDoskaDirectoryError(w, err)
		return
	}
	result := map[string]any{"schema_version": 1, "items": page.Items, "next_cursor": page.NextCursor}
	if kind != "" {
		result["changes_cursor"] = page.ChangesCursor
	}
	respond(w, 200, result)
}
func (s *Server) localDoskaDirectoryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrLocalDirectoryResync):
		problem(w, 410, "resync_required", "Обновите снимок локального справочника")
	case errors.Is(err, store.ErrNotFound):
		problem(w, 404, "identity_not_found", "Локальная учётная запись не найдена")
	case errors.Is(err, store.ErrInvalid):
		problem(w, 400, "invalid_query", "Некорректные параметры локального справочника")
	default:
		s.fail(w, err)
	}
}
