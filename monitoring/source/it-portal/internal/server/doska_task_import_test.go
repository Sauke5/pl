package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func importManifest() DoskaGatewayManifest {
	m := doskaGatewayTestManifest()
	m.Routes = append(m.Routes, DoskaGatewayRoute{Method: "POST", Path: doskaTaskImportPath, Kind: "write", Schema: doskaTaskImportSchema})
	return m
}
func importBody(n int) []byte {
	tasks := make([]string, n)
	for i := range tasks {
		tasks[i] = `{"title":"Задача"}`
	}
	return []byte(`{"clientRequestId":"75c019d5-533d-4c3b-926a-55309f261da6","tasks":[` + strings.Join(tasks, ",") + `]}`)
}
func TestDoskaTaskImportStrictRequest(t *testing.T) {
	for _, n := range []int{0, 1, 500, 501} {
		if _, ok := doskaTaskImportRequest(importBody(n)); ok != (n >= 1 && n <= 500) {
			t.Fatalf("tasks %d accepted %v", n, ok)
		}
	}
	for _, task := range []string{`{"title":"ok","columnId":null}`, `{"title":"ok","description":5}`, `{"title":"ok","labels":null}`, `{"title":"ok","coexecutorIds":null}`, `{"title":"ok","priority":"bad"}`, `{"title":"ok","cardColor":"#ffffff"}`, `{"title":"ok","startDate":"2026-02-30"}`, `{"title":"ok","due":{"date":"2026-10-26","time":"24:00"}}`, `{"title":"ok","coexecutorIds":["ad:a","ad:a"]}`, `{"title":"ok","unknown":true}`, `{"Title":"ok"}`, `{"title":"ok","title":"dup"}`, `{"title":" "}`, `{"title":"ok","customValues":[{"fieldId":"f"}]}`, `{"title":"ok","labels":[{"name":"x","color":"black"}]}`} {
		b := bytes.Replace(importBody(1), []byte(`{"title":"Задача"}`), []byte(task), 1)
		if _, ok := doskaTaskImportRequest(b); ok {
			t.Fatalf("accepted invalid %s", task)
		}
	}
	for _, task := range []string{`{"title":" ok ","description":null,"parentTaskId":null,"userId":null,"cardColor":null,"startDate":null,"due":null}`, `{"title":"ok","columnId":"p","priority":"urgent","coexecutorIds":["ad:a"],"labels":[{"name":"x","color":"#aAbBcC"}],"customValues":[{"fieldId":"f","value":null}],"due":{"date":"2026-10-26","time":"23:59"}}`} {
		if _, ok := doskaTaskImportRequest(bytes.Replace(importBody(1), []byte(`{"title":"Задача"}`), []byte(task), 1)); !ok {
			t.Fatalf("rejected %s", task)
		}
	}
	for _, bad := range []string{`{"clientRequestId":"bad","tasks":[{"title":"x"}]}`, `{"clientRequestId":null,"tasks":[{"title":"x"}]}`, `{"clientRequestId":"75c019d5-533d-4c3b-926a-55309f261da6","tasks":[{"title":"x"}],"extra":1}`} {
		if _, ok := doskaTaskImportRequest([]byte(bad)); ok {
			t.Fatal("accepted invalid envelope")
		}
	}
}
func TestDoskaTaskImportStrictResponse(t *testing.T) {
	for _, body := range []string{`{"taskIds":["x"],"imported":1,"replayed":false}`, `{"taskIds":["x"],"imported":1,"replayed":true}`} {
		if !doskaTaskImportResponse(201, 1, []byte(body)) {
			t.Fatal(body)
		}
	}
	for _, body := range []string{`{"taskIds":["x"],"imported":1,"replayed":false,"extra":1}`, `{"taskIds":["x"],"imported":2,"replayed":false}`, `{"taskIds":null,"imported":1,"replayed":false}`, `{"taskIds":["x"],"imported":"1","replayed":false}`, `{"taskIds":["x"],"imported":1,"Replayed":false}`, `{"taskIds":["x"],"imported":1,"replayed":null}`, `{"taskIds":["x"],"imported":1,"replayed":false,"replayed":true}`} {
		if doskaTaskImportResponse(201, 1, []byte(body)) {
			t.Fatal("accepted " + body)
		}
	}
	for _, status := range []int{200, 204, 302} {
		if doskaTaskImportResponse(status, 1, []byte(`{}`)) {
			t.Fatal(status)
		}
	}
}
func TestDoskaTaskImportManifest(t *testing.T) {
	if _, e := compileDoskaManifest(importManifest()); e != nil {
		t.Fatal(e)
	}
	for _, r := range []DoskaGatewayRoute{{Method: "POST", Path: doskaTaskImportPath, Kind: "write"}, {Method: "GET", Path: doskaTaskImportPath, Kind: "read", Schema: doskaTaskImportSchema}, {Method: "POST", Path: "/doska/api/doska/other", Kind: "write", Schema: doskaTaskImportSchema}, {Method: "POST", Path: doskaTaskImportPath, Kind: "write", Schema: doskaTaskImportSchema, Query: map[string]DoskaGatewayQuery{"q": {Kind: "text"}}}} {
		if _, e := compileDoskaManifest(DoskaGatewayManifest{Version: "test", Routes: []DoskaGatewayRoute{r}}); e == nil {
			t.Fatalf("accepted %+v", r)
		}
	}
}
func TestDoskaTaskImportFixture(t *testing.T) {
	raw, e := os.ReadFile("testdata/doska-task-import-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		PublicPath    string `json:"publicPath"`
		MaxBodyBytes  int    `json:"maxBodyBytes"`
		MaxTasks      int    `json:"maxTasks"`
		RequestSchema struct {
			Properties struct {
				Tasks struct {
					Items struct {
						Properties map[string]any `json:"properties"`
					} `json:"items"`
				} `json:"tasks"`
			} `json:"properties"`
		} `json:"requestSchema"`
	}
	if json.Unmarshal(raw, &f) != nil || f.PublicPath != doskaTaskImportPath || f.MaxBodyBytes != doskaTaskImportLimit || f.MaxTasks != 500 {
		t.Fatal("fixture drift")
	}
	for key := range f.RequestSchema.Properties.Tasks.Items.Properties {
		task := map[string]any{"title": "x", key: nil}
		data, _ := json.Marshal(map[string]any{"clientRequestId": "75c019d5-533d-4c3b-926a-55309f261da6", "tasks": []any{task}})
		_, ok := doskaTaskImportRequest(data)
		nullable := strings.Contains(" description parentTaskId userId cardColor startDate due ", " "+key+" ")
		if ok != nullable {
			t.Fatalf("nullability %s=%v", key, ok)
		}
	}
}
func TestDoskaTaskImportTransportDeadline(t *testing.T) {
	s := &Server{Config: Config{PublicURL: "https://portal.example.test"}}
	base := &http.Transport{ResponseHeaderTimeout: 30 * time.Second}
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://api.test", WebUpstream: "http://web.test", Key: attachmentTestKey, Manifest: importManifest(), Transport: base})
	if e != nil {
		t.Fatal(e)
	}
	clone := g.importTransport.(*http.Transport)
	if clone == base || clone.ResponseHeaderTimeout != 60*time.Second || base.ResponseHeaderTimeout != 30*time.Second {
		t.Fatal("transport timeout isolation")
	}
}
func TestDoskaTaskImportPostgreSQLHTTP(t *testing.T) {
	s := apiFixture(t)
	user, _ := attachmentIdentity(t, s)
	calls := 0
	responseBody := `{"taskIds":["t"],"imported":1,"replayed":false}`
	responseStatus := 201
	tr := directoryRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		body, _ := io.ReadAll(r.Body)
		digest := sha256.Sum256(body)
		var claims gatewayIdentity
		data, _ := base64.RawURLEncoding.DecodeString(r.Header.Get(gatewayAssertionHeader))
		_ = json.Unmarshal(data, &claims)
		if claims.BodySHA256 != hex.EncodeToString(digest[:]) || claims.URI != "/doska"+r.URL.RequestURI() || !claims.CSRFVerified || claims.CSRFToken == user.csrf || r.Header.Get(gatewaySignatureHeader) != gatewayMAC(attachmentTestKey, "pl-gateway-v2\n"+r.Header.Get(gatewayAssertionHeader)) {
			t.Error("signed actual body/SSO/CSRF mismatch")
		}
		if strings.HasSuffix(r.URL.Path, "task-imports") {
			d, ok := r.Context().Deadline()
			if !ok || time.Until(d) > 60*time.Second || time.Until(d) < 55*time.Second {
				t.Error("import deadline")
			}
		}
		return &http.Response{StatusCode: responseStatus, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(responseBody))}, nil
	})
	g, e := s.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://api.test", WebUpstream: "http://web.test", Key: attachmentTestKey, Manifest: importManifest(), Transport: tr})
	if e != nil {
		t.Fatal(e)
	}
	send := func(path string, body []byte, auth, csrf bool) int {
		r := httptest.NewRequest("POST", s.Config.PublicURL+path, bytes.NewReader(body))
		if auth {
			r.AddCookie(user.cookie)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", s.Config.PublicURL)
		if csrf {
			r.Header.Set("X-CSRF-Token", user.csrf)
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		return w.Code
	}
	path := "/doska/api/doska/projects/p1/task-imports"
	big := append(importBody(1), bytes.Repeat([]byte(" "), doskaTaskImportLimit-len(importBody(1)))...)
	for _, tc := range []struct {
		name, path string
		body       []byte
		auth, csrf bool
		status     int
	}{{"exact3MiB", path, big, true, true, 201}, {"oversize", path, append(append([]byte{}, big...), ' '), true, true, 413}, {"anonymous", path, importBody(1), false, true, 401}, {"CSRF", path, importBody(1), true, false, 403}, {"unknown", "/doska/api/doska/projects/p1/task-imports/other", importBody(1), true, true, 404}, {"501", path, importBody(501), true, true, 400}, {"generic128KiB", "/doska/api/doska/projects", bytes.Repeat([]byte(" "), (128<<10)+1), true, true, 413}} {
		t.Run(tc.name, func(t *testing.T) {
			if got := send(tc.path, tc.body, tc.auth, tc.csrf); got != tc.status {
				t.Fatalf("status %d want %d", got, tc.status)
			}
		})
	}
	if calls != 1 {
		t.Fatalf("rejections reached upstream %d", calls)
	}

	ids := make([]string, 500)
	for i := range ids {
		ids[i] = fmt.Sprintf("t%d", i)
	}
	many, _ := json.Marshal(map[string]any{"taskIds": ids, "imported": 500, "replayed": false})
	responseBody = string(many)
	if got := send(path, importBody(500), true, true); got != 201 {
		t.Fatal("500 tasks", got)
	}
	generic := append([]byte(`{}`), bytes.Repeat([]byte(" "), (128<<10)-2)...)
	if got := send("/doska/api/doska/projects", generic, true, true); got != 201 {
		t.Fatal("generic inclusive128KiB", got)
	}
	responseBody = `{"taskIds":["t"],"imported":1,"replayed":false,"extra":true}`
	if got := send(path, importBody(1), true, true); got != 502 {
		t.Fatal(got)
	}
	responseBody = `{"taskIds":["t"],"imported":1,"replayed":true}`
	if got := send(path, importBody(1), true, true); got != 201 {
		t.Fatal(got)
	}
	responseStatus = 200
	if got := send(path, importBody(1), true, true); got != 502 {
		t.Fatal(got)
	}
	// A canceled client stops this HTTP wait, but says nothing about a remote DB
	// transaction. The client must reconcile using the same UUID and frozen body.
	g.importTransport = directoryRoundTrip(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })
	r := httptest.NewRequest("POST", s.Config.PublicURL+path, bytes.NewReader(importBody(1)))
	r.AddCookie(user.cookie)
	r.Header.Set("Origin", s.Config.PublicURL)
	r.Header.Set("X-CSRF-Token", user.csrf)
	r.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithTimeout(r.Context(), 100*time.Millisecond)
	defer cancel()
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r.WithContext(ctx))
	if w.Code != 502 {
		t.Fatal(fmt.Sprint(w.Code))
	}
}

