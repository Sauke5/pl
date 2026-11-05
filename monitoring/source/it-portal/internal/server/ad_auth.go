package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
	"pl/portal/internal/model"
)

// BER is used only by the AD client; configure parser bounds once before serving requests.
func init() { ber.MaxPacketLengthBytes = 1 << 20; ber.MaxNestingDepth = 32 }

var adLoginSlots = make(chan struct{}, 4)
var errADCredentials = errors.New("invalid AD credentials")
var errADUnavailable = errors.New("AD authentication unavailable")

const adChainRule = "1.2.840.113556.1.4.1941"

func (c Config) adEnabled() bool {
	return c.ADURL != "" && c.ADBaseDN != "" && c.ADUserSuffix != "" && (c.ADGroupDN != "" || c.ADGroup != "")
}
func validateADConfig(c Config) error {
	if c.ADURL == "" {
		if c.ADBaseDN != "" || c.ADGroupDN != "" || c.ADGroup != "" {
			return errors.New("PORTAL_AD_URL required for AD configuration")
		}
		return nil
	}
	if !c.adEnabled() {
		return errors.New("AD requires URL, BASE_DN, USER_SUFFIX and GROUP_DN or GROUP")
	}
	u, e := url.Parse(c.ADURL)
	if e != nil || u.Hostname() == "" || (u.Scheme != "ldap" && u.Scheme != "ldaps") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(c.ADURL, "#") || u.RawPath != "" || strings.HasSuffix(u.Host, ":") || (u.Path != "" && u.Path != "/") {
		return errors.New("PORTAL_AD_URL must be ldap:// (StartTLS) or ldaps:// without credentials or path")
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return errors.New("invalid AD port")
		}
	}
	if _, e = ldap.ParseDN(c.ADBaseDN); e != nil {
		return errors.New("invalid PORTAL_AD_BASE_DN")
	}
	if c.ADGroupDN != "" {
		if _, e = ldap.ParseDN(c.ADGroupDN); e != nil {
			return errors.New("invalid PORTAL_AD_GROUP_DN")
		}
	}
	if len(c.ADGroup) > 256 || len(c.ADBaseDN) > 2048 || len(c.ADGroupDN) > 2048 || len(c.ADUserSuffix) > 253 || strings.ContainsAny(c.ADUserSuffix, "@/\\ \t\r\n\x00") {
		return errors.New("invalid AD directory configuration")
	}
	if c.CAFile != "" || c.ADCAPEM != "" {
		if _, e = adTLSConfig(c, u.Hostname()); e != nil {
			return e
		}
	}
	return nil
}
func adTLSConfig(c Config, host string) (*tls.Config, error) {
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if c.CAFile != "" {
		b, e := os.ReadFile(c.CAFile)
		if e != nil || !roots.AppendCertsFromPEM(b) {
			return nil, errors.New("AD CA file unavailable or invalid")
		}
	}
	if c.ADCAPEM != "" && !roots.AppendCertsFromPEM([]byte(c.ADCAPEM)) {
		return nil, errors.New("AD CA certificate unavailable or invalid")
	}
	return &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, RootCAs: roots}, nil
}

// Fixed administrator-configured LDAP destination; credentials never select a host.
// Limit both total connection lifetime and inbound bytes, including TLS records.
type boundedADConn struct {
	net.Conn
	remaining int
}

