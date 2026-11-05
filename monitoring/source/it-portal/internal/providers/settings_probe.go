package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pl/portal/internal/model"
)

// IntegrationProbe is the outcome of bounded read-only validation of a draft source.
// It is deliberately independent of persisted source health and snapshots.
type IntegrationProbe struct {
	Status     string    `json:"status"`
	Message    string    `json:"message"`
	CheckedAt  time.Time `json:"checked_at"`
	DurationMS int64     `json:"duration_ms"`
}

var settingsProbeSlots = make(chan struct{}, 4)

// ProbeIntegration tests the provider's existing read API using the draft. It
// never polls through the worker, saves documents or applies returned objects.
func (r *Registry) ProbeIntegration(ctx context.Context, i model.Integration) (out IntegrationProbe) {
	started := time.Now()
	defer func() {
		out.CheckedAt = time.Now().UTC()
		out.DurationMS = time.Since(started).Milliseconds()
	}()
	if i.Kind == "docker" {
		return IntegrationProbe{Status: "unsupported", Message: "Executor задаётся на сервере. Проверка параметров черновика для этого подключения недоступна."}
	}
	path := map[string]string{
		"prometheus":   "/api/v1/targets",
		"alertmanager": "/api/v2/alerts",
		"grafana":      "/api/search",
		"reports":      "/internal/reports/manifest",
		"wayline":      "/api/v1/targets",
		"netbox":       "/api/dcim/devices/",
		"oxidized":     "/nodes.json",
	}[i.Kind]
	managed := i.ManagedModuleID != ""
	if managed && i.Kind != "prometheus" && i.Kind != "alertmanager" && i.Kind != "grafana" && i.Kind != "wayline" && i.Kind != "fileauditor" && i.Kind != "forms" && i.Kind != "doska" && i.Kind != "sftpgo" && i.Kind != "netmap" && i.Kind != "bookstack" && i.Kind != "inventory" {
		return IntegrationProbe{Status: "unsupported", Message: "Проверка для этого управляемого модуля недоступна."}
	}
	if path == "" && !managed {
		return IntegrationProbe{Status: "unsupported", Message: "Проверка для этого типа подключения недоступна."}
	}
	if r.guard == nil && !managed {
		return IntegrationProbe{Status: "unreachable", Message: "Проверка подключений сейчас недоступна."}
	}
	select {
	case settingsProbeSlots <- struct{}{}:
		defer func() { <-settingsProbeSlots }()
	default:
		return IntegrationProbe{Status: "busy", Message: "Другие проверки ещё выполняются. Повторите попытку немного позже."}
	}
	budget := timeout(i)
	if budget > 15*time.Second {
		budget = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	if managed && (i.Kind == "forms" || i.Kind == "doska" || i.Kind == "sftpgo" || i.Kind == "netmap" || i.Kind == "bookstack" || i.Kind == "inventory") {
		if r.ManagedHealth == nil {
			return IntegrationProbe{Status: "unreachable", Message: "Проверка установленного приложения недоступна."}
		}
		if err := r.ManagedHealth(ctx, i); err != nil {
			return settingsProbeFailure(err)
		}
		return IntegrationProbe{Status: "connected", Message: "Контроллер подтвердил базу данных и API установленного приложения."}
	}
	if managed {
		// The module manager resolves persisted ownership and the controller route.
		// Draft URLs, secrets and broader integration policy are not authorities for
		// an installed module. Poll only reads; its snapshot is deliberately discarded.
		if _, err := r.Poll(ctx, i); err != nil {
			return settingsProbeFailure(err)
		}
		return IntegrationProbe{Status: "connected", Message: "Управляемый модуль ответил на проверку API."}
	}
	if i.Kind == "oxidized" {
		if err := r.ProbeOxidized(ctx, i); err != nil {
			return IntegrationProbe{Status: "invalid_response", Message: "Не удалось получить сведения о конфигурациях. Проверьте адрес Oxidized и доступ к его API."}
		}
		return IntegrationProbe{Status: "connected", Message: "Подключение успешно. История конфигураций доступна."}
	}
	address, err := endpoint(i.URL, path)
	if err != nil || !safeSourceURL(i.URL) {
		return IntegrationProbe{Status: "invalid_response", Message: "Проверьте базовый адрес подключения."}
	}
	u, err := url.Parse(address)
	if err != nil {
		return IntegrationProbe{Status: "invalid_response", Message: "Проверьте базовый адрес подключения."}
	}
	if err = r.guard.ValidateURL(u); err != nil {
		return settingsProbeFailure(err)
	}
	if i.Kind == "netbox" {
		q := u.Query()
		q.Set("limit", "1")
		q.Set("offset", "0")
		u.RawQuery = q.Encode()
	} else if i.Kind == "grafana" {
		q := u.Query()
		q.Set("type", "dash-db")
		q.Set("limit", "1")
		u.RawQuery = q.Encode()
	} else if i.Kind == "reports" {
		// The saved adapter reads its manifest from the origin root, regardless
		// of a base subpath. Probe the same route rather than generic /health.
		u.Path, u.RawPath = path, ""
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return IntegrationProbe{Status: "invalid_response", Message: "Проверьте базовый адрес подключения."}
	}
	token, err := secret(i.SecretRef)
	if err != nil {
		return IntegrationProbe{Status: "secret_unavailable", Message: "Не удалось использовать указанную ссылку на учётные данные."}
	}
	switch i.Kind {
	case "netbox":
		if host := i.Config["http_host"]; host != "" {
			if !validNetBoxHTTPHost(host) {
				return IntegrationProbe{Status: "invalid_response", Message: "Проверьте HTTP Host для NetBox."}
			}
			req.Host = host
		}
		if token != "" {
			req.Header.Set("Authorization", "Token "+token)
		}
	case "wayline":
		username := i.Config["basic_username"]
		if (username == "") != (token == "") || strings.ContainsAny(username, ":\r\n") {
			return IntegrationProbe{Status: "secret_unavailable", Message: "Укажите пользователя Wayline и ссылку на пароль вместе."}
		}
		if username != "" {
			req.SetBasicAuth(username, token)
		}
	case "reports":
		// Match reportManifest: its internal read route does not forward the
		// integration's Bearer credential to the archive service.
	default:
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}
	req.Header.Set("Accept", "application/json")
	client := r.guard.Client(budget)
	// The draft's exact endpoint must answer; credentials never follow redirects.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return settingsProbeFailure(err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return IntegrationProbe{Status: "auth", Message: "Источник отклонил авторизацию. Проверьте учётные данные и их права."}
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		return IntegrationProbe{Status: "invalid_response", Message: "Источник перенаправляет запрос. Уточните базовый адрес API."}
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return IntegrationProbe{Status: "unreachable", Message: "Источник сейчас не может выполнить запрос. Повторите проверку позже."}
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return IntegrationProbe{Status: "invalid_response", Message: "API не принял запрос. Проверьте адрес и тип подключения."}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
	if err != nil {
		return settingsProbeFailure(err)
	}
	if len(b) > 4<<20 {
		return IntegrationProbe{Status: "invalid_response", Message: "Ответ источника превышает допустимый размер проверки."}
	}
	if !settingsProbeResponse(i.Kind, b) {
		return IntegrationProbe{Status: "invalid_response", Message: "Ответ не соответствует API выбранного типа подключения."}
	}
	return IntegrationProbe{Status: "connected", Message: "Подключение успешно. Источник ответил на запрос API."}
}

func settingsProbeFailure(err error) IntegrationProbe {
	cause := classifyEndpointError(err)
	switch {
	case errors.Is(cause, ErrTLSUntrusted), errors.Is(cause, ErrTLSHostname), errors.Is(cause, ErrTLSExpired), errors.Is(cause, ErrTLSVerification):
		return IntegrationProbe{Status: "tls", Message: "Сертификат источника не прошёл проверку TLS."}
	case errors.Is(cause, ErrPolicyDenied):
		return IntegrationProbe{Status: "policy_denied", Message: "Адрес или порт источника не разрешён для подключений Платформы."}
	case errors.Is(cause, ErrTimeout):
		return IntegrationProbe{Status: "unreachable", Message: "Источник не ответил за отведённое время."}
	case errors.Is(cause, ErrDNS):
		return IntegrationProbe{Status: "unreachable", Message: "Не удалось определить адрес источника по имени."}
	default:
		return IntegrationProbe{Status: "unreachable", Message: "Не удалось связаться с источником. Проверьте адрес и доступность сервиса."}
	}
}

func settingsProbeResponse(kind string, body []byte) bool {
	switch kind {
	case "prometheus":
		var v struct {
			Status string `json:"status"`
			Data   *struct {
				ActiveTargets *[]struct {
					Labels    map[string]string `json:"labels"`
					ScrapeURL string            `json:"scrapeUrl"`
					Health    string            `json:"health"`
				} `json:"activeTargets"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &v) != nil || v.Status != "success" || v.Data == nil || v.Data.ActiveTargets == nil {
			return false
		}
		for _, target := range *v.Data.ActiveTargets {
			if len(target.Labels) == 0 || !safeSourceURL(target.ScrapeURL) || (target.Health != "up" && target.Health != "down" && target.Health != "unknown" && target.Health != "") {
				return false
			}
		}
		return true
	case "alertmanager":
		var v []struct {
			Fingerprint string            `json:"fingerprint"`
			Labels      map[string]string `json:"labels"`
			StartsAt    time.Time         `json:"startsAt"`
			Status      *struct {
				State string `json:"state"`
			} `json:"status"`
		}
		if json.Unmarshal(body, &v) != nil || v == nil {
			return false
		}
		for _, a := range v {
			if a.Fingerprint == "" || len(a.Labels) == 0 || a.StartsAt.IsZero() || a.Status == nil || (a.Status.State != "active" && a.Status.State != "suppressed" && a.Status.State != "unprocessed") {
				return false
			}
		}
		return true
	case "grafana":
		var v []struct {
			UID   string `json:"uid"`
			Title string `json:"title"`
			Type  string `json:"type"`
		}
		if json.Unmarshal(body, &v) != nil || v == nil || len(v) > 1 {
			return false
		}
		for _, dashboard := range v {
			if !providerUID.MatchString(dashboard.UID) || dashboard.Title == "" || dashboard.Type != "dash-db" {
				return false
			}
		}
		return true
	case "reports":
		return settingsProbeReportManifest(body)
	case "wayline":
		var v struct {
			Targets *[]WaylineTarget `json:"targets"`
		}
		if json.Unmarshal(body, &v) != nil || v.Targets == nil || len(*v.Targets) > 10000 {
			return false
		}
		seen := map[int64]bool{}
		for _, target := range *v.Targets {
			if seen[target.ID] || target.ID < 1 || target.Name == "" || target.Host == "" || target.IntervalSeconds < 1 || target.IntervalSeconds > 86400 {
				return false
			}
			seen[target.ID] = true
		}
		return true
	case "netbox":
		var v struct {
			Count   *int        `json:"count"`
			Results *[]nbObject `json:"results"`
		}
		if json.Unmarshal(body, &v) != nil || v.Count == nil || *v.Count < 0 || *v.Count > 20000 || v.Results == nil || len(*v.Results) > 1 || len(*v.Results) > *v.Count || (*v.Count > 0 && len(*v.Results) == 0) {
			return false
		}
		for _, item := range *v.Results {
			if item.ID < 1 || item.Name == "" {
				return false
			}
		}
		return true
	}
	return false
}

// Validate the same daily/weekly file contract consumed by reportManifest. This
// parses a bounded response only; it neither imports reports nor creates jobs.
func settingsProbeReportManifest(body []byte) bool {
	var entries []manifestReport
	if json.Unmarshal(body, &entries) != nil || entries == nil || len(entries) > 10000 {
		return false
	}
	for _, entry := range entries {
		if entry.Run < 1 {
			return false
		}
		var expected string
		switch entry.Type {
		case "daily":
			date, err := time.Parse("2006-01-02", entry.Date)
			if err != nil || date.Format("2006-01-02") != entry.Date {
				return false
			}
			expected = fmt.Sprintf("infrastructure-%s-run-%d.html", entry.Date, entry.Run)
		case "weekly":
			start, startErr := time.Parse("2006-01-02", entry.Start)
			end, endErr := time.Parse("2006-01-02", entry.End)
			year, week := start.ISOWeek()
			endYear, endWeek := end.ISOWeek()
			if startErr != nil || endErr != nil || end.Before(start) || year != entry.ISOYear || week != entry.ISOWeek || endYear != year || endWeek != week {
				return false
			}
			expected = fmt.Sprintf("infrastructure-weekly-%04d-W%02d-run-%d.html", year, week, entry.Run)
		default:
			return false
		}
		if entry.File != expected {
			return false
		}
	}
	return true
}
