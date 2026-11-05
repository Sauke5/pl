package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

const (
	mailcowMaxBody    = 2 << 20
	mailcowMaxRecords = 10000
	mailcowBudget     = 10 * time.Second
)

type mailcowError string

func (e mailcowError) Error() string { return "mailcow: " + string(e) }

// MailcowErrorCode exposes only a finite cause, never an upstream body, URL or key.
func MailcowErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var e mailcowError
	if errors.As(err, &e) {
		return string(e)
	}
	return "network"
}

func mailcowTransportError(err error) error {
	var network net.Error
	switch {
	case errors.Is(err, netguard.ErrPolicyDenied):
		return mailcowError("policy")
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &network) && network.Timeout():
		return mailcowError("timeout")
	default:
		return mailcowError("network")
	}
}

// MailcowCollect performs only the native read capability of one group. The caller
// owns opt-in, scheduling, generation checks and retention of previous snapshots.
// Installed external modules and standalone external integrations use the same
// guarded native API; managed local containers are not part of this capability.
// No partial data is returned if any endpoint or field required by the group fails.
func (r *Registry) MailcowCollect(ctx context.Context, i model.Integration, group string) (json.RawMessage, error) {
	switch group {
	case "inventory", "mailboxes", "queue", "services", "storage", "rspamd":
	default:
		return nil, mailcowError("unsupported")
	}
	u, err := url.Parse(i.URL)
	if err != nil || u.Host == "" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") || i.Kind != "mailcow" || !i.Enabled || (i.ManagedModuleID != "" && i.Config["module_mode"] != "external") || r.guard == nil {
		return nil, mailcowError("policy")
	}
	guard := r.guard
	var key string
	if strings.HasPrefix(i.SecretRef, "managed:") {
		if r.MailcowCredential == nil {
			return nil, mailcowError("secret")
		}
		key, guard, err = r.MailcowCredential(ctx, i)
	} else {
		key, err = secret(i.SecretRef)
	}
	if errors.Is(err, netguard.ErrPolicyDenied) || guard == nil {
		return nil, mailcowError("policy")
	}
	if validationErr := guard.ValidateURL(u); validationErr != nil {
		return nil, mailcowError("policy")
	}
	if err != nil || key == "" || len(key) > 4096 {
		return nil, mailcowError("secret")
	}
	for _, ch := range key {
		if ch < 0x21 || ch > 0x7e {
			return nil, mailcowError("secret")
		}
	}
	budget := mailcowBudget
	if i.TimeoutSeconds > 0 && i.TimeoutSeconds < 10 {
		budget = time.Duration(i.TimeoutSeconds) * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	client := guard.Client(budget)
	// Even a same-origin redirect cannot widen the finite API capability or carry
	// X-API-Key to an endpoint selected by an upstream Location header.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	get := func(path string) (any, error) {
		switch path {
		case "status/version", "domain/all", "mailbox/all", "mailq/all", "status/containers", "status/vmail", "logs/rspamd-stats":
		default:
			return nil, mailcowError("policy")
		}
		target := *u
		target.Path = "/api/v1/get/" + path
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if e != nil {
			return nil, mailcowError("policy")
		}
		req.Header.Set("X-API-Key", key)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Accept-Encoding", "identity")
		resp, e := client.Do(req)
		if e != nil {
			return nil, mailcowTransportError(e)
		}
		defer resp.Body.Close()
		switch {
		case resp.StatusCode == 401 || resp.StatusCode == 403:
			return nil, mailcowError("auth")
		case resp.StatusCode == 404 || resp.StatusCode == 501:
			return nil, mailcowError("unsupported")
		case resp.StatusCode >= 300 && resp.StatusCode < 400:
			return nil, mailcowError("policy")
		case resp.StatusCode < 200 || resp.StatusCode >= 300:
			return nil, mailcowError("http")
		}
		if resp.ContentLength > mailcowMaxBody {
			return nil, mailcowError("body_limit")
		}
		if v := resp.Header.Get("Content-Encoding"); v != "" && v != "identity" {
			return nil, mailcowError("schema")
		}
		body, e := io.ReadAll(io.LimitReader(resp.Body, mailcowMaxBody+1))
		if e != nil {
			return nil, mailcowTransportError(e)
		}
		if len(body) > mailcowMaxBody {
			return nil, mailcowError("body_limit")
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		var value any
		if e := dec.Decode(&value); e != nil {
			return nil, mailcowError("schema")
		}
		var extra any
		if e := dec.Decode(&extra); e != io.EOF {
			return nil, mailcowError("schema")
		}
		if mailcowUpstreamError(value) {
			return nil, mailcowError("upstream")
		}
		if rows, ok := value.([]any); ok {
			for _, row := range rows {
				if mailcowUpstreamError(row) {
					return nil, mailcowError("upstream")
				}
			}
		}
		return value, nil
	}
	data, err := mailcowAggregate(group, get, time.Now())
	if err != nil {
		return nil, err
	}
	result, err := json.Marshal(data)
	if err != nil {
		return nil, mailcowError("schema")
	}
	return result, nil
}

