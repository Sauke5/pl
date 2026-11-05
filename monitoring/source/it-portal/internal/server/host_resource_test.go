package server

import (
	"pl/portal/internal/model"
	"testing"
)

func TestHostResourceURLIsOptionalButIdentityRequired(t *testing.T) {
	for _, typ := range []string{"Сервер", "Устройство", "Виртуальная машина", "Сетевое устройство", "storage"} {
		r := model.Resource{Name: "Host", Type: typ, Hostname: "host.example.org"}
		if err := validateResource(&r); err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
	}
	for _, r := range []model.Resource{{Name: "App", Type: "Приложение", Hostname: "host.example.org"}, {Name: "Host", Type: "Сервер"}, {Name: "Host", Type: "Сервер", Hostname: "host.example.org", URL: "javascript:alert(1)"}} {
		if validateResource(&r) == nil {
			t.Fatalf("invalid resource accepted %+v", r)
		}
	}
	r := model.Resource{Name: "Host", Type: "Сервер", IP: "10.0.0.1", URL: "https://console.example.org"}
	if err := validateResource(&r); err != nil {
		t.Fatal(err)
	}
}
