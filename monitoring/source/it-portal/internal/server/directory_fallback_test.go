package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDirectoryUnavailableNavigation(t *testing.T) {
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "/directory/?unsafe=%3Cscript%3E", nil)
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		r.Header.Set("Sec-Fetch-Dest", "document")
		w := httptest.NewRecorder()
		if !directoryUnavailable(w, r, 502) || w.Code != 503 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %v", method, w.Code, w.Header())
		}
		if method == "HEAD" && w.Body.Len() != 0 {
			t.Fatal("HEAD body")
		}
		if method == "GET" && (!strings.Contains(w.Body.String(), "Адресная книга временно недоступна") || !strings.Contains(w.Body.String(), `href="/directory/"`) || strings.Contains(w.Body.String(), "unsafe=")) {
			t.Fatal("incorrect static fallback")
		}
	}
}
func TestDirectoryUnavailablePreservesAPIErrors(t *testing.T) {
	for _, tc := range []struct{ method, path, accept, dest string }{{"GET", "/directory/api/v1/people", "text/html", "document"}, {"GET", "/directory/", "application/json", ""}, {"POST", "/directory/", "text/html", "document"}, {"GET", "/directory/assets/app.js", "text/html", "script"}} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Accept", tc.accept)
		r.Header.Set("Sec-Fetch-Dest", tc.dest)
		w := httptest.NewRecorder()
		if directoryUnavailable(w, r, 503) || w.Body.Len() != 0 || len(w.Header()) != 0 {
			t.Fatalf("handled non-navigation: %+v", tc)
		}
	}
}
