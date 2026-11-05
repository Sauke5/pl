package server

import (
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

func (s *Server) moduleAuth(next http.HandlerFunc) http.HandlerFunc {
	protected := s.auth(next, true)
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.Header["Authorization"]; ok {
			problem(w, 403, "forbidden", "Управление модулями доступно только через сессию администратора")
			return
		}
		if s.Modules == nil {
			problem(w, 503, "modules_unavailable", "Каталог модулей не настроен")
			return
		}
		protected(w, r)
	}
}
func (s *Server) moduleCatalog(w http.ResponseWriter, r *http.Request) {
	items := model.ModuleCatalog()
	versions := s.availableModuleVersions(r.Context())
	for index := range items {
		items[index].Version = versions[items[index].ID]
		if s.Config.OnDemandModules && items[index].Version == "" {
			available := make([]string, 0, len(items[index].Modes))
			for _, mode := range items[index].Modes {
				if mode != "local" {
					available = append(available, mode)
				}
			}
			items[index].Modes = available
		}
		if items[index].ID == "bookstack" || items[index].ID == "netmap" {
			items[index].Modes = []string{}
			if items[index].Version != "" {
				items[index].Modes = append(items[index].Modes, "local")
			}
			if s.Config.PortableRelease && (items[index].ID == "bookstack" && s.Modules.BookStack != nil || items[index].ID == "netmap" && s.Modules.NetMap != nil && s.connectorCredentials != nil) {
				items[index].Modes = append(items[index].Modes, "external")
			}
			continue
		}
		if (items[index].ID == "wayline" || items[index].ID == "grafana" || items[index].ID == "forms" || items[index].ID == "doska" || items[index].ID == "sftpgo" || items[index].ID == "netmap" || items[index].ID == "bookstack") && items[index].Version == "" {
			if items[index].ID == "wayline" {
				items[index].Modes = []string{"external"}
			} else {
				items[index].Modes = []string{}
			}
		}
	}
	respond(w, 200, map[string]any{"items": items, "local_available": s.Modules.LocalAvailable(), "managed_credentials_available": s.connectorCredentials != nil})
}
func (s *Server) listModules(w http.ResponseWriter, r *http.Request) {
	items, err := store.List[model.ModuleInstance](r.Context(), s.Store, "module_instance")
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, map[string]any{"items": items})
}
func moduleKeyValid(key string) bool {
	return len(key) >= 8 && len(key) <= 128 && strings.TrimSpace(key) == key && !strings.ContainsFunc(key, unicode.IsControl)
}
func (s *Server) createModule(w http.ResponseWriter, r *http.Request) {
	var input struct {
		model.ModuleRequest
		Key        string `json:"idempotency_key"`
		APIKey     string `json:"api_key"`
		GatewayKey string `json:"gateway_key"`
	}
	if !decode(w, r, &input) {
		return
	}
	if !model.ModuleModeSupported(input.ModuleID, input.Mode) || !moduleKeyValid(input.Key) || utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 128 || strings.TrimSpace(input.Name) != input.Name || strings.ContainsFunc(input.Name, unicode.IsControl) {
		problem(w, 400, "invalid_module", "Проверьте модуль, название и ключ операции")
		return
	}
	if input.APIKey != "" && (input.ModuleID != "mailcow" || input.Mode != "external" || input.SecretRef != "" || !validConnectorKey(input.APIKey)) {
		problem(w, 400, "invalid_api_key", "Укажите один read-only API-ключ Mailcow или подготовленный серверный секрет")
		return
	}
	if input.GatewayKey != "" || input.ModuleID == "netmap" && input.Mode == "external" {
		key, err := modules.NetMapGatewayKey(input.GatewayKey)
		clear(key)
		if err != nil || input.ModuleID != "netmap" || input.Mode != "external" || input.SecretRef != "" || input.APIKey != "" {
			problem(w, 400, "invalid_gateway_key", "Для внешнего NetMap нужен отдельный gateway key из 64 hex символов")
			return
		}
	}
	if input.Mode == "local" && (s.Config.OnDemandModules || input.ModuleID == "wayline" || input.ModuleID == "grafana" || input.ModuleID == "forms" || input.ModuleID == "doska" || input.ModuleID == "sftpgo" || input.ModuleID == "netmap" || input.ModuleID == "bookstack") && s.availableModuleVersions(r.Context())[input.ModuleID] == "" {
		problem(w, 409, "module_unavailable", "В каталоге поставки нет совместимой версии модуля. Проверьте обновления в настройках PL.")
		return
	}
	if (input.ModuleID == "grafana" || input.ModuleID == "forms" || input.ModuleID == "doska" || input.ModuleID == "sftpgo" || input.ModuleID == "netmap" || input.ModuleID == "bookstack") && input.AdditionalInstance {
		problem(w, 400, "additional_instance_unsupported", "На этой установке поддерживается один экземпляр этого приложения")
		return
	}
	if input.Mode == "local" {
		if !s.Modules.LocalAvailable() {
			problem(w, 409, "controller_unavailable", "Локальная установка требует host controller")
			return
		}
		if input.Endpoint != "" {
			problem(w, 400, "invalid_endpoint", "Адрес локального модуля назначается платформой")
			return
		}
	} else {
		endpoint, err := modules.ValidateEndpoint(input.Endpoint)
		if input.ModuleID == "bookstack" || input.ModuleID == "netmap" {
			endpoint, err = connectorcredentials.CanonicalOrigin(input.Endpoint)
		}
		if input.ModuleID == "fileauditor" {
			endpoint, err = modules.ValidateAuditorEndpoint(input.Endpoint)
		}
		if err != nil {
			problem(w, 400, "invalid_endpoint", err.Error())
			return
		}
		input.Endpoint = endpoint
	}
	if input.SecretRef != "" && (input.Mode != "external" || (input.ModuleID != "wayline" && input.ModuleID != "fileauditor" && input.ModuleID != "mailcow")) {
		problem(w, 400, "invalid_secret_ref", "Ссылка на секрет недоступна для этого модуля")
		return
	}
	if len(input.SecretRef) > 256 || strings.ContainsFunc(input.SecretRef, unicode.IsControl) || (input.SecretRef != "" && !strings.HasPrefix(input.SecretRef, "file:") && !strings.HasPrefix(input.SecretRef, "env:PORTAL_SECRET_")) {
		problem(w, 400, "invalid_secret_ref", "Укажите ссылку на подготовленный серверный секрет")
		return
	}
	if input.ModuleID == "fileauditor" && (!strings.HasPrefix(input.SecretRef, "file:") || input.SecretRef == "file:") {
		problem(w, 400, "invalid_secret_ref", "Auditor требует ссылку file: на подготовленный ключ шлюза")
		return
	}
	var credential *store.ModuleCredential
	if input.ModuleID == "mailcow" {
		if s.Providers == nil {
			problem(w, 503, "connector_unavailable", "Проверка API Mailcow на этой установке недоступна")
			return
		}
		origin, err := connectorcredentials.CanonicalOrigin(input.Endpoint)
		if err != nil || (input.APIKey == "" && !validMailcowSecretRef(input.SecretRef)) {
			problem(w, 400, "invalid_mailcow", "Укажите адрес Mailcow и read-only API-ключ")
			return
		}
		input.Endpoint = origin
		if input.APIKey != "" {
			if s.connectorCredentials == nil {
				problem(w, 409, "credential_storage_unavailable", "На этой установке ещё не включено сохранение API-ключей")
				return
			}
			credential, err = s.prepareConnectorCredential(r.Context(), origin, input.APIKey)
			if err != nil {
				problem(w, 400, "invalid_connection_address", "Не удалось разрешить адрес сервера или адрес недоступен для внешнего подключения")
				return
			}
		}
	}
	for key, value := range input.Config {
		if input.ModuleID != "wayline" || key != "basic_username" || len(value) > 128 || strings.ContainsAny(value, ":\r\n") {
			problem(w, 400, "invalid_config", "Неподдерживаемый параметр коннектора")
			return
		}
	}
	if input.ModuleID == "wayline" && ((input.SecretRef != "") != (input.Config["basic_username"] != "")) {
		problem(w, 400, "invalid_config", "Укажите вместе логин и ссылку на пароль Wayline")
		return
	}
	if input.ModuleID == "mailcow" {
		instance, job, replayed, err := s.Store.ReplayModuleRequest(r.Context(), current(r).User.ID, input.Key, input.ModuleRequest, credential)
		if err != nil {
			s.fail(w, err)
			return
		}
		if replayed {
			respond(w, 202, map[string]any{"instance": instance, "job": job})
			return
		}
		if err := s.probeMailcowConnection(r.Context(), input.Endpoint, input.SecretRef, input.APIKey, credential); err != nil {
			mailcowConnectionProblem(w, err)
			return
		}
	}
	if input.ModuleID == "bookstack" && input.Mode == "external" {
		if !s.Config.PortableRelease || s.Modules.BookStack == nil {
			problem(w, 409, "connector_unavailable", "Подключение внешней Wiki на этой установке недоступно")
			return
		}
		origin, config, err := s.Modules.BookStack.Approve(r.Context(), input.Endpoint, s.Config.PublicURL)
		if err != nil {
			problem(w, 400, "invalid_connection_address", err.Error())
			return
		}
		input.Endpoint, input.Config = origin, config
	}
	if input.ModuleID == "netmap" && input.Mode == "external" {
		if !s.Config.PortableRelease || s.connectorCredentials == nil || s.Modules.NetMap == nil {
			problem(w, 409, "connector_unavailable", "Подключение внешнего NetMap на этой установке недоступно")
			return
		}
		origin, prepared, err := s.prepareNetMapCredential(r.Context(), input.Endpoint, input.GatewayKey)
		if err != nil {
			problem(w, 400, "invalid_netmap_connection", modules.ErrNetMapConnection.Error())
			return
		}
		input.Endpoint, credential = origin, prepared
		input.Config = map[string]string{"platform_origin": s.Config.PublicURL}
	}
	instance, job, err := s.Store.QueueModuleWithCredential(r.Context(), current(r).User.ID, input.Key, "", "install", input.ModuleRequest, credential)
	if err != nil {
		var exists *store.ModuleExistsError
		if errors.As(err, &exists) {
			respond(w, 409, map[string]any{"code": "module_exists", "message": "Этот модуль уже подключён. Откройте его или подтвердите создание дополнительного экземпляра.", "existing_instance_id": exists.InstanceID})
			return
		}
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}
func (s *Server) moduleAction(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Action      string `json:"action"`
		Key         string `json:"idempotency_key"`
		ConfirmName string `json:"confirm_name"`
		Endpoint    string `json:"endpoint"`
		Revision    int64  `json:"revision"`
	}
	if !decode(w, r, &input) {
		return
	}
	if _, err := uuid.Parse(r.PathValue("id")); err != nil {
		problem(w, 400, "invalid_module", "Некорректный ID модуля")
		return
	}
	if !moduleKeyValid(input.Key) || (input.Action != "enable" && input.Action != "disable" && input.Action != "refresh" && input.Action != "remove" && input.Action != "reconnect") {
		problem(w, 400, "invalid_action", "Неизвестное действие или ключ операции")
		return
	}
	if input.Action == "remove" && input.ConfirmName == "" {
		problem(w, 400, "confirmation_required", "Введите точное название модуля для полного удаления")
		return
	}
	request := model.ModuleRequest{ConfirmName: input.ConfirmName}
	if input.Action == "reconnect" {
		instance, err := store.Get[model.ModuleInstance](r.Context(), s.Store, "module_instance", r.PathValue("id"))
		if err != nil {
			s.fail(w, err)
			return
		}
		if !s.Config.PortableRelease || instance.ModuleID != "bookstack" || instance.Mode != "external" || s.Modules.BookStack == nil || input.Revision < 1 {
			problem(w, 400, "invalid_connection", "Изменение адреса доступно только внешнему подключению Wiki")
			return
		}
		origin, config, err := s.Modules.BookStack.Approve(r.Context(), input.Endpoint, s.Config.PublicURL)
		if err != nil {
			problem(w, 400, "invalid_connection_address", err.Error())
			return
		}
		request.Endpoint, request.Config, request.ConnectionRevision = origin, config, input.Revision
	} else if input.Endpoint != "" || input.Revision != 0 {
		problem(w, 400, "invalid_action", "Адрес и ревизия используются только при изменении подключения")
		return
	}
	instance, job, err := s.Store.QueueModule(r.Context(), current(r).User.ID, input.Key, r.PathValue("id"), input.Action, request)
	if err != nil {
		s.fail(w, err)
		return
	}
	if input.Action == "disable" || input.Action == "remove" {
		s.revokeManagedApplication(instance.ID)
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}
