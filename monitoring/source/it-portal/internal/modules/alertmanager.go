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
	"unicode/utf8"

	"pl/portal/internal/model"
)

// Optional capability keeps existing controller implementations and test fakes
// compatible. Every request is finite and uses the authenticated local channel.
type AlertmanagerController interface {
	PrepareAlertmanager(context.Context, string, model.AlertmanagerConfigurationInput) (model.AlertmanagerConfiguration, error)
	ValidateAlertmanager(context.Context, string, string) error
	AlertmanagerStatus(context.Context, string) (model.AlertmanagerStatus, error)
}

func (c *HostController) alertmanagerCall(ctx context.Context, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil || len(body) > 256<<10 {
		return errors.New("Некорректная конфигурация Alertmanager")
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("Некорректный запрос Alertmanager")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	res, err := c.client.Do(req)
	if err != nil {
		return controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, (256<<10)+1))
	if err != nil {
		return controllerTransportError(ctx, err)
	}
	// Never persist or return upstream error bodies: they can contain input secrets.
	if res.StatusCode != http.StatusOK || len(data) > 256<<10 || json.Unmarshal(data, output) != nil {
		return errors.New("Host controller отклонил запрос Alertmanager; проверьте настройки и доступность модуля")
	}
	return nil
}
func (c *HostController) PrepareAlertmanager(ctx context.Context, id string, input model.AlertmanagerConfigurationInput) (model.AlertmanagerConfiguration, error) {
	var out model.AlertmanagerConfiguration
	if !canonicalID(id) {
		return out, errors.New("Некорректный экземпляр Alertmanager")
	}
	err := c.alertmanagerCall(ctx, "/v1/alertmanager/prepare", map[string]any{"instance_id": id, "configuration": input}, &out)
	if err == nil && (!canonicalID(out.Ref) || out.Revision != input.Revision+1 || len(out.Receivers) > 32) {
		err = errors.New("Host controller не подтвердил план Alertmanager")
	}
	return out, err
}
func (c *HostController) ValidateAlertmanager(ctx context.Context, id, ref string) error {
	if !canonicalID(id) || !canonicalID(ref) {
		return errors.New("Некорректный план Alertmanager")
	}
	var out struct {
		Valid bool `json:"valid"`
	}
	if err := c.alertmanagerCall(ctx, "/v1/alertmanager/validate", map[string]string{"instance_id": id, "configuration_ref": ref}, &out); err != nil {
		return err
	}
	if !out.Valid {
		return errors.New("Конфигурация Alertmanager не прошла проверку")
	}
	return nil
}
func (c *HostController) AlertmanagerStatus(ctx context.Context, id string) (model.AlertmanagerStatus, error) {
	var out model.AlertmanagerStatus
	if !canonicalID(id) {
		return out, errors.New("Некорректный экземпляр Alertmanager")
	}
	err := c.alertmanagerCall(ctx, "/v1/alertmanager/status", map[string]string{"instance_id": id}, &out)
	if err == nil && out.State != "running" && out.State != "disabled" && out.State != "absent" && out.State != "error" {
		err = errors.New("Некорректный ответ Alertmanager")
	}
	return out, err
}

// Email tools remain an optional capability for compatible controller fakes.
type AlertmanagerEmailController interface {
	PreviewAlertmanagerEmail(context.Context, string, model.AlertmanagerEmailMessage, string) (model.AlertmanagerEmailPreview, error)
	TestAlertmanagerEmail(context.Context, string, model.AlertmanagerEmailTest) error
}

type AlertmanagerMessageController interface {
	PreviewAlertmanagerMessage(context.Context, string, string, model.AlertmanagerEmailMessage, string) (model.AlertmanagerMessagePreview, error)
}

func (c *HostController) PreviewAlertmanagerMessage(ctx context.Context, id, kind string, message model.AlertmanagerEmailMessage, status string) (model.AlertmanagerMessagePreview, error) {
	var out model.AlertmanagerMessagePreview
	limits := map[string]int{"webhook": 8192, "telegram": 3800, "slack": 6000, "discord": 3800, "msteamsv2": 4000, "pagerduty": 8192}
	limit, supported := limits[kind]
	if !canonicalID(id) || !supported || (status != "firing" && status != "resolved") {
		return out, errors.New("Некорректный запрос предпросмотра")
	}
	err := c.alertmanagerCall(ctx, "/v1/alertmanager/preview", map[string]any{"instance_id": id, "kind": kind, "message": message, "status": status}, &out)
	if err != nil {
		return model.AlertmanagerMessagePreview{}, err
	}
	if out.Kind != kind || out.Title == "" || utf8.RuneCountInString(out.Title) > 160 || utf8.RuneCountInString(out.Text) > limit || (kind == "telegram" && utf8.RuneCountInString(out.Title+"\n\n"+out.Text) > limit) {
		return model.AlertmanagerMessagePreview{}, errors.New("Native renderer вернул некорректный предпросмотр")
	}
	if kind == "webhook" {
		payload, err := json.Marshal(out.Payload)
		if err != nil || len(payload) > 64<<10 || len(out.Payload) != 1 || out.Payload["pl_notification"] == nil {
			return model.AlertmanagerMessagePreview{}, errors.New("Native renderer вернул некорректный webhook payload")
		}
	} else if out.Payload != nil {
		return model.AlertmanagerMessagePreview{}, errors.New("Native renderer вернул неожиданный payload")
	}
	return out, nil
}

func (c *HostController) PreviewAlertmanagerEmail(ctx context.Context, id string, message model.AlertmanagerEmailMessage, status string) (model.AlertmanagerEmailPreview, error) {
	var out model.AlertmanagerEmailPreview
	if !canonicalID(id) || (status != "firing" && status != "resolved") {
		return out, errors.New("Некорректный запрос preview")
	}
	err := c.alertmanagerCall(ctx, "/v1/alertmanager/preview", map[string]any{"instance_id": id, "message": message, "status": status}, &out)
	return out, err
}
func (c *HostController) TestAlertmanagerEmail(ctx context.Context, id string, input model.AlertmanagerEmailTest) error {
	if !canonicalID(id) || !canonicalID(input.ConfigurationRef) || !canonicalID(input.TestID) || (input.Status != "firing" && input.Status != "resolved") {
		return errors.New("Некорректный запрос контрольного письма")
	}
	var out struct {
		Accepted bool `json:"accepted"`
	}
	err := c.alertmanagerCall(ctx, "/v1/alertmanager/test-notification", map[string]any{"instance_id": id, "configuration_ref": input.ConfigurationRef, "receiver": input.Receiver, "test_id": input.TestID, "status": input.Status}, &out)
	if err == nil && !out.Accepted {
		return errors.New("Alertmanager не подтвердил приём контрольного события")
	}
	return err
}
