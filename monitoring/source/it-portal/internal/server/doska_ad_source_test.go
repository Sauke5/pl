package server

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
	"pl/portal/internal/organization"
)

type doskaADFixture struct {
	mu                                                                                                sync.Mutex
	filters                                                                                           []string
	binds                                                                                             int
	member, missing, disabled, expired, referral, partial, duplicate, extraUser, malformed, wrongGUID bool
	startTLS                                                                                          bool
	unsupportedControl                                                                                bool
}

var doskaTestUserGUID = [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
var doskaTestGroupGUID = [16]byte{17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}

const doskaTestUserDN = "CN=Test User,OU=Users,DC=example,DC=test"
const doskaTestGroupDN = "CN=IT,OU=Groups,DC=example,DC=test"

func doskaADServer(t *testing.T, f *doskaADFixture) DoskaADSourceConfig {
	t.Helper()
	certificate, ca := adCertificate(t)
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(5 * time.Second))
				secured := !f.startTLS
				if secured {
					c = tls.Server(c, tlsConfig)
				}
				for {
					packet, e := ber.ReadPacket(c)
					if e != nil {
						return
					}
					if len(packet.Children) < 2 || len(packet.Children) > 3 {
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
							t.Error("duplicate StartTLS")
							return
						}
						if ldapWrite(c, ldapResult(id, 24, 0)) != nil {
							return
						}
						c = tls.Server(c, tlsConfig)
						secured = true
					case 0:
						if !secured {
							t.Error("bind before TLS")
							return
						}
						f.mu.Lock()
						f.binds++
						f.mu.Unlock()
						code := int64(0)
						if op.Children[1].Data.String() != "CN=Service,DC=example,DC=test" || op.Children[2].Data.String() != "fixture-password" {
							code = 49
						}
						if ldapWrite(c, ldapResult(id, 1, code)) != nil {
							return
						}
					case 3:
						if !secured {
							t.Error("search before TLS")
							return
						}
						if len(packet.Children) != 3 || len(packet.Children[2].Children) != 1 {
							t.Error("missing domain-scope control")
							return
						}
						control := packet.Children[2].Children[0]
						if len(control.Children) != 2 || control.Children[0].Data.String() != doskaADDomainScopeOID || control.Children[1].Value != true {
							t.Error("invalid/noncritical domain-scope control")
							return
						}
						if f.unsupportedControl {
							if ldapWrite(c, ldapResult(id, 5, 12)) != nil {
								return
							}
							continue
						}
						filter, e := ldap.DecompileFilter(op.Children[6])
						if e != nil {
							t.Error(e)
							return
						}
						f.mu.Lock()
						f.filters = append(f.filters, filter)
						f.mu.Unlock()
						attrs := map[string]string{"objectGUID": string(doskaTestUserGUID[:]), "displayName": "Test User", "sAMAccountName": "test.user", "userAccountControl": "512", "accountExpires": "0"}
						if f.disabled {
							attrs["userAccountControl"] = "514"
						}
						if f.expired {
							attrs["accountExpires"] = "1"
						}
						if f.malformed {
							attrs["userAccountControl"] = "not-an-integer"
						}
						if f.wrongGUID {
							attrs["objectGUID"] = string(doskaTestGroupGUID[:])
						}
						switch {
						case strings.Contains(filter, "objectClass=group"):
							_ = ldapWrite(c, ldapEntry(id, doskaTestGroupDN, map[string]string{"objectGUID": string(doskaTestGroupGUID[:])}))
						case strings.Contains(filter, adChainRule):
							if f.member {
								_ = ldapWrite(c, ldapEntry(id, doskaTestUserDN, attrs))
								if f.extraUser && op.Children[1].Value == int64(ldap.ScopeWholeSubtree) {
									second := map[string]string{}
									for k, v := range attrs {
										second[k] = v
									}
									second["objectGUID"] = string(doskaTestGroupGUID[:])
									_ = ldapWrite(c, ldapEntry(id, "CN=Second User,OU=Users,DC=example,DC=test", second))
								}
							}
						default:
							if !strings.Contains(filter, "objectGUID=") {
								t.Error("unbounded user search", filter)
							}
							if !f.missing {
								_ = ldapWrite(c, ldapEntry(id, doskaTestUserDN, attrs))
								if f.duplicate {
									_ = ldapWrite(c, ldapEntry(id, doskaTestUserDN, attrs))
								}
							}
						}
						if f.referral {
							_ = ldapWrite(c, ldapReference(id, "ldap://untrusted.invalid/DC=elsewhere"))
						}
						code := int64(0)
						if f.partial {
							code = 4
						}
						if ldapWrite(c, ldapResult(id, 5, code)) != nil {
							return
						}
					case 2:
						return
					default:
						t.Error("unexpected read-only LDAP operation", op.Tag)
						return
					}
				}
			}(c)
		}
	}()
	dir := t.TempDir()
	bind := filepath.Join(dir, "bind-dn")
	password := filepath.Join(dir, "bind-password")
	if err = os.WriteFile(bind, []byte("CN=Service,DC=example,DC=test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(password, []byte("fixture-password\n"), 0600); err != nil {
		t.Fatal(err)
	}
	scheme := "ldaps://"
	if f.startTLS {
		scheme = "ldap://"
	}
	return DoskaADSourceConfig{URL: scheme + l.Addr().String(), BaseDN: "DC=example,DC=test", CAFile: ca, BindDNFile: bind, BindPasswordFile: password}
}

