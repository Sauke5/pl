package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

// RegisterSettingsWorkspace is deliberately separate from the shared router.
// The integration patch adds one call to this method in Server.Handler.
func (s *Server) RegisterSettingsWorkspace(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/settings-workspace/history", s.auth(s.settingsWorkspaceHistory, true))
	m.HandleFunc("PUT /api/v1/settings-workspace/general", s.auth(s.settingsWorkspaceGeneral, true))
	m.HandleFunc("PUT /api/v1/settings-workspace/publication", s.auth(s.settingsWorkspacePublication, true))
	m.HandleFunc("PUT /api/v1/settings-workspace/dictionaries", s.auth(s.settingsWorkspaceDictionaries, true))
	m.HandleFunc("POST /api/v1/settings-workspace/integrations", s.auth(s.settingsWorkspaceIntegration, true))
	m.HandleFunc("PUT /api/v1/settings-workspace/integrations/{id}", s.auth(s.settingsWorkspaceIntegration, true))
	m.HandleFunc("DELETE /api/v1/settings-workspace/integrations/{id}", s.auth(s.settingsWorkspaceDeleteIntegration, true))
}

func settingsWorkspaceInvalid(w http.ResponseWriter, message string, fields map[string]string) {
	respond(w, 400, map[string]any{"error": "invalid_settings", "message": message, "field_errors": fields})
}

func settingsWorkspaceRevision(w http.ResponseWriter, revision int64) bool {
	if revision < 1 {
		problem(w, 428, "revision_required", "Укажите текущую revision")
		return false
	}
	return true
}

func (s *Server) settingsWorkspaceHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 30
	if raw := q.Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil {
			problem(w, 400, "invalid_history_filter", "Некорректный размер страницы")
			return
		}
	}
	id := q.Get("id")
	if id == "" && (q.Get("kind") == "settings" || q.Get("kind") == "dictionaries") {
		id = "global"
	}
	page, err := s.Store.SettingsHistory(r.Context(), store.SettingsHistoryFilter{Kind: q.Get("kind"), ID: id, Group: q.Get("group"), Cursor: q.Get("cursor"), Limit: limit})
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, page)
}

func (s *Server) settingsWorkspaceGeneral(w http.ResponseWriter, r *http.Request) {
	var draft struct {
		Revision          int64  `json:"revision"`
		Timezone          string `json:"timezone"`
		StaleAfterSeconds int    `json:"stale_after_seconds"`
	}
	if !decode(w, r, &draft) || !settingsWorkspaceRevision(w, draft.Revision) {
		return
	}
	fields := map[string]string{}
	if _, err := time.LoadLocation(draft.Timezone); err != nil || draft.Timezone == "" {
		fields["timezone"] = "Выберите действующий часовой пояс"
	}
	if draft.StaleAfterSeconds < 30 || draft.StaleAfterSeconds > 86400 {
		fields["stale_after_seconds"] = "Укажите от 30 до 86400 секунд"
	}
	if len(fields) > 0 {
		settingsWorkspaceInvalid(w, "Проверьте общие параметры", fields)
		return
	}
	currentSettings, err := store.Get[model.Settings](r.Context(), s.Store, "settings", "global")
	if err != nil {
		s.fail(w, err)
		return
	}
	currentSettings.Timezone, currentSettings.StaleAfterSeconds = draft.Timezone, draft.StaleAfterSeconds
	s.settingsWorkspaceSave(w, r, "settings", "global", draft.Revision, currentSettings, http.StatusOK)
}

