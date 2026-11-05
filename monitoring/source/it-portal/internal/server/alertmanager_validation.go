package server

import (
	"crypto/x509"
	"encoding/json"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"pl/portal/internal/model"
)

var alertmanagerMailbox = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+/=?^_`|~.-]+@[A-Za-z0-9.-]+$")

func validAlertmanagerMailbox(v string) bool {
	if len(v) > 254 || !alertmanagerMailbox.MatchString(v) {
		return false
	}
	local, host, _ := strings.Cut(v, "@")
	return len(local) <= 64 && !strings.HasPrefix(local, ".") && !strings.HasSuffix(local, ".") && !strings.Contains(local, "..") && !strings.HasSuffix(host, ".") && alertmanagerHost(host)
}
func validAlertmanagerMessage(v *model.AlertmanagerEmailMessage) bool {
	if v == nil {
		return true
	}
	if v.Title == "" || !alertmanagerText(v.Title, 80) || !alertmanagerText(v.Footer, 240) || !alertmanagerText(v.PlatformURL, 2048) {
		return false
	}
	if v.PlatformURL == "" {
		return true
	}
	u, err := url.Parse(v.PlatformURL)
	return err == nil && alertmanagerURL(v.PlatformURL, false) && u.RawQuery == "" && !u.ForceQuery && !strings.ContainsAny(v.PlatformURL, "{}?#")
}
func validAlertmanagerSMTP(v *model.AlertmanagerSMTPInput) bool {
	if v == nil || !validAlertmanagerMessage(v.Message) || !alertmanagerText(v.Smarthost, 320) || !alertmanagerText(v.Username, 128) || !alertmanagerText(v.Password, 1024) || (v.Username == "" && v.Password != "") || (v.TLSMode != "starttls" && v.TLSMode != "implicit") || !validAlertmanagerMailbox(v.From) || len(v.To) < 1 || len(v.To) > 32 {
		return false
	}
	host, rawPort, err := net.SplitHostPort(v.Smarthost)
	port, portErr := strconv.Atoi(rawPort)
	if err != nil || (!alertmanagerHost(host) || strings.HasSuffix(host, ".")) || portErr != nil || port < 1 || port > 65535 || net.JoinHostPort(host, strconv.Itoa(port)) != v.Smarthost {
		return false
	}
	seen := map[string]bool{}
	for _, recipient := range v.To {
		if !validAlertmanagerMailbox(recipient) || seen[recipient] {
			return false
		}
		seen[recipient] = true
	}
	return true
}

var alertmanagerName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
var alertmanagerDuration = regexp.MustCompile(`^(0|[1-9][0-9]{0,6})(s|m|h)$`)
var alertmanagerHostPart = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

func alertmanagerText(v string, max int) bool {
	return len(v) <= max && !strings.ContainsFunc(v, unicode.IsControl)
}
func alertmanagerHost(host string) bool {
	if net.ParseIP(host) != nil {
		return true
	}
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	for _, part := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if !alertmanagerHostPart.MatchString(part) {
			return false
		}
	}
	return true
}
func alertmanagerURL(raw string, proxy bool) bool {
	if !alertmanagerText(raw, 8192) {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Fragment != "" || !alertmanagerHost(u.Hostname()) {
		return false
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return false
		}
	}
	if proxy {
		return u.Scheme == "http" && u.Port() != "" && (u.Path == "" || u.Path == "/") && u.RawQuery == "" && u.ForceQuery == false
	}
	return u.Scheme == "https"
}
func alertmanagerNoProxy(v string) bool {
	if !alertmanagerText(v, 256) || v == "" || strings.TrimSpace(v) != v {
		return false
	}
	if prefix, err := netip.ParsePrefix(v); err == nil {
		return prefix == prefix.Masked() && prefix.String() == v
	}
	return alertmanagerHost(strings.TrimPrefix(v, "."))
}
func validAlertmanagerInput(c model.AlertmanagerConfigurationInput) bool {
	raw, err := json.Marshal(c)
	if err != nil || len(raw) > 256<<10 {
		return false
	}
	if c.Revision < 0 || c.Revision >= (1<<53)-1 || c.Receivers == nil || len(c.Receivers) > 32 {
		return false
	}
	duration := func(raw string, min time.Duration) (time.Duration, bool) {
		v, e := time.ParseDuration(raw)
		return v, e == nil && alertmanagerDuration.MatchString(raw) && v >= min && v <= 168*time.Hour
	}
	if _, ok := duration(c.Route.GroupWait, 0); !ok {
		return false
	}
	interval, ok := duration(c.Route.GroupInterval, time.Second)
	if !ok {
		return false
	}
	if _, ok := duration(c.Route.RepeatInterval, interval); !ok {
		return false
	}
	names := map[string]bool{}
	for _, r := range c.Receivers {
		if !alertmanagerName.MatchString(r.Name) || names[r.Name] || (r.Kind != "webhook" && r.Kind != "telegram" && r.Kind != "slack" && r.Kind != "discord" && r.Kind != "email" && r.Kind != "msteamsv2" && r.Kind != "pagerduty") {
			return false
		}
		names[r.Name] = true
		if r.Kind == "email" {
			if !validAlertmanagerSMTP(r.SMTP) || r.Endpoint != "" || r.Token != "" || r.ChatID != 0 || r.Proxy.Mode != "direct" {
				return false
			}
		} else if r.SMTP != nil {
			return false
		}
		if (r.Endpoint != "" && !alertmanagerURL(r.Endpoint, false)) || !alertmanagerText(r.Token, 4096) {
			return false
		}
		if r.Kind == "telegram" {
			if r.ChatID == 0 || r.ChatID < -((1<<53)-1) || r.ChatID > (1<<53)-1 {
				return false
			}
		} else if (r.Kind != "pagerduty" && r.Token != "") || r.ChatID != 0 {
			return false
		}
		if r.Kind == "pagerduty" && (strings.ContainsAny(r.Token, "{}") || strings.ContainsFunc(r.Token, unicode.IsSpace)) {
			return false
		}
		p := r.Proxy
		if p.NoProxy == nil || len(p.NoProxy) > 128 || !alertmanagerText(p.Username, 128) || strings.Contains(p.Username, ":") || !alertmanagerText(p.Password, 1024) || len(p.CAPEM) > 64<<10 || (p.ClearCA && p.CAPEM != "") {
			return false
		}
		if p.CAPEM != "" {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(p.CAPEM)) {
				return false
			}
		}
		if p.Mode == "direct" {
			if p.URL != "" || p.Username != "" || p.Password != "" || len(p.NoProxy) != 0 {
				return false
			}
		} else if p.Mode == "http" {
			if !alertmanagerURL(p.URL, true) || (p.Username == "" && p.Password != "") {
				return false
			}
			seen := map[string]bool{}
			for _, host := range p.NoProxy {
				if seen[host] || !alertmanagerNoProxy(host) {
					return false
				}
				seen[host] = true
			}
		} else {
			return false
		}
	}
	if len(c.Receivers) == 0 {
		return c.Route.Receiver == ""
	}
	return names[c.Route.Receiver]
}

func validAlertmanagerPublic(c model.AlertmanagerConfiguration) bool {
	input := model.AlertmanagerConfigurationInput{Revision: c.Revision, Ref: c.Ref, Route: c.Route, Receivers: []model.AlertmanagerReceiverInput{}}
	for _, r := range c.Receivers {
		if r.Kind == "pagerduty" && !r.TokenSet {
			return false
		}
		var smtp *model.AlertmanagerSMTPInput
		if r.SMTP != nil {
			smtp = &model.AlertmanagerSMTPInput{Message: r.SMTP.Message, Smarthost: r.SMTP.Smarthost, From: r.SMTP.From, To: r.SMTP.To, TLSMode: r.SMTP.TLSMode, Username: r.SMTP.Username, PasswordSet: r.SMTP.PasswordSet}
		}
		if r.Kind == "email" && (r.EndpointSet || r.TokenSet || r.SMTP == nil || (r.SMTP.Username != "") != r.SMTP.PasswordSet) {
			return false
		}
		input.Receivers = append(input.Receivers, model.AlertmanagerReceiverInput{Name: r.Name, Kind: r.Kind, ChatID: r.ChatID, SMTP: smtp, Proxy: model.AlertmanagerProxyInput{Mode: r.Proxy.Mode, URL: r.Proxy.URL, Username: r.Proxy.Username, NoProxy: r.Proxy.NoProxy}})
	}
	return validAlertmanagerInput(input)
}
