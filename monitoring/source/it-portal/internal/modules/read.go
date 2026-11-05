package modules

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

const ReadLimit = 8 << 20

var readPaths = map[string]bool{
	"/": true, "/query": true, "/graph": true, "/alerts": true, "/rules": true,
	"/targets": true, "/service-discovery": true, "/alertmanager-discovery": true,
	"/status": true, "/tsdb-status": true, "/flags": true, "/config": true, "/agent": true,
	"/favicon.svg": true, "/favicon.ico": true, "/manifest.json": true, "/-/ready": true, "/-/healthy": true,
	"/api/v1/query": true, "/api/v1/query_range": true, "/api/v1/query_exemplars": true,
	"/api/v1/format_query": true, "/api/v1/parse_query": true, "/api/v1/series": true, "/api/v1/labels": true,
	"/api/v1/targets": true, "/api/v1/targets/metadata": true, "/api/v1/metadata": true,
	"/api/v1/rules": true, "/api/v1/alerts": true, "/api/v1/alertmanagers": true,
	"/api/v1/notifications": true, "/api/v1/features": true,
	"/api/v1/status/buildinfo": true, "/api/v1/status/runtimeinfo": true, "/api/v1/status/config": true,
	"/api/v1/status/flags": true, "/api/v1/status/tsdb": true, "/api/v1/status/walreplay": true,
}
var readLabel = regexp.MustCompile(`^/api/v1/label/[A-Za-z_][A-Za-z0-9_]{0,127}/values$`)
var readAsset = regexp.MustCompile(`^/assets/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(js|css|woff2?|ttf|svg|png|txt)$`)

func canonicalID(id string) bool { v, e := uuid.Parse(id); return e == nil && v.String() == id }

// ValidateRead is shared by external transport and the Unix controller client.
// The host independently enforces the same finite GET-only contract.
func ValidateRead(path, query string) error {
	if len(query) > 8192 || strings.ContainsAny(path, "%\\") || strings.Contains(path, "..") || strings.Contains(query, "#") || strings.ContainsFunc(path+query, unicode.IsControl) || (!readPaths[path] && !readLabel.MatchString(path) && !readAsset.MatchString(path)) {
		return errors.New("Этот маршрут Prometheus недоступен через платформу")
	}
	values, err := url.ParseQuery(query)
	if err != nil || len(values) > 128 {
		return errors.New("Некорректные параметры запроса Prometheus")
	}
	count := 0
	for key, vv := range values {
		for _, value := range vv {
			count++
			if strings.ContainsFunc(key+value, unicode.IsControl) || count > 128 {
				return errors.New("Некорректные параметры запроса Prometheus")
			}
		}
	}
	return nil
}
func readStatus(status int) bool {
	return status >= 200 && status < 300 || status >= 400 && status < 600
}
func readContentType(value string) bool {
	return value != "" && len(value) <= 256 && !strings.ContainsFunc(value, unicode.IsControl)
}
func bufferedResponse(status int, contentType string, body []byte) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body))}
}

// ReadIntegration resolves both ownership edges from persisted state. Integration
// URL, SecretRef and client-supplied module identity are never transport authority.
func (m *Manager) ReadIntegration(ctx context.Context, i model.Integration, path, query string) (*http.Response, error) {
	if i.Kind == "grafana" {
		allowed := path == "/api/health" || path == "/api/search" || path == "/api/datasources"
		if strings.HasPrefix(path, "/api/dashboards/uid/") {
			allowed = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(strings.TrimPrefix(path, "/api/dashboards/uid/"))
		}
		if !allowed || len(query) > 8192 || strings.ContainsFunc(query, unicode.IsControl) || path != "/api/search" && query != "" {
			return nil, errors.New("Этот маршрут Grafana недоступен provider")
		}
		return m.GrafanaRequest(ctx, i, http.MethodGet, "/grafana"+path, query, "", "system:modules:provider", "Наблюдение Pl", false, nil)
	}
	if i.Kind == "alertmanager" {
		return m.readAlertmanagerIntegration(ctx, i, path, query)
	}
	if err := ValidateRead(path, query); err != nil {
		return nil, err
	}
	if m == nil || m.Store == nil || !canonicalID(i.ManagedModuleID) || !i.Enabled || i.Kind != "prometheus" {
		return nil, errors.New("Управляемая интеграция недоступна")
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", i.ManagedModuleID)
	if err != nil {
		return nil, err
	}
	canonical, err := store.Get[model.Integration](ctx, m.Store, "integration", i.ID)
	if err != nil {
		return nil, err
	}
	if canonical.ManagedModuleID != instance.ID || instance.IntegrationID != i.ID || !canonical.Enabled || canonical.Kind != "prometheus" || instance.ModuleID != "prometheus" || instance.DesiredState != "enabled" {
		return nil, errors.New("Связь интеграции с модулем не подтверждена")
	}
	if instance.Mode == "local" {
		reader, ok := m.Controller.(interface {
			Read(context.Context, string, string, string) (*http.Response, error)
		})
		if !ok {
			return nil, errors.New("Host controller не поддерживает чтение модуля")
		}
		return reader.Read(ctx, instance.ID, path, query)
	}
	if instance.Mode == "external" {
		reader, ok := m.Probe.(interface {
			Read(context.Context, string, string, string) (*http.Response, error)
		})
		if !ok {
			return nil, errors.New("Адаптер Prometheus не поддерживает чтение")
		}
		return reader.Read(ctx, instance.Endpoint, path, query)
	}
	return nil, errors.New("Неизвестный способ подключения модуля")
}

// Read pins DNS once per bounded request, verifies TLS against the original host,
// refuses redirects and drops upstream credentials, cookies and hop headers.
func (p *PrometheusProbe) Read(ctx context.Context, endpoint, path, query string) (*http.Response, error) {
	if err := ValidateRead(path, query); err != nil {
		return nil, err
	}
	base, client, closeClient, err := p.client(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	defer closeClient()
	address := base + path
	if query != "" {
		address += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, errors.New("Некорректный запрос Prometheus")
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, errors.New("Prometheus недоступен; проверьте адрес, TLS и сетевой доступ")
	}
	defer res.Body.Close()
	contentType := res.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if !readStatus(res.StatusCode) || !readContentType(contentType) {
		return nil, errors.New("Некорректный ответ Prometheus")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, ReadLimit+1))
	if err != nil || len(body) > ReadLimit {
		return nil, errors.New("Ответ Prometheus превышает допустимый размер")
	}
	return bufferedResponse(res.StatusCode, contentType, body), nil
}
