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

	"pl/portal/internal/model"
)

// XrayConfigurationError exposes only controller diagnostic codes reviewed for
// public use. Neither a controller error body nor a wrapped parser error is shown.
type XrayConfigurationError struct{ Code string }

func (e *XrayConfigurationError) Error() string {
	if message := xrayConfigurationMessage(e.Code); message != "" {
		return message
	}
	return "Не удалось проверить настройки Xray"
}
func (e *XrayConfigurationError) Known() bool {
	return e != nil && xrayConfigurationMessage(e.Code) != ""
}
func xrayConfigurationMessage(code string) string {
	switch code {
	case "xray_invalid_outbound":
		return "Не удалось разобрать ссылку outbound. Проверьте формат ссылки подключения."
	case "xray_unsupported_outbound_parameters":
		return "Ссылка содержит неподдерживаемые параметры outbound."
	case "xray_unsupported_transport":
		return "Транспорт или режим защиты outbound пока не поддерживается."
	case "xray_host_addresses_unavailable":
		return "Не удалось получить IPv4-адреса хоста. Проверьте доступность host controller."
	case "xray_invalid_bind_address":
		return "Укажите IPv4-адрес, назначенный этому хосту: 127.0.0.1 или адрес частной сети."
	case "xray_port_in_use":
		return "Выбранный адрес и TCP-порт уже заняты. Укажите другой порт входящего подключения. Работающий сервис не изменён."
	case "xray_bind_unavailable":
		return "Не удалось открыть выбранный адрес и TCP-порт. Проверьте адрес хоста и доступность порта. Работающий сервис не изменён."
	}
	return ""
}

// Optional capability keeps existing controller implementations and test fakes
// compatible. Every request is finite and uses the authenticated local channel.
type XrayController interface {
	PrepareXray(context.Context, string, model.XrayConfigurationInput) (model.XrayConfiguration, error)
	ValidateXray(context.Context, string, string) error
	XrayStatus(context.Context, string) (model.XrayStatus, error)
}

func (c *HostController) xrayCall(ctx context.Context, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil || len(body) > 128<<10 {
		return errors.New("Некорректная конфигурация Xray")
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("Некорректный запрос Xray")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	res, err := c.client.Do(req)
	if err != nil {
		return controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, (128<<10)+1))
	if err != nil {
		return controllerTransportError(ctx, err)
	}
	// Decode only an allowlisted code on the expected validation status. Ignore
	// every other response field, including error/message which may contain secrets.
	if res.StatusCode == http.StatusBadRequest && len(data) <= 128<<10 {
		var diagnostic struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(data, &diagnostic) == nil {
			safe := &XrayConfigurationError{Code: diagnostic.Code}
			if safe.Known() {
				return safe
			}
		}
	}
	// Never persist or return upstream error bodies: they can contain input secrets.
	if res.StatusCode != http.StatusOK || len(data) > 128<<10 || json.Unmarshal(data, output) != nil {
		return errors.New("Host controller отклонил запрос Xray; проверьте настройки и доступность модуля")
	}
	return nil
}
func (c *HostController) PrepareXray(ctx context.Context, id string, input model.XrayConfigurationInput) (model.XrayConfiguration, error) {
	var out model.XrayConfiguration
	if !canonicalID(id) {
		return out, errors.New("Некорректный экземпляр Xray")
	}
	err := c.xrayCall(ctx, "/v1/xray/prepare", map[string]any{"instance_id": id, "configuration": input}, &out)
	if err == nil && (!canonicalID(out.Ref) || out.Revision != input.Revision+1 || len(out.Inbounds) > 16) {
		err = errors.New("Host controller не подтвердил план Xray")
	}
	return out, err
}
func (c *HostController) ValidateXray(ctx context.Context, id, ref string) error {
	if !canonicalID(id) || !canonicalID(ref) {
		return errors.New("Некорректный план Xray")
	}
	var out struct {
		Valid bool `json:"valid"`
	}
	if err := c.xrayCall(ctx, "/v1/xray/validate", map[string]string{"instance_id": id, "configuration_ref": ref}, &out); err != nil {
		return err
	}
	if !out.Valid {
		return errors.New("Конфигурация Xray не прошла проверку")
	}
	return nil
}
func (c *HostController) XrayStatus(ctx context.Context, id string) (model.XrayStatus, error) {
	var out model.XrayStatus
	if !canonicalID(id) {
		return out, errors.New("Некорректный экземпляр Xray")
	}
	err := c.xrayCall(ctx, "/v1/xray/status", map[string]string{"instance_id": id}, &out)
	if err == nil && (len(out.Inbounds) > 16 || len(out.Counters) > 128) {
		err = errors.New("Некорректный ответ Xray")
	}
	return out, err
}
