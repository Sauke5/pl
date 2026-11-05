package server

import (
	"context"
	"net/http"

	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func (s *Server) probeMailcowConnection(ctx context.Context, origin, secretRef, apiKey string, credential *store.ModuleCredential) error {
	registry := s.Providers
	if apiKey != "" {
		if s.connectorCredentials == nil || s.connectorCredentials.guard == nil || credential == nil {
			return store.ErrInvalid
		}
		guard, err := s.connectorCredentials.guard.BoundOrigin(origin, credential.ApprovedIPs)
		if err != nil {
			return err
		}
		registry = providers.New(guard, "")
	}
	return registry.MailcowProbe(ctx, model.Integration{
		Kind: "mailcow", URL: origin, Enabled: true, SecretRef: secretRef, TimeoutSeconds: 10,
	}, apiKey)
}

func mailcowConnectionProblem(w http.ResponseWriter, err error) {
	cause := providers.MailcowErrorCode(err)
	message := map[string]string{
		"auth":         "Mailcow отклонил API-ключ или адрес Платформы",
		"network":      "Не удалось подключиться к API Mailcow",
		"timeout":      "API Mailcow не ответил за отведённое время",
		"schema":       "Mailcow вернул данные API в неподдерживаемом формате",
		"unsupported":  "Сервер не предоставляет необходимые API Mailcow",
		"upstream":     "Mailcow вернул ошибку API",
		"http":         "API Mailcow вернул ошибку HTTP",
		"secret":       "Не удалось прочитать серверный API-ключ Mailcow",
		"policy":       "Доступ к API Mailcow отклонён политикой подключения",
		"body_limit":   "Ответ API Mailcow превысил допустимый размер",
		"record_limit": "API Mailcow вернул слишком много записей",
		"dependency":   "Данные очереди Mailcow недоступны: проверьте Postfix и dockerapi",
	}[cause]
	if message == "" {
		cause, message = "network", "Не удалось проверить API Mailcow"
	}
	response := map[string]any{"error": "mailcow_" + cause, "message": message}
	if status := providers.MailcowHTTPStatus(err); status != 0 {
		response["upstream_status"] = status
	}
	respond(w, http.StatusUnprocessableEntity, response)
}
