package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
)

func TestAlertmanagerControllerSignsFinitePrepareValidateStatusAndAlertsRead(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	ref := "22222222-2222-4222-8222-222222222222"
	var calls atomic.Int32
	c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Method != "POST" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("unsigned Alertmanager request")
		}
		var input map[string]json.RawMessage
		if json.Unmarshal(body, &input) != nil {
			t.Error("invalid signed JSON")
		}
		if string(input["instance_id"]) != `"`+id+`"` {
			t.Error("wrong instance identity")
		}
		switch r.URL.Path {
		case "/v1/alertmanager/prepare":
			if !strings.Contains(string(body), "private-token-secret") || !strings.Contains(string(body), "private-smtp-password") {
				t.Error("root prepare lost write-only credentials")
			}
			public := model.DefaultAlertmanagerConfiguration()
			public.Revision = 1
			public.Ref = ref
			json.NewEncoder(w).Encode(public)
		case "/v1/alertmanager/validate":
			if len(input) != 2 || string(input["configuration_ref"]) != `"`+ref+`"` {
				t.Error("validation must send only frozen reference")
			}
			io.WriteString(w, `{"valid":true}`)
		case "/v1/alertmanager/status":
			if len(input) != 1 {
				t.Error("arbitrary status parameters")
			}
			io.WriteString(w, `{"state":"running","version":"fixture"}`)
		case "/v1/alertmanager/read":
			if len(input) != 3 || string(input["path"]) != `"/api/v2/alerts"` || string(input["query"]) != `""` {
				t.Error("root read route is not finite")
			}
			w.Header().Set("Set-Cookie", "private=discard")
			json.NewEncoder(w).Encode(map[string]any{"instance_id": id, "status": 200, "content_type": "application/json", "body": base64.StdEncoding.EncodeToString([]byte(`[{"fingerprint":"actual-alert"}]`))})
		default:
			t.Error("unexpected finite endpoint")
			w.WriteHeader(404)
		}
	})
	input := model.AlertmanagerConfigurationInput{Receivers: []model.AlertmanagerReceiverInput{{Name: "office", Kind: "telegram", Token: "private-token-secret", ChatID: 1}, {Name: "mail", Kind: "email", SMTP: &model.AlertmanagerSMTPInput{Smarthost: "smtp.example.invalid:587", From: "alerts@example.invalid", To: []string{"ops@example.invalid"}, TLSMode: "starttls", Username: "operator", Password: "private-smtp-password"}}}}
	prepared, err := c.PrepareAlertmanager(context.Background(), id, input)
	if err != nil || prepared.Ref != ref {
		t.Fatalf("prepare err=%v", err)
	}
	if err := c.ValidateAlertmanager(context.Background(), id, ref); err != nil {
		t.Fatal(err)
	}
	if status, err := c.AlertmanagerStatus(context.Background(), id); err != nil || status.State != "running" {
		t.Fatalf("status %+v %v", status, err)
	}
	response, err := c.ReadAlertmanager(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(data), "actual-alert") || response.Header.Get("Set-Cookie") != "" {
		t.Fatal("finite alerts read lost data or leaked headers")
	}
	if calls.Load() != 4 {
		t.Fatal("unexpected request count")
	}
	bad := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		io.WriteString(w, `{"error":"private-token-secret private-smtp-password https://hook.invalid/secret"}`)
	})
	_, err = bad.PrepareAlertmanager(context.Background(), id, input)
	if err == nil || strings.Contains(err.Error(), "private-token-secret") || strings.Contains(err.Error(), "private-smtp-password") || strings.Contains(err.Error(), "https://") {
		t.Fatal("root error body leaked")
	}
}

func TestAlertmanagerReadRejectsForeignStatusHTMLMalformedAndOversizedJSON(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	for _, scenario := range []string{"foreign", "redirect", "html", "invalid-base64", "invalid-json", "oversized"} {
		t.Run(scenario, func(t *testing.T) {
			c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				returned, status, ct, body := id, 200, "application/json", base64.StdEncoding.EncodeToString([]byte(`[]`))
				switch scenario {
				case "foreign":
					returned = "foreign"
				case "redirect":
					status = 302
				case "html":
					ct = "text/html"
				case "invalid-base64":
					body = "!"
				case "invalid-json":
					body = base64.StdEncoding.EncodeToString([]byte(`private nonJSON`))
				case "oversized":
					body = base64.StdEncoding.EncodeToString(make([]byte, alertmanagerReadLimit+1))
				}
				json.NewEncoder(w).Encode(map[string]any{"instance_id": returned, "status": status, "content_type": ct, "body": body})
			})
			if response, err := c.ReadAlertmanager(context.Background(), id); err == nil {
				response.Body.Close()
				t.Fatal("invalid read accepted")
			}
		})
	}
}

