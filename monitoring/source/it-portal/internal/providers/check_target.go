package providers

import (
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"

	"pl/portal/internal/model"
)

// ResourceCheckTarget preserves the explicit target → entry URL fallback.
// Hostname/IP are not substituted: TCP requires an explicitly selected port.
func ResourceCheckTarget(r model.Resource) string {
	if target := strings.TrimSpace(r.Check.Target); target != "" {
		return target
	}
	return strings.TrimSpace(r.URL)
}

// ValidateCheckTarget checks syntax only. Resolution and destination/port policy
// remain enforced by netguard at execution, without network I/O during enqueue.
func ValidateCheckTarget(kind, target string) error {
	target = strings.TrimSpace(target)
	messages := map[string]string{
		"tcp":         "Укажите адрес и TCP-порт, например server:443",
		"tls":         "Укажите имя сервера, IP-адрес или HTTPS-адрес",
		"http":        "Укажите HTTP(S)-адрес или имя сайта",
		"dns":         "Укажите имя сервера, IP-адрес или адрес сайта",
		"dns_records": "Укажите доменное имя или адрес сайта",
		"reverse_dns": "Укажите IPv4 или IPv6 адрес",
		"nmap":        "Укажите один сервер и порты через запятую, например server:22,443",
	}
	message := messages[kind]
	if message == "" {
		message = "Укажите корректную цель проверки"
	}
	invalid := errors.New(message)
	if target == "" || len(target) > 4096 || strings.ContainsAny(target, "\r\n\x00\t") {
		return invalid
	}
	validHost := func(host string) bool {
		return host != "" && (net.ParseIP(host) != nil || !strings.ContainsAny(host, "/\\:@%?# []"))
	}
	validURL := func(value string) bool {
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || !validHost(u.Hostname()) || strings.HasSuffix(u.Host, ":") {
			return false
		}
		if port := u.Port(); port != "" {
			n, err := strconv.Atoi(port)
			return err == nil && n > 0 && n <= 65535
		}
		return true
	}
	switch kind {
	case "http":
		if !strings.Contains(target, "://") {
			target = "https://" + target
		}
		if validURL(target) {
			return nil
		}
	case "tcp", "tls":
		if strings.Contains(target, "://") {
			if validURL(target) {
				return nil
			}
			return invalid
		}
		if kind == "tls" && (net.ParseIP(target) != nil || !strings.ContainsAny(target, "/: ")) {
			target = net.JoinHostPort(target, "443")
		}
		address, host, err := checkAddress(target, kind)
		if err == nil && address != "" && validHost(host) {
			return nil
		}
	case "dns", "dns_records", "reverse_dns":
		host := checkTargetHost(target)
		if strings.Contains(target, "://") {
			if !validURL(target) {
				return invalid
			}
		} else if host != target {
			if _, _, err := checkAddress(target, "tcp"); err != nil {
				return invalid
			}
		}
		if kind == "reverse_dns" {
			if net.ParseIP(host) != nil {
				return nil
			}
		} else if validHost(host) && (kind != "dns_records" || net.ParseIP(host) == nil) {
			return nil
		}
	case "nmap":
		if _, _, err := parseNmapTarget(target); err == nil {
			return nil
		}
	case "icmp":
		return ValidateICMPTarget(target)
	case "iperf":
		return ValidateIperfParameters(target, nil)
	}
	return invalid
}

// checkTargetHost allows DNS tools to reuse a pasted service URL or host:port.
// ValidateCheckTarget validates the whole input before execution.
func checkTargetHost(target string) string {
	if strings.Contains(target, "://") {
		if u, err := url.Parse(target); err == nil {
			return u.Hostname()
		}
	}
	if net.ParseIP(target) != nil {
		return target
	}
	if host, _, err := net.SplitHostPort(target); err == nil {
		return host
	}
	return target
}