func mailcowUpstreamError(value any) bool {
	row, ok := value.(map[string]any)
	return ok && (row["type"] == "error" || row["type"] == "danger")
}
func mailcowObject(value any) (map[string]any, error) {
	row, ok := value.(map[string]any)
	if !ok {
		return nil, mailcowError("schema")
	}
	return row, nil
}
func mailcowRows(value any) ([]map[string]any, error) {
	if obj, ok := value.(map[string]any); ok && len(obj) == 0 {
		return []map[string]any{}, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, mailcowError("schema")
	}
	if len(list) > mailcowMaxRecords {
		return nil, mailcowError("record_limit")
	}
	rows := make([]map[string]any, 0, len(list))
	for _, value := range list {
		row, err := mailcowObject(value)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
func mailcowText(value any, limit int) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" || len(text) > limit || strings.IndexFunc(text, unicode.IsControl) >= 0 {
		return "", mailcowError("schema")
	}
	return text, nil
}

var mailcowDecimal = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)?$`)

func mailcowNumeric(value any) (string, error) {
	switch v := value.(type) {
	case json.Number:
		if len(v) <= 128 {
			return string(v), nil
		}
	case string:
		if len(v) <= 128 && mailcowDecimal.MatchString(v) {
			return v, nil
		}
	}
	return "", mailcowError("schema")
}
func mailcowNumber(value any) (float64, error) {
	text, err := mailcowNumeric(value)
	if err != nil {
		return 0, err
	}
	value64, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value64) || math.IsInf(value64, 0) || value64 < 0 {
		return 0, mailcowError("schema")
	}
	return value64, nil
}
func mailcowInteger(value any) (int64, error) {
	text, err := mailcowNumeric(value)
	if err != nil {
		return 0, err
	}
	if _, err := mailcowNumber(value); err != nil {
		return 0, err
	}
	// Bound exponent expansion before constructing an exact rational.
	if index := strings.IndexAny(text, "eE"); index >= 0 {
		exponent, err := strconv.Atoi(text[index+1:])
		if err != nil || exponent < -100 || exponent > 100 {
			return 0, mailcowError("schema")
		}
	}
	// Preserve exact counts above 2^53; float64 conversion can hide fractions and
	// silently round byte counts before overflow validation.
	rational, ok := new(big.Rat).SetString(text)
	if !ok || rational.Sign() < 0 || !rational.IsInt() || !rational.Num().IsInt64() {
		return 0, mailcowError("schema")
	}
	return rational.Num().Int64(), nil
}
func mailcowActive(row map[string]any) (int64, error) {
	value, ok := row["active_int"]
	if !ok {
		value = row["active"]
	}
	if boolean, ok := value.(bool); ok {
		if boolean {
			return 1, nil
		}
		return 0, nil
	}
	active, err := mailcowInteger(value)
	if err != nil || active > 1 {
		return 0, mailcowError("schema")
	}
	return active, nil
}
func mailcowAdd(data map[string]any, field string, value int64) error {
	current, _ := data[field].(int64)
	if value > math.MaxInt64-current {
		return mailcowError("schema")
	}
	data[field] = current + value
	return nil
}
func mailcowSum(data map[string]any, field string, value any) error {
	integer, err := mailcowInteger(value)
	if err != nil {
		return err
	}
	return mailcowAdd(data, field, integer)
}
func mailcowUnique(rows []map[string]any, field string, limit int) error {
	seen := make(map[string]bool, len(rows))
	for _, row := range rows {
		identity, err := mailcowText(row[field], limit)
		if err != nil || seen[identity] {
			return mailcowError("schema")
		}
		seen[identity] = true
	}
	return nil
}

var mailcowServiceName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,80}$`)

