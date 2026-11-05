package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

// Registered by one integration line in Handler; no auth or existing route
// contracts are changed. All workspace data retains the admin boundary.
func (s *Server) registerWorkspaceRoutes(m *http.ServeMux) {
	add := func(pattern string, h http.HandlerFunc) { m.HandleFunc(pattern, s.auth(h, true)) }
	add("GET /api/v1/system-profiles", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"profiles": providers.SystemProfiles(), "metrics": providers.SystemMetricDefinitions()})
	})
	add("GET /api/v1/systems", s.workspaceSystems)
	add("POST /api/v1/systems", s.workspaceSystems)
	add("POST /api/v1/systems/preview", s.workspaceSystemPreview)
	add("GET /api/v1/systems/{id}", s.workspaceSystems)
	add("PUT /api/v1/systems/{id}", s.workspaceSystems)
	add("DELETE /api/v1/systems/{id}", s.workspaceSystems)
	add("GET /api/v1/systems/{id}/snapshot", s.workspaceSystemSnapshot)
	add("GET /api/v1/workspace-preferences", s.workspacePreferences)
	add("PUT /api/v1/workspace-preferences", s.workspacePreferences)
	add("GET /api/v1/operations", s.workspaceOperations)
	s.registerProblemPresentationRoutes(m)
}

func uniqueWorkspaceIDs(ids []string, max int) bool {
	if len(ids) > max {
		return false
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || len(id) > 128 || seen[id] || strings.ContainsAny(id, "\x00\r\n") {
			return false
		}
		seen[id] = true
	}
	return true
}

func validateWorkspaceSystem(v model.System) bool {
	return workspaceSystemValidationMessage(v) == ""
}

func workspaceSystemValidationMessage(v model.System) string {
	if strings.TrimSpace(v.Name) == "" {
		return "Укажите название системы"
	}
	if utf8.RuneCountInString(v.Name) > 160 || utf8.RuneCountInString(v.Description) > 4000 {
		return "Название должно содержать до 160 символов, описание — до 4000 символов"
	}
	if !uniqueWorkspaceIDs(v.ResourceIDs, 200) {
		return "Выберите не более 200 разных ресурсов"
	}
	if len(v.Metrics) > 32 {
		return "Можно добавить до 32 показателей"
	}
	known := false
	for _, p := range providers.SystemProfiles() {
		if p.Key == v.Profile {
			known = true
		}
	}
	if !known {
		return "Выберите тип системы или «Пользовательская система»"
	}
	ids := []string{}
	for index, m := range v.Metrics {
		ids = append(ids, m.ID)
		prefix := "Показатель №" + strconv.Itoa(index+1) + ": "
		if utf8.RuneCountInString(m.Title) > 160 {
			return prefix + "сократите подпись до 160 символов"
		}
		if !providers.SystemMetricKnown(m.Metric) {
			return prefix + "выберите показатель из библиотеки"
		}
		if m.ResourceID != "" && !systemIncludesResource(v, m.ResourceID) {
			return prefix + "привязанный ресурс должен входить в состав системы"
		}
		if providers.ValidateSystemMetricDraft(m) != nil {
			return prefix + "проверьте названия условий и их значения"
		}
	}
	if !uniqueWorkspaceIDs(ids, 32) {
		return "У показателей должны быть разные непустые ID"
	}
	return ""
}

