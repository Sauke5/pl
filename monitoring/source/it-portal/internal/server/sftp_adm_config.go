package server

import (
	"errors"
	"net"
	"net/url"
	"os"
	"path"
	"pl/portal/internal/netguard"
	"strconv"
	"strings"
)

// SFTPAdminConfig belongs to the isolated file server, never the exchange provider.
type SFTPAdminConfig struct {
	UpstreamURL, CAFile, AdminKeyFile, DataRoot string
	OIDC                                        SFTPAdminOIDCConfig
	AllowedCIDRs                                []string
}

func loadSFTPAdminConfig(publicURL string) (*SFTPAdminConfig, error) {
	upstream := os.Getenv("PORTAL_SFTP_ADM_URL")
	if upstream == "" {
		for _, key := range []string{"PORTAL_SFTP_ADM_CA_FILE", "PORTAL_SFTP_ADM_ADMIN_KEY_FILE", "PORTAL_SFTP_ADM_CLIENT_SECRET_FILE", "PORTAL_SFTP_ADM_SIGNING_KEY_FILE", "PORTAL_SFTP_ADM_ALLOWED_CIDRS", "PORTAL_SFTP_ADM_DATA_ROOT", "PORTAL_SFTP_ADM_CLIENT_ID"} {
			if os.Getenv(key) != "" {
				return nil, errors.New("incomplete SFTP administration configuration")
			}
		}
		return nil, nil
	}
	u, err := url.Parse(upstream)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("invalid isolated SFTP administration upstream")
	}
	p, err := url.Parse(publicURL)
	if err != nil || p.Scheme != "https" || p.Host == "" || p.User != nil || p.Path != "" || p.RawPath != "" || p.RawQuery != "" || p.ForceQuery || p.Fragment != "" || p.Opaque != "" {
		return nil, errors.New("SFTP administration requires an HTTPS public origin")
	}
	c := &SFTPAdminConfig{UpstreamURL: upstream,
		CAFile: os.Getenv("PORTAL_SFTP_ADM_CA_FILE"), AdminKeyFile: os.Getenv("PORTAL_SFTP_ADM_ADMIN_KEY_FILE"),
		DataRoot: os.Getenv("PORTAL_SFTP_ADM_DATA_ROOT"), AllowedCIDRs: csv(os.Getenv("PORTAL_SFTP_ADM_ALLOWED_CIDRS")),
		OIDC: SFTPAdminOIDCConfig{Issuer: publicURL + "/auth/sftp-adm/oidc", ClientID: env("PORTAL_SFTP_ADM_CLIENT_ID", "pl-sftp-adm"),
			ClientSecretFile: os.Getenv("PORTAL_SFTP_ADM_CLIENT_SECRET_FILE"), SigningKeyFile: os.Getenv("PORTAL_SFTP_ADM_SIGNING_KEY_FILE"),
			RedirectURL: publicURL + "/sftp-adm/web/oidc/redirect"},
	}
	if !path.IsAbs(c.DataRoot) || path.Clean(c.DataRoot) != c.DataRoot || c.DataRoot == "/" || strings.ContainsAny(c.DataRoot, "\r\n\x00") {
		return nil, errors.New("SFTP administration requires an explicit storage root")
	}
	if _, err := sftpAdminGuard(c); err != nil {
		return nil, err
	}
	for _, file := range []string{c.CAFile, c.AdminKeyFile, c.OIDC.ClientSecretFile, c.OIDC.SigningKeyFile} {
		if !strings.HasPrefix(file, "/") || strings.ContainsAny(file, "\r\n\x00") {
			return nil, errors.New("SFTP administration requires absolute credential file paths")
		}
	}
	return c, nil
}

// InitSFTPAdmin fails startup if an explicitly enabled integration is incomplete.
func (s *Server) InitSFTPAdmin() error {
	if s.Config.SFTPAdmin == nil {
		return nil
	}
	issuer, err := newSFTPAdminOIDC(s, s.Config.SFTPAdmin.OIDC)
	if err != nil {
		return err
	}
	gateway, err := newSFTPAdminGateway(s, *s.Config.SFTPAdmin, issuer)
	if err != nil {
		return err
	}
	s.SFTPAdminOIDC = issuer
	s.SFTPAdminGateway = gateway
	return nil
}

func sftpAdminGuard(c *SFTPAdminConfig) (*netguard.Guard, error) {
	if c == nil || len(c.AllowedCIDRs) == 0 || len(c.AllowedCIDRs) > 32 {
		return nil, errors.New("SFTP administration requires explicit allowed CIDRs")
	}
	u, err := url.Parse(c.UpstreamURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("invalid SFTP administration origin")
	}
	port := 443
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid SFTP administration port")
		}
	}
	// The constructor loads and verifies the configured CA separately.
	guard, err := netguard.New(c.AllowedCIDRs, []int{port}, "")
	if err != nil {
		return nil, errors.New("invalid SFTP administration network policy")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil {
		if err = guard.ValidatePortIPs([]net.IP{ip}, port); err != nil {
			return nil, errors.New("SFTP administration address is outside allowed CIDRs")
		}
	}
	return guard, nil
}
