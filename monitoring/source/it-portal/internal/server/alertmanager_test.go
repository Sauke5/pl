package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

type alertmanagerControllerFixture struct {
	read    func(context.Context, string) (*http.Response, error)
	prepare func(model.AlertmanagerConfigurationInput) (model.AlertmanagerConfiguration, error)
	apply   func(modules.Operation) (modules.Observation, error)
}

func (f *alertmanagerControllerFixture) ReadAlertmanager(ctx context.Context, id string) (*http.Response, error) {
	return f.read(ctx, id)
}

func (f *alertmanagerControllerFixture) Apply(_ context.Context, op modules.Operation) (modules.Observation, error) {
	return f.apply(op)
}
func (f *alertmanagerControllerFixture) PrepareAlertmanager(_ context.Context, _ string, c model.AlertmanagerConfigurationInput) (model.AlertmanagerConfiguration, error) {
	return f.prepare(c)
}
func (f *alertmanagerControllerFixture) ValidateAlertmanager(context.Context, string, string) error {
	return nil
}
func (f *alertmanagerControllerFixture) AlertmanagerStatus(context.Context, string) (model.AlertmanagerStatus, error) {
	return model.AlertmanagerStatus{State: "running", Version: "fixture"}, nil
}

func TestAlertmanagerPublicConfigurationFrozenRetryAndRealIntegration(t *testing.T) {
	s, admin := localUsersFixture(t)
	viewer := apiUser(t, s, "notifications.viewer", false)
	controller := &alertmanagerControllerFixture{}
	controller.apply = func(op modules.Operation) (modules.Observation, error) {
		return modules.Observation{State: "running", Version: "fixture", Endpoint: "http://127.0.0.1:19093", OperationID: op.OperationID}, nil
	}
	s.Modules = modules.New(s.Store, controller)
	polls := 0
	registry := providers.New(nil, "")
	registry.ManagedRead = s.Modules.ReadIntegration
	s.Modules.Poll = registry.Poll
	controller.read = func(_ context.Context, id string) (*http.Response, error) {
		polls++
		if !canonicalUUID(id) {
			t.Fatal("root reader received URL instead of owned module ID")
		}
		payload := `[{"fingerprint":"fixture-alert","labels":{"alertname":"FixtureAlert","severity":"warning"},"annotations":{"summary":"Alertmanager fixture"},"startsAt":"2026-10-18T00:00:00Z","status":{"state":"active","silencedBy":[],"inhibitedBy":[]}}]`
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(payload))}, nil
	}

	create := map[string]any{"module_id": "alertmanager", "name": "Notifications", "mode": "local", "idempotency_key": "alertmanager:install"}
	w := apiCall(s, admin, "POST", "/api/v1/modules", create, nil)
	if w.Code != 202 {
		t.Fatalf("install %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if _, err := finishModuleFixture(t, s); err != nil {
		t.Fatal(err)
	}
	integration, err := store.Get[model.Integration](context.Background(), s.Store, "integration", created.Instance.IntegrationID)
	if err != nil || integration.Kind != "alertmanager" || integration.Status != "connected" || polls != 1 {
		t.Fatalf("native integration %+v polls=%d err=%v", integration, polls, err)
	}
	resource, err := store.Get[model.Resource](context.Background(), s.Store, "resource", created.Instance.ResourceID)
	if err != nil || resource.URL != "/#modules?instance="+created.Instance.ID+"&view=alertmanager" {
		t.Fatalf("resource %+v %v", resource, err)
	}
	problems, err := store.List[model.Problem](context.Background(), s.Store, "problem")
	if err != nil || len(problems) != 1 || problems[0].Title != "Alertmanager fixture" || problems[0].IntegrationID != integration.ID {
		t.Fatalf("native alert snapshot missing %+v %v", problems, err)
	}
	if response, err := s.Modules.ReadIntegration(context.Background(), integration, "/api/v2/status", ""); err == nil {
		if response != nil {
			response.Body.Close()
		}
		t.Fatal("private status/config route exposed")
	}
	root := "/api/v1/modules/" + created.Instance.ID + "/alertmanager"
	for _, suffix := range []string{"/configuration", "/status"} {
		if w := apiCall(s, viewer, "GET", root+suffix, nil, nil); w.Code != 403 {
			t.Fatalf("viewer read %d", w.Code)
		}
	}
	input := model.AlertmanagerConfigurationInput{Route: model.AlertmanagerRoute{Receiver: "office", GroupWait: "0s", GroupInterval: "1s", RepeatInterval: "1h"}, Receivers: []model.AlertmanagerReceiverInput{
		{Name: "office", Kind: "webhook", Endpoint: "https://notifications.invalid/private-webhook-secret", Proxy: model.AlertmanagerProxyInput{Mode: "http", URL: "http://proxy.invalid:3128", Username: "operator", Password: "private-proxy-password", NoProxy: []string{".internal.invalid", "192.168.0.0/16"}}},
		{Name: "telegram", Kind: "telegram", Token: "123:private-token-secret", ChatID: -123456, Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}},
		{Name: "mail", Kind: "email", SMTP: &model.AlertmanagerSMTPInput{Smarthost: "smtp.example.invalid:587", From: "alerts@example.invalid", To: []string{"ops@example.invalid"}, TLSMode: "starttls", Username: "operator", Password: "private-smtp-password"}, Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}},
		{Name: "teams", Kind: "msteamsv2", Endpoint: "https://workflow.invalid/private-teams-hook", Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}},
		{Name: "pager", Kind: "pagerduty", Token: "private-pagerduty-routing-key", Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}},
	}}
	plan := uuid.NewString()
	controller.prepare = func(v model.AlertmanagerConfigurationInput) (model.AlertmanagerConfiguration, error) {
		if v.Receivers[0].Endpoint != input.Receivers[0].Endpoint || v.Receivers[0].Proxy.Password != input.Receivers[0].Proxy.Password || v.Receivers[1].Token != input.Receivers[1].Token || v.Receivers[2].SMTP == nil || v.Receivers[2].SMTP.Password != input.Receivers[2].SMTP.Password || v.Receivers[3].Endpoint != input.Receivers[3].Endpoint || v.Receivers[4].Token != input.Receivers[4].Token {
			t.Fatal("root prepare lost write-only credentials")
		}
		return model.AlertmanagerConfiguration{Revision: v.Revision + 1, Ref: plan, Route: v.Route, Receivers: []model.AlertmanagerReceiver{
			{Name: "office", Kind: "webhook", EndpointSet: true, Proxy: model.AlertmanagerProxy{Mode: "http", URL: "http://proxy.invalid:3128", Username: "operator", PasswordSet: true, CASet: true, NoProxy: []string{".internal.invalid", "192.168.0.0/16"}}},
			{Name: "telegram", Kind: "telegram", EndpointSet: true, TokenSet: true, ChatID: -123456, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}},
			{Name: "mail", Kind: "email", SMTP: &model.AlertmanagerSMTP{Smarthost: "smtp.example.invalid:587", From: "alerts@example.invalid", To: []string{"ops@example.invalid"}, TLSMode: "starttls", Username: "operator", PasswordSet: true}, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}},
			{Name: "teams", Kind: "msteamsv2", EndpointSet: true, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}},
			{Name: "pager", Kind: "pagerduty", EndpointSet: true, TokenSet: true, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}},
		}}, nil
	}
	payload := map[string]any{"configuration": input}
	if w := apiCall(s, viewer, "PUT", root+"/configuration", payload, nil); w.Code != 403 {
		t.Fatalf("viewer mutation %d", w.Code)
	}
	if w := apiCall(s, admin, "PUT", root+"/configuration", payload, map[string]string{"X-CSRF-Token": "forged"}); w.Code != 403 {
		t.Fatal("missing CSRF protection")
	}
	w = apiCall(s, admin, "PUT", root+"/configuration", payload, nil)
	if w.Code != 200 {
		t.Fatalf("save %d %s", w.Code, w.Body.String())
	}
	secrets := []string{input.Receivers[0].Endpoint, input.Receivers[0].Proxy.Password, input.Receivers[1].Token, input.Receivers[2].SMTP.Password, input.Receivers[3].Endpoint, input.Receivers[4].Token}
	for _, secret := range secrets {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("save leaked credential")
		}
	}
	if w := apiCall(s, admin, "PUT", root+"/configuration", payload, nil); w.Code != 409 {
		t.Fatalf("stale draft accepted %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", root+"/configuration/validate", map[string]string{"configuration_ref": uuid.NewString()}, nil); w.Code != 409 {
		t.Fatalf("foreign plan accepted %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", root+"/configuration/validate", map[string]string{"configuration_ref": plan}, nil); w.Code != 200 {
		t.Fatalf("validate %d", w.Code)
	}
	attempts := 0
	operationID := ""
	controller.apply = func(op modules.Operation) (modules.Observation, error) {
		attempts++
		if op.Configuration != nil || op.ConfigurationRef != plan {
			t.Fatal("unsafe frozen operation")
		}
		if operationID == "" {
			operationID = op.OperationID
		} else if operationID != op.OperationID {
			t.Fatal("retry changed operation ID")
		}
		if attempts == 1 {
			return modules.Observation{}, errors.New(input.Receivers[0].Endpoint + input.Receivers[0].Proxy.Password + input.Receivers[1].Token + input.Receivers[2].SMTP.Password + input.Receivers[3].Endpoint + input.Receivers[4].Token)
		}
		return modules.Observation{State: "running", Endpoint: "http://127.0.0.1:19093", OperationID: op.OperationID, ConfigurationRevision: 1, ConfigurationHash: strings.Repeat("a", 64)}, nil
	}
	w = apiCall(s, admin, "POST", root+"/configuration/apply", map[string]any{"revision": 1, "idempotency_key": "alertmanager:apply"}, nil)
	if w.Code != 202 {
		t.Fatalf("apply %d %s", w.Code, w.Body.String())
	}
	var queued struct {
		Job model.Job `json:"job"`
	}
	json.Unmarshal(w.Body.Bytes(), &queued)
	if len(queued.Job.Parameters) != 4 || queued.Job.Parameters["configuration_ref"] != plan {
		t.Fatalf("unsafe persistent job %+v", queued.Job.Parameters)
	}
	failed, err := finishModuleFixture(t, s)
	if err == nil {
		t.Fatal("failure hidden")
	}
	for _, secret := range secrets {
		if strings.Contains(failed.Error, secret) {
			t.Fatal("failure leaked secret")
		}
	}
	edited := input
	edited.Revision = 1
	edited.Ref = plan
	if w := apiCall(s, admin, "PUT", root+"/configuration", map[string]any{"configuration": edited}, nil); w.Code != 409 {
		t.Fatalf("unresolved draft edited %d", w.Code)
	}
	w = apiCall(s, admin, "POST", root+"/configuration/retry", map[string]string{"job_id": queued.Job.ID}, nil)
	if w.Code != 202 {
		t.Fatalf("retry %d %s", w.Code, w.Body.String())
	}
	applied, err := finishModuleFixture(t, s)
	if err != nil || applied.AlertmanagerApplied == nil || applied.AlertmanagerApplied.Ref != plan || polls != 2 {
		t.Fatalf("apply %+v polls=%d err=%v", applied, polls, err)
	}
	if !applied.AlertmanagerApplied.Receivers[0].Proxy.CASet {
		t.Fatal("fixture did not retain root-private receiver CA")
	}
	clearInput := input
	clearInput.Revision = 1
	clearInput.Ref = plan
	clearInput.Receivers = append([]model.AlertmanagerReceiverInput{}, input.Receivers...)
	clearInput.Receivers[0].Proxy.ClearCA = true
	cleared := *applied.AlertmanagerApplied
	cleared.Ref = uuid.NewString()
	cleared.Revision = 2
	cleared.Receivers = append([]model.AlertmanagerReceiver{}, cleared.Receivers...)
	cleared.Receivers[0].Proxy.CASet = false
	controller.prepare = func(v model.AlertmanagerConfigurationInput) (model.AlertmanagerConfiguration, error) {
		if !v.Receivers[0].Proxy.ClearCA || v.Ref != plan {
			t.Fatal("root did not receive explicit clear on the owned plan")
		}
		return cleared, nil
	}
	clearResponse := apiCall(s, admin, "PUT", root+"/configuration", map[string]any{"configuration": clearInput}, nil)
	if clearResponse.Code != 200 {
		t.Fatalf("clear CA status %d", clearResponse.Code)
	}
	var clearedView struct {
		Draft   model.AlertmanagerConfiguration `json:"draft"`
		Applied model.AlertmanagerConfiguration `json:"applied"`
	}
	if err := json.Unmarshal(clearResponse.Body.Bytes(), &clearedView); err != nil {
		t.Fatal(err)
	}
	if clearedView.Draft.Receivers[0].Proxy.CASet || !clearedView.Applied.Receivers[0].Proxy.CASet || strings.Contains(clearResponse.Body.String(), "clear_ca") {
		t.Fatal("public CA clear/save acknowledgement invalid")
	}
	controller.apply = func(op modules.Operation) (modules.Observation, error) {
		state := "running"
		if op.Action == "disable" {
			state = "disabled"
		}
		if op.Action == "remove" {
			state = "absent"
		}
		return modules.Observation{State: state, Endpoint: "http://127.0.0.1:19093", OperationID: op.OperationID}, nil
	}
	for _, action := range []string{"disable", "enable", "remove"} {
		payload := map[string]string{"action": action, "idempotency_key": "alertmanager:" + action, "confirm_name": "Notifications"}
		response := apiCall(s, admin, "POST", "/api/v1/modules/"+created.Instance.ID+"/actions", payload, nil)
		if response.Code != 202 {
			t.Fatalf("%s %d", action, response.Code)
		}
		instance, err := finishModuleFixture(t, s)
		if err != nil {
			t.Fatal(err)
		}
		if action != "remove" && (instance.AlertmanagerApplied == nil || instance.AlertmanagerApplied.Ref != plan) {
			t.Fatal("lifecycle lost applied configuration")
		}
	}
	if _, err := store.Get[model.Integration](context.Background(), s.Store, "integration", integration.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("managed integration survived removal %v", err)
	}
	if _, err := store.Get[model.Resource](context.Background(), s.Store, "resource", resource.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("managed resource survived removal %v", err)
	}
	rows, err := s.Store.Pool.Query(context.Background(), "SELECT body::text FROM documents UNION ALL SELECT body::text FROM jobs UNION ALL SELECT body::text FROM audit_events UNION ALL SELECT body::text FROM events")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		for _, secret := range secrets {
			if strings.Contains(raw, secret) {
				t.Fatal("persistent credential")
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestAlertmanagerStructuredInputBoundsAndReceiverCA(t *testing.T) {
	initial := model.DefaultAlertmanagerConfiguration()
	if !validAlertmanagerInput(model.AlertmanagerConfigurationInput{Route: initial.Route, Receivers: []model.AlertmanagerReceiverInput{}}) {
		t.Fatal("default disabled receiver config rejected")
	}
	valid := model.AlertmanagerConfigurationInput{Route: model.AlertmanagerRoute{Receiver: "office", GroupWait: "0s", GroupInterval: "1s", RepeatInterval: "1h"}, Receivers: []model.AlertmanagerReceiverInput{{Name: "office", Kind: "webhook", Endpoint: "https://example.invalid/secret", Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}}}}
	if !validAlertmanagerInput(valid) {
		t.Fatal("valid input rejected")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	directCA := valid
	directCA.Receivers = append([]model.AlertmanagerReceiverInput{}, valid.Receivers...)
	directCA.Receivers[0].Proxy.CAPEM = ca
	if !validAlertmanagerInput(directCA) {
		t.Fatal("receiver CA must work without a proxy")
	}
	clearCA := valid
	clearCA.Receivers = append([]model.AlertmanagerReceiverInput{}, valid.Receivers...)
	clearCA.Receivers[0].Proxy.ClearCA = true
	if !validAlertmanagerInput(clearCA) {
		t.Fatal("explicit return to system CA rejected")
	}
	encodedClear, err := json.Marshal(clearCA)
	if err != nil || !strings.Contains(string(encodedClear), `"clear_ca":true`) {
		t.Fatal("CA clear operation not sent to root")
	}
	public := model.AlertmanagerConfiguration{Revision: 1, Ref: uuid.NewString(), Route: valid.Route, Receivers: []model.AlertmanagerReceiver{{Name: "office", Kind: "webhook", EndpointSet: true, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}, CASet: false}}}}
	encodedPublic, err := json.Marshal(public)
	if err != nil || !validAlertmanagerPublic(public) || strings.Contains(string(encodedPublic), "clear_ca") || strings.Contains(string(encodedPublic), "ca_pem") {
		t.Fatal("CA clear operation persisted in public metadata")
	}
	clearCA.Receivers[0].Proxy.CAPEM = ca
	if validAlertmanagerInput(clearCA) {
		t.Fatal("conflicting CA clear and replacement accepted")
	}
	for _, mutate := range []func(*model.AlertmanagerConfigurationInput){
		func(c *model.AlertmanagerConfigurationInput) { c.Route.Receiver = "absent" }, func(c *model.AlertmanagerConfigurationInput) { c.Route.RepeatInterval = "0s" },
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[0].Endpoint = "http://example.invalid" }, func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Endpoint = "https://user:secret@example.invalid"
		},
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[0].Kind = "arbitrary" }, func(c *model.AlertmanagerConfigurationInput) { c.Receivers[0].Proxy.CAPEM = "invalid PEM" },
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Proxy = model.AlertmanagerProxyInput{Mode: "http", URL: "http://proxy.invalid", NoProxy: []string{}}
		},
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Proxy = model.AlertmanagerProxyInput{Mode: "http", URL: "http://user:secret@proxy.invalid:3128", NoProxy: []string{}}
		},
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Proxy = model.AlertmanagerProxyInput{Mode: "http", URL: "http://proxy.invalid:3128", Username: "a:b", Password: "secret", NoProxy: []string{}}
		},
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Proxy = model.AlertmanagerProxyInput{Mode: "http", URL: "http://proxy.invalid:3128", NoProxy: []string{"*"}}
		},
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Proxy = model.AlertmanagerProxyInput{Mode: "http", URL: "http://proxy.invalid:3128", NoProxy: []string{"192.168.1.1/24"}}
		},
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[0].Kind = "telegram"
			c.Receivers[0].ChatID = 1 << 53
		},
	} {
		c := valid
		c.Receivers = append([]model.AlertmanagerReceiverInput{}, valid.Receivers...)
		mutate(&c)
		if validAlertmanagerInput(c) {
			t.Fatal("invalid input accepted")
		}
	}
}