func mailcowServices(value any) (map[string]any, error) {
	object, err := mailcowObject(value)
	if err != nil || len(object) == 0 {
		return nil, mailcowError("schema")
	}
	if len(object) > mailcowMaxRecords {
		return nil, mailcowError("record_limit")
	}
	services := make(map[string]any, len(object))
	for name, value := range object {
		if !mailcowServiceName.MatchString(name) {
			return nil, mailcowError("schema")
		}
		row, err := mailcowObject(value)
		if err != nil {
			return nil, err
		}
		if mailcowUpstreamError(row) {
			return nil, mailcowError("upstream")
		}
		state, err := mailcowText(row["state"], 40)
		if err != nil {
			return nil, err
		}
		switch state {
		case "created", "restarting", "running", "removing", "paused", "exited", "dead", "unknown":
		default:
			state = "unknown"
		}
		started, err := mailcowText(row["started_at"], 512)
		if err != nil {
			return nil, err
		}
		timestamp, err := time.Parse(time.RFC3339Nano, started)
		if err != nil {
			return nil, mailcowError("schema")
		}
		seconds := math.Max(0, float64(timestamp.Unix())+float64(timestamp.Nanosecond())/1e9)
		services[name] = map[string]any{"state": state, "started_at": seconds}
	}
	return services, nil
}

