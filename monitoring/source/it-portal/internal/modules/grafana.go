package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

var ErrGrafanaUnavailable = errors.New("Grafana недоступна")

const GrafanaSessionCookie = "grafana_session"

var grafanaSessionValue = regexp.MustCompile(`^[A-Za-z0-9._~+/=-]{1,512}$`)

type grafanaSessionKey struct{}
type grafanaSession struct {
	value     string
	setCookie func(*http.Cookie)
}

func ValidGrafanaSession(value string) bool { return grafanaSessionValue.MatchString(value) }

// WithGrafanaSession keeps the Grafana identity scoped to a single chart request,
// including any session rotation between dashboard, datasource and query reads.
func WithGrafanaSession(ctx context.Context, value string, setCookie func(*http.Cookie)) context.Context {
	return context.WithValue(ctx, grafanaSessionKey{}, &grafanaSession{value, setCookie})
}

func (session *grafanaSession) renew(raw string) {
	if len(raw) > 1024 {
		return
	}
	cookie, err := http.ParseSetCookie(raw)
	if err != nil || cookie.Domain != "" || (cookie.Path != "/grafana" && cookie.Path != "/grafana/") {
		return
	}
	switch cookie.Name {
	case GrafanaSessionCookie:
		if cookie.Value != "" && !ValidGrafanaSession(cookie.Value) {
			return
		}
		session.value = cookie.Value
	case "grafana_session_expiry":
		if cookie.Value != "" {
			if _, err := strconv.ParseInt(cookie.Value, 10, 64); err != nil {
				return
			}
		}
	default:
		return
	}
	if session.setCookie != nil {
		session.setCookie(cookie)
	}
}

// ProviderRequest is a read-only service transport, separate from native browser roles.
func (m *Manager) ProviderRequest(ctx context.Context, integration model.Integration, method, path, query, contentType string, body []byte) (*http.Response, error) {
	if integration.Kind == "wayline" {
		return m.WaylineRequest(ctx, integration, method, path, query, contentType, body)
	}
	if integration.Kind != "grafana" || method != http.MethodPost || path != "/api/ds/query" || query != "" || contentType != "application/json" || len(body) == 0 || len(body) > 512<<10 || !json.Valid(body) {
		return nil, errors.New("Этот запрос недоступен provider")
	}
	return m.GrafanaRequest(ctx, integration, method, "/grafana/api/ds/query", "", "application/json", "system:modules:provider", "Наблюдение Pl", false, body)
}

func (c *HostController) RequestGrafana(ctx context.Context, id, method, path, query, contentType, userID, userName string, admin bool, body []byte) (*http.Response, error) {
	if !canonicalID(id) || len(body) > 512<<10 || len(userID) == 0 || len(userID) > 256 || len(userName) > 512 {
		return nil, errors.New("Некорректный запрос Grafana")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	input := map[string]any{"instance_id": id, "method": method, "path": path, "query": query, "content_type": contentType, "user_id": userID, "user_name": userName, "admin": admin, "body": base64.StdEncoding.EncodeToString(body)}
	session, _ := ctx.Value(grafanaSessionKey{}).(*grafanaSession)
	if session != nil {
		if !ValidGrafanaSession(session.value) {
			return bufferedResponse(http.StatusUnauthorized, "application/json", nil), nil
		}
		input["browser_session"] = session.value
	}
	payload, _ := json.Marshal(input)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	endpoint := "/v1/grafana/request"
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(timestamp + "\nPOST\n" + endpoint + "\n"))
	mac.Write(payload)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, errors.New("Некорректный запрос Grafana")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Pl-Timestamp", timestamp)
	request.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	response, err := c.client.Do(request)
	if err != nil {
		return nil, controllerTransportError(ctx, err)
	}
	defer response.Body.Close()
	const maximum = 8 << 20
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximum*4/3+4097))
	if err != nil || response.StatusCode != 200 || len(raw) > maximum*4/3+4096 {
		return nil, errors.New("Host controller не подтвердил запрос Grafana")
	}
	var output struct {
		InstanceID  string   `json:"instance_id"`
		Status      int      `json:"status"`
		ContentType string   `json:"content_type"`
		Body        string   `json:"body"`
		SetCookies  []string `json:"set_cookies"`
	}
	if json.Unmarshal(raw, &output) != nil || output.InstanceID != id || !readStatus(output.Status) || !readContentType(output.ContentType) {
		return nil, errors.New("Некорректный ответ Grafana")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(output.Body)
	if err != nil || len(decoded) > maximum {
		return nil, errors.New("Превышен размер ответа Grafana")
	}
	if session != nil {
		for _, raw := range output.SetCookies {
			session.renew(raw)
		}
	}
	return bufferedResponse(output.Status, output.ContentType, decoded), nil
}

func (m *Manager) GrafanaRequest(ctx context.Context, integration model.Integration, method, path, query, contentType, userID, userName string, admin bool, body []byte) (*http.Response, error) {
	if !integration.Enabled || integration.Kind != "grafana" || !canonicalID(integration.ManagedModuleID) {
		return nil, ErrGrafanaUnavailable
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", integration.ManagedModuleID)
	if err != nil {
		return nil, err
	}
	current, err := store.Get[model.Integration](ctx, m.Store, "integration", integration.ID)
	if err != nil {
		return nil, err
	}
	if instance.IntegrationID != integration.ID || current.ManagedModuleID != instance.ID || !current.Enabled || current.Kind != "grafana" || instance.ModuleID != "grafana" || instance.Mode != "local" || instance.DesiredState != "enabled" {
		return nil, ErrGrafanaUnavailable
	}
	controller, ok := m.Controller.(interface {
		RequestGrafana(context.Context, string, string, string, string, string, string, string, bool, []byte) (*http.Response, error)
	})
	if !ok {
		return nil, errors.New("Host controller не поддерживает Grafana")
	}
	return controller.RequestGrafana(ctx, instance.ID, method, path, query, contentType, userID, userName, admin, body)
}
