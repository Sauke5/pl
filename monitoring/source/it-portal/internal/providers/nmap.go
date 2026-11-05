package providers

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const nmapOutputLimit = 256 << 10

func parseNmapTarget(target string) (string, []int, error) {
	host, portList, err := net.SplitHostPort(strings.TrimSpace(target))
	if err != nil || host == "" || len(host) > 253 || strings.ContainsAny(host, " /\\\t\r\n%") || strings.HasPrefix(host, "-") {
		return "", nil, errors.New("nmap requires one host and explicit TCP ports")
	}
	if net.ParseIP(host) == nil {
		for _, c := range host {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_') {
				return "", nil, errors.New("invalid scan hostname")
			}
		}
	}
	parts := strings.Split(portList, ",")
	if len(parts) == 0 || len(parts) > 16 {
		return "", nil, errors.New("select at most 16 TCP ports")
	}
	ports := []int{}
	seen := map[int]bool{}
	for _, value := range parts {
		for _, c := range value {
			if c < '0' || c > '9' {
				return "", nil, errors.New("scan ports must be numeric")
			}
		}
		port, e := strconv.Atoi(value)
		if e != nil || port < 1 || port > 65535 {
			return "", nil, errors.New("invalid scan port")
		}
		if !seen[port] {
			ports = append(ports, port)
			seen[port] = true
		}
	}
	sort.Ints(ports)
	return host, ports, nil
}

type nmapLimitedBuffer struct {
	bytes.Buffer
	exceeded bool
}

func (b *nmapLimitedBuffer) Write(p []byte) (int, error) {
	if len(p) > nmapOutputLimit-b.Len() {
		b.exceeded = true
		return 0, errors.New("scan output limit exceeded")
	}
	return b.Buffer.Write(p)
}
func runNmap(ctx context.Context, path string, args []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.WaitDelay = time.Second
	var stdout, stderr nmapLimitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if stdout.exceeded || stderr.exceeded {
			return nil, errors.New("scan output limit exceeded")
		}
		return nil, errors.New("port scanner failed or is unavailable")
	}
	return stdout.Bytes(), nil
}

type nmapPortResult struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	State    string `json:"state"`
	Reason   string `json:"reason"`
	Service  string `json:"service"`
}

