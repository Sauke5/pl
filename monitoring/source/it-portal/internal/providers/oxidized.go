package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"pl/portal/internal/model"
)

// Only these fields survive decoding; connection parameters and config bodies
// never enter the snapshot, cache, or API response.
type oxidizedNode struct {
	Name   string `json:"name"`
	Group  string `json:"group"`
	Status string `json:"status"`
	Last   struct {
		Status string `json:"status"`
		End    string `json:"end"`
	} `json:"last"`
}
type oxidizedVersion struct {
	OID  string          `json:"oid"`
	Time json.RawMessage `json:"time"`
}

func (r *Registry) oxidizedRead(ctx context.Context, i model.Integration, path string, query url.Values, out any) error {
	raw, err := endpoint(i.URL, path)
	if err != nil {
		return err
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid Oxidized URL")
	}
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return errors.New("invalid Oxidized request")
	}
	token, err := secret(i.SecretRef)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := r.guard.Client(timeout(i))
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("Oxidized request failed (network, policy or TLS)")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("Oxidized metadata unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return errors.New("Oxidized response interrupted or too large")
	}
	if json.Unmarshal(body, out) != nil {
		return errors.New("Oxidized returned malformed metadata")
	}
	return nil
}

func oxidizedTime(raw json.RawMessage) *time.Time {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05 MST"} {
			if v, err := time.Parse(layout, text); err == nil {
				v = v.UTC()
				return &v
			}
		}
	}
	var seconds float64
	if json.Unmarshal(raw, &seconds) == nil && seconds > 0 && seconds < 1e11 {
		v := time.Unix(int64(seconds), 0).UTC()
		return &v
	}
	return nil
}

func (r *Registry) pollOxidized(ctx context.Context, i model.Integration) (model.Snapshot, error) {
	result := model.Snapshot{}
	if err := model.ValidateOxidizedConfig(i.Config); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout(i))
	defer cancel()
	var upstream []oxidizedNode
	if err := r.oxidizedRead(ctx, i, "/nodes.json", nil, &upstream); err != nil {
		return result, err
	}
	if upstream == nil || len(upstream) > model.ConfigurationNodeLimit {
		return result, errors.New("Oxidized node list missing or exceeds limit")
	}
	snapshot := &model.ConfigurationSnapshot{ObservedAt: time.Now().UTC(), Nodes: make([]model.ConfigurationNode, len(upstream))}
	seen := map[string]bool{}
	for n, node := range upstream {
		key := node.Group + "/" + node.Name
		if !model.ValidConfigurationPath(key) || strings.Contains(node.Name, "/") || seen[key] {
			return result, errors.New("Oxidized node identity invalid or ambiguous")
		}
		seen[key] = true
		status := "unknown"
		switch node.Status {
		case "success":
			status = "success"
		case "failed", "failure", "no_connection", "timeout":
			status = "failed"
		case "never":
			status = "never"
		}
		projected := model.ConfigurationNode{Key: key, Name: node.Name, Group: node.Group, CollectionStatus: status}
		if node.Last.Status == "success" {
			raw, _ := json.Marshal(node.Last.End)
			projected.LastSuccessfulCollectionAt = oxidizedTime(raw)
		}
		snapshot.Nodes[n] = projected
	}
	workers := i.Concurrency
	if workers < 1 {
		workers = 4
	}
	if workers > 4 {
		workers = 4
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := range jobs {
				node := &snapshot.Nodes[n]
				var versions []oxidizedVersion
				if err := r.oxidizedRead(ctx, i, "/node/version.json", url.Values{"node_full": {node.Key}}, &versions); err != nil {
					node.Error = "Не удалось получить историю изменений"
					continue
				}
				if versions == nil {
					node.Error = "Oxidized вернул неполную историю изменений"
					continue
				}
				if len(versions) > 1000 {
					node.Error = "История превышает допустимый размер"
					continue
				}
				if len(versions) > 0 {
					latest := versions[0]
					stamp := oxidizedTime(latest.Time)
					if !model.ValidConfigurationRevision(latest.OID) || stamp == nil {
						node.Error = "Некорректная версия изменения"
						continue
					}
					node.Revision = strings.ToLower(latest.OID)
					node.LastChangeAt = stamp
				}
			}
		}()
	}
	for n := range snapshot.Nodes {
		jobs <- n
	}
	close(jobs)
	wg.Wait()
	result.Configuration = snapshot
	return result, nil
}

// ProbeOxidized uses exactly the same bounded metadata routes as polling.
func (r *Registry) ProbeOxidized(ctx context.Context, i model.Integration) error {
	snapshot, err := r.pollOxidized(ctx, i)
	if err != nil {
		return err
	}
	if snapshot.Configuration == nil {
		return errors.New("Oxidized metadata missing")
	}
	for _, node := range snapshot.Configuration.Nodes {
		if node.Error != "" {
			return errors.New("Oxidized metadata incomplete")
		}
	}
	return nil
}
