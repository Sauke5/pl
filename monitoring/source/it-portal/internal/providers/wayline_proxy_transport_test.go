package providers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

func TestWaylineProxyTransportCredentialsAndDestination(t *testing.T) {
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_WAYLINE_PROXY")
	t.Setenv("PORTAL_SECRET_WAYLINE_PROXY", "fixture-password")
	calls := 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls++
		name, password, ok := q.BasicAuth()
		if !ok || name != "fixture-user" || password != "fixture-password" {
			t.Error("missing intended Basic")
		}
		for _, h := range []string{"Cookie", "X-CSRF-Token", "Proxy-Authorization"} {
			if q.Header.Get(h) != "" {
				t.Error("credential leaked", h)
			}
		}
		w.WriteHeader(204)
	})
	source := model.Integration{Enabled: true, Kind: "wayline", URL: "http://source", SecretRef: "env:PORTAL_SECRET_WAYLINE_PROXY", Config: map[string]string{"basic_username": "fixture-user"}}
	rt, err := r.WaylineProxyTransport(source)
	if err != nil {
		t.Fatal(err)
	}
	typed := rt.(waylineProxyTransport)
	if typed.transport.ResponseHeaderTimeout != 220*time.Second || typed.transport.Proxy != nil || !typed.transport.DisableKeepAlives || typed.transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("incorrect transport boundaries")
	}
	req := httptest.NewRequest("GET", "http://source/api/v1/targets", nil)
	req.RequestURI = ""
	for _, h := range []string{"Authorization", "Cookie", "X-CSRF-Token", "Proxy-Authorization"} {
		req.Header.Set(h, "browser-secret")
	}
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 204 || calls != 1 {
		t.Fatal("source request failed")
	}
	if req.Header.Get("Authorization") != "browser-secret" {
		t.Fatal("caller request mutated")
	}
	for _, address := range []string{"http://other/api/v1/targets", "https://source/api/v1/targets", "http://127.0.0.1/api/v1/targets"} {
		q := httptest.NewRequest("GET", address, nil)
		q.RequestURI = ""
		if _, err := rt.RoundTrip(q); !errors.Is(err, netguard.ErrPolicyDenied) {
			t.Fatal("foreign destination permitted", err)
		}
	}
	if calls != 1 {
		t.Fatal("rejected destination called")
	}
	source.Enabled = false
	if _, err = r.WaylineProxyTransport(source); err == nil {
		t.Fatal("disabled source permitted")
	}
	source.Enabled = true
	source.SecretRef = "env:PORTAL_SECRET_NOT_ALLOWED"
	if _, err = r.WaylineProxyTransport(source); err == nil {
		t.Fatal("unapproved credential permitted")
	}
	source.SecretRef = ""
	if _, err = r.WaylineProxyTransport(source); err == nil {
		t.Fatal("incomplete credential pair permitted")
	}
}
