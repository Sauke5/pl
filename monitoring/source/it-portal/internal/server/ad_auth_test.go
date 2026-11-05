package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
)

type adFixture struct {
	mu             sync.Mutex
	filters        []string
	bindNames      []string
	admin          bool
	badPassword    bool
	disabled       bool
	duplicateGroup bool
	startTLS       bool
	referralURL    string
	referralOnly   bool
	referralError  bool
	searchGate     <-chan struct{}
	searchEntered  chan<- struct{}
}

func adCertificate(t *testing.T) (tls.Certificate, string) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "AD test fixture"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	raw, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	encodedKey, e := x509.MarshalECPrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})
	cert, e := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: encodedKey}))
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "ad-ca.pem")
	if e = os.WriteFile(path, certPEM, 0600); e != nil {
		t.Fatal(e)
	}
	return cert, path
}
func ldapResult(id int64, tag ber.Tag, code int64) *ber.Packet {
	p := ber.NewSequence("LDAPMessage")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "id"))
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, tag, nil, "result")
	op.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, code, "code"))
	op.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "matchedDN"))
	op.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "diagnostic"))
	p.AppendChild(op)
	return p
}
func ldapEntry(id int64, dn string, attrs map[string]string) *ber.Packet {
	p := ber.NewSequence("LDAPMessage")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "id"))
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, 4, nil, "entry")
	op.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, dn, "dn"))
	list := ber.NewSequence("attributes")
	for k, v := range attrs {
		a := ber.NewSequence("attribute")
		a.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, k, "name"))
		values := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSet, nil, "values")
		values.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, v, "value"))
		a.AppendChild(values)
		list.AppendChild(a)
	}
	op.AppendChild(list)
	p.AppendChild(op)
	return p
}
func ldapWrite(c net.Conn, p *ber.Packet) error { _, e := c.Write(p.Bytes()); return e }
func adServer(t *testing.T, f *adFixture) Config {
	t.Helper()
	cert, ca := adCertificate(t)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { listener.Close() })
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	go func() {
		for {
			raw, e := listener.Accept()
			if e != nil {
				return
			}
			go func() {
				defer raw.Close()
				_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
				var c net.Conn = raw
				secured := !f.startTLS
				if secured {
					c = tls.Server(raw, tlsConfig)
				}
				for {
					packet, e := ber.ReadPacket(c)
					if e != nil {
						return
					}
					if len(packet.Children) != 2 {
						return
					}
					id, ok := packet.Children[0].Value.(int64)
					if !ok {
						return
					}
					op := packet.Children[1]
					switch op.Tag {
					case 23:
						if secured {
							return
						}
						if e = ldapWrite(c, ldapResult(id, 24, 0)); e != nil {
							return
						}
						c = tls.Server(raw, tlsConfig)
						secured = true
					case 0:
						if !secured {
							t.Error("credentials sent before TLS")
							return
						}
						name, _ := op.Children[1].Value.(string)
						password := op.Children[2].Data.String()
						f.mu.Lock()
						f.bindNames = append(f.bindNames, name)
						badPassword := f.badPassword
						f.mu.Unlock()
						code := int64(0)
						if badPassword || password != "fixture-password" {
							code = 49
						}
						if e = ldapWrite(c, ldapResult(id, 1, code)); e != nil {
							return
						}
					case 3:
						filter, e := ldap.DecompileFilter(op.Children[6])
						if e != nil {
							t.Error(e)
							return
						}
						f.mu.Lock()
						f.filters = append(f.filters, filter)
						referralError, referralOnly, referralURL := f.referralError, f.referralOnly, f.referralURL
						admin, disabled, duplicateGroup := f.admin, f.disabled, f.duplicateGroup
						gate, entered := f.searchGate, f.searchEntered
						f.mu.Unlock()
						if entered != nil {
							select {
							case entered <- struct{}{}:
							default:
							}
						}
						if gate != nil {
							<-gate
						}
						if referralError {
							_ = ldapWrite(c, ldapResult(id, 5, 10))
							continue
						}
						if referralURL != "" && op.Children[1].Value == int64(ldap.ScopeWholeSubtree) {
							_ = ldapWrite(c, ldapReference(id, referralURL))
							if referralOnly {
								_ = ldapWrite(c, ldapResult(id, 5, 0))
								continue
							}
						}
						dn := "CN=Test User,OU=Users,DC=example,DC=test"
						switch {
						case strings.Contains(filter, adChainRule):
							if admin {
								_ = ldapWrite(c, ldapEntry(id, dn, nil))
							}
						case strings.Contains(filter, "objectClass=group"):
							_ = ldapWrite(c, ldapEntry(id, "CN=Portal Admins,OU=Groups,DC=example,DC=test", nil))
							if duplicateGroup {
								_ = ldapWrite(c, ldapEntry(id, "CN=Duplicate,OU=Other,DC=example,DC=test", nil))
							}
						default:
							flags := "512"
							if disabled {
								flags = "514"
							}
							_ = ldapWrite(c, ldapEntry(id, dn, map[string]string{"objectGUID": string([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}), "sAMAccountName": "test.user", "displayName": "Test User", "userAccountControl": flags, "accountExpires": "0"}))
						}
						if e = ldapWrite(c, ldapResult(id, 5, 0)); e != nil {
							return
						}
					case 2:
						return
					default:
						t.Error("unexpected LDAP operation", op.Tag)
						return
					}
				}
			}()
		}
	}()
	scheme := "ldaps://"
	if f.startTLS {
		scheme = "ldap://"
	}
	return Config{ADURL: scheme + listener.Addr().String(), ADBaseDN: "DC=example,DC=test", ADUserSuffix: "example.test", ADGroup: "Portal Admins", CAFile: ca, PublicURL: "https://portal.test", SessionLifetime: time.Hour}
}
func TestADTLSLDAPContracts(t *testing.T) {
	for _, tc := range []struct {
		name      string
		f         *adFixture
		wantAdmin bool
		wantErr   error
	}{{name: "nested group uses matching rule", f: &adFixture{admin: true}, wantAdmin: true}, {name: "unprivileged is board user"}, {name: "wrong password", f: &adFixture{badPassword: true}, wantErr: errADCredentials}, {name: "disabled account", f: &adFixture{disabled: true}, wantErr: errADCredentials}, {name: "ambiguous group denied", f: &adFixture{duplicateGroup: true}, wantErr: errADUnavailable}, {name: "StartTLS before bind", f: &adFixture{admin: true, startTLS: true}, wantAdmin: true}} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.f == nil {
				tc.f = &adFixture{}
			}
			c := adServer(t, tc.f)
			u, e := authenticateAD(context.Background(), c, "test.user", "fixture-password")
			if !errors.Is(e, tc.wantErr) {
				t.Fatalf("error=%v want=%v", e, tc.wantErr)
			}
			if e != nil {
				return
			}
			if u.Admin != tc.wantAdmin || !strings.HasPrefix(u.ID, "ad:") || u.Name != "Test User" {
				t.Fatal(u)
			}
			tc.f.mu.Lock()
			defer tc.f.mu.Unlock()
			if len(tc.f.bindNames) != 2 || tc.f.bindNames[0] != "test.user@example.test" || !strings.HasPrefix(tc.f.bindNames[1], "CN=Test User,") {
				t.Fatal("bind did not prove resolved object", tc.f.bindNames)
			}
			if len(tc.f.filters) != 3 || !strings.Contains(tc.f.filters[2], "memberOf:"+adChainRule+":=CN=Portal Admins,") {
				t.Fatal("recursive group contract missing", tc.f.filters)
			}
		})
	}
}
func TestADRejectsUntrustedTLS(t *testing.T) {
	c := adServer(t, &adFixture{admin: true})
	c.CAFile = ""
	if _, e := authenticateAD(context.Background(), c, "test.user", "fixture-password"); !errors.Is(e, errADUnavailable) {
		t.Fatal("accepted untrusted LDAP certificate", e)
	}
}
func TestADEscapingAndExactIdentity(t *testing.T) {
	c := adServer(t, &adFixture{})
	raw := `test*)(|(objectClass=*))`
	_, upn, e := adUsername(raw, "example.test")
	if e != nil || upn != raw+"@example.test" {
		t.Fatal(e)
	}
	escaped := ldap.EscapeFilter(raw)
	if strings.Contains(escaped, "(") || strings.Contains(escaped, ")") || strings.Contains(escaped, "*") {
		t.Fatal("filter not escaped", escaped)
	}
	if _, _, e = adUsername("admin@different.test", c.ADUserSuffix); !errors.Is(e, errADCredentials) {
		t.Fatal("foreign UPN accepted")
	}
	if _, _, e = adUsername(`DOMAIN\admin`, c.ADUserSuffix); !errors.Is(e, errADCredentials) {
		t.Fatal("ambiguous domain form accepted")
	}
	if _, e = authenticateAD(context.Background(), c, "test.user", ""); !errors.Is(e, errADCredentials) {
		t.Fatal("empty password bind allowed")
	}
}
func TestADConfigAndDisabledRoute(t *testing.T) {
	for _, c := range []Config{{ADURL: "http://dc", ADBaseDN: "DC=test", ADUserSuffix: "test", ADGroup: "Admins"}, {ADURL: "ldap://dc", ADBaseDN: "DC=test", ADUserSuffix: "test"}, {ADURL: "ldaps://user:password@dc", ADBaseDN: "DC=test", ADUserSuffix: "test", ADGroup: "Admins"}} {
		if e := validateADConfig(c); e == nil {
			t.Fatal("accepted incomplete/insecure configuration")
		}
	}
	if e := validateADConfig(Config{}); e != nil {
		t.Fatal(e)
	}
	s := &Server{}
	w := httptest.NewRecorder()
	s.adLogin(w, httptest.NewRequest("POST", "https://portal.test/auth/ad", strings.NewReader(`{}`)))
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestADLoginSessionUsesDirectoryGroupAndPersistentLimiter(t *testing.T) {
	fixture := &adFixture{admin: false}
	c := adServer(t, fixture)
	db := localAuthTestStore(t)
	s := &Server{Store: db, Config: c}
	login := func(password string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"username": "test.user", "password": password})
		r := httptest.NewRequest("POST", c.PublicURL+"/auth/ad", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", c.PublicURL)
		r.RemoteAddr = "192.0.2.80:4321"
		w := httptest.NewRecorder()
		s.adLogin(w, r)
		return w
	}
	response := login("fixture-password")
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	r := httptest.NewRequest("GET", c.PublicURL+"/api/v1/resources", nil)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	record := httptest.NewRecorder()
	s.auth(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "unexpected admin") }, true)(record, r)
	if record.Code != 403 {
		t.Fatal("nonmember accessed admin API", record.Code)
	}
	for n := 0; n < 5; n++ {
		if w := login("wrong-password"); w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	if w := login("wrong-password"); w.Code != 429 {
		t.Fatal("persistent AD limit missing", w.Code)
	}
}

