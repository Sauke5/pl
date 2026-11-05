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
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func (m *Manager) WaylineRequest(ctx context.Context, integration model.Integration, method, path, query, contentType string, body []byte) (*http.Response, error) {
	if !integration.Enabled || integration.Kind != "wayline" || !canonicalID(integration.ManagedModuleID) {
		return nil, errors.New("Wayline недоступен")
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", integration.ManagedModuleID)
	if err != nil {
		return nil, err
	}
	canonical, err := store.Get[model.Integration](ctx, m.Store, "integration", integration.ID)
	if err != nil {
		return nil, err
	}
	if instance.IntegrationID != integration.ID || canonical.ManagedModuleID != instance.ID || canonical.Kind != "wayline" || !canonical.Enabled || instance.ModuleID != "wayline" || instance.DesiredState != "enabled" || instance.Mode != "local" {
		return nil, errors.New("Связь модуля Wayline не подтверждена")
	}
	controller, ok := m.Controller.(interface {
		RequestWayline(context.Context, string, string, string, string, string, []byte) (*http.Response, error)
	})
	if !ok {
		return nil, errors.New("Host controller не поддерживает Wayline")
	}
	return controller.RequestWayline(ctx, instance.ID, method, path, query, contentType, body)
}

func (c *HostController) RequestWayline(ctx context.Context, id, method, path, query, contentType string, body []byte) (*http.Response, error) {
	if !canonicalID(id) || len(body) > 256<<10 {
		return nil, errors.New("Некорректный запрос Wayline")
	}
	ctx, cancel := context.WithTimeout(ctx, 225*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{"instance_id": id, "method": method, "path": path, "query": query, "content_type": contentType, "body": base64.StdEncoding.EncodeToString(body)})
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	endpoint := "/v1/wayline/request"
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(timestamp + "\nPOST\n" + endpoint + "\n"))
	mac.Write(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, errors.New("Некорректный запрос Wayline")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", timestamp)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	res, err := c.client.Do(req)
	if err != nil {
		return nil, controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	const limit = 4 << 20
	data, err := io.ReadAll(io.LimitReader(res.Body, (limit*4/3)+4097))
	if err != nil || res.StatusCode != 200 || len(data) > (limit*4/3)+4096 {
		return nil, errors.New("Host controller не подтвердил запрос Wayline")
	}
	var reply struct {
		InstanceID  string `json:"instance_id"`
		Status      int    `json:"status"`
		ContentType string `json:"content_type"`
		Body        string `json:"body"`
	}
	if json.Unmarshal(data, &reply) != nil || reply.InstanceID != id || !readStatus(reply.Status) || !readContentType(reply.ContentType) {
		return nil, errors.New("Некорректный ответ Wayline")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(reply.Body)
	if err != nil || len(decoded) > limit {
		return nil, errors.New("Превышен размер ответа Wayline")
	}
	return bufferedResponse(reply.Status, reply.ContentType, decoded), nil
}
