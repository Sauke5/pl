package server

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoskaConfigOptionalStrictAndBounded(t *testing.T) {
	t.Setenv("PORTAL_DOSKA_CONFIG_FILE", "")
	if gateway, ad, err := loadDoskaConfig(); err != nil || gateway != nil || ad != nil {
		t.Fatal("unset config must not activate integration")
	}
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "gateway.key")
	manifestFile := filepath.Join(dir, "manifest.json")
	configFile := filepath.Join(dir, "config.json")
	key := []byte("0123456789abcdef0123456789abcdef")
	write := func(path string, body []byte) {
		t.Helper()
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	manifest, _ := json.Marshal(doskaGatewayTestManifest())
	write(keyFile, key)
	write(manifestFile, manifest)
	base := map[string]any{"api_upstream": "http://192.0.2.240:1337", "web_upstream": "http://192.0.2.240:8080", "key_file": keyFile, "manifest_file": manifestFile, "allowed_cidrs": []string{"192.0.2.240/32"}}
	save := func(config map[string]any) {
		t.Helper()
		data, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		write(configFile, data)
	}
	save(base)
	t.Setenv("PORTAL_DOSKA_CONFIG_FILE", configFile)
	gateway, ad, err := loadDoskaConfig()
	if err != nil || gateway == nil || ad != nil || string(gateway.Key) != string(key) || gateway.Guard == nil || gateway.Transport != nil {
		t.Fatalf("config did not load: %v", err)
	}
	if _, err := (&Server{Config: Config{PublicURL: "https://portal.example.test"}}).DoskaGateway(*gateway); err != nil {
		t.Fatal(err)
	}
	withAD := map[string]any{}
	for k, v := range base {
		withAD[k] = v
	}
	withAD["ad"] = map[string]any{"url": "ldaps://192.0.2.10:636", "base_dn": "dc=fixture,dc=test", "bind_dn_file": filepath.Join(dir, "bind-dn"), "bind_password_file": filepath.Join(dir, "bind-password"), "scope_group_guids": []string{"000102030405060708090a0b0c0d0e0f"}, "max_discovery_employees": 25}
	save(withAD)
	_, ad, err = loadDoskaConfig()
	if err != nil || ad == nil || ad.MaxDiscoveryEmployees != 25 || len(ad.ScopeGroupGUIDs) != 1 {
		t.Fatalf("AD config not loaded: %v", err)
	}
	// Credential paths intentionally do not exist: loading configuration must not
	// read bind credentials or connect to the directory.
	if _, err := os.Stat(ad.BindPasswordFile); !os.IsNotExist(err) {
		t.Fatal("unexpected bind credential fixture")
	}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unknown", func(m map[string]any) { m["unexpected"] = true }},
		{"missing-key", func(m map[string]any) { delete(m, "key_file") }},
		{"relative-manifest", func(m map[string]any) { m["manifest_file"] = "manifest.json" }},
		{"userinfo", func(m map[string]any) { m["api_upstream"] = "http://user:password@192.0.2.240:1337" }},
		{"path", func(m map[string]any) { m["api_upstream"] = "http://192.0.2.240:1337/api/" }},
		{"wrong-cidr", func(m map[string]any) { m["allowed_cidrs"] = []string{"192.0.2.241/32"} }},
		{"no-cidr", func(m map[string]any) { m["allowed_cidrs"] = []string{} }},
		{"AD-unknown", func(m map[string]any) { m["ad"] = map[string]any{"unexpected": true} }},
		{"AD-relative-secrets", func(m map[string]any) {
			m["ad"] = map[string]any{"url": "ldaps://192.0.2.10", "base_dn": "dc=fixture,dc=test", "bind_dn_file": "bind", "bind_password_file": "password"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]any{}
			for k, v := range base {
				m[k] = v
			}
			tc.mutate(m)
			save(m)
			if _, _, err := loadDoskaConfig(); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
	save(base)
	for _, raw := range []string{`{"api_upstream":"one","api_upstream":"two"}`, `{"ad":{"url":"one","url":"two"}}`, strings.Repeat(" ", (64<<10)+1), `{} {}`} {
		write(configFile, []byte(raw))
		if _, _, err := loadDoskaConfig(); err == nil {
			t.Fatal("duplicate/oversized/trailing config accepted")
		}
	}
	save(base)
	for _, raw := range [][]byte{key[:31], append(append([]byte{}, key...), '\n')} {
		write(keyFile, raw)
		if _, _, err := loadDoskaConfig(); err == nil {
			t.Fatal("non-raw32 key accepted")
		}
	}
	write(keyFile, key)
	for _, raw := range []string{`{"version":"v1","version":"v2","routes":[]}`, `{"version":"v1","routes":[],"unexpected":true}`, strings.Repeat(" ", (512<<10)+1)} {
		write(manifestFile, []byte(raw))
		if _, _, err := loadDoskaConfig(); err == nil {
			t.Fatal("invalid manifest accepted")
		}
	}
}

func TestDoskaManifestConverterPreservesReviewedSchema(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 required for release converter test")
	}
	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.json")
	output := filepath.Join(dir, "manifest.json")
	rule := func(name string, required bool, schema map[string]any) map[string]any {
		return map[string]any{"name": name, "required": required, "multiplicity": 1, "schema": schema}
	}
	source := map[string]any{
		"webSource": "a5e10792",
		"source":    strings.Repeat("a", 40), "pages": []string{"/doska", "/doska/", "/doska/projects/{projectId}"},
		"assets":                []map[string]any{{"path": "/doska/assets/index-123456.js", "bytes": 1, "sha256": strings.Repeat("0", 64)}},
		"requestBodyLimitBytes": 131072, "websockets": false, "uploads": false, "nativeRoutes": false,
		"queryLimits": map[string]any{"rawBytes": 4096, "duplicateKeys": "reject"},
		"pageQuery":   map[string]any{"/doska/projects/{projectId}": map[string]any{"taskId": map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_-]+$", "multiplicity": 1, "required": false}}, "otherPages": map[string]any{}},
		"apiRoutes": []map[string]any{{"method": "GET", "external": "/doska/api/doska/options", "upstream": "/api/doska/options", "unknownQueryKeys": "reject", "query": []map[string]any{
			rule("limit", false, map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 50}),
			rule("purpose", true, map[string]any{"type": "string", "enum": []string{"invitation", "ownership"}}),
			rule("q", false, map[string]any{"type": "string", "maxLength": 200}),
		}}},
	}
	data, _ := json.Marshal(source)
	if err := os.WriteFile(sourcePath, data, 0600); err != nil {
		t.Fatal(err)
	}
	script := "../../deploy/doska/prepare-gateway-manifest.py"
	command := func(out string) error { return exec.Command(python, script, sourcePath, out).Run() }
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
	if manifest.Version != "doska-aaaaaaaaaaaa" || len(manifest.Routes) != 4 {
		t.Fatalf("wrong converter result %+v", manifest)
	}
	routes, err := compileDoskaManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		target  string
		allowed bool
	}{
		{"/doska/projects/p1?taskId=t1", true}, {"/doska/projects/p1?token=x", false},
		{"/doska/assets/index-123456.js", true}, {"/doska/assets/unknown.js", false},
		{"/doska/api/doska/options?purpose=ownership&limit=100", true}, {"/doska/api/doska/options?purpose=ownership&limit=101", false},
		{"/doska/api/doska/options?purpose=ownership&limit=0", false}, {"/doska/api/doska/options?limit=50", false},
		{"/doska/api/doska/options?purpose=unknown", false}, {"/doska/api/doska/options?purpose=ownership&purpose=invitation", false},
	} {
		request := doskaDirectoryTestRequest("GET", tc.target, "")
		_, ok := doskaMatchRoute(routes, request)
		if ok != tc.allowed {
			t.Fatalf("converted query schema %s allowed%v", tc.target, ok)
		}
	}
	if err := command(output); err == nil {
		t.Fatal("converter overwrote existing artifact")
	}
	api := source["apiRoutes"].([]map[string]any)[0]
	for _, schema := range []map[string]any{{"type": "array"}, {"type": "string", "pattern": ".*"}, {"type": "integer", "minimum": 1}, {"type": "string", "maxLength": 200, "unexpected": true}} {
		api["query"] = []map[string]any{rule("q", false, schema)}
		data, _ := json.Marshal(source)
		if err := os.WriteFile(sourcePath, data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := command(filepath.Join(dir, "rejected.json")); err == nil {
			t.Fatalf("unknown schema accepted %+v", schema)
		}
	}
	for _, raw := range []string{strings.Repeat(" ", (512<<10)+1), `{"source":"one","source":"two"}`} {
		if err := os.WriteFile(sourcePath, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if err := command(filepath.Join(dir, "rejected-bounds.json")); err == nil {
			t.Fatal("oversized or duplicate source JSON accepted")
		}
	}
}
