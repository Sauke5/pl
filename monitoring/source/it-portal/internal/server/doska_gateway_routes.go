package server

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// This manifest is a reviewed release artifact, never request-controlled input.
// Inventory files and arbitrary route prefixes cannot be used as a manifest.
type DoskaGatewayManifest struct {
	Version string              `json:"version"`
	Routes  []DoskaGatewayRoute `json:"routes"`
}
type DoskaGatewayRoute struct {
	Method string                       `json:"method"`
	Path   string                       `json:"path"`
	Schema string                       `json:"schema,omitempty"`
	Kind   string                       `json:"kind"` // page, asset, read, write
	Query  map[string]DoskaGatewayQuery `json:"query,omitempty"`
}
type DoskaGatewayQuery struct {
	Kind       string   `json:"kind"` // text, id, subjectid, date, integer, boolean
	Required   bool     `json:"required,omitempty"`
	Multiple   bool     `json:"multiple,omitempty"`
	MaxBytes   int      `json:"max_bytes,omitempty"`
	MaxChars   int      `json:"max_chars,omitempty"`
	AllowEmpty bool     `json:"allow_empty,omitempty"`
	Minimum    *int64   `json:"minimum,omitempty"`
	Maximum    *int64   `json:"maximum,omitempty"`
	Enum       []string `json:"enum,omitempty"`
}
type doskaCompiledRoute struct {
	DoskaGatewayRoute
	pattern *regexp.Regexp
}

var doskaSubjectID = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,128}$`)
var doskaDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// Release versions may contain dot-separated tokens; route and query IDs keep
// their independent gatewaySafeID policy.
var doskaManifestVersion = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`)

func doskaValidDate(value string) bool {
	if !doskaDate.MatchString(value) {
		return false
	}
	date, err := time.Parse("2006-01-02", value)
	return err == nil && date.Year() >= 1
}

func compileDoskaManifest(m DoskaGatewayManifest) ([]doskaCompiledRoute, error) {
	invalid := errors.New("invalid doska route manifest")
	if len(m.Version) > 128 || !doskaManifestVersion.MatchString(m.Version) || len(m.Routes) == 0 || len(m.Routes) > 1024 {
		return nil, invalid
	}
	out := make([]doskaCompiledRoute, 0, len(m.Routes))
	seen := map[string]bool{}
	for _, r := range m.Routes {
		if !strings.HasPrefix(r.Path, "/doska/") || strings.ContainsAny(r.Path, "?%\\*#") || strings.Contains(r.Path, "..") || strings.Contains(r.Path, "//") || len(r.Path) > 1024 {
			return nil, invalid
		}
		if (r.Path == doskaEventsPath || r.Kind == "events" || r.Schema == "events-v1") && (r.Path != doskaEventsPath || r.Kind != "events" || r.Schema != "events-v1" || r.Method != "GET" || len(r.Query) != 0) {
			return nil, invalid
		}
		if (strings.HasSuffix(r.Path, "/task-imports") || r.Schema == doskaTaskImportSchema) && !doskaTaskImportRoute(r) {
			return nil, invalid
		}
		attachment, attachmentOK := false, false
		if r.Kind != "events" && !doskaTaskImportRoute(r) {
			attachment, attachmentOK = doskaAttachmentRoute(r)
		}
		if attachment && !attachmentOK {
			return nil, invalid
		}
		read := r.Method == "GET" || r.Method == "HEAD"
		switch r.Kind {
		case "page", "asset":
			if !read || strings.HasPrefix(r.Path, "/doska/api/") {
				return nil, invalid
			}
			if r.Kind == "asset" && strings.ContainsAny(r.Path, "{}") {
				return nil, invalid
			}
		case "read":
			if !read || !strings.HasPrefix(r.Path, "/doska/api/") {
				return nil, invalid
			}
		case "events":
		case "upload", "download":
			if !attachmentOK {
				return nil, invalid
			}
		case "write":
			if (r.Method != "POST" && r.Method != "PUT" && r.Method != "PATCH" && r.Method != "DELETE") || !strings.HasPrefix(r.Path, "/doska/api/") {
				return nil, invalid
			}
		default:
			return nil, invalid
		}
		// Native authentication, administration and external integrations have no
		// place in this integrated release, even if copied from upstream inventory.
		first := strings.Split(strings.TrimPrefix(r.Path, "/doska/api/"), "/")[0]
		if strings.HasPrefix(r.Path, "/doska/api/") && (first == "auth" || first == "admin" || first == "oauth" || first == "mcp" || first == "import" || first == "public-project" || strings.Contains(first, "integration") || strings.Contains(first, "upload")) {
			return nil, invalid
		}
		if strings.Contains(r.Path, "upload") && !attachmentOK || strings.HasPrefix(r.Path, "/doska/api/ws/") {
			return nil, invalid
		}
		names := map[string]bool{}
		pieces := strings.Split(r.Path, "/")
		pattern := "^"
		for i, p := range pieces {
			if i > 0 {
				pattern += "/"
			}
			if strings.HasPrefix(p, "{") && strings.HasSuffix(p, "}") {
				name := strings.TrimSuffix(strings.TrimPrefix(p, "{"), "}")
				if !gatewaySafeID.MatchString(name) || names[name] {
					return nil, invalid
				}
				names[name] = true
				pattern += "[A-Za-z0-9_-]{1,128}"
			} else {
				if strings.ContainsAny(p, "{}") || !gatewayString(p, 256, true) {
					return nil, invalid
				}
				pattern += regexp.QuoteMeta(p)
			}
		}
		pattern += "$"
		key := r.Method + " " + pattern
		if seen[key] {
			return nil, invalid
		}
		seen[key] = true
		query := make(map[string]DoskaGatewayQuery, len(r.Query))
		for name, q := range r.Query {
			if !gatewaySafeID.MatchString(name) || q.MaxBytes < 0 || q.MaxBytes > 4096 || q.MaxChars < 0 || q.MaxChars > 4096 || q.Minimum != nil && q.Maximum != nil && *q.Minimum > *q.Maximum || len(q.Enum) > 100 {
				return nil, invalid
			}
			if (q.Minimum != nil || q.Maximum != nil) && q.Kind != "integer" {
				return nil, invalid
			}
			for _, value := range q.Enum {
				if !gatewayString(value, 4096, false) {
					return nil, invalid
				}
			}
			switch q.Kind {
			case "text", "id", "subjectid", "date", "integer", "boolean":
			default:
				return nil, invalid
			}
			q.Enum = append([]string(nil), q.Enum...)
			if q.Minimum != nil {
				n := *q.Minimum
				q.Minimum = &n
			}
			if q.Maximum != nil {
				n := *q.Maximum
				q.Maximum = &n
			}
			query[name] = q
		}
		r.Query = query
		out = append(out, doskaCompiledRoute{r, regexp.MustCompile(pattern)})
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.Count(out[i].Path, "{") < strings.Count(out[j].Path, "{") })
	return out, nil
}