func doskaTestPlan(source *DoskaADSource) organization.ADRefreshPlan {
	return organization.ADRefreshPlan{Namespace: source.Namespace(), Identities: []organization.ADIdentity{{Subject: "ad:" + source.Namespace() + ":" + hex.EncodeToString(doskaTestUserGUID[:]), ObjectGUID: doskaTestUserGUID, Revision: 1}}, Groups: []organization.DepartmentBinding{{DepartmentID: "it", ObjectGUID: doskaTestGroupGUID}}}
}

func TestDoskaADSourceExactGUIDMembershipAndLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name       string
		fixture    *doskaADFixture
		state      organization.AccountState
		department bool
	}{
		{"active nested membership", &doskaADFixture{member: true}, organization.Active, true},
		{"outside mapped group", &doskaADFixture{}, organization.Active, false},
		{"disabled", &doskaADFixture{member: true, disabled: true}, organization.Disabled, true},
		{"expired", &doskaADFixture{member: true, expired: true}, organization.Expired, true},
		{"confirmed deleted", &doskaADFixture{missing: true}, organization.Missing, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := doskaADServer(t, tc.fixture)
			source, err := NewDoskaADSource(config)
			if err != nil {
				t.Fatal(err)
			}
			p := doskaTestPlan(source)
			now := time.Now().UTC()
			observations, err := source.ReadPlan(context.Background(), p, now)
			if err != nil || len(observations) != 1 || observations[0].AccountState != tc.state || !observations[0].ObservedAt.Equal(now) || (len(observations[0].CandidateDepartmentIDs) == 1) != tc.department {
				t.Fatal(observations, err)
			}
			tc.fixture.mu.Lock()
			defer tc.fixture.mu.Unlock()
			if tc.fixture.binds != 1 {
				t.Fatal("expected one service bind")
			}
			if len(tc.fixture.filters) < 2 || !strings.Contains(tc.fixture.filters[0], "objectClass=group") || !strings.Contains(tc.fixture.filters[1], "objectGUID=") {
				t.Fatal(tc.fixture.filters)
			}
			if tc.department && !strings.Contains(tc.fixture.filters[2], "memberOf:"+adChainRule+":=") {
				t.Fatal("recursive AD membership not checked", tc.fixture.filters)
			}
		})
	}
}

