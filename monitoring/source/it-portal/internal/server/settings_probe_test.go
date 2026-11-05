package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
)

type settingsProbeDNS struct{}

func (settingsProbeDNS) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}, nil
}

func settingsProbeProvider(t *testing.T, h http.HandlerFunc) *providers.Registry {
	t.Helper()
	source := httptest.NewServer(h)
	t.Cleanup(source.Close)
	address := strings.TrimPrefix(source.URL, "http://")
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", settingsProbeDNS{}, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	})
	if err != nil {
		t.Fatal(err)
	}
	return providers.New(guard, "")
}

func settingsProbeAPICall(s *Server, identity apiIdentity, body string, headers map[string]string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	s.RegisterSettingsProbe(mux)
	r := httptest.NewRequest(http.MethodPost, s.Config.PublicURL+"/api/v1/settings-workspace/probe", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.Config.PublicURL)
	if identity.cookie != nil {
		r.AddCookie(identity.cookie)
	}
	if identity.csrf != "" {
		r.Header.Set("X-CSRF-Token", identity.csrf)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestSettingsProbeAnonymousBoundaryWithoutDatabase(t *testing.T) {
	s := &Server{Config: Config{PublicURL: "https://portal.example.test"}}
	if w := settingsProbeAPICall(s, apiIdentity{}, `{}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous probe: %d", w.Code)
	}
}

func TestSettingsProbeAPIAdministrativeBoundaryAndReadOnlyDraft(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "probe-admin", true)
	viewer := apiUser(t, s, "probe-viewer", false)
	var calls atomic.Int32
	s.Providers = settingsProbeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/draft/api/v1/targets" || r.Header.Get("Cookie") != "" || r.Header.Get("X-CSRF-Token") != "" {
			t.Error("wrong draft endpoint or browser identity forwarded")
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[]}}`))
	})
	input := `{"id":"not-a-saved-source","name":"Draft source","kind":"prometheus","url":"http://draft.example.test/draft","enabled":false,"poll_seconds":60,"timeout_seconds":3,"concurrency":2,"config":{}}`
	for _, who := range []struct {
		identity apiIdentity
		want     int
	}{{apiIdentity{}, 401}, {viewer, 403}} {
		if w := settingsProbeAPICall(s, who.identity, input, nil); w.Code != who.want {
			t.Fatalf("forbidden draft probe: %d want%d", w.Code, who.want)
		}
	}
	for _, headers := range []map[string]string{{"X-CSRF-Token": ""}, {"X-CSRF-Token": "invalid"}, {"Origin": "https://other.example.test"}, {"Sec-Fetch-Site": "cross-site"}, {"Authorization": "Bearer not-browser-session"}} {
		if w := settingsProbeAPICall(s, admin, input, headers); w.Code != 401 && w.Code != 403 {
			t.Fatalf("CSRF/machine boundary bypass: %d", w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("denied probe reached source")
	}
	counts := func() [4]int {
		var values [4]int
		if err := s.Store.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM documents),(SELECT count(*) FROM jobs),(SELECT count(*) FROM events),(SELECT count(*) FROM audit_events)`).Scan(&values[0], &values[1], &values[2], &values[3]); err != nil {
			t.Fatal(err)
		}
		return values
	}
	before := counts()
	out := apiDecode[providers.IntegrationProbe](t, settingsProbeAPICall(s, admin, input, nil), http.StatusOK)
	if out.Status != "connected" || out.CheckedAt.IsZero() || calls.Load() != 1 {
		t.Fatalf("draft probe=%+v calls=%d", out, calls.Load())
	}
	if after := counts(); before != after {
		t.Fatalf("draft probe changed durable state: before%v after%v", before, after)
	}
}

func TestSettingsProbeAPIValidationAndSourceAuthAreSeparate(t *testing.T) {
	s := apiFixture(t)
	admin := apiUser(t, s, "probe-validator", true)
	var calls atomic.Int32
	s.Providers = settingsProbeProvider(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"private":"PROVIDER-SECRET"}`))
	})
	good := model.Integration{Name: "Draft", Kind: "grafana", URL: "http://source.example.test", PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 1, Config: map[string]string{}}
	for _, input := range []string{
		`{`, `{}`,
		`{"name":"Draft","kind":"unknown","url":"http://source.example.test"}`,
		`{"name":"Draft","kind":"grafana","url":"http://user:password@source.example.test"}`,
		`{"name":"Draft","kind":"grafana","url":"http://source.example.test","config":{"PROVIDER-SECRET":"hidden"}}`,
		`{"name":"Draft","kind":"grafana","url":"http://source.example.test","unknown":true}`,
		`{"name":"Draft","kind":"grafana","url":"http://source.example.test","concurrency":5}`,
		`{} {}`,
		strings.Repeat(" ", (2<<20)+1),
	} {
		w := settingsProbeAPICall(s, admin, input, nil)
		if w.Code != http.StatusBadRequest || bytes.Contains(w.Body.Bytes(), []byte("PROVIDER-SECRET")) {
			t.Fatalf("invalid input=%d %s", w.Code, w.Body.String())
		}
	}
	b, _ := json.Marshal(good)
	if w := settingsProbeAPICall(s, admin, string(b), map[string]string{"Content-Type": "text/plain"}); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("untyped body=%d", w.Code)
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached source")
	}
	w := settingsProbeAPICall(s, admin, string(b), nil)
	out := apiDecode[providers.IntegrationProbe](t, w, http.StatusOK)
	if out.Status != "auth" || bytes.Contains(w.Body.Bytes(), []byte("PROVIDER-SECRET")) || calls.Load() != 1 {
		t.Fatalf("source auth confused with portal auth: %+v calls=%d", out, calls.Load())
	}
}
