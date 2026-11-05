package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

// These tests use the same real PostgreSQL and browser-session fixture as the
// other module tests. They never start a worker or contact a deployed Mailcow server.
func mailcowHTTPFixture(t *testing.T) (*Server, apiIdentity, *int, *int) {
	t.Helper()
	s, admin := localUsersFixture(t)
	s.Modules = modules.New(s.Store, nil)
	mailcowNativeConnectionFixture(t, s, "mailcow-read-only-fixture-key-never-for-browser", nil)
	probes, polls := 0, 0
	s.Modules.Probe = moduleProbeFunc(func(context.Context, string) (modules.Observation, error) {
		probes++
		return modules.Observation{}, errors.New("unexpected Mailcow health probe")
	})
	s.Modules.Poll = func(context.Context, model.Integration) (model.Snapshot, error) {
		polls++
		return model.Snapshot{}, errors.New("unexpected generic Mailcow poll")
	}
	return s, admin, &probes, &polls
}

func mailcowCreateBody(key, secretRef string) map[string]any {
	return map[string]any{
		"module_id": "mailcow", "name": "Почта лаборатории", "mode": "external",
		"endpoint": "http://mail.example.test:18080", "secret_ref": secretRef,
		"idempotency_key": key,
	}
}

func mailcowInstallHTTPFixture(t *testing.T, s *Server, admin apiIdentity) model.ModuleInstance {
	t.Helper()
	const keyValue = "mailcow-read-only-fixture-key-never-for-browser"
	const secretRef = "file:mailcow-ro.key"
	secretRoot := t.TempDir()
	t.Setenv("PORTAL_SECRETS_DIR", secretRoot)
	t.Setenv("PORTAL_SECRET_REFS", secretRef)
	secretPath := filepath.Join(secretRoot, "mailcow-ro.key")
	if err := os.WriteFile(secretPath, []byte(keyValue), 0600); err != nil {
		t.Fatal(err)
	}
	w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", mailcowCreateBody("mailcow:install:fixture", secretRef), nil)
	created := apiDecode[struct {
		Instance model.ModuleInstance `json:"instance"`
		Job      model.Job            `json:"job"`
	}](t, w, http.StatusAccepted)
	if created.Instance.ModuleID != "mailcow" || created.Instance.Mode != "external" || created.Instance.IntegrationID == "" || created.Job.ID == "" {
		t.Fatalf("incomplete external Mailcow registration: %+v", created)
	}
	if strings.Contains(w.Body.String(), keyValue) || strings.Contains(w.Body.String(), "mailcow-ro.key") {
		t.Fatal("module registration leaked API key value or reference")
	}
	job := apiDecode[model.Job](t, apiCall(s, admin, http.MethodGet, "/api/v1/jobs/"+created.Job.ID, nil, nil), http.StatusOK)
	rawJob, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawJob), keyValue) || strings.Contains(string(rawJob), "mailcow-ro.key") || strings.Contains(string(rawJob), secretPath) {
		t.Fatal("durable module job contains secret value or reference")
	}
	instance, err := finishModuleFixture(t, s)
	if err != nil || instance.ID != created.Instance.ID || instance.ObservedState != "running" {
		t.Fatalf("external registration projection: instance=%+v err=%v", instance, err)
	}
	integration, err := store.Get[model.Integration](context.Background(), s.Store, "integration", instance.IntegrationID)
	if err != nil || integration.SecretRef != secretRef || integration.Kind != "mailcow" || integration.ManagedModuleID != instance.ID {
		t.Fatalf("server-side source binding: integration=%+v err=%v", integration, err)
	}
	return instance
}

func mailcowSettingsFixture(revision int64) model.MailcowSettings {
	settings := model.MailcowSettings{Revision: revision, Groups: map[string]model.MailcowGroupSettings{}}
	for _, group := range model.MailcowGroups() {
		settings.Groups[group] = model.MailcowGroupSettings{IntervalSeconds: 60}
	}
	return settings
}

