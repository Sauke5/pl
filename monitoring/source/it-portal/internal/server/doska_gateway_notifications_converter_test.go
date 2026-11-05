package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoskaNotificationCursorAndPanelConverter(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 required")
	}
	dir := t.TempDir()
	input, output := filepath.Join(dir, "source.json"), filepath.Join(dir, "typed.json")
	cursor := map[string]any{"type": "string", "minLength": 1, "maxLength": 1024}
	panel := map[string]any{"type": "string", "enum": []string{"members"}, "required": false, "multiplicity": 1}
	rule := map[string]any{"name": "cursor", "required": false, "multiplicity": 1, "schema": cursor}
	source := map[string]any{
		"source": strings.Repeat("a", 40), "pages": []string{"/doska", "/doska/projects/{projectId}"}, "assets": []any{},
		"requestBodyLimitBytes": 131072, "websockets": false, "uploads": false, "nativeRoutes": false,
		"queryLimits": map[string]any{"rawBytes": 4096, "duplicateKeys": "reject"},
		"pageQuery":   map[string]any{"/doska/projects/{projectId}": map[string]any{"panel": panel}, "otherPages": map[string]any{}},
		"apiRoutes":   []map[string]any{{"method": "GET", "external": "/doska/api/doska/notifications", "upstream": "/api/doska/notifications", "query": []any{rule}, "unknownQueryKeys": "reject"}},
	}
	write := func() {
		t.Helper()
		raw, err := json.Marshal(source)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(input, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	run := func(target string) error {
		return exec.Command(python, "../../deploy/doska/prepare-gateway-manifest.py", input, target).Run()
	}
	write()
	if err := run(output); err != nil {
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
	cursorRule := manifest.Routes[1].Query["cursor"]
	if cursorRule.Kind != "text" || cursorRule.AllowEmpty || cursorRule.MaxChars != 1024 || cursorRule.MaxBytes != 4096 {
		t.Fatalf("cursor bounds changed %+v", cursorRule)
	}
	routes, err := compileDoskaManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path    string
		allowed bool
	}{
		{"/doska/api/doska/notifications", true}, {"/doska/api/doska/notifications?cursor=a", true},
		{"/doska/api/doska/notifications?cursor=" + strings.Repeat("a", 1024), true},
		{"/doska/api/doska/notifications?cursor=", false}, {"/doska/api/doska/notifications?cursor=" + strings.Repeat("a", 1025), false},
		{"/doska/api/doska/notifications?cursor=a&cursor=b", false}, {"/doska/api/doska/notifications?unknown=a", false},
		{"/doska/projects/p1?panel=members", true}, {"/doska/projects/p1?panel=owners", false}, {"/doska/projects/p1?panel=", false},
		{"/doska/projects/p1?panel=members&panel=members", false}, {"/doska/projects/p1?panel=members&unknown=a", false},
	} {
		_, ok := doskaMatchRoute(routes, httptest.NewRequest("GET", "http://portal.test"+tc.path, nil))
		if ok != tc.allowed {
			t.Fatalf("%s allowed%v want%v", tc.path, ok, tc.allowed)
		}
	}
	for _, schema := range []map[string]any{
		{"type": "string", "minLength": 0, "maxLength": 1024}, {"type": "string", "minLength": 2, "maxLength": 1024},
		{"type": "string", "minLength": true, "maxLength": 1024}, {"type": "string", "minLength": "1", "maxLength": 1024},
		{"type": "string", "minLength": 1}, {"type": "string", "minLength": 1, "maxLength": 1025},
		{"type": "integer", "minLength": 1, "minimum": 1, "maximum": 100},
		{"type": "string", "minLength": 1, "maxLength": 1024, "minimum": 0},
		{"type": "string", "minLength": 1, "maxLength": 1024, "default": ""},
		{"type": "string", "minLength": 1, "maxLength": 1024, "default": 1},
		{"type": "string", "minLength": 1, "maxLength": 1024, "default": strings.Repeat("x", 1025)},
	} {
		rule["schema"] = schema
		write()
		if err := run(filepath.Join(dir, "reject-cursor.json")); err == nil {
			t.Fatalf("invalid cursor schema accepted %+v", schema)
		}
	}
	rule["schema"] = cursor
	for _, invalidPanel := range []map[string]any{
		{"type": "string", "required": false, "multiplicity": 1},
		{"type": "string", "enum": []string{}, "required": false, "multiplicity": 1},
		{"type": "string", "enum": []string{""}, "required": false, "multiplicity": 1},
		{"type": "string", "enum": []string{"members", "members"}, "required": false, "multiplicity": 1},
		{"type": "string", "enum": "members", "required": false, "multiplicity": 1},
		{"type": "string", "enum": []string{"members"}, "required": false, "multiplicity": 2},
		{"type": "string", "pattern": ".*", "required": false, "multiplicity": 1},
		{"type": "string", "enum": []string{"members"}, "unknown": true, "required": false, "multiplicity": 1},
	} {
		source["pageQuery"].(map[string]any)["/doska/projects/{projectId}"] = map[string]any{"panel": invalidPanel}
		write()
		if err := run(filepath.Join(dir, "reject-panel.json")); err == nil {
			t.Fatalf("invalid panel schema accepted %+v", invalidPanel)
		}
	}
}
