package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
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

var ErrApplicationUnavailable = errors.New("модуль приложения недоступен")
var ErrApplicationNotInstalled = errors.New("модуль приложения не установлен")

const formsApplicationBodyLimit = 3 << 20

func readFormsApplicationBody(reader io.Reader) ([]byte, error) {
	if reader == nil {
		reader = http.NoBody
	}
	body, err := io.ReadAll(io.LimitReader(reader, formsApplicationBodyLimit+1))
	if err != nil || len(body) > formsApplicationBodyLimit {
		return nil, ErrApplicationUnavailable
	}
	return body, nil
}

func (m *Manager) applicationInstance(ctx context.Context, id string) (model.ModuleInstance, error) {
	if m == nil || m.Store == nil || !canonicalID(id) {
		return model.ModuleInstance{}, ErrApplicationUnavailable
	}
	v, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil || (v.Mode != "local" && (v.ModuleID != "netmap" || v.Mode != "external")) || v.DesiredState != "enabled" || (v.ModuleID != "forms" && v.ModuleID != "doska" && v.ModuleID != "netmap" && v.ModuleID != "inventory") {
		return model.ModuleInstance{}, ErrApplicationUnavailable
	}
	return v, nil
}

func (m *Manager) FindApplication(ctx context.Context, kind string) (model.ModuleInstance, error) {
	if m == nil || m.Store == nil || (kind != "forms" && kind != "doska" && kind != "netmap" && kind != "inventory") {
		return model.ModuleInstance{}, ErrApplicationUnavailable
	}
	rows, err := store.List[model.ModuleInstance](ctx, m.Store, "module_instance")
	if err != nil {
		return model.ModuleInstance{}, err
	}
	var selected model.ModuleInstance
	present := false
	netMapAliases := 0
	for _, row := range rows {
		supported := row.Mode == "local" || kind == "netmap" && row.Mode == "external"
		if row.ModuleID == kind && supported && row.DesiredState != "removed" {
			present = true
			if kind == "netmap" {
				netMapAliases++
				if netMapAliases > 1 {
					return model.ModuleInstance{}, ErrApplicationUnavailable
				}
			}
		}
		if row.ModuleID == kind && supported && row.DesiredState == "enabled" && row.ObservedState == "running" {
			if selected.ID != "" {
				return model.ModuleInstance{}, ErrApplicationUnavailable
			}
			selected = row
		}
	}
	if selected.ID == "" {
		if !present {
			return selected, ErrApplicationNotInstalled
		}
		return selected, ErrApplicationUnavailable
	}
	return selected, nil
}

func (c *HostController) ApplicationKey(id, kind string) ([]byte, error) {
	if !canonicalID(id) || (kind != "forms" && kind != "doska" && kind != "netmap" && kind != "inventory") {
		return nil, ErrApplicationUnavailable
	}
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte("pl-module-key-v1\n" + kind + "\n" + id))
	return mac.Sum(nil), nil
}
func (m *Manager) ApplicationKey(ctx context.Context, id string) ([]byte, error) {
	v, err := m.applicationInstance(ctx, id)
	if err != nil {
		return nil, err
	}
	if v.ModuleID == "netmap" && v.Mode == "external" {
		integration, err := m.externalNetMapIntegration(ctx, v)
		if err != nil {
			return nil, err
		}
		return m.NetMap.Key(ctx, integration, m.PublicURL)
	}
	c, ok := m.Controller.(interface {
		ApplicationKey(string, string) ([]byte, error)
	})
	if !ok {
		return nil, ErrApplicationUnavailable
	}
	return c.ApplicationKey(id, v.ModuleID)
}
func (m *Manager) AuthenticateDirectory(ctx context.Context, id, token string) bool {
	v, err := m.applicationInstance(ctx, id)
	if err != nil || v.ModuleID != "doska" || len(token) != 64 {
		return false
	}
	c, ok := m.Controller.(*HostController)
	if !ok {
		return false
	}
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte("pl-module-directory-token-v1\ndoska\n" + id))
	expected := hex.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}

func (c *HostController) applicationRequest(ctx context.Context, endpoint string, payload []byte, body io.Reader, length int64, raw bool) (*http.Response, error) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(timestamp + "\nPOST\n" + endpoint + "\n"))
	mac.Write(payload)
	// An opaque non-nil empty reader means unknown length to net/http. Honor
	// the declared zero length explicitly so POST is not sent as chunked RPC.
	if length == 0 {
		body = http.NoBody
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+endpoint, body)
	if err != nil {
		return nil, ErrApplicationUnavailable
	}
	request.GetBody = nil
	request.ContentLength = length
	request.Header.Set("X-Pl-Timestamp", timestamp)
	request.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("Content-Type", "application/json")
	if raw {
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("X-Pl-Transport-Meta", base64.StdEncoding.EncodeToString(payload))
	}
	// RoundTrip deliberately does not replay mutations or follow redirects.
	response, err := c.client.Transport.RoundTrip(request)
	if err != nil {
		return nil, controllerTransportError(ctx, err)
	}
	return response, nil
}

type applicationTransport struct {
	manager  *Manager
	id, kind string
}

func (m *Manager) ApplicationTransport(id, kind string) http.RoundTripper {
	return &applicationTransport{m, id, kind}
}

