package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNetMapInventoryRoutesAreFiniteAndAdminOnly(t *testing.T) {
	id := netmapGatewayID
	for _, pair := range [][2]string{
		{"GET", "/profiles"}, {"HEAD", "/targets"}, {"GET", "/jobs"}, {"GET", "/capabilities"},
		{"POST", "/profiles"}, {"POST", "/targets"}, {"POST", "/enroll"}, {"POST", "/ssh-host-key"},
		{"POST", "/profiles/" + id + "/test"}, {"POST", "/targets/" + id + "/collect"},
		{"DELETE", "/profiles/" + id}, {"DELETE", "/targets/" + id},
	} {
		r := httptest.NewRequest(pair[0], "https://portal.example.test/netmap/api/inventory"+pair[1], nil)
		route, ok := netmapMatchRoute(r)
		if !ok || route.scope != "netmap:admin" || route.media != "application/json" || route.native != "" {
			t.Fatalf("unexpected admission: %s %s %+v %v", pair[0], pair[1], route, ok)
		}
	}
	for _, pair := range [][2]string{
		{"GET", "/profiles/" + id}, {"POST", "/profiles/" + id + "/collect"},
		{"POST", "/targets/" + id + "/test"}, {"DELETE", "/jobs/" + id},
		{"PUT", "/profiles"}, {"POST", "/profiles?force=1"},
		{"GET", "/jobs?all=1"}, {"GET", "/profiles/../jobs"},
		{"GET", "/enroll"}, {"POST", "/ssh-host-key?port=22"}, {"POST", "/capabilities"},
		{"POST", "/targets/foreign/collect"}, {"DELETE", "/profiles/" + id + "/"},
	} {
		r := httptest.NewRequest(pair[0], "https://portal.example.test/netmap/api/inventory"+pair[1], nil)
		if _, ok := netmapMatchRoute(r); ok {
			t.Fatalf("unexpected admission: %s %s", pair[0], pair[1])
		}
	}
}

func TestNetMapInventoryMutationRequiresCSRFAndBindsBody(t *testing.T) {
	calls := 0
	g := netmapFixture(t, func(r *http.Request, body []byte) *http.Response {
		calls++
		if r.Method != "DELETE" || r.URL.Path != "/netmap/api/inventory/targets/"+netmapGatewayID || string(body) != "{}" {
			t.Fatal("inventory request was not bound to its method/path/body")
		}
		return netmapResponse("application/json", `{"removed":true}`)
	})
	headers := http.Header{"Content-Type": {"application/json"}, "Origin": {"https://portal.example.test"}, "Idempotency-Key": {netmapGatewayID}}
	path := "/netmap/api/inventory/targets/" + netmapGatewayID
	if got := netmapCall(g, "DELETE", path, "{}", headers, false); got.Code == 200 || calls != 0 {
		t.Fatal("inventory deletion bypassed CSRF")
	}
	headers.Set("X-CSRF-Token", netmapSession().CSRF)
	if got := netmapCall(g, "DELETE", path, "{}", headers, false); got.Code != 200 || calls != 1 {
		t.Fatalf("signed inventory deletion failed: %d %s", got.Code, got.Body.String())
	}
}

func TestNetMapInventoryDeepLinkAcceptsOnlyNativeIDsOnMapHTML(t *testing.T) {
	for _, path := range []string{
		"/netmap/?device=device%3A55", "/netmap/index.html?scope=network&device=vm%3A42&layout=groups",
	} {
		route, ok := netmapMatchRoute(httptest.NewRequest("GET", path, nil))
		if !ok || route.scope != "netmap:read" || route.media != "text/html" {
			t.Fatalf("map deep link rejected: %q %+v", path, route)
		}
	}
	for _, path := range []string{
		"/netmap/app.js?device=device%3A55", "/netmap/?device=neighbor%3A55", "/netmap/?device=device%3A0",
		"/netmap/?device=device%3A55&device=vm%3A42", "/netmap/?device=device%3A55&redirect=https%3A%2F%2Fexample.test",
		"/netmap/?layout=unknown", "/netmap/?layout=groups&layout=groups", "/netmap/app.js?layout=groups",
	} {
		if _, ok := netmapMatchRoute(httptest.NewRequest("GET", path, nil)); ok {
			t.Fatalf("unexpected map query admitted: %q", path)
		}
	}
}