func TestMailcowHTTPCreateValidationAndResourceView(t *testing.T) {
	s, admin, probes, polls := mailcowHTTPFixture(t)
	for index, tc := range []struct {
		name, field, value string
	}{
		{"local mode", "mode", "local"},
		{"missing secret", "secret_ref", ""},
		{"empty file reference", "secret_ref", "file:"},
		{"empty env reference", "secret_ref", "env:PORTAL_SECRET_"},
		{"literal API key", "secret_ref", "raw-mailcow-key"},
		{"endpoint path", "endpoint", "https://mail.example.test/api/v1"},
		{"endpoint query", "endpoint", "https://mail.example.test?key=forbidden"},
		{"endpoint fragment", "endpoint", "https://mail.example.test#fragment"},
		{"endpoint credentials", "endpoint", "https://user:password@mail.example.test"},
		{"endpoint scheme", "endpoint", "ftp://mail.example.test"},
		{"endpoint loopback", "endpoint", "http://127.0.0.1:8080"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := mailcowCreateBody(fmt.Sprintf("mailcow:invalid:%d", index), "file:mailcow-ro.key")
			body[tc.field] = tc.value
			if w := apiCall(s, admin, http.MethodPost, "/api/v1/modules", body, nil); w.Code != http.StatusBadRequest {
				t.Fatalf("invalid connection accepted: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	instances, err := store.List[model.ModuleInstance](context.Background(), s.Store, "module_instance")
	if err != nil || len(instances) != 0 {
		t.Fatalf("rejected create persisted a module: %+v err=%v", instances, err)
	}
	instance := mailcowInstallHTTPFixture(t, s, admin)
	resource := apiDecode[model.Resource](t, apiCall(s, admin, http.MethodGet, "/api/v1/resources/"+instance.ResourceID, nil, nil), http.StatusOK)
	if resource.ManagedModuleID != instance.ID || resource.URL != "/#modules?instance="+instance.ID+"&view=mailcow" || resource.Name != "Почта лаборатории" {
		t.Fatalf("Mailcow resource does not open its own view: %+v", resource)
	}
	catalog := apiDecode[struct {
		Items []model.ModuleDescriptor `json:"items"`
	}](t, apiCall(s, admin, http.MethodGet, "/api/v1/modules/catalog", nil, nil), http.StatusOK)
	found := false
	for _, entry := range catalog.Items {
		if entry.ID == "mailcow" {
			found = true
			if !reflect.DeepEqual(entry.Modes, []string{"external"}) || entry.View != "mailcow" {
				t.Fatalf("Mailcow catalog mode/view mismatch: %+v", entry)
			}
		}
	}
	if !found || *probes != 0 || *polls != 0 {
		t.Fatalf("catalog entry=%v; registration contacted upstream: probes=%d polls=%d", found, *probes, *polls)
	}
}

func TestMailcowHTTPBrowserPermissionsAndCSRF(t *testing.T) {
	s, admin, _, _ := mailcowHTTPFixture(t)
	instance := mailcowInstallHTTPFixture(t, s, admin)
	viewer := apiUser(t, s, "mailcow-viewer", false)
	root := "/api/v1/modules/" + instance.ID + "/mailcow"
	snapshot := apiDecode[model.MailcowSnapshot](t, apiCall(s, admin, http.MethodGet, root, nil, nil), http.StatusOK)
	settings := mailcowSettingsFixture(snapshot.Revision)
	for _, tc := range []struct {
		name, method, path string
		body               any
	}{
		{"snapshot", http.MethodGet, root, nil},
		{"settings", http.MethodPut, root + "/settings", settings},
		{"create", http.MethodPost, "/api/v1/modules", mailcowCreateBody("mailcow:unauthorized", "file:mailcow-ro.key")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, identity := range []struct {
				name string
				who  apiIdentity
				want int
			}{{"viewer", viewer, http.StatusForbidden}, {"anonymous", apiIdentity{}, http.StatusUnauthorized}} {
				if w := apiCall(s, identity.who, tc.method, tc.path, tc.body, nil); w.Code != identity.want {
					t.Fatalf("%s: status=%d want=%d body=%s", identity.name, w.Code, identity.want, w.Body.String())
				}
			}
			if tc.method != http.MethodGet {
				for _, csrf := range []string{"", "forged"} {
					if w := apiCall(s, admin, tc.method, tc.path, tc.body, map[string]string{"X-CSRF-Token": csrf}); w.Code != http.StatusForbidden {
						t.Fatalf("CSRF %q bypassed: status=%d body=%s", csrf, w.Code, w.Body.String())
					}
				}
			}
		})
	}

	// Prove this bearer credential is valid for its ordinary catalog scope before
	// checking that the browser-only Mailcow API refuses it without cookies/Origin.
	token := strings.Repeat("mailcow-machine-fixture-", 3)
	digest := sha256.Sum256([]byte(token))
	file := filepath.Join(t.TempDir(), "machine.json")
	principal := machinePrincipal{ID: "mailcow-test", TokenSHA256: hex.EncodeToString(digest[:]), Scopes: []string{"catalog:read", "catalog:write"}, ExpiresAt: time.Now().Add(time.Hour)}
	encoded, err := json.Marshal(map[string]any{"principals": []machinePrincipal{principal}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	s.Config.MachineCredentialsFile = file
	callMachine := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, strings.NewReader(string(payload)))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	if w := callMachine(http.MethodGet, "/api/v1/resources", nil); w.Code != http.StatusOK {
		t.Fatalf("machine fixture is not valid: status=%d body=%s", w.Code, w.Body.String())
	}
	for _, route := range []struct {
		method, path string
		body         any
	}{{http.MethodGet, root, nil}, {http.MethodPut, root + "/settings", settings}, {http.MethodPost, "/api/v1/modules", mailcowCreateBody("mailcow:machine-create", "file:mailcow-ro.key")}} {
		if w := callMachine(route.method, route.path, route.body); w.Code != http.StatusForbidden {
			t.Fatalf("machine gained Mailcow access: %s %s status=%d body=%s", route.method, route.path, w.Code, w.Body.String())
		}
		if w := apiCall(s, admin, route.method, route.path, route.body, map[string]string{"Authorization": "Bearer " + token}); w.Code != http.StatusForbidden {
			t.Fatalf("machine header fell back to admin cookie: status=%d body=%s", w.Code, w.Body.String())
		}
	}
	after := apiDecode[model.MailcowSnapshot](t, apiCall(s, admin, http.MethodGet, root, nil, nil), http.StatusOK)
	if !reflect.DeepEqual(after, snapshot) {
		t.Fatal("denied operations changed Mailcow settings/cache")
	}
}

func TestMailcowHTTPSettingsRevisionAndCacheOnlySnapshot(t *testing.T) {
	s, admin, probes, polls := mailcowHTTPFixture(t)
	instance := mailcowInstallHTTPFixture(t, s, admin)
	ctx := context.Background()
	root := "/api/v1/modules/" + instance.ID + "/mailcow"
	read := func() model.MailcowSnapshot {
		t.Helper()
		w := apiCall(s, admin, http.MethodGet, root, nil, nil)
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("Mailcow browser response is cacheable")
		}
		for _, forbidden := range []string{"secret_ref", "api_key", "X-API-Key", "mailcow-ro.key", "mailcow-read-only-fixture-key-never-for-browser"} {
			if strings.Contains(w.Body.String(), forbidden) {
				t.Fatalf("snapshot exposes credential metadata/value: %s", forbidden)
			}
		}
		return apiDecode[model.MailcowSnapshot](t, w, http.StatusOK)
	}
	initial := read()
	if initial.InstanceID != instance.ID || initial.IntegrationID != instance.IntegrationID || initial.URL != "http://mail.example.test:18080" || initial.Name != instance.Name || !initial.Enabled || len(initial.Groups) != 6 {
		t.Fatalf("incomplete source identity: %+v", initial)
	}
	for _, id := range model.MailcowGroups() {
		group, ok := initial.Groups[id]
		if !ok || group.Enabled || group.IntervalSeconds != 60 || group.Status != "disabled" || group.Stale || group.LastAttempt != nil || group.LastSuccess != nil || group.ErrorCode != "" || group.LastAttemptStatus != "" || string(group.Data) != "null" {
			t.Fatalf("group %s invented a collection result: %+v data=%s", id, group, group.Data)
		}
	}

	// All six entries and integer interval bounds are required. Invalid writes
	// must leave both the source revision and current settings unchanged.
	for _, tc := range []string{"missing", "unknown", "below minimum", "above maximum", "zero revision", "fractional interval"} {
		t.Run(tc, func(t *testing.T) {
			input := mailcowSettingsFixture(initial.Revision)
			var body any = input
			switch tc {
			case "missing":
				delete(input.Groups, "rspamd")
			case "unknown":
				delete(input.Groups, "rspamd")
				input.Groups["unexpected"] = model.MailcowGroupSettings{IntervalSeconds: 60}
			case "below minimum":
				input.Groups["queue"] = model.MailcowGroupSettings{IntervalSeconds: 4}
			case "above maximum":
				input.Groups["queue"] = model.MailcowGroupSettings{IntervalSeconds: 86401}
			case "zero revision":
				input.Revision = 0
				body = input
			case "fractional interval":
				groups := map[string]any{}
				for _, id := range model.MailcowGroups() {
					groups[id] = map[string]any{"enabled": false, "interval_seconds": 60}
				}
				groups["queue"] = map[string]any{"enabled": true, "interval_seconds": 5.5}
				body = map[string]any{"revision": initial.Revision, "groups": groups}
			}
			if w := apiCall(s, admin, http.MethodPut, root+"/settings", body, nil); w.Code != http.StatusBadRequest {
				t.Fatalf("invalid settings accepted: status=%d body=%s", w.Code, w.Body.String())
			}
			if after := read(); !reflect.DeepEqual(after, initial) {
				t.Fatal("invalid settings changed source/cache")
			}
		})
	}
	settings := mailcowSettingsFixture(initial.Revision)
	settings.Groups["mailboxes"] = model.MailcowGroupSettings{Enabled: true, IntervalSeconds: 5}
	settings.Groups["inventory"] = model.MailcowGroupSettings{Enabled: true, IntervalSeconds: 86400}
	saved := apiDecode[model.MailcowSnapshot](t, apiCall(s, admin, http.MethodPut, root+"/settings", settings, nil), http.StatusOK)
	if saved.Revision != initial.Revision+1 || saved.URL != initial.URL {
		t.Fatalf("save did not return the updated source revision: %+v", saved)
	}
	for id, expected := range settings.Groups {
		group := saved.Groups[id]
		wantStatus := "disabled"
		if expected.Enabled {
			wantStatus = "pending"
		}
		if group.Enabled != expected.Enabled || group.IntervalSeconds != expected.IntervalSeconds || group.Status != wantStatus || string(group.Data) != "null" || group.LastSuccess != nil {
			t.Fatalf("save invented results or lost settings for %s: %+v", id, group)
		}
	}
	conflict := apiCall(s, admin, http.MethodPut, root+"/settings", settings, nil)
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "revision_conflict") {
		t.Fatalf("stale settings revision accepted: status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	if !reflect.DeepEqual(read(), saved) {
		t.Fatal("rejected stale revision overwrote current settings")
	}

	// Seed a real persisted group result through the Store path, then a failed
	// attempt. HTTP reads must preserve its values and original success time.
	integration, err := store.Get[model.Integration](ctx, s.Store, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	data := json.RawMessage(`{"mailboxes":3,"active_mailboxes":3,"messages":6,"used_bytes":2048}`)
	if err := s.Store.ApplyMailcowGroup(ctx, integration, "mailboxes", data, "", time.Now().UTC().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	good := read().Groups["mailboxes"]
	if good.Status != "ok" || good.LastSuccess == nil || good.LastAttempt == nil || good.LastAttemptStatus != "success" {
		t.Fatalf("persisted success missing: %+v", good)
	}
	if err := s.Store.ApplyMailcowGroup(ctx, integration, "mailboxes", nil, "timeout", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	var beforeBody string
	var beforeRevision int64
	if err := s.Store.Pool.QueryRow(ctx, "SELECT body::text,revision FROM documents WHERE kind='mailcow_snapshot' AND id=$1", integration.ID).Scan(&beforeBody, &beforeRevision); err != nil {
		t.Fatal(err)
	}
	var beforeJobs int
	if err := s.Store.Pool.QueryRow(ctx, "SELECT count(*) FROM jobs").Scan(&beforeJobs); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		group := read().Groups["mailboxes"]
		if group.Status != "error" || group.ErrorCode != "timeout" || group.LastAttemptStatus != "error" || group.LastSuccess == nil || !group.LastSuccess.Equal(*good.LastSuccess) {
			t.Fatalf("cached error lost previous successful result: %+v", group)
		}
		var values map[string]int
		if err := json.Unmarshal(group.Data, &values); err != nil || values["mailboxes"] != 3 || values["messages"] != 6 || values["used_bytes"] != 2048 {
			t.Fatalf("cached aggregate replaced by zero/missing: data=%s err=%v", group.Data, err)
		}
	}
	var afterBody string
	var afterRevision int64
	if err := s.Store.Pool.QueryRow(ctx, "SELECT body::text,revision FROM documents WHERE kind='mailcow_snapshot' AND id=$1", integration.ID).Scan(&afterBody, &afterRevision); err != nil {
		t.Fatal(err)
	}
	var afterJobs int
	if err := s.Store.Pool.QueryRow(ctx, "SELECT count(*) FROM jobs").Scan(&afterJobs); err != nil {
		t.Fatal(err)
	}
	if beforeBody != afterBody || beforeRevision != afterRevision || beforeJobs != afterJobs || *probes != 0 || *polls != 0 {
		t.Fatalf("GET triggered collection or mutated cache: cache_revision=%d→%d jobs=%d→%d probes=%d polls=%d", beforeRevision, afterRevision, beforeJobs, afterJobs, *probes, *polls)
	}
	settings.Revision = saved.Revision
	settings.Groups["queue"] = model.MailcowGroupSettings{Enabled: true, IntervalSeconds: 120}
	current := apiDecode[model.MailcowSnapshot](t, apiCall(s, admin, http.MethodPut, root+"/settings", settings, nil), http.StatusOK)
	if current.Revision != saved.Revision+1 || current.Groups["queue"].Status != "pending" || current.Groups["queue"].IntervalSeconds != 120 || !current.Groups["queue"].Enabled || current.Groups["mailboxes"].ErrorCode != "timeout" {
		t.Fatalf("current revision failed to save settings while retaining cached groups: %+v", current)
	}
}
