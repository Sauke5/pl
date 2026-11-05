package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

type xrayControllerFixture struct {
	validate func() error
	prepare  func(model.XrayConfigurationInput) (model.XrayConfiguration, error)
	apply    func(modules.Operation) (modules.Observation, error)
}

func (f *xrayControllerFixture) Apply(_ context.Context, op modules.Operation) (modules.Observation, error) {
	return f.apply(op)
}
func (f *xrayControllerFixture) PrepareXray(_ context.Context, _ string, c model.XrayConfigurationInput) (model.XrayConfiguration, error) {
	return f.prepare(c)
}
func (f *xrayControllerFixture) ValidateXray(context.Context, string, string) error {
	if f.validate != nil {
		return f.validate()
	}
	return nil
}
func (f *xrayControllerFixture) XrayStatus(context.Context, string) (model.XrayStatus, error) {
	return model.XrayStatus{State: "running", Inbounds: []model.XrayInboundStatus{}, Counters: []model.XrayCounter{}}, nil
}

func TestXrayPublicConfigurationFrozenRetryAndPermissions(t *testing.T) {
	s, admin := localUsersFixture(t)
	viewer := apiUser(t, s, "xray.viewer", false)
	controller := &xrayControllerFixture{}
	controller.apply = func(op modules.Operation) (modules.Observation, error) {
		state := "running"
		if op.Action == "disable" {
			state = "disabled"
		}
		if op.Action == "remove" {
			state = "absent"
		}
		return modules.Observation{State: state, Version: "fixture", OperationID: op.OperationID}, nil
	}
	s.Modules = modules.New(s.Store, controller)
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) {
		t.Fatal("Xray must never create or poll a Prometheus integration")
		return model.Snapshot{}, nil
	}
	body := map[string]any{"module_id": "xray", "name": "Office proxy", "mode": "local", "idempotency_key": "xray:install"}
	w := apiCall(s, admin, "POST", "/api/v1/modules", body, nil)
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
	if created.Instance.IntegrationID != "" || created.Instance.ResourceID == "" {
		t.Fatal("Xray projection must own only a resource")
	}
	if _, err := finishModuleFixture(t, s); err != nil {
		t.Fatal(err)
	}
	root := "/api/v1/modules/" + created.Instance.ID + "/xray"
	for _, suffix := range []string{"/configuration", "/status"} {
		if w := apiCall(s, viewer, "GET", root+suffix, nil, nil); w.Code != 403 {
			t.Fatalf("viewer read %d", w.Code)
		}
	}
	input := model.XrayConfigurationInput{Inbounds: []model.XrayInboundInput{{Tag: "office", Protocol: "socks", Listen: "127.0.0.1", Port: 1080, Auth: "password", Username: "operator", Password: "write-only-password"}}, Outbound: model.XrayOutboundInput{Mode: "imported", Link: "vless://fixture-secret@example.invalid:443?security=tls"}, Routing: "proxy_all"}
	plan := uuid.NewString()
	controller.prepare = func(v model.XrayConfigurationInput) (model.XrayConfiguration, error) {
		if v.Inbounds[0].Password != input.Inbounds[0].Password || v.Outbound.Link != input.Outbound.Link {
			t.Fatal("credentials must reach authenticated root prepare")
		}
		return model.XrayConfiguration{Revision: v.Revision + 1, Ref: plan, Inbounds: []model.XrayInbound{{Tag: "office", Protocol: "socks", Listen: "127.0.0.1", Port: 1080, Auth: "password", Username: "operator", PasswordSet: true}}, Outbound: model.XrayOutbound{Mode: "imported", Protocol: "vless", Server: "example.invalid", Port: 443}, Routing: "proxy_all"}, nil
	}
	payload := map[string]any{"configuration": input}
	if w := apiCall(s, admin, "PUT", root+"/configuration", payload, map[string]string{"X-CSRF-Token": "forged"}); w.Code != 403 {
		t.Fatal("missing CSRF protection")
	}
	w = apiCall(s, admin, "PUT", root+"/configuration", payload, nil)
	if w.Code != 200 {
		t.Fatalf("save %d %s", w.Code, w.Body.String())
	}
	for _, secret := range []string{input.Inbounds[0].Password, input.Outbound.Link, "fixture-secret"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("save response leaked a credential")
		}
	}
	if w := apiCall(s, admin, "PUT", root+"/configuration", payload, nil); w.Code != 409 {
		t.Fatalf("stale draft was accepted %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", root+"/configuration/validate", map[string]string{"configuration_ref": uuid.NewString()}, nil); w.Code != 409 {
		t.Fatalf("foreign ref %d", w.Code)
	}
	if w := apiCall(s, admin, "POST", root+"/configuration/validate", map[string]string{"configuration_ref": plan}, nil); w.Code != 200 {
		t.Fatalf("validate %d", w.Code)
	}
	var configured modules.Operation
	attempts := 0
	controller.apply = func(op modules.Operation) (modules.Observation, error) {
		attempts++
		if op.Configuration != nil || op.ConfigurationRef != plan {
			t.Fatal("configure must send only frozen root plan ref")
		}
		configured = op
		if attempts == 1 {
			return modules.Observation{}, errors.New("secret fixture-secret write-only-password")
		}
		return modules.Observation{State: "running", OperationID: op.OperationID, ConfigurationRevision: 1, ConfigurationHash: strings.Repeat("a", 64)}, nil
	}
	w = apiCall(s, admin, "POST", root+"/configuration/apply", map[string]any{"revision": 1, "idempotency_key": "xray:apply"}, nil)
	if w.Code != 202 {
		t.Fatalf("apply %d %s", w.Code, w.Body.String())
	}
	var queued struct {
		Job model.Job `json:"job"`
	}
	json.Unmarshal(w.Body.Bytes(), &queued)
	if len(queued.Job.Parameters) != 4 || queued.Job.Parameters["configuration_ref"] != plan {
		t.Fatalf("unsafe durable payload %+v", queued.Job.Parameters)
	}
	failed, err := finishModuleFixture(t, s)
	if err == nil || strings.Contains(failed.Error, "fixture-secret") {
		t.Fatal("failure must be redacted")
	}
	firstOperation := configured.OperationID
	edited := input
	edited.Revision = 1
	edited.Ref = plan
	if w := apiCall(s, admin, "PUT", root+"/configuration", map[string]any{"configuration": edited}, nil); w.Code != 409 {
		t.Fatalf("unresolved frozen draft edited %d", w.Code)
	}
	w = apiCall(s, admin, "POST", root+"/configuration/retry", map[string]string{"job_id": queued.Job.ID}, nil)
	if w.Code != 202 {
		t.Fatalf("retry %d %s", w.Code, w.Body.String())
	}
	applied, err := finishModuleFixture(t, s)
	if err != nil || configured.OperationID != firstOperation || applied.XrayApplied == nil || applied.XrayApplied.Ref != plan {
		t.Fatalf("frozen retry mismatch %+v %v", applied, err)
	}
	integrations, err := store.List[model.Integration](context.Background(), s.Store, "integration")
	if err != nil || len(integrations) != 0 {
		t.Fatalf("fake integrations %+v %v", integrations, err)
	}
	// Plain stored documents/jobs/events are a second redaction boundary.
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
		for _, secret := range []string{input.Inbounds[0].Password, input.Outbound.Link, "fixture-secret"} {
			if strings.Contains(raw, secret) {
				t.Fatal("persisted credential")
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestXrayConfigurationInputBounds(t *testing.T) {
	valid := model.XrayConfigurationInput{Inbounds: []model.XrayInboundInput{{Tag: "office", Protocol: "http", Listen: "127.0.0.1", Port: 8080, Auth: "none"}}, Outbound: model.XrayOutboundInput{Mode: "direct"}, Routing: "private_direct"}
	if !validXrayInput(valid) {
		t.Fatal("valid minimal configuration rejected")
	}
	for _, mutate := range []func(*model.XrayConfigurationInput){func(c *model.XrayConfigurationInput) { c.Inbounds[0].Port = 10085 }, func(c *model.XrayConfigurationInput) { c.Inbounds[0].Port = 80 }, func(c *model.XrayConfigurationInput) { c.Inbounds[0].Protocol = "vless" }, func(c *model.XrayConfigurationInput) { c.Inbounds = append(c.Inbounds, c.Inbounds[0]) }, func(c *model.XrayConfigurationInput) { c.Outbound.Link = "https://subscription.invalid" }, func(c *model.XrayConfigurationInput) { c.Revision = -1 }} {
		c := valid
		c.Inbounds = append([]model.XrayInboundInput{}, valid.Inbounds...)
		mutate(&c)
		if validXrayInput(c) {
			t.Fatalf("invalid input accepted %+v", c)
		}
	}
}

func TestXrayInboundTagsMatchControllerContract(t *testing.T) {
	for _, test := range []struct {
		tag   string
		valid bool
	}{
		{"office.socks-1_main", true}, {"A", true}, {"A" + strings.Repeat("x", 63), true},
		{"", false}, {"1office", false}, {"_office", false}, {"office socks", false},
		{"офис", false}, {"office\n", false}, {"A" + strings.Repeat("x", 64), false},
		{"api", false}, {"proxy", false}, {"direct", false}, {"block", false},
	} {
		t.Run(test.tag, func(t *testing.T) {
			input := model.XrayConfigurationInput{
				Inbounds: []model.XrayInboundInput{{Tag: test.tag, Protocol: "socks", Listen: "127.0.0.1", Port: 1080, Auth: "none"}},
				Outbound: model.XrayOutboundInput{Mode: "direct"}, Routing: "proxy_all",
			}
			if got := validXrayInput(input); got != test.valid {
				t.Fatalf("validXrayInput tag %q = %t, want %t", test.tag, got, test.valid)
			}
		})
	}
}

func TestXrayConfigurationDiagnosticsExposeOnlyKnownStaticMessages(t *testing.T) {
	s, admin := localUsersFixture(t)
	controller := &xrayControllerFixture{apply: func(op modules.Operation) (modules.Observation, error) {
		return modules.Observation{State: "running", OperationID: op.OperationID}, nil
	}}
	s.Modules = modules.New(s.Store, controller)
	response := apiCall(s, admin, "POST", "/api/v1/modules", map[string]string{"module_id": "xray", "name": "Diagnostics", "mode": "local", "idempotency_key": "xray:diagnostics:install"}, nil)
	if response.Code != 202 {
		t.Fatalf("install %d", response.Code)
	}
	var created struct {
		Instance model.ModuleInstance `json:"instance"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if _, err := finishModuleFixture(t, s); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/modules/" + created.Instance.ID + "/xray/configuration"
	input := model.XrayConfigurationInput{Inbounds: []model.XrayInboundInput{}, Outbound: model.XrayOutboundInput{Mode: "direct"}, Routing: "proxy_all"}
	known := &modules.XrayConfigurationError{Code: "xray_unsupported_transport"}
	for _, tc := range []struct {
		err           error
		code, message string
	}{
		{fmt.Errorf("private-token-secret: %w", known), known.Code, known.Error()},
		{&modules.XrayConfigurationError{Code: "private-token-secret"}, "invalid_configuration", "Host controller отклонил настройки Xray; проверьте адреса, порты и ссылку подключения"},
		{errors.New("private-token-secret vless://credential@example.invalid"), "invalid_configuration", "Host controller отклонил настройки Xray; проверьте адреса, порты и ссылку подключения"},
	} {
		controller.prepare = func(model.XrayConfigurationInput) (model.XrayConfiguration, error) {
			return model.XrayConfiguration{}, tc.err
		}
		response := apiCall(s, admin, "PUT", path, map[string]any{"configuration": input}, nil)
		var body struct {
			Code    string `json:"error"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != 422 || body.Code != tc.code || body.Message != tc.message || strings.Contains(response.Body.String(), "private-token-secret") {
			t.Fatalf("unsafe prepare diagnostic status=%d code=%s", response.Code, body.Code)
		}
	}
	ref := uuid.NewString()
	controller.prepare = func(model.XrayConfigurationInput) (model.XrayConfiguration, error) {
		draft := model.DefaultXrayConfiguration()
		draft.Revision = 1
		draft.Ref = ref
		return draft, nil
	}
	if response := apiCall(s, admin, "PUT", path, map[string]any{"configuration": input}, nil); response.Code != 200 {
		t.Fatalf("save %d", response.Code)
	}
	for _, tc := range []struct {
		err  error
		code string
	}{
		{fmt.Errorf("private-token-secret: %w", known), known.Code},
		{&modules.XrayConfigurationError{Code: "xray_port_in_use"}, "xray_port_in_use"},
		{&modules.XrayConfigurationError{Code: "xray_bind_unavailable"}, "xray_bind_unavailable"},
		{&modules.XrayConfigurationError{Code: "private-token-secret"}, "configuration_validation_failed"},
		{errors.New("private-token-secret"), "configuration_validation_failed"},
	} {
		controller.validate = func() error { return tc.err }
		response := apiCall(s, admin, "POST", path+"/validate", map[string]string{"configuration_ref": ref}, nil)
		var body struct {
			Code    string `json:"error"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != 422 || body.Code != tc.code || strings.Contains(response.Body.String(), "private-token-secret") {
			t.Fatalf("unsafe validate diagnostic status=%d code=%s", response.Code, body.Code)
		}
		var diagnostic *modules.XrayConfigurationError
		if errors.As(tc.err, &diagnostic) && diagnostic.Known() && body.Message != diagnostic.Error() {
			t.Fatal("validation did not preserve the safe diagnostic")
		}
		if tc.code == "configuration_validation_failed" && strings.Contains(body.Message, "run -test") {
			t.Fatal("unknown controller failure was labelled as a failed Xray configuration test")
		}
	}
}

func TestXrayLANAuthenticationIsOptional(t *testing.T) {
	for _, protocol := range []string{"socks", "http"} {
		t.Run(protocol, func(t *testing.T) {
			input := model.XrayConfigurationInput{Inbounds: []model.XrayInboundInput{{Tag: "office", Protocol: protocol, Listen: "10.73.43.25", Port: 10808, Auth: "none"}}, Outbound: model.XrayOutboundInput{Mode: "direct"}, Routing: "proxy_all"}
			if !validXrayInput(input) {
				t.Fatal("LAN configuration without authentication rejected")
			}
			input.Inbounds[0].Username = "hidden-fixture-user"
			if validXrayInput(input) {
				t.Fatal("credentials with disabled authentication accepted")
			}
		})
	}
}