func TestAlertmanagerEmailToolsUseSignedFiniteControllerRequests(t *testing.T) {
	id, ref, testID := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	calls := 0
	c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("unsigned email operation")
		}
		var input map[string]json.RawMessage
		if json.Unmarshal(body, &input) != nil || string(input["instance_id"]) != `"`+id+`"` {
			t.Error("invalid instance binding")
		}
		switch r.URL.Path {
		case "/v1/alertmanager/preview":
			if len(input) != 3 || string(input["status"]) != `"resolved"` {
				t.Error("unbounded preview input")
			}
			io.WriteString(w, `{"subject":"PL · ВОССТАНОВЛЕНО","html":"<p>native renderer</p>","text":"native renderer"}`)
		case "/v1/alertmanager/test-notification":
			if len(input) != 5 || string(input["configuration_ref"]) != `"`+ref+`"` || string(input["test_id"]) != `"`+testID+`"` {
				t.Error("test identity lost")
			}
			io.WriteString(w, `{"accepted":true}`)
		default:
			t.Error("unexpected email endpoint")
			w.WriteHeader(404)
		}
	})
	preview, err := c.PreviewAlertmanagerEmail(context.Background(), id, model.AlertmanagerEmailMessage{Title: "PL"}, "resolved")
	if err != nil || !strings.Contains(preview.Subject, "ВОССТАНОВЛЕНО") {
		t.Fatalf("preview %+v %v", preview, err)
	}
	input := model.AlertmanagerEmailTest{ConfigurationRef: ref, Receiver: "mail", TestID: testID, Status: "firing"}
	if err := c.TestAlertmanagerEmail(context.Background(), id, input); err != nil {
		t.Fatal(err)
	}
	input.TestID = "invalid"
	if err := c.TestAlertmanagerEmail(context.Background(), id, input); err == nil {
		t.Fatal("invalid test identity accepted")
	}
	if calls != 2 {
		t.Fatal("invalid request reached controller")
	}
}

func TestAlertmanagerMessagesUseExistingSignedRPCAndValidateNativeOutput(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	message := model.AlertmanagerEmailMessage{Title: "{{ .Secret }} · PL", PlatformURL: "https://pl.example/", Footer: "Дежурная смена", ShowLabels: true}
	calls := 0
	c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, make([]byte, 32))
		mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n" + r.URL.Path + "\n"))
		mac.Write(body)
		if r.Method != "POST" || r.URL.Path != "/v1/alertmanager/preview" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			t.Error("generic preview did not use the signed finite endpoint")
		}
		var input struct {
			Instance string                         `json:"instance_id"`
			Kind     string                         `json:"kind"`
			Message  model.AlertmanagerEmailMessage `json:"message"`
			Status   string                         `json:"status"`
		}
		if json.Unmarshal(body, &input) != nil || input.Instance != id || input.Message != message || input.Status != "resolved" {
			t.Error("message preview changed literal settings or identity")
		}
		out := model.AlertmanagerMessagePreview{Kind: input.Kind, Title: "PL · ВОССТАНОВЛЕНО", Text: "Важность: critical · Объект: node-1"}
		if input.Kind == "webhook" {
			out.Payload = map[string]any{"pl_notification": map[string]any{"schema": "pl.notification.v1", "name": "true"}}
		}
		json.NewEncoder(w).Encode(out)
	})
	for _, kind := range []string{"webhook", "telegram", "slack", "discord", "msteamsv2", "pagerduty"} {
		out, err := c.PreviewAlertmanagerMessage(context.Background(), id, kind, message, "resolved")
		if err != nil || out.Kind != kind || !strings.Contains(out.Title, "ВОССТАНОВЛЕНО") {
			t.Fatalf("%s preview: %+v %v", kind, out, err)
		}
	}
	for _, kind := range []string{"email", "unknown", ""} {
		if _, err := c.PreviewAlertmanagerMessage(context.Background(), id, kind, message, "resolved"); err == nil {
			t.Fatal("unsupported kind reached RPC")
		}
	}
	if _, err := c.PreviewAlertmanagerMessage(context.Background(), "foreign", "slack", message, "resolved"); err == nil {
		t.Fatal("invalid instance reached RPC")
	}
	if _, err := c.PreviewAlertmanagerMessage(context.Background(), id, "slack", message, "pending"); err == nil {
		t.Fatal("invalid status reached RPC")
	}
	if calls != 6 {
		t.Fatalf("invalid input performed IO: calls=%d", calls)
	}
	for _, out := range []model.AlertmanagerMessagePreview{
		{Kind: "telegram", Title: "PL", Text: "wrong kind"},
		{Kind: "slack", Title: strings.Repeat("Я", 161)},
		{Kind: "slack", Title: "PL", Text: strings.Repeat("Я", 6001)},
		{Kind: "slack", Title: "PL", Payload: map[string]any{"private": "unexpected"}},
	} {
		bad := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(out) })
		if _, err := bad.PreviewAlertmanagerMessage(context.Background(), id, "slack", message, "resolved"); err == nil {
			t.Fatal("invalid native output accepted")
		}
	}
}
