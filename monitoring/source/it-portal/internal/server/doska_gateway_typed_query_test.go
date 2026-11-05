package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func doskaTypedQueryManifest() DoskaGatewayManifest {
	one, hundred, zero, maxOffset := int64(1), int64(100), int64(0), int64(10000000)
	return DoskaGatewayManifest{Version: "search-types-v1", Routes: []DoskaGatewayRoute{
		{Method: "GET", Path: "/doska/search", Kind: "page"},
		{Method: "GET", Path: "/doska/api/doska/task-search", Kind: "read", Query: map[string]DoskaGatewayQuery{
			"limit": {Kind: "integer", Minimum: &one, Maximum: &hundred}, "offset": {Kind: "integer", Minimum: &zero, Maximum: &maxOffset},
			"q": {Kind: "text", MaxChars: 200, MaxBytes: 800, AllowEmpty: true}, "projectId": {Kind: "id"},
			"assigneeId": {Kind: "subjectid"}, "coexecutorId": {Kind: "subjectid"}, "dueFrom": {Kind: "date"}, "dueTo": {Kind: "date"},
			"state": {Kind: "text", Enum: []string{"planned", "active", "completed"}}, "priority": {Kind: "text", Enum: []string{"no-priority", "low", "medium", "high", "urgent"}},
			"unassigned": {Kind: "boolean"}, "overdue": {Kind: "boolean"}, "archived": {Kind: "boolean"},
		}},
	}}
}

func TestDoskaGatewayTypedSearchQueries(t *testing.T) {
	routes, err := compileDoskaManifest(doskaTypedQueryManifest())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query   string
		allowed bool
	}{
		{"", true}, {"limit=100&offset=10000000&q=test&projectId=p_1&assigneeId=ad%3A0123%3Aabcd&coexecutorId=ad:other&state=active&priority=urgent&dueFrom=2024-02-29&dueTo=2024-03-01&unassigned=true&overdue=false&archived=false", true},
		{"assigneeId=" + strings.Repeat("a", 128), true}, {"projectId=" + strings.Repeat("a", 128), true},
		{"assigneeId=" + strings.Repeat("a", 129), false}, {"coexecutorId=" + strings.Repeat("a", 129), false}, {"projectId=" + strings.Repeat("a", 129), false},
		{"projectId=ad:person", false}, {"assigneeId=ad%2Fperson", false}, {"coexecutorId=ad%5Cperson", false},
		{"assigneeId=", false}, {"coexecutorId=", false}, {"projectId=", false}, {"dueFrom=", false},
		{"dueFrom=2000-02-29", true}, {"dueFrom=1900-02-29", false}, {"dueTo=2023-02-29", false},
		{"dueTo=2024-02-30", false}, {"dueTo=2024-04-31", false}, {"dueTo=2024-13-01", false}, {"dueTo=2024-00-01", false},
		{"dueTo=2024-01-00", false}, {"dueTo=2024-2-01", false}, {"dueTo=0000-01-01", false}, {"dueTo=0001-01-01", true},
		{"dueTo=2024-02-29T00:00:00Z", false}, {"dueTo=" + url.QueryEscape("２０２４-02-29"), false},
		{"assigneeId=a&assigneeId=b", false}, {"dueFrom=2024-01-01&dueFrom=2024-01-02", false},
		{"dueFrom=2024-01-01&unknown=true", false}, {"limit=101", false}, {"offset=-1", false}, {"state=hidden", false}, {"priority=critical", false},
	} {
		path := "/doska/api/doska/task-search"
		if tc.query != "" {
			path += "?" + tc.query
		}
		_, ok := doskaMatchRoute(routes, httptest.NewRequest("GET", "http://portal.test"+path, nil))
		if ok != tc.allowed {
			t.Fatalf("%s allowed%v want%v", tc.query, ok, tc.allowed)
		}
	}
	for _, target := range []string{"/doska/search?projectId=p1", "/doska/api/doska/task-search?regex=.*"} {
		if _, ok := doskaMatchRoute(routes, httptest.NewRequest("GET", "http://portal.test"+target, nil)); ok {
			t.Fatalf("unregistered query allowed: %s", target)
		}
	}
	for _, kind := range []string{"regex", "datetime", "subject"} {
		m := doskaTypedQueryManifest()
		m.Routes[1].Query["unknown"] = DoskaGatewayQuery{Kind: kind}
		if _, err := compileDoskaManifest(m); err == nil {
			t.Fatalf("unknown kind %s accepted", kind)
		}
	}
}

