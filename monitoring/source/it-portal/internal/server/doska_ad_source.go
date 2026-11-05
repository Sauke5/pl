package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
	"pl/portal/internal/organization"
)

// DoskaADSourceConfig is a leaf configuration. Files contain an LDAP bind DN
// and password (optional final LF), are regular files with mode 0600 or tighter,
// and are read at connection time. No password is retained in this struct.
// ScopeGroupGUIDs is an explicit optional discovery allowlist, never all AD.
type DoskaADSourceConfig struct {
	URL, BaseDN, CAFile          string
	BindDNFile, BindPasswordFile string
	ScopeGroupGUIDs              []string
	MaxDiscoveryEmployees        int
}

var errDoskaADSource = errors.New("doska_ad_source_unavailable")

// LDAP_SERVER_DOMAIN_SCOPE_OID limits AD searches to this naming context and
// suppresses continuation referrals. It is critical: unsupported servers must
// reject the request rather than silently widen the result semantics.
// https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ldap/ldap-server-domain-scope-oid
const doskaADDomainScopeOID = "1.2.840.113556.1.4.1339"

type DoskaADSource struct {
	config    DoskaADSourceConfig
	directory Config
	namespace string
	base      *ldap.DN
	scope     [][16]byte
}

// NewDoskaADSource validates static configuration without opening a connection
// or reading credentials. No AD write operations exist in this adapter.
func NewDoskaADSource(c DoskaADSourceConfig) (*DoskaADSource, error) {
	u, err := url.Parse(c.URL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "ldap" && u.Scheme != "ldaps") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("invalid Doska AD URL")
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return nil, errors.New("invalid Doska AD port")
		}
	}
	base, err := ldap.ParseDN(c.BaseDN)
	if err != nil || len(base.RDNs) == 0 || len(c.BaseDN) > 2048 {
		return nil, errors.New("invalid Doska AD base")
	}
	if !filepath.IsAbs(c.BindDNFile) || !filepath.IsAbs(c.BindPasswordFile) || c.BindDNFile == c.BindPasswordFile {
		return nil, errors.New("Doska AD requires separate absolute credential file paths")
	}
	if c.MaxDiscoveryEmployees == 0 {
		c.MaxDiscoveryEmployees = organization.MaxADBatch
	}
	if c.MaxDiscoveryEmployees < 1 || c.MaxDiscoveryEmployees > organization.MaxADBatch || len(c.ScopeGroupGUIDs) > 32 {
		return nil, errors.New("invalid Doska AD discovery bound")
	}
	directory := Config{ADURL: c.URL, ADBaseDN: c.BaseDN, CAFile: c.CAFile}
	if _, err = adTLSConfig(directory, u.Hostname()); err != nil {
		return nil, errors.New("invalid Doska AD TLS configuration")
	}
	namespace := sha256.Sum256([]byte(strings.ToLower(c.BaseDN)))
	s := &DoskaADSource{config: c, directory: directory, namespace: hex.EncodeToString(namespace[:])[:16], base: base}
	seen := map[[16]byte]bool{}
	for _, value := range c.ScopeGroupGUIDs {
		b, e := hex.DecodeString(value)
		if e != nil || len(b) != 16 || hex.EncodeToString(b) != value {
			return nil, errors.New("invalid Doska AD scope group GUID")
		}
		var guid [16]byte
		copy(guid[:], b)
		if seen[guid] {
			return nil, errors.New("duplicate Doska AD scope group")
		}
		seen[guid] = true
		s.scope = append(s.scope, guid)
	}
	return s, nil
}

func (s *DoskaADSource) Namespace() string       { return s.namespace }
func (s *DoskaADSource) HasDiscoveryScope() bool { return len(s.scope) > 0 }

func doskaCredentialFile(path string, max int) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", errDoskaADSource
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > int64(max+2) {
		return "", errDoskaADSource
	}
	b, err := io.ReadAll(io.LimitReader(f, int64(max+3)))
	if err != nil {
		return "", errDoskaADSource
	}
	b = []byte(strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r"))
	if len(b) == 0 || len(b) > max || strings.ContainsAny(string(b), "\x00\r\n") {
		return "", errDoskaADSource
	}
	return string(b), nil
}

func (s *DoskaADSource) connect(ctx context.Context) (*ldap.Conn, error) {
	bind, err := doskaCredentialFile(s.config.BindDNFile, 2048)
	if err != nil {
		return nil, errDoskaADSource
	}
	if _, err = ldap.ParseDN(bind); err != nil {
		return nil, errDoskaADSource
	}
	password, err := doskaCredentialFile(s.config.BindPasswordFile, 1024)
	if err != nil {
		return nil, errDoskaADSource
	}
	conn, err := dialAD(ctx, s.directory)
	if err != nil {
		return nil, errDoskaADSource
	}
	if err = conn.Bind(bind, password); err != nil {
		conn.Close()
		return nil, errDoskaADSource
	}
	return conn, nil
}

