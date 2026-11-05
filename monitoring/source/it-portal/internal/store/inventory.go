package store

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

func inventoryHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if ip, _, err := net.ParseCIDR(raw); err == nil {
		return ip.String()
	}
	_, host := endpointIdentity(raw)
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}

// MatchInventoryTarget checks the entire inventory, including unaccepted objects.
// A duplicate IP in another VRF, BMC address, or short name never grants ownership.
func MatchInventoryTarget(target model.Candidate, candidates []model.Candidate, resources []model.Resource) string {
	if strings.Contains(target.Labels["instance"], "://") {
		return ""
	}
	host := inventoryHost(target.Labels["instance"])
	if host == "" || (net.ParseIP(host) == nil && !strings.Contains(host, ".")) {
		return ""
	}
	objects := map[string]model.Candidate{}
	eligible := map[string]bool{}
	for _, c := range candidates {
		if c.Inventory == nil {
			continue
		}
		inv := c.Inventory
		key := c.IntegrationID + ":" + c.ExternalID
		matched, safe := false, false
		if net.ParseIP(host) == nil && inventoryHost(inv.Hostname) == host {
			matched, safe = true, true
		}
		for _, a := range inv.Addresses {
			if inventoryHost(a.Address) == host || (net.ParseIP(host) == nil && inventoryHost(a.DNSName) == host) {
				matched = true
				if !a.ManagementOnly && !a.ObservedOnly {
					safe = true
				}
			}
		}
		if matched {
			objects[key] = c
			eligible[key] = safe
		}
	}
	if len(objects) != 1 {
		return ""
	}
	active := activeResourceMap(resources)
	for key, c := range objects {
		if !eligible[key] || c.State != "linked" {
			return ""
		}
		if r, ok := active[c.ResourceID]; ok && isHostResource(r) {
			return r.ID
		}
	}
	return ""
}

func initializeCandidateResource(r *model.Resource, c model.Candidate) {
	if inv := c.Inventory; inv != nil {
		r.Type = "Устройство"
		role := strings.ToLower(inv.Role)
		for _, word := range []string{"server", "сервер", "hypervisor", "гипервизор"} {
			if strings.Contains(role, word) {
				r.Type = "Сервер"
			}
		}
		for _, word := range []string{"switch", "router", "firewall", "коммутатор", "маршрутизатор", "сетев", "gateway"} {
			if strings.Contains(role, word) {
				r.Type = "Сетевое устройство"
			}
		}
		if inv.Kind == "virtual_machine" {
			r.Type = "Виртуальная машина"
		}
		r.URL = ""
		if inv.NetBoxURL != "" {
			r.Links = append(r.Links, model.Endpoint{Name: "NetBox", URL: inv.NetBoxURL})
		}
		r.Hostname = inv.Hostname
		if r.Hostname == "" {
			r.Hostname = inv.Name
		}
		// BMC/observed-only addresses stay in source observations, not host identity.
		for _, a := range inv.Addresses {
			if !a.ManagementOnly && !a.ObservedOnly && inventoryHost(a.Address) == inventoryHost(inv.PrimaryIP) {
				r.IP = inventoryHost(a.Address)
				r.IPSource = iExternal(c)
				break
			}
		}
		r.Site = inv.Site
		return
	}
	if c.Labels["job"] == "windows" || c.Labels["job"] == "linux" {
		host := inventoryHost(c.Labels["instance"])
		if host != "" && !strings.Contains(c.Labels["instance"], "://") {
			r.Type = "Сервер"
			r.Name = host
			r.URL = ""
			if c.Labels["job"] == "windows" {
				r.Directions = []string{"AD / Windows"}
			}
			if net.ParseIP(host) != nil {
				r.IP = host
			} else {
				r.Hostname = host
			}
		}
	}
}

