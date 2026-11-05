package providers

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

type errorResolver func(context.Context, string) ([]net.IPAddr, error)

func (f errorResolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return f(ctx, host)
}

func endpointTLSFixture(t *testing.T, expired bool) (string, string) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	end := time.Now().Add(time.Hour)
	if expired {
		end = time.Now().Add(-time.Hour)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "example.com"}, DNSNames: []string{"example.com"}, NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: end, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if e = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	return strings.TrimPrefix(srv.URL, "https://"), ca
}

func TestEndpointTLSCausesUseSafeErrors(t *testing.T) {
	for _, tc := range []struct {
		name, host     string
		expired, trust bool
		want           error
	}{{"unknown CA", "example.com", false, false, ErrTLSUntrusted}, {"hostname", "wrong-host.test", false, true, ErrTLSHostname}, {"expired", "example.com", true, true, ErrTLSExpired}} {
		t.Run(tc.name, func(t *testing.T) {
			address, ca := endpointTLSFixture(t, tc.expired)
			if !tc.trust {
				ca = ""
			}
			g, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{443}, ca, fakeDNS{}, func(c context.Context, n, a string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(c, n, address)
			})
			if e != nil {
				t.Fatal(e)
			}
			r := New(g, "")
			for _, kind := range []string{"enrich", "http", "tls"} {
				j := model.Job{Kind: "check", Parameters: map[string]any{"kind": kind, "target": "https://" + tc.host + "/private?token=do-not-expose"}}
				if kind == "enrich" {
					j.Kind = "enrich"
				}
				_, err := r.Execute(context.Background(), j, nil, nil)
				if !errors.Is(err, tc.want) {
					t.Fatalf("%s cause=%v want=%v", kind, err, tc.want)
				}
				if strings.Contains(err.Error(), "do-not-expose") || strings.Contains(CheckErrorMessage(err), tc.host) {
					t.Fatal("raw endpoint error escaped")
				}
			}
		})
	}
}

func TestEndpointTimeoutDNSRefusedAndPolicyCauses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	g, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", fakeDNS{}, func(c context.Context, n, a string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(c, n, strings.TrimPrefix(srv.URL, "http://"))
	})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := New(g, "").Execute(ctx, model.Job{Kind: "enrich", Parameters: map[string]any{"target": "http://example.com?token=do-not-expose"}}, nil, nil)
	if !errors.Is(err, ErrTimeout) {
		t.Fatal("body timeout classification", err)
	}
	resolver := errorResolver(func(context.Context, string) ([]net.IPAddr, error) {
		return nil, &net.DNSError{Err: "private resolver detail do-not-expose", Name: "internal-secret", IsNotFound: true}
	})
	g, e = netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", resolver, func(context.Context, string, string) (net.Conn, error) { t.Fatal("unexpected dial"); return nil, nil })
	if e != nil {
		t.Fatal(e)
	}
	_, err = New(g, "").Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "dns", "target": "missing.test"}}, nil, nil)
	if !errors.Is(err, ErrDNS) || strings.Contains(err.Error(), "do-not-expose") {
		t.Fatal(err)
	}
	_, err = New(g, "").Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "tcp", "target": "127.0.0.1:80"}}, nil, nil)
	if !errors.Is(err, ErrPolicyDenied) {
		t.Fatal(err)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	closed := listener.Addr().String()
	listener.Close()
	g, e = netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", fakeDNS{}, func(c context.Context, n, a string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(c, n, closed)
	})
	if e != nil {
		t.Fatal(e)
	}
	_, err = New(g, "").Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "tcp", "target": "example.com:80"}}, nil, nil)
	if !errors.Is(err, ErrConnectionRefused) {
		t.Fatal(err)
	}
}

func TestCheckErrorMessageNeverLeaksRawDiagnostics(t *testing.T) {
	unknown := errors.New("https://user:password@internal.test/?token=do-not-expose; " + ErrTLSUntrusted.Error())
	if msg := CheckErrorMessage(unknown); strings.Contains(msg, "password") || strings.Contains(msg, "do-not-expose") || msg == CheckErrorMessage(ErrTLSUntrusted) {
		t.Fatal(msg)
	}
	for _, cause := range []error{ErrTLSUntrusted, ErrTLSHostname, ErrTLSExpired, ErrTLSVerification, ErrDNS, ErrTimeout, ErrConnectionRefused, ErrPolicyDenied} {
		msg := CheckErrorMessage(fmt.Errorf("private do-not-expose: %w", cause))
		if msg == "" || strings.Contains(msg, "do-not-expose") || strings.Contains(msg, "endpoint_") {
			t.Fatal(msg)
		}
	}
}