var applicationHeaders = []string{"X-PL-Gateway-Assertion", "X-PL-Gateway-Signature", "X-CSRF-Token", "Idempotency-Key", "Last-Event-ID", "Accept", "Accept-Language", "If-None-Match", "If-Modified-Since", "Range", "If-Range", "Content-Range"}

func (t *applicationTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if t.kind == "inventory" {
		return t.inventoryRoundTrip(request)
	}
	v, err := t.manager.applicationInstance(request.Context(), t.id)
	if err != nil || v.ModuleID != t.kind || v.ObservedState != "running" {
		return nil, ErrApplicationUnavailable
	}
	c, ok := t.manager.Controller.(*HostController)
	if !ok {
		return nil, ErrApplicationUnavailable
	}
	headers := map[string]string{}
	for _, name := range applicationHeaders {
		if t.kind == "forms" && name != "X-PL-Gateway-Assertion" && name != "X-PL-Gateway-Signature" && name != "X-CSRF-Token" && name != "Idempotency-Key" {
			continue
		}
		if values := request.Header.Values(name); len(values) > 1 {
			return nil, ErrApplicationUnavailable
		} else if len(values) == 1 {
			headers[name] = values[0]
		}
	}
	if request.URL.RawPath != "" || request.ContentLength < 0 || request.ContentLength > 26<<20 {
		return nil, ErrApplicationUnavailable
	}
	if t.kind == "forms" {
		body, err := readFormsApplicationBody(request.Body)
		if err != nil {
			return nil, ErrApplicationUnavailable
		}
		payload, _ := json.Marshal(map[string]any{"instance_id": t.id, "method": request.Method, "path": request.URL.Path, "query": request.URL.RawQuery, "content_type": request.Header.Get("Content-Type"), "body": base64.StdEncoding.EncodeToString(body), "headers": headers})
		ctx, cancel := context.WithTimeout(request.Context(), 45*time.Second)
		defer cancel()
		response, err := c.applicationRequest(ctx, "/v1/forms/request", payload, bytes.NewReader(payload), int64(len(payload)), false)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, (24<<20)+1))
		if err != nil || response.StatusCode != 200 || len(data) > 24<<20 {
			return nil, ErrApplicationUnavailable
		}
		var output struct {
			InstanceID  string `json:"instance_id"`
			Status      int    `json:"status"`
			ContentType string `json:"content_type"`
			Body        string `json:"body"`
		}
		if json.Unmarshal(data, &output) != nil || output.InstanceID != t.id || !readStatus(output.Status) || !readContentType(output.ContentType) {
			return nil, ErrApplicationUnavailable
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(output.Body)
		if err != nil || len(decoded) > 16<<20 {
			return nil, ErrApplicationUnavailable
		}
		return bufferedResponse(output.Status, output.ContentType, decoded), nil
	}
	role := ""
	switch request.URL.Host {
	case "module-api":
		role = "api"
	case "module-web":
		role = "web"
	default:
		return nil, ErrApplicationUnavailable
	}
	sum := sha256.Sum256(nil)
	bodyHash := hex.EncodeToString(sum[:])
	if role == "api" {
		raw, err := base64.RawURLEncoding.DecodeString(request.Header.Get("X-PL-Gateway-Assertion"))
		if err != nil {
			return nil, ErrApplicationUnavailable
		}
		var claims struct {
			BodySHA256 string `json:"body_sha256"`
		}
		if json.Unmarshal(raw, &claims) != nil || len(claims.BodySHA256) != 64 {
			return nil, ErrApplicationUnavailable
		}
		if _, err = hex.DecodeString(claims.BodySHA256); err != nil {
			return nil, ErrApplicationUnavailable
		}
		bodyHash = claims.BodySHA256
	} else if request.ContentLength != 0 || request.Method != "GET" && request.Method != "HEAD" {
		return nil, ErrApplicationUnavailable
	}
	payload, _ := json.Marshal(map[string]any{"instance_id": t.id, "role": role, "method": request.Method, "path": request.URL.Path, "query": request.URL.RawQuery, "content_type": request.Header.Get("Content-Type"), "headers": headers, "body_length": request.ContentLength, "body_sha256": bodyHash})
	return c.applicationRequest(request.Context(), "/v1/doska/transport", payload, request.Body, request.ContentLength, true)
}

func (m *Manager) ApplicationManifest(ctx context.Context, id string) ([]byte, error) {
	v, err := m.applicationInstance(ctx, id)
	if err != nil || v.ModuleID != "doska" {
		return nil, ErrApplicationUnavailable
	}
	c, ok := m.Controller.(*HostController)
	if !ok {
		return nil, ErrApplicationUnavailable
	}
	payload, _ := json.Marshal(map[string]string{"instance_id": id})
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	response, err := c.applicationRequest(ctx, "/v1/doska/manifest", payload, bytes.NewReader(payload), int64(len(payload)), false)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (512<<10)+1))
	if err != nil || response.StatusCode != 200 || len(body) > 512<<10 || !json.Valid(body) {
		return nil, ErrApplicationUnavailable
	}
	return body, nil
}

func BearerDirectoryToken(header string) string {
	if !strings.HasPrefix(header, "Bearer ") {
		return ""
	}
	token := strings.TrimPrefix(header, "Bearer ")
	if len(token) != 64 {
		return ""
	}
	return token
}
