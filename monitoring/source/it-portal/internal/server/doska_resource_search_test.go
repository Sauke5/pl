package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"pl/portal/internal/model"
	"pl/portal/internal/organization"
	"pl/portal/internal/store"
	"strings"
	"testing"
	"time"
)

func resourceSearchTestManifest() DoskaGatewayManifest {
	m := catalogTestManifest()
	m.Routes = append(m.Routes, DoskaGatewayRoute{Method: "GET", Path: "/doska/api/doska/task-search", Kind: "read", Query: map[string]DoskaGatewayQuery{
		"projectId": {Kind: "id"}, "q": {Kind: "text"}, "resourceId": {Kind: "text", MaxBytes: 36}, "sourceKind": {Kind: "text", Enum: []string{"platform", "netbox"}},
		"resourceSource": {Kind: "text"}, "resourceType": {Kind: "text"}, "resourceObjectId": {Kind: "text"}, "ResourceId": {Kind: "text"},
	}})
	return m
}

func TestDoskaResourceSearchPostgreSQLHTTP(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	guid := make([]byte, 16)
	guid[15] = 83
	subject, _ := organization.ADSubject("dc=resource-search,dc=test", guid)
	_, err := organization.NewStore(s.Store.Pool).SaveEmployee(ctx, organization.EmployeeRecord{Identity: organization.Identity{Subject: subject, Name: "Search actor", AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: strings.Split(subject, ":")[1], ObjectGUID: guid}, 0, "test", now)
	if err != nil {
		t.Fatal(err)
	}
	user := apiUser(t, s, subject, false)
	id := "11111111-1111-4111-8111-111111111111"
	if _, err = s.Store.Save(ctx, "resource", id, 0, model.Resource{ID: id, Name: "Service", Lifecycle: "active"}, "fixture"); err != nil {
		t.Fatal(err)
	}
	settings, _ := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{id}
	save := func() {
		t.Helper()
		b, e := s.Store.Save(ctx, "settings", "global", settings.Revision, settings, "fixture")
		if e != nil {
			t.Fatal(e)
		}
		settings, _ = store.Decode[model.Settings](b)
	}
	save()
	mode := "normal"
	searches := 0
	capabilities := 0
	lastQuery := ""
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		raw, _ := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
		var claims gatewayIdentity
		_ = json.Unmarshal(raw, &claims)
		if claims.URI != "/doska"+r.URL.RequestURI() || r.Header.Get(gatewaySignatureHeader) != gatewayMAC([]byte("0123456789abcdef0123456789abcdef"), "pl-gateway-v2\n"+r.Header.Get(gatewayAssertionHeader)) {
			t.Error("exact transformed URI not signed")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("browser credentials forwarded")
		}
		if strings.HasSuffix(r.URL.Path, "/resource-link-capabilities") {
			capabilities++
			if mode == "denied" {
				io.WriteString(w, `{"version":1,"readContent":false,"workOnTasks":false}`)
			} else {
				io.WriteString(w, `{"version":1,"readContent":true,"workOnTasks":false}`)
			}
			return
		}
		searches++
		lastQuery = r.URL.RawQuery
		if mode == "revoked" {
			settings.BoardResourceIDs = nil
			save()
		}
		if mode == "logout" {
			_, _ = s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", subject)
		}
		if mode == "error" {
			w.WriteHeader(404)
			io.WriteString(w, `{"resourceSource":"private"}`)
			return
		}
		if mode == "leak" {
			io.WriteString(w, `[{"resourceSource":"private"}]`)
			return
		}
		if mode == "redirect" {
			w.Header().Set("Location", "/api/doska/task-search?resourceSource=platform")
			w.WriteHeader(302)
			return
		}
		w.Header().Set("Set-Cookie", "private=x")
		w.Header().Set("Content-Disposition", "private-ref")
		if mode == "large" {
			io.WriteString(w, `[{"id":"t","description":"`+strings.Repeat("x", (1<<20)+5)+`"}]`)
			return
		}
		io.WriteString(w, `[{"id":"t","title":"Task"}]`)
	}))
	defer backend.Close()
	g, err := s.DoskaGateway(DoskaGatewayConfig{APIUpstream: backend.URL, WebUpstream: backend.URL, Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: resourceSearchTestManifest(), Transport: http.DefaultTransport})
	if err != nil {
		t.Fatal(err)
	}
	call := func(query string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", s.Config.PublicURL+"/doska/api/doska/task-search?"+query, nil)
		r.AddCookie(user.cookie)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("query %s got%d want%d %s", query, w.Code, want, w.Body.String())
		}
		if w.Header().Get("Set-Cookie") != "" {
			t.Fatal("cookie leak")
		}
		return w
	}
	pair := "projectId=p&resourceId=" + id + "&sourceKind=platform"
	call(pair+"&q=old", 200)
	if searches != 1 || capabilities < 2 || lastQuery != "projectId=p&q=old&resourceObjectId="+id+"&resourceSource=platform&resourceType=resource" {
		t.Fatalf("typed search missing: searches%d caps%d query%s", searches, capabilities, lastQuery)
	}
	for _, q := range []string{"resourceSource=platform", "resourceType=resource", "resourceObjectId=" + id, "ResourceId=" + id, pair + "&resourceSource=platform", pair + "&resourceId=" + id, "projectId=p&resourceId=" + id, "resourceId=" + id + "&sourceKind=platform", "projectId=p&resourceId=" + id + "&sourceKind=netbox"} {
		before := searches
		call(q, 404)
		if searches != before {
			t.Fatal("rejected selector reached upstream")
		}
	}
	for _, m := range []struct {
		mode   string
		status int
	}{{"denied", 404}, {"error", 404}, {"leak", 502}, {"redirect", 502}, {"large", 200}, {"revoked", 503}} {
		mode = m.mode
		w := call(pair, m.status)
		if w.Header().Get("Location") != "" || w.Header().Get("Content-Disposition") != "" || strings.Contains(w.Body.String(), "resourceSource") {
			t.Fatal("internal response leaked")
		}
	}
	mode = "normal"
	before := capabilities
	call("projectId=p&q=old", 200)
	if capabilities != before || lastQuery != "projectId=p&q=old" {
		t.Fatal("generic task-search changed")
	}
	settings.BoardResourceIDs = []string{id}
	save()
	mode = "logout"
	call(pair, 401)

}