func TestDoskaADSourceRejectsPartialReferralsAndUnprovenIdentity(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fixture *doskaADFixture
	}{
		{"referrals with successful entries", &doskaADFixture{member: true, referral: true}},
		{"size-limit partial result", &doskaADFixture{member: true, partial: true}},
		{"ambiguous object", &doskaADFixture{duplicate: true}},
		{"malformed status", &doskaADFixture{malformed: true}},
		{"GUID mismatch", &doskaADFixture{wrongGUID: true}},
		{"unsupported critical scope control", &doskaADFixture{unsupportedControl: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := doskaADServer(t, tc.fixture)
			source, err := NewDoskaADSource(config)
			if err != nil {
				t.Fatal(err)
			}
			observations, err := source.ReadPlan(context.Background(), doskaTestPlan(source), time.Now().UTC())
			if err == nil || len(observations) != 0 {
				t.Fatal("partial result must not be applied", observations, err)
			}
		})
	}
}

func TestDoskaADSourceExplicitBoundedDiscovery(t *testing.T) {
	f := &doskaADFixture{member: true}
	config := doskaADServer(t, f)
	config.ScopeGroupGUIDs = []string{hex.EncodeToString(doskaTestGroupGUID[:])}
	source, err := NewDoskaADSource(config)
	if err != nil {
		t.Fatal(err)
	}
	p := doskaTestPlan(source)
	p.Identities[0].Revision = 12
	plan, observations, err := source.Discover(context.Background(), p, time.Now().UTC())
	if err != nil || len(observations) != 1 || len(plan.Identities) != 1 || plan.Identities[0].Revision != 12 || observations[0].CandidateDepartmentIDs[0] != "it" {
		t.Fatal(plan, observations, err)
	}
	// An over-limit scope is an error, not the first successful page.
	f2 := &doskaADFixture{member: true, extraUser: true}
	config = doskaADServer(t, f2)
	config.ScopeGroupGUIDs = []string{hex.EncodeToString(doskaTestGroupGUID[:])}
	config.MaxDiscoveryEmployees = 1
	source, err = NewDoskaADSource(config)
	if err != nil {
		t.Fatal(err)
	}
	if _, observations, err = source.Discover(context.Background(), doskaTestPlan(source), time.Now().UTC()); err == nil || len(observations) > 0 {
		t.Fatal(observations, err)
	}
}

func TestDoskaADSourceProtectedCredentialsAndConfig(t *testing.T) {
	f := &doskaADFixture{}
	config := doskaADServer(t, f)
	if err := os.Chmod(config.BindPasswordFile, 0644); err != nil {
		t.Fatal(err)
	}
	source, err := NewDoskaADSource(config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.ReadPlan(context.Background(), doskaTestPlan(source), time.Now().UTC()); !errors.Is(err, errDoskaADSource) {
		t.Fatal(err)
	}
	f.mu.Lock()
	binds := f.binds
	f.mu.Unlock()
	if binds != 0 {
		t.Fatal("unprotected credential used")
	}
	config.URL = "ldap://user:password@127.0.0.1"
	if _, err = NewDoskaADSource(config); err == nil {
		t.Fatal("URL credentials accepted")
	}
	config.URL = "http://127.0.0.1"
	if _, err = NewDoskaADSource(config); err == nil {
		t.Fatal("plaintext non-LDAP transport accepted")
	}
	config.URL = "ldaps://127.0.0.1"
	config.BaseDN = ""
	if _, err = NewDoskaADSource(config); err == nil {
		t.Fatal("unbounded empty base accepted")
	}
}

func TestDoskaADSourceStartTLSAndCancellation(t *testing.T) {
	f := &doskaADFixture{startTLS: true}
	config := doskaADServer(t, f)
	source, err := NewDoskaADSource(config)
	if err != nil {
		t.Fatal(err)
	}
	p := doskaTestPlan(source)
	p.Groups = nil
	if observations, err := source.ReadPlan(context.Background(), p, time.Now().UTC()); err != nil || len(observations) != 1 {
		t.Fatal(observations, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = source.ReadPlan(ctx, p, time.Now().UTC()); err == nil {
		t.Fatal("canceled read succeeded")
	}
}