func TestAlertmanagerSMTPBoundsAndPublicSecretBoundary(t *testing.T) {
	makeInput := func() model.AlertmanagerConfigurationInput {
		return model.AlertmanagerConfigurationInput{Route: model.AlertmanagerRoute{Receiver: "mail", GroupWait: "0s", GroupInterval: "1s", RepeatInterval: "1h"}, Receivers: []model.AlertmanagerReceiverInput{{Name: "mail", Kind: "email", SMTP: &model.AlertmanagerSMTPInput{Smarthost: "smtp.example.invalid:587", From: "alerts@example.invalid", To: []string{"ops@example.invalid"}, TLSMode: "starttls", Username: "operator", Password: "fixture-smtp-password"}, Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}}}}
	}
	valid := makeInput()
	if !validAlertmanagerInput(valid) {
		t.Fatal("valid SMTP rejected")
	}
	for _, mutate := range []func(*model.AlertmanagerReceiverInput){
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.Smarthost = "smtp.example.invalid" },
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.Smarthost = "smtp.example.invalid:0" },
		func(r *model.AlertmanagerReceiverInput) {
			r.SMTP.From = "alerts@example.invalid\r\nBcc: other@example.invalid"
		},
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.To = []string{"Ops <ops@example.invalid>"} },
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.To = []string{"{{ .Labels.recipient }}"} },
		func(r *model.AlertmanagerReceiverInput) {
			r.SMTP.To = []string{"ops@example.invalid", "ops@example.invalid"}
		},
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.To = nil },
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.TLSMode = "none" },
		func(r *model.AlertmanagerReceiverInput) { r.SMTP.Username = "" },
		func(r *model.AlertmanagerReceiverInput) {
			r.Proxy.Mode = "http"
			r.Proxy.URL = "http://proxy.invalid:3128"
		},
		func(r *model.AlertmanagerReceiverInput) { r.Endpoint = "https://notify.invalid" },
		func(r *model.AlertmanagerReceiverInput) { r.Kind = "webhook" },
	} {
		input := makeInput()
		mutate(&input.Receivers[0])
		if validAlertmanagerInput(input) {
			t.Fatal("unsafe SMTP configuration accepted")
		}
	}
	public := model.AlertmanagerConfiguration{Revision: 1, Ref: uuid.NewString(), Route: valid.Route, Receivers: []model.AlertmanagerReceiver{{Name: "mail", Kind: "email", SMTP: &model.AlertmanagerSMTP{Smarthost: "smtp.example.invalid:587", From: "alerts@example.invalid", To: []string{"ops@example.invalid"}, TLSMode: "starttls", Username: "operator", PasswordSet: true}, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}}}}
	raw, err := json.Marshal(public)
	if err != nil || !validAlertmanagerPublic(public) || strings.Contains(string(raw), `"password":`) || strings.Contains(string(raw), "fixture-smtp-password") {
		t.Fatal("SMTP public secret boundary failed")
	}
	public.Receivers[0].SMTP.PasswordSet = false
	if validAlertmanagerPublic(public) {
		t.Fatal("inconsistent SMTP credentials accepted")
	}
}

