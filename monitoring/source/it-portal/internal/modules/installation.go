package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
)

type InstallationSettings struct {
	Revision     int64    `json:"revision"`
	PublicURL    string   `json:"public_url"`
	BindAddress  string   `json:"bind_address"`
	AllowedCIDRs []string `json:"allowed_cidrs"`
	AllowedPorts []int    `json:"allowed_ports"`
}
type InstallationChange struct {
	InstallationSettings
	OperationID   string  `json:"operation_id"`
	TLSCertPEM    string  `json:"tls_cert_pem,omitempty"`
	TLSKeyPEM     string  `json:"tls_key_pem,omitempty"`
	OutboundCAPEM *string `json:"outbound_ca_pem,omitempty"`
}
type InstallationStatus struct {
	InstallationSettings
	CoreAPI       int                    `json:"core_api"`
	CustomTLS     bool                   `json:"custom_tls"`
	OutboundCAPEM string                 `json:"outbound_ca_pem"`
	Operation     *InstallationOperation `json:"operation,omitempty"`
}
type InstallationOperation struct {
	Kind        string `json:"kind,omitempty"`
	OperationID string `json:"operation_id"`
	Phase       string `json:"phase"`
	Error       string `json:"error,omitempty"`
	NextURL     string `json:"next_url,omitempty"`
	StartedAt   string `json:"started_at,omitempty"`
	FinishedAt  string `json:"finished_at,omitempty"`
}
type InstallationError struct {
	Status        int
	Code, Message string
}

func (e *InstallationError) Error() string { return e.Message }

func (m *Manager) Installation(ctx context.Context, change *InstallationChange) (InstallationStatus, error) {
	if m == nil {
		return InstallationStatus{}, errors.New("Настройки развёртывания недоступны")
	}
	c, ok := m.Controller.(interface {
		Installation(context.Context, *InstallationChange) (InstallationStatus, error)
	})
	if !ok {
		return InstallationStatus{}, errors.New("Host controller не поддерживает настройки развёртывания")
	}
	return c.Installation(ctx, change)
}
func (c *HostController) Installation(ctx context.Context, change *InstallationChange) (InstallationStatus, error) {
	var result InstallationStatus
	var value any = struct{}{}
	path := "/v1/installation/status"
	if change != nil {
		if !canonicalID(change.OperationID) {
			return result, errors.New("Некорректный идентификатор операции")
		}
		value = change
		path = "/v1/installation/configure"
	}
	body, err := json.Marshal(value)
	if err != nil || len(body) > 384<<10 {
		return result, errors.New("Слишком большой запрос настроек")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, "POST", "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	response, err := c.client.Do(req)
	if err != nil {
		return result, controllerTransportError(ctx, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (128<<10)+1))
	if err != nil || len(raw) > 128<<10 {
		return result, errors.New("Некорректный ответ настроек развёртывания")
	}
	if response.StatusCode != 200 {
		var failure struct {
			Error struct{ Code, Message string }
		}
		if json.Unmarshal(raw, &failure) == nil && (response.StatusCode == 400 || response.StatusCode == 409) && (failure.Error.Code == "installation_invalid" || failure.Error.Code == "installation_conflict" || failure.Error.Code == "installation_origin_modules" || failure.Error.Code == "installation_tls_modules") {
			return result, &InstallationError{Status: response.StatusCode, Code: failure.Error.Code, Message: controllerErrorMessage(failure.Error.Message)}
		}
		return result, errors.New("Host controller не подтвердил применение настроек")
	}
	if json.Unmarshal(raw, &result) != nil || result.CoreAPI != 1 {
		return InstallationStatus{}, errors.New("Некорректный ответ настроек развёртывания")
	}
	return result, nil
}