func TestADWireFilterEscapesUserInput(t *testing.T) {
	f := &adFixture{admin: true}
	c := adServer(t, f)
	raw := `test*)(|(objectClass=*))`
	user, e := authenticateAD(context.Background(), c, raw, "fixture-password")
	if e == nil || user.Admin {
		t.Fatal("mismatched identity granted access")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.filters) != 1 || f.filters[0] != "(&(objectClass=user)(sAMAccountName="+ldap.EscapeFilter(raw)+"))" {
		t.Fatal("user input changed LDAP filter structure", f.filters)
	}
}
func TestADProductionConfigurationAlternative(t *testing.T) {
	for _, k := range []string{"PORTAL_OIDC_ISSUER", "PORTAL_OIDC_CLIENT_ID", "PORTAL_OIDC_CLIENT_SECRET", "PORTAL_OIDC_ALLOWED_GROUP", "PORTAL_LOCAL_ADMIN_HASH_FILE", "PORTAL_CA_FILE", "PORTAL_AD_GROUP_DN"} {
		t.Setenv(k, "")
	}
	t.Setenv("PORTAL_DEMO", "false")
	t.Setenv("PORTAL_DATABASE_URL", "postgres://unused/test")
	t.Setenv("PORTAL_PUBLIC_URL", "https://portal.test")
	t.Setenv("PORTAL_AD_URL", "ldaps://dc.example.test:636")
	t.Setenv("PORTAL_AD_BASE_DN", "DC=example,DC=test")
	t.Setenv("PORTAL_AD_USER_SUFFIX", "example.test")
	t.Setenv("PORTAL_AD_GROUP", "Portal Admins")
	c, e := LoadConfig()
	if e != nil || !c.adEnabled() {
		t.Fatal("complete AD alternative rejected", e)
	}
	t.Setenv("PORTAL_AD_USER_SUFFIX", "")
	if _, e = LoadConfig(); e == nil || !strings.Contains(e.Error(), "USER_SUFFIX") {
		t.Fatal("AD without an explicit user suffix must fail before attempting authentication")
	}
	t.Setenv("PORTAL_AD_USER_SUFFIX", "example.test")
	t.Setenv("PORTAL_AD_GROUP", "")
	if _, e = LoadConfig(); e == nil {
		t.Fatal("incomplete AD silently enabled auth bypass")
	}
}
func TestADConfiguredGroupDNUsesExactRecursiveMatch(t *testing.T) {
	f := &adFixture{admin: true}
	c := adServer(t, f)
	c.ADGroup = ""
	c.ADGroupDN = "CN=GG-ADM-PLATFORM,OU=Administration,OU=Groups,DC=example,DC=test"
	user, e := authenticateAD(context.Background(), c, "test.user@example.test", "fixture-password")
	if e != nil || !user.Admin {
		t.Fatal(user, e)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	want := "(&(objectClass=user)(memberOf:" + adChainRule + ":=" + ldap.EscapeFilter(c.ADGroupDN) + "))"
	if len(f.filters) != 2 || f.filters[1] != want {
		t.Fatal("configured group was not matched exactly", f.filters)
	}
}

func TestADConcurrentSuccessfulLoginsDoNotExhaustFailureBudget(t *testing.T) {
	c := adServer(t, &adFixture{admin: false})
	c.TrustedProxyCIDRs = []string{"172.21.0.0/16"}
	s := &Server{Store: localAuthTestStore(t), Config: c}
	var wg sync.WaitGroup
	for n := 0; n < 4; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := 0; k < 8; k++ {
				body := `{"username":"test.user","password":"fixture-password"}`
				r := httptest.NewRequest("POST", c.PublicURL+"/auth/ad", strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", c.PublicURL)
				r.Header.Set("X-Real-IP", "192.0.2.91")
				r.RemoteAddr = "172.21.0.3:49100"
				w := httptest.NewRecorder()
				s.adLogin(w, r)
				if w.Code != 200 {
					t.Errorf("valid concurrent login %d: HTTP %d", k, w.Code)
					return
				}
			}
		}()
	}
	wg.Wait()
	var attempts int
	if e := s.Store.Pool.QueryRow(context.Background(), "SELECT COALESCE(sum(attempts),0) FROM local_login_attempts").Scan(&attempts); e != nil || attempts != 0 {
		t.Fatal("successful logins consumed failure budget", attempts, e)
	}
}

