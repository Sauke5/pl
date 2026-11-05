package modules

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

// AuditorKeyResolver returns the existing integration's raw 32-byte gateway key.
// The connector never persists the key or includes it in errors and observations.
// A bearer token is not compatible with the Auditor signed-gateway v2 contract.
type AuditorKeyResolver func(context.Context, model.Integration) ([]byte, error)

type AuditorConnector struct {
	guard      *netguard.Guard
	resolveKey AuditorKeyResolver
	clock      func() time.Time
}

func NewAuditorConnector(guard *netguard.Guard, resolveKey AuditorKeyResolver) *AuditorConnector {
	return &AuditorConnector{guard: guard, resolveKey: resolveKey, clock: time.Now}
}

// AuditorInstance is intentionally limited to fields confirmed by the existing
// Windows Auditor gateway contract. The connector does not infer scan health,
// findings or server capacity from instance reachability.
type AuditorInstance struct {
	MachineName string `json:"machine_name"`
	RootCount   int    `json:"root_count"`
}

func ValidateAuditorEndpoint(raw string) (string, error) {
	if parsed, err := url.Parse(raw); err == nil && strings.Contains(parsed.Path, "//") {
		return "", errors.New("Некорректный базовый путь File Auditor")
	}
	endpoint, err := ValidateEndpoint(raw)
	if err != nil {
		return "", errors.New("Укажите HTTP(S) адрес File Auditor без логина, параметров и фрагмента")
	}
	parsed, _ := url.Parse(endpoint)
	if parsed.Path != "/audit" && parsed.Path != "/audit-arch" {
		return "", errors.New("Адрес File Auditor должен заканчиваться на /audit или /audit-arch")
	}
	return endpoint, nil
}

var auditorReadAsset = regexp.MustCompile(`^/assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$`)
var auditorReadDepartment = regexp.MustCompile(`^/(?:departments|api/departments|api/intelligence/departments)/[1-9][0-9]*$`)
var auditorReadSimulation = regexp.MustCompile(`^/api/intelligence/departments/[1-9][0-9]*/simulate$`)
var auditorReadPaths = map[string]bool{
	"/": true, "/departments": true, "/documents": true, "/scans": true,
	"/service": true, "/favicon.svg": true, "/api/instance": true,
	"/api/findings": true, "/api/departments": true, "/api/scans": true,
	"/api/scans/current": true, "/api/dashboard": true,
	"/api/intelligence/overview": true, "/api/scans/latest": true,
}

// ValidateAuditorRead mirrors the existing Auditor gateway's finite GET routes.
// It deliberately cannot start scans, authenticate or alter server configuration.
func ValidateAuditorRead(path, query string) error {
	if len(path) > 1024 || len(query) > 8192 || !utf8.ValidString(path+query) || strings.ContainsAny(path, "%\\") || strings.Contains(path, "..") || strings.Contains(path, "//") || strings.Contains(query, "#") || strings.ContainsFunc(query, func(r rune) bool { return r > 127 }) || strings.ContainsFunc(path+query, unicode.IsControl) || (!auditorReadPaths[path] && !auditorReadAsset.MatchString(path) && !auditorReadDepartment.MatchString(path) && !auditorReadSimulation.MatchString(path)) {
		return errors.New("Этот маршрут File Auditor недоступен через платформу")
	}
	values, err := url.ParseQuery(query)
	if err != nil || len(values) > 128 {
		return errors.New("Некорректные параметры запроса File Auditor")
	}
	count := 0
	for key, items := range values {
		for _, value := range items {
			count++
			if count > 128 || !utf8.ValidString(key+value) || strings.ContainsFunc(key+value, unicode.IsControl) {
				return errors.New("Некорректные параметры запроса File Auditor")
			}
		}
	}
	return nil
}

