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
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	DeliveryProxyRequestLimit  = 96 << 10
	deliveryProxyResponseLimit = 64 << 10
)

type DeliveryProxyMode string
type DeliveryProxyProtocol string
type DeliveryProxyAuth string
type DeliveryProxyPasswordAction string

const (
	DeliveryProxyDirect        DeliveryProxyMode           = "direct"
	DeliveryProxyExternal      DeliveryProxyMode           = "external"
	DeliveryProxyXray          DeliveryProxyMode           = "xray"
	DeliveryProxyHTTP          DeliveryProxyProtocol       = "http"
	DeliveryProxySOCKS5        DeliveryProxyProtocol       = "socks5"
	DeliveryProxyNoAuth        DeliveryProxyAuth           = "none"
	DeliveryProxyPasswordAuth  DeliveryProxyAuth           = "password"
	DeliveryProxyKeepPassword  DeliveryProxyPasswordAction = "keep"
	DeliveryProxySetPassword   DeliveryProxyPasswordAction = "set"
	DeliveryProxyClearPassword DeliveryProxyPasswordAction = "clear"
)

// Write-only secrets never belong to DeliveryProxyPublicConfiguration.
// Nil CA preserves the current trust; a pointer to an empty string clears it.
type DeliveryProxyConfiguration struct {
	Mode     DeliveryProxyMode                   `json:"mode"`
	External *DeliveryProxyExternalConfiguration `json:"external,omitempty"`
	Xray     *DeliveryProxyXrayConfiguration     `json:"xray,omitempty"`
	CAPEM    *string                             `json:"ca_pem,omitempty"`
}
type DeliveryProxyExternalConfiguration struct {
	Protocol       DeliveryProxyProtocol       `json:"protocol"`
	Host           string                      `json:"host"`
	Port           int                         `json:"port"`
	Auth           DeliveryProxyAuth           `json:"auth"`
	Username       string                      `json:"username"`
	PasswordAction DeliveryProxyPasswordAction `json:"password_action"`
	Password       *string                     `json:"password,omitempty"`
}
type DeliveryProxyXrayConfiguration struct {
	InstanceID string `json:"instance_id"`
	InboundTag string `json:"inbound_tag"`
}
type DeliveryProxyChange struct {
	OperationID   string                     `json:"operation_id"`
	Revision      int64                      `json:"revision"`
	Configuration DeliveryProxyConfiguration `json:"configuration"`
}
type DeliveryProxyTestRequest struct {
	Revision      int64                      `json:"revision"`
	Configuration DeliveryProxyConfiguration `json:"configuration"`
}

// Preserve the host contract's distinction between absent optional fields and
// explicit null. Reject missing revisions, duplicate keys and unknown fields
// before re-encoding a request; otherwise Go defaults could silently change it.
func decodeDeliveryProxyObject(data []byte, target any, required ...string) error {
	invalid := func() error { return errors.New("Некорректные настройки доставки") }
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return invalid()
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return invalid()
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return invalid()
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return invalid()
	}
	for _, key := range required {
		if !seen[key] {
			return invalid()
		}
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return invalid()
	}
	return nil
}
func (v *DeliveryProxyConfiguration) UnmarshalJSON(data []byte) error {
	type wire DeliveryProxyConfiguration
	var decoded wire
	if err := decodeDeliveryProxyObject(data, &decoded, "mode"); err != nil {
		return err
	}
	*v = DeliveryProxyConfiguration(decoded)
	return nil
}
func (v *DeliveryProxyExternalConfiguration) UnmarshalJSON(data []byte) error {
	type wire DeliveryProxyExternalConfiguration
	var decoded wire
	if err := decodeDeliveryProxyObject(data, &decoded, "protocol", "host", "port", "auth", "username", "password_action"); err != nil {
		return err
	}
	*v = DeliveryProxyExternalConfiguration(decoded)
	return nil
}
func (v *DeliveryProxyXrayConfiguration) UnmarshalJSON(data []byte) error {
	type wire DeliveryProxyXrayConfiguration
	var decoded wire
	if err := decodeDeliveryProxyObject(data, &decoded, "instance_id", "inbound_tag"); err != nil {
		return err
	}
	*v = DeliveryProxyXrayConfiguration(decoded)
	return nil
}
func (v *DeliveryProxyChange) UnmarshalJSON(data []byte) error {
	type wire DeliveryProxyChange
	var decoded wire
	if err := decodeDeliveryProxyObject(data, &decoded, "operation_id", "revision", "configuration"); err != nil {
		return err
	}
	*v = DeliveryProxyChange(decoded)
	return nil
}
func (v *DeliveryProxyTestRequest) UnmarshalJSON(data []byte) error {
	type wire DeliveryProxyTestRequest
	var decoded wire
	if err := decodeDeliveryProxyObject(data, &decoded, "revision", "configuration"); err != nil {
		return err
	}
	*v = DeliveryProxyTestRequest(decoded)
	return nil
}

