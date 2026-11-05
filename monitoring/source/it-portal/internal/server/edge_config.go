package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// EdgeConfig is backend-only. Its contents must never be serialized or logged.
type EdgeConfig struct {
	endpoint  string
	token     string
	transport http.RoundTripper // Tests only; production always uses normal TLS validation.
}

var errEdgeConfig = errors.New("invalid Edge configuration")

func loadEdgeConfig() (EdgeConfig, error) {
	configPath := os.Getenv("PORTAL_EDGE_CONFIG_FILE")
	if configPath == "" {
		return EdgeConfig{}, nil
	}
	raw, err := edgePrivateFile(filepath.Dir(configPath), filepath.Base(configPath), 16<<10)
	if err != nil {
		return EdgeConfig{}, errEdgeConfig
	}
	// A token-level pass rejects duplicate and unknown keys, including escaped aliases.
	dec := json.NewDecoder(bytes.NewReader(raw))
	first, err := dec.Token()
	if err != nil || first != json.Delim('{') {
		return EdgeConfig{}, errEdgeConfig
	}
	values := map[string]string{}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return EdgeConfig{}, errEdgeConfig
		}
		name, ok := key.(string)
		if !ok || (name != "api_base_url" && name != "token_file") {
			return EdgeConfig{}, errEdgeConfig
		}
		if _, exists := values[name]; exists {
			return EdgeConfig{}, errEdgeConfig
		}
		var value string
		if dec.Decode(&value) != nil {
			return EdgeConfig{}, errEdgeConfig
		}
		values[name] = value
	}
	if end, err := dec.Token(); err != nil || end != json.Delim('}') {
		return EdgeConfig{}, errEdgeConfig
	}
	if _, err := dec.Token(); err != io.EOF {
		return EdgeConfig{}, errEdgeConfig
	}
	endpoint, ok := edgeEndpoint(values["api_base_url"])
	if !ok {
		return EdgeConfig{}, errEdgeConfig
	}
	tokenPath := values["token_file"]
	if tokenPath == "" {
		return EdgeConfig{}, errEdgeConfig
	}
	if filepath.IsAbs(tokenPath) {
		tokenPath, err = filepath.Rel(filepath.Dir(configPath), tokenPath)
		if err != nil {
			return EdgeConfig{}, errEdgeConfig
		}
	}
	token, err := edgePrivateFile(filepath.Dir(configPath), tokenPath, 4096)
	if err != nil {
		return EdgeConfig{}, errEdgeConfig
	}
	value := strings.TrimSuffix(strings.TrimSuffix(string(token), "\n"), "\r")
	if len(value) == 0 {
		return EdgeConfig{}, errEdgeConfig
	}
	for _, c := range value {
		if c <= 32 || c >= 127 {
			return EdgeConfig{}, errEdgeConfig
		}
	}
	return EdgeConfig{endpoint: endpoint, token: value}, nil
}

func edgeEndpoint(raw string) (string, bool) {
	if len(raw) > 4096 || strings.ContainsAny(raw, "?#") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !validProxyControlOrigin(u.Scheme+"://"+u.Host) || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" {
		return "", false
	}
	// Restrict the fixed base path to plain URI segments: no encoded traversal or separators.
	if strings.ContainsAny(u.EscapedPath(), "%\\") || strings.Contains(u.Path, "//") {
		return "", false
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return "", false
		}
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/panel/api/server/status"
	return u.String(), true
}

func edgePrivateFile(dir, name string, limit int64) ([]byte, error) {
	if !filepath.IsLocal(name) {
		return nil, errEdgeConfig
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, errEdgeConfig
	}
	defer root.Close()
	f, err := root.Open(name)
	if err != nil {
		return nil, errEdgeConfig
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > limit {
		return nil, errEdgeConfig
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errEdgeConfig
	}
	return data, nil
}