func (s *Server) workspaceSystems(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if r.Method == http.MethodGet {
		if id != "" {
			out, err := s.Store.Get(r.Context(), "system", id)
			if err != nil {
				s.fail(w, err)
				return
			}
			respond(w, 200, out)
			return
		}
		out, err := store.List[model.System](r.Context(), s.Store, "system")
		if err != nil {
			s.fail(w, err)
			return
		}
		sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
		respond(w, 200, out)
		return
	}
	if r.Method == http.MethodDelete {
		revision, err := strconv.ParseInt(strings.Trim(r.Header.Get("If-Match"), "\""), 10, 64)
		if err != nil || revision < 1 {
			problem(w, 428, "revision_required", "Нужна текущая revision системы")
			return
		}
		if err = s.Store.Delete(r.Context(), "system", id, revision, current(r).User.ID); err != nil {
			s.fail(w, err)
			return
		}
		s.Hub.Notify("systems")
		w.WriteHeader(204)
		return
	}
	var v model.System
	if !decode(w, r, &v) {
		return
	}
	if message := workspaceSystemValidationMessage(v); message != "" {
		problem(w, 400, "invalid_system", message)
		return
	}
	status := 200
	if r.Method == http.MethodPost {
		if v.Revision != 0 {
			problem(w, 400, "invalid_revision", "Новая система должна иметь revision 0")
			return
		}
		id = uuid.NewString()
		status = 201
	} else if v.ID != id || v.Revision < 1 {
		problem(w, 400, "invalid_revision", "Нужны ID и revision редактируемой системы")
		return
	}
	v.ID = id
	v.Name = strings.TrimSpace(v.Name)
	if v.ResourceIDs == nil {
		v.ResourceIDs = []string{}
	}
	if v.Metrics == nil {
		v.Metrics = []model.SystemMetricBinding{}
	}
	for index := range v.Metrics {
		if v.Metrics[index].Labels == nil {
			v.Metrics[index].Labels = map[string]string{}
		}
	}
	for _, resourceID := range v.ResourceIDs {
		resource, err := store.Get[model.Resource](r.Context(), s.Store, "resource", resourceID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && resource.Lifecycle == "archived") {
			problem(w, 400, "missing_resource", "Выбранный ресурс отсутствует или архивирован")
			return
		}
		if err != nil {
			s.fail(w, err)
			return
		}
	}
	for _, binding := range v.Metrics {
		if binding.IntegrationID != "" {
			i, err := store.Get[model.Integration](r.Context(), s.Store, "integration", binding.IntegrationID)
			if errors.Is(err, store.ErrNotFound) || (err == nil && i.Kind != "prometheus") {
				problem(w, 400, "invalid_source", "Показателю нужен существующий источник Prometheus")
				return
			}
			if err != nil {
				s.fail(w, err)
				return
			}
		}
	}
	out, err := s.Store.Save(r.Context(), "system", id, v.Revision, v, current(r).User.ID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("systems")
	respond(w, status, out)
}

func (s *Server) workspacePreferences(w http.ResponseWriter, r *http.Request) {
	id := current(r).User.ID
	if r.Method == http.MethodGet {
		out, err := store.Get[model.WorkspacePreferences](r.Context(), s.Store, "workspace_preferences", id)
		if errors.Is(err, store.ErrNotFound) {
			respond(w, 200, model.WorkspacePreferences{SystemIDs: []string{}, Groups: []model.FavoriteGroup{}})
			return
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, out)
		return
	}
	var v model.WorkspacePreferences
	if !decode(w, r, &v) {
		return
	}
	if !uniqueWorkspaceIDs(v.SystemIDs, 100) || len(v.Groups) > 50 {
		problem(w, 400, "invalid_preferences", "Слишком много систем или групп")
		return
	}
	previous, err := store.Get[model.WorkspacePreferences](r.Context(), s.Store, "workspace_preferences", id)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, err)
		return
	}
	previousGroups := map[string][]string{}
	for _, group := range previous.Groups {
		previousGroups[group.ID] = group.ResourceIDs
	}
	groupIDs := []string{}
	for _, group := range v.Groups {
		groupIDs = append(groupIDs, group.ID)
		if strings.TrimSpace(group.Name) == "" || len(group.Name) > 120 || !uniqueWorkspaceIDs(group.ResourceIDs, 200) {
			problem(w, 400, "invalid_group", "Проверьте название и состав группы")
			return
		}
		if _, err := uuid.Parse(group.ID); err != nil {
			problem(w, 400, "invalid_group", "Некорректный ID группы")
			return
		}
	}
	if !uniqueWorkspaceIDs(groupIDs, 50) {
		problem(w, 400, "invalid_group", "Повторяющиеся группы")
		return
	}
	for _, group := range v.Groups {
		if !s.validateServiceCardAdditions(w, r, group.ResourceIDs, previousGroups[group.ID]) {
			return
		}
	}
	if v.SystemIDs == nil {
		v.SystemIDs = []string{}
	}
	if v.Groups == nil {
		v.Groups = []model.FavoriteGroup{}
	}
	out, err := s.Store.Save(r.Context(), "workspace_preferences", id, v.Revision, v, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if err = json.Unmarshal(out, &v); err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, v)
}

