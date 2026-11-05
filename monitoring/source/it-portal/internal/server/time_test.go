package server

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestServerTime(t *testing.T) {
	before := time.Now()
	w := httptest.NewRecorder()
	serverTime(w, httptest.NewRequest("GET", "/api/v1/time", nil))
	var value struct {
		ServerTime string `json:"server_time"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339Nano, value.ServerTime)
	if err != nil || now.Before(before) || now.After(time.Now()) {
		t.Fatalf("invalid server time %q: %v", value.ServerTime, err)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("clock must not be cached")
	}
}