// autoLinkInventory attaches source identities only. It never updates manual fields.
func autoLinkInventory(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return err
	}
	q := sqlgen.New(tx)
	docs, err := q.ListDocuments(ctx, "candidate")
	if err != nil {
		return err
	}
	candidates := []model.Candidate{}
	revisions := map[string]int64{}
	for _, d := range docs {
		c, e := Decode[model.Candidate](d.Body)
		if e != nil {
			return e
		}
		candidates = append(candidates, c)
		revisions[c.ID] = d.Revision
	}
	rdocs, err := q.ListDocuments(ctx, "resource")
	if err != nil {
		return err
	}
	resources := []model.Resource{}
	for _, d := range rdocs {
		r, e := Decode[model.Resource](document(d))
		if e != nil {
			return e
		}
		resources = append(resources, r)
	}
	integrations, err := q.ListDocuments(ctx, "integration")
	if err != nil {
		return err
	}
	kinds := map[string]string{}
	sourceByID := map[string]model.Integration{}
	for _, d := range integrations {
		i, e := Decode[model.Integration](d.Body)
		if e != nil {
			return e
		}
		kinds[i.ID] = i.Kind
		sourceByID[i.ID] = i
	}
	matching := append([]model.Candidate{}, candidates...)
	for n := range matching {
		if matching[n].Inventory != nil && !inventorySourceFresh(sourceByID[matching[n].IntegrationID], matching[n].LastSeen) {
			matching[n].State = "stale"
		}
	}
	for _, c := range candidates {
		if c.State != "pending" || kinds[c.IntegrationID] != "prometheus" || !inventorySourceFresh(sourceByID[c.IntegrationID], c.LastSeen) {
			continue
		}
		resourceID := MatchInventoryTarget(c, matching, resources)
		if resourceID == "" {
			continue
		}
		c.State = "linked"
		c.ResourceID = resourceID
		if _, err = save(ctx, tx, "candidate", c.ID, revisions[c.ID], c); err != nil {
			return err
		}
		for n := range resources {
			r := &resources[n]
			if r.ID != resourceID {
				continue
			}
			ext := iExternal(c)
			if !Contains(r.ExternalIDs, ext) {
				r.ExternalIDs = append(r.ExternalIDs, ext)
				r.UpdatedAt = time.Now().UTC()
				if _, err = save(ctx, tx, "resource", r.ID, r.Revision, *r); err != nil {
					return err
				}
				r.Revision++
			}
		}
		if err = record(ctx, tx, "discovery.auto_link", "Цель мониторинга связана с ресурсом NetBox", resourceID, "system", map[string]any{"candidate_id": c.ID}, false); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ResourceInventory(ctx context.Context, id string) (model.ResourceInventory, error) {
	out := model.ResourceInventory{ResourceID: id, Sources: []model.ResourceInventorySource{}}
	if _, err := Get[model.Resource](ctx, s, "resource", id); err != nil {
		return out, err
	}
	candidates, err := List[model.Candidate](ctx, s, "candidate")
	if err != nil {
		return out, err
	}
	integrations, err := List[model.Integration](ctx, s, "integration")
	if err != nil {
		return out, err
	}
	byID := map[string]model.Integration{}
	for _, i := range integrations {
		byID[i.ID] = i
	}
	for _, c := range candidates {
		if c.State != "linked" || c.ResourceID != id {
			continue
		}
		i, ok := byID[c.IntegrationID]
		out.Sources = append(out.Sources, model.ResourceInventorySource{CandidateID: c.ID, IntegrationID: c.IntegrationID, IntegrationName: i.Name, Kind: i.Kind, Status: i.Status, LastSeen: c.LastSeen, Stale: !ok || !inventorySourceFresh(i, c.LastSeen), Name: c.Name, URL: c.URL, Labels: c.Labels, Inventory: c.Inventory, Observation: c.Observation})
	}
	return out, nil
}

// withCandidateIdentities enriches only the matching projection, never stored resources.
func withCandidateIdentities(resources []model.Resource, candidates []model.Candidate) []model.Resource {
	out := append([]model.Resource{}, resources...)
	for n := range out {
		out[n].Aliases = append([]string{}, out[n].Aliases...)
		out[n].LinkedTargets = nil
		for _, c := range candidates {
			if c.State != "linked" || c.ResourceID != out[n].ID || c.Inventory != nil {
				continue
			}
			raw := c.Labels["instance"]
			if strings.Contains(raw, "://") {
				continue
			}
			if raw != "" && (c.Labels["job"] == "windows" || c.Labels["job"] == "linux") {
				out[n].LinkedTargets = append(out[n].LinkedTargets, c.Labels["job"]+"\x00"+strings.ToLower(strings.TrimSpace(raw)))
			}
			host := inventoryHost(raw)
			if host != "" && !Contains(out[n].Aliases, host) {
				out[n].Aliases = append(out[n].Aliases, host)
			}
		}
	}
	return out
}
func transactionCandidateIdentities(ctx context.Context, tx pgx.Tx, resources []model.Resource) ([]model.Resource, error) {
	docs, err := sqlgen.New(tx).ListDocuments(ctx, "candidate")
	if err != nil {
		return nil, err
	}
	candidates := []model.Candidate{}
	for _, d := range docs {
		c, e := Decode[model.Candidate](d.Body)
		if e != nil {
			return nil, e
		}
		candidates = append(candidates, c)
	}
	return withCandidateIdentities(resources, candidates), nil
}
func (s *Store) candidateIdentities(ctx context.Context, resources []model.Resource) ([]model.Resource, error) {
	candidates, err := List[model.Candidate](ctx, s, "candidate")
	if err != nil {
		return nil, err
	}
	return withCandidateIdentities(resources, candidates), nil
}

func initializeUniqueInventoryResource(ctx context.Context, tx pgx.Tx, r *model.Resource, c model.Candidate) error {
	initializeCandidateResource(r, c)
	if c.Inventory == nil {
		return nil
	}
	docs, err := sqlgen.New(tx).ListDocuments(ctx, "candidate")
	if err != nil {
		return err
	}
	for _, d := range docs {
		other, e := Decode[model.Candidate](d.Body)
		if e != nil {
			return e
		}
		if other.Inventory == nil || (other.IntegrationID == c.IntegrationID && other.ExternalID == c.ExternalID) {
			continue
		}
		if r.Hostname != "" && inventoryHost(other.Inventory.Hostname) == inventoryHost(r.Hostname) {
			r.Hostname = ""
		}
		for _, a := range other.Inventory.Addresses {
			if r.IP != "" && inventoryHost(a.Address) == r.IP {
				r.IP = ""
			}
		}
	}
	return nil
}

// Absence from the latest successful complete snapshot is immediately stale.
func inventorySourceFresh(i model.Integration, seen time.Time) bool {
	limit := time.Duration(i.PollSeconds*3) * time.Second
	if limit < 5*time.Minute {
		limit = 5 * time.Minute
	}
	return i.Enabled && i.Status == "connected" && i.LastSuccess != nil && !seen.Before(*i.LastSuccess) && time.Since(seen) <= limit
}

// Repeated exporters for one exact host attach to its card, preserving manual content.
func existingCandidateHost(proposed model.Resource, c model.Candidate, resources []model.Resource) (*model.Resource, bool) {
	// Stable external identity wins over mutable inventory names and addresses.
	exact := []model.Resource{}
	for _, r := range resources {
		if Contains(r.ExternalIDs, iExternal(c)) {
			if r.Lifecycle == "archived" {
				return nil, true
			}
			exact = append(exact, r)
		}
	}
	if len(exact) > 1 {
		return nil, true
	}
	if len(exact) == 1 {
		return &exact[0], false
	}
	matches := []model.Resource{}
	for _, r := range resources {
		if !isHostResource(proposed) || !isHostResource(r) || r.Lifecycle == "archived" {
			continue
		}
		proposedHost, existingHost := inventoryHost(proposed.Hostname), inventoryHost(r.Hostname)
		sameHost := proposedHost != "" && proposedHost == existingHost
		bothIPs := proposed.IP != "" && r.IP != ""
		sameIP := bothIPs && inventoryHost(proposed.IP) == inventoryHost(r.IP)
		// Conflicting addresses make even an exact name unsafe without a manual decision.
		if sameHost && bothIPs && !sameIP {
			return nil, true
		}
		sameNamespace := false
		if c.IntegrationID != "" {
			for _, external := range r.ExternalIDs {
				if strings.HasPrefix(external, c.IntegrationID+":") {
					sameNamespace = true
					break
				}
			}
		}
		// Short names are source-local identifiers; do not equate NetBox and Prometheus.
		allowedName := sameHost && (strings.Contains(proposedHost, ".") || sameNamespace)
		if sameIP || allowedName {
			matches = append(matches, r)
		}
	}
	if len(matches) > 1 {
		return nil, true
	}
	if len(matches) == 1 {
		return &matches[0], false
	}
	return nil, false
}

// CandidateResourceProposal applies the same source-to-resource normalization used
// during acceptance, without persistence or association side effects.
func CandidateResourceProposal(c model.Candidate) model.Resource {
	r := model.Resource{Name: c.Name, URL: c.URL, Type: "Приложение"}
	initializeCandidateResource(&r, c)
	return r
}

// A linked NetBox identity may own only IP; every other card field stays manual.
// Legacy nonempty IPs require explicit opt-in instead of guessing their provenance.
func refreshInventoryIP(r *model.Resource, c model.Candidate) bool {
	if c.State != "linked" || c.ResourceID != r.ID || c.Inventory == nil || r.Lifecycle == "archived" || !Contains(r.ExternalIDs, iExternal(c)) {
		return false
	}
	if r.IPSource != iExternal(c) {
		// Linking an inventory observation to a manual service does not transfer ownership.
		if r.IPSource != "" || r.IP != "" || r.Source != "discovery" || !isHostResource(*r) {
			return false
		}
	}
	proposed := CandidateResourceProposal(c)
	if proposed.IP == "" || (r.IP == proposed.IP && r.IPSource == iExternal(c)) {
		return false
	}
	r.IP, r.IPSource = proposed.IP, iExternal(c)
	return true
}

// Save and import use the manual write boundary. Older clients may omit the ownership marker;
// changing the IP still creates a durable override, including an intentional clear.
func prepareResourceIPSource(ctx context.Context, tx pgx.Tx, id string, revision int64, r *model.Resource) error {
	old := model.Resource{}
	if revision > 0 {
		d, err := sqlgen.New(tx).GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "resource", ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConflict
		}
		if err != nil {
			return translate(err)
		}
		if d.Revision != revision {
			return ErrConflict
		}
		old, err = Decode[model.Resource](d.Body)
		if err != nil {
			return err
		}
	}
	if revision > 0 && old.IP != r.IP {
		r.IPSource = "manual"
	} else if r.IPSource == "" {
		r.IPSource = old.IPSource
	}
	if r.IPSource == "" || r.IPSource == "manual" {
		return nil
	}
	// An explicit opt-in must point at an already linked, exact NetBox object.
	if r.IPSource != old.IPSource {
		docs, err := sqlgen.New(tx).ListDocuments(ctx, "candidate")
		if err != nil {
			return err
		}
		for _, d := range docs {
			c, err := Decode[model.Candidate](d.Body)
			if err != nil {
				return err
			}
			if c.State != "linked" || c.ResourceID != id || c.Inventory == nil || iExternal(c) != r.IPSource || !Contains(r.ExternalIDs, r.IPSource) {
				continue
			}
			iDoc, err := sqlgen.New(tx).GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "integration", ID: c.IntegrationID})
			if err != nil {
				return err
			}
			i, err := Decode[model.Integration](iDoc.Body)
			if err != nil {
				return err
			}
			if i.Kind == "netbox" {
				return nil
			}
		}
		return ErrInvalid
	}
	return nil
}

