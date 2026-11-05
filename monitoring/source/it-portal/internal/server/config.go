package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type GrafanaNativeConfig struct {
	Login         string
	UserID, OrgID int64
}

type Config struct {
	PortableRelease                                                                                             bool
	OnDemandModules                                                                                             bool
	ModuleVersions                                                                                              map[string]string
	Edge                                                                                                        EdgeConfig
	Forms                                                                                                       *FormsGatewayConfig
	Doska                                                                                                       *DoskaGatewayConfig
	DoskaAD                                                                                                     *DoskaADSourceConfig
	SFTPAdmin                                                                                                   *SFTPAdminConfig
	SFTP                                                                                                        *sftpgo.Client
	GrafanaNative                                                                                               GrafanaNativeConfig
	ProxyControl                                                                                                ProxyControlConfig
	PublicWebChecks                                                                                             bool
	MachineCredentialsFile                                                                                      string
	GrafanaTokenVerifyURL                                                                                       string
	WaylineIntegrationID                                                                                        string
	ServiceGateways                                                                                             []ServiceGatewayConfig
	OutboundCAFile                                                                                              string
	TrustedProxyCIDRs                                                                                           []string
	ADURL, ADBaseDN, ADUserSuffix, ADGroupDN, ADGroup                                                           string
	ADCAPEM                                                                                                     string
	LocalAdminUsername, LocalAdminHashFile                                                                      string
	Addr, DatabaseURL, PublicURL, Issuer, ClientID, ClientSecret, GroupClaim, AllowedGroup, CAFile, ExecutorURL string
	ICMPExecutorURL                                                                                             string
	ICMPPolicyMode                                                                                              string
	ICMPCIDRs                                                                                                   []string
	Demo                                                                                                        bool
	LocalAdminPasswordChange                                                                                    bool
	LocalUsersEnabled                                                                                           bool
	CheckPorts                                                                                                  []int
	CheckCIDRs                                                                                                  []string
	CIDRs                                                                                                       []string
	Ports                                                                                                       []int
	SessionLifetime                                                                                             time.Duration
}

