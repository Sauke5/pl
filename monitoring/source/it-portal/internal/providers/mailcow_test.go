package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

const mailcowTestKey = "test-only-mailcow-key"
const mailcowTestServices = `{"postfix-mailcow":{"state":"running","started_at":"2026-10-30T06:47:48.797555645Z","container":"private-container-id"},"dockerapi-mailcow":{"state":"running","started_at":"2026-10-30T06:43:30Z"},"clamd-mailcow":{"state":"running","started_at":"2026-10-30T06:54:17Z"}}`

func mailcowTestIntegration(t *testing.T) model.Integration {
	t.Helper()
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_MAILCOW_TEST")
	t.Setenv("PORTAL_SECRET_MAILCOW_TEST", mailcowTestKey)
	return model.Integration{Kind: "mailcow", Enabled: true, URL: "http://mailcow.test", SecretRef: "env:PORTAL_SECRET_MAILCOW_TEST"}
}
func mailcowTestRegistry(t *testing.T, responses map[string]string) (*Registry, *[]string) {
	t.Helper()
	calls := []string{}
	r := registry(t, func(w http.ResponseWriter, req *http.Request) {
		calls = append(calls, req.URL.Path)
		if req.Method != http.MethodGet || req.Header.Get("X-API-Key") != mailcowTestKey || req.Header.Get("Accept") != "application/json" || req.Header.Get("Accept-Encoding") != "identity" || req.URL.RawQuery != "" || req.Header.Get("Authorization") != "" {
			t.Errorf("request escaped native read contract: method=%s path=%s", req.Method, req.URL.Path)
		}
		body, ok := responses[strings.TrimPrefix(req.URL.Path, "/api/v1/get/")]
		if !ok || !strings.HasPrefix(req.URL.Path, "/api/v1/get/") {
			t.Errorf("unexpected API path %s", req.URL.Path)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	return r, &calls
}
func mailcowTestDecode(t *testing.T, raw json.RawMessage, err error) map[string]any {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{mailcowTestKey, "private-", "@example.test", "example.test", "queue-secret"} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("private field leaked: %s", private)
		}
	}
	return data
}
func TestMailcowNativeGroupsAggregateWithoutPII(t *testing.T) {
	i := mailcowTestIntegration(t)
	responses := map[string]string{
		"status/version":    `{"version":"2026-10"}`,
		"domain/all":        `[{"domain_name":"example.test","active_int":1,"active":"localized","mboxes_in_domain":"2","bytes_total":"25","msgs_total":"6","max_quota_for_domain":1000,"quota_used_in_domain":"300"}]`,
		"mailbox/all":       `[{"username":"private-user@example.test","active_int":"1","quota":"100","quota_used":"90","messages":"2"},{"username":"second@example.test","active":false,"quota":0,"quota_used":25,"messages":4}]`,
		"status/containers": mailcowTestServices,
		"mailq/all":         fmt.Sprintf(`[{"queue_id":"queue-secret","queue_name":"deferred","message_size":"90","arrival_time":%d,"sender":"private-sender@example.test","recipients":["private-recipient@example.test"],"body":"private-message"}]`, time.Now().Unix()-30),
		"status/vmail":      `{"used_percent":"69%","used":"78G","total":"113G","disk":"private-device"}`,
		"logs/rspamd-stats": `{"scanned":"20","actions":{"no action":18,"reject":"1","private-class":1},"spam_count":"2","learned":4,"uptime":12.5,"secret":"private-secret"}`,
	}
	r, calls := mailcowTestRegistry(t, responses)
	tests := []struct {
		group, field string
		expected     any
		paths        string
	}{
		{"inventory", "used_bytes", float64(25), "/api/v1/get/status/version,/api/v1/get/domain/all"},
		{"mailboxes", "quota_over_90_percent", float64(1), "/api/v1/get/mailbox/all"},
		{"queue", "bytes_observed", float64(90), "/api/v1/get/status/containers,/api/v1/get/mailq/all"},
		{"services", "services", nil, "/api/v1/get/status/containers"},
		{"storage", "used_display", "78G", "/api/v1/get/status/vmail"},
		{"rspamd", "scanned", float64(20), "/api/v1/get/logs/rspamd-stats"},
	}
	for _, tc := range tests {
		t.Run(tc.group, func(t *testing.T) {
			*calls = nil
			raw, err := r.MailcowCollect(context.Background(), i, tc.group)
			data := mailcowTestDecode(t, raw, err)
			if tc.expected != nil && data[tc.field] != tc.expected {
				t.Fatalf("%s=%v", tc.field, data[tc.field])
			}
			if strings.Join(*calls, ",") != tc.paths {
				t.Fatalf("paths=%v", *calls)
			}
			switch tc.group {
			case "inventory":
				if data["mailbox_quota_allocated_bytes"] != float64(300) || data["quota_limit_bytes"] != float64(1000) {
					t.Fatal(data)
				}
			case "mailboxes":
				if data["used_bytes"] != float64(115) || data["unlimited_mailboxes"] != float64(1) || data["messages"] != float64(6) {
					t.Fatal(data)
				}
			case "services":
				services := data["services"].(map[string]any)
				if len(services) != 3 || services["clamd-mailcow"].(map[string]any)["state"] != "running" || services["postfix-mailcow"].(map[string]any)["started_at"].(float64) <= 0 {
					t.Fatal(data)
				}
				if _, ok := data["readiness"]; ok {
					t.Fatal("invented readiness")
				}
			case "queue":
				age := data["oldest_observed_age_seconds"].(float64)
				if age < 29 || age > 35 || data["empty_ambiguous"] != false {
					t.Fatal(data)
				}
			case "storage":
				if _, ok := data["used_bytes"]; ok {
					t.Fatal("rounded sizes converted to exact bytes")
				}
				if data["used_percent"] != float64(69) {
					t.Fatal(data)
				}
			case "rspamd":
				if data["actions"].(map[string]any)["other"] != float64(1) {
					t.Fatal(data)
				}
				if _, ok := data["ham_count"]; ok {
					t.Fatal("missing counter fabricated")
				}
			}
		})
	}
}

func TestMailcowNativeEmptyListsAndQueueAmbiguity(t *testing.T) {
	i := mailcowTestIntegration(t)
	for _, empty := range []string{"[]", "{}"} {
		t.Run(empty, func(t *testing.T) {
			r, _ := mailcowTestRegistry(t, map[string]string{"status/version": `{"version":"2026-10"}`, "domain/all": empty, "mailbox/all": empty, "mailq/all": empty, "status/containers": mailcowTestServices})
			for _, group := range []string{"inventory", "mailboxes", "queue"} {
				raw, err := r.MailcowCollect(context.Background(), i, group)
				data := mailcowTestDecode(t, raw, err)
				if group == "queue" && (data["empty_ambiguous"] != true || data["messages_observed"] != float64(0) || data["possibly_truncated"] != false) {
					t.Fatal(data)
				}
			}
		})
	}
}
func TestMailcowNativeFiniteErrorsIgnoreUpstreamText(t *testing.T) {
	i := mailcowTestIntegration(t)
	for _, tc := range []struct {
		status int
		code   string
	}{{401, "auth"}, {403, "auth"}, {404, "unsupported"}, {501, "unsupported"}, {500, "http"}, {429, "http"}} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(mailcowTestKey + " private-error-body"))
			})
			raw, err := r.MailcowCollect(context.Background(), i, "storage")
			if (tc.status == 401 || tc.status == 403) && MailcowHTTPStatus(err) != tc.status {
				t.Fatal("upstream authentication status was lost")
			}
			if raw != nil || MailcowErrorCode(err) != tc.code || strings.Contains(err.Error(), mailcowTestKey) || strings.Contains(err.Error(), "private-") {
				t.Fatalf("data=%s err=%v", raw, err)
			}
		})
	}
	for _, body := range []string{`{"type":"danger","msg":"private-body"}`, `[{"type":"error","msg":"private-body"}]`} {
		r, _ := mailcowTestRegistry(t, map[string]string{"mailbox/all": body})
		raw, err := r.MailcowCollect(context.Background(), i, "mailboxes")
		if raw != nil || MailcowErrorCode(err) != "upstream" {
			t.Fatalf("%s %v", raw, err)
		}
	}
}
func TestMailcowNativeNeverFollowsRedirects(t *testing.T) {
	i := mailcowTestIntegration(t)
	for _, code := range []int{301, 302, 303, 307, 308} {
		for _, location := range []string{"http://mailcow.test/steal-key", "http://other.test/steal-key"} {
			t.Run(fmt.Sprint(code)+location, func(t *testing.T) {
				calls := 0
				r := registry(t, func(w http.ResponseWriter, req *http.Request) {
					calls++
					if req.URL.Path != "/api/v1/get/status/vmail" {
						t.Error("redirect target reached")
					}
					w.Header().Set("Location", location)
					w.WriteHeader(code)
				})
				raw, err := r.MailcowCollect(context.Background(), i, "storage")
				if calls != 1 || raw != nil || MailcowErrorCode(err) != "policy" {
					t.Fatalf("calls=%d raw=%s err=%v", calls, raw, err)
				}
			})
		}
	}
}
func TestMailcowNativePolicyAndSecretRejectBeforeNetwork(t *testing.T) {
	i := mailcowTestIntegration(t)
	calls := 0
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(500) })
	for _, origin := range []string{"http://user:password@mailcow.test", "http://mailcow.test/api", "http://mailcow.test/?token=private", "http://mailcow.test/#fragment", "ftp://mailcow.test", "http://mailcow.test:9999", "http://mailcow.test/%2f", "http://mailcow.test/?"} {
		candidate := i
		candidate.URL = origin
		raw, err := r.MailcowCollect(context.Background(), candidate, "storage")
		if raw != nil || MailcowErrorCode(err) != "policy" {
			t.Fatalf("unsafe origin accepted: %s %v", origin, err)
		}
	}
	for _, ref := range []string{"", "env:PORTAL_SECRET_UNLISTED"} {
		candidate := i
		candidate.SecretRef = ref
		_, err := r.MailcowCollect(context.Background(), candidate, "storage")
		if MailcowErrorCode(err) != "secret" {
			t.Fatal(err)
		}
	}
	t.Setenv("PORTAL_SECRET_MAILCOW_TEST", "private-key\nheader")
	_, err := r.MailcowCollect(context.Background(), i, "storage")
	if MailcowErrorCode(err) != "secret" || calls != 0 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	_, err = r.MailcowCollect(context.Background(), i, "arbitrary/path")
	if MailcowErrorCode(err) != "unsupported" || calls != 0 {
		t.Fatal(err)
	}
}
func TestMailcowNativeNetworkPolicyEnforcedByGuard(t *testing.T) {
	i := mailcowTestIntegration(t)
	// The shared registry fixture resolves names to 10.0.0.5; numeric loopback
	// bypasses DNS but must still be denied before its injected dial is called.
	calls := 0
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(500) })
	i.URL = "http://127.0.0.1"
	_, err := r.MailcowCollect(context.Background(), i, "storage")
	if MailcowErrorCode(err) != "policy" || calls != 0 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}
