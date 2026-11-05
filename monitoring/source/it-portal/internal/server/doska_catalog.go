package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var catalogTaskRoute = regexp.MustCompile(`^/doska/api/doska/projects/([A-Za-z0-9_-]{1,128})/tasks/([A-Za-z0-9_-]{1,128})/resource-links(?:/([A-Za-z0-9_-]{1,128}))?$`)
var catalogCreateRoute = regexp.MustCompile(`^/doska/api/doska/projects/([A-Za-z0-9_-]{1,128})/tasks/from-resource$`)

type catalogRoute struct{ Operation, Project, Task, Link string }

func matchCatalogRoute(r *http.Request) (catalogRoute, bool) {
	path := r.URL.Path
	v := catalogRoute{}
	if !strings.HasPrefix(path, "/doska/api/doska/") {
		return v, false
	}
	reserved := strings.HasPrefix(path, "/doska/api/doska/catalog/") || strings.Contains(path, "/resource-link-capabilities") || strings.Contains(path, "/resource-links") || strings.HasSuffix(path, "/tasks/from-resource")
	if path == "/doska/api/doska/catalog/search" && r.Method == "GET" {
		v.Operation = "search"
	}
	if path == "/doska/api/doska/catalog/resolve" && r.Method == "POST" {
		v.Operation = "resolve"
	}
	if path == "/doska/api/doska/catalog/task-links" && r.Method == "POST" {
		v.Operation = "backrefs"
	}
	if m := catalogCreateRoute.FindStringSubmatch(path); m != nil && r.Method == "POST" {
		v.Operation = "create"
		v.Project = m[1]
	}
	if m := catalogTaskRoute.FindStringSubmatch(path); m != nil {
		v.Project = m[1]
		v.Task = m[2]
		v.Link = m[3]
		if v.Link == "" {
			if r.Method == "GET" {
				v.Operation = "list"
			}
			if r.Method == "POST" {
				v.Operation = "attach"
			}
		} else if r.Method == "DELETE" {
			v.Operation = "detach"
		}
	}
	return v, reserved
}
func catalogProblem(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code}})
}

type catalogFailure struct {
	Status int
	Code   string
}

func (e *catalogFailure) Error() string { return e.Code }
func catalogFail(w http.ResponseWriter, e error) {
	var f *catalogFailure
	if errors.As(e, &f) {
		catalogProblem(w, f.Status, f.Code)
	} else {
		catalogProblem(w, 503, "temporarily_unavailable")
	}
}