func LoadConfig() (Config, error) {
	c := Config{Addr: env("PORTAL_ADDR", ":8080"), DatabaseURL: os.Getenv("PORTAL_DATABASE_URL"), PublicURL: env("PORTAL_PUBLIC_URL", "http://localhost:8098"), Issuer: os.Getenv("PORTAL_OIDC_ISSUER"), ClientID: os.Getenv("PORTAL_OIDC_CLIENT_ID"), ClientSecret: os.Getenv("PORTAL_OIDC_CLIENT_SECRET"), GroupClaim: env("PORTAL_OIDC_GROUP_CLAIM", "groups"), AllowedGroup: os.Getenv("PORTAL_OIDC_ALLOWED_GROUP"), CAFile: os.Getenv("PORTAL_CA_FILE"), ExecutorURL: os.Getenv("PORTAL_EXECUTOR_URL"), Demo: os.Getenv("PORTAL_DEMO") == "true", CIDRs: csv(os.Getenv("PORTAL_ALLOWED_CIDRS")), SessionLifetime: 8 * time.Hour}
	c.ICMPExecutorURL = os.Getenv("PORTAL_ICMP_EXECUTOR_URL")
	c.ICMPCIDRs = csv(os.Getenv("PORTAL_ICMP_ALLOWED_CIDRS"))
	c.ICMPPolicyMode = os.Getenv("PORTAL_ICMP_POLICY")
	if c.ICMPPolicyMode == "" {
		if _, explicit := os.LookupEnv("PORTAL_ICMP_ALLOWED_CIDRS"); explicit {
			c.ICMPPolicyMode = "cidr"
		} else {
			c.ICMPPolicyMode = "interactive"
		}
	}
	if c.ICMPPolicyMode != "interactive" && c.ICMPPolicyMode != "cidr" || c.ICMPPolicyMode == "interactive" && len(c.ICMPCIDRs) != 0 {
		return c, errors.New("invalid PORTAL_ICMP_POLICY")
	}
	if c.ICMPExecutorURL != "" {
		u, err := url.Parse(c.ICMPExecutorURL)
		if err != nil || u.Scheme != "unix" || u.Host != "" || u.User != nil || !filepath.IsAbs(u.Path) || filepath.Clean(u.Path) != u.Path || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
			return c, errors.New("invalid PORTAL_ICMP_EXECUTOR_URL")
		}
	}
	if len(c.ICMPCIDRs) > 64 {
		return c, errors.New("invalid PORTAL_ICMP_ALLOWED_CIDRS")
	}
	seenICMPCIDR := map[string]bool{}
	for _, value := range c.ICMPCIDRs {
		ip, network, err := net.ParseCIDR(value)
		if err != nil || ip.To4() == nil || network.String() != value || seenICMPCIDR[value] {
			return c, errors.New("invalid PORTAL_ICMP_ALLOWED_CIDRS")
		}
		seenICMPCIDR[value] = true
	}
	if raw := os.Getenv("PORTAL_MODULE_VERSIONS"); raw != "" {
		if len(raw) > 1024 || json.Unmarshal([]byte(raw), &c.ModuleVersions) != nil || c.ModuleVersions == nil {
			return c, errors.New("invalid PORTAL_MODULE_VERSIONS")
		}
		for id, version := range c.ModuleVersions {
			if !model.ModuleModeSupported(id, "local") || !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(version) {
				return c, errors.New("invalid PORTAL_MODULE_VERSIONS")
			}
		}
	}
	edge, edgeErr := loadEdgeConfig()
	if edgeErr != nil {
		return c, edgeErr
	}
	c.Edge = edge
	c.PortableRelease = os.Getenv("PORTAL_PORTABLE_RELEASE") == "true"
	c.OnDemandModules = os.Getenv("PORTAL_ON_DEMAND_MODULES") == "true"
	var sftpErr error
	if c.PortableRelease {
		for _, value := range os.Environ() {
			key, content, _ := strings.Cut(value, "=")
			if strings.HasPrefix(key, "PORTAL_SFTP_") && content != "" {
				return c, errors.New("specialized SFTP exchange configuration is not part of the portable release")
			}
		}
	} else {
		c.SFTP, sftpErr = loadSFTPConfig()
		if sftpErr != nil {
			return c, sftpErr
		}
		c.SFTPAdmin, sftpErr = loadSFTPAdminConfig(c.PublicURL)
		if sftpErr != nil {
			return c, sftpErr
		}
	}
	inheritIntegrationPolicy := os.Getenv("PORTAL_CHECK_INHERIT_INTEGRATION_POLICY")
	if inheritIntegrationPolicy != "" && inheritIntegrationPolicy != "true" && inheritIntegrationPolicy != "false" {
		return c, errors.New("invalid PORTAL_CHECK_INHERIT_INTEGRATION_POLICY")
	}
	c.CheckCIDRs = append(append([]string{}, c.CIDRs...), csv(os.Getenv("PORTAL_CHECK_ALLOWED_CIDRS"))...)
	if inheritIntegrationPolicy == "false" {
		c.CheckCIDRs = csv(os.Getenv("PORTAL_CHECK_ALLOWED_CIDRS"))
	}
	c.PublicWebChecks = os.Getenv("PORTAL_CHECK_PUBLIC_WEB") == "true"
	c.MachineCredentialsFile = os.Getenv("PORTAL_MACHINE_CREDENTIALS_FILE")
	c.GrafanaTokenVerifyURL = os.Getenv("PORTAL_GRAFANA_TOKEN_VERIFY_URL")
	if c.GrafanaTokenVerifyURL != "" && c.GrafanaTokenVerifyURL != "http://grafana:3000/grafana/api/user" {
		return c, errors.New("invalid PORTAL_GRAFANA_TOKEN_VERIFY_URL")
	}
	c.GrafanaNative.Login = os.Getenv("PORTAL_GRAFANA_NATIVE_LOGIN")
	nativeUser, nativeOrg := os.Getenv("PORTAL_GRAFANA_NATIVE_USER_ID"), os.Getenv("PORTAL_GRAFANA_NATIVE_ORG_ID")
	if c.GrafanaNative.Login != "" || nativeUser != "" || nativeOrg != "" {
		var userErr, orgErr error
		c.GrafanaNative.UserID, userErr = strconv.ParseInt(nativeUser, 10, 64)
		c.GrafanaNative.OrgID, orgErr = strconv.ParseInt(nativeOrg, 10, 64)
		if userErr != nil || orgErr != nil || !c.grafanaNativeConfigured() || !gatewayString(c.GrafanaNative.Login, 160, false) || strings.TrimSpace(c.GrafanaNative.Login) != c.GrafanaNative.Login {
			return c, errors.New("invalid Grafana native user/org configuration")
		}
	}
	c.WaylineIntegrationID = os.Getenv("PORTAL_WAYLINE_INTEGRATION_ID")
	for _, item := range []struct{ audience, envPrefix, keyEnv, prefix string }{{"monitoring-admin", "PORTAL_MONITORING_ADMIN", "PORTAL_MONITORING_ADMIN_KEY_FILE", "/admin"}, {"websites-admin", "PORTAL_WEBSITES_ADMIN", "PORTAL_WEBSITES_ADMIN_KEY_FILE", "/websites"}, {"directory", "PORTAL_DIRECTORY", "PORTAL_DIRECTORY_KEY_FILE", "/directory"}, {"auditor", "PORTAL_AUDITOR_HOT", "AUDITOR_HOT_GATEWAY_KEY_FILE", "/audit"}, {"auditor", "PORTAL_AUDITOR_ARCH", "AUDITOR_ARCH_GATEWAY_KEY_FILE", "/audit-arch"}} {
		upstream, keyFile := os.Getenv(item.envPrefix+"_URL"), os.Getenv(item.keyEnv)
		if upstream == "" && keyFile == "" {
			continue
		}
		u, err := url.Parse(upstream)
		if err == nil && item.audience == "directory" && u.Path == "" {
			u.Path = "/directory"
			upstream = u.String()
		}
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimRight(u.Path, "/") != item.prefix || keyFile == "" {
			return c, errors.New("invalid " + item.envPrefix + " gateway configuration")
		}
		key, err := os.ReadFile(keyFile)
		if err != nil || len(key) != 32 {
			return c, errors.New("invalid " + item.envPrefix + " gateway key file")
		}
		for _, configured := range c.ServiceGateways {
			if bytes.Equal(configured.Key, key) {
				return c, errors.New("gateway applications require independent keys")
			}
		}
		version := 1
		if item.audience == "directory" || item.audience == "auditor" {
			version = 2
		}
		c.ServiceGateways = append(c.ServiceGateways, ServiceGatewayConfig{Audience: item.audience, Prefix: item.prefix, Upstream: upstream, Key: key, AssertionVersion: version})
	}
	proxyOrigin, proxyKeyFile := os.Getenv("PORTAL_PROXY_CONTROL_URL"), os.Getenv("PORTAL_PROXY_CONTROL_KEY_FILE")
	if proxyOrigin != "" || proxyKeyFile != "" {
		if !validProxyControlOrigin(proxyOrigin) || proxyKeyFile == "" {
			return c, errors.New("invalid PORTAL_PROXY_CONTROL_URL / PORTAL_PROXY_CONTROL_KEY_FILE configuration")
		}
		keyFile := proxyKeyFile
		key, err := os.ReadFile(keyFile)
		if err != nil || len(key) != 32 {
			return c, errors.New("invalid PORTAL_PROXY_CONTROL_KEY_FILE")
		}
		for _, gateway := range c.ServiceGateways {
			if bytes.Equal(gateway.Key, key) {
				return c, errors.New("gateway applications require independent keys")
			}
		}
		c.ProxyControl.Origin = proxyOrigin
		c.ProxyControl.Key = key
	}
	c.OutboundCAFile = env("PORTAL_OUTBOUND_CA_FILE", c.CAFile)
	c.TrustedProxyCIDRs = csv(os.Getenv("PORTAL_TRUSTED_PROXY_CIDRS"))
	for _, cidr := range c.TrustedProxyCIDRs {
		if _, _, e := net.ParseCIDR(cidr); e != nil {
			return c, errors.New("invalid PORTAL_TRUSTED_PROXY_CIDRS")
		}
	}
	c.ADURL = os.Getenv("PORTAL_AD_URL")
	c.ADBaseDN = os.Getenv("PORTAL_AD_BASE_DN")
	c.ADUserSuffix = os.Getenv("PORTAL_AD_USER_SUFFIX")
	c.ADGroupDN = os.Getenv("PORTAL_AD_GROUP_DN")
	c.ADGroup = os.Getenv("PORTAL_AD_GROUP")
	if e := validateADConfig(c); e != nil {
		return c, e
	}
	c.LocalAdminUsername = env("PORTAL_LOCAL_ADMIN_USERNAME", "portal-admin")
	c.LocalAdminHashFile = os.Getenv("PORTAL_LOCAL_ADMIN_HASH_FILE")
	c.LocalAdminPasswordChange = os.Getenv("PORTAL_LOCAL_ADMIN_PASSWORD_CHANGE") == "true"
	c.LocalUsersEnabled = os.Getenv("PORTAL_LOCAL_USERS") == "true"
	if c.LocalUsersEnabled && c.LocalAdminHashFile == "" {
		return c, errors.New("local users require a configured local administrator")
	}
	if c.LocalAdminPasswordChange && c.LocalAdminHashFile == "" {
		return c, errors.New("local password changes require a configured local administrator")
	}
	if c.LocalAdminHashFile != "" && (len(c.LocalAdminUsername) < 1 || len(c.LocalAdminUsername) > 128 || strings.TrimSpace(c.LocalAdminUsername) != c.LocalAdminUsername) {
		return c, errors.New("invalid PORTAL_LOCAL_ADMIN_USERNAME")
	}
	if c.LocalAdminHashFile != "" {
		if e := ValidateLocalAdminHashFile(c.LocalAdminHashFile); e != nil {
			return c, e
		}
	}
	for _, p := range csv(env("PORTAL_ALLOWED_PORTS", "80,443")) {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return c, errors.New("invalid PORTAL_ALLOWED_PORTS")
		}
		c.Ports = append(c.Ports, n)
	}
	c.CheckPorts = append([]int{}, c.Ports...)
	if inheritIntegrationPolicy == "false" {
		c.CheckPorts = nil
	}
	for _, p := range csv(os.Getenv("PORTAL_CHECK_ALLOWED_PORTS")) {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return c, errors.New("invalid PORTAL_CHECK_ALLOWED_PORTS")
		}
		c.CheckPorts = append(c.CheckPorts, n)
	}
	if inheritIntegrationPolicy == "false" && len(c.CheckPorts) == 0 {
		c.CheckPorts = []int{80, 443}
	}
	if v := os.Getenv("PORTAL_SESSION_HOURS"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 24 {
			return c, errors.New("PORTAL_SESSION_HOURS must be 1..24")
		}
		c.SessionLifetime = time.Duration(n) * time.Hour
	}
	u, e := url.Parse(c.PublicURL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return c, errors.New("invalid PORTAL_PUBLIC_URL")
	}
	c.PublicURL = strings.TrimRight(c.PublicURL, "/")
	if c.DatabaseURL == "" {
		return c, errors.New("PORTAL_DATABASE_URL required")
	}
	if !c.Demo && u.Scheme != "https" {
		return c, errors.New("production requires HTTPS PUBLIC_URL")
	}
	oidcConfigured := c.Issuer != "" && c.ClientID != "" && c.ClientSecret != "" && c.AllowedGroup != ""
	if !c.Demo && !oidcConfigured && !c.adEnabled() && c.LocalAdminHashFile == "" {
		return c, errors.New("production requires complete OIDC or AD configuration, or explicitly configured local administrator")
	}
	if c.Demo && (u.Scheme != "http" && u.Scheme != "https") {
		return c, errors.New("invalid public URL scheme")
	}
	var doskaErr error
	c.Doska, c.DoskaAD, doskaErr = loadDoskaConfig()
	if doskaErr != nil {
		return c, doskaErr
	}
	if c.Doska != nil {
		for _, existing := range c.ServiceGateways {
			if bytes.Equal(existing.Key, c.Doska.Key) {
				return c, errors.New("Doska requires an independent gateway key")
			}
		}
	}
	var formsErr error
	c.Forms, formsErr = loadFormsConfig()
	if formsErr != nil {
		return c, formsErr
	}
	if formsErr = c.validateFormsKey(); formsErr != nil {
		return c, formsErr
	}
	return c, nil
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func csv(v string) []string {
	out := []string{}
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Require a literal origin: do not trim, repair or normalize operator input.
func validProxyControlOrigin(origin string) bool {
	for _, ch := range origin {
		if ch <= 32 || ch >= 127 || ch == '\\' || ch == '%' {
			return false
		}
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Opaque != "" || u.Host == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || origin != u.Scheme+"://"+u.Host {
		return false
	}
	host := u.Hostname()
	if host == "" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return false
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if strings.HasPrefix(u.Host, "[") {
		return net.ParseIP(host) != nil && strings.Contains(host, ":")
	}
	if strings.Contains(host, ":") || len(host) > 253 {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	onlyNumeric := true
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-') {
				return false
			}
			if ch < '0' || ch > '9' {
				onlyNumeric = false
			}
		}
	}
	return !onlyNumeric
}
