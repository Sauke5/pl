package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

const doskaTaskSearchPath = "/doska/api/doska/task-search"

type doskaResourceSearch struct {
	project   string
	selection catalogSelection
	policy    catalogPolicy
	ref       catalogRef
}

// The public selection is only an identifier. Resolve it against current policy;
// internal reference parameters are never accepted from a browser manifest.
func doskaResourceSearchInput(r *http.Request) (*doskaResourceSearch, error) {
	if r.URL.Path != doskaTaskSearchPath {
		return nil, nil
	}
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, errCatalogSchema
	}
	for key, values := range q {
		switch strings.ToLower(key) {
		case "resourcesource", "resourcetype", "resourceobjectid":
			return nil, errCatalogSchema
		case "resourceid", "sourcekind":
			if key != "resourceId" && key != "sourceKind" || len(values) != 1 {
				return nil, errCatalogSchema
			}
		}
	}
	_, a := q["resourceId"]
	_, b := q["sourceKind"]
	if !a && !b {
		return nil, nil
	}
	selection := catalogSelection{q.Get("resourceId"), q.Get("sourceKind")}
	if !a || !b || r.Method != http.MethodGet || !selection.valid() || len(q["projectId"]) != 1 || !catalogID.MatchString(q.Get("projectId")) {
		return nil, errCatalogSchema
	}
	return &doskaResourceSearch{project: q.Get("projectId"), selection: selection}, nil
}

func (g *doskaGateway) prepareResourceSearch(r *http.Request, sess session, s *doskaResourceSearch) error {
	p, e := g.catalogPolicy(r.Context(), sess.User)
	if e != nil {
		return e
	}
	entry := p.selection(s.selection)
	if entry == nil {
		return &catalogFailure{404, "unavailable"}
	}
	if e = g.catalogCapabilities(r, sess, s.project, false); e != nil {
		return resourceSearchFailure(e)
	}
	s.policy = p
	s.ref = entry.Ref
	return nil
}

func resourceSearchFailure(e error) error {
	var f *catalogFailure
	if errors.As(e, &f) && (f.Status == 403 || f.Status == 404) {
		return &catalogFailure{404, "unavailable"}
	}
	return e
}

func (s *doskaResourceSearch) rewrite(out *http.Request) {
	q := out.URL.Query()
	q.Del("resourceId")
	q.Del("sourceKind")
	q.Set("resourceSource", s.ref.Source)
	q.Set("resourceType", s.ref.Type)
	q.Set("resourceObjectId", s.ref.ID)
	out.URL.RawQuery = q.Encode()
}

func (g *doskaGateway) recheckResourceSearch(r *http.Request, original, latest session, s *doskaResourceSearch) error {
	p, e := g.catalogPolicy(r.Context(), latest.User)
	if e != nil {
		return e
	}
	if p.Fingerprint != s.policy.Fingerprint || latest.User.Admin != original.User.Admin {
		return &catalogFailure{503, "temporarily_unavailable"}
	}
	return resourceSearchFailure(g.catalogCapabilities(r, latest, s.project, false))
}

// Keep the existing MyTask[] payload and 16MiB JSON lane budget. Reject upstream
// errors/redirects and reserved reference fields rather than reflecting private
// provider references into browser bodies or headers.
func resourceSearchResponse(response *http.Response, data []byte) error {
	if response.StatusCode != http.StatusOK {
		if response.StatusCode >= 300 && response.StatusCode < 400 {
			return &catalogFailure{502, "invalid_upstream_response"}
		}
		if response.StatusCode == 403 || response.StatusCode == 404 {
			return &catalogFailure{404, "unavailable"}
		}
		return &catalogFailure{503, "temporarily_unavailable"}
	}
	media, _, e := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if e != nil || media != "application/json" || len(response.Header.Values("Content-Type")) != 1 || response.Header.Get("Location") != "" {
		return &catalogFailure{502, "invalid_upstream_response"}
	}
	var tasks []json.RawMessage
	if !utf8.Valid(data) || json.Unmarshal(data, &tasks) != nil || tasks == nil {
		return &catalogFailure{502, "invalid_upstream_response"}
	}
	var safe func(json.RawMessage, int) bool
	safe = func(raw json.RawMessage, depth int) bool {
		if depth > 24 {
			return false
		}
		raw = bytes.TrimSpace(raw)
		var obj map[string]json.RawMessage
		if len(raw) > 0 && raw[0] == '{' {
			if json.Unmarshal(raw, &obj) != nil {
				return false
			}
			for key, value := range obj {
				switch strings.ToLower(key) {
				case "resourcesource", "resourcetype", "resourceobjectid", "ref", "resourceref":
					return false
				}
				if !safe(value, depth+1) {
					return false
				}
			}
		} else if len(raw) > 0 && raw[0] == '[' {
			var list []json.RawMessage
			if json.Unmarshal(raw, &list) != nil {
				return false
			}
			for _, v := range list {
				if !safe(v, depth+1) {
					return false
				}
			}
		}
		return true
	}
	for _, task := range tasks {
		if len(task) == 0 || task[0] != '{' || !safe(task, 0) {
			return &catalogFailure{502, "invalid_upstream_response"}
		}
	}
	response.Header = http.Header{"Content-Type": []string{"application/json"}}
	return nil
}