type DeliveryProxyPublicConfiguration struct {
	Mode     DeliveryProxyMode            `json:"mode"`
	External *DeliveryProxyPublicExternal `json:"external,omitempty"`
	Xray     *DeliveryProxyPublicXray     `json:"xray,omitempty"`
}
type DeliveryProxyPublicXray struct {
	InstanceID string `json:"instance_id"`
	InboundTag string `json:"inbound_tag"`
}
type DeliveryProxyPublicExternal struct {
	Protocol           DeliveryProxyProtocol `json:"protocol"`
	Host               string                `json:"host"`
	Port               int                   `json:"port"`
	Auth               DeliveryProxyAuth     `json:"auth"`
	Username           string                `json:"username"`
	PasswordConfigured bool                  `json:"password_configured"`
}
type DeliveryProxyInbound struct {
	InstanceID string                `json:"instance_id"`
	InboundTag string                `json:"inbound_tag"`
	Protocol   DeliveryProxyProtocol `json:"protocol"`
	Listen     string                `json:"listen"`
	Port       int                   `json:"port"`
	Auth       DeliveryProxyAuth     `json:"auth"`
	Ready      bool                  `json:"ready"`
}
type DeliveryProxyStatus struct {
	CoreAPI       int                              `json:"core_api"`
	Revision      int64                            `json:"revision"`
	Configuration DeliveryProxyPublicConfiguration `json:"configuration"`
	CustomCA      bool                             `json:"custom_ca"`
	CASHA256      string                           `json:"ca_sha256"`
	XrayInbounds  []DeliveryProxyInbound           `json:"xray_inbounds"`
	ErrorCode     string                           `json:"error_code"`
	Error         string                           `json:"error"`
}
type DeliveryProxyTestResult struct {
	OK            bool              `json:"ok"`
	CheckedAt     string            `json:"checked_at"`
	Mode          DeliveryProxyMode `json:"mode"`
	LatestVersion string            `json:"latest_version"`
	ErrorCode     string            `json:"error_code"`
	Error         string            `json:"error"`
}

// The host supplies a finite diagnostic code. Its raw message and response body
// are never errors returned to the browser; they may contain proxy credentials.
type DeliveryProxyError struct {
	Status int
	Code   string
}

func (e *DeliveryProxyError) Error() string {
	return deliveryProxyMessage(e.Code)
}
func deliveryProxyMessage(code string) string {
	switch code {
	case "delivery_proxy_invalid":
		return "Проверьте параметры подключения для загрузки обновлений."
	case "delivery_proxy_conflict":
		return "Настройки подключения изменились. Обновите данные и повторите сохранение."
	case "delivery_proxy_busy":
		return "Сейчас выполняется другая операция PL. Повторите после её завершения."
	case "delivery_proxy_unavailable":
		return "Не удалось подключиться к серверу поставки выбранным способом."
	case "delivery_proxy_auth":
		return "Прокси отклонил имя пользователя или пароль."
	case "delivery_proxy_tls":
		return "Не удалось проверить TLS-сертификат сервера поставки."
	case "delivery_proxy_timeout":
		return "Истекло время проверки подключения к серверу поставки."
	case "delivery_proxy_catalog":
		return "Каталог релизов не прошёл проверку подписи или формата."
	default:
		return "Не удалось проверить подключение для загрузки обновлений."
	}
}
func deliveryProxyErrorStatus(code string) int {
	switch code {
	case "delivery_proxy_invalid":
		return 400
	case "delivery_proxy_conflict", "delivery_proxy_busy":
		return 409
	case "delivery_proxy_unavailable", "delivery_proxy_auth", "delivery_proxy_tls", "delivery_proxy_catalog":
		return 502
	case "delivery_proxy_timeout":
		return 504
	default:
		return 0
	}
}
func safeDeliveryProxyDiagnostic(code, rawMessage string, failed bool) (string, string) {
	if code == "" && rawMessage == "" && !failed {
		return "", ""
	}
	if deliveryProxyErrorStatus(code) == 0 {
		code = "delivery_proxy_unavailable"
	}
	return code, deliveryProxyMessage(code)
}

