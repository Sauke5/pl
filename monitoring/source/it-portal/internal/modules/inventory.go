package modules

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
	"time"
)

const inventoryBodyLimit = 64 << 20

type InventorySettings struct {
	InstanceID                string `json:"instance_id"`
	ArchivePasswordConfigured bool   `json:"archive_password_configured"`
}

func (t *applicationTransport) inventoryRoundTrip(request *http.Request) (*http.Response, error) {
	v, err := t.manager.applicationInstance(request.Context(), t.id)
	if err != nil || v.ModuleID != "inventory" || v.ObservedState != "running" || request.URL.RawPath != "" || request.ContentLength > inventoryBodyLimit {
		return nil, ErrApplicationUnavailable
	}
	c, ok := t.manager.Controller.(*HostController)
	if !ok {
		return nil, ErrApplicationUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, inventoryBodyLimit+1))
	if err != nil || len(body) > inventoryBodyLimit {
		return nil, ErrApplicationUnavailable
	}
	headers := map[string]string{}
	for _, name := range []string{"X-PL-Gateway-Assertion", "X-PL-Gateway-Signature", "X-CSRF-Token", "Idempotency-Key"} {
		if values := request.Header.Values(name); len(values) > 1 {
			return nil, ErrApplicationUnavailable
		} else if len(values) == 1 {
			headers[name] = values[0]
		}
	}
	payload, _ := json.Marshal(map[string]any{"instance_id": t.id, "method": request.Method, "path": request.URL.Path, "query": request.URL.RawQuery, "content_type": request.Header.Get("Content-Type"), "body": base64.StdEncoding.EncodeToString(body), "headers": headers})
	ctx, cancel := context.WithTimeout(request.Context(), 90*time.Second)
	defer cancel()
	response, err := c.applicationRequest(ctx, "/v1/inventory/request", payload, bytes.NewReader(payload), int64(len(payload)), false)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (12<<20)+1))
	if err != nil || response.StatusCode != 200 || len(raw) > 12<<20 {
		return nil, ErrApplicationUnavailable
	}
	var out struct {
		InstanceID  string `json:"instance_id"`
		Status      int    `json:"status"`
		ContentType string `json:"content_type"`
		Body        string `json:"body"`
	}
	if json.Unmarshal(raw, &out) != nil || out.InstanceID != t.id || !readStatus(out.Status) || !readContentType(out.ContentType) {
		return nil, ErrApplicationUnavailable
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(out.Body)
	if err != nil || len(decoded) > 8<<20 {
		return nil, ErrApplicationUnavailable
	}
	return bufferedResponse(out.Status, out.ContentType, decoded), nil
}

func (m *Manager) InventorySettings(ctx context.Context, id, password, operation string) (InventorySettings, error) {
	var out InventorySettings
	if m == nil || m.Store == nil || !canonicalID(id) {
		return out, ErrApplicationUnavailable
	}
	v, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil || v.ModuleID != "inventory" || v.Mode != "local" || v.DesiredState == "removed" {
		return out, ErrApplicationUnavailable
	}
	c, ok := m.Controller.(*HostController)
	if !ok {
		return out, ErrApplicationUnavailable
	}
	payload := map[string]string{"instance_id": id}
	if password != "" {
		if len(password) > 4096 || !canonicalID(operation) {
			return out, errors.New("Некорректные параметры импорта Inventory")
		}
		payload["archive_password"], payload["operation_id"] = password, operation
	}
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := c.applicationRequest(ctx, "/v1/inventory/settings", body, bytes.NewReader(body), int64(len(body)), false)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4097))
	if err != nil || len(raw) > 4096 || res.StatusCode != 200 || json.Unmarshal(raw, &out) != nil || out.InstanceID != id {
		return InventorySettings{}, ErrApplicationUnavailable
	}
	return out, nil
}
