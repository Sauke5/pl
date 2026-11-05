package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/organization"
	"pl/portal/internal/store"
)

func catalogTestManifest() DoskaGatewayManifest {
	m := doskaGatewayTestManifest()
	min, max := int64(1), int64(50)
	m.Routes = append(m.Routes,
		DoskaGatewayRoute{Method: "GET", Path: "/doska/api/doska/catalog/search", Kind: "read", Query: map[string]DoskaGatewayQuery{"projectId": {Kind: "id", Required: true}, "q": {Kind: "text", Required: true, MaxChars: 128, MaxBytes: 512}, "limit": {Kind: "integer", Minimum: &min, Maximum: &max}, "cursor": {Kind: "text", MaxBytes: 512}}},
		DoskaGatewayRoute{Method: "POST", Path: "/doska/api/doska/catalog/resolve", Kind: "write"},
		DoskaGatewayRoute{Method: "POST", Path: "/doska/api/doska/catalog/task-links", Kind: "write"},
		DoskaGatewayRoute{Method: "GET", Path: "/doska/api/doska/projects/{projectId}/tasks/{taskId}/resource-links", Kind: "read"},
		DoskaGatewayRoute{Method: "POST", Path: "/doska/api/doska/projects/{projectId}/tasks/{taskId}/resource-links", Kind: "write"},
		DoskaGatewayRoute{Method: "DELETE", Path: "/doska/api/doska/projects/{projectId}/tasks/{taskId}/resource-links/{linkId}", Kind: "write"},
		DoskaGatewayRoute{Method: "POST", Path: "/doska/api/doska/projects/{projectId}/tasks/from-resource", Kind: "write"},
		// Even an accidentally listed internal route must stay inaccessible.
		DoskaGatewayRoute{Method: "GET", Path: "/doska/api/doska/projects/{projectId}/resource-link-capabilities", Kind: "read"})
	return m
}
func TestDoskaCatalogStrictSchemas(t *testing.T) {
	selection := `{"resourceId":"11111111-1111-4111-8111-111111111111","sourceKind":"platform"}`
	valid := `{"selection":` + selection + `,"limit":20,"cursor":null}`
	for _, tc := range []struct {
		body string
		ok   bool
	}{
		{valid, true}, {`{"selection":` + selection + `}`, true},
		{strings.Replace(valid, `"limit":20`, `"limit":20,"limit":1`, 1), false},
		{strings.Replace(valid, `"limit":20`, `"Limit":20`, 1), false},
		{strings.Replace(valid, `"cursor":null`, `"Cursor":null`, 1), false},
		{strings.Replace(valid, `"limit":20`, `"limit":null`, 1), false},
		{strings.Replace(valid, `"sourceKind":"platform"`, `"sourceKind":"platform","ref":{}`, 1), false},
		{valid + ` {}`, false}, {strings.Replace(valid, `"limit":20`, `"limit":1.5`, 1), false},
		{strings.Replace(valid, `"limit":20`, `"limit":51`, 1), false},
		{strings.Replace(valid, `"sourceKind":"platform"`, `"sourceKind":"PLATFORM"`, 1), false},
	} {
		var in catalogInput
		if got := catalogInputValid("backrefs", []byte(tc.body), &in); got != tc.ok {
			t.Fatalf("valid=%v want%v %s", got, tc.ok, tc.body)
		}
	}
	for _, tc := range []struct {
		task string
		ok   bool
	}{
		{`{"title":"Task","columnId":"c","description":null,"due":null,"labels":[{"name":"Label","color":"red"}],"customValues":[{"fieldId":"f","value":null}],"coexecutorIds":["u:1"],"priority":"medium"}`, true},
		{`{"title":"` + strings.Repeat("Я", 500) + `","description":"` + strings.Repeat("x", 100000) + `"}`, true},
		{`{"title":"Task","status":"todo"}`, false}, {`{"title":"Task","columnId":null}`, false},
		{`{"title":"Task","labels":[{"name":"L","color":"red","leak":"x"}]}`, false},
		{`{"title":"Task","due":{"date":"2026-10-25","URL":"x"}}`, false},
		{`{"title":"Task","customValues":[{"fieldId":"f","value":false}]}`, false},
		{`{"title":"Task","userId":33}`, false}, {`{"title":"   "}`, false},
		{`{"title":"` + strings.Repeat("x", 501) + `"}`, false},
	} {
		if got := catalogTaskShape([]byte(tc.task)); got != tc.ok {
			t.Fatalf("task valid=%v want%v length%d", got, tc.ok, len(tc.task))
		}
	}
	for _, raw := range []string{`{"version":1,"revision":1,"linkId":"x","REF":{}}`, `{"version":1,"revision":1,"linkId":"x","LinkId":"y"}`, "{\"version\":1,\"revision\":1,\"linkId\":\"\xff\"}"} {
		var v catalogMutation
		if catalogJSON([]byte(raw), &v) == nil {
			t.Fatal("invalid upstream accepted")
		}
	}
}
func TestDoskaCatalogCursorBinding(t *testing.T) {
	g := &doskaGateway{config: DoskaGatewayConfig{Key: []byte("0123456789abcdef0123456789abcdef")}}
	c := catalogCursor{Subject: strings.Repeat("s", 256), Project: strings.Repeat("p", 128), Query: strings.Repeat("Я", 128), Policy: strings.Repeat("f", 64), Last: "11111111-1111-4111-8111-111111111111:platform", Expires: time.Now().Add(299 * time.Second).Unix()}
	raw := g.catalogCursorEncode(c)
	if len(raw) > 512 {
		t.Fatalf("cursor too large: %d", len(raw))
	}
	if got, e := g.catalogCursorDecode(raw, c); e != nil || got != c.Last {
		t.Fatalf("cursor %s %v", got, e)
	}
	for _, edit := range []func(*catalogCursor){func(c *catalogCursor) { c.Subject = "other" }, func(c *catalogCursor) { c.Project = "other" }, func(c *catalogCursor) { c.Query = "other" }, func(c *catalogCursor) { c.Policy = "revoked" }} {
		v := c
		edit(&v)
		if _, e := g.catalogCursorDecode(raw, v); e == nil {
			t.Fatal("foreign cursor accepted")
		}
	}
	if _, e := g.catalogCursorDecode(raw+"x", c); e == nil {
		t.Fatal("tamper accepted")
	}
}

