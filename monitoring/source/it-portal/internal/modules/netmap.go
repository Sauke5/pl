package modules

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
)

const netMapBodyLimit = 3 << 20
const netMapResponseLimit = 32 << 20
const netMapEnvelopeLimit = 4*((netMapResponseLimit+2)/3) + (64 << 10)

var netMapRequestHeaders = map[string]bool{
	"X-Pl-Gateway-Assertion": true, "X-Pl-Gateway-Signature": true,
	"X-Csrf-Token": true, "Idempotency-Key": true, "Accept": true,
	"Cookie": true, "Origin": true, "Referer": true, "X-Csrftoken": true,
	"X-Pl-Native-Csrf-Token": true, "Accept-Language": true, "If-None-Match": true,
}
var netMapResponseHeaders = map[string]bool{
	"Set-Cookie": true, "Location": true, "Cache-Control": true, "Etag": true,
	"Last-Modified": true, "Content-Disposition": true, "Vary": true,
}

// NetMapRequestErrorCode accepts only a finite adapter validation cause with its
// matching HTTP status. Unknown bodies, fields and exception text stay private.
func NetMapRequestErrorCode(status int, body []byte) string {
	fallback := ""
	switch status {
	case http.StatusBadRequest:
		fallback = "netmap_invalid_request"
	case http.StatusConflict:
		fallback = "netmap_conflict"
	case http.StatusBadGateway:
		return "netmap_request_failed"
	default:
		return ""
	}
	if len(body) > 4096 {
		return fallback
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') || !decoder.More() {
		return fallback
	}
	field, err := decoder.Token()
	var code string
	if err != nil || field != "error" || decoder.Decode(&code) != nil || decoder.More() {
		return fallback
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || decoder.Decode(new(any)) != io.EOF {
		return fallback
	}
	allowed := map[string]int{
		"netmap_snmp_required": http.StatusBadRequest, "netmap_network_missing": http.StatusBadRequest,
		"netmap_profile_missing": http.StatusBadRequest, "netmap_invalid_network": http.StatusBadRequest,
		"netmap_invalid_profile": http.StatusBadRequest, "netmap_invalid_ssh_trust": http.StatusBadRequest,
		"netmap_invalid_observations": http.StatusBadRequest,
		"netmap_invalid_model":        http.StatusBadRequest, "netmap_invalid_snmp_community": http.StatusBadRequest,
		"netmap_network_limit": http.StatusBadRequest, "netmap_profile_limit": http.StatusBadRequest,
		"netmap_poll_running": http.StatusConflict, "netmap_idempotency_conflict": http.StatusConflict,
		"netmap_invalid_snmp_profiles": http.StatusBadRequest,
		"netmap_device_missing":        http.StatusBadRequest, "netmap_invalid_binding": http.StatusBadRequest,
		"netmap_device_changed": http.StatusConflict, "netmap_collector_not_ready": http.StatusConflict,
	}
	if allowed[code] == status {
		return code
	}
	return fallback
}

// NetMapRequest transports one exact signed request to the owned adapter. The
// persisted module identity selects the destination; endpoint URLs are ignored.
func (m *Manager) NetMapRequest(ctx context.Context, id, method, path, query, contentType string, headers http.Header, body []byte) (*http.Response, error) {
	v, err := m.applicationInstance(ctx, id)
	if err != nil || v.ModuleID != "netmap" || v.ObservedState != "running" {
		return nil, ErrApplicationUnavailable
	}
	if v.Mode == "external" {
		integration, err := m.externalNetMapIntegration(ctx, v)
		if err != nil {
			return nil, err
		}
		return m.NetMap.Request(ctx, integration, m.PublicURL, method, path, query, contentType, headers, body)
	}
	c, ok := m.Controller.(*HostController)
	if !ok {
		return nil, ErrApplicationUnavailable
	}
	return c.netMapRequest(ctx, id, method, path, query, contentType, headers, body)
}

func netMapWireString(value string, limit int) bool {
	return len(value) <= limit && !strings.ContainsFunc(value, func(r rune) bool { return unicode.IsControl(r) || r > 127 })
}

func netMapWireRequest(id, method, path, query, contentType string, headers http.Header, body []byte) (map[string]string, error) {
	if !canonicalID(id) || len(body) > netMapBodyLimit || !strings.HasPrefix(path, "/netmap/") || !netMapWireString(path, 4096) || !netMapWireString(query, 4096) || !netMapWireString(contentType, 256) || strings.ContainsAny(path, "%\\?# ") || strings.Contains(path, "//") {
		return nil, ErrApplicationUnavailable
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." || part == "." {
			return nil, ErrApplicationUnavailable
		}
	}
	if method != "GET" && method != "HEAD" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" {
		return nil, ErrApplicationUnavailable
	}
	if (method == "GET" || method == "HEAD") && (len(body) != 0 || contentType != "") {
		return nil, ErrApplicationUnavailable
	}
	if _, err := url.ParseQuery(query); err != nil {
		return nil, ErrApplicationUnavailable
	}
	selected := map[string]string{}
	for name, values := range headers {
		canonical := http.CanonicalHeaderKey(name)
		if !netMapRequestHeaders[canonical] || len(values) != 1 || !netMapWireString(values[0], 16384) {
			return nil, ErrApplicationUnavailable
		}
		if _, exists := selected[canonical]; exists {
			return nil, ErrApplicationUnavailable
		}
		selected[canonical] = values[0]
	}
	if selected["X-Pl-Gateway-Assertion"] == "" || selected["X-Pl-Gateway-Signature"] == "" {
		return nil, ErrApplicationUnavailable
	}
	return selected, nil
}