type DeliveryProxyController interface {
	DeliveryProxyStatus(context.Context) (DeliveryProxyStatus, error)
	ConfigureDeliveryProxy(context.Context, DeliveryProxyChange) (DeliveryProxyStatus, error)
	TestDeliveryProxy(context.Context, DeliveryProxyTestRequest) (DeliveryProxyTestResult, error)
}

func (m *Manager) deliveryProxyController() (DeliveryProxyController, error) {
	if m != nil {
		if c, ok := m.Controller.(DeliveryProxyController); ok {
			return c, nil
		}
	}
	return nil, errors.New("Host controller не поддерживает настройки доставки")
}
func (m *Manager) DeliveryProxyStatus(ctx context.Context) (DeliveryProxyStatus, error) {
	c, err := m.deliveryProxyController()
	if err != nil {
		return DeliveryProxyStatus{}, err
	}
	return c.DeliveryProxyStatus(ctx)
}
func (m *Manager) ConfigureDeliveryProxy(ctx context.Context, change DeliveryProxyChange) (DeliveryProxyStatus, error) {
	c, err := m.deliveryProxyController()
	if err != nil {
		return DeliveryProxyStatus{}, err
	}
	return c.ConfigureDeliveryProxy(ctx, change)
}
func (m *Manager) TestDeliveryProxy(ctx context.Context, request DeliveryProxyTestRequest) (DeliveryProxyTestResult, error) {
	c, err := m.deliveryProxyController()
	if err != nil {
		return DeliveryProxyTestResult{}, err
	}
	return c.TestDeliveryProxy(ctx, request)
}

func (c *HostController) deliveryProxyCall(ctx context.Context, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil || len(body) > DeliveryProxyRequestLimit {
		return &DeliveryProxyError{Status: 400, Code: "delivery_proxy_invalid"}
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("Некорректный запрос настроек доставки")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	response, err := c.client.Do(req)
	if err != nil {
		return controllerTransportError(ctx, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, deliveryProxyResponseLimit+1))
	if err != nil || len(raw) > deliveryProxyResponseLimit {
		return errors.New("Некорректный ответ настроек доставки")
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &failure) == nil && deliveryProxyErrorStatus(failure.Error.Code) == response.StatusCode {
			return &DeliveryProxyError{Status: response.StatusCode, Code: failure.Error.Code}
		}
		return errors.New("Host controller не подтвердил настройки доставки")
	}
	if json.Unmarshal(raw, output) != nil {
		return errors.New("Некорректный ответ настроек доставки")
	}
	return nil
}
func (c *HostController) DeliveryProxyStatus(ctx context.Context) (DeliveryProxyStatus, error) {
	return c.deliveryProxySettings(ctx, "/v1/delivery/proxy/status", struct{}{})
}
func (c *HostController) ConfigureDeliveryProxy(ctx context.Context, change DeliveryProxyChange) (DeliveryProxyStatus, error) {
	if !canonicalID(change.OperationID) || change.Revision < 0 || ValidateDeliveryProxyConfiguration(change.Configuration) != nil {
		return DeliveryProxyStatus{}, &DeliveryProxyError{Status: 400, Code: "delivery_proxy_invalid"}
	}
	return c.deliveryProxySettings(ctx, "/v1/delivery/proxy/configure", change)
}
func (c *HostController) deliveryProxySettings(ctx context.Context, path string, input any) (DeliveryProxyStatus, error) {
	var result DeliveryProxyStatus
	if err := c.deliveryProxyCall(ctx, path, input, &result); err != nil {
		return DeliveryProxyStatus{}, err
	}
	if result.CoreAPI != 1 || result.Revision < 0 || !validDeliveryProxyMode(result.Configuration.Mode) || len(result.XrayInbounds) > 64 {
		return DeliveryProxyStatus{}, errors.New("Некорректный ответ настроек доставки")
	}
	result.ErrorCode, result.Error = safeDeliveryProxyDiagnostic(result.ErrorCode, result.Error, false)
	return result, nil
}
func (c *HostController) TestDeliveryProxy(ctx context.Context, request DeliveryProxyTestRequest) (DeliveryProxyTestResult, error) {
	var result DeliveryProxyTestResult
	if request.Revision < 0 || ValidateDeliveryProxyConfiguration(request.Configuration) != nil {
		return result, &DeliveryProxyError{Status: 400, Code: "delivery_proxy_invalid"}
	}
	if err := c.deliveryProxyCall(ctx, "/v1/delivery/proxy/test", request, &result); err != nil {
		return DeliveryProxyTestResult{}, err
	}
	if !validDeliveryProxyMode(result.Mode) {
		return DeliveryProxyTestResult{}, errors.New("Некорректный ответ проверки доставки")
	}
	result.ErrorCode, result.Error = safeDeliveryProxyDiagnostic(result.ErrorCode, result.Error, !result.OK)
	return result, nil
}

