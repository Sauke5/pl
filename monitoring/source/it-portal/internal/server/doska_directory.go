package server

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pl/portal/internal/organization"
)

type doskaIdentityDTO struct {
	SchemaVersion       int                          `json:"schema_version"`
	Subject             string                       `json:"sub"`
	Name                string                       `json:"name"`
	State               organization.AccountState    `json:"state"`
	Revision            uint64                       `json:"identity_revision"`
	DepartmentState     organization.DepartmentState `json:"department_state"`
	PrimaryDepartmentID *string                      `json:"primary_department_id"`
	HeadDepartmentIDs   []string                     `json:"head_department_ids"`
	ObservedAt          time.Time                    `json:"observed_at"`
	ValidUntil          time.Time                    `json:"valid_until"`
}

func doskaDirectoryIdentity(p organization.Projection) doskaIdentityDTO {
	heads := append([]string{}, p.HeadDepartmentIDs...)
	return doskaIdentityDTO{1, p.Subject, p.Name, p.AccountState, p.Revision,
		p.Department.State, p.Department.PrimaryDepartmentID, heads, p.LastSuccessAt.UTC(), p.ValidUntil.UTC()}
}

func doskaDirectoryDepartment(d organization.Department) map[string]any {
	return map[string]any{"id": d.ID, "name": d.Name, "revision": d.Revision, "active": d.Active, "head_subjects": append([]string{}, d.HeadSubjects...)}
}

// doskaDirectory is invoked only AFTER machineAuth. This principal check also
// prevents a different scoped machine or a browser context from reading it.
func (s *Server) doskaDirectory(w http.ResponseWriter, r *http.Request) {
	if current(r).User.ID == "machine:doska-directory-local" {
		s.localDoskaDirectory(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if current(r).User.ID != "machine:doska-directory" {
		problem(w, 403, "machine_scope", "Справочник недоступен этой учётной записи")
		return
	}
	if r.Method != http.MethodGet {
		problem(w, 405, "method_not_allowed", "Допустим только GET")
		return
	}
	var allowed []string
	switch r.URL.Path {
	case "/api/v1/doska-directory/identity":
		allowed = []string{"sub"}
	case "/api/v1/doska-directory/employees", "/api/v1/doska-directory/departments":
		allowed = []string{"cursor", "limit"}
	case "/api/v1/doska-directory/changes":
		allowed = []string{"after", "limit"}
	default:
		problem(w, 404, "not_found", "Маршрут справочника не найден")
		return
	}
	query, err := doskaDirectoryQuery(r, allowed)
	if err != nil {
		problem(w, 400, "invalid_query", "Некорректные параметры справочника")
		return
	}
	now := time.Now().UTC()
	if s.Store == nil || s.Store.Pool == nil {
		problem(w, 503, "directory_unavailable", "Справочник временно недоступен")
		return
	}
	store := organization.NewStore(s.Store.Pool)
	switch r.URL.Path {
	case "/api/v1/doska-directory/identity":
		p, err := store.Lookup(r.Context(), query.Get("sub"), now)
		if err != nil {
			doskaDirectoryError(w, err)
			return
		}
		respond(w, 200, doskaDirectoryIdentity(p))
	case "/api/v1/doska-directory/employees":
		page, err := store.ListEmployees(r.Context(), query.Get("cursor"), doskaDirectoryLimit(query), now)
		if err != nil {
			doskaDirectoryError(w, err)
			return
		}
		items := make([]doskaIdentityDTO, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, doskaDirectoryIdentity(item))
		}
		respond(w, 200, map[string]any{"schema_version": 1, "items": items, "next_cursor": page.NextCursor, "changes_cursor": page.ChangesCursor})
	case "/api/v1/doska-directory/departments":
		page, err := store.ListDepartments(r.Context(), query.Get("cursor"), doskaDirectoryLimit(query))
		if err != nil {
			doskaDirectoryError(w, err)
			return
		}
		items := make([]map[string]any, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, doskaDirectoryDepartment(item))
		}
		respond(w, 200, map[string]any{"schema_version": 1, "items": items, "next_cursor": page.NextCursor, "changes_cursor": page.ChangesCursor})
	case "/api/v1/doska-directory/changes":
		page, err := store.Changes(r.Context(), query.Get("after"), doskaDirectoryLimit(query))
		if err != nil {
			doskaDirectoryError(w, err)
			return
		}
		items := make([]map[string]any, 0, len(page.Items))
		for _, event := range page.Items {
			item := map[string]any{"cursor": event.Cursor, "event_id": event.EventID, "type": event.Type, "occurred_at": event.OccurredAt.UTC()}
			switch event.Type {
			case "identity.changed":
				p := organization.Project(event.Identity, now, organization.DefaultMaxFreshness)
				item["subject"], item["identity_revision"] = event.Identity.Subject, event.Identity.Revision
				item["previous_department_id"], item["primary_department_id"] = event.PreviousDepartmentID, p.Department.PrimaryDepartmentID
				item["identity"] = doskaDirectoryIdentity(p)
			case "department.changed":
				if event.Department == nil {
					doskaDirectoryError(w, errors.New("missing department event"))
					return
				}
				item["department"] = doskaDirectoryDepartment(*event.Department)
			default:
				doskaDirectoryError(w, errors.New("unsupported directory event"))
				return
			}
			items = append(items, item)
		}
		respond(w, 200, map[string]any{"schema_version": 1, "items": items, "next_cursor": page.NextCursor})
	}
}

func doskaDirectoryLimit(query url.Values) int {
	if value := query.Get("limit"); value != "" {
		n, _ := strconv.Atoi(value) // Strictly validated before store access.
		return n
	}
	return 100
}

func doskaDirectoryQuery(r *http.Request, allowed []string) (url.Values, error) {
	invalid := errors.New("invalid directory query")
	if r.URL.RawPath != "" || len(r.URL.RawQuery) > 8192 || r.URL.ForceQuery || r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		return nil, invalid
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, invalid
	}
	for key, values := range query {
		valid := false
		for _, name := range allowed {
			valid = valid || key == name
		}
		if !valid || len(values) != 1 || values[0] == "" {
			return nil, invalid
		}
		value := values[0]
		switch key {
		case "sub":
			if len(value) > 256 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
				return nil, invalid
			}
			for _, char := range value {
				if unicode.IsControl(char) {
					return nil, invalid
				}
			}
		case "limit":
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > 100 || strconv.Itoa(n) != value {
				return nil, invalid
			}
		case "cursor", "after":
			if len(value) > 4096 {
				return nil, invalid
			}
			for _, char := range value {
				if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
					return nil, invalid
				}
			}
		}
	}
	if len(allowed) == 1 && allowed[0] == "sub" && query.Get("sub") == "" {
		return nil, invalid
	}
	return query, nil
}

func doskaDirectoryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, organization.ErrNotFound):
		problem(w, 404, "not_found", "Сотрудник не найден")
	case errors.Is(err, organization.ErrInvalidCursor):
		problem(w, 400, "invalid_cursor", "Некорректный курсор справочника")
	case errors.Is(err, organization.ErrCursorExpired):
		problem(w, 410, "resync_required", "Необходима полная синхронизация справочника")
	case errors.Is(err, organization.ErrStale):
		problem(w, 503, "directory_stale", "Нет подтверждённых свежих данных сотрудника")
	default:
		problem(w, 503, "directory_unavailable", "Справочник временно недоступен")
	}
}