func TestDoskaCatalogPostgreSQLHTTP(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	guid := make([]byte, 16)
	guid[15] = 71
	subject, _ := organization.ADSubject("dc=catalog,dc=test", guid)
	_, e := organization.NewStore(s.Store.Pool).SaveEmployee(ctx, organization.EmployeeRecord{Identity: organization.Identity{Subject: subject, Name: "Catalog actor", AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: strings.Split(subject, ":")[1], ObjectGUID: guid}, 0, "test", now)
	if e != nil {
		t.Fatal(e)
	}
	user := apiUser(t, s, subject, false)
	ids := []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"}
	for i, id := range ids {
		_, e = s.Store.Save(ctx, "resource", id, 0, model.Resource{ID: id, Name: "Service " + id[:1], Description: "private-description", IP: "192.0.2.99", Site: "private-site", Lifecycle: "active", Employee: &model.EmployeeMetadata{DisplayName: "Service " + id[:1], Description: "safe description", Category: "safe category"}}, "fixture")
		if e != nil {
			t.Fatal(e)
		}
		_ = i
	}
	settings, _ := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{ids[1], ids[2]}
	saveSettings := func() {
		b, e := s.Store.Save(ctx, "settings", "global", settings.Revision, settings, "fixture")
		if e != nil {
			t.Fatal(e)
		}
		settings, _ = store.Decode[model.Settings](b)
	}
	saveSettings()
	// An aborted RoundTrip can finish before the fixture handler unwinds.
	var backendMu sync.Mutex
	calls := 0
	mode := "normal"
	setMode := func(value string) {
		backendMu.Lock()
		defer backendMu.Unlock()
		mode = value
	}
	callCount := func() int {
		backendMu.Lock()
		defer backendMu.Unlock()
		return calls
	}
	nonces := map[string]bool{}
	keys := []string{}
	lastBody := ""
	revoked := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendMu.Lock()
		defer backendMu.Unlock()
		calls++
		body, _ := io.ReadAll(r.Body)
		if r.Method != "GET" {
			lastBody = string(body)
		}
		b, _ := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
		var claims gatewayIdentity
		_ = json.Unmarshal(b, &claims)
		sum := sha256.Sum256(body)
		if claims.URI != "/doska"+r.URL.RequestURI() || claims.BodySHA256 != hex.EncodeToString(sum[:]) || claims.Subject != subject || claims.Audience != "doska" || nonces[claims.Nonce] || r.Header.Get(gatewaySignatureHeader) != gatewayMAC([]byte("0123456789abcdef0123456789abcdef"), "pl-gateway-v2\n"+r.Header.Get(gatewayAssertionHeader)) {
			t.Error("signed request binding")
		}
		nonces[claims.Nonce] = true
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("browser credentials forwarded")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "private=x")
		if strings.HasSuffix(r.URL.Path, "/resource-link-capabilities") {
			if mode == "denied" {
				w.WriteHeader(404)
				io.WriteString(w, `{"private":"secret"}`)
				return
			}
			io.WriteString(w, `{"version":1,"readContent":true,"workOnTasks":true}`)
			return
		}
		if mode == "logout" {
			_, _ = s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", subject)
		}
		if mode == "revoked" && !revoked {
			settings.BoardResourceIDs = []string{}
			saveSettings()
			revoked = true
		}
		if mode == "timeout" {
			panic(http.ErrAbortHandler)
		}
		if mode == "unknown-key" {
			io.WriteString(w, `{"version":1,"revision":0,"links":[],"ref":"private"}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/task-links") {
			if mode == "foreign-href" {
				io.WriteString(w, `{"version":1,"items":[{"projectId":"p","taskId":"t","title":"Task","href":"https://evil.test/"}],"nextCursor":null}`)
			} else {
				io.WriteString(w, `{"version":1,"items":[{"projectId":"p","taskId":"t","title":"Task","href":"/doska/projects/p?taskId=t"}],"nextCursor":null}`)
			}
			return
		}
		if r.Method == "GET" {
			io.WriteString(w, `{"version":1,"revision":0,"links":[{"linkId":"visible","ref":{"version":1,"source":"platform","type":"resource","id":"`+ids[1]+`"}},{"linkId":"hidden","ref":{"version":1,"source":"platform","type":"resource","id":"`+ids[0]+`"}}]}`)
			return
		}
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if claims.IdempotencyKey != r.Header.Get("Idempotency-Key") || !claims.CSRFVerified || claims.CSRFToken == user.csrf {
			t.Error("write claims")
		}
		if strings.HasSuffix(r.URL.Path, "/from-resource") {
			io.WriteString(w, `{"version":1,"revision":1,"linkId":"new-link","projectId":"p","taskId":"new-task","href":"/doska/projects/p?taskId=new-task"}`)
		} else {
			io.WriteString(w, `{"version":1,"revision":1,"linkId":"hidden"}`)
		}
	}))
	defer backend.Close()
	g, e := s.DoskaGateway(DoskaGatewayConfig{APIUpstream: backend.URL, WebUpstream: backend.URL, Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: catalogTestManifest(), Transport: http.DefaultTransport})
	if e != nil {
		t.Fatal(e)
	}
	call := func(method, path, body, key string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, s.Config.PublicURL+path, strings.NewReader(body))
		r.AddCookie(user.cookie)
		r.Header.Set("Origin", s.Config.PublicURL)
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", user.csrf)
		}
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s got%d want%d %s", method, path, w.Code, want, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("response headers")
		}
		return w
	}
	prefix := "/doska/api/doska/"
	for _, query := range []string{"projectId=p&q=Service&limit=51", "projectId=p&q=Service&q=other", "projectId=p&q=Service&private=x", "projectId=p&q=%20", "projectId=p&q=Service&cursor="} {
		call("GET", prefix+"catalog/search?"+query, "", "", 400)
	}
	call("GET", prefix+"projects/p/tasks/t/resource-links?q=x", "", "", 400)

	selection := `{"resourceId":"` + ids[1] + `","sourceKind":"platform"}`
	w := call("GET", prefix+"catalog/search?projectId=p&q=Service&limit=1", "", "", 200)
	var page struct {
		Items      []struct{ Selection catalogSelection }
		NextCursor *string
	}
	_ = json.Unmarshal(w.Body.Bytes(), &page)
	if len(page.Items) != 1 || page.Items[0].Selection.ResourceID != ids[1] || page.NextCursor == nil {
		t.Fatal("ACL before pagination", w.Body.String())
	}
	for _, private := range []string{"192.0.2", "private-", ids[0]} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("search leaked", w.Body.String())
		}
	}
	call("GET", prefix+"catalog/search?projectId=p&q=192.0.2.99", "", "", 200)
	w = call("GET", prefix+"projects/p/tasks/t/resource-links", "", "", 200)
	if strings.Contains(w.Body.String(), ids[0]) || strings.Contains(w.Body.String(), `"ref"`) || !strings.Contains(w.Body.String(), `{"linkId":"hidden","available":false}`) || strings.Contains(w.Body.String(), "platformHref") {
		t.Fatal("opaque projection", w.Body.String())
	}
	call("POST", prefix+"catalog/resolve", `{"projectId":"p","selections":[`+selection+`]}`, "", 200)
	call("POST", prefix+"catalog/task-links", `{"selection":`+selection+`,"cursor":null}`, "", 200)
	key := uuid.NewString()
	attach := `{"expectedRevision":0,"clientRequestId":"` + key + `","selection":` + selection + `}`
	call("POST", prefix+"projects/p/tasks/t/resource-links", attach, key, 200)
	backendMu.Lock()
	canonicalBody := lastBody
	backendMu.Unlock()
	if !strings.Contains(canonicalBody, `"ref"`) || strings.Contains(canonicalBody, "selection") {
		t.Fatal("not canonicalized", canonicalBody)
	}
	call("POST", prefix+"projects/p/tasks/t/resource-links", attach, key, 200)
	backendMu.Lock()
	storedKeys := append([]string(nil), keys...)
	backendMu.Unlock()
	if len(storedKeys) != 2 || storedKeys[0] != storedKeys[1] {
		t.Fatal("retry changed business key")
	}
	key = uuid.NewString()
	call("POST", prefix+"projects/p/tasks/from-resource", `{"expectedRevision":0,"clientRequestId":"`+key+`","selection":`+selection+`,"task":{"title":"Task","columnId":"c","description":null}}`, key, 200)
	key = uuid.NewString()
	call("DELETE", prefix+"projects/p/tasks/t/resource-links/hidden", `{"expectedRevision":0,"clientRequestId":"`+key+`"}`, key, 200)
	before := callCount()
	call("GET", prefix+"projects/p/resource-link-capabilities", "", "", 404)
	if callCount() != before {
		t.Fatal("internal capabilities exposed")
	}
	call("POST", prefix+"catalog/task-links", `{"selection":`+strings.Replace(selection, ids[1], ids[0], 1)+`}`, "", 404)
	setMode("unknown-key")
	call("GET", prefix+"projects/p/tasks/t/resource-links", "", "", 502)
	setMode("foreign-href")
	call("POST", prefix+"catalog/task-links", `{"selection":`+selection+`}`, "", 502)
	setMode("denied")
	call("GET", prefix+"catalog/search?projectId=p&q=Service", "", "", 404)
	setMode("timeout")
	before = callCount()
	call("POST", prefix+"catalog/task-links", `{"selection":`+selection+`}`, "", 503)
	if callCount() != before+1 {
		t.Fatal("unsafe retry")
	}
	setMode("revoked")
	call("GET", prefix+"projects/p/tasks/t/resource-links", "", "", 503)
	setMode("normal")
	w = call("GET", prefix+"projects/p/tasks/t/resource-links", "", "", 200)
	if strings.Contains(w.Body.String(), "descriptor") {
		t.Fatal("revocation stale descriptor")
	}
	setMode("logout")
	call("GET", prefix+"projects/p/tasks/t/resource-links", "", "", 401)
}

func TestDoskaCatalogNetBoxPolicyPostgreSQL(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	resource := model.Resource{ID: uuid.NewString(), Name: "Accepted", Lifecycle: "active"}
	integration := model.Integration{ID: uuid.NewString(), Kind: "netbox", Enabled: true}
	candidate := model.Candidate{ID: uuid.NewString(), IntegrationID: integration.ID, ExternalID: "dcim.device:42", ResourceID: resource.ID, State: "linked", Name: "Device", LastSeen: time.Now(), Inventory: &model.InventoryObject{Name: "Device", Kind: "device"}}
	resource.ExternalIDs = []string{integration.ID + ":" + candidate.ExternalID}
	for _, v := range []struct {
		kind, id string
		body     any
	}{{"resource", resource.ID, resource}, {"integration", integration.ID, integration}, {"candidate", candidate.ID, candidate}} {
		if _, e := s.Store.Save(ctx, v.kind, v.id, 0, v.body, "fixture"); e != nil {
			t.Fatal(e)
		}
	}
	g := &doskaGateway{server: s}
	p, e := g.catalogPolicy(ctx, model.User{Admin: true})
	if e != nil || len(p.Entries) != 2 {
		t.Fatalf("NetBox missing %v %#v", e, p.Entries)
	}
	sel := catalogSelection{resource.ID, "netbox"}
	entry := p.selection(sel)
	if entry == nil || entry.Ref.Source != "netbox/"+integration.ID || entry.Ref.ID != "42" {
		t.Fatal("wrong tuple")
	}
	employee, e := g.catalogPolicy(ctx, model.User{})
	if e != nil || employee.selection(sel) != nil {
		t.Fatal("employee inventory grant")
	}
	second := candidate
	second.ID = uuid.NewString()
	second.ExternalID = "virtualization.virtualmachine:17"
	second.Inventory = &model.InventoryObject{Name: "VM", Kind: "virtual_machine"}
	resource.ExternalIDs = append(resource.ExternalIDs, integration.ID+":"+second.ExternalID)
	saved, _ := store.Get[model.Resource](ctx, s.Store, "resource", resource.ID)
	if _, e = s.Store.Save(ctx, "resource", resource.ID, saved.Revision, resource, "fixture"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Store.Save(ctx, "candidate", second.ID, 0, second, "fixture"); e != nil {
		t.Fatal(e)
	}
	p, e = g.catalogPolicy(ctx, model.User{Admin: true})
	if e != nil || p.selection(sel) != nil {
		t.Fatal("ambiguous selector accepted")
	}
}
