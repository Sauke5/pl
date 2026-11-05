//go:build optional_module_acceptance

package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/organization"
	"pl/portal/internal/store"
)

// Opt-in real HTTP Gateway -> owner-started disposable Node API -> PostgreSQL.
// Same test-only subject as attachmentIdentity, never production login/state.
func TestDoskaCatalogGatewayExternal(t *testing.T) {
	if os.Getenv("DOSKA_CATALOG_TEST_ENABLE") != "1" {
		t.Fatal("owner-started disposable Doska catalog fixture required")
	}
	origin := func(raw string) *url.URL {
		t.Helper()
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Port() == "" || !net.ParseIP(u.Hostname()).IsLoopback() {
			t.Fatal("explicit loopback HTTP fixture required")
		}
		return u
	}
	type actor struct {
		ID      string `json:"id"`
		Subject string `json:"subject"`
		Name    string `json:"name"`
		Admin   bool   `json:"admin"`
		Access  string `json:"access"`
	}
	var metadata struct {
		Upstream         string  `json:"upstream"`
		GatewayKeyFile   string  `json:"gatewayKeyFile"`
		ControlTokenFile string  `json:"controlTokenFile"`
		Actors           []actor `json:"actors"`
		ProjectID        string  `json:"projectId"`
		HiddenProjectID  string  `json:"hiddenProjectId"`
	}
	metadataBytes, e := doskaReadFile(os.Getenv("DOSKA_CATALOG_TEST_METADATA"), 64<<10)
	if e != nil || json.Unmarshal(metadataBytes, &metadata) != nil {
		t.Fatal("test-only fixture metadata required")
	}
	api := origin(metadata.Upstream)
	public := origin(os.Getenv("DOSKA_TEST_PUBLIC_URL"))
	db, e := url.Parse(os.Getenv("PORTAL_TEST_DATABASE_URL"))
	if e != nil || (db.Scheme != "postgres" && db.Scheme != "postgresql") || !net.ParseIP(db.Hostname()).IsLoopback() || db.Path == "" {
		t.Fatal("separate loopback disposable Platform PostgreSQL required")
	}
	key, e := doskaReadFile(metadata.GatewayKeyFile, 32)
	if e != nil || len(key) != 32 {
		t.Fatal("test-only raw32 key required")
	}
	project := metadata.ProjectID
	if !catalogID.MatchString(project) || !catalogID.MatchString(metadata.HiddenProjectID) {
		t.Fatal("fixture project required")
	}
	s := apiFixture(t)
	s.Config.PublicURL = public.String()
	ctx := context.Background()
	users := map[string]apiIdentity{}
	for _, a := range metadata.Actors {
		parts := strings.Split(a.Subject, ":")
		if len(parts) != 3 || parts[0] != "ad" {
			t.Fatal("canonical fixture subject required")
		}
		guid, e := hex.DecodeString(parts[2])
		if e != nil || len(guid) != 16 {
			t.Fatal("fixture GUID required")
		}
		now := time.Now().UTC()
		_, e = organization.NewStore(s.Store.Pool).SaveEmployee(ctx, organization.EmployeeRecord{Identity: organization.Identity{Subject: a.Subject, Name: a.Name, AccountState: organization.Active, LastSuccessAt: now}, Provider: "ad", ProviderNamespace: parts[1], ObjectGUID: guid}, 0, "catalog-fixture", now)
		if e != nil {
			t.Fatal(e)
		}
		// A technical Platform administrator still has no right to a foreign project.
		users[a.ID] = apiUser(t, s, a.Subject, a.Admin || a.Access == "none")
	}
	user, ok := users["fixture-employee"]
	if !ok {
		t.Fatal("employee fixture required")
	}

	id := uuid.NewString()
	if _, e = s.Store.Save(ctx, "resource", id, 0, model.Resource{ID: id, Name: "Catalog cross-app fixture", Lifecycle: "active", Employee: &model.EmployeeMetadata{DisplayName: "Fixture service"}}, "fixture"); e != nil {
		t.Fatal(e)
	}
	settings, e := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	if e != nil {
		t.Fatal(e)
	}
	settings.BoardEnabled = true
	settings.BoardResourceIDs = []string{id}
	if _, e = s.Store.Save(ctx, "settings", "global", settings.Revision, settings, "fixture"); e != nil {
		t.Fatal(e)
	}
	manifest := catalogTestManifest()
	if path := os.Getenv("DOSKA_CATALOG_TEST_MANIFEST_FILE"); path != "" {
		raw, e := doskaReadFile(path, 512<<10)
		if e != nil || catalogJSON(raw, &manifest) != nil {
			t.Fatal("candidate manifest required")
		}
	}
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: api.String(), WebUpstream: api.String(), Key: key, Manifest: manifest, Transport: &http.Transport{Proxy: nil, DisableCompression: true, ResponseHeaderTimeout: 5 * time.Second}})
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", public.Host)
	if e != nil {
		t.Fatal(e)
	}
	gateway := httptest.NewUnstartedServer(g)
	gateway.Listener.Close()
	gateway.Listener = listener
	gateway.Start()
	t.Cleanup(gateway.Close)
	client := &http.Client{Timeout: 10 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	call := func(method, path string, body any, key string, want int) []byte {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		r, e := http.NewRequest(method, public.String()+path, bytes.NewReader(raw))
		if e != nil {
			t.Fatal(e)
		}
		r.AddCookie(user.cookie)
		r.Header.Set("Origin", public.String())
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", user.csrf)
		}
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		response, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		data, e := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		if e != nil || response.StatusCode != want {
			t.Fatalf("%s %s got%d want%d: %.1000s %v", method, path, response.StatusCode, want, data, e)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cache headers")
		}
		return data
	}
	prefix := "/doska/api/doska/"
	resourceSearchGate := os.Getenv("DOSKA_RESOURCE_SEARCH_TEST_ENABLE") == "1"
	if os.Getenv("DOSKA_CATALOG_TEST_MANIFEST_FILE") != "" {
		call("GET", prefix+"overview?limit=1&offset=0", nil, "", 200)
		call("GET", prefix+"task-search?projectId="+project+"&open=true&upcoming=true&labelName=fixture&customFieldId=fixture&customFieldValue=value", nil, "", 200)
	}

	selection := catalogSelection{id, "platform"}
	search := call("GET", prefix+"catalog/search?projectId="+project+"&q=Fixture", nil, "", 200)
	if !bytes.Contains(search, []byte(id)) {
		t.Fatal("search missing public selection")
	}
	call("POST", prefix+"catalog/resolve", map[string]any{"projectId": project, "selections": []catalogSelection{selection}}, "", 200)
	requestID := uuid.NewString()
	create := map[string]any{"selection": selection, "expectedRevision": 0, "clientRequestId": requestID, "task": map[string]any{"title": "Cross-app resource task", "description": nil, "priority": "medium"}}
	raw := call("POST", prefix+"projects/"+project+"/tasks/from-resource", create, requestID, 200)
	var created catalogCreateResult
	if catalogJSON(raw, &created) != nil || created.ProjectID != project || created.Revision == nil || *created.Revision != 1 {
		t.Fatal("create result")
	}
	retry := call("POST", prefix+"projects/"+project+"/tasks/from-resource", create, requestID, 200)
	if !bytes.Equal(raw, retry) {
		t.Fatal("create idempotency replay changed result")
	}
	taskPath := prefix + "projects/" + project + "/tasks/" + created.TaskID + "/resource-links"

	resourceQuery := prefix + "task-search?projectId=" + project + "&resourceId=" + id + "&sourceKind=platform"
	checkResourceSearch := func(suffix, wantTask string) {
		t.Helper()
		data := call("GET", resourceQuery+suffix, nil, "", 200)
		var tasks []struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(data, &tasks) != nil || tasks == nil {
			t.Fatal("resource task-search changed MyTask[]")
		}
		if wantTask == "" {
			if len(tasks) != 0 {
				t.Fatal("resource task-search filter/offset failed")
			}
		} else if len(tasks) != 1 || tasks[0].ID != wantTask {
			t.Fatal("resource task-search missing linked task")
		}
	}
	if resourceSearchGate {
		checkResourceSearch("&limit=1&offset=0", created.TaskID)
		checkResourceSearch("&limit=1&offset=1", "")
		checkResourceSearch("&q=Cross-app", created.TaskID)
		checkResourceSearch("&q=not-matching-resource-task", "")
		for _, query := range []string{"resourceSource=platform", "resourceType=resource", "resourceObjectId=" + id, "resourceId=" + id, "sourceKind=platform"} {
			call("GET", prefix+"task-search?projectId="+project+"&"+query, nil, "", 404)
		}
	}
	links := call("GET", taskPath, nil, "", 200)
	if bytes.Contains(links, []byte(`"ref"`)) || bytes.Contains(links, []byte(id)) || !bytes.Contains(links, []byte("Fixture service")) {
		t.Fatal("descriptor projection")
	}
	refs := call("POST", prefix+"catalog/task-links", map[string]any{"selection": selection, "limit": 20, "cursor": nil}, "", 200)
	if !bytes.Contains(refs, []byte(catalogTaskHref(project, created.TaskID))) {
		t.Fatal("backref missing actual created task")
	}

	// Observer reads and cross-project filtering use real Node ACL, not gateway role guesses.
	user = users["fixture-observer"]
	call("GET", taskPath, nil, "", 200)
	if resourceSearchGate {
		checkResourceSearch("", created.TaskID)
	}
	observerKey := uuid.NewString()
	call("POST", taskPath, map[string]any{"selection": selection, "expectedRevision": 1, "clientRequestId": observerKey}, observerKey, 404)
	user = users["fixture-denied"]
	call("GET", taskPath, nil, "", 404)
	if resourceSearchGate {
		call("GET", resourceQuery, nil, "", 404)
	}
	hiddenKey := uuid.NewString()
	hidden := map[string]any{"selection": selection, "expectedRevision": 0, "clientRequestId": hiddenKey, "task": map[string]any{"title": "Hidden resource task"}}
	call("POST", prefix+"projects/"+metadata.HiddenProjectID+"/tasks/from-resource", hidden, hiddenKey, 200)
	user = users["fixture-employee"]
	if resourceSearchGate {
		call("GET", prefix+"task-search?projectId="+metadata.HiddenProjectID+"&resourceId="+id+"&sourceKind=platform", nil, "", 404)
	}
	refs = call("POST", prefix+"catalog/task-links", map[string]any{"selection": selection, "limit": 1}, "", 200)
	if bytes.Contains(refs, []byte(metadata.HiddenProjectID)) || bytes.Contains(refs, []byte("Hidden resource task")) {
		t.Fatal("backrefs leaked hidden project")
	}
	staleKey := uuid.NewString()
	call("POST", taskPath, map[string]any{"selection": selection, "expectedRevision": 0, "clientRequestId": staleKey}, staleKey, 409)
	changed := map[string]any{"selection": selection, "expectedRevision": 0, "clientRequestId": requestID, "task": map[string]any{"title": "Changed body"}}
	conflict := call("POST", prefix+"projects/"+project+"/tasks/from-resource", changed, requestID, 409)
	if !bytes.Contains(conflict, []byte("idempotency_conflict")) {
		t.Fatal("idempotency conflict code lost")
	}
	// Real backend identity revocation must deny a still-active Platform session.
	controlToken, e := doskaReadFile(metadata.ControlTokenFile, 4096)
	if e != nil {
		t.Fatal("test-only control token required")
	}
	control := func(name string) {
		t.Helper()
		r, _ := http.NewRequest("POST", api.String()+"/__fixture/"+name, nil)
		r.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(controlToken)))
		resp, e := client.Do(r)
		if e != nil {
			t.Fatal("fixture control failed")
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatal("fixture control rejected")
		}
	}
	user = users["fixture-revocable"]
	call("GET", taskPath, nil, "", 200)
	control("revoke")
	call("GET", taskPath, nil, "", 403)
	control("restore")
	user = users["fixture-employee"]
	// A revoked resource becomes opaque; detaching that opaque link remains allowed.
	currentSettings, e := store.Get[model.Settings](ctx, s.Store, "settings", "global")
	if e != nil {
		t.Fatal(e)
	}
	currentSettings.BoardResourceIDs = []string{}
	b, e := s.Store.Save(ctx, "settings", "global", currentSettings.Revision, currentSettings, "fixture")
	if e != nil {
		t.Fatal(e)
	}
	currentSettings, _ = store.Decode[model.Settings](b)
	opaque := call("GET", taskPath, nil, "", 200)
	if bytes.Contains(opaque, []byte("descriptor")) {
		t.Fatal("resource revocation retained descriptor")
	}
	call("POST", prefix+"catalog/task-links", map[string]any{"selection": selection}, "", 404)
	if resourceSearchGate {
		call("GET", resourceQuery, nil, "", 404)
	}
	requestID = uuid.NewString()
	call("DELETE", taskPath+"/"+created.LinkID, map[string]any{"expectedRevision": 1, "clientRequestId": requestID}, requestID, 200)
	currentSettings.BoardResourceIDs = []string{id}
	if _, e = s.Store.Save(ctx, "settings", "global", currentSettings.Revision, currentSettings, "fixture"); e != nil {
		t.Fatal(e)
	}
	refs = call("POST", prefix+"catalog/task-links", map[string]any{"selection": selection}, "", 200)
	if bytes.Contains(refs, []byte(created.TaskID)) {
		t.Fatal("detached task remained in backrefs")
	}
	if resourceSearchGate {
		checkResourceSearch("", "")
	}
	call("GET", prefix+"projects/"+project+"/resource-link-capabilities", nil, "", 404)
	t.Log("actual Node/PostgreSQL search/resolve/create+link/replay/CAS/observer/technical-admin/hidden-backrefs/backend-revoke/opaque-detach PASS")
}
