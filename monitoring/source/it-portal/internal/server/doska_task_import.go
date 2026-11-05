package server

import (
	"crypto/sha256"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

const doskaTaskImportPath = "/doska/api/doska/projects/{id}/task-imports"
const doskaTaskImportSchema = "task-import-v1"
const doskaTaskImportLimit = 3145728
const doskaTaskImportTimeout = 60 * time.Second

var doskaTaskImportRequestPath = regexp.MustCompile(`^/doska/api/doska/projects/[A-Za-z0-9_-]{1,128}/task-imports$`)
var doskaImportUUID = regexp.MustCompile(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var doskaImportClock = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
var doskaImportHexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func doskaTaskImportRoute(r DoskaGatewayRoute) bool {
	return r.Method == http.MethodPost && r.Path == doskaTaskImportPath && r.Kind == "write" && r.Schema == doskaTaskImportSchema && len(r.Query) == 0
}

// Uses the shared strict JSON decoder: duplicate keys, case variants, invalid
// UTF-8 and trailing JSON are rejected. The original bytes are signed/forwarded.
func doskaImportObject(v any, required, optional string) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	allowed := strings.Fields(required + " " + optional)
	for _, k := range strings.Fields(required) {
		if _, ok := m[k]; !ok {
			return nil, false
		}
	}
	for k := range m {
		found := false
		for _, a := range allowed {
			found = found || k == a
		}
		if !found {
			return nil, false
		}
	}
	return m, true
}

// ECMAScript String.trim, as used by the upstream task/label schemas.
func doskaImportTrim(s string) string {
	return strings.Trim(s, "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func doskaImportString(v any, min, max int, trim bool) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	if trim {
		s = doskaImportTrim(s)
	}
	n := len(utf16.Encode([]rune(s)))
	return n >= min && n <= max
}
func doskaImportEnum(v any, choices string) bool {
	s, ok := v.(string)
	return ok && strings.Contains(" "+choices+" ", " "+s+" ") && s != "" && !strings.Contains(s, " ")
}
func doskaImportArray(v any, max int, validate func(any) bool) bool {
	a, ok := v.([]any)
	if !ok || len(a) > max {
		return false
	}
	for _, x := range a {
		if !validate(x) {
			return false
		}
	}
	return true
}
func doskaImportID(v any, subject bool) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	if subject {
		return doskaSubjectID.MatchString(s)
	}
	return catalogID.MatchString(s)
}
func doskaImportDate(v any) bool {
	s, ok := v.(string)
	return ok && len(s) == 10 && s[0] >= '1' && s[0] <= '9' && doskaValidDate(s)
}
func doskaImportTask(v any) bool {
	m, ok := doskaImportObject(v, "title", "description columnId parentTaskId userId coexecutorIds priority cardColor startDate due labels customValues")
	if !ok || !doskaImportString(m["title"], 1, 500, true) {
		return false
	}
	colors := "blue cyan green yellow orange red pink purple"
	for k, v := range m {
		valid := true
		switch k {
		case "description":
			valid = v == nil || doskaImportString(v, 0, 100000, false)
		case "columnId":
			valid = doskaImportID(v, false)
		case "parentTaskId":
			valid = v == nil || doskaImportID(v, false)
		case "userId":
			valid = v == nil || doskaImportID(v, true)
		case "priority":
			valid = doskaImportEnum(v, "no-priority low medium high urgent")
		case "cardColor":
			valid = v == nil || doskaImportEnum(v, colors)
		case "startDate":
			valid = v == nil || doskaImportDate(v)
		case "coexecutorIds":
			seen := map[string]bool{}
			valid = doskaImportArray(v, 100, func(x any) bool {
				if !doskaImportID(x, true) {
					return false
				}
				s := x.(string)
				if seen[s] {
					return false
				}
				seen[s] = true
				return true
			})
		case "due":
			if v != nil {
				d, ok := doskaImportObject(v, "date", "time")
				valid = ok && doskaImportDate(d["date"])
				if tm, exists := d["time"]; exists {
					s, ok := tm.(string)
					valid = valid && ok && doskaImportClock.MatchString(s)
				}
			}
		case "labels":
			seen := map[string]bool{}
			valid = doskaImportArray(v, 20, func(x any) bool {
				l, ok := doskaImportObject(x, "name color", "")
				if !ok || !doskaImportString(l["name"], 1, 100, true) {
					return false
				}
				n := doskaImportTrim(l["name"].(string))
				c, ok := l["color"].(string)
				if !ok || seen[n] || !(doskaImportEnum(c, colors) || doskaImportHexColor.MatchString(c)) {
					return false
				}
				seen[n] = true
				return true
			})
		case "customValues":
			seen := map[string]bool{}
			valid = doskaImportArray(v, 100, func(x any) bool {
				c, ok := doskaImportObject(x, "fieldId value", "")
				if !ok || !doskaImportID(c["fieldId"], false) {
					return false
				}
				id := c["fieldId"].(string)
				if seen[id] {
					return false
				}
				seen[id] = true
				return c["value"] == nil || doskaImportString(c["value"], 0, 10000, false)
			})
		}
		if !valid {
			return false
		}
	}
	return true
}
func doskaTaskImportRequest(data []byte) (int, bool) {
	var value any
	if catalogJSON(data, &value) != nil {
		return 0, false
	}
	m, ok := doskaImportObject(value, "clientRequestId tasks", "")
	if !ok {
		return 0, false
	}
	id, ok := m["clientRequestId"].(string)
	if !ok || len(id) != 36 {
		return 0, false
	}
	if !doskaImportUUID.MatchString(id) {
		return 0, false
	}
	a, ok := m["tasks"].([]any)
	if !ok || len(a) < 1 || !doskaImportArray(a, 500, doskaImportTask) {
		return 0, false
	}
	return len(a), true
}
func doskaTaskImportResponse(status, count int, data []byte) bool {
	if status != http.StatusCreated {
		return status >= 400 && status <= 599
	}
	var value any
	if catalogJSON(data, &value) != nil {
		return false
	}
	m, ok := doskaImportObject(value, "taskIds imported replayed", "")
	if !ok {
		return false
	}
	n, ok := m["imported"].(float64)
	if !ok || n != float64(count) || n < 1 || n > 500 {
		return false
	}
	if _, ok := m["replayed"].(bool); !ok {
		return false
	}
	ids, ok := m["taskIds"].([]any)
	return ok && len(ids) == count && doskaImportArray(ids, 500, func(x any) bool { _, ok := x.(string); return ok })
}

// A dedicated signer preserves the generic JSON signer's independent 2 MiB
// ceiling. The digest covers the actual bounded bytes, including whitespace.
func signDoskaTaskImport(r *http.Request, body []byte, sess session, kind doskaRouteKind, key []byte, now time.Time, verified bool, sourceIP string) error {
	if r.Method != "POST" || !doskaTaskImportRequestPath.MatchString(r.URL.Path) || r.URL.RawQuery != "" || len(body) > doskaTaskImportLimit || kind != doskaRouteWrite {
		return errors.New("invalid import signing request")
	}
	digest := sha256.Sum256(body)
	return signDoskaDigest(r, digest, int64(len(body)), sess, kind, key, now, verified, sourceIP, randomToken())
}
