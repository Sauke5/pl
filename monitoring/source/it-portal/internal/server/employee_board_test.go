package server

import (
	"encoding/json"
	"pl/portal/internal/model"
	"strings"
	"testing"
)

func TestEmployeeNavigationURL(t *testing.T) {
	for _, tc := range []struct {
		value   string
		allowed bool
	}{
		{"https://wiki.example.test/", true}, {"http://service.example.test:3000/", true}, {"/audit/", true},
		{"javascript:alert(1)", false}, {"data:text/html,test", false}, {"//evil.test/", false}, {"/\\evil.test", false}, {"/%2f%2fevil.test", false}, {"/%5cevil.test", false}, {"https://user:pass@example.test/", false},
		{"https://example.test/?token=secret", false}, {"/audit/?%61pi_key=secret", false}, {"https://example.test/\n", false}, {"/auth/logout", false}, {"/audit/../auth/logout", false}, {"/%61uth/logout", false}, {"/api/v1/resources", false}, {"https://portal.example.test/api/v1/session", false}, {"audit/", false}, {" https://example.test/", false},
	} {
		t.Run(tc.value, func(t *testing.T) {
			got := employeeNavigationURL(tc.value, "https://portal.example.test")
			if (got != "") != tc.allowed {
				t.Fatalf("allowed=%v, got %q", tc.allowed, got)
			}
		})
	}
}
func TestEmployeeProjectionSeparatesPublicAndInternalMetadata(t *testing.T) {
	r := model.Resource{ID: "published", Name: "Internal name", URL: "https://wiki.example.test/", Description: "PRIVATE-DESCRIPTION", IP: "192.0.2.2", Hostname: "PRIVATE-HOST", Aliases: []string{"PRIVATE-ALIAS"}, Tags: []string{"PRIVATE-TAG"}, Endpoints: []model.Endpoint{{Name: "PRIVATE-ENDPOINT", URL: "https://secret.example.test/"}}, Employee: &model.EmployeeMetadata{DisplayName: "База знаний", Description: "Публичное описание", Category: "Знания и файлы", Icon: "book", Support: true}}
	anonymous := projectBoardResource(r, "unknown", false, "https://portal.example.test")
	if len(anonymous) != 4 || anonymous["name"] != r.Name || anonymous["description"] != "" {
		t.Fatalf("anonymous projection expanded: %#v", anonymous)
	}
	employee := projectBoardResource(r, "unknown", true, "https://portal.example.test")
	if len(employee) != 8 || employee["url"] != r.URL || employee["name"] != "База знаний" || employee["description"] != "Публичное описание" || employee["support"] != true {
		t.Fatalf("employee metadata missing: %#v", employee)
	}
	for _, item := range []map[string]any{anonymous, employee} {
		raw, _ := json.Marshal(item)
		if strings.Contains(string(raw), "PRIVATE") || strings.Contains(string(raw), "192.0.2.2") {
			t.Fatalf("internal metadata leaked: %s", raw)
		}
	}
	r.URL = "javascript:alert(1)"
	r.Employee = nil
	employee = projectBoardResource(r, "unknown", true, "https://portal.example.test")
	if employee["url"] != "" || employee["name"] != r.Name || employee["description"] != "" {
		t.Fatalf("unsafe fallback: %#v", employee)
	}
}
func TestEmployeeMetadataValidation(t *testing.T) {
	if validateEmployeeMetadata(nil) != nil {
		t.Fatal("legacy metadata rejected")
	}
	for _, v := range []*model.EmployeeMetadata{{DisplayName: strings.Repeat("я", 161)}, {Description: strings.Repeat("я", 501)}, {Category: strings.Repeat("я", 81)}, {Icon: "<script>"}} {
		if validateEmployeeMetadata(v) == nil {
			t.Fatalf("invalid metadata accepted: %#v", v)
		}
	}
	v := &model.EmployeeMetadata{DisplayName: " База знаний ", Icon: "book"}
	if validateEmployeeMetadata(v) != nil || v.DisplayName != "База знаний" {
		t.Fatal("valid metadata not normalized")
	}
}