func (s *Server) settingsWorkspacePublication(w http.ResponseWriter, r *http.Request) {
	var draft struct {
		Revision         int64    `json:"revision"`
		BoardEnabled     bool     `json:"board_enabled"`
		BoardAnonymous   bool     `json:"board_anonymous"`
		BoardTitle       string   `json:"board_title"`
		BoardResourceIDs []string `json:"board_resource_ids"`
	}
	if !decode(w, r, &draft) || !settingsWorkspaceRevision(w, draft.Revision) {
		return
	}
	fields := map[string]string{}
	if len(draft.BoardTitle) > 160 {
		fields["board_title"] = "Сократите заголовок Board"
	}
	if draft.BoardAnonymous && !draft.BoardEnabled {
		fields["board_anonymous"] = "Сначала включите публикацию Board"
	}
	if len(draft.BoardResourceIDs) > 1000 {
		fields["board_resource_ids"] = "Можно опубликовать не более 1000 ресурсов"
	}
	seen := map[string]bool{}
	for _, id := range draft.BoardResourceIDs {
		if id == "" || len(id) > 160 || seen[id] {
			fields["board_resource_ids"] = "Выберите ресурсы без повторений"
			break
		}
		seen[id] = true
	}
	if len(fields) > 0 {
		settingsWorkspaceInvalid(w, "Проверьте параметры публикации", fields)
		return
	}
	currentSettings, err := store.Get[model.Settings](r.Context(), s.Store, "settings", "global")
	if err != nil {
		s.fail(w, err)
		return
	}
	if !s.validateServiceCardAdditions(w, r, draft.BoardResourceIDs, currentSettings.BoardResourceIDs) {
		return
	}
	if draft.BoardResourceIDs == nil {
		draft.BoardResourceIDs = []string{}
	}
	currentSettings.BoardEnabled, currentSettings.BoardAnonymous = draft.BoardEnabled, draft.BoardAnonymous
	currentSettings.BoardTitle, currentSettings.BoardResourceIDs = draft.BoardTitle, draft.BoardResourceIDs
	s.settingsWorkspaceSave(w, r, "settings", "global", draft.Revision, currentSettings, http.StatusOK)
}

func (s *Server) settingsWorkspaceDictionaries(w http.ResponseWriter, r *http.Request) {
	var draft model.Dictionaries
	if !decode(w, r, &draft) || !settingsWorkspaceRevision(w, draft.Revision) {
		return
	}
	fields := map[string]string{}
	for key, list := range map[string][]string{"directions": draft.Directions, "sites": draft.Sites, "environments": draft.Environments, "types": draft.Types, "relation_types": draft.RelationTypes} {
		if len(list) > 200 {
			fields[key] = "Допустимо не более 200 значений"
			continue
		}
		seen := map[string]bool{}
		for _, item := range list {
			normalized := strings.TrimSpace(item)
			if normalized == "" || len(item) > 100 {
				fields[key] = "Укажите непустые значения и сократите слишком длинные"
				break
			}
			if seen[normalized] {
				fields[key] = "Удалите повторяющиеся значения"
				break
			}
			seen[normalized] = true
		}
	}
	if len(fields) > 0 {
		settingsWorkspaceInvalid(w, "Проверьте справочники", fields)
		return
	}
	if draft.Directions == nil {
		draft.Directions = []string{}
	}
	if draft.Sites == nil {
		draft.Sites = []string{}
	}
	if draft.Environments == nil {
		draft.Environments = []string{}
	}
	if draft.Types == nil {
		draft.Types = []string{}
	}
	if draft.RelationTypes == nil {
		current, err := store.Get[model.Dictionaries](r.Context(), s.Store, "dictionaries", "global")
		if err != nil {
			s.fail(w, err)
			return
		}
		draft.RelationTypes = current.RelationTypes
		if draft.RelationTypes == nil {
			draft.RelationTypes = []string{}
		}
	}
	s.settingsWorkspaceSave(w, r, "dictionaries", "global", draft.Revision, draft, http.StatusOK)
}

func (s *Server) settingsWorkspaceIntegration(w http.ResponseWriter, r *http.Request) {
	var draft model.Integration
	if !decode(w, r, &draft) {
		return
	}
	if draft.ManagedModuleID != "" {
		problem(w, 409, "managed_module", "Измените подключение на странице модулей")
		return
	}
	id, revision, status := r.PathValue("id"), draft.Revision, http.StatusOK
	if r.Method == http.MethodPost {
		id, revision, status = uuid.NewString(), 0, http.StatusCreated
	} else if !settingsWorkspaceRevision(w, revision) {
		return
	}
	if len(id) > 160 {
		problem(w, 400, "invalid_integration", "Некорректный идентификатор подключения")
		return
	}
	if !s.settingsIntegrationUnmanaged(w, r, id) {
		return
	}
	if err := validateIntegration(&draft); err != nil {
		settingsWorkspaceInvalid(w, err.Error(), settingsIntegrationFieldErrors(draft))
		return
	}
	draft.ID, draft.Revision = id, revision
	if !s.validateIntegrationBindings(w, r, draft) {
		return
	}
	draft.Capabilities = providers.Capabilities(draft.Kind)
	s.settingsWorkspaceSave(w, r, "integration", id, revision, draft, status)
}