var deliveryProxyHostLabel = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
var deliveryProxyInboundTag = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

func validDeliveryProxyMode(mode DeliveryProxyMode) bool {
	return mode == DeliveryProxyDirect || mode == DeliveryProxyExternal || mode == DeliveryProxyXray
}
func validDeliveryProxyHost(value string) bool {
	if len(value) == 0 || len(value) > 253 || strings.TrimSpace(value) != value {
		return false
	}
	if net.ParseIP(value) != nil {
		return true
	}
	for _, label := range strings.Split(strings.TrimSuffix(value, "."), ".") {
		if !deliveryProxyHostLabel.MatchString(label) {
			return false
		}
	}
	return true
}
func deliveryProxyControl(value string) bool {
	return strings.ContainsFunc(value, func(r rune) bool { return r < 32 || r == 127 })
}
func ValidateDeliveryProxyConfiguration(v DeliveryProxyConfiguration) error {
	invalid := func() error { return &DeliveryProxyError{Status: 400, Code: "delivery_proxy_invalid"} }
	if v.CAPEM != nil && (len(*v.CAPEM) > 65536 || !utf8.ValidString(*v.CAPEM)) {
		return invalid()
	}
	switch v.Mode {
	case DeliveryProxyDirect:
		if v.External != nil || v.Xray != nil {
			return invalid()
		}
	case DeliveryProxyXray:
		if v.External != nil || v.Xray == nil || !canonicalID(v.Xray.InstanceID) || !deliveryProxyInboundTag.MatchString(v.Xray.InboundTag) {
			return invalid()
		}
	case DeliveryProxyExternal:
		if v.Xray != nil || v.External == nil {
			return invalid()
		}
		e := v.External
		if (e.Protocol != DeliveryProxyHTTP && e.Protocol != DeliveryProxySOCKS5) || !validDeliveryProxyHost(e.Host) || e.Port < 1 || e.Port > 65535 || len(e.Username) > 255 || !utf8.ValidString(e.Username) || deliveryProxyControl(e.Username) || e.Protocol == DeliveryProxyHTTP && strings.Contains(e.Username, ":") {
			return invalid()
		}
		if e.Auth != DeliveryProxyNoAuth && e.Auth != DeliveryProxyPasswordAuth {
			return invalid()
		}
		if e.Auth == DeliveryProxyNoAuth && (e.Username != "" || e.PasswordAction != DeliveryProxyClearPassword) || e.Auth == DeliveryProxyPasswordAuth && (e.Username == "" || e.PasswordAction == DeliveryProxyClearPassword) {
			return invalid()
		}
		switch e.PasswordAction {
		case DeliveryProxyKeepPassword, DeliveryProxyClearPassword:
			if e.Password != nil {
				return invalid()
			}
		case DeliveryProxySetPassword:
			limit := 1024
			if e.Protocol == DeliveryProxySOCKS5 {
				limit = 255
			}
			if e.Auth != DeliveryProxyPasswordAuth || e.Password == nil || len(*e.Password) == 0 || len(*e.Password) > limit || !utf8.ValidString(*e.Password) || deliveryProxyControl(*e.Password) {
				return invalid()
			}
		default:
			return invalid()
		}
	default:
		return invalid()
	}
	return nil
}
