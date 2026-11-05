package model

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const ConfigurationNodeLimit = 100

type ConfigurationNode struct {
	Key                        string     `json:"key"`
	Name                       string     `json:"name"`
	Group                      string     `json:"group"`
	CollectionStatus           string     `json:"collection_status"`
	LastSuccessfulCollectionAt *time.Time `json:"last_successful_collection_at"`
	LastChangeAt               *time.Time `json:"last_change_at"`
	Revision                   string     `json:"revision"`
	HistoryURL                 string     `json:"history_url"`
	DiffURL                    string     `json:"diff_url"`
	Error                      string     `json:"error,omitempty"`
	ResourceID                 string     `json:"resource_id,omitempty"`
}

type ConfigurationSnapshot struct {
	ObservedAt time.Time           `json:"observed_at"`
	Nodes      []ConfigurationNode `json:"nodes"`
}

type ConfigurationHistory struct {
	IntegrationID string              `json:"integration_id"`
	ObservedAt    *time.Time          `json:"observed_at"`
	LastSuccessAt *time.Time          `json:"last_success_at"`
	SourceStatus  string              `json:"source_status"`
	Stale         bool                `json:"stale"`
	Nodes         []ConfigurationNode `json:"nodes"`
}

var configurationRevision = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func ValidConfigurationRevision(s string) bool { return configurationRevision.MatchString(s) }

// Paths are exact locators, never wildcard, URL or relative path expressions.
func ValidConfigurationPath(s string) bool {
	if s == "" || len(s) > 512 || strings.ContainsAny(s, "\\\r\n\x00?#") {
		return false
	}
	for _, c := range s {
		if c < 32 || c == 127 {
			return false
		}
	}
	for _, p := range strings.Split(s, "/") {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}

func OxidizedBindings(config map[string]string) (map[string]string, error) {
	out := map[string]string{}
	raw := config["node_bindings"]
	if raw == "" {
		return out, nil
	}
	if len(raw) > 16384 || json.Unmarshal([]byte(raw), &out) != nil || out == nil || len(out) > ConfigurationNodeLimit {
		return nil, errors.New("invalid Oxidized node bindings")
	}
	for key, id := range out {
		if !ValidConfigurationPath(key) || !strings.Contains(key, "/") {
			return nil, errors.New("invalid Oxidized node locator")
		}
		if _, err := uuid.Parse(id); err != nil {
			return nil, errors.New("invalid Oxidized resource binding")
		}
	}
	return out, nil
}

func configurationRepository(config map[string]string) (*url.URL, string, error) {
	raw := config["gitea_repository_url"]
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(raw, "\r\n\x00") {
		return nil, "", errors.New("invalid Gitea repository URL")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if !ValidConfigurationPath(strings.TrimPrefix(u.Path, "/")) || len(strings.Split(strings.Trim(u.Path, "/"), "/")) < 2 {
		return nil, "", errors.New("invalid Gitea repository path")
	}
	branch := config["gitea_branch"]
	if branch == "" {
		branch = "main"
	}
	if len(branch) > 128 || !ValidConfigurationPath(branch) {
		return nil, "", errors.New("invalid Gitea branch")
	}
	return u, branch, nil
}

func ValidateOxidizedConfig(config map[string]string) error {
	if _, _, err := configurationRepository(config); err != nil {
		return err
	}
	_, err := OxidizedBindings(config)
	return err
}

func ConfigurationLinks(config map[string]string, key, revision string) (string, string, error) {
	u, branch, err := configurationRepository(config)
	if err != nil {
		return "", "", err
	}
	if !ValidConfigurationPath(key) {
		return "", "", errors.New("invalid configuration node path")
	}
	base := strings.TrimRight(u.String(), "/")
	parts := strings.Split(key, "/")
	for n := range parts {
		parts[n] = url.PathEscape(parts[n])
	}
	history := base + "/commits/branch/" + url.PathEscape(branch) + "/" + strings.Join(parts, "/")
	diff := ""
	if revision != "" {
		if !ValidConfigurationRevision(revision) {
			return "", "", errors.New("invalid configuration revision")
		}
		diff = base + "/commit/" + revision
	}
	return history, diff, nil
}
