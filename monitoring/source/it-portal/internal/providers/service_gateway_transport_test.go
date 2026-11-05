package providers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pl/portal/internal/netguard"
)

func TestServiceGatewayTransportPinsOriginPrefixAndTimeout(t *testing.T) {
	calls := 0
	registry := registry(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) })
	rt, err := registry.ServiceGatewayTransport("http://source/admin")
	if err != nil {
		t.Fatal(err)
	}
	transport := rt.(serviceGatewayTransport)
	if transport.transport.ResponseHeaderTimeout != 130*time.Second || transport.transport.Proxy != nil || !transport.transport.DisableKeepAlives || transport.transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("invalid gateway transport settings")
	}
	for _, path := range []string{"http://source/websites/", "http://evil/admin/", "https://source/admin/", "http://source/admin/../metrics", "http://source/admin/%2Fmetrics", "http://source/admin/%252e%252e/metrics"} {
		r := httptest.NewRequest("GET", path, nil)
		r.RequestURI = ""
		if _, err = rt.RoundTrip(r); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatal("destination escaped policy", path, err)
		}
	}
	if calls != 0 {
		t.Fatal("invalid request reached source")
	}
	r := httptest.NewRequest("GET", "http://source/admin/api/v1/session", nil)
	r.RequestURI = ""
	response, err := rt.RoundTrip(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 204 || calls != 1 {
		t.Fatal("source not reached")
	}
	for _, base := range []string{"http://user:pass@source/admin", "http://source/admin?token=fixture", "http://source/", "http://source/admin#fragment"} {
		if _, err = registry.ServiceGatewayTransport(base); err == nil {
			t.Fatal("invalid upstream configuration accepted")
		}
	}
}

func TestDirectoryTransportPinsOriginAndPrefix(t *testing.T) {
	calls := 0
	registry := registry(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/directory/api/v1/contacts" {
			t.Error(r.URL.Path)
		}
		w.WriteHeader(204)
	})
	rt, err := registry.ServiceGatewayTransport("http://source/directory")
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"http://source/admin/", "http://evil/directory/", "http://source/directory/../admin/", "http://source/directory/%2e%2e/admin/", "http://source/directory//api"} {
		r := httptest.NewRequest("GET", target, nil)
		r.RequestURI = ""
		if _, err = rt.RoundTrip(r); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatal("escaped directory", target, err)
		}
	}
	r := httptest.NewRequest("GET", "http://source/directory/api/v1/contacts", nil)
	r.RequestURI = ""
	response, err := rt.RoundTrip(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if calls != 1 {
		t.Fatal(calls)
	}
}
