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
	"strconv"
	"strings"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

const alertmanagerReadLimit = 4 << 20

func (c *HostController) ReadAlertmanager(ctx context.Context, id string) (*http.Response, error) {
	if !canonicalID(id) {
		return nil, errors.New("Некорректный экземпляр Alertmanager")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"instance_id": id, "path": "/api/v2/alerts", "query": ""})
	path := "/v1/alertmanager/read"
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(timestamp + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", timestamp)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	res, err := c.client.Do(req)
	if err != nil {
		return nil, controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, (alertmanagerReadLimit*4/3)+4097))
	if err != nil {
		return nil, controllerTransportError(ctx, err)
	}
	if res.StatusCode != 200 || len(data) > (alertmanagerReadLimit*4/3)+4096 {
		return nil, errors.New("Host controller не подтвердил чтение Alertmanager")
	}
	var out struct {
		InstanceID  string `json:"instance_id"`
		Status      int    `json:"status"`
		ContentType string `json:"content_type"`
		Body        string `json:"body"`
	}
	if json.Unmarshal(data, &out) != nil || out.InstanceID != id || out.Status != 200 || !(out.ContentType == "application/json" || strings.HasPrefix(out.ContentType, "application/json;")) || !readContentType(out.ContentType) {
		return nil, errors.New("Некорректный ответ host controller Alertmanager")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(out.Body)
	if err != nil || len(decoded) > alertmanagerReadLimit || !json.Valid(decoded) {
		return nil, errors.New("Некорректный JSON Alertmanager")
	}
	return bufferedResponse(out.Status, out.ContentType, decoded), nil
}

func (m *Manager) readAlertmanagerIntegration(ctx context.Context, i model.Integration, path, query string) (*http.Response, error) {
	if path != "/api/v2/alerts" || query != "" || m == nil || m.Store == nil || !canonicalID(i.ManagedModuleID) || !i.Enabled {
		return nil, errors.New("Управляемая интеграция Alertmanager недоступна")
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", i.ManagedModuleID)
	if err != nil {
		return nil, err
	}
	canonical, err := store.Get[model.Integration](ctx, m.Store, "integration", i.ID)
	if err != nil {
		return nil, err
	}
	if canonical.ManagedModuleID != instance.ID || instance.IntegrationID != i.ID || canonical.Kind != "alertmanager" || !canonical.Enabled || instance.ModuleID != "alertmanager" || instance.Mode != "local" || instance.DesiredState != "enabled" {
		return nil, errors.New("Связь Alertmanager с модулем не подтверждена")
	}
	reader, ok := m.Controller.(interface {
		ReadAlertmanager(context.Context, string) (*http.Response, error)
	})
	if !ok {
		return nil, errors.New("Host controller не поддерживает чтение Alertmanager")
	}
	return reader.ReadAlertmanager(ctx, instance.ID)
}
