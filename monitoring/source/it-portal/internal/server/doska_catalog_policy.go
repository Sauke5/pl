package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type catalogEntry struct {
	Selection  catalogSelection  `json:"selection"`
	Descriptor catalogDescriptor `json:"descriptor"`
	Ref        catalogRef        `json:"-"`
	Search     string            `json:"-"`
}
type catalogPolicy struct {
	Entries     []catalogEntry
	Fingerprint string
}

func (p catalogPolicy) selection(s catalogSelection) *catalogEntry {
	for i := range p.Entries {
		if p.Entries[i].Selection == s {
			return &p.Entries[i]
		}
	}
	return nil
}
func (p catalogPolicy) ref(ref catalogRef) *catalogEntry {
	var found *catalogEntry
	for i := range p.Entries {
		if p.Entries[i].Ref == ref {
			if found != nil {
				return nil
			}
			found = &p.Entries[i]
		}
	}
	return found
}
func catalogEntryKey(e catalogEntry) string {
	return e.Selection.ResourceID + ":" + e.Selection.SourceKind
}

// Rebuilt from current authoritative documents on every request and again before
// response. Neither a selected UUID nor an earlier descriptor grants access.
func (g *doskaGateway) catalogPolicy(ctx context.Context, user model.User) (catalogPolicy, error) {
	p := catalogPolicy{Entries: []catalogEntry{}}
	resources, e := store.List[model.Resource](ctx, g.server.Store, "resource")
	if e != nil {
		return p, e
	}
	allowed := map[string]bool{}
	if !user.Admin {
		settings, e := store.Get[model.Settings](ctx, g.server.Store, "settings", "global")
		if e != nil {
			return p, e
		}
		if settings.BoardEnabled {
			for _, id := range settings.BoardResourceIDs {
				allowed[id] = true
			}
		}
	}
	candidates := []model.Candidate{}
	integrations := map[string]model.Integration{}
	if user.Admin {
		candidates, e = store.List[model.Candidate](ctx, g.server.Store, "candidate")
		if e != nil {
			return p, e
		}
		is, e := store.List[model.Integration](ctx, g.server.Store, "integration")
		if e != nil {
			return p, e
		}
		for _, i := range is {
			integrations[i.ID] = i
		}
	}
	// A tuple linked to more than one accepted resource is deliberately unavailable.
	tupleResources := map[catalogRef]map[string]bool{}
	active := map[string]model.Resource{}
	for _, r := range resources {
		if r.Lifecycle == "active" && catalogUUID.MatchString(r.ID) {
			active[r.ID] = r
		}
	}
	candidateRef := func(c model.Candidate) (catalogRef, bool) {
		i, ok := integrations[c.IntegrationID]
		r, exists := active[c.ResourceID]
		if !ok || !i.Enabled || i.Kind != "netbox" || !catalogUUID.MatchString(i.ID) || !exists || c.State != "linked" || c.Inventory == nil || !store.Contains(r.ExternalIDs, c.IntegrationID+":"+c.ExternalID) {
			return catalogRef{}, false
		}
		parts := strings.Split(c.ExternalID, ":")
		if len(parts) != 2 {
			return catalogRef{}, false
		}
		ref := catalogRef{1, "netbox/" + i.ID, parts[0], parts[1]}
		if !ref.valid() {
			return ref, false
		}
		return ref, true
	}
	for _, c := range candidates {
		if ref, ok := candidateRef(c); ok {
			if tupleResources[ref] == nil {
				tupleResources[ref] = map[string]bool{}
			}
			tupleResources[ref][c.ResourceID] = true
		}
	}
	for _, r := range resources {
		if _, ok := active[r.ID]; !ok || !user.Admin && !allowed[r.ID] {
			continue
		}
		name := r.Name
		search := name
		d := catalogDescriptor{DisplayName: name, ObjectKind: "resource"}
		if user.Admin {
			d.PlatformHref = "/#catalog?resourceId=" + r.ID
			if catalogText(r.Site, 0, 128) && len(r.Site) <= 512 {
				d.Site = r.Site
			}
		} else {
			d.ObjectKind = "service"
			if r.Employee != nil {
				if r.Employee.DisplayName != "" {
					name = r.Employee.DisplayName
				}
				search = name + " " + r.Employee.Description + " " + r.Employee.Category
			}
			d.DisplayName = name
		}
		if !catalogText(name, 1, 256) || len(name) > 1024 {
			continue
		}
		p.Entries = append(p.Entries, catalogEntry{catalogSelection{r.ID, "platform"}, d, catalogRef{1, "platform", "resource", r.ID}, store.Normalize(search)})
		if !user.Admin {
			continue
		}
		linked := []model.Candidate{}
		for _, c := range candidates {
			if c.ResourceID == r.ID {
				if ref, ok := candidateRef(c); ok && len(tupleResources[ref]) == 1 {
					linked = append(linked, c)
				}
			}
		}
		// Browser selection identifies the accepted resource, so multiple linked
		// device/VM observations cannot be silently chosen for that selector.
		if len(linked) != 1 {
			continue
		}
		c := linked[0]
		ref, _ := candidateRef(c)
		n := c.Inventory.Name
		if n == "" {
			n = c.Name
		}
		if !catalogText(n, 1, 256) || len(n) > 1024 {
			continue
		}
		nd := d
		nd.DisplayName = n
		nd.ObjectKind = "device"
		if ref.Type == "virtualization.virtualmachine" {
			nd.ObjectKind = "virtual_machine"
		}
		if catalogText(c.Inventory.Site, 0, 128) && len(c.Inventory.Site) <= 512 {
			nd.Site = c.Inventory.Site
		}
		if !c.LastSeen.IsZero() {
			nd.SourceObservedAt = c.LastSeen.UTC().Format(time.RFC3339)
		}
		i := integrations[c.IntegrationID]
		stale := i.LastSuccess == nil || i.Status != "ok" || time.Since(c.LastSeen) > time.Duration(max(i.PollSeconds*3, 180))*time.Second
		nd.Stale = &stale
		p.Entries = append(p.Entries, catalogEntry{catalogSelection{r.ID, "netbox"}, nd, ref, store.Normalize(n + " " + nd.Site)})
	}
	sort.Slice(p.Entries, func(i, j int) bool { return catalogEntryKey(p.Entries[i]) < catalogEntryKey(p.Entries[j]) })
	// Bind pagination to the entire current safe projection and canonical identity.
	h := sha256.New()
	for _, v := range p.Entries {
		b, _ := json.Marshal(v)
		h.Write(b)
		b, _ = json.Marshal(v.Ref)
		h.Write(b)
		h.Write([]byte(v.Search))
	}
	p.Fingerprint = hex.EncodeToString(h.Sum(nil))
	return p, nil
}

