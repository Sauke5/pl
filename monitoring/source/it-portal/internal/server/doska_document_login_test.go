package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDoskaAnonymousDocumentLoginReturn(t *testing.T) {
	manifest := doskaGatewayTestManifest()
	for _, path := range []string{"/doska/projects", "/doska/invitations", "/doska/management", "/doska/search", "/doska/my-tasks", "/doska/overview"} {
		manifest.Routes = append(manifest.Routes, DoskaGatewayRoute{Method: "GET", Path: path, Kind: "page"})
	}
	server := &Server{Config: Config{PublicURL: "https://portal.example.test"}}
	g, e := server.newDoskaGateway(DoskaGatewayConfig{APIUpstream: "http://api.test:1337", WebUpstream: "http://web.test:8080", Key: []byte("0123456789abcdef0123456789abcdef"), Manifest: manifest, Transport: directoryRoundTrip(func(*http.Request) (*http.Response, error) {
		t.Fatal("anonymous request reached upstream")
		return nil, nil
	})})
	if e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"/doska/", "/doska/projects", "/doska/projects/p-1", "/doska/invitations", "/doska/management", "/doska/search", "/doska/my-tasks", "/doska/overview"} {
		for _, method := range []string{"GET", "HEAD"} {
			t.Run(method+path, func(t *testing.T) {
				r := httptest.NewRequest(method, "https://portal.example.test"+path+"?token=must-not-copy&taskId=t", nil)
				r.Header.Set("Accept", "text/html,application/xhtml+xml")
				w := httptest.NewRecorder()
				g.ServeHTTP(w, r)
				want := "/401?return_to=" + url.QueryEscape(path)
				if w.Code != 303 || w.Header().Get("Location") != want || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("got %d %q want303 %q", w.Code, w.Header().Get("Location"), want)
				}
				if strings.Contains(w.Body.String(), "must-not-copy") {
					t.Fatal("query credential reflected")
				}
			})
		}
	}
	for _, tc := range []struct{ method, path, accept, header, value string }{
		{"GET", "/doska/", "application/json", "", ""},
		{"GET", "/doska/api/doska/context", "text/html", "", ""},
		{"HEAD", "/doska/api/doska/context", "text/html", "", ""},
		{"GET", "/doska/assets/test-123456.js", "text/html", "", ""},
		{"GET", "/doska/unknown", "text/html", "", ""},
		{"GET", "/doska/projects/p-1/task/t", "text/html", "", ""},
		{"GET", "/doska/projects/p%2fsecret", "text/html", "", ""},
		{"GET", "/doska//projects", "text/html", "", ""},
		{"GET", "/doska/projects/../overview", "text/html", "", ""},
		{"GET", "/doska/", "text/html", "Authorization", "Bearer machine"},
		{"GET", "/doska/", "text/html", "Authorization", ""},
		{"GET", "/doska/", "text/html", "Upgrade", "websocket"},
		{"GET", "/doska/", "text/html", "Upgrade", ""},
		{"POST", "/doska/", "text/html", "", ""},
	} {
		r := httptest.NewRequest(tc.method, "https://portal.example.test"+tc.path, nil)
		r.Header.Set("Accept", tc.accept)
		if tc.header != "" {
			r.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != 401 || w.Header().Get("Location") != "" || !strings.Contains(w.Body.String(), `"error":"session_expired"`) {
			t.Fatalf("%s %s %s got%d %s", tc.method, tc.path, tc.header, w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("GET", "https://portal.example.test/doska?password=must-not-copy", nil)
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 303 || w.Header().Get("Location") != "/401?return_to=%2Fdoska%2F" {
		t.Fatalf("root alias got%d %s", w.Code, w.Header().Get("Location"))
	}
}
