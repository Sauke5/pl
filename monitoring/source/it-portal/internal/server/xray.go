package server

import (
	"errors"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

func xrayConfigurationView(i model.ModuleInstance) map[string]any {
	draft := model.DefaultXrayConfiguration()
	if i.XrayDraft != nil {
		draft = *i.XrayDraft
	}
	return map[string]any{"editable": i.Mode == "local" && i.ModuleID == "xray" && i.DesiredState != "removed", "draft": draft, "applied": i.XrayApplied, "last_job_id": i.ConfigurationLastJobID, "last_error": i.ConfigurationError, "rolled_back": i.ConfigurationRolledBack}
}
func (s *Server) xrayInstance(w http.ResponseWriter, r *http.Request) (model.ModuleInstance, bool) {
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
	if i.ModuleID != "xray" || i.Mode != "local" || i.DesiredState == "removed" {
		problem(w, 409, "invalid_module", "Действие доступно только для установленного Xray")
		return empty, false
	}
	return i, true
}
func (s *Server) xrayController(w http.ResponseWriter) (modules.XrayController, bool) {
	c, ok := s.Modules.Controller.(modules.XrayController)
	if !ok {
		problem(w, 503, "controller_unavailable", "Host controller не поддерживает Xray")
	}
	return c, ok
}
func (s *Server) getXrayConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.xrayInstance(w, r)
	if ok {
		respond(w, 200, xrayConfigurationView(i))
	}
}
func (s *Server) saveXrayConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.xrayInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.xrayController(w)
	if !ok {
		return
	}
	var input struct {
		Configuration model.XrayConfigurationInput `json:"configuration"`
	}
	if !decode(w, r, &input) {
		return
	}
	v := input.Configuration
	revision := int64(0)
	ref := ""
	if i.XrayDraft != nil {
		revision = i.XrayDraft.Revision
		ref = i.XrayDraft.Ref
	}
	if v.Revision != revision || v.Ref != ref {
		problem(w, 409, "conflict", "Черновик изменился; обновите страницу")
		return
	}
	if !validXrayInput(v) {
		problem(w, 400, "invalid_configuration", "Проверьте inbound, outbound и маршрутизацию Xray")
		return
	}
	prepared, err := c.PrepareXray(r.Context(), i.ID, v)
	if err != nil {
		var diagnostic *modules.XrayConfigurationError
		if errors.As(err, &diagnostic) && diagnostic.Known() {
			problem(w, 422, diagnostic.Code, diagnostic.Error())
			return
		}
		problem(w, 422, "invalid_configuration", "Host controller отклонил настройки Xray; проверьте адреса, порты и ссылку подключения")
		return
	}
	if prepared.Revision != v.Revision+1 || !canonicalUUID(prepared.Ref) {
		problem(w, 502, "invalid_controller_response", "Host controller не подтвердил план Xray")
		return
	}
	saved, err := s.Store.SaveXrayDraft(r.Context(), i.ID, current(r).User.ID, prepared)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 200, xrayConfigurationView(saved))
}
func canonicalUUID(v string) bool { u, e := uuid.Parse(v); return e == nil && u.String() == v }

var xrayInboundTag = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

func validXrayInput(c model.XrayConfigurationInput) bool {
	if c.Revision < 0 || c.Revision >= (1<<53)-1 || c.Inbounds == nil || len(c.Inbounds) > 16 || (c.Routing != "proxy_all" && c.Routing != "private_direct") || (c.Outbound.Mode != "direct" && c.Outbound.Mode != "imported") || len(c.Outbound.Link) > 16384 {
		return false
	}
	if c.Outbound.Mode == "direct" && c.Outbound.Link != "" {
		return false
	}
	tags := map[string]bool{"api": true, "proxy": true, "direct": true, "block": true}
	bindings := map[string]bool{}
	for _, i := range c.Inbounds {
		if !xrayInboundTag.MatchString(i.Tag) || tags[i.Tag] || (i.Protocol != "socks" && i.Protocol != "http") || i.Port < 1024 || i.Port > 65535 || i.Port == 10085 || (i.Auth != "none" && i.Auth != "password") || len(i.Username) > 128 || len(i.Password) > 1024 || strings.ContainsFunc(i.Username, unicode.IsControl) {
			return false
		}
		ip := net.ParseIP(i.Listen)
		if ip == nil || ip.To4() == nil || ip.String() != i.Listen || (i.Listen != "127.0.0.1" && !ip.IsPrivate()) {
			return false
		}
		if i.Auth == "none" && (i.Username != "" || i.Password != "") {
			return false
		}
		if i.Auth == "password" && i.Username == "" {
			return false
		}
		tags[i.Tag] = true
		// Binding and local-interface ownership are authoritatively checked by root.
		key := i.Listen + ":" + strconv.Itoa(i.Port)
		if bindings[key] {
			return false
		}
		bindings[key] = true
	}
	return true
}
func (s *Server) validateXrayConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.xrayInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.xrayController(w)
	if !ok {
		return
	}
	var input struct {
		Ref string `json:"configuration_ref"`
	}
	if !decode(w, r, &input) {
		return
	}
	if i.XrayDraft == nil || input.Ref != i.XrayDraft.Ref || !canonicalUUID(input.Ref) {
		problem(w, 409, "conflict", "Проверять можно текущий сохранённый черновик")
		return
	}
	if err := c.ValidateXray(r.Context(), i.ID, input.Ref); err != nil {
		var diagnostic *modules.XrayConfigurationError
		if errors.As(err, &diagnostic) && diagnostic.Known() {
			problem(w, 422, diagnostic.Code, diagnostic.Error())
			return
		}
		problem(w, 422, "configuration_validation_failed", "Не удалось завершить проверку Xray. Проверьте состояние модуля и host controller. Работающий сервис не изменён.")
		return
	}
	respond(w, 200, map[string]bool{"valid": true})
}
func (s *Server) applyXrayConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.xrayInstance(w, r)
	if !ok {
		return
	}
	if _, ok = s.xrayController(w); !ok {
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
func (s *Server) retryXrayConfiguration(w http.ResponseWriter, r *http.Request) {
	i, ok := s.xrayInstance(w, r)
	if !ok {
		return
	}
	if _, ok = s.xrayController(w); !ok {
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
	instance, job, err := s.Store.RetryXrayConfiguration(r.Context(), i.ID, current(r).User.ID, input.JobID)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}
func (s *Server) getXrayStatus(w http.ResponseWriter, r *http.Request) {
	i, ok := s.xrayInstance(w, r)
	if !ok {
		return
	}
	c, ok := s.xrayController(w)
	if !ok {
		return
	}
	status, err := c.XrayStatus(r.Context(), i.ID)
	if err != nil {
		problem(w, 503, "xray_unavailable", "Не удалось получить состояние Xray")
		return
	}
	respond(w, 200, status)
}
