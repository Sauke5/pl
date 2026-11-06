package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func (s *Server) jobs(w http.ResponseWriter, r *http.Request) {
	s.reconcileDelivery(r.Context())
	if id := r.PathValue("id"); id != "" {
		j, e := s.Store.Job(r.Context(), id)
		if e != nil {
			s.fail(w, e)
			return
		}
		respond(w, 200, j)
		return
	}
	items, e := s.Store.Jobs(r.Context())
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, items)
}
func (s *Server) jobOutput(w http.ResponseWriter, r *http.Request) {
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		problem(w, 400, "invalid_job", "Некорректный ID задания")
		return
	}
	raw, err := s.Store.JobOutput(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, map[string]string{"raw_output": raw})
}
func (s *Server) enqueue(w http.ResponseWriter, r *http.Request) {
	var j model.Job
	if !decode(w, r, &j) {
		return
	}
	s.enqueueJob(w, r, j)
}
func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	s.enqueueJob(w, r, model.Job{Kind: "refresh", IntegrationID: r.PathValue("id"), IdempotencyKey: uuid.NewString(), Parameters: map[string]any{}})
}
func (s *Server) enqueueJob(w http.ResponseWriter, r *http.Request, j model.Job) {
	if !store.Contains([]string{"check", "enrich", "report", "restart", "refresh"}, j.Kind) || len(j.IdempotencyKey) < 8 || len(j.IdempotencyKey) > 128 {
		problem(w, 400, "invalid_job", "Укажите известную операцию и idempotency_key (8–128 символов)")
		return
	}
	if j.Parameters == nil {
		j.Parameters = map[string]any{}
	}
	allowed := map[string]bool{}
	switch j.Kind {
	case "check":
		allowed = map[string]bool{"kind": true, "target": true}
		if j.Parameters["kind"] == "iperf" {
			allowed["direction"], allowed["duration_seconds"] = true, true
		}
	case "enrich":
		allowed = map[string]bool{"target": true}
	case "report":
		allowed = map[string]bool{"target_date": true}
	}
	for k, v := range j.Parameters {
		if !allowed[k] {
			problem(w, 400, "invalid_parameters", "Недопустимый параметр операции")
			return
		}
		if j.Kind == "check" && j.Parameters["kind"] == "iperf" && k == "duration_seconds" {
			n, ok := v.(float64)
			if !ok || (n != 5 && n != 10 && n != 15) {
				problem(w, 400, "invalid_parameters", "Длительность проверки должна быть числом: 5, 10 или 15 секунд")
				return
			}
			continue
		}
		sv, ok := v.(string)
		if !ok || len(sv) > 4096 {
			problem(w, 400, "invalid_parameters", "Параметры должны быть строками ограниченного размера")
			return
		}
	}
	var resource *model.Resource
	if j.ResourceID != "" {
		v, e := store.Get[model.Resource](r.Context(), s.Store, "resource", j.ResourceID)
		if e != nil {
			s.fail(w, e)
			return
		}
		if v.Lifecycle != "active" {
			problem(w, 409, "archived", "Ресурс архивирован")
			return
		}
		resource = &v
	}
	var integration *model.Integration
	if j.IntegrationID != "" {
		v, e := store.Get[model.Integration](r.Context(), s.Store, "integration", j.IntegrationID)
		if e != nil {
			s.fail(w, e)
			return
		}
		if !v.Enabled {
			problem(w, 409, "integration_disabled", "Интеграция выключена")
			return
		}
		if v.ManagedModuleID != "" {
			if j.Kind != "refresh" {
				problem(w, 409, "managed_module", "Операция доступна на странице модулей")
				return
			}
			if _, ok := r.Header["Authorization"]; ok {
				problem(w, 403, "forbidden", "Управление модулем требует сессию администратора")
				return
			}
			_, job, e := s.Store.QueueModule(r.Context(), current(r).User.ID, j.IdempotencyKey, v.ManagedModuleID, "refresh", model.ModuleRequest{})
			if e != nil {
				s.fail(w, e)
				return
			}
			s.Hub.Notify("all")
			respond(w, 202, job)
			return
		}
		integration = &v
	}
	switch j.Kind {
	case "restart":
		if !j.Confirmed || resource == nil || !store.Contains(resource.Operations, "restart") || resource.ExecutorTarget == "" {
			problem(w, 403, "confirmation_required", "Требуются разрешённая цель и подтверждение перезапуска")
			return
		}
		if s.Config.ExecutorURL == "" {
			problem(w, 409, "executor_not_configured", "Настройте ограниченный executor")
			return
		}
		j.Parameters["executor_target"] = resource.ExecutorTarget
	case "report":
		if integration == nil || integration.Kind != "reports" {
			problem(w, 409, "report_not_configured", "Выберите настроенный генератор отчётов")
			return
		}
		if date, ok := j.Parameters["target_date"].(string); ok && date != "" {
			d, e := time.Parse("2006-01-02", date)
			if e != nil || d.After(time.Now().Add(24*time.Hour)) {
				problem(w, 400, "invalid_period", "Некорректная дата отчёта")
				return
			}
		}
	case "refresh":
		if integration == nil {
			problem(w, 400, "integration_required", "Выберите интеграцию")
			return
		}
	case "check":
		kind, _ := j.Parameters["kind"].(string)
		target, _ := j.Parameters["target"].(string)
		if resource != nil {
			if kind == "" {
				kind = resource.Check.Kind
			}
			if strings.TrimSpace(target) == "" {
				target = providers.ResourceCheckTarget(*resource)
			}
		}
		if !store.Contains([]string{"dns", "tcp", "http", "tls", "reverse_dns", "dns_records", "nmap", "iperf", "icmp"}, kind) || strings.TrimSpace(target) == "" {
			problem(w, 400, "invalid_check", "Укажите тип и цель проверки")
			return
		}
		if err := providers.ValidateCheckTarget(kind, target); err != nil {
			problem(w, 400, "invalid_check", err.Error())
			return
		}
		if kind == "icmp" && s.Config.ICMPExecutorURL == "" {
			problem(w, 409, "icmp_not_configured", "ICMP-проверка на хосте Платформы не настроена")
			return
		}
		if kind == "iperf" {
			if err := providers.ValidateIperfParameters(target, j.Parameters); err != nil {
				problem(w, 400, "invalid_iperf", "Укажите хост с портом 5201–5205, направление и длительность 5, 10 или 15 секунд")
				return
			}
		}
		j.Parameters["kind"] = kind
		j.Parameters["target"] = target
	case "enrich":
		target, _ := j.Parameters["target"].(string)
		if target == "" && resource != nil {
			target = resource.URL
		}
		if !safeURL(target) {
			problem(w, 400, "invalid_target", "Укажите HTTP(S)-адрес")
			return
		}
		j.Parameters["target"] = target
	}
	j.Actor = current(r).User.ID
	j.ID = ""
	j.Status = ""
	j.Error = ""
	j.Result = nil
	j.StartedAt = nil
	j.FinishedAt = nil
	out, e := s.Store.Enqueue(r.Context(), j)
	if e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify("jobs")
	respond(w, 202, out)
}
func (s *Server) resolveCandidates(w http.ResponseWriter, r *http.Request) {
	var p struct {
		IDs        []string `json:"ids"`
		Action     string   `json:"action"`
		ResourceID string   `json:"resource_id"`
	}
	if !decode(w, r, &p) {
		return
	}
	if len(p.IDs) == 0 || len(p.IDs) > 200 || !store.Contains([]string{"add", "link", "ignore", "restore"}, p.Action) {
		problem(w, 400, "invalid_resolution", "Выберите кандидатов и действие")
		return
	}
	if p.Action == "add" {
		for _, id := range p.IDs {
			c, e := store.Get[model.Candidate](r.Context(), s.Store, "candidate", id)
			if e != nil {
				s.fail(w, e)
				return
			}
			v := store.CandidateResourceProposal(c)
			if e = validateResource(&v); e != nil {
				problem(w, 400, "invalid_candidate", e.Error())
				return
			}
		}
	}
	out, e := s.Store.ResolveCandidates(r.Context(), p.IDs, p.Action, p.ResourceID, current(r).User.ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	s.Hub.Notify("all")
	respond(w, 200, out)
}
