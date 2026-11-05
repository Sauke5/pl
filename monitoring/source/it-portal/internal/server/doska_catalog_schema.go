package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var catalogUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var catalogID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var catalogUserID = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,128}$`)
var errCatalogSchema = errors.New("invalid catalog schema")

const catalogMaxRevision int64 = 9007199254740991

type catalogSelection struct {
	ResourceID string `json:"resourceId"`
	SourceKind string `json:"sourceKind"`
}

func (s catalogSelection) valid() bool {
	return catalogUUID.MatchString(s.ResourceID) && (s.SourceKind == "platform" || s.SourceKind == "netbox")
}

type catalogRef struct {
	Version int    `json:"version"`
	Source  string `json:"source"`
	Type    string `json:"type"`
	ID      string `json:"id"`
}

func (r catalogRef) valid() bool {
	if r.Version != 1 {
		return false
	}
	if r.Source == "platform" {
		return r.Type == "resource" && catalogUUID.MatchString(r.ID)
	}
	if !strings.HasPrefix(r.Source, "netbox/") || !catalogUUID.MatchString(strings.TrimPrefix(r.Source, "netbox/")) || (r.Type != "dcim.device" && r.Type != "virtualization.virtualmachine") {
		return false
	}
	n, e := strconv.ParseInt(r.ID, 10, 32)
	return e == nil && n > 0 && strconv.FormatInt(n, 10) == r.ID
}

type catalogDescriptor struct {
	DisplayName      string `json:"displayName"`
	ObjectKind       string `json:"objectKind"`
	Site             string `json:"site,omitempty"`
	PlatformHref     string `json:"platformHref,omitempty"`
	SourceObservedAt string `json:"sourceObservedAt,omitempty"`
	Stale            *bool  `json:"stale,omitempty"`
}
type catalogCapabilities struct {
	Version     int   `json:"version"`
	ReadContent *bool `json:"readContent"`
	WorkOnTasks *bool `json:"workOnTasks"`
}
type catalogMutation struct {
	Version  int    `json:"version"`
	Revision *int64 `json:"revision"`
	LinkID   string `json:"linkId"`
}
type catalogCreateResult struct {
	Version   int    `json:"version"`
	Revision  *int64 `json:"revision"`
	LinkID    string `json:"linkId"`
	TaskID    string `json:"taskId"`
	ProjectID string `json:"projectId"`
	Href      string `json:"href"`
}
type catalogInternalLink struct {
	LinkID string     `json:"linkId"`
	Ref    catalogRef `json:"ref"`
}
type catalogLinks struct {
	Version  int                   `json:"version"`
	Revision *int64                `json:"revision"`
	Links    []catalogInternalLink `json:"links"`
}
type catalogBrowserLink struct {
	LinkID     string             `json:"linkId"`
	Available  bool               `json:"available"`
	Descriptor *catalogDescriptor `json:"descriptor,omitempty"`
}
type catalogTaskLink struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Title     string `json:"title"`
	Href      string `json:"href"`
}
type catalogBackrefs struct {
	Version    int               `json:"version"`
	Items      []catalogTaskLink `json:"items"`
	NextCursor *string           `json:"nextCursor"`
}
type catalogInput struct {
	ProjectID        string             `json:"projectId,omitempty"`
	Selections       []catalogSelection `json:"selections,omitempty"`
	Selection        *catalogSelection  `json:"selection,omitempty"`
	ExpectedRevision *int64             `json:"expectedRevision,omitempty"`
	ClientRequestID  string             `json:"clientRequestId,omitempty"`
	Task             json.RawMessage    `json:"task,omitempty"`
	Limit            *int               `json:"limit,omitempty"`
	Cursor           *string            `json:"cursor,omitempty"`
}

// The token pass rejects duplicate and case-variant keys before decoding. Go's
// DisallowUnknownFields alone matches struct fields case-insensitively.
func catalogJSON(data []byte, out any) error {
	if !utf8.Valid(data) {
		return errCatalogSchema
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var walk func(int) (any, error)
	walk = func(depth int) (any, error) {
		if depth > 24 {
			return nil, errCatalogSchema
		}
		t, e := d.Token()
		if e != nil {
			return nil, e
		}
		switch t {
		case json.Delim('{'):
			m := map[string]any{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, e
				}
				key, ok := k.(string)
				if !ok {
					return nil, errCatalogSchema
				}
				if _, ok = m[key]; ok {
					return nil, errCatalogSchema
				}
				v, e := walk(depth + 1)
				if e != nil {
					return nil, e
				}
				m[key] = v
			}
			_, e = d.Token()
			return m, e
		case json.Delim('['):
			a := []any{}
			for d.More() {
				v, e := walk(depth + 1)
				if e != nil {
					return nil, e
				}
				a = append(a, v)
			}
			_, e = d.Token()
			return a, e
		default:
			return t, nil
		}
	}
	v, e := walk(0)
	if e != nil {
		return errCatalogSchema
	}
	if _, e = d.Token(); e != io.EOF {
		return errCatalogSchema
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	d = json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e = d.Decode(out); e != nil {
		return errCatalogSchema
	}
	// Match actual JSON tag spelling, including null and optional fields.
	var shape func(any, reflect.Type) bool
	rawType := reflect.TypeOf(json.RawMessage{})
	shape = func(value any, t reflect.Type) bool {
		if t == rawType {
			return true
		}
		if t.Kind() == reflect.Pointer {
			if value == nil {
				return true
			}
			return shape(value, t.Elem())
		}
		if value == nil {
			return t.Kind() == reflect.Slice || t.Kind() == reflect.Map || t.Kind() == reflect.Interface
		}
		switch t.Kind() {
		case reflect.Struct:
			m, ok := value.(map[string]any)
			if !ok {
				return false
			}
			fields := map[string]reflect.Type{}
			for i := 0; i < t.NumField(); i++ {
				f := t.Field(i)
				name := strings.Split(f.Tag.Get("json"), ",")[0]
				if name == "" {
					name = f.Name
				}
				if name != "-" {
					fields[name] = f.Type
				}
			}
			for k, v := range m {
				ft, ok := fields[k]
				if !ok || !shape(v, ft) {
					return false
				}
			}
		case reflect.Slice:
			a, ok := value.([]any)
			if !ok {
				return false
			}
			for _, v := range a {
				if !shape(v, t.Elem()) {
					return false
				}
			}
		case reflect.Map:
			m, ok := value.(map[string]any)
			if !ok {
				return false
			}
			for _, v := range m {
				if !shape(v, t.Elem()) {
					return false
				}
			}
		}
		return true
	}
	if !shape(v, reflect.TypeOf(out).Elem()) {
		return errCatalogSchema
	}
	return nil
}
func catalogObject(data []byte, allowed, required string) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	if e := catalogJSON(data, &m); e != nil || m == nil {
		return nil, errCatalogSchema
	}
	for k := range m {
		if !strings.Contains(" "+allowed+" ", " "+k+" ") {
			return nil, errCatalogSchema
		}
	}
	for _, k := range strings.Fields(required) {
		if _, ok := m[k]; !ok {
			return nil, errCatalogSchema
		}
	}
	return m, nil
}
func catalogRevision(v *int64) bool { return v != nil && *v >= 0 && *v <= catalogMaxRevision }
func catalogText(s string, min, max int) bool {
	n := utf8.RuneCountInString(s)
	return utf8.ValidString(s) && n >= min && n <= max
}
func catalogTaskHref(project, task string) string {
	return "/doska/projects/" + project + "?taskId=" + task
}

// This is a transport shape bound. Doska retains its authoritative Zod,
// project-field rules and createTaskInTransaction validation.
func catalogTaskShape(raw []byte) bool {
	m, e := catalogObject(raw, "title description columnId labels customValues parentTaskId userId coexecutorIds priority cardColor startDate due", "title")
	if e != nil {
		return false
	}
	str := func(k string, min, max int, nullable bool) bool {
		v, ok := m[k]
		if !ok {
			return true
		}
		if nullable && string(v) == "null" {
			return true
		}
		var s string
		return json.Unmarshal(v, &s) == nil && catalogText(s, min, max)
	}
	var title string
	if json.Unmarshal(m["title"], &title) != nil || !catalogText(strings.TrimSpace(title), 1, 500) {
		return false
	}
	if !str("description", 0, 100000, true) || !str("columnId", 1, 128, false) || !str("parentTaskId", 1, 128, true) || !str("userId", 1, 128, true) || !str("priority", 1, 32, false) || !str("cardColor", 1, 32, true) || !str("startDate", 1, 32, true) {
		return false
	}
	for _, k := range []string{"columnId", "parentTaskId", "userId"} {
		if v, ok := m[k]; ok && string(v) != "null" {
			var s string
			_ = json.Unmarshal(v, &s)
			re := catalogID
			if k == "userId" {
				re = catalogUserID
			}
			if !re.MatchString(s) {
				return false
			}
		}
	}
	if v, ok := m["coexecutorIds"]; ok {
		var ids []string
		if json.Unmarshal(v, &ids) != nil || ids == nil || len(ids) > 100 {
			return false
		}
		for _, id := range ids {
			if !catalogUserID.MatchString(id) {
				return false
			}
		}
	}
	if v, ok := m["labels"]; ok {
		var a []json.RawMessage
		if json.Unmarshal(v, &a) != nil || a == nil || len(a) > 20 {
			return false
		}
		for _, x := range a {
			q, e := catalogObject(x, "name color", "name color")
			if e != nil {
				return false
			}
			for k, b := range q {
				var s string
				if json.Unmarshal(b, &s) != nil || !catalogText(s, 1, 100) {
					return false
				}
				_ = k
			}
		}
	}
	if v, ok := m["customValues"]; ok {
		var a []json.RawMessage
		if json.Unmarshal(v, &a) != nil || a == nil || len(a) > 100 {
			return false
		}
		for _, x := range a {
			q, e := catalogObject(x, "fieldId value", "fieldId value")
			if e != nil {
				return false
			}
			var id string
			if json.Unmarshal(q["fieldId"], &id) != nil || !catalogID.MatchString(id) {
				return false
			}
			if string(q["value"]) != "null" {
				var s string
				if json.Unmarshal(q["value"], &s) != nil || !catalogText(s, 0, 10000) {
					return false
				}
			}
		}
	}
	if v, ok := m["due"]; ok && string(v) != "null" {
		q, e := catalogObject(v, "date time", "date")
		if e != nil {
			return false
		}
		for _, b := range q {
			var s string
			if json.Unmarshal(b, &s) != nil || !catalogText(s, 1, 32) {
				return false
			}
		}
	}
	return true
}