func TestDoskaTaskImportKnownFieldBounds(t *testing.T) {
	for _, tc := range []struct {
		field string
		value any
		ok    bool
	}{
		{"title", strings.Repeat("😀", 250), true}, {"title", strings.Repeat("😀", 251), false},
		{"title", "\ufeff", false}, {"title", "\u0085", true},
		{"description", strings.Repeat("x", 100000), true}, {"description", strings.Repeat("x", 100001), false},
		{"columnId", strings.Repeat("a", 129), false}, {"columnId", "ad:abc", false}, {"userId", "ad:abc", true},
		{"due", map[string]any{"date": "2026-10-26", "time": nil}, false}, {"due", map[string]any{"date": "2026-10-26", "unknown": true}, false},
		{"coexecutorIds", []any{1}, false}, {"labels", []any{map[string]any{"name": "x", "color": "blue"}, map[string]any{"name": " x ", "color": "red"}}, false},
		{"customValues", []any{map[string]any{"fieldId": "f", "value": nil}, map[string]any{"fieldId": "f", "value": "x"}}, false},
	} {
		task := map[string]any{"title": "x", tc.field: tc.value}
		data, _ := json.Marshal(map[string]any{"clientRequestId": "75c019d5-533d-4c3b-926a-55309f261da6", "tasks": []any{task}})
		if _, ok := doskaTaskImportRequest(data); ok != tc.ok {
			t.Fatalf("%s accepted%v want%v", tc.field, ok, tc.ok)
		}
	}
	for _, field := range []string{"labels", "customValues", "coexecutorIds"} {
		var a []any
		limit := 100
		if field == "labels" {
			limit = 20
		}
		for i := 0; i <= limit; i++ {
			switch field {
			case "labels":
				a = append(a, map[string]any{"name": fmt.Sprint(i), "color": "blue"})
			case "customValues":
				a = append(a, map[string]any{"fieldId": fmt.Sprint(i), "value": nil})
			case "coexecutorIds":
				a = append(a, fmt.Sprint(i))
			}
		}
		task := map[string]any{"title": "x", field: a}
		if doskaImportTask(task) {
			t.Fatalf("accepted overlimit %s", field)
		}
		task[field] = a[:limit]
		if !doskaImportTask(task) {
			t.Fatalf("rejected inclusive %s", field)
		}
	}
}