func TestAlertmanagerTeamsAndPagerDutyStructuredInput(t *testing.T) {
	input := model.AlertmanagerConfigurationInput{Route: model.AlertmanagerRoute{Receiver: "teams", GroupWait: "0s", GroupInterval: "1s", RepeatInterval: "1h"}, Receivers: []model.AlertmanagerReceiverInput{
		{Name: "teams", Kind: "msteamsv2", Endpoint: "https://workflow.invalid/private-hook", Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}},
		{Name: "pager", Kind: "pagerduty", Token: "fixture-routing-key", Proxy: model.AlertmanagerProxyInput{Mode: "direct", NoProxy: []string{}}},
	}}
	if !validAlertmanagerInput(input) {
		t.Fatal("valid Teams/PagerDuty input rejected")
	}
	for _, mutate := range []func(*model.AlertmanagerConfigurationInput){
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[0].Token = "wrong-channel-token" },
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[0].Endpoint = "http://workflow.invalid" },
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[1].Token = "{{ .Labels.key }}" },
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[1].Token = "key with spaces" },
		func(c *model.AlertmanagerConfigurationInput) { c.Receivers[1].ChatID = 123 },
		func(c *model.AlertmanagerConfigurationInput) {
			c.Receivers[1].Endpoint = "http://events.invalid/enqueue"
		},
	} {
		changed := input
		changed.Receivers = append([]model.AlertmanagerReceiverInput{}, input.Receivers...)
		mutate(&changed)
		if validAlertmanagerInput(changed) {
			t.Fatal("unsafe Teams/PagerDuty input accepted")
		}
	}
	public := model.AlertmanagerConfiguration{Revision: 1, Ref: uuid.NewString(), Route: input.Route, Receivers: []model.AlertmanagerReceiver{
		{Name: "teams", Kind: "msteamsv2", EndpointSet: true, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}},
		{Name: "pager", Kind: "pagerduty", EndpointSet: true, TokenSet: true, Proxy: model.AlertmanagerProxy{Mode: "direct", NoProxy: []string{}}},
	}}
	if !validAlertmanagerPublic(public) {
		t.Fatal("valid Teams/PagerDuty public plan rejected")
	}
	public.Receivers[1].TokenSet = false
	if validAlertmanagerPublic(public) {
		t.Fatal("PagerDuty public plan without routing key accepted")
	}
}