func TestMailcowNativeSchemaAndAtomicPartialFailure(t *testing.T) {
	i := mailcowTestIntegration(t)
	for _, body := range []string{`null`, `[]`, `{"used_percent":"101%","used":"1G","total":"1G"}`, `{"used_percent":69,"used":"1G","total":"1G"}`, `{"used_percent":"NaN%","used":"1G","total":"1G"}`, `{"used_percent":"1%","used":"1G"}`, `{} {}`, `{`} {
		r, _ := mailcowTestRegistry(t, map[string]string{"status/vmail": body})
		raw, err := r.MailcowCollect(context.Background(), i, "storage")
		if raw != nil || MailcowErrorCode(err) != "schema" {
			t.Fatalf("body=%s raw=%s err=%v", body, raw, err)
		}
	}
	r, calls := mailcowTestRegistry(t, map[string]string{"status/version": `{"version":"2026-10"}`, "domain/all": `[{"domain_name":"private-domain"}]`})
	raw, err := r.MailcowCollect(context.Background(), i, "inventory")
	if raw != nil || MailcowErrorCode(err) != "schema" || len(*calls) != 2 {
		t.Fatalf("raw=%s err=%v calls=%v", raw, err, *calls)
	}
	// An unrelated healthy group succeeds after another group's parse failure.
	r, _ = mailcowTestRegistry(t, map[string]string{"mailbox/all": `[{"username":"private-user"}]`, "status/vmail": `{"used_percent":"1%","used":"1G","total":"100G"}`})
	_, err = r.MailcowCollect(context.Background(), i, "mailboxes")
	if MailcowErrorCode(err) != "schema" {
		t.Fatal(err)
	}
	raw, err = r.MailcowCollect(context.Background(), i, "storage")
	_ = mailcowTestDecode(t, raw, err)
}
func TestMailcowNativeDuplicateAndInvalidCounts(t *testing.T) {
	i := mailcowTestIntegration(t)
	valid := `{"username":"private-user","active_int":1,"quota":100,"quota_used":90,"messages":2}`
	for _, body := range []string{"[" + valid + "," + valid + "]", strings.Replace("["+valid+"]", `"quota_used":90`, `"quota_used":-1`, 1), strings.Replace("["+valid+"]", `"messages":2`, `"messages":2.5`, 1), strings.Replace("["+valid+"]", `"messages":2`, `"messages":true`, 1), strings.Replace("["+valid+"]", `"messages":2`, `"messages":"NaN"`, 1), strings.Replace("["+valid+"]", `"messages":2`, `"messages":1e100000000`, 1)} {
		r, _ := mailcowTestRegistry(t, map[string]string{"mailbox/all": body})
		raw, err := r.MailcowCollect(context.Background(), i, "mailboxes")
		if raw != nil || MailcowErrorCode(err) != "schema" {
			t.Fatalf("raw=%s err=%v", raw, err)
		}
	}
	for _, value := range []any{json.Number("1.1"), json.Number("-1"), json.Number("9223372036854775808"), json.Number("9007199254740992.1"), "1e3", " 1", "1e100000000", true} {
		if _, err := mailcowInteger(value); MailcowErrorCode(err) != "schema" {
			t.Fatalf("integer accepted %v", value)
		}
	}
	for _, value := range []any{json.Number("9007199254740993"), "9007199254740993"} {
		n, err := mailcowInteger(value)
		if err != nil || n != 9007199254740993 {
			t.Fatalf("lost exact integer: %d %v", n, err)
		}
	}
	data := map[string]any{"bytes": int64(math.MaxInt64)}
	if MailcowErrorCode(mailcowAdd(data, "bytes", 1)) != "schema" {
		t.Fatal("aggregate overflow accepted")
	}
}
func TestMailcowNativeQueueDependencyAndServiceValidation(t *testing.T) {
	i := mailcowTestIntegration(t)
	for _, services := range []string{`{}`, `{"postfix-mailcow":{"state":"running","started_at":"2026-10-30T06:47:48Z"}}`, strings.Replace(mailcowTestServices, `"running"`, `"exited"`, 1)} {
		r, calls := mailcowTestRegistry(t, map[string]string{"status/containers": services})
		raw, err := r.MailcowCollect(context.Background(), i, "queue")
		if raw != nil || (MailcowErrorCode(err) != "schema" && MailcowErrorCode(err) != "dependency") || len(*calls) != 1 {
			t.Fatalf("raw=%s err=%v calls=%v", raw, err, *calls)
		}
	}
	for _, services := range []string{strings.Replace(mailcowTestServices, "postfix-mailcow", "private-user@example.test", 1), strings.Replace(mailcowTestServices, "2026-10-30T06:43:30Z", "2026-10-30T06:43:30", 1)} {
		r, _ := mailcowTestRegistry(t, map[string]string{"status/containers": services})
		_, err := r.MailcowCollect(context.Background(), i, "services")
		if MailcowErrorCode(err) != "schema" {
			t.Fatal(err)
		}
	}
	r, _ := mailcowTestRegistry(t, map[string]string{"status/containers": strings.Replace(mailcowTestServices, `"running"`, `"future-state"`, 1)})
	raw, err := r.MailcowCollect(context.Background(), i, "services")
	data := mailcowTestDecode(t, raw, err)
	if data["services"].(map[string]any)["postfix-mailcow"].(map[string]any)["state"] != "unknown" {
		t.Fatal(data)
	}
}
func TestMailcowNativeBodyAndRecordLimits(t *testing.T) {
	i := mailcowTestIntegration(t)
	for _, declared := range []bool{false, true} {
		t.Run(fmt.Sprint(declared), func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, _ *http.Request) {
				if declared {
					w.Header().Set("Content-Length", fmt.Sprint(mailcowMaxBody+1))
				}
				_, _ = w.Write([]byte(strings.Repeat(" ", mailcowMaxBody+1)))
			})
			raw, err := r.MailcowCollect(context.Background(), i, "storage")
			if raw != nil || MailcowErrorCode(err) != "body_limit" {
				t.Fatalf("raw=%s err=%v", raw, err)
			}
		})
	}
	body := "[" + strings.Repeat("{},", mailcowMaxRecords) + "{}]"
	r, _ := mailcowTestRegistry(t, map[string]string{"mailbox/all": body})
	raw, err := r.MailcowCollect(context.Background(), i, "mailboxes")
	if raw != nil || MailcowErrorCode(err) != "record_limit" {
		t.Fatal(err)
	}
	// The upstream queue list limit is 10000: exactly at the cap remains an
	// observation with an explicit possible-truncation flag.
	row := `{"queue_name":"private-class","message_size":1,"arrival_time":0}`
	body = "[" + strings.Repeat(row+",", mailcowMaxRecords-1) + row + "]"
	r, _ = mailcowTestRegistry(t, map[string]string{"status/containers": mailcowTestServices, "mailq/all": body})
	raw, err = r.MailcowCollect(context.Background(), i, "queue")
	data := mailcowTestDecode(t, raw, err)
	if data["possibly_truncated"] != true || data["messages_observed"] != float64(mailcowMaxRecords) || data["by_queue"].(map[string]any)["other"] != float64(mailcowMaxRecords) {
		t.Fatal(data)
	}
}
func TestMailcowNativeCancellationAndCounterResets(t *testing.T) {
	i := mailcowTestIntegration(t)
	r, _ := mailcowTestRegistry(t, map[string]string{"logs/rspamd-stats": `{"scanned":2,"actions":{"no action":2},"uptime":1}`})
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	raw, err := r.MailcowCollect(ctx, i, "rspamd")
	if raw != nil || MailcowErrorCode(err) != "timeout" {
		t.Fatal(err)
	}
	raw, err = r.MailcowCollect(context.Background(), i, "rspamd")
	data := mailcowTestDecode(t, raw, err)
	if data["scanned"] != float64(2) {
		t.Fatal(data)
	}
	// There is no monotonicity assumption or fabricated delta in a stateless read.
	r, _ = mailcowTestRegistry(t, map[string]string{"logs/rspamd-stats": `{"scanned":0,"actions":{},"uptime":0}`})
	raw, err = r.MailcowCollect(context.Background(), i, "rspamd")
	data = mailcowTestDecode(t, raw, err)
	if data["scanned"] != float64(0) {
		t.Fatal(data)
	}
}