type catalogCursor struct {
	Subject string `json:"s"`
	Project string `json:"p"`
	Query   string `json:"q"`
	Policy  string `json:"a"`
	Last    string `json:"l"`
	Expires int64  `json:"e"`
}

func (g *doskaGateway) catalogCursorEncode(c catalogCursor) string {
	c.Subject = catalogCursorBinding(c)
	c.Project = ""
	c.Query = ""
	b, _ := json.Marshal(c)
	h := hmac.New(sha256.New, g.config.Key)
	h.Write([]byte("doska-catalog-cursor-v1\n"))
	h.Write(b)
	return base64.RawURLEncoding.EncodeToString(b) + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func (g *doskaGateway) catalogCursorDecode(raw string, want catalogCursor) (string, error) {
	if len(raw) > 512 {
		return "", errCatalogSchema
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return "", errCatalogSchema
	}
	b, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return "", errCatalogSchema
	}
	mac, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return "", errCatalogSchema
	}
	h := hmac.New(sha256.New, g.config.Key)
	h.Write([]byte("doska-catalog-cursor-v1\n"))
	h.Write(b)
	if !hmac.Equal(mac, h.Sum(nil)) {
		return "", errCatalogSchema
	}
	var c catalogCursor
	if catalogJSON(b, &c) != nil || c.Subject != catalogCursorBinding(want) || c.Project != "" || c.Query != "" || c.Policy != want.Policy || c.Expires < time.Now().Unix() || c.Expires > time.Now().Add(300*time.Second).Unix() {
		return "", errCatalogSchema
	}
	return c.Last, nil
}
func catalogLimit(raw string) (int, error) {
	if raw == "" {
		return 20, nil
	}
	n, e := strconv.Atoi(raw)
	if e != nil || n < 1 || n > 50 || strconv.Itoa(n) != raw {
		return 0, errors.New("invalid limit")
	}
	return n, nil
}

func catalogCursorBinding(c catalogCursor) string {
	b, _ := json.Marshal([]string{c.Subject, c.Project, c.Query})
	h := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(h[:])
}
