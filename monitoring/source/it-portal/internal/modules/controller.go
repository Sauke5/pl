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
	"net"
	"net/http"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type Observation struct {
	ConfigurationRevision int64  `json:"configuration_revision,omitempty"`
	ConfigurationHash     string `json:"configuration_hash,omitempty"`
	ConfigurationYAML     string `json:"configuration_yaml,omitempty"`
	RolledBack            bool   `json:"rolled_back,omitempty"`
	State                 string `json:"state"`
	Version               string `json:"version"`
	Endpoint              string `json:"endpoint"`
	TargetsUp             int    `json:"targets_up"`
	TargetsTotal          int    `json:"targets_total"`
	Error                 string `json:"error"`
	OperationID           string `json:"operation_id"`
}
type Operation struct {
	PrometheusInstanceID string                         `json:"prometheus_instance_id,omitempty"`
	PublicURL            string                         `json:"public_url,omitempty"`
	ConfigurationRef     string                         `json:"configuration_ref,omitempty"`
	Configuration        *model.PrometheusConfiguration `json:"configuration,omitempty"`
	OperationID          string                         `json:"operation_id"`
	InstanceID           string                         `json:"instance_id"`
	ModuleID             string                         `json:"module_id"`
	Action               string                         `json:"action"`
}
type Controller interface {
	Apply(context.Context, Operation) (Observation, error)
}
type HostController struct {
	key    []byte
	client *http.Client
}

func NewHostController(socket, keyFile string) (*HostController, error) {
	if socket == "" && keyFile == "" {
		return nil, nil
	}
	if !filepath.IsAbs(socket) || !filepath.IsAbs(keyFile) {
		return nil, errors.New("module controller requires absolute socket and key paths")
	}
	key, err := os.ReadFile(keyFile)
	if err != nil || len(key) != 32 {
		return nil, errors.New("module controller key must contain 32 raw bytes")
	}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
	}, MaxResponseHeaderBytes: 16384}
	return &HostController{key: key, client: &http.Client{Transport: transport, Timeout: 310 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("controller redirect denied") }}}, nil
}
func (c *HostController) Apply(ctx context.Context, op Operation) (Observation, error) {
	var out Observation
	body, err := json.Marshal(op)
	if err != nil {
		return out, err
	}
	path := "/v1/operations"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	_, _ = mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, "POST", "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	client := c.client
	if timeout := model.ModuleStartupControllerTimeout(op.ModuleID, op.Action); timeout > 0 {
		// A per-call copy preserves the shared client's short budget for all
		// other operations and still honors an earlier caller cancellation.
		startupClient := *c.client
		startupClient.Timeout = timeout
		client = &startupClient
	}
	res, err := client.Do(req)
	if err != nil {
		return out, controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
	if err != nil {
		return out, controllerTransportError(ctx, err)
	}
	if len(data) > 2<<20 {
		return out, errors.New("Некорректный ответ host controller")
	}
	if err = json.Unmarshal(data, &out); err != nil {
		return out, errors.New("Некорректный ответ host controller")
	}
	if res.StatusCode != 200 || out.OperationID != op.OperationID {
		return out, errors.New("Host controller не подтвердил операцию")
	}
	if out.State != "running" && out.State != "disabled" && out.State != "unavailable" && out.State != "error" && out.State != "absent" {
		return out, errors.New("Host controller вернул неизвестное состояние")
	}
	if out.State == "error" || out.State == "unavailable" {
		message := controllerErrorMessage(out.Error)
		if message == "" {
			message = "Модуль недоступен или операция завершилась ошибкой; проверьте host controller"
		}
		return out, errors.New(message)
	}
	return out, nil
}

// Observe performs a fresh ownership and readiness check in the host controller.
func (c *HostController) Observe(ctx context.Context, instanceID string) (Observation, error) {
	var out Observation
	if !canonicalID(instanceID) {
		return out, ErrApplicationUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	path := "/v1/instances/" + instanceID
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(timestamp + "\nGET\n" + path + "\n"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://module-controller"+path, nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("X-Pl-Timestamp", timestamp)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	response, err := c.client.Do(req)
	if err != nil {
		return out, controllerTransportError(ctx, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || response.StatusCode != http.StatusOK || len(body) > 2<<20 || json.Unmarshal(body, &out) != nil {
		return out, errors.New("Host controller не подтвердил состояние модуля")
	}
	if out.State != "running" && out.State != "disabled" && out.State != "absent" && out.State != "unavailable" && out.State != "error" {
		return out, errors.New("Host controller вернул неизвестное состояние")
	}
	return out, nil
}

// Read uses the same authenticated local channel as lifecycle operations. The host
// selects the owned loopback endpoint; neither URL nor headers cross this boundary.
func (c *HostController) Read(ctx context.Context, instanceID, path, query string) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := ValidateRead(path, query); err != nil {
		return nil, err
	}
	if !canonicalID(instanceID) {
		return nil, errors.New("Некорректный экземпляр модуля")
	}
	body, _ := json.Marshal(map[string]string{"instance_id": instanceID, "path": path, "query": query})
	var data []byte
	status := 0
	for attempt := 0; attempt < 6; attempt++ {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, c.key)
		mac.Write([]byte(ts + "\nPOST\n/v1/read\n"))
		mac.Write(body)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller/v1/read", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Pl-Timestamp", ts)
		req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
		res, err := c.client.Do(req)
		if err != nil {
			return nil, controllerTransportError(ctx, err)
		}
		data, err = io.ReadAll(io.LimitReader(res.Body, (ReadLimit*4/3)+4097))
		res.Body.Close()
		if err != nil {
			return nil, controllerTransportError(ctx, err)
		}
		status = res.StatusCode
		var busy struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if status != http.StatusServiceUnavailable || len(data) > 4096 || json.Unmarshal(data, &busy) != nil || busy.Error.Code != "controller_busy" || attempt == 5 {
			break
		}
		// Only a typed read-lock conflict may retry. Five bounded backoffs total
		// three seconds; each attempt is freshly signed under the same deadline.
		timer := time.NewTimer(time.Duration(attempt+1) * 200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, controllerTransportError(ctx, ctx.Err())
		case <-timer.C:
		}
	}
	if status != 200 || len(data) > (ReadLimit*4/3)+4096 {
		return nil, errors.New("Host controller не подтвердил чтение модуля")
	}
	var out struct {
		InstanceID  string `json:"instance_id"`
		Status      int    `json:"status"`
		ContentType string `json:"content_type"`
		Body        string `json:"body"`
	}
	if json.Unmarshal(data, &out) != nil || out.InstanceID != instanceID || !readStatus(out.Status) || !readContentType(out.ContentType) {
		return nil, errors.New("Некорректный ответ host controller")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(out.Body)
	if err != nil || len(decoded) > ReadLimit {
		return nil, errors.New("Ответ модуля превышает допустимый размер")
	}
	return bufferedResponse(out.Status, out.ContentType, decoded), nil
}

// Controller errors are fixed operator-facing messages, never Docker stderr.
// Bound and normalize them before persisting to the browser-facing instance.
func controllerErrorMessage(raw string) string {
	raw = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, raw)
	runes := []rune(raw)
	if len(runes) > 256 {
		raw = string(runes[:256])
	}
	return strings.TrimSpace(raw)
}

func controllerTransportError(ctx context.Context, err error) error {
	cause := ctx.Err()
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() {
		cause = context.DeadlineExceeded
	}
	return errors.Join(errors.New("Host controller недоступен; результат операции требует проверки"), cause)
}