func TestDoskaResourceSearchInput(t *testing.T) {
	const pair = "projectId=p&resourceId=abcdef12-1234-4234-8234-abcdefabcdef&sourceKind=platform"
	for _, raw := range []string{
		"resourceId=abcdef12-1234-4234-8234-abcdefabcdef", "sourceKind=platform",
		strings.Replace(pair, "abcdef12", "ABCDEF12", 1), pair + "&sourceKind=platform", pair + "&projectId=p",
		strings.Replace(pair, "sourceKind", "SourceKind", 1), strings.Replace(pair, "projectId", "ProjectId", 1),
		pair + "&%72esourceSource=platform", pair + "&ResourceObjectId=1", pair + "&resourceType=resource",
	} {
		if _, e := doskaResourceSearchInput(httptest.NewRequest("GET", doskaTaskSearchPath+"?"+raw, nil)); e == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, method := range []string{"HEAD", "POST"} {
		if _, e := doskaResourceSearchInput(httptest.NewRequest(method, doskaTaskSearchPath+"?"+pair, nil)); e == nil {
			t.Fatal("unexpected method")
		}
	}
	r := httptest.NewRequest("GET", doskaTaskSearchPath+"?"+pair+"&q=a%2Bb&labelName=old", nil)
	in, e := doskaResourceSearchInput(r)
	if e != nil {
		t.Fatal(e)
	}
	in.ref = catalogRef{1, "netbox/11111111-1111-4111-8111-111111111111", "dcim.device", "42"}
	in.rewrite(r)
	q := r.URL.Query()
	if q.Get("q") != "a+b" || q.Get("labelName") != "old" || q.Get("resourceSource") != in.ref.Source || q.Get("resourceObjectId") != "42" || q.Has("resourceId") || q.Has("sourceKind") {
		t.Fatal("query rewrite")
	}
}

func TestDoskaResourceSearchNetBoxPolicyPostgreSQL(t *testing.T) {
	s := apiFixture(t)
	ctx := context.Background()
	resource := model.Resource{ID: "11111111-1111-4111-8111-111111111111", Name: "Accepted", Lifecycle: "active", ExternalIDs: []string{"22222222-2222-4222-8222-222222222222:dcim.device:42"}}
	integration := model.Integration{ID: "22222222-2222-4222-8222-222222222222", Kind: "netbox", Enabled: true}
	candidate := model.Candidate{ID: "33333333-3333-4333-8333-333333333333", IntegrationID: integration.ID, ExternalID: "dcim.device:42", ResourceID: resource.ID, State: "linked", Inventory: &model.InventoryObject{Name: "Device"}}
	for _, v := range []struct {
		kind, id string
		body     any
	}{{"resource", resource.ID, resource}, {"integration", integration.ID, integration}, {"candidate", candidate.ID, candidate}} {
		if _, e := s.Store.Save(ctx, v.kind, v.id, 0, v.body, "fixture"); e != nil {
			t.Fatal(e)
		}
	}
	calls := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"version":1,"readContent":true,"workOnTasks":false}`)
	}))
	defer backend.Close()
	upstream, _ := url.Parse(backend.URL)
	g := &doskaGateway{server: s, apiUpstream: upstream, transport: http.DefaultTransport, config: DoskaGatewayConfig{Key: []byte("0123456789abcdef0123456789abcdef")}}
	sess := session{User: model.User{ID: "admin", Name: "Admin", Admin: true}, CSRF: "test", ExpiresAt: time.Now().Add(time.Hour)}
	r := httptest.NewRequest("GET", doskaTaskSearchPath+"?projectId=p&resourceId="+resource.ID+"&sourceKind=netbox", nil)
	in, _ := doskaResourceSearchInput(r)
	if e := g.prepareResourceSearch(r, sess, in); e != nil || in.ref.Source != "netbox/"+integration.ID || in.ref.Type != "dcim.device" || in.ref.ID != "42" {
		t.Fatalf("canonical ref %v %#v", e, in)
	}
	// A browser selection grants nothing to an employee, even when published.
	settings, _ := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{resource.ID}
	if _, e := s.Store.Save(ctx, "settings", "global", settings.Revision, settings, "fixture"); e != nil {
		t.Fatal(e)
	}
	employee := sess
	employee.User.Admin = false
	before := calls
	if e := g.prepareResourceSearch(r, employee, in); e == nil || calls != before {
		t.Fatal("employee NetBox selection accepted")
	}
	current, _ := store.Get[model.Integration](ctx, s.Store, "integration", integration.ID)
	current.Enabled = false
	if _, e := s.Store.Save(ctx, "integration", current.ID, current.Revision, current, "fixture"); e != nil {
		t.Fatal(e)
	}
	if e := g.prepareResourceSearch(r, sess, in); e == nil || calls != before {
		t.Fatal("disabled integration accepted")
	}
	// Deleting policy makes access unavailable instead of using the earlier ref.
	if _, e := s.Store.Pool.Exec(ctx, "DELETE FROM documents WHERE kind='settings'"); e != nil {
		t.Fatal(e)
	}
	platform := &doskaResourceSearch{project: "p", selection: catalogSelection{resource.ID, "platform"}}
	if e := g.prepareResourceSearch(r, employee, platform); e == nil || calls != before {
		t.Fatal("policy failure did not close")
	}
}

func TestDoskaResourceSearchResponse(t *testing.T) {
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`[{"id":"t","title":"resourceSource netbox/example dcim.device", "description":"literal ref"}]`, true},
		{`[{"nested": [ {"resourceSource":"netbox/private"} ]}]`, false},
		{`[{"nested":{"ResourceObjectId":"1"}}]`, false},
		{`[{"ref":{"source":"platform"}}]`, false},
		{`null`, false}, {`{}`, false}, {`[null]`, false}, {`[]`, true},
	} {
		response := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}, "Content-Disposition": []string{"private"}}}
		if e := resourceSearchResponse(response, []byte(tc.body)); (e == nil) != tc.valid {
			t.Fatalf("body %s valid%v error%v", tc.body, tc.valid, e)
		}
		if tc.valid && len(response.Header) != 1 {
			t.Fatal("unexpected upstream header retained")
		}
	}
}