func (c *HostController) netMapRequest(ctx context.Context, id, method, path, query, contentType string, headers http.Header, body []byte) (*http.Response, error) {
	selected, err := netMapWireRequest(id, method, path, query, contentType, headers, body)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(map[string]any{"instance_id": id, "method": method, "path": path, "query": query, "content_type": contentType, "body": base64.StdEncoding.EncodeToString(body), "headers": selected})
	if err != nil {
		return nil, ErrApplicationUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	response, err := c.applicationRequest(ctx, "/v1/netmap/request", payload, bytes.NewReader(payload), int64(len(payload)), false)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, netMapEnvelopeLimit+1))
	if err != nil || response.StatusCode != http.StatusOK || len(data) > netMapEnvelopeLimit {
		return nil, ErrApplicationUnavailable
	}
	var output struct {
		InstanceID  string `json:"instance_id"`
		Status      int    `json:"status"`
		ContentType string `json:"content_type"`
		Body        string `json:"body"`
		Headers     []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"headers"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&output) != nil || decoder.Decode(new(any)) != io.EOF || output.InstanceID != id || output.Status < 200 || output.Status > 599 || !readContentType(output.ContentType) || !netMapWireString(output.ContentType, 256) || len(output.Headers) > 64 {
		return nil, ErrApplicationUnavailable
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(output.Body)
	if err != nil || len(decoded) > netMapResponseLimit || (method == "HEAD" && len(decoded) > 0) {
		return nil, ErrApplicationUnavailable
	}
	result := bufferedResponse(output.Status, output.ContentType, decoded)
	for _, header := range output.Headers {
		name := http.CanonicalHeaderKey(header.Name)
		if !netMapResponseHeaders[name] || !netMapWireString(header.Value, 8192) || (name != "Set-Cookie" && len(result.Header.Values(name)) > 0) {
			return nil, ErrApplicationUnavailable
		}
		result.Header.Add(name, header.Value)
	}
	if method != http.MethodHead && strings.HasPrefix(path, "/netmap/api/") {
		if code := NetMapRequestErrorCode(output.Status, decoded); code != "" {
			if !json.Valid(decoded) {
				return nil, ErrApplicationUnavailable
			}
			safe, _ := json.Marshal(struct {
				Error string `json:"error"`
			}{code})
			result.Body = io.NopCloser(bytes.NewReader(safe))
			result.ContentLength = int64(len(safe))
		}
	}
	return result, nil
}
