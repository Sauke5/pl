package server

import (
	"errors"
	"net/url"
	"path"
	"pl/portal/internal/model"
	"strings"
	"unicode/utf8"
)

func validateEmployeeMetadata(v *model.EmployeeMetadata) error {
	if v == nil {
		return nil
	}
	v.DisplayName = strings.TrimSpace(v.DisplayName)
	v.Description = strings.TrimSpace(v.Description)
	v.Category = strings.TrimSpace(v.Category)
	if utf8.RuneCountInString(v.DisplayName) > 160 || utf8.RuneCountInString(v.Description) > 500 || utf8.RuneCountInString(v.Category) > 80 {
		return errors.New("Слишком длинная подпись для сотрудника")
	}
	switch v.Icon {
	case "", "app", "book", "folder", "support":
	default:
		return errors.New("Неизвестная иконка сервиса сотрудника")
	}
	return nil
}

// Only a published resource's primary URL is accepted, never request input,
// provider URLs, secondary endpoints or credentials. Absolute HTTP(S) follows
// the catalog policy; paths stay on the configured Platform origin.
func employeeNavigationURL(value, origin string) string {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\\\r\n\x00") {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || sensitiveQuery(u) {
		return ""
	}
	if u.IsAbs() {
		if !safeURL(value) {
			return ""
		}
	} else {
		if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || u.Host != "" {
			return ""
		}
		if strings.HasPrefix(u.Path, "//") || strings.ContainsAny(u.Path, "\\\r\n\x00") {
			return ""
		}
	}
	base, err := url.Parse(origin)
	if err != nil || !safeURL(origin) {
		return ""
	}
	if !u.IsAbs() || strings.EqualFold(u.Host, base.Host) {
		clean := path.Clean(u.Path)
		if clean == "/auth" || strings.HasPrefix(clean, "/auth/") || clean == "/api" || strings.HasPrefix(clean, "/api/") {
			return ""
		}
	}
	return value
}

func projectBoardResource(r model.Resource, status string, authenticated bool, origin string) map[string]any {
	item := map[string]any{"id": r.ID, "name": r.Name, "description": "", "status": status}
	if !authenticated {
		return item
	}
	if r.Icon != "" && r.Icon != "auto" && model.ValidResourceIcon(r.Icon) {
		item["resource_icon"] = r.Icon
	}
	item["url"] = serviceCardNavigationURL(r, origin)
	item["category"] = ""
	item["icon"] = "app"
	item["support"] = false
	if r.Employee != nil {
		if r.Employee.DisplayName != "" {
			item["name"] = r.Employee.DisplayName
		}
		item["description"] = r.Employee.Description
		item["category"] = r.Employee.Category
		switch r.Employee.Icon {
		case "book", "folder", "support":
			item["icon"] = r.Employee.Icon
		}
		item["support"] = r.Employee.Support
	}
	return item
}