// Read is a bounded server-side read using a dedicated, explicitly read-only
// service identity. Browser requests must continue to use ServiceGateway and its
// real Platform session identity; this service identity does not grant scan scope.
func (c *AuditorConnector) Read(ctx context.Context, integration model.Integration, path, query string) (*http.Response, error) {
	if err := ValidateAuditorRead(path, query); err != nil {
		return nil, err
	}
	if c == nil || c.guard == nil || c.resolveKey == nil || integration.Kind != "fileauditor" || !integration.Enabled || integration.SecretRef == "" {
		return nil, errors.New("Подключение File Auditor не настроено")
	}
	endpoint, err := ValidateAuditorEndpoint(integration.URL)
	if err != nil {
		return nil, err
	}
	budget := integration.TimeoutSeconds
	if budget < 1 || budget > 30 {
		budget = 15
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(budget)*time.Second)
	defer cancel()
	base, _ := url.Parse(endpoint)
	if err = c.guard.ValidateURL(base); err != nil {
		return nil, errors.New("Адрес File Auditor не разрешён сетевой политикой")
	}
	// ValidateURL checks URL syntax and port. Resolve independently checks every
	// DNS answer before loading signing material; DialContext rechecks the policy
	// at connection time, so this preflight cannot permit DNS rebinding.
	if _, err = c.guard.Resolve(ctx, base.Hostname()); err != nil {
		return nil, errors.New("Адрес File Auditor не разрешён сетевой политикой или недоступен в DNS")
	}
	key, err := c.resolveKey(ctx, integration)
	if err != nil || len(key) != 32 {
		return nil, errors.New("Ключ signed gateway File Auditor недоступен или имеет неверный формат")
	}
	address := endpoint + path
	if query != "" {
		address += "?" + query
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, errors.New("Некорректный запрос File Auditor")
	}
	request.Header.Set("Accept", "application/json")
	if err = c.signRead(request, key); err != nil {
		return nil, err
	}
	client := c.guard.Client(time.Duration(budget) * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("File Auditor недоступен; проверьте адрес, TLS и сетевой доступ")
	}
	defer response.Body.Close()
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if !readStatus(response.StatusCode) || !readContentType(contentType) {
		return nil, errors.New("Некорректный ответ File Auditor")
	}
	limit := int64(ReadLimit)
	if path == "/api/instance" {
		limit = 1 << 20
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, errors.New("Ответ File Auditor превышает допустимый размер")
	}
	// Only the body, status and content type cross the connector boundary. Never
	// forward cookies, redirects, authentication or upstream identity headers.
	return bufferedResponse(response.StatusCode, contentType, body), nil
}

func (c *AuditorConnector) Instance(ctx context.Context, integration model.Integration) (AuditorInstance, error) {
	var instance AuditorInstance
	response, err := c.Read(ctx, integration, "/api/instance", "")
	if err != nil {
		return instance, err
	}
	defer response.Body.Close()
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != http.StatusOK || err != nil || mediaType != "application/json" {
		return instance, errors.New("Источник не подтвердил API File Auditor; проверьте signed gateway и prefix")
	}
	var wire struct {
		MachineName string             `json:"machineName"`
		Roots       *[]json.RawMessage `json:"roots"`
	}
	decoder := json.NewDecoder(response.Body)
	if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF || strings.TrimSpace(wire.MachineName) != wire.MachineName || wire.MachineName == "" || len(wire.MachineName) > 255 || !utf8.ValidString(wire.MachineName) || strings.ContainsFunc(wire.MachineName, unicode.IsControl) || wire.Roots == nil || len(*wire.Roots) > 10000 {
		return instance, errors.New("File Auditor вернул некорректные сведения об экземпляре")
	}
	instance.MachineName, instance.RootCount = wire.MachineName, len(*wire.Roots)
	return instance, nil
}

func (c *AuditorConnector) Probe(ctx context.Context, integration model.Integration) (Observation, error) {
	observation := Observation{Endpoint: integration.URL}
	if _, err := c.Instance(ctx, integration); err != nil {
		return observation, err
	}
	observation.State = "running"
	return observation, nil
}

// Auditor v2 authenticates the encoded bytes. JSON property order follows the
// published cross-language vector even though the verifier must not reserialize.
func (c *AuditorConnector) signRead(request *http.Request, key []byte) error {
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return errors.New("Не удалось подписать запрос File Auditor")
	}
	now := time.Now()
	if c.clock != nil {
		now = c.clock()
	}
	digest := sha256.Sum256(nil)
	claims := struct {
		Version        int      `json:"v"`
		Audience       string   `json:"aud"`
		IssuedAt       int64    `json:"iat"`
		ExpiresAt      int64    `json:"exp"`
		Nonce          string   `json:"nonce"`
		Subject        string   `json:"sub"`
		Name           string   `json:"name"`
		Admin          bool     `json:"admin"`
		Scopes         []string `json:"scopes"`
		Method         string   `json:"method"`
		URI            string   `json:"uri"`
		ContentType    string   `json:"content_type"`
		BodySHA256     string   `json:"body_sha256"`
		IdempotencyKey string   `json:"idempotency_key"`
		SourceIP       string   `json:"source_ip"`
		CSRFToken      string   `json:"csrf_token"`
		CSRFVerified   bool     `json:"csrf_verified"`
	}{2, "auditor", now.Unix(), now.Unix() + 30, base64.RawURLEncoding.EncodeToString(nonce[:]), "system:modules:fileauditor", "Pl File Auditor connector", false, []string{"auditor:read"}, http.MethodGet, request.URL.RequestURI(), "", hex.EncodeToString(digest[:]), "", "127.0.0.1", auditorMAC(key, "pl-auditor-read-csrf-v2\n"), false}
	payload, err := json.Marshal(claims)
	if err != nil {
		return errors.New("Не удалось подписать запрос File Auditor")
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	request.Header.Set("X-PL-Gateway-Assertion", encoded)
	request.Header.Set("X-PL-Gateway-Signature", auditorMAC(key, "pl-gateway-v2\n"+encoded))
	return nil
}

func auditorMAC(key []byte, text string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(text))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