func ldapReference(id int64, reference string) *ber.Packet {
	p := ber.NewSequence("LDAPMessage")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "id"))
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, 19, nil, "searchResRef")
	op.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, reference, "referral"))
	p.AppendChild(op)
	return p
}
func TestADSubtreeSupplementaryReferralsKeepLocalEntryWithoutFollowing(t *testing.T) {
	remote, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer remote.Close()
	var connections atomic.Int32
	go func() {
		for {
			c, e := remote.Accept()
			if e != nil {
				return
			}
			connections.Add(1)
			c.Close()
		}
	}()
	f := &adFixture{admin: true, referralURL: "ldap://" + remote.Addr().String() + "/DC=DomainDNSZones,DC=example,DC=test"}
	c := adServer(t, f)
	user, e := authenticateAD(context.Background(), c, "test.user", "fixture-password")
	if e != nil || !user.Admin {
		t.Fatal("supplementary naming-context referral rejected valid local identity", user, e)
	}
	time.Sleep(30 * time.Millisecond)
	if connections.Load() != 0 {
		t.Fatal("authentication followed referral host", connections.Load())
	}
}
func TestADReferralOnlyAndReferralResultFailClosed(t *testing.T) {
	for _, f := range []*adFixture{{admin: true, referralURL: "ldap://127.0.0.1:1/DC=other", referralOnly: true}, {admin: true, referralError: true}} {
		c := adServer(t, f)
		user, e := authenticateAD(context.Background(), c, "test.user", "fixture-password")
		if !errors.Is(e, errADUnavailable) || user.Admin {
			t.Fatal("referral-only result granted access", user, e)
		}
	}
}