func mailcowAggregate(group string, get func(string) (any, error), now time.Time) (map[string]any, error) {
	fetchObject := func(path string) (map[string]any, error) {
		value, err := get(path)
		if err != nil {
			return nil, err
		}
		return mailcowObject(value)
	}
	fetchRows := func(path string) ([]map[string]any, error) {
		value, err := get(path)
		if err != nil {
			return nil, err
		}
		return mailcowRows(value)
	}
	switch group {
	case "inventory":
		version, err := fetchObject("status/version")
		if err != nil {
			return nil, err
		}
		text, err := mailcowText(version["version"], 120)
		if err != nil {
			return nil, err
		}
		rows, err := fetchRows("domain/all")
		if err != nil {
			return nil, err
		}
		if err := mailcowUnique(rows, "domain_name", 253); err != nil {
			return nil, err
		}
		data := map[string]any{"version": text, "domains": len(rows), "active_domains": int64(0), "mailboxes": int64(0), "used_bytes": int64(0), "messages": int64(0), "quota_limit_bytes": int64(0), "mailbox_quota_allocated_bytes": int64(0)}
		fields := map[string]string{"mailboxes": "mboxes_in_domain", "used_bytes": "bytes_total", "messages": "msgs_total", "quota_limit_bytes": "max_quota_for_domain", "mailbox_quota_allocated_bytes": "quota_used_in_domain"}
		for _, row := range rows {
			active, err := mailcowActive(row)
			if err != nil {
				return nil, err
			}
			if err := mailcowAdd(data, "active_domains", active); err != nil {
				return nil, err
			}
			for name, input := range fields {
				if err := mailcowSum(data, name, row[input]); err != nil {
					return nil, err
				}
			}
		}
		return data, nil
	case "mailboxes":
		rows, err := fetchRows("mailbox/all")
		if err != nil {
			return nil, err
		}
		if err := mailcowUnique(rows, "username", 320); err != nil {
			return nil, err
		}
		data := map[string]any{"mailboxes": len(rows), "active_mailboxes": int64(0), "quota_limit_bytes": int64(0), "used_bytes": int64(0), "messages": int64(0), "unlimited_mailboxes": int64(0), "quota_over_90_percent": int64(0)}
		for _, row := range rows {
			active, err := mailcowActive(row)
			if err != nil {
				return nil, err
			}
			quota, err := mailcowInteger(row["quota"])
			if err != nil {
				return nil, err
			}
			used, err := mailcowInteger(row["quota_used"])
			if err != nil {
				return nil, err
			}
			for key, value := range map[string]int64{"active_mailboxes": active, "quota_limit_bytes": quota, "used_bytes": used} {
				if err := mailcowAdd(data, key, value); err != nil {
					return nil, err
				}
			}
			if err := mailcowSum(data, "messages", row["messages"]); err != nil {
				return nil, err
			}
			if quota == 0 {
				_ = mailcowAdd(data, "unlimited_mailboxes", 1)
			}
			// ceil(9*quota/10), without multiplying an int64 byte count by nine.
			threshold := (quota/10)*9 + ((quota%10)*9+9)/10
			if quota > 0 && used >= threshold {
				_ = mailcowAdd(data, "quota_over_90_percent", 1)
			}
		}
		return data, nil
	case "services", "queue":
		value, err := get("status/containers")
		if err != nil {
			return nil, err
		}
		services, err := mailcowServices(value)
		if err != nil {
			return nil, err
		}
		if group == "services" {
			return map[string]any{"services": services, "limitations": []string{"Container state does not establish application readiness or ClamAV engine readiness."}}, nil
		}
		for _, name := range []string{"postfix-mailcow", "dockerapi-mailcow"} {
			service, ok := services[name].(map[string]any)
			if !ok || service["state"] != "running" {
				return nil, mailcowError("dependency")
			}
		}
		rows, err := fetchRows("mailq/all")
		if err != nil {
			return nil, err
		}
		classes := map[string]int64{}
		data := map[string]any{"messages_observed": len(rows), "bytes_observed": int64(0), "oldest_observed_age_seconds": float64(0), "by_queue": classes, "empty_ambiguous": len(rows) == 0, "possibly_truncated": len(rows) >= mailcowMaxRecords, "limitations": []string{"An empty upstream queue can also result from an internal list failure; running containers do not prove delivery health."}}
		seen := map[string]bool{}
		for _, row := range rows {
			// Queue IDs are optional across upstream versions; when present they must
			// be unique, but are never retained in the aggregate.
			if value, ok := row["queue_id"]; ok {
				identity, err := mailcowText(value, 512)
				if err != nil || seen[identity] {
					return nil, mailcowError("schema")
				}
				seen[identity] = true
			}
			class, err := mailcowText(row["queue_name"], 80)
			if err != nil {
				return nil, err
			}
			switch class {
			case "active", "deferred", "hold", "incoming", "maildrop", "corrupt":
			default:
				class = "other"
			}
			classes[class]++
			if err := mailcowSum(data, "bytes_observed", row["message_size"]); err != nil {
				return nil, err
			}
			arrival, err := mailcowNumber(row["arrival_time"])
			if err != nil {
				return nil, err
			}
			age := math.Max(0, float64(now.Unix())+float64(now.Nanosecond())/1e9-arrival)
			if age > data["oldest_observed_age_seconds"].(float64) {
				data["oldest_observed_age_seconds"] = age
			}
		}
		return data, nil
	case "storage":
		value, err := fetchObject("status/vmail")
		if err != nil {
			return nil, err
		}
		percent, err := mailcowText(value["used_percent"], 8)
		if err != nil || !strings.HasSuffix(percent, "%") {
			return nil, mailcowError("schema")
		}
		usedPercent, err := mailcowNumber(strings.TrimSuffix(percent, "%"))
		if err != nil || usedPercent > 100 {
			return nil, mailcowError("schema")
		}
		used, err := mailcowText(value["used"], 40)
		if err != nil {
			return nil, err
		}
		total, err := mailcowText(value["total"], 40)
		if err != nil {
			return nil, err
		}
		return map[string]any{"used_percent": usedPercent, "used_display": used, "total_display": total, "limitations": []string{"Mailcow returns rounded display sizes; exact filesystem byte counts are unavailable."}}, nil
	case "rspamd":
		value, err := fetchObject("logs/rspamd-stats")
		if err != nil {
			return nil, err
		}
		input, err := mailcowObject(value["actions"])
		if err != nil {
			return nil, err
		}
		if len(input) > mailcowMaxRecords {
			return nil, mailcowError("record_limit")
		}
		scanned, err := mailcowInteger(value["scanned"])
		if err != nil {
			return nil, err
		}
		actions := map[string]any{}
		for action, count := range input {
			switch action {
			case "reject", "soft reject", "rewrite subject", "add header", "greylist", "no action", "discard", "quarantine", "other":
			default:
				action = "other"
			}
			if err := mailcowSum(actions, action, count); err != nil {
				return nil, err
			}
		}
		data := map[string]any{"scanned": scanned, "actions": actions}
		// Counters are source totals: a restart/reset may legitimately decrease them.
		for _, name := range []string{"spam_count", "ham_count", "learned", "uptime"} {
			if value, ok := value[name]; ok {
				if name == "uptime" {
					number, err := mailcowNumber(value)
					if err != nil {
						return nil, err
					}
					data[name] = number
				} else {
					count, err := mailcowInteger(value)
					if err != nil {
						return nil, err
					}
					data[name] = count
				}
			}
		}
		return data, nil
	}
	return nil, mailcowError("unsupported")
}