func settingsIntegrationFieldErrors(draft model.Integration) map[string]string {
	fields := map[string]string{}
	if strings.TrimSpace(draft.Name) == "" || len(draft.Name) > 160 {
		fields["name"] = "Укажите непустое название и сократите его при необходимости"
	}
	if !store.Contains([]string{"prometheus", "alertmanager", "grafana", "reports", "docker", "wayline", "netbox", "oxidized", "fileauditor"}, draft.Kind) {
		fields["kind"] = "Выберите поддерживаемый адаптер"
	}
	if draft.Kind != "docker" && !safeURL(draft.URL) {
		fields["url"] = "Укажите корректный HTTP(S)-адрес"
	}
	if draft.PollSeconds < 10 || draft.PollSeconds > 86400 {
		fields["poll_seconds"] = "Укажите от 10 до 86400 секунд"
	}
	if draft.TimeoutSeconds < 1 || draft.TimeoutSeconds > 300 {
		fields["timeout_seconds"] = "Укажите от 1 до 300 секунд"
	}
	if draft.Concurrency < 1 || draft.Concurrency > 4 {
		fields["concurrency"] = "Укажите от 1 до 4"
	}
	if draft.SecretRef != "" && !strings.HasPrefix(draft.SecretRef, "env:PORTAL_SECRET_") && !strings.HasPrefix(draft.SecretRef, "file:") {
		fields["secret_ref"] = "Укажите существующую ссылку env:PORTAL_SECRET_* или file:имя"
	}
	return fields
}

func (s *Server) settingsWorkspaceSave(w http.ResponseWriter, r *http.Request, kind, id string, revision int64, value any, status int) {
	saved, err := s.Store.SaveSettingsWorkspace(r.Context(), kind, id, revision, value, current(r).User.ID)
	if err != nil {
		if errors.Is(err, store.ErrManagedModule) {
			problem(w, 409, "managed_module", "Измените подключение на странице модулей")
			return
		}
		s.fail(w, err)
		return
	}
	s.Hub.Notify(kind)
	respond(w, status, saved)
}

func (s *Server) settingsWorkspaceDeleteIntegration(w http.ResponseWriter, r *http.Request) {
	revision, err := strconv.ParseInt(strings.Trim(r.Header.Get("If-Match"), "\""), 10, 64)
	if err != nil || !settingsWorkspaceRevision(w, revision) {
		if err != nil {
			problem(w, 428, "revision_required", "Укажите If-Match с текущей revision")
		}
		return
	}
	if !s.settingsIntegrationUnmanaged(w, r, r.PathValue("id")) {
		return
	}
	if err = s.Store.DeleteSettingsWorkspace(r.Context(), "integration", r.PathValue("id"), revision, current(r).User.ID); err != nil {
		if errors.Is(err, store.ErrManagedModule) {
			problem(w, 409, "managed_module", "Удалите подключение на странице модулей")
			return
		}
		s.fail(w, err)
		return
	}
	s.Hub.Notify("integrations")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) settingsIntegrationUnmanaged(w http.ResponseWriter, r *http.Request, id string) bool {
	if id == "" {
		return true
	}
	previous, err := store.Get[model.Integration](r.Context(), s.Store, "integration", id)
	if errors.Is(err, store.ErrNotFound) {
		return true
	}
	if err != nil {
		s.fail(w, err)
		return false
	}
	if previous.ManagedModuleID != "" {
		problem(w, 409, "managed_module", "Измените подключение на странице модулей")
		return false
	}
	return true
}