func ldapGUIDFilter(guid [16]byte) string {
	var b strings.Builder
	for _, v := range guid {
		b.WriteByte('\\')
		b.WriteString(hex.EncodeToString([]byte{v}))
	}
	return b.String()
}

// strictSearch rejects any referral, even alongside successful entries. A
// partial/reference result must not extend a previously confirmed lease.
func (s *DoskaADSource) strictSearch(conn *ldap.Conn, base string, scope int, filter string, attrs []string, limit int) ([]*ldap.Entry, error) {
	r, err := conn.Search(ldap.NewSearchRequest(base, scope, ldap.NeverDerefAliases, limit, 4, false, filter, attrs,
		[]ldap.Control{ldap.NewControlString(doskaADDomainScopeOID, true, "")}))
	if err != nil || len(r.Referrals) > 0 || len(r.Entries) > limit {
		return nil, errDoskaADSource
	}
	for _, entry := range r.Entries {
		dn, e := ldap.ParseDN(entry.DN)
		if e != nil || (!s.base.EqualFold(dn) && !s.base.AncestorOfFold(dn)) {
			return nil, errDoskaADSource
		}
	}
	return r.Entries, nil
}

type doskaResolvedGroup struct {
	guid        [16]byte
	dn          string
	departments []string
}

func (s *DoskaADSource) resolveGroups(conn *ldap.Conn, bindings []organization.DepartmentBinding) ([]doskaResolvedGroup, error) {
	if len(bindings) > organization.MaxADBatch {
		return nil, errDoskaADSource
	}
	groups := []doskaResolvedGroup{}
	positions := map[[16]byte]int{}
	for _, binding := range bindings {
		if binding.DepartmentID == "" || binding.ObjectGUID == [16]byte{} {
			return nil, errDoskaADSource
		}
		if pos, ok := positions[binding.ObjectGUID]; ok {
			groups[pos].departments = append(groups[pos].departments, binding.DepartmentID)
			continue
		}
		dn, err := s.resolveGroup(conn, binding.ObjectGUID)
		if err != nil {
			return nil, err
		}
		positions[binding.ObjectGUID] = len(groups)
		groups = append(groups, doskaResolvedGroup{guid: binding.ObjectGUID, dn: dn, departments: []string{binding.DepartmentID}})
	}
	return groups, nil
}
func (s *DoskaADSource) resolveGroup(conn *ldap.Conn, guid [16]byte) (string, error) {
	entries, err := s.strictSearch(conn, s.config.BaseDN, ldap.ScopeWholeSubtree, "(&(objectClass=group)(objectGUID="+ldapGUIDFilter(guid)+"))", []string{"objectGUID"}, 2)
	if err != nil || len(entries) != 1 || string(entries[0].GetRawAttributeValue("objectGUID")) != string(guid[:]) {
		return "", errDoskaADSource
	}
	return entries[0].DN, nil
}

var doskaADUserAttributes = []string{"objectGUID", "displayName", "sAMAccountName", "userAccountControl", "accountExpires"}

func (s *DoskaADSource) observe(conn *ldap.Conn, entry *ldap.Entry, subject string, groups []doskaResolvedGroup, now time.Time) (organization.ADObservation, error) {
	o := organization.ADObservation{Subject: subject, Name: entry.GetAttributeValue("displayName"), ObservedAt: now, CandidateDepartmentIDs: []string{}}
	if o.Name == "" {
		o.Name = entry.GetAttributeValue("sAMAccountName")
	}
	if strings.TrimSpace(o.Name) == "" || len(o.Name) > 256 {
		return o, errDoskaADSource
	}
	flags, err := strconv.ParseUint(entry.GetAttributeValue("userAccountControl"), 10, 32)
	if err != nil {
		return o, errDoskaADSource
	}
	o.AccountState = organization.Active
	if flags&2 != 0 {
		o.AccountState = organization.Disabled
	}
	expires := entry.GetAttributeValue("accountExpires")
	if expires == "" {
		return o, errDoskaADSource
	}
	if expires != "0" && expires != "9223372036854775807" {
		n, e := strconv.ParseInt(expires, 10, 64)
		if e != nil || n < 0 {
			return o, errDoskaADSource
		}
		if n/10000000-11644473600 <= now.Unix() && o.AccountState == organization.Active {
			o.AccountState = organization.Expired
		}
	}
	set := map[string]bool{}
	for _, g := range groups {
		entries, e := s.strictSearch(conn, entry.DN, ldap.ScopeBaseObject, "(&(objectClass=user)(memberOf:"+adChainRule+":="+ldap.EscapeFilter(g.dn)+"))", []string{"1.1"}, 2)
		if e != nil || len(entries) > 1 {
			return o, errDoskaADSource
		}
		if len(entries) == 1 {
			for _, id := range g.departments {
				set[id] = true
			}
		}
	}
	for id := range set {
		o.CandidateDepartmentIDs = append(o.CandidateDepartmentIDs, id)
	}
	sort.Strings(o.CandidateDepartmentIDs)
	return o, nil
}