func TestMailcowNativeTLSVerificationCannotBeDisabled(t *testing.T) {
	i := mailcowTestIntegration(t)
	called := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"used_percent":"1%","used":"1G","total":"100G"}`))
	}))
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "https://")
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80, 443}, "", fakeDNS{}, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	})
	if err != nil {
		t.Fatal(err)
	}
	i.URL = "https://mailcow.test"
	i.Config = map[string]string{"tls_skip_verify": "true", "insecure": "true"}
	raw, err := New(guard, "").MailcowCollect(context.Background(), i, "storage")
	if raw != nil || MailcowErrorCode(err) != "network" || called {
		t.Fatalf("TLS verification bypassed: handler=%v err=%v", called, err)
	}
}
func TestMailcowNativeOneBudgetForAllGroupRequests(t *testing.T) {
	i := mailcowTestIntegration(t)
	i.TimeoutSeconds = 1
	r := registry(t, func(w http.ResponseWriter, req *http.Request) {
		select {
		case <-time.After(650 * time.Millisecond):
		case <-req.Context().Done():
			return
		}
		if req.URL.Path == "/api/v1/get/status/version" {
			_, _ = w.Write([]byte(`{"version":"2026-10"}`))
		} else {
			_, _ = w.Write([]byte(`[]`))
		}
	})
	started := time.Now()
	raw, err := r.MailcowCollect(context.Background(), i, "inventory")
	if raw != nil || MailcowErrorCode(err) != "timeout" || time.Since(started) > 2*time.Second {
		t.Fatalf("group budget not enforced: elapsed=%s err=%v", time.Since(started), err)
	}
}
func TestMailcowNativeInterruptedResponseHasFiniteNetworkError(t *testing.T) {
	i := mailcowTestIntegration(t)
	r := registry(t, func(w http.ResponseWriter, _ *http.Request) {
		hijack, ok := w.(http.Hijacker)
		if !ok {
			t.Error("HTTP test server cannot hijack")
			return
		}
		conn, _, err := hijack.Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	})
	raw, err := r.MailcowCollect(context.Background(), i, "storage")
	if raw != nil || MailcowErrorCode(err) != "network" || strings.Contains(err.Error(), i.URL) {
		t.Fatalf("raw=%s err=%v", raw, err)
	}
}

func TestMailcowNativeManagedExternalAndIntegrationAdmission(t *testing.T) {
	i := mailcowTestIntegration(t)
	i.ManagedModuleID = "module-mailcow-external"
	i.Config = map[string]string{"module_mode": "external"}
	r, calls := mailcowTestRegistry(t, map[string]string{"status/vmail": `{"used_percent":"1%","used":"1G","total":"100G"}`})
	raw, err := r.MailcowCollect(context.Background(), i, "storage")
	data := mailcowTestDecode(t, raw, err)
	if data["used_percent"] != float64(1) || len(*calls) != 1 {
		t.Fatalf("external module not collected: calls=%v data=%v", *calls, data)
	}
	for _, tc := range []struct {
		name, mode, kind string
		enabled          bool
	}{
		{"managed local", "local", "mailcow", true},
		{"managed mode absent", "", "mailcow", true},
		{"disabled external", "external", "mailcow", false},
		{"wrong kind", "external", "wayline", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := i
			candidate.Config = map[string]string{"module_mode": tc.mode}
			candidate.Kind, candidate.Enabled = tc.kind, tc.enabled
			*calls = nil
			raw, err := r.MailcowCollect(context.Background(), candidate, "storage")
			if raw != nil || MailcowErrorCode(err) != "policy" || len(*calls) != 0 {
				t.Fatalf("invalid integration admitted: raw=%s calls=%v err=%v", raw, *calls, err)
			}
		})
	}
	// A standalone integration is already external and has no module-mode marker.
	i.ManagedModuleID, i.Config = "", nil
	*calls = nil
	raw, err = r.MailcowCollect(context.Background(), i, "storage")
	_ = mailcowTestDecode(t, raw, err)
	if len(*calls) != 1 {
		t.Fatalf("standalone integration not collected: calls=%v", *calls)
	}
}

func TestMailcowPreflightUsesSevenReadsAndOneBudget(t *testing.T) {
	responses := map[string]string{
		"status/version": `{"version":"2026-10"}`, "domain/all": `[]`, "mailbox/all": `[]`, "mailq/all": `[]`,
		"status/containers": mailcowTestServices, "status/vmail": `{"used_percent":"0%","used":"0G","total":"16G"}`, "logs/rspamd-stats": `{"scanned":0,"actions":{}}`,
	}
	t.Run("zero data and transient credential", func(t *testing.T) {
		i := mailcowTestIntegration(t)
		i.SecretRef = ""
		r, calls := mailcowTestRegistry(t, responses)
		if err := r.MailcowProbe(context.Background(), i, mailcowTestKey); err != nil {
			t.Fatal(err)
		}
		if len(*calls) != 7 {
			t.Fatal("expected seven unique native GET requests", *calls)
		}
	})
	t.Run("one total timeout", func(t *testing.T) {
		i := mailcowTestIntegration(t)
		i.TimeoutSeconds = 1
		var calls atomic.Int32
		r := registry(t, func(w http.ResponseWriter, req *http.Request) {
			calls.Add(1)
			select {
			case <-time.After(300 * time.Millisecond):
			case <-req.Context().Done():
				return
			}
			_, _ = w.Write([]byte(responses[strings.TrimPrefix(req.URL.Path, "/api/v1/get/")]))
		})
		started := time.Now()
		err := r.MailcowProbe(context.Background(), i, "")
		if MailcowErrorCode(err) != "timeout" || calls.Load() >= 7 || time.Since(started) > 2*time.Second {
			t.Fatal("preflight did not retain a single finite budget", err, calls.Load(), time.Since(started))
		}
	})
	t.Run("policy before transient credential", func(t *testing.T) {
		i := mailcowTestIntegration(t)
		i.URL = "http://127.0.0.1"
		i.SecretRef = ""
		r, calls := mailcowTestRegistry(t, responses)
		if err := r.MailcowProbe(context.Background(), i, mailcowTestKey); MailcowErrorCode(err) != "policy" || len(*calls) != 0 {
			t.Fatal("probe bypassed target policy", err, *calls)
		}
	})
}
