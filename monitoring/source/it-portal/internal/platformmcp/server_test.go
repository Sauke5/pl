package platformmcp

import (
	"context"
	"encoding/json"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testID = "19cb742a-abdc-4dd4-9a7e-688b21646c45"

func fixture(t *testing.T, h http.HandlerFunc, write bool) (*mcp.ClientSession, *Client) {
	t.Helper()
	ts := httptest.NewTLSServer(h)
	t.Cleanup(ts.Close)
	file := filepath.Join(t.TempDir(), "token")
	if e := os.WriteFile(file, []byte(strings.Repeat("x", 43)), 0600); e != nil {
		t.Fatal(e)
	}
	c, e := NewClient(ts.URL, file)
	if e != nil {
		t.Fatal(e)
	}
	c.http = ts.Client()
	c.http.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	server := NewServer(c, write)
	st, ct := mcp.NewInMemoryTransports()
	ss, e := server.Connect(context.Background(), st, nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { ss.Close() })
	cs, e := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(context.Background(), ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cs.Close() })
	return cs, c
}
func TestMCPReadOnlyAndCatalogUpdate(t *testing.T) {
	puts := 0
	h := func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("x", 43) || r.Header.Get("Cookie") != "" {
			t.Error("wrong auth")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/v1/search":
			json.NewEncoder(w).Encode([]any{map[string]any{"id": testID, "name": "App"}})
		case "GET /api/v1/resources/" + testID:
			json.NewEncoder(w).Encode(map[string]any{"id": testID, "revision": 3, "name": "old", "url": "https://app.example/", "operations": []string{"check"}})
		case "PUT /api/v1/resources/" + testID:
			puts++
			var m map[string]any
			json.NewDecoder(r.Body).Decode(&m)
			if m["name"] != "new" || m["url"] != "https://app.example/" || m["revision"] != float64(3) {
				t.Errorf("lost fields: %v", m)
			}
			json.NewEncoder(w).Encode(m)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.Error(w, "bad", 500)
		}
	}
	cs, _ := fixture(t, h, false)
	tools, e := cs.ListTools(context.Background(), nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(tools.Tools) != 7 {
		t.Fatalf("read tool count %d", len(tools.Tools))
	}
	res, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_resources", Arguments: map[string]any{"query": "App"}})
	if e != nil || res.IsError {
		t.Fatalf("read failed %v %+v", e, res)
	}
	cs, _ = fixture(t, h, true)
	call := func(rev int, changes map[string]any) bool {
		r, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "update_resource", Arguments: map[string]any{"id": testID, "revision": rev, "changes": changes}})
		return e == nil && !r.IsError
	}
	if call(2, map[string]any{"name": "new"}) || puts != 0 {
		t.Fatal("stale revision written")
	}
	if call(3, map[string]any{"executor_target": "evil"}) || puts != 0 {
		t.Fatal("runtime field written")
	}
	if !call(3, map[string]any{"name": "new"}) || puts != 1 {
		t.Fatal("update failed")
	}
}
func TestTransportRejectsRedirectAndReloadsToken(t *testing.T) {
	cs, c := fixture(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://other.example", 302) }, false)
	r, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_resources", Arguments: map[string]any{}})
	if e == nil && !r.IsError {
		t.Fatal("redirect accepted")
	}
	os.Chmod(c.tokenFile, 0644)
	if _, e = c.token(); e == nil {
		t.Fatal("public token file accepted")
	}
	os.Chmod(c.tokenFile, 0600)
	os.WriteFile(c.tokenFile, []byte(strings.Repeat("z", 43)), 0600)
	v, e := c.token()
	if e != nil || v != strings.Repeat("z", 43) {
		t.Fatal("token not reloaded")
	}
	for _, u := range []string{"http://example.org", "https://user:pass@example.org", "https://example.org/api", "https://example.org?x=y"} {
		if _, e := NewClient(u, c.tokenFile); e == nil {
			t.Fatalf("unsafe origin %s", u)
		}
	}
}
