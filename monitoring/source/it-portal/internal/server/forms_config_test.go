package server

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const formsUpstream = "http://192.0.2.240:8091"

func TestFormsConfigOptInFixedDestinationAndRawKey(t *testing.T) {
	t.Setenv("PORTAL_FORMS_URL", "")
	t.Setenv("PORTAL_FORMS_KEY_FILE", "")
	t.Setenv("PORTAL_FORMS_ALLOWED_CIDRS", "")
	t.Setenv("PORTAL_FORMS_CA_FILE", "")
	if c, e := loadFormsConfig(); e != nil || c != nil {
		t.Fatal(c, e)
	}
	path := filepath.Join(t.TempDir(), "forms-test-only.key")
	t.Setenv("PORTAL_FORMS_KEY_FILE", path)
	if _, e := loadFormsConfig(); e == nil {
		t.Fatal("key without URL enabled")
	}
	t.Setenv("PORTAL_FORMS_ALLOWED_CIDRS", "192.0.2.240/32")
	t.Setenv("PORTAL_FORMS_CA_FILE", "")
	t.Setenv("PORTAL_FORMS_URL", formsUpstream)
	for _, size := range []int{0, 31, 33, 64} {
		if e := os.WriteFile(path, bytes.Repeat([]byte{42}, size), 0600); e != nil {
			t.Fatal(e)
		}
		if _, e := loadFormsConfig(); e == nil {
			t.Fatal("invalid key size accepted", size)
		}
	}
	if e := os.WriteFile(path, bytes.Repeat([]byte{42}, 32), 0600); e != nil {
		t.Fatal(e)
	}
	if c, e := loadFormsConfig(); e != nil || c.Upstream != formsUpstream || len(c.Key) != 32 {
		t.Fatal(c, e)
	}
	for _, value := range []string{"", formsUpstream + "/", formsUpstream + "/forms/", formsUpstream + "?", formsUpstream + "?target=evil", "http://user:password@192.0.2.240:8091", "http://192.0.2.241:8091"} {
		t.Setenv("PORTAL_FORMS_URL", value)
		if _, e := loadFormsConfig(); e == nil {
			t.Fatal("unsafe upstream accepted", value)
		}
	}
}

func TestFormsConfigLoadAndIndependentKeys(t *testing.T) {
	t.Setenv("PORTAL_DATABASE_URL", "postgres://test.invalid/test")
	t.Setenv("PORTAL_DEMO", "true")
	t.Setenv("PORTAL_PUBLIC_URL", "http://localhost:8199")
	t.Setenv("PORTAL_LOCAL_ADMIN_HASH_FILE", "")
	t.Setenv("PORTAL_AD_URL", "")
	t.Setenv("PORTAL_FORMS_ALLOWED_CIDRS", "192.0.2.240/32")
	t.Setenv("PORTAL_FORMS_CA_FILE", "")
	t.Setenv("PORTAL_FORMS_URL", formsUpstream)
	key := bytes.Repeat([]byte{42}, 32)
	path := filepath.Join(t.TempDir(), "forms-test-only.key")
	if e := os.WriteFile(path, key, 0600); e != nil {
		t.Fatal(e)
	}
	t.Setenv("PORTAL_FORMS_KEY_FILE", path)
	c, err := LoadConfig()
	if err != nil || c.Forms == nil {
		t.Fatal(c.Forms, err)
	}
	for _, kind := range []string{"service", "doska", "proxy"} {
		copyConfig := Config{Forms: c.Forms}
		switch kind {
		case "service":
			copyConfig.ServiceGateways = []ServiceGatewayConfig{{Key: key}}
		case "doska":
			copyConfig.Doska = &DoskaGatewayConfig{Key: key}
		case "proxy":
			copyConfig.ProxyControl.Key = key
		}
		if e := copyConfig.validateFormsKey(); e == nil {
			t.Fatal("shared key accepted", kind)
		}
	}
	t.Setenv("PORTAL_MONITORING_ADMIN_URL", "http://monitoring-admin:8080/admin/")
	t.Setenv("PORTAL_MONITORING_ADMIN_KEY_FILE", path)
	if _, err = LoadConfig(); err == nil || !strings.Contains(err.Error(), "independent") {
		t.Fatal("LoadConfig shared key accepted", err)
	}
	c.ServiceGateways = []ServiceGatewayConfig{{Key: bytes.Repeat([]byte{43}, 32)}}
	if err = c.validateFormsKey(); err != nil {
		t.Fatal("independent key rejected", err)
	}
	s := &Server{Config: Config{PublicURL: "https://portal.example.test", Forms: c.Forms}}
	if err = s.InitForms(); err != nil || s.formsHandler == nil {
		t.Fatal("init", err)
	}
	for _, bad := range []*FormsGatewayConfig{{Upstream: formsUpstream, Key: key[:31]}, {Upstream: formsUpstream + "/forms/", Key: key}} {
		if _, err = s.newFormsGateway(bad); err == nil {
			t.Fatal("invalid gateway initialized")
		}
	}
}