func TestDoskaGatewayTypedPatternConverter(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 required")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "source.json")
	query := []map[string]any{}
	patternRule := func(name, pattern string) map[string]any {
		return map[string]any{"name": name, "required": false, "multiplicity": 1, "schema": map[string]any{"type": "string", "pattern": pattern}}
	}
	query = append(query, patternRule("projectId", `^[A-Za-z0-9_-]{1,128}$`), patternRule("assigneeId", `^[A-Za-z0-9:_-]{1,128}$`), patternRule("coexecutorId", `^[A-Za-z0-9:_-]{1,128}$`), patternRule("dueFrom", `^\d{4}-\d{2}-\d{2}$`), patternRule("dueTo", `^\d{4}-\d{2}-\d{2}$`))
	query = append(query, map[string]any{"name": "customFieldValue", "required": false, "multiplicity": 1, "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 2000}})
	source := map[string]any{"source": strings.Repeat("a", 40), "pages": []string{"/doska", "/doska/search"}, "assets": []any{}, "requestBodyLimitBytes": 131072, "websockets": false, "uploads": false, "nativeRoutes": false, "queryLimits": map[string]any{"rawBytes": 4096, "duplicateKeys": "reject"}, "pageQuery": map[string]any{"otherPages": map[string]any{}}, "apiRoutes": []map[string]any{{"method": "GET", "external": "/doska/api/doska/task-search", "upstream": "/api/doska/task-search", "query": query, "unknownQueryKeys": "reject"}}}
	write := func() {
		t.Helper()
		b, err := json.Marshal(source)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(input, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	command := func(output string) error {
		return exec.Command(python, "../../deploy/doska/prepare-gateway-manifest.py", input, output).Run()
	}
	write()
	output := filepath.Join(dir, "typed.json")
	if err := command(output); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var manifest DoskaGatewayManifest
	if err := doskaStrictJSON(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	routes, err := compileDoskaManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	rules := manifest.Routes[1].Query
	if value := rules["customFieldValue"]; value.MaxChars != 2000 || value.MaxBytes != 4096 || value.AllowEmpty {
		t.Fatalf("native field-value bounds lost during conversion: %+v", value)
	}
	for _, tc := range []struct {
		query   string
		allowed bool
	}{{"customFieldValue=" + strings.Repeat("x", 2000), true}, {"customFieldValue=" + strings.Repeat("x", 2001), false}, {"customFieldValue=", false}, {"customFieldValue=value&unknown=true", false}, {"customFieldValue=a&customFieldValue=b", false}} {
		_, allowed := doskaMatchRoute(routes, httptest.NewRequest("GET", "http://portal.test/doska/api/doska/task-search?"+tc.query, nil))
		if allowed != tc.allowed {
			t.Fatalf("converted search query %q allowed=%v want=%v", tc.query, allowed, tc.allowed)
		}
	}
	// The converter does not admit unbounded future DTO expansions silently.
	fieldSchema := query[len(query)-1]["schema"]
	query[len(query)-1]["schema"] = map[string]any{"type": "string", "maxLength": 2001}
	write()
	if err := command(filepath.Join(dir, "oversized.json")); err == nil {
		t.Fatal("unsupported field-value bound accepted")
	}
	query[len(query)-1]["schema"] = fieldSchema
	// The 2000-character exception belongs only to this GET field, not cursors
	// or other operations that happen to declare a similarly named parameter.
	route := source["apiRoutes"].([]map[string]any)[0]
	for _, tc := range []struct{ method, external, name string }{
		{"GET", "/doska/api/doska/task-search", "cursor"},
		{"GET", "/doska/api/doska/notifications", "customFieldValue"},
		{"POST", "/doska/api/doska/task-search", "customFieldValue"},
	} {
		route["method"], route["external"], route["upstream"] = tc.method, tc.external, strings.TrimPrefix(tc.external, "/doska")
		query[len(query)-1]["name"] = tc.name
		write()
		if err := command(filepath.Join(dir, "outside-field.json")); err == nil {
			t.Fatalf("field-value exception escaped to %s %s %s", tc.method, tc.external, tc.name)
		}
	}
	route["method"], route["external"], route["upstream"] = "GET", "/doska/api/doska/task-search", "/api/doska/task-search"
	query[len(query)-1]["name"] = "customFieldValue"
	for name, kind := range map[string]string{"projectId": "id", "assigneeId": "subjectid", "coexecutorId": "subjectid", "dueFrom": "date", "dueTo": "date"} {
		if rules[name].Kind != kind {
			t.Fatalf("%s kind%q want%q", name, rules[name].Kind, kind)
		}
	}
	// An accidentally double-escaped artifact is a DIFFERENT pattern and must
	// remain rejected; the owner must correct the source before conversion.
	for _, pattern := range []string{`^\\d{4}-\\d{2}-\\d{2}$`, `^[A-Za-z0-9:_-]+$`, `.*`, `^\w{1,128}$`} {
		query[0]["schema"] = map[string]any{"type": "string", "pattern": pattern}
		write()
		if err := command(filepath.Join(dir, "rejected.json")); err == nil {
			t.Fatalf("unsupported pattern accepted %q", pattern)
		}
	}
}