// This typed lane intercepts reserved resource routes before generic dispatch.
func (g *doskaGateway) serveCatalog(w http.ResponseWriter, r *http.Request, sess session, identityValidUntil time.Time) bool {
	route, reserved := matchCatalogRoute(r)
	if !reserved {
		return false
	}
	if route.Operation == "" || r.URL.RawPath != "" || r.URL.ForceQuery || len(r.URL.RawQuery) > 4096 || r.Header.Get("Upgrade") != "" {
		catalogProblem(w, 404, "unavailable")
		return true
	}
	// Configuration enables the finite route; this lane owns stricter query
	// validation and its 400 response, rather than generic query passthrough.
	enabled := false
	for _, registered := range g.routes {
		if registered.Method == r.Method && registered.pattern.MatchString(r.URL.Path) {
			enabled = true
			break
		}
	}
	if !enabled {
		catalogProblem(w, 404, "unavailable")
		return true
	}
	if !g.acquireSlot(r.Context()) {
		catalogProblem(w, 429, "busy")
		return true
	}
	defer func() { <-g.slots }()
	deadline := time.Now().Add(30 * time.Second)
	if sess.ExpiresAt.Before(deadline) {
		deadline = sess.ExpiresAt
	}
	if identityValidUntil.Before(deadline) {
		deadline = identityValidUntil
	}
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	r = r.Clone(ctx)
	for _, h := range []string{"Content-Type", "Content-Encoding", "Idempotency-Key", "X-CSRF-Token"} {
		if len(r.Header.Values(h)) > 1 {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		catalogProblem(w, 400, "invalid_request")
		return true
	}
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<10))
	if e != nil {
		catalogProblem(w, 413, "request_too_large")
		return true
	}
	in := catalogInput{}
	if r.Method == "GET" {
		if len(data) != 0 || r.Header.Get("Idempotency-Key") != "" {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
	} else {
		media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if e != nil || media != "application/json" {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
		if !g.server.gatewayOrigin(r) || !gatewayCSRF(r, data, sess.CSRF, gatewayServiceCSRF(sess.CSRF, "doska")) {
			catalogProblem(w, 403, "csrf_failed")
			return true
		}
		if r.URL.RawQuery != "" || !catalogInputValid(route.Operation, data, &in) {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
	}
	mutation := route.Operation == "attach" || route.Operation == "detach" || route.Operation == "create"
	if mutation {
		if r.Header.Get("Idempotency-Key") != in.ClientRequestID {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
	} else if r.Header.Get("Idempotency-Key") != "" {
		catalogProblem(w, 400, "invalid_request")
		return true
	}
	if route.Operation == "search" {
		q, e := url.ParseQuery(r.URL.RawQuery)
		if e != nil {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
		for k, v := range q {
			if (k != "projectId" && k != "q" && k != "limit" && k != "cursor") || len(v) != 1 || v[0] == "" {
				catalogProblem(w, 400, "invalid_request")
				return true
			}
		}
		route.Project = q.Get("projectId")
		if !catalogID.MatchString(route.Project) || !catalogText(q.Get("q"), 1, 128) || strings.TrimSpace(q.Get("q")) == "" || len(q.Get("q")) > 512 {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
	} else if r.Method == "GET" && r.URL.RawQuery != "" {
		catalogProblem(w, 400, "invalid_request")
		return true
	}
	if route.Operation == "resolve" {
		route.Project = in.ProjectID
	}
	if route.Project != "" {
		if e = g.catalogCapabilities(r, sess, route.Project, mutation); e != nil {
			catalogFail(w, e)
			return true
		}
	}
	policy, e := g.catalogPolicy(ctx, sess.User)
	if e != nil {
		catalogFail(w, e)
		return true
	}
	var result any
	switch route.Operation {
	case "search":
		q := r.URL.Query()
		limit, e := catalogLimit(q.Get("limit"))
		if e != nil {
			catalogProblem(w, 400, "invalid_request")
			return true
		}
		cursor := catalogCursor{Subject: sess.User.ID, Project: route.Project, Query: q.Get("q"), Policy: policy.Fingerprint, Expires: time.Now().Add(300 * time.Second).Unix()}
		last := ""
		if raw := q.Get("cursor"); raw != "" {
			last, e = g.catalogCursorDecode(raw, cursor)
			if e != nil {
				catalogProblem(w, 400, "invalid_request")
				return true
			}
		}
		type item struct {
			DisplayName string           `json:"displayName"`
			ObjectKind  string           `json:"objectKind"`
			Selection   catalogSelection `json:"selection"`
		}
		items := []item{}
		var next *string
		for _, entry := range policy.Entries {
			if catalogEntryKey(entry) <= last || !strings.Contains(entry.Search, storeCatalogNormalize(q.Get("q"))) {
				continue
			}
			if len(items) == limit {
				cursor.Last = last
				n := g.catalogCursorEncode(cursor)
				next = &n
				break
			}
			items = append(items, item{entry.Descriptor.DisplayName, entry.Descriptor.ObjectKind, entry.Selection})
			last = catalogEntryKey(entry)
		}
		result = struct {
			Version    int     `json:"version"`
			Items      []item  `json:"items"`
			NextCursor *string `json:"nextCursor"`
		}{1, items, next}
	case "resolve":
		type item struct {
			Index      int                `json:"index"`
			Available  bool               `json:"available"`
			Descriptor *catalogDescriptor `json:"descriptor,omitempty"`
		}
		items := []item{}
		for i, s := range in.Selections {
			v := item{Index: i}
			if entry := policy.selection(s); entry != nil {
				v.Available = true
				v.Descriptor = &entry.Descriptor
			}
			items = append(items, v)
		}
		result = struct {
			Version int    `json:"version"`
			Items   []item `json:"items"`
		}{1, items}
	case "list":
		var links catalogLinks
		if e = g.catalogCall(r, sess, r.Method, r.URL.Path, nil, "", &links); e != nil {
			catalogFail(w, e)
			return true
		}
		if links.Version != 1 || !catalogRevision(links.Revision) || links.Links == nil || len(links.Links) > 32 {
			catalogProblem(w, 502, "invalid_upstream_response")
			return true
		}
		seen := map[string]bool{}
		refs := map[catalogRef]bool{}
		items := []catalogBrowserLink{}
		for _, link := range links.Links {
			if !catalogID.MatchString(link.LinkID) || !link.Ref.valid() || seen[link.LinkID] || refs[link.Ref] {
				catalogProblem(w, 502, "invalid_upstream_response")
				return true
			}
			seen[link.LinkID] = true
			refs[link.Ref] = true
			v := catalogBrowserLink{LinkID: link.LinkID}
			if entry := policy.ref(link.Ref); entry != nil {
				v.Available = true
				v.Descriptor = &entry.Descriptor
			}
			items = append(items, v)
		}
		result = struct {
			Version  int                  `json:"version"`
			Revision int64                `json:"revision"`
			Links    []catalogBrowserLink `json:"links"`
		}{1, *links.Revision, items}
	case "attach", "create", "detach", "backrefs":
		body := map[string]any{"version": 1}
		if route.Operation != "detach" {
			entry := policy.selection(*in.Selection)
			if entry == nil {
				catalogProblem(w, 404, "unavailable")
				return true
			}
			body["ref"] = entry.Ref
		}
		if mutation {
			body["expectedRevision"] = *in.ExpectedRevision
			body["clientRequestId"] = in.ClientRequestID
		}
		if route.Operation == "create" {
			body["task"] = in.Task
		}
		if route.Operation == "backrefs" {
			limit := 20
			if in.Limit != nil {
				limit = *in.Limit
			}
			body["limit"] = limit
			body["cursor"] = in.Cursor
			var v catalogBackrefs
			if e = g.catalogCall(r, sess, "POST", r.URL.Path, body, "", &v); e != nil {
				catalogFail(w, e)
				return true
			}
			if v.Version != 1 || v.Items == nil || len(v.Items) > limit || v.NextCursor != nil && (!catalogText(*v.NextCursor, 1, 512) || len(*v.NextCursor) > 512) {
				catalogProblem(w, 502, "invalid_upstream_response")
				return true
			}
			seen := map[string]bool{}
			for _, item := range v.Items {
				key := item.ProjectID + ":" + item.TaskID
				if !catalogID.MatchString(item.ProjectID) || !catalogID.MatchString(item.TaskID) || !catalogText(item.Title, 1, 500) || item.Href != catalogTaskHref(item.ProjectID, item.TaskID) || seen[key] {
					catalogProblem(w, 502, "invalid_upstream_response")
					return true
				}
				seen[key] = true
			}
			result = v
		} else if route.Operation == "create" {
			var v catalogCreateResult
			if e = g.catalogCall(r, sess, "POST", r.URL.Path, body, in.ClientRequestID, &v); e != nil {
				catalogFail(w, e)
				return true
			}
			if v.Version != 1 || !catalogRevision(v.Revision) || *v.Revision != 1 || !catalogID.MatchString(v.LinkID) || !catalogID.MatchString(v.TaskID) || v.ProjectID != route.Project || v.Href != catalogTaskHref(v.ProjectID, v.TaskID) {
				catalogProblem(w, 502, "invalid_upstream_response")
				return true
			}
			result = v
		} else {
			var v catalogMutation
			if e = g.catalogCall(r, sess, r.Method, r.URL.Path, body, in.ClientRequestID, &v); e != nil {
				catalogFail(w, e)
				return true
			}
			if v.Version != 1 || !catalogRevision(v.Revision) || !catalogID.MatchString(v.LinkID) || route.Operation == "detach" && v.LinkID != route.Link {
				catalogProblem(w, 502, "invalid_upstream_response")
				return true
			}
			result = v
		}
	}
	if route.Project != "" {
		if e = g.catalogCapabilities(r, sess, route.Project, false); e != nil {
			catalogFail(w, e)
			return true
		}
	}
	latest, e := g.server.readSession(r)
	if e != nil || latest.User.ID != sess.User.ID {
		catalogProblem(w, 401, "unauthenticated")
		return true
	}
	if _, e = g.identity(ctx, sess.User.ID, time.Now()); e != nil {
		catalogProblem(w, 503, "temporarily_unavailable")
		return true
	}
	current, e := g.catalogPolicy(ctx, latest.User)
	if e != nil {
		catalogFail(w, e)
		return true
	}
	if current.Fingerprint != policy.Fingerprint || latest.User.Admin != sess.User.Admin {
		catalogProblem(w, 503, "temporarily_unavailable")
		return true
	}
	if route.Project != "" {
		if e = g.catalogCapabilities(r, latest, route.Project, false); e != nil {
			catalogFail(w, e)
			return true
		}
	}
	respond(w, 200, result)
	return true
}
func storeCatalogNormalize(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(strings.ToLower(s), "ё", "е")), " ")
}

func catalogInputValid(op string, data []byte, in *catalogInput) bool {
	allowed, required := "", ""
	switch op {
	case "resolve":
		allowed = "projectId selections"
		required = allowed
	case "attach":
		allowed = "expectedRevision clientRequestId selection"
		required = allowed
	case "detach":
		allowed = "expectedRevision clientRequestId"
		required = allowed
	case "create":
		allowed = "expectedRevision clientRequestId selection task"
		required = allowed
	case "backrefs":
		allowed = "selection limit cursor"
		required = "selection"
	default:
		return false
	}
	m, e := catalogObject(data, allowed, required)
	if e != nil || catalogJSON(data, in) != nil {
		return false
	}
	for k, v := range m {
		if string(v) == "null" && k != "cursor" {
			return false
		}
	}
	if op == "resolve" {
		if !catalogID.MatchString(in.ProjectID) || len(in.Selections) < 1 || len(in.Selections) > 32 {
			return false
		}
		seen := map[catalogSelection]bool{}
		for _, s := range in.Selections {
			if !s.valid() || seen[s] {
				return false
			}
			seen[s] = true
		}
		return true
	}
	if op != "detach" && (in.Selection == nil || !in.Selection.valid()) {
		return false
	}
	if op == "backrefs" {
		return (in.Limit == nil || *in.Limit >= 1 && *in.Limit <= 50) && (in.Cursor == nil || catalogText(*in.Cursor, 1, 512) && len(*in.Cursor) <= 512)
	}
	if !catalogRevision(in.ExpectedRevision) || !catalogUUID.MatchString(in.ClientRequestID) {
		return false
	}
	return op != "create" || *in.ExpectedRevision == 0 && catalogTaskShape(in.Task)
}

func (g *doskaGateway) catalogCapabilities(r *http.Request, sess session, project string, write bool) error {
	var v catalogCapabilities
	e := g.catalogCall(r, sess, "GET", "/doska/api/doska/projects/"+project+"/resource-link-capabilities", nil, "", &v)
	if e != nil {
		return e
	}
	if v.Version != 1 || v.ReadContent == nil || v.WorkOnTasks == nil {
		return &catalogFailure{502, "invalid_upstream_response"}
	}
	if !*v.ReadContent || write && !*v.WorkOnTasks {
		return &catalogFailure{404, "unavailable"}
	}
	return nil
}
func (g *doskaGateway) catalogCall(r *http.Request, sess session, method, path string, body any, key string, out any) error {
	var data []byte
	var e error
	if body != nil {
		data, e = json.Marshal(body)
		if e != nil {
			return e
		}
	}
	u := *g.apiUpstream
	u.Path = path
	u.RawPath = ""
	u.RawQuery = ""
	u.ForceQuery = false
	req, e := http.NewRequestWithContext(r.Context(), method, u.String(), bytes.NewReader(data))
	if e != nil {
		return e
	}
	req.GetBody = nil
	unsafe := method != "GET"
	kind := doskaRouteRead
	if unsafe {
		kind = doskaRouteWrite
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", gatewayServiceCSRF(sess.CSRF, "doska"))
		req.Header.Set("Origin", g.server.Config.PublicURL)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	sourceIP := g.server.loginPeer(r)
	if net.ParseIP(sourceIP) == nil {
		return &catalogFailure{400, "invalid_request"}
	}
	public, _ := url.Parse(g.server.Config.PublicURL)
	req.Host = public.Host
	req.Header.Set("X-Forwarded-Host", public.Host)
	req.Header.Set("X-Forwarded-Proto", public.Scheme)
	req.Header.Set("X-Forwarded-Prefix", "/doska")
	req.Header.Set("X-Forwarded-For", sourceIP)
	req.Header.Set("Accept", "application/json")
	if e = signDoskaRequest(req, data, sess, kind, g.config.Key, time.Now(), unsafe, sourceIP); e != nil {
		return e
	}
	req.URL.Path = strings.TrimPrefix(path, "/doska")
	req.RequestURI = ""
	resp, e := g.transport.RoundTrip(req)
	if e != nil {
		return &catalogFailure{503, "temporarily_unavailable"}
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if e != nil || len(b) > 1<<20 {
		return &catalogFailure{502, "invalid_upstream_response"}
	}
	if resp.StatusCode != 200 {
		code := "temporarily_unavailable"
		status := resp.StatusCode
		switch status {
		case 400:
			code = "invalid_request"
		case 401:
			code = "unauthenticated"
		case 403:
			code = "forbidden"
		case 404:
			code = "unavailable"
		case 409:
			code = "revision_conflict"
			var safe struct {
				Message string `json:"message"`
				Code    string `json:"code"`
			}
			if catalogJSON(b, &safe) == nil && (safe.Message == "idempotency_conflict" || safe.Code == "idempotency_conflict") {
				code = "idempotency_conflict"
			}
		case 413:
			code = "request_too_large"
		case 429:
			code = "busy"
		default:
			status = 503
		}
		return &catalogFailure{status, code}
	}
	required := "version revision linkId"
	switch out.(type) {
	case *catalogCapabilities:
		required = "version readContent workOnTasks"
	case *catalogLinks:
		required = "version revision links"
	case *catalogCreateResult:
		required = "version revision linkId taskId projectId href"
	case *catalogBackrefs:
		required = "version items nextCursor"
	}
	if _, e = catalogObject(b, required, required); e != nil {
		return &catalogFailure{502, "invalid_upstream_response"}
	}
	media, _, e := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if e != nil || media != "application/json" || len(resp.Header.Values("Content-Type")) != 1 || resp.Header.Get("Location") != "" || catalogJSON(b, out) != nil {
		return &catalogFailure{502, "invalid_upstream_response"}
	}
	return nil
}
