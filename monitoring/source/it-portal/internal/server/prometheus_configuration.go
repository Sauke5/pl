package server

import (
	"github.com/google/uuid"
	"net/http"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

func configurationView(i model.ModuleInstance) map[string]any {
	draft, applied := model.DefaultPrometheusConfiguration(), model.DefaultPrometheusConfiguration()
	if i.PrometheusDraft != nil {
		draft = *i.PrometheusDraft
	}
	if i.PrometheusApplied != nil {
		applied = *i.PrometheusApplied
	}
	editable := i.Mode == "local" && i.ModuleID == "prometheus" && i.DesiredState != "removed"
	reason := ""
	if !editable {
		reason = "HTTP API внешнего Prometheus не позволяет менять конфигурацию. Настройте её на его хосте; Pl показывает мониторинг и targets."
	}
	if !editable {
		return map[string]any{"editable": false, "reason": reason, "draft": nil, "applied": nil, "last_job_id": i.ConfigurationLastJobID, "last_error": i.ConfigurationError, "rolled_back": i.ConfigurationRolledBack}
	}
	return map[string]any{"editable": editable, "reason": reason, "draft": draft, "applied": applied, "last_job_id": i.ConfigurationLastJobID, "last_error": i.ConfigurationError, "rolled_back": i.ConfigurationRolledBack}
}
func (s *Server) configurationInstance(w http.ResponseWriter, r *http.Request, write bool) (model.ModuleInstance, bool) {
	var i model.ModuleInstance
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		problem(w, 400, "invalid_module", "Некорректный ID модуля")
		return i, false
	}
	i, err := store.Get[model.ModuleInstance](r.Context(), s.Store, "module_instance", id)
	if err != nil {
		s.fail(w, err)
		return i, false
	}
	if i.ModuleID != "prometheus" {
		problem(w, 400, "invalid_module", "Конфигурация доступна только для Prometheus")
		return i, false
	}
	if write && (i.Mode != "local" || i.DesiredState == "removed") {
		problem(w, 409, "configuration_readonly", "Конфигурация доступна для изменения только у локального Prometheus")
		return i, false
	}
	return i, true
}
func (s *Server) getPrometheusConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.configurationInstance(w, r, false)
	if !ok {
		return
	}
	respond(w, 200, configurationView(i))
}
func (s *Server) savePrometheusConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.configurationInstance(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Configuration model.PrometheusConfiguration `json:"configuration"`
	}
	if !decode(w, r, &input) {
		return
	}
	if err := modules.ValidateConfiguration(input.Configuration); err != nil {
		problem(w, 400, "invalid_configuration", err.Error())
		return
	}
	saved, err := s.Store.SavePrometheusDraft(r.Context(), i.ID, current(r).User.ID, input.Configuration)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 200, configurationView(saved))
}
func (s *Server) validatePrometheusConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.configurationInstance(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Configuration model.PrometheusConfiguration `json:"configuration"`
	}
	if !decode(w, r, &input) {
		return
	}
	if err := modules.ValidateConfiguration(input.Configuration); err != nil {
		problem(w, 400, "invalid_configuration", err.Error())
		return
	}
	validator, ok := s.Modules.Controller.(modules.ConfigurationValidator)
	if !ok {
		problem(w, 503, "controller_unavailable", "Host controller не поддерживает проверку конфигурации")
		return
	}
	out, err := validator.ValidateConfiguration(r.Context(), i.ID, input.Configuration)
	if err != nil {
		problem(w, 422, "configuration_validation_failed", err.Error())
		return
	}
	respond(w, 200, out)
}
func (s *Server) applyPrometheusConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.configurationInstance(w, r, true)
	if !ok {
		return
	}
	var input struct {
		Revision int64  `json:"revision"`
		Key      string `json:"idempotency_key"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !s.Modules.LocalAvailable() {
		problem(w, 503, "controller_unavailable", "Host controller не настроен")
		return
	}
	if input.Revision < 1 || !moduleKeyValid(input.Key) {
		problem(w, 400, "invalid_configuration", "Сохраните черновик и укажите ключ операции")
		return
	}
	instance, job, err := s.Store.QueueModule(r.Context(), current(r).User.ID, input.Key, i.ID, "configure", model.ModuleRequest{ConfigurationRevision: input.Revision})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}

func (s *Server) retryPrometheusConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.configurationInstance(w, r, true)
	if !ok {
		return
	}
	var input struct {
		JobID string `json:"job_id"`
	}
	if !decode(w, r, &input) {
		return
	}
	if _, err := uuid.Parse(input.JobID); err != nil {
		problem(w, 400, "invalid_job", "Некорректный ID задания")
		return
	}
	if !s.Modules.LocalAvailable() {
		problem(w, 503, "controller_unavailable", "Host controller не настроен")
		return
	}
	instance, job, err := s.Store.RetryPrometheusConfiguration(r.Context(), i.ID, current(r).User.ID, input.JobID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}