type systemResourceCoverage struct {
	ResourceID string `json:"resource_id"`
	State      string `json:"state"`
}

type systemWorkspaceSnapshot struct {
	Coverage           []systemResourceCoverage   `json:"coverage"`
	System             model.System               `json:"system"`
	ObservedAt         time.Time                  `json:"observed_at"`
	State              string                     `json:"state"`
	Resources          []model.Resource           `json:"resources"`
	MissingResourceIDs []string                   `json:"missing_resource_ids"`
	Metrics            []model.SystemMetricResult `json:"metrics"`
	Problems           []model.Problem            `json:"problems"`
	Events             []model.Event              `json:"events"`
	Operations         []workspaceOperation       `json:"operations"`
}

func systemIncludesResource(system model.System, id string) bool {
	for _, candidate := range system.ResourceIDs {
		if candidate == id {
			return true
		}
	}
	return false
}

func (s *Server) workspaceSystemSnapshot(w http.ResponseWriter, r *http.Request) {
	v, err := store.Get[model.System](r.Context(), s.Store, "system", r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	out := systemWorkspaceSnapshot{System: v, ObservedAt: time.Now().UTC(), State: "no_data", Resources: []model.Resource{}, MissingResourceIDs: []string{}, Metrics: []model.SystemMetricResult{}, Problems: []model.Problem{}, Events: []model.Event{}, Operations: []workspaceOperation{}}
	for _, id := range v.ResourceIDs {
		resource, err := store.Get[model.Resource](r.Context(), s.Store, "resource", id)
		if errors.Is(err, store.ErrNotFound) || (err == nil && resource.Lifecycle == "archived") {
			out.MissingResourceIDs = append(out.MissingResourceIDs, id)
			continue
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		out.Resources = append(out.Resources, resource)
	}
	if v.Planned {
		out.State = "planned"
		out.Coverage = workspaceResourceCoverage(v, nil, out.MissingResourceIDs)
		respond(w, 200, out)
		return
	}
	out.Metrics, err = s.workspaceMetricResults(r.Context(), v.Metrics, out.ObservedAt)
	if err != nil {
		s.fail(w, err)
		return
	}
	problems, err := s.Store.Problems(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	for _, p := range problems {
		linked := systemIncludesResource(v, p.ResourceID)
		for _, id := range p.ResourceIDs {
			linked = linked || systemIncludesResource(v, id)
		}
		if linked {
			out.Problems = append(out.Problems, p)
		}
	}
	events, err := s.Store.Events(r.Context(), false)
	if err != nil {
		s.fail(w, err)
		return
	}
	for _, event := range events {
		if systemIncludesResource(v, event.ResourceID) && len(out.Events) < 20 {
			out.Events = append(out.Events, event)
		}
	}
	ops, err := s.loadWorkspaceOperations(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	for _, op := range ops {
		if systemIncludesResource(v, op.ResourceID) && len(out.Operations) < 20 {
			out.Operations = append(out.Operations, op)
		}
	}
	// No blanket "healthy" score: fresh metrics alone cannot prove every
	// component/application path. Only explicit current faults elevate state.
	out.State = workspaceMetricState(out.Metrics)
	if len(out.MissingResourceIDs) > 0 {
		out.State = "incomplete"
	}
	for _, p := range out.Problems {
		if p.Status == "firing" && !p.Stale && !p.Hidden && p.Labels["portal_silenced"] != "true" && p.Labels["portal_inhibited"] != "true" {
			out.State = "attention"
		}
	}
	for _, metric := range out.Metrics {
		if workspaceMetricRequiresAttention(metric) {
			out.State = "attention"
		}
	}
	out.Coverage = workspaceResourceCoverage(v, out.Metrics, out.MissingResourceIDs)
	for _, coverage := range out.Coverage {
		if coverage.State == "attention" {
			out.State = "attention"
		}
	}
	respond(w, 200, out)
}

// Fresh constituents do not conceal missing, stale or failed observations.
// Current faults are elevated separately after this completeness assessment.
func workspaceMetricState(metrics []model.SystemMetricResult) string {
	if len(metrics) == 0 {
		return "no_data"
	}
	fresh := 0
	for _, metric := range metrics {
		if metric.State == "fresh" {
			fresh++
		}
	}
	if fresh == len(metrics) {
		return "observed"
	}
	if fresh > 0 {
		return "incomplete"
	}
	return "no_data"
}

type workspaceOperation struct {
	model.Job
	ActorName string `json:"actor_name"`
}

func (s *Server) loadWorkspaceOperations(r *http.Request) ([]workspaceOperation, error) {
	jobs, err := s.Store.Jobs(r.Context())
	if err != nil {
		return nil, err
	}
	// Resolve names in one bounded query, keeping stable IDs for attribution.
	actors := make([]string, 0, len(jobs))
	for _, j := range jobs {
		actors = append(actors, j.Actor)
	}
	names, err := s.Store.ActorNames(r.Context(), actors)
	if err != nil {
		return nil, err
	}
	out := make([]workspaceOperation, 0, len(jobs))
	for _, j := range jobs {
		name := names[j.Actor]
		if name == "" {
			name = "Пользователь (имя не сохранено)"
		}
		out = append(out, workspaceOperation{j, name})
	}
	return out, nil
}

func (s *Server) workspaceMetricResults(ctx context.Context, bindings []model.SystemMetricBinding, now time.Time) ([]model.SystemMetricResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	sources := make([]model.Integration, len(bindings))
	for index, b := range bindings {
		if b.IntegrationID != "" {
			i, err := store.Get[model.Integration](ctx, s.Store, "integration", b.IntegrationID)
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				return nil, err
			}
			sources[index] = i
		}
	}
	out := make([]model.SystemMetricResult, len(bindings))
	slots := make(chan struct{}, 4)
	var pending sync.WaitGroup
	for index, binding := range bindings {
		pending.Add(1)
		go func() {
			defer pending.Done()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-ctx.Done():
				out[index] = model.SystemMetricResult{ID: binding.ID, ResourceID: binding.ResourceID, Metric: binding.Metric, Title: binding.Title, State: "error", Error: "Источник не ответил вовремя", Samples: []model.SystemMetricSample{}}
				return
			}
			out[index] = s.Providers.SystemMetric(ctx, sources[index], binding, now)
		}()
	}
	pending.Wait()
	return out, nil
}

func (s *Server) workspaceSystemPreview(w http.ResponseWriter, r *http.Request) {
	var v model.System
	if !decode(w, r, &v) {
		return
	}
	if message := workspaceSystemValidationMessage(v); message != "" {
		problem(w, 400, "invalid_system", message)
		return
	}
	if v.Planned {
		respond(w, 200, []model.SystemMetricResult{})
		return
	}
	out, err := s.workspaceMetricResults(r.Context(), v.Metrics, time.Now().UTC())
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, out)
}

func (s *Server) workspaceOperations(w http.ResponseWriter, r *http.Request) {
	out, err := s.loadWorkspaceOperations(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, out)
}

// A missing/stale constituent must not be concealed by a later fresh metric.
func workspaceResourceCoverage(system model.System, metrics []model.SystemMetricResult, missing []string) []systemResourceCoverage {
	rank := map[string]int{"unconfigured": 0, "unsupported": 1, "no_data": 1, "observed": 2, "stale": 3, "error": 4, "attention": 5}
	out := make([]systemResourceCoverage, 0, len(system.ResourceIDs))
	for _, id := range system.ResourceIDs {
		state := "unconfigured"
		for _, metric := range metrics {
			if metric.ResourceID != id {
				continue
			}
			candidate := metric.State
			if candidate == "fresh" {
				candidate = "observed"
				if workspaceMetricRequiresAttention(metric) {
					candidate = "attention"
				}
			}
			if rank[candidate] > rank[state] {
				state = candidate
			}
		}
		for _, absent := range missing {
			if absent == id {
				state = "no_data"
			}
		}
		if system.Planned {
			state = "planned"
		}
		out = append(out, systemResourceCoverage{id, state})
	}
	return out
}

func workspaceMetricRequiresAttention(metric model.SystemMetricResult) bool {
	if metric.State != "fresh" {
		return false
	}
	for _, sample := range metric.Samples {
		if metric.Unit == "state" && sample.Value == 0 {
			return true
		}
		if metric.Metric == "backup.result" && (sample.Labels["result"] == "Failed" || sample.Labels["result"] == "Warning") {
			return true
		}
	}
	return false
}