func refreshLinkedInventoryIPs(ctx context.Context, tx pgx.Tx, candidates []model.Candidate) error {
	q := sqlgen.New(tx)
	if len(candidates) == 0 {
		return nil
	}
	// Empty legacy cards with several linked inventory objects need explicit ownership.
	docs, err := q.ListDocuments(ctx, "candidate")
	if err != nil {
		return err
	}
	linked := map[string]int{}
	for _, d := range docs {
		c, err := Decode[model.Candidate](d.Body)
		if err != nil {
			return err
		}
		if c.State == "linked" && c.Inventory != nil {
			linked[c.ResourceID]++
		}
	}
	changed := false
	for _, c := range candidates {
		if c.State != "linked" || c.ResourceID == "" || c.Inventory == nil {
			continue
		}
		d, err := q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: "resource", ID: c.ResourceID})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return translate(err)
		}
		r, err := Decode[model.Resource](document(d))
		if err != nil {
			return err
		}
		if r.IPSource == "" && r.IP == "" && linked[r.ID] != 1 {
			continue
		}
		if !refreshInventoryIP(&r, c) {
			continue
		}
		r.UpdatedAt = time.Now().UTC()
		if _, err = save(ctx, tx, "resource", r.ID, r.Revision, r); err != nil {
			return err
		}
		if err = record(ctx, tx, "resource.inventory_ip", "Обновлён IP из NetBox", r.ID, "system", map[string]any{"external_id": iExternal(c)}, false); err != nil {
			return err
		}
		changed = true
	}
	if changed {
		return reindex(ctx, tx)
	}
	return nil
}
