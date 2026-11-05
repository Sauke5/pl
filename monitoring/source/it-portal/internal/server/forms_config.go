package server

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"pl/portal/internal/netguard"
	"strconv"
	"strings"
)

// Forms is explicitly enabled; no URL, key or directory synchronization is inferred.
type FormsGatewayConfig struct {
	Transport    http.RoundTripper // Only the owned module transport injects this in-process.
	Upstream     string
	Key          []byte
	AllowedCIDRs []string
	CAFile       string
}

func loadFormsConfig() (*FormsGatewayConfig, error) {
	upstream, keyFile := os.Getenv("PORTAL_FORMS_URL"), os.Getenv("PORTAL_FORMS_KEY_FILE")
	if upstream == "" && keyFile == "" && os.Getenv("PORTAL_FORMS_ALLOWED_CIDRS") == "" && os.Getenv("PORTAL_FORMS_CA_FILE") == "" {
		return nil, nil
	}
	c := &FormsGatewayConfig{Upstream: upstream, AllowedCIDRs: csv(os.Getenv("PORTAL_FORMS_ALLOWED_CIDRS")), CAFile: os.Getenv("PORTAL_FORMS_CA_FILE")}
	if _, err := formsGuard(c); err != nil {
		return nil, err
	}
	key, err := doskaReadFile(keyFile, 32)
	if err != nil || len(key) != 32 {
		return nil, errors.New("invalid Forms raw 32-byte key file")
	}
	c.Key = key
	return c, nil
}

func (c Config) validateFormsKey() error {
	if c.Forms == nil {
		return nil
	}
	keys := [][]byte{c.ProxyControl.Key}
	for _, gateway := range c.ServiceGateways {
		keys = append(keys, gateway.Key)
	}
	if c.Doska != nil {
		keys = append(keys, c.Doska.Key)
	}
	for _, key := range keys {
		if bytes.Equal(key, c.Forms.Key) {
			return errors.New("Forms requires an independent gateway key")
		}
	}
	return nil
}

func (s *Server) InitForms() error {
	g, err := s.newFormsGateway(s.Config.Forms)
	if err != nil {
		return err
	}
	s.formsHandler = g
	return nil
}

func formsGuard(c *FormsGatewayConfig) (*netguard.Guard, error) {
	if c == nil || len(c.Upstream) > 2048 || strings.TrimSpace(c.Upstream) != c.Upstream || strings.ContainsAny(c.Upstream, "\r\n\x00") || len(c.AllowedCIDRs) == 0 || len(c.AllowedCIDRs) > 32 {
		return nil, errors.New("Forms requires an explicit origin and allowed CIDRs")
	}
	u, err := url.Parse(c.Upstream)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errors.New("invalid Forms origin")
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid Forms port")
		}
	}
	guard, err := netguard.New(c.AllowedCIDRs, []int{port}, c.CAFile)
	if err != nil {
		return nil, errors.New("invalid Forms network or CA configuration")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil {
		if err = guard.ValidatePortIPs([]net.IP{ip}, port); err != nil {
			return nil, errors.New("Forms address is outside the allowed CIDRs")
		}
	}
	return guard, nil
}
