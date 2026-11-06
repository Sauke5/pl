package server

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

func alertmanagerConfigurationView(i model.ModuleInstance) map[string]any {
	draft := model.DefaultAlertmanagerConfiguration()
	if i.AlertmanagerDraft != nil {
		draft = *i.AlertmanagerDraft
	}
	return map[string]any{"editable": i.Mode == "local" && i.ModuleID == "alertmanager" && i.DesiredState != "removed", "draft": draft, "applied": i.AlertmanagerApplied, "last_job_id": i.ConfigurationLastJobID, "last_error": i.ConfigurationError, "rolled_back": i.ConfigurationRolledBack}
}
func (s *Server) alertmanagerInstance(w http.ResponseWriter, r *http.Request) (model.ModuleInstance, bool) {
	var empty model.ModuleInstance
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		problem(w, 400, "invalid_module", "Некорректный ID модуля")
		return empty, false
	}
	i, err := store.Get[model.ModuleInstance](r.Context(), s.Store, "module_instance", r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return empty, false
	}
	if i.ModuleID != "alertmanager" || i.Mode != "local" || i.DesiredState == "removed" {
		problem(w, 409, "invalid_module", "Действие доступно только для установленного Alertmanager")
		return empty, false
	}
	return i, true
}
func (s *Server) alertmanagerController(w http.ResponseWriter) (modules.AlertmanagerController, bool) {
	c, ok := s.Modules.Controller.(modules.AlertmanagerController)
	if !ok {
		problem(w, 503, "controller_unavailable", "Host controller не поддерживает Alertmanager")
	}
	return c, ok
}
func (s *Server) getAlertmanagerConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if ok {
		respond(w, 200, alertmanagerConfigurationView(i))
	}
}
func (s *Server) saveAlertmanagerConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.alertmanagerController(w)
	if !ok {
		return
	}
	var input struct {
		Configuration model.AlertmanagerConfigurationInput `json:"configuration"`
	}
	if !decode(w, r, &input) {
		return
	}
	v := input.Configuration
	revision := int64(0)
	ref := ""
	if i.AlertmanagerDraft != nil {
		revision = i.AlertmanagerDraft.Revision
		ref = i.AlertmanagerDraft.Ref
	}
	if v.Revision != revision || v.Ref != ref {
		problem(w, 409, "conflict", "Черновик изменился; обновите страницу")
		return
	}
	if !validAlertmanagerInput(v) {
		problem(w, 400, "invalid_configuration", "Проверьте получателей, интервалы и настройки proxy")
		return
	}
	prepared, err := c.PrepareAlertmanager(r.Context(), i.ID, v)
	if err != nil {
		problem(w, 422, "invalid_configuration", "Host controller отклонил настройки Alertmanager; проверьте получателей, proxy и учётные данные")
		return
	}
	if prepared.Revision != v.Revision+1 || !canonicalUUID(prepared.Ref) || !validAlertmanagerPublic(prepared) {
		problem(w, 502, "invalid_controller_response", "Host controller не подтвердил план Alertmanager")
		return
	}
	saved, err := s.Store.SaveAlertmanagerDraft(r.Context(), i.ID, current(r).User.ID, prepared)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 200, alertmanagerConfigurationView(saved))
}