type doskaPlanReader struct {
	source *DoskaADSource
	groups []organization.DepartmentBinding
	now    time.Time
}

func (r doskaPlanReader) ReadIdentities(ctx context.Context, identities []organization.ADIdentity) ([]organization.ADObservation, error) {
	conn, err := r.source.connect(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	groups, err := r.source.resolveGroups(conn, r.groups)
	if err != nil {
		return nil, err
	}
	observations := make([]organization.ADObservation, 0, len(identities))
	for _, id := range identities {
		if id.Subject != "ad:"+r.source.namespace+":"+hex.EncodeToString(id.ObjectGUID[:]) {
			return nil, errDoskaADSource
		}
		entries, e := r.source.strictSearch(conn, r.source.config.BaseDN, ldap.ScopeWholeSubtree, "(&(objectClass=user)(objectGUID="+ldapGUIDFilter(id.ObjectGUID)+"))", doskaADUserAttributes, 2)
		if e != nil || len(entries) > 1 {
			return nil, errDoskaADSource
		}
		if len(entries) == 0 {
			observations = append(observations, organization.ADObservation{Subject: id.Subject, AccountState: organization.Missing, ObservedAt: r.now})
			continue
		}
		if string(entries[0].GetRawAttributeValue("objectGUID")) != string(id.ObjectGUID[:]) {
			return nil, errDoskaADSource
		}
		o, e := r.source.observe(conn, entries[0], id.Subject, groups, r.now)
		if e != nil {
			return nil, e
		}
		observations = append(observations, o)
	}
	return observations, nil
}

func (s *DoskaADSource) ReadPlan(ctx context.Context, p organization.ADRefreshPlan, now time.Time) ([]organization.ADObservation, error) {
	if p.Namespace != s.namespace || now.IsZero() {
		return nil, errDoskaADSource
	}
	return organization.ReadADBatch(ctx, doskaPlanReader{source: s, groups: p.Groups, now: now}, p.Identities)
}

// Discover reads users only through explicitly configured group membership
// filters with a hard aggregate limit. There is no unfiltered user search,
// paging beyond the configured bound, or partial-success result.
func (s *DoskaADSource) Discover(ctx context.Context, p organization.ADRefreshPlan, now time.Time) (organization.ADRefreshPlan, []organization.ADObservation, error) {
	if p.Namespace != s.namespace || now.IsZero() || len(s.scope) == 0 {
		return p, nil, errDoskaADSource
	}
	ctx, cancel := context.WithTimeout(ctx, organization.ADReadTimeout)
	defer cancel()
	conn, err := s.connect(ctx)
	if err != nil {
		return p, nil, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	groups, err := s.resolveGroups(conn, p.Groups)
	if err != nil {
		return p, nil, err
	}
	entriesByGUID := map[[16]byte]*ldap.Entry{}
	expected := map[string]uint64{}
	for _, identity := range p.Identities {
		expected[identity.Subject] = identity.Revision
	}
	for _, guid := range s.scope {
		dn, e := s.resolveGroup(conn, guid)
		if e != nil {
			return p, nil, e
		}
		entries, e := s.strictSearch(conn, s.config.BaseDN, ldap.ScopeWholeSubtree, "(&(objectClass=user)(memberOf:"+adChainRule+":="+ldap.EscapeFilter(dn)+"))", doskaADUserAttributes, s.config.MaxDiscoveryEmployees+1)
		if e != nil || len(entries) > s.config.MaxDiscoveryEmployees {
			return p, nil, errDoskaADSource
		}
		for _, entry := range entries {
			raw := entry.GetRawAttributeValue("objectGUID")
			if len(raw) != 16 {
				return p, nil, errDoskaADSource
			}
			var id [16]byte
			copy(id[:], raw)
			entriesByGUID[id] = entry
			if len(entriesByGUID) > s.config.MaxDiscoveryEmployees {
				return p, nil, errDoskaADSource
			}
		}
	}
	p.Identities = []organization.ADIdentity{}
	observations := []organization.ADObservation{}
	for guid, entry := range entriesByGUID {
		sub := "ad:" + s.namespace + ":" + hex.EncodeToString(guid[:])
		o, e := s.observe(conn, entry, sub, groups, now)
		if e != nil {
			return p, nil, e
		}
		p.Identities = append(p.Identities, organization.ADIdentity{Subject: sub, ObjectGUID: guid, Revision: expected[sub]})
		observations = append(observations, o)
	}
	if ctx.Err() != nil {
		return p, nil, errDoskaADSource
	}
	return p, observations, nil
}
