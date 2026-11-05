//go:build candidate_acceptance

package server

import (
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDoskaCatalogCandidateManifest(t *testing.T) {
	path := os.Getenv("DOSKA_CATALOG_TEST_MANIFEST_FILE")
	if path == "" {
		t.Fatal("exact offline release candidate required")
	}
	raw, e := doskaReadFile(path, 512<<10)
	var manifest DoskaGatewayManifest
	if e != nil || catalogJSON(raw, &manifest) != nil {
		t.Fatal("candidate manifest invalid")
	}
	routes, e := compileDoskaManifest(manifest)
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		path    string
		allowed bool
	}{
		{"/doska/overview", true}, {"/doska/api/doska/overview?limit=100&offset=0", true}, {"/doska/api/doska/overview?limit=101", false},
		{"/doska/api/doska/task-search?open=true&upcoming=false&labelName=Label&customFieldId=field&customFieldValue=value", true},
		{"/doska/api/doska/task-search?customFieldValue=" + strings.Repeat("x", 2000), true}, {"/doska/api/doska/task-search?customFieldValue=" + strings.Repeat("x", 2001), false},
		{"/doska/api/doska/task-search?labelName=" + strings.Repeat("x", 101), false}, {"/doska/api/doska/task-search?open=yes", false},
		{"/doska/projects?resourceId=11111111-1111-4111-8111-111111111111&sourceKind=netbox", true},
		{"/doska/projects?resourceId=11111111-1111-4111-8111-111111111111&sourceKind=other", false},
		{"/doska/api/doska/projects/p/resource-link-capabilities", false},
	} {
		r := httptest.NewRequest("GET", "http://fixture.test"+tc.path, nil)
		_, allowed := doskaMatchRoute(routes, r)
		if allowed != tc.allowed {
			t.Fatalf("candidate %s allowed%v want%v", tc.path, allowed, tc.allowed)
		}
	}
	if _, reserved := matchCatalogRoute(httptest.NewRequest("GET", "http://fixture.test/doska/assets/resource-links-abc.js", nil)); reserved {
		t.Fatal("web asset captured by API lane")
	}
	t.Logf("exact candidate %s: %d finite routes compiled", manifest.Version, len(manifest.Routes))
}