func parseNmapOutput(data []byte, ip net.IP, ports []int) ([]nmapPortResult, error) {
	var doc struct {
		XMLName xml.Name `xml:"nmaprun"`
		Hosts   []struct {
			Addresses []struct {
				Addr string `xml:"addr,attr"`
			} `xml:"address"`
			Ports []struct {
				Port     int    `xml:"portid,attr"`
				Protocol string `xml:"protocol,attr"`
				State    struct {
					State  string `xml:"state,attr"`
					Reason string `xml:"reason,attr"`
				} `xml:"state"`
				Service struct {
					Name string `xml:"name,attr"`
				} `xml:"service"`
			} `xml:"ports>port"`
			Extra []struct {
				State   string `xml:"state,attr"`
				Count   int    `xml:"count,attr"`
				Reasons []struct {
					Reason string `xml:"reason,attr"`
					Count  int    `xml:"count,attr"`
				} `xml:"extrareasons"`
			} `xml:"ports>extraports"`
		} `xml:"host"`
		Finished struct {
			Exit string `xml:"exit,attr"`
		} `xml:"runstats>finished"`
	}
	decoder := xml.NewDecoder(io.LimitReader(bytes.NewReader(data), nmapOutputLimit+1))
	if err := decoder.Decode(&doc); err != nil || len(data) > nmapOutputLimit || doc.Finished.Exit != "success" || len(doc.Hosts) != 1 {
		return nil, errors.New("port scanner returned incomplete results")
	}
	host := doc.Hosts[0]
	matches := false
	for _, addr := range host.Addresses {
		if parsed := net.ParseIP(addr.Addr); parsed != nil && parsed.Equal(ip) {
			matches = true
		}
	}
	if !matches {
		return nil, errors.New("port scanner returned an unexpected host")
	}
	out := make([]nmapPortResult, 0, len(ports))
	for _, port := range ports {
		result := nmapPortResult{Port: port, Protocol: "tcp", State: "unknown"}
		for _, p := range host.Ports {
			if p.Port == port && p.Protocol == "tcp" {
				result.State = p.State.State
				result.Reason = p.State.Reason
				result.Service = p.Service.Name
				break
			}
		}
		out = append(out, result)
	}
	// Nmap may group identical closed/filtered ports in XML. Only expand a
	// single group accounting for exactly all omitted requested ports.
	missing := 0
	for _, result := range out {
		if result.State == "unknown" {
			missing++
		}
	}
	if len(host.Extra) == 1 && host.Extra[0].Count == missing && (host.Extra[0].State == "closed" || host.Extra[0].State == "filtered") {
		group := host.Extra[0]
		reason := ""
		if len(group.Reasons) == 1 && group.Reasons[0].Count == missing {
			reason = group.Reasons[0].Reason
		}
		for i := range out {
			if out[i].State == "unknown" {
				out[i].State = group.State
				out[i].Reason = reason
			}
		}
	}
	return out, nil
}
func (r *Registry) nmapCheck(ctx context.Context, target string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	started := time.Now()
	host, ports, err := parseNmapTarget(target)
	if err != nil {
		return nil, err
	}
	guard := r.interactiveGuard()
	if guard == nil {
		return nil, errors.New("check policy is unavailable")
	}
	ips, err := guard.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, errors.New("host has no addresses")
	}
	// Validate every resolved address before pinning one. No second DNS lookup is
	// performed by the scanner, including service-name resolution.
	for _, port := range ports {
		if err = guard.ValidatePortIPs(ips, port); err != nil {
			return nil, err
		}
	}
	ip := ips[0]
	// A new portable installation needs only a bounded TCP connect probe. Keep
	// the explicit Nmap adapter for administrators providing their own scanner.
	if os.Getenv("PORTAL_NMAP_PATH") == "" {
		results, err := connectPortResults(ctx, ip, ports)
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": "nmap", "scanner": "tcp_connect", "target": target, "origin": "portal backend", "source": "portal_check", "ports": results, "scanned_address": ip.String(), "duration_ms": time.Since(started).Milliseconds(), "observed_at": started.UTC(), "scope": "selected_ports", "description": fmt.Sprintf("TCP: %d selected ports", len(ports))}, nil
	}
	values := make([]string, len(ports))
	for i, p := range ports {
		values[i] = strconv.Itoa(p)
	}
	args := []string{"-sT", "-Pn", "-n", "--max-retries", "1", "--host-timeout", "20s", "--reason", "-p", strings.Join(values, ","), "-oX", "-"}
	if ip.To4() == nil {
		args = append(args, "-6")
	}
	args = append(args, ip.String())
	path := os.Getenv("PORTAL_NMAP_PATH")
	if path == "" {
		path = "/usr/bin/nmap"
	}
	data, err := runNmap(ctx, path, args)
	if err != nil {
		return nil, err
	}
	results, err := parseNmapOutput(data, ip, ports)
	if err != nil {
		return nil, err
	}
	return map[string]any{"kind": "nmap", "target": target, "origin": "portal backend", "source": "portal_check", "ports": results, "scanned_address": ip.String(), "duration_ms": time.Since(started).Milliseconds(), "observed_at": started.UTC(), "scope": "selected_ports", "description": fmt.Sprintf("TCP: %d selected ports", len(ports))}, nil
}

// connectPortResults uses the already validated numeric address: no second DNS
// lookup, raw sockets, service fingerprinting or arbitrary network range scan.
// At most sixteen ports are admitted by parseNmapTarget; concurrency is four.
func connectPortResults(ctx context.Context, ip net.IP, ports []int) ([]nmapPortResult, error) {
	results := make([]nmapPortResult, len(ports))
	slots := make(chan struct{}, 4)
	var tasks sync.WaitGroup
	for index, port := range ports {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			tasks.Wait()
			return nil, ctx.Err()
		}
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			defer func() { <-slots }()
			value := nmapPortResult{Port: port, Protocol: "tcp", State: "filtered", Reason: "no-response"}
			conn, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), strconv.Itoa(port)))
			if err == nil {
				conn.Close()
				value.State, value.Reason = "open", "connected"
			} else if errors.Is(err, syscall.ECONNREFUSED) {
				value.State, value.Reason = "closed", "conn-refused"
			} else if errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
				value.Reason = "unreachable"
			}
			results[index] = value
		}()
	}
	tasks.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return results, nil
}