func (c *boundedADConn) Read(b []byte) (int, error) {
	if c.remaining <= 0 {
		return 0, errors.New("LDAP response limit exceeded")
	}
	if len(b) > c.remaining {
		b = b[:c.remaining]
	}
	n, e := c.Conn.Read(b)
	c.remaining -= n
	return n, e
}
func dialAD(ctx context.Context, c Config) (*ldap.Conn, error) {
	u, e := url.Parse(c.ADURL)
	if e != nil {
		return nil, errADUnavailable
	}
	conf, e := adTLSConfig(c, u.Hostname())
	if e != nil {
		return nil, errADUnavailable
	}
	port := u.Port()
	if port == "" {
		port = "636"
		if u.Scheme == "ldap" {
			port = "389"
		}
	}
	raw, e := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(u.Hostname(), port))
	if e != nil {
		return nil, errADUnavailable
	}
	stopHandshake := context.AfterFunc(ctx, func() { raw.Close() })
	defer stopHandshake()
	bounded := &boundedADConn{Conn: raw, remaining: 2 << 20}
	if deadline, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(deadline)
	}
	var transport net.Conn = bounded
	if u.Scheme == "ldaps" {
		secure := tls.Client(bounded, conf)
		if e = secure.HandshakeContext(ctx); e != nil {
			raw.Close()
			return nil, errADUnavailable
		}
		transport = secure
	}
	conn := ldap.NewConn(transport, u.Scheme == "ldaps")
	conn.Start()
	conn.SetTimeout(5 * time.Second)
	if u.Scheme == "ldap" {
		if e = conn.StartTLS(conf); e != nil {
			conn.Close()
			return nil, errADUnavailable
		}
	}
	return conn, nil
}
func adUsername(raw, suffix string) (string, string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 256 || strings.ContainsAny(value, "\x00\r\n\\/") {
		return "", "", errADCredentials
	}
	local := value
	if strings.Contains(value, "@") {
		parts := strings.Split(value, "@")
		if len(parts) != 2 || parts[0] == "" || !strings.EqualFold(parts[1], suffix) {
			return "", "", errADCredentials
		}
		local = parts[0]
	}
	return local, local + "@" + suffix, nil
}
func adSearch(conn *ldap.Conn, base string, scope int, filter string, attributes []string, limit int) (*ldap.SearchResult, error) {
	result, e := conn.Search(ldap.NewSearchRequest(base, scope, ldap.NeverDerefAliases, limit, 4, false, filter, attributes, nil))
	if e != nil {
		// Do not log LDAP diagnostics, filters or credentials from the directory.
		slog.Warn("ad_directory_unavailable", "stage", "search", "scope", scope)
		return nil, errADUnavailable
	}
	// AD subtree searches commonly include supplementary references for DNS
	// naming contexts alongside the requested entry. go-ldap does not follow
	// these references. Keep the local successful entries; reference-only data
	// is not proof of identity or non-membership and must remain fail-closed.
	if len(result.Entries) == 0 && len(result.Referrals) > 0 {
		slog.Warn("ad_directory_unavailable", "stage", "search_referral_only", "scope", scope)
		return nil, errADUnavailable
	}
	return result, nil
}
func authenticateAD(ctx context.Context, c Config, username, password string) (model.User, error) {
	var user model.User
	if !c.adEnabled() {
		return user, errADUnavailable
	}
	account, upn, e := adUsername(username, c.ADUserSuffix)
	if e != nil || password == "" || len(password) > 1024 {
		return user, errADCredentials
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	conn, e := dialAD(ctx, c)
	if e != nil {
		return user, e
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	bind := func(name string) error {
		if e := conn.Bind(name, password); e != nil {
			if ldap.IsErrorWithCode(e, ldap.LDAPResultInvalidCredentials) {
				return errADCredentials
			}
			return errADUnavailable
		}
		return nil
	}
	if e = bind(upn); e != nil {
		return user, e
	}
	result, e := adSearch(conn, c.ADBaseDN, ldap.ScopeWholeSubtree, "(&(objectClass=user)(sAMAccountName="+ldap.EscapeFilter(account)+"))", []string{"objectGUID", "sAMAccountName", "displayName", "userAccountControl", "accountExpires"}, 2)
	if e != nil {
		return user, e
	}
	if len(result.Entries) != 1 {
		return user, errADCredentials
	}
	entry := result.Entries[0]
	// Prove that the resolved directory object is the account whose password was
	// supplied, even where UPN aliases differ from sAMAccountName.
	if e = bind(entry.DN); e != nil {
		return user, e
	}
	guid := entry.GetRawAttributeValue("objectGUID")
	actual := entry.GetAttributeValue("sAMAccountName")
	if len(guid) != 16 || !strings.EqualFold(actual, account) {
		return user, errADUnavailable
	}
	if e = validADAccount(entry); e != nil {
		return user, e
	}
	groupDN := c.ADGroupDN
	if groupDN == "" {
		groups, e := adSearch(conn, c.ADBaseDN, ldap.ScopeWholeSubtree, "(&(objectClass=group)(sAMAccountName="+ldap.EscapeFilter(c.ADGroup)+"))", []string{"distinguishedName"}, 2)
		if e != nil {
			return user, e
		}
		if len(groups.Entries) != 1 {
			return user, errADUnavailable
		}
		groupDN = groups.Entries[0].DN
	}
	if _, e = ldap.ParseDN(groupDN); e != nil {
		return user, errADUnavailable
	}
	membership, e := adSearch(conn, entry.DN, ldap.ScopeBaseObject, "(&(objectClass=user)(memberOf:"+adChainRule+":="+ldap.EscapeFilter(groupDN)+"))", []string{"1.1"}, 1)
	if e != nil {
		return user, e
	}
	if len(membership.Entries) > 1 {
		return user, errADUnavailable
	}
	user = model.User{ID: "ad:" + hash(strings.ToLower(c.ADBaseDN))[:16] + ":" + hex.EncodeToString(guid), Name: entry.GetAttributeValue("displayName"), Admin: len(membership.Entries) == 1}
	if user.Name == "" {
		user.Name = actual
	}
	return user, nil
}
func (s *Server) adLogin(w http.ResponseWriter, r *http.Request) {
	cfg, _, configErr := s.adConfiguration(r.Context())
	if configErr != nil {
		problem(w, 503, "login_unavailable", "Не удалось прочитать настройки входа через AD")
		return
	}
	if !cfg.adEnabled() {
		http.NotFound(w, r)
		return
	}
	if !s.sameOrigin(r) {
		problem(w, 403, "csrf", "Недопустимый источник запроса")
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		problem(w, 415, "content_type", "Ожидается application/json")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(&input); e != nil {
		problem(w, 400, "invalid_json", "Некорректный запрос входа")
		return
	}
	if d.Decode(&struct{}{}) != io.EOF || len(input.Username) > 256 || len(input.Password) > 1024 {
		problem(w, 400, "invalid_json", "Некорректный запрос входа")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	limiterUsername := input.Username
	if account, _, e := adUsername(input.Username, cfg.ADUserSuffix); e == nil {
		limiterUsername = account
	}
	select {
	case adLoginSlots <- struct{}{}:
		defer func() { <-adLoginSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		problem(w, 429, "login_rate_limited", "Вход занят. Повторите через несколько секунд.")
		return
	}
	reservation, allowed, e := s.reserveLoginAttempt(ctx, "ad:"+s.loginPeer(r), limiterUsername)
	if e != nil {
		problem(w, 503, "login_unavailable", "Вход временно недоступен")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		problem(w, 429, "login_rate_limited", "Слишком много попыток входа. Повторите через 15 минут.")
		return
	}
	user, e := authenticateAD(ctx, cfg, input.Username, input.Password)
	input.Password = ""
	if e != nil {
		if errors.Is(e, errADCredentials) {
			problem(w, 401, "invalid_credentials", localAuthFailure)
		} else {
			problem(w, 503, "login_unavailable", "AD недоступен или не удалось проверить доступ")
		}
		return
	}
	if e = s.refundLoginAttempt(ctx, reservation); e != nil {
		problem(w, 503, "login_unavailable", "Вход временно недоступен")
		return
	}
	s.observeDoskaADLogin(r.Context(), user)
	if e = s.newSession(w, r, user, time.Time{}); e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func validADAccount(entry *ldap.Entry) error {
	flags, err := strconv.ParseUint(entry.GetAttributeValue("userAccountControl"), 10, 32)
	if err != nil {
		return errADUnavailable
	}
	if flags&2 != 0 {
		return errADCredentials
	}
	if expires := entry.GetAttributeValue("accountExpires"); expires != "" && expires != "0" && expires != "9223372036854775807" {
		n, err := strconv.ParseInt(expires, 10, 64)
		if err != nil {
			return errADUnavailable
		}
		if n/10000000-11644473600 <= time.Now().Unix() {
			return errADCredentials
		}
	}
	return nil
}