func doskaMatchRoute(routes []doskaCompiledRoute, r *http.Request) (*doskaCompiledRoute, bool) {
	if r.URL.RawPath != "" || r.URL.ForceQuery || r.URL.Fragment != "" || strings.ContainsAny(r.URL.EscapedPath(), "%\\") || strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "//") || !gatewayString(r.URL.RequestURI(), 4096, true) {
		return nil, false
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, false
	}
	for i := range routes {
		route := &routes[i]
		if route.Method != r.Method || !route.pattern.MatchString(r.URL.Path) {
			continue
		}
		valid := true
		for name, vals := range values {
			rule, ok := route.Query[name]
			if !ok || !rule.Multiple && len(vals) != 1 || len(vals) > 32 {
				valid = false
				break
			}
			for _, value := range vals {
				max := rule.MaxBytes
				if max == 0 {
					max = 256
				}
				if value == "" && !rule.AllowEmpty || !gatewayString(value, max, false) || rule.MaxChars > 0 && utf8.RuneCountInString(value) > rule.MaxChars {
					valid = false
					break
				}
				switch rule.Kind {
				case "id":
					valid = valid && gatewaySafeID.MatchString(value)
				case "subjectid":
					valid = valid && doskaSubjectID.MatchString(value)
				case "date":
					valid = valid && doskaValidDate(value)
				case "integer":
					n, e := strconv.ParseInt(value, 10, 64)
					valid = valid && e == nil && n >= 0 && strconv.FormatInt(n, 10) == value
					if rule.Minimum != nil {
						valid = valid && n >= *rule.Minimum
					}
					if rule.Maximum != nil {
						valid = valid && n <= *rule.Maximum
					}
				case "boolean":
					valid = valid && (value == "true" || value == "false")
				}
				if len(rule.Enum) > 0 {
					found := false
					for _, item := range rule.Enum {
						found = found || item == value
					}
					valid = valid && found
				}
			}
		}
		for name, rule := range route.Query {
			if rule.Required && len(values[name]) == 0 {
				valid = false
			}
		}
		if valid {
			return route, true
		}
		// A rejected literal route cannot fall through to a broader ID template.
		return nil, false
	}
	return nil, false
}
