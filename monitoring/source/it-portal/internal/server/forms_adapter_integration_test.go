//go:build optional_module_acceptance

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Explicit opt-in for the application owner's real adapter + isolated FakeEngine
// fixture. This is a protocol/business boundary test, not HeyForm acceptance.
// The production destination remains fixed; only the test dial maps it to loopback.
func TestFormsActualAdapterProtocolAndLifecycle(t *testing.T) {
	endpoint := os.Getenv("PORTAL_TEST_FORMS_UPSTREAM_URL")
	if endpoint == "" {
		t.Fatal("explicit isolated Forms adapter fixture required")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		t.Fatal("Forms fixture must be an explicit loopback origin")
	}
	key, err := doskaReadFile(os.Getenv("PORTAL_TEST_FORMS_KEY_FILE"), 32)
	if err != nil || len(key) != 32 {
		t.Fatal("synthetic fixture raw32 key file required")
	}
	f := &formsHTTPFixture{s: apiFixture(t), key: key}
	f.employee = apiUser(t, f.s, "ad:forms-actual-employee", false)
	f.admin = apiUser(t, f.s, "ad:forms-actual-admin", true)
	f.g, err = f.s.newFormsGateway(&FormsGatewayConfig{Upstream: formsUpstream, Key: key, AllowedCIDRs: []string{"192.0.2.240/32"}})
	if err != nil {
		t.Fatal(err)
	}
	transport := f.g.transport.(*http.Transport)
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "192.0.2.240:8091" {
			t.Error("destination changed", address)
		}
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, u.Host)
	}
	t.Cleanup(transport.CloseIdleConnections)
	var captured *http.Request
	var capturedBody []byte
	f.g.transport = directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.Method == "POST" && r.URL.Path == "/forms/api/v1/surveys" {
			captured = r.Clone(context.Background())
			captured.Header = r.Header.Clone()
			capturedBody, _ = io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(capturedBody))
		}
		return transport.RoundTrip(r)
	})
	invoke := func(who apiIdentity, method, path, body, idem string) *httptest.ResponseRecorder {
		if idem == "" {
			idem = uuid.NewString()
		}
		return f.call(t, who, method, path, body, func(r *http.Request) { r.Header.Set("Idempotency-Key", idem) })
	}
	decode := func(w *httptest.ResponseRecorder, status int) map[string]any {
		t.Helper()
		if w.Code != status {
			t.Fatalf("adapter returned %d want %d: %s", w.Code, status, w.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal("adapter JSON", err)
		}
		return result
	}
	if w := invoke(apiIdentity{}, "GET", "/forms/api/v1/context", "", ""); w.Code != 401 {
		t.Fatal("anonymous adapter", w.Code)
	}
	for _, who := range []apiIdentity{f.employee, f.admin} {
		context := decode(invoke(who, "GET", "/forms/api/v1/context", "", ""), 200)
		wantAdmin := who.cookie == f.admin.cookie
		wantName := "ad:forms-actual-employee"
		if wantAdmin {
			wantName = "ad:forms-actual-admin"
		}
		if context["name"] != wantName || context["admin"] != wantAdmin || context["csrf_token"] != gatewayServiceCSRF(who.csrf, "forms") || context["csrf_token"] == who.csrf {
			t.Fatal("verified adapter context mismatch")
		}
	}
	for _, path := range []string{"/forms/", "/forms/index.html", "/forms/app.js", "/forms/styles.css", "/forms/theme.js"} {
		if w := invoke(f.employee, "GET", path, "", ""); w.Code != 200 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'self'") {
			t.Fatalf("actual adapter asset %s: %d %s", path, w.Code, w.Body.String())
		}
		if w := invoke(f.employee, "HEAD", path, "", ""); w.Code != 200 || w.Body.Len() != 0 {
			t.Fatal("actual adapter HEAD", path, w.Code)
		}
	}
	if businessID := os.Getenv("PORTAL_TEST_FORMS_BUSINESS_ID"); businessID != "" {
		t.Run("business result filtering", func(t *testing.T) {
			if !formsID.MatchString(businessID) {
				t.Fatal("invalid synthetic business survey ID")
			}
			path := "/forms/api/v1/surveys/" + businessID + "/results"
			body := `{"filters":{"role":["manager"]}}`
			if w := invoke(f.employee, "POST", path, body, ""); w.Code != 403 {
				t.Fatal("employee filtered results", w.Code)
			}
			all := decode(invoke(f.admin, "GET", path, "", ""), 200)
			filtered := decode(invoke(f.admin, "POST", path, body, ""), 200)
			if all["total"] != float64(6) || filtered["total"] != float64(2) || filtered["overall_total"] != float64(6) {
				t.Fatal("business result filter totals", all["total"], filtered["total"], filtered["overall_total"])
			}
			for _, field := range []string{"answers", "responses", "subject", "sub", "name"} {
				if _, exists := filtered[field]; exists {
					t.Fatal("raw identity/response exposed", field)
				}
			}
		})
	}
	poll := `{"title":"Gateway protocol acceptance","description":"Изолированный fixture","kind":"poll","outcomes":[],"questions":[{"id":"q1","title":"Проверка","required":true,"options":[{"id":"a","label":"Да","weights":{}},{"id":"b","label":"Нет","weights":{}}]}]}`
	created := decode(invoke(f.admin, "POST", "/forms/api/v1/surveys", poll, ""), 200)
	id, ok := created["id"].(string)
	if !ok || !formsID.MatchString(id) || created["status"] != "draft" {
		t.Fatal("invalid created survey")
	}
	base := "/forms/api/v1/surveys/" + id
	if w := invoke(f.employee, "GET", base, "", ""); w.Code != 404 {
		t.Fatal("draft exposed to employee", w.Code)
	}
	list := decode(invoke(f.employee, "GET", "/forms/api/v1/surveys", "", ""), 200)
	surveys, ok := list["surveys"].([]any)
	if !ok || len(surveys) > 100 {
		t.Fatal("unbounded list")
	}
	for _, entry := range surveys {
		if entry.(map[string]any)["id"] == id {
			t.Fatal("draft listed for employee")
		}
	}
	published := decode(invoke(f.admin, "POST", base+"/publish", `{}`, ""), 200)
	if published["status"] != "published" {
		t.Fatal("publish did not persist")
	}
	listed := decode(invoke(f.employee, "GET", "/forms/api/v1/surveys", "", ""), 200)["surveys"].([]any)
	found := false
	for _, entry := range listed {
		if entry.(map[string]any)["id"] == id {
			found = true
		}
	}
	if !found || len(listed) > 100 {
		t.Fatal("published survey not visible in bounded list")
	}
	detail := decode(invoke(f.employee, "GET", base, "", ""), 200)
	for _, key := range []string{"engine_id", "outcomes", "responses", "answers"} {
		if _, exists := detail[key]; exists {
			t.Fatal("employee private field", key)
		}
	}
	questions := detail["questions"].([]any)
	for _, question := range questions {
		for _, option := range question.(map[string]any)["options"].([]any) {
			if _, exists := option.(map[string]any)["weights"]; exists {
				t.Fatal("employee scoring weights exposed")
			}
		}
	}
	if w := invoke(f.employee, "GET", base+"/results", "", ""); w.Code != 403 {
		t.Fatal("employee results", w.Code)
	}
	submission := map[string]any{"version": published["version"], "answers": map[string]string{"q1": "a"}, "submission_id": uuid.NewString()}
	body, _ := json.Marshal(submission)
	idem := uuid.NewString()
	first := decode(invoke(f.employee, "POST", base+"/responses", string(body), idem), 200)
	repeated := decode(invoke(f.employee, "POST", base+"/responses", string(body), idem), 200)
	if first["saved"] != true || first["outcome"] != nil || !reflect.DeepEqual(first, repeated) {
		t.Fatal("submission/retry changed result")
	}
	results := decode(invoke(f.admin, "GET", base+"/results", "", ""), 200)
	if results["total"] != float64(1) {
		t.Fatal("retry duplicated result", results["total"])
	}
	for _, field := range []string{"answers", "responses", "subject", "sub", "name"} {
		if _, exists := results[field]; exists {
			t.Fatal("raw identity/response exposed", field)
		}
	}
	closed := decode(invoke(f.admin, "POST", base+"/close", `{}`, ""), 200)
	if closed["status"] != "closed" {
		t.Fatal("close did not persist")
	}
	submission["submission_id"] = uuid.NewString()
	body, _ = json.Marshal(submission)
	if w := invoke(f.employee, "POST", base+"/responses", string(body), ""); w.Code != 409 {
		t.Fatal("closed form accepted response", w.Code, w.Body.String())
	}
	if w := invoke(f.employee, "GET", base, "", ""); w.Code != 404 {
		t.Fatal("closed form exposed", w.Code)
	}
	results = decode(invoke(f.admin, "GET", base+"/results", "", ""), 200)
	if results["total"] != float64(1) {
		t.Fatal("closed response changed results")
	}

	// Requests below bypass the gateway deliberately to prove that the adapter
	// independently verifies the actual Go-produced assertion and body binding.
	directTransport := &http.Transport{Proxy: nil, DisableCompression: true}
	t.Cleanup(directTransport.CloseIdleConnections)
	direct := func(method, path string, body []byte, headers http.Header) int {
		t.Helper()
		req, err := http.NewRequest(method, endpoint+path, io.NopCloser(bytes.NewReader(body)))
		if err != nil {
			t.Fatal(err)
		}
		req.ContentLength = int64(len(body))
		req.Host = "portal.example.test"
		req.Header = headers.Clone()
		response, err := directTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		if response.Header.Get("Set-Cookie") != "" {
			t.Fatal("adapter created local auth cookie")
		}
		return response.StatusCode
	}
	if direct("GET", "/forms/api/v1/context", nil, http.Header{}) != 401 {
		t.Fatal("unsigned adapter access")
	}
	if captured == nil {
		t.Fatal("no actual signed mutation captured")
	}
	if direct(captured.Method, captured.URL.Path, capturedBody, captured.Header) != 409 {
		t.Fatal("actual assertion replay accepted")
	}
	forged := captured.Header.Clone()
	forged.Set(gatewaySignatureHeader, strings.Repeat("A", 43))
	if direct(captured.Method, captured.URL.Path, capturedBody, forged) != 401 {
		t.Fatal("forged signature accepted")
	}
	if direct(captured.Method, captured.URL.Path, []byte(`{}`), captured.Header) != 401 {
		t.Fatal("body binding bypass")
	}
	badCSRF := captured.Header.Clone()
	badCSRF.Set("X-CSRF-Token", "bad")
	if direct(captured.Method, captured.URL.Path, capturedBody, badCSRF) != 403 {
		t.Fatal("adapter CSRF bypass")
	}
	claims := decodeDirectoryAssertion(t, captured, key)
	for _, mutation := range []func(*gatewayIdentity){
		func(c *gatewayIdentity) { c.Audience = "directory" },
		func(c *gatewayIdentity) { c.IssuedAt -= 90; c.ExpiresAt -= 90 },
		func(c *gatewayIdentity) { c.Method = "GET" },
		func(c *gatewayIdentity) { c.URI = "/forms/api/v1/context" },
	} {
		copyClaims := claims
		mutation(&copyClaims)
		req := captured.Clone(context.Background())
		req.Header = captured.Header.Clone()
		if err := writeGatewayIdentity(req, copyClaims, key); err != nil {
			t.Fatal(err)
		}
		if direct(captured.Method, captured.URL.Path, capturedBody, req.Header) != 401 {
			t.Fatal("adapter claim mismatch accepted")
		}
	}
	falseAdmin := claims
	falseAdmin.Admin = false
	req := captured.Clone(context.Background())
	req.Header = captured.Header.Clone()
	if err := writeGatewayIdentity(req, falseAdmin, key); err != nil {
		t.Fatal(err)
	}
	if direct(captured.Method, captured.URL.Path, capturedBody, req.Header) != 403 {
		t.Fatal("adapter issuer-admin boundary bypass")
	}

}
