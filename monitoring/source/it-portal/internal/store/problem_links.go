package store

import (
	"context"
	"errors"
	"net"
	"net/url"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

func emptyLinkConfig() model.ProblemLinkConfig {
	return model.ProblemLinkConfig{Overrides: map[string]model.ProblemLinkOverride{}, Rules: []model.ProblemLinkRule{}}
}
func (s *Store) LinkConfig(ctx context.Context) (model.ProblemLinkConfig, error) {
	c, e := Get[model.ProblemLinkConfig](ctx, s, "problem_links", "global")
	if errors.Is(e, ErrNotFound) {
		return emptyLinkConfig(), nil
	}
	return c, e
}
func endpointIdentity(raw string) (endpoint, host string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if strings.Contains(raw, "://") {
		u, e := url.Parse(raw)
		if e != nil || u.Hostname() == "" || u.User != nil {
			return "", ""
		}
		host = strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
		port := u.Port()
		if port == "" {
			if u.Scheme == "https" {
				port = "443"
			} else if u.Scheme == "http" {
				port = "80"
			}
		}
		endpoint = strings.ToLower(u.Scheme) + "://" + net.JoinHostPort(host, port) + strings.TrimRight(u.EscapedPath(), "/")
		if u.RawQuery != "" {
			endpoint += "?" + u.RawQuery
		}
		return
	}
	if h, p, e := net.SplitHostPort(raw); e == nil {
		host = strings.TrimSuffix(strings.ToLower(h), ".")
		return net.JoinHostPort(host, p), host
	}
	if strings.ContainsAny(raw, " /?=#") {
		return "", ""
	}
	if strings.Contains(raw, ":") && net.ParseIP(raw) == nil {
		return "", ""
	}
	host = strings.TrimSuffix(strings.ToLower(raw), ".")
	return "", host
}
func activeResourceMap(resources []model.Resource) map[string]model.Resource {
	active := map[string]model.Resource{}
	for _, r := range resources {
		if r.Lifecycle != "archived" {
			active[r.ID] = r
		}
	}
	return active
}
func existingIDs(ids []string, active map[string]model.Resource) []string {
	out := []string{}
	for _, id := range ids {
		if _, ok := active[id]; ok && !Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}
func ruleMatches(rule model.ProblemLinkRule, p model.Problem) bool {
	return rule.IntegrationID == p.IntegrationID && rule.Value != "" && p.Labels[rule.Label] == rule.Value && (rule.Job == "" || p.Labels["job"] == rule.Job)
}

// Exact endpoint matches outrank explicit host identities. No DNS, fuzzy names,
// substring, shared-host guessing, or inventory creation is performed here.
func ResolveProblemLinks(p model.Problem, resources []model.Resource, c model.ProblemLinkConfig) model.ProblemLinks {
	result := model.ProblemLinks{Revision: c.Revision, Mode: "auto", ResourceIDs: []string{}, Candidates: []model.ProblemLinkCandidate{}, Reason: "В каталоге пока нет однозначного совпадения с целью проверки"}
	active := activeResourceMap(resources)
	if o, ok := c.Overrides[p.ID]; ok {
		result.Mode = o.Mode
		result.ResourceIDs = existingIDs(o.ResourceIDs, active)
		result.Reason = "Связь указана вручную"
		if o.Mode == "disabled" {
			result.Reason = "Автоматическая связь отключена для этой проблемы"
		} else if len(result.ResourceIDs) != len(o.ResourceIDs) {
			result.Reason = "Связанный ресурс удалён или находится в архиве"
		}
		return result
	}
	matches := []model.ProblemLinkRule{}
	for _, rule := range c.Rules {
		if ruleMatches(rule, p) {
			matches = append(matches, rule)
		}
	}
	if len(matches) > 0 {
		// A job-specific rule is more precise than a target-only rule.
		sort.Slice(matches, func(i, j int) bool { return len(matches[i].Job) > len(matches[j].Job) })
		if len(matches) > 1 && (matches[0].Job != "") == (matches[1].Job != "") {
			result.Reason = "Подходят несколько правил связи — уточните правило"
			return result
		}
		rule := matches[0]
		result.Rule = &rule
		result.Mode = "manual"
		result.ResourceIDs = existingIDs(rule.ResourceIDs, active)
		result.Reason = "Связь задана правилом для этой цели"
		return result
	}
	if id := p.Labels["portal_resource_id"]; id != "" {
		if _, ok := active[id]; ok {
			result.ResourceIDs = []string{id}
			result.Reason = "ID ресурса указан в метке алерта"
			return result
		}
	}
	scores := map[string]int{}
	reasons := map[string]string{}
	for _, label := range []string{"instance", "target", "host", "hostname", "nodename", "node", "server", "veeam_server", "device"} {
		ep, host := endpointIdentity(p.Labels[label])
		if host == "" {
			continue
		}
		for id, r := range active {
			score, reason := 0, ""
			if label == "instance" && Contains(r.LinkedTargets, p.Labels["job"]+"\x00"+strings.ToLower(strings.TrimSpace(p.Labels[label]))) {
				score, reason = 3, "Цель Prometheus явно связана с этой карточкой"
			}
			endpoints := []string{r.URL, r.Check.Target}
			for _, e := range r.Endpoints {
				endpoints = append(endpoints, e.URL)
			}
			for _, value := range endpoints {
				rep, _ := endpointIdentity(value)
				if ep != "" && ep == rep {
					score = 3
					reason = "Точный адрес цели совпадает с адресом ресурса"
				}
			}
			for _, value := range append([]string{r.Hostname, r.IP}, r.Aliases...) {
				_, rh := endpointIdentity(value)
				if rh != "" && rh == host && score < 2 {
					score = 1
					reason = "Имя узла совпадает; принадлежность сервиса требует подтверждения"
					if isHostResource(r) && !strings.Contains(p.Labels[label], "://") {
						score = 2
						reason = "Имя узла или IP точно совпадает с карточкой оборудования"
					}
				}
			}
			if score > scores[id] {
				scores[id] = score
				reasons[id] = reason
			}
		}
	}
	best := 0
	for _, v := range scores {
		if v > best {
			best = v
		}
	}
	ids := []string{}
	for id, v := range scores {
		if v == best && v > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		result.Candidates = append(result.Candidates, model.ProblemLinkCandidate{ID: id, Name: active[id].Name, Reason: reasons[id]})
	}
	if len(ids) == 1 && best >= 2 {
		result.ResourceIDs = ids
		result.Reason = reasons[ids[0]]
	} else if len(ids) == 1 {
		result.Reason = "Найден ресурс на этом узле — подтвердите принадлежность проблемы"
	} else if len(ids) > 1 {
		result.Reason = "Цель совпадает с несколькими ресурсами — выберите нужный"
	}
	return result
}
func applyLinks(p *model.Problem, resources []model.Resource, c model.ProblemLinkConfig) {
	l := ResolveProblemLinks(*p, resources, c)
	p.ResourceIDs = l.ResourceIDs
	p.ResourceID = ""
	if len(l.ResourceIDs) > 0 {
		p.ResourceID = l.ResourceIDs[0]
	}
	p.LinkMode = l.Mode
	p.LinkReason = l.Reason
	p.LinkCandidates = []string{}
	for _, v := range l.Candidates {
		p.LinkCandidates = append(p.LinkCandidates, v.ID)
	}
}
func (s *Store) ProblemLinks(ctx context.Context, id string) (model.ProblemLinks, error) {
	p, e := Get[model.Problem](ctx, s, "problem", id)
	if e != nil {
		return model.ProblemLinks{}, e
	}
	c, e := s.LinkConfig(ctx)
	if e != nil {
		return model.ProblemLinks{}, e
	}
	resources, e := List[model.Resource](ctx, s, "resource")
	if e != nil {
		return model.ProblemLinks{}, e
	}
	resources, e = s.candidateIdentities(ctx, resources)
	if e != nil {
		return model.ProblemLinks{}, e
	}
	return ResolveProblemLinks(p, resources, c), nil
}
func (s *Store) SetProblemLinks(ctx context.Context, id string, input model.ProblemLinkUpdate, actor model.User) error {
	if input.Revision < 0 || (input.Mode != "auto" && input.Mode != "manual" && input.Mode != "disabled") || (input.Scope != "problem" && input.Scope != "target") || len(input.ResourceIDs) > 20 {
		return ErrInvalid
	}
	if input.Mode == "manual" && len(input.ResourceIDs) == 0 || input.Mode != "manual" && len(input.ResourceIDs) > 0 {
		return ErrInvalid
	}
	if input.Scope == "target" && input.Mode != "manual" {
		return ErrInvalid
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Same resource lock as archive/import so validation and saving remain coherent.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398220)"); e != nil {
		return e
	}
	var body []byte
	if e = tx.QueryRow(ctx, "SELECT body FROM documents WHERE kind='problem' AND id=$1", id).Scan(&body); e != nil {
		return translate(e)
	}
	p, e := Decode[model.Problem](body)
	if e != nil {
		return e
	}
	c := emptyLinkConfig()
	var configRevision int64
	e = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind='problem_links' AND id='global'").Scan(&configRevision, &body)
	if e == nil {
		c, e = Decode[model.ProblemLinkConfig](body)
		if e != nil {
			return e
		}
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	c.Revision = configRevision
	if c.Revision != input.Revision {
		return ErrConflict
	}
	if c.Overrides == nil {
		c.Overrides = map[string]model.ProblemLinkOverride{}
	}
	seen := map[string]bool{}
	for _, rid := range input.ResourceIDs {
		if rid == "" || seen[rid] {
			return ErrInvalid
		}
		seen[rid] = true
		if e = tx.QueryRow(ctx, "SELECT body FROM documents WHERE kind='resource' AND id=$1", rid).Scan(&body); e != nil {
			return translate(e)
		}
		r, e := Decode[model.Resource](body)
		if e != nil {
			return e
		}
		if r.Lifecycle == "archived" {
			return ErrInvalid
		}
	}
	if input.RemoveRuleID != "" {
		found := false
		rules := []model.ProblemLinkRule{}
		for _, r := range c.Rules {
			if r.ID == input.RemoveRuleID {
				if !ruleMatches(r, p) {
					return ErrInvalid
				}
				found = true
			} else {
				rules = append(rules, r)
			}
		}
		if !found {
			return ErrConflict
		}
		c.Rules = rules
	}
	if input.Scope == "target" {
		if !Contains([]string{"instance", "target", "host", "hostname", "nodename", "node", "server", "veeam_server", "device"}, input.Label) || input.Value == "" || len(input.Value) > 1024 || p.Labels[input.Label] != input.Value || (input.Job != "" && p.Labels["job"] != input.Job) {
			return ErrInvalid
		}
		rule := model.ProblemLinkRule{ID: SourceID(p.IntegrationID, input.Label+"\x00"+input.Value+"\x00"+input.Job), IntegrationID: p.IntegrationID, Label: input.Label, Value: input.Value, Job: input.Job, ResourceIDs: input.ResourceIDs}
		found := false
		for n, r := range c.Rules {
			if r.ID == rule.ID {
				c.Rules[n] = rule
				found = true
			}
		}
		if !found {
			c.Rules = append(c.Rules, rule)
		}
		delete(c.Overrides, id)
	} else if input.Mode == "auto" {
		delete(c.Overrides, id)
	} else {
		c.Overrides[id] = model.ProblemLinkOverride{Mode: input.Mode, ResourceIDs: input.ResourceIDs}
	}
	if len(c.Rules) > 1000 || len(c.Overrides) > 5000 {
		return ErrInvalid
	}
	if _, e = save(ctx, tx, "problem_links", "global", c.Revision, c); e != nil {
		return e
	}
	details := map[string]any{"problem_id": id, "mode": input.Mode, "scope": input.Scope, "resource_ids": input.ResourceIDs}
	if e = record(ctx, tx, "problem.links_changed", "Изменены связи проблемы: "+p.Title, "", actor.ID, details, true); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// IsHostResource reports infrastructure types whose management URL is optional.
func IsHostResource(r model.Resource) bool { return isHostResource(r) }

func isHostResource(r model.Resource) bool {
	return Contains([]string{"устройство", "сервер", "сетевое устройство", "хранилище", "server", "network", "storage", "host", "virtual machine", "виртуальная машина"}, strings.ToLower(strings.TrimSpace(r.Type)))
}
func transactionLinkState(ctx context.Context, tx pgx.Tx) ([]model.Resource, model.ProblemLinkConfig, error) {
	q := sqlgen.New(tx)
	docs, e := q.ListDocuments(ctx, "resource")
	if e != nil {
		return nil, model.ProblemLinkConfig{}, e
	}
	resources := []model.Resource{}
	for _, d := range docs {
		r, e := Decode[model.Resource](d.Body)
		if e != nil {
			return nil, model.ProblemLinkConfig{}, e
		}
		resources = append(resources, r)
	}
	resources, e = transactionCandidateIdentities(ctx, tx, resources)
	if e != nil {
		return nil, model.ProblemLinkConfig{}, e
	}
	c := emptyLinkConfig()
	d, e := q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "problem_links", ID: "global"})
	if e == nil {
		c, e = Decode[model.ProblemLinkConfig](d.Body)
		c.Revision = d.Revision
	} else if errors.Is(e, pgx.ErrNoRows) {
		e = nil
	}
	return resources, c, e
}