func (s *Server) validateAlertmanagerConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.alertmanagerController(w)
	if !ok {
		return
	}
	var input struct {
		Ref string `json:"configuration_ref"`
	}
	if !decode(w, r, &input) {
		return
	}
	if i.AlertmanagerDraft == nil || input.Ref != i.AlertmanagerDraft.Ref || !canonicalUUID(input.Ref) {
		problem(w, 409, "conflict", "Проверять можно текущий сохранённый черновик")
		return
	}
	if err := c.ValidateAlertmanager(r.Context(), i.ID, input.Ref); err != nil {
		problem(w, 422, "configuration_validation_failed", "Конфигурация Alertmanager не прошла amtool check-config")
		return
	}
	respond(w, 200, map[string]bool{"valid": true})
}
func (s *Server) applyAlertmanagerConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	if _, ok = s.alertmanagerController(w); !ok {
		return
	}
	var input struct {
		Revision int64  `json:"revision"`
		Key      string `json:"idempotency_key"`
	}
	if !decode(w, r, &input) {
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
func (s *Server) retryAlertmanagerConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	if _, ok = s.alertmanagerController(w); !ok {
		return
	}
	var input struct {
		JobID string `json:"job_id"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !canonicalUUID(input.JobID) {
		problem(w, 400, "invalid_job", "Некорректный ID операции")
		return
	}
	instance, job, err := s.Store.RetryAlertmanagerConfiguration(r.Context(), i.ID, current(r).User.ID, input.JobID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}
func (s *Server) getAlertmanagerStatus(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.alertmanagerController(w)
	if !ok {
		return
	}
	status, err := c.AlertmanagerStatus(r.Context(), i.ID)
	if err != nil {
		problem(w, 503, "alertmanager_unavailable", "Не удалось получить состояние Alertmanager")
		return
	}
	respond(w, 200, status)
}

func (s *Server) previewAlertmanagerEmail(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.Modules.Controller.(modules.AlertmanagerEmailController)
	if !ok {
		problem(w, 503, "controller_unavailable", "Host controller не поддерживает email preview")
		return
	}
	var input struct {
		Message model.AlertmanagerEmailMessage `json:"message"`
		Status  string                         `json:"status"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !validAlertmanagerMessage(&input.Message) || (input.Status != "firing" && input.Status != "resolved") {
		problem(w, 400, "invalid_configuration", "Проверьте оформление письма")
		return
	}
	out, err := c.PreviewAlertmanagerEmail(r.Context(), i.ID, input.Message, input.Status)
	if err != nil {
		problem(w, 422, "preview_failed", "Не удалось отобразить письмо native renderer Alertmanager")
		return
	}
	respond(w, 200, out)
}

func (s *Server) previewAlertmanagerMessage(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	var input struct {
		Kind    string                          `json:"kind"`
		Message *model.AlertmanagerEmailMessage `json:"message"`
		Status  string                          `json:"status"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !alertmanagerMessageKind(input.Kind) || input.Message == nil || !validAlertmanagerMessage(input.Message) || (input.Status != "firing" && input.Status != "resolved") {
		problem(w, 400, "invalid_configuration", "Проверьте канал и оформление уведомления")
		return
	}
	c, ok := s.Modules.Controller.(modules.AlertmanagerMessageController)
	if !ok {
		problem(w, 503, "controller_unavailable", "Предпросмотр уведомлений пока недоступен")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	out, err := c.PreviewAlertmanagerMessage(ctx, i.ID, input.Kind, *input.Message, input.Status)
	if err != nil {
		problem(w, 422, "preview_failed", "Не удалось показать пример уведомления. Повторите попытку.")
		return
	}
	respond(w, 200, out)
}

func (s *Server) testAlertmanagerEmail(w http.ResponseWriter, r *http.Request) {
	i, ok := s.alertmanagerInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.Modules.Controller.(modules.AlertmanagerEmailController)
	if !ok {
		problem(w, 503, "controller_unavailable", "Host controller не поддерживает контрольные письма")
		return
	}
	var input model.AlertmanagerEmailTest
	if !decode(w, r, &input) {
		return
	}
	if !canonicalUUID(input.TestID) || i.AlertmanagerApplied == nil || i.AlertmanagerApplied.Ref != input.ConfigurationRef || i.DesiredState != "enabled" || (input.Status != "firing" && input.Status != "resolved") {
		problem(w, 409, "conflict", "Выберите текущую применённую конфигурацию работающего Alertmanager")
		return
	}
	found := false
	for _, receiver := range i.AlertmanagerApplied.Receivers {
		if receiver.Name == input.Receiver && receiver.Kind == "email" && receiver.SMTP != nil && receiver.SMTP.Message != nil {
			found = true
		}
	}
	if !found {
		problem(w, 400, "invalid_receiver", "Сначала примените оформление выбранного email получателя")
		return
	}
	if err := c.TestAlertmanagerEmail(r.Context(), i.ID, input); err != nil {
		problem(w, 422, "notification_test_failed", "Alertmanager не принял контрольное событие; проверьте состояние и повторите через 10 секунд")
		return
	}
	respond(w, 202, map[string]any{"accepted": true, "test_id": input.TestID, "status": input.Status})
}
