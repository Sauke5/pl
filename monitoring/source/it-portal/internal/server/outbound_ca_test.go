package server

import "testing"

func TestOutboundTrustDoesNotChangeADTrust(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://unused")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8099")
	t.Setenv("PORTAL_CA_FILE", "/etc/portal/certs/ad.pem")
	t.Setenv("PORTAL_OUTBOUND_CA_FILE", "")
	c, e := LoadConfig()
	if e != nil {
		t.Fatal(e)
	}
	if c.OutboundCAFile != c.CAFile {
		t.Fatal("existing trust fallback changed")
	}
	t.Setenv("PORTAL_OUTBOUND_CA_FILE", "/etc/portal/certs/web.pem")
	c, e = LoadConfig()
	if e != nil {
		t.Fatal(e)
	}
	if c.CAFile != "/etc/portal/certs/ad.pem" || c.OutboundCAFile != "/etc/portal/certs/web.pem" {
		t.Fatal("outbound trust altered AD trust")
	}
}
