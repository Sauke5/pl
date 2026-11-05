package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"pl/portal/internal/netguard"
)

// loadDoskaConfig is opt-in and does not connect to AD or provision credentials.
// The configuration is nonsecret; actual credentials are file references only.
func loadDoskaConfig() (*DoskaGatewayConfig, *DoskaADSourceConfig, error) {
	path := os.Getenv("PORTAL_DOSKA_CONFIG_FILE")
	if path == "" {
		return nil, nil, nil
	}
	invalid := errors.New("invalid Doska configuration")
	var file struct {
		APIUpstream  string                 `json:"api_upstream"`
		WebUpstream  string                 `json:"web_upstream"`
		KeyFile      string                 `json:"key_file"`
		ManifestFile string                 `json:"manifest_file"`
		AllowedCIDRs []string               `json:"allowed_cidrs"`
		Events       bool                   `json:"events,omitempty"`
		Attachments  *DoskaAttachmentConfig `json:"attachments,omitempty"`
		AD           *struct {
			URL                   string   `json:"url"`
			BaseDN                string   `json:"base_dn"`
			CAFile                string   `json:"ca_file"`
			BindDNFile            string   `json:"bind_dn_file"`
			BindPasswordFile      string   `json:"bind_password_file"`
			ScopeGroupGUIDs       []string `json:"scope_group_guids"`
			MaxDiscoveryEmployees int      `json:"max_discovery_employees"`
		} `json:"ad"`
	}
	data, err := doskaReadFile(path, 64<<10)
	if err != nil {
		return nil, nil, invalid
	}
	if doskaStrictJSON(data, &file) != nil || !filepath.IsAbs(file.KeyFile) || !filepath.IsAbs(file.ManifestFile) || len(file.AllowedCIDRs) == 0 || len(file.AllowedCIDRs) > 32 {
		return nil, nil, invalid
	}
	key, err := doskaReadFile(file.KeyFile, 32)
	if err != nil || len(key) != 32 {
		return nil, nil, invalid
	}
	raw, err := doskaReadFile(file.ManifestFile, 512<<10)
	if err != nil {
		return nil, nil, invalid
	}
	var manifest DoskaGatewayManifest
	if doskaStrictJSON(raw, &manifest) != nil {
		return nil, nil, invalid
	}
	if _, err = compileDoskaManifest(manifest); err != nil {
		return nil, nil, invalid
	}
	ports := []int{}
	for _, address := range []string{file.APIUpstream, file.WebUpstream} {
		u, e := url.Parse(address)
		if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" && u.Path != "/" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
			return nil, nil, invalid
		}
		port := 80
		if u.Scheme == "https" {
			port = 443
		}
		if u.Port() != "" {
			port, e = strconv.Atoi(u.Port())
			if e != nil || port < 1 || port > 65535 {
				return nil, nil, invalid
			}
		}
		ports = append(ports, port)
	}
	guard, err := netguard.New(file.AllowedCIDRs, ports, "")
	if err != nil {
		return nil, nil, invalid
	}
	for _, address := range []string{file.APIUpstream, file.WebUpstream} {
		u, _ := url.Parse(address)
		if guard.ValidateURL(u) != nil {
			return nil, nil, invalid
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := guard.Resolve(ctx, u.Hostname())
		cancel()
		if err != nil {
			return nil, nil, invalid
		}
	}
	var ad *DoskaADSourceConfig
	if file.AD != nil {
		value := file.AD
		ad = &DoskaADSourceConfig{URL: value.URL, BaseDN: value.BaseDN, CAFile: value.CAFile, BindDNFile: value.BindDNFile, BindPasswordFile: value.BindPasswordFile, ScopeGroupGUIDs: value.ScopeGroupGUIDs, MaxDiscoveryEmployees: value.MaxDiscoveryEmployees}
		if _, err = NewDoskaADSource(*ad); err != nil {
			return nil, nil, invalid
		}
	}
	return &DoskaGatewayConfig{APIUpstream: file.APIUpstream, WebUpstream: file.WebUpstream, Key: key, Manifest: manifest, Guard: guard, Attachments: file.Attachments, Events: file.Events}, ad, nil
}

func doskaReadFile(path string, max int) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("absolute file required")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() > int64(max) {
		return nil, errors.New("invalid bounded file")
	}
	data, e := io.ReadAll(io.LimitReader(f, int64(max)+1))
	if e != nil || len(data) > max {
		return nil, errors.New("file exceeds bound")
	}
	return data, nil
}

// DisallowUnknownFields alone permits duplicate JSON object keys. Reject them
// at every depth before decoding the bounded configuration into typed structs.
func doskaStrictJSON(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	var visit func(int) error
	visit = func(depth int) error {
		if depth > 32 {
			return errors.New("JSON nesting exceeds bound")
		}
		token, e := d.Token()
		if e != nil {
			return e
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				name, e := d.Token()
				if e != nil {
					return e
				}
				key, ok := name.(string)
				if !ok || seen[key] {
					return errors.New("duplicate JSON key")
				}
				seen[key] = true
				if e = visit(depth + 1); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e := visit(depth + 1); e != nil {
					return e
				}
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		_, e = d.Token()
		return e
	}
	if e := visit(0); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return errors.New("trailing JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(out); e != nil {
		return e
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
