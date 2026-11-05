package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

type configurationCache struct {
	Fingerprint   string                      `json:"fingerprint"`
	Snapshot      model.ConfigurationSnapshot `json:"snapshot"`
	LastSuccessAt time.Time                   `json:"last_success_at"`
}

func configurationFingerprint(i model.Integration) string {
	bytes, _ := json.Marshal([]string{i.Kind, i.URL, i.SecretRef})
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:])
}

// Called only after a successful source poll, inside ApplySnapshot's transaction.
func applyConfigurationSnapshot(ctx context.Context, tx pgx.Tx, i model.Integration, snapshot *model.ConfigurationSnapshot, now time.Time) error {
	if snapshot == nil || snapshot.ObservedAt.IsZero() || len(snapshot.Nodes) > model.ConfigurationNodeLimit {
		return errors.New("missing or oversized configuration snapshot")
	}
	var old configurationCache
	var body []byte
	err := tx.QueryRow(ctx, "SELECT body FROM documents WHERE kind='configuration_history' AND id=$1", i.ID).Scan(&body)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if len(body) > 0 {
		if err = json.Unmarshal(body, &old); err != nil {
			return err
		}
	}
	previous := map[string]model.ConfigurationNode{}
	fingerprint := configurationFingerprint(i)
	if old.Fingerprint == fingerprint {
		for _, node := range old.Snapshot.Nodes {
			previous[node.Key] = node
		}
	}
	safe := model.ConfigurationSnapshot{ObservedAt: snapshot.ObservedAt, Nodes: make([]model.ConfigurationNode, 0, len(snapshot.Nodes))}
	seen := map[string]bool{}
	for _, node := range snapshot.Nodes {
		if !model.ValidConfigurationPath(node.Key) || node.Key != node.Group+"/"+node.Name || seen[node.Key] || (node.Revision != "" && !model.ValidConfigurationRevision(node.Revision)) {
			return errors.New("invalid configuration snapshot identity")
		}
		seen[node.Key] = true
		node.ResourceID = ""
		node.HistoryURL = ""
		node.DiffURL = ""
		oldNode := previous[node.Key]
		if node.LastSuccessfulCollectionAt == nil {
			node.LastSuccessfulCollectionAt = oldNode.LastSuccessfulCollectionAt
		}
		// A failed version metadata read does not disprove the previously
		// confirmed revision. Keep the pair together and expose the new error.
		if node.Error != "" && node.Revision == "" && node.LastChangeAt == nil && oldNode.Revision != "" && oldNode.LastChangeAt != nil {
			node.Revision = oldNode.Revision
			node.LastChangeAt = oldNode.LastChangeAt
		}
		safe.Nodes = append(safe.Nodes, node)
	}
	value := configurationCache{Fingerprint: fingerprint, Snapshot: safe, LastSuccessAt: now}
	_, err = tx.Exec(ctx, "INSERT INTO documents(kind,id,body) VALUES('configuration_history',$1,$2) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=now()", i.ID, encode(value))
	return err
}

// ConfigurationHistory reads only the local cache. Current source identity and
// bindings are resolved on every read, so URL changes cannot expose old data.
func (s *Store) ConfigurationHistory(ctx context.Context, integrationID string) (model.ConfigurationHistory, error) {
	var source, body []byte
	err := s.Pool.QueryRow(ctx, `SELECT i.body,c.body FROM documents i LEFT JOIN documents c ON c.kind='configuration_history' AND c.id=i.id WHERE i.kind='integration' AND i.id=$1`, integrationID).Scan(&source, &body)
	if err != nil {
		return model.ConfigurationHistory{}, translate(err)
	}
	i, err := Decode[model.Integration](source)
	if err != nil {
		return model.ConfigurationHistory{}, err
	}
	if i.Kind != "oxidized" {
		return model.ConfigurationHistory{}, ErrNotFound
	}
	out := model.ConfigurationHistory{IntegrationID: i.ID, SourceStatus: "unavailable", Stale: true, Nodes: []model.ConfigurationNode{}}
	if len(body) == 0 {
		return out, nil
	}
	var cache configurationCache
	if json.Unmarshal(body, &cache) != nil {
		return out, errors.New("invalid configuration cache")
	}
	if cache.Fingerprint != configurationFingerprint(i) {
		return out, nil
	}
	bindings, err := model.OxidizedBindings(i.Config)
	if err != nil {
		return out, ErrInvalid
	}
	if err = model.ValidateOxidizedConfig(i.Config); err != nil {
		return out, ErrInvalid
	}
	out.ObservedAt = &cache.Snapshot.ObservedAt
	out.LastSuccessAt = &cache.LastSuccessAt
	out.SourceStatus = "ok"
	out.Stale = false
	for _, node := range cache.Snapshot.Nodes {
		node.ResourceID = bindings[node.Key]
		node.HistoryURL, node.DiffURL, err = model.ConfigurationLinks(i.Config, node.Key, node.Revision)
		if err != nil {
			return out, ErrInvalid
		}
		if node.Error != "" {
			out.SourceStatus = "partial"
			out.Stale = true
		}
		out.Nodes = append(out.Nodes, node)
	}
	// A worker that has stopped polling must not leave an indefinitely fresh cache.
	interval := i.PollSeconds
	if interval <= 0 {
		interval = 60
	}
	if !i.Enabled || i.Status != "connected" || time.Since(cache.LastSuccessAt) > time.Duration(interval*3+max(i.TimeoutSeconds, 15))*time.Second {
		out.SourceStatus = "stale"
		out.Stale = true
	}
	return out, nil
}

func (s *Store) ResourceConfigurationHistory(ctx context.Context, resourceID string) ([]model.ConfigurationHistory, error) {
	if _, err := s.Get(ctx, "resource", resourceID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, "SELECT id FROM documents WHERE kind='integration' AND body->>'kind'='oxidized' ORDER BY id")
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := []model.ConfigurationHistory{}
	for _, id := range ids {
		history, err := s.ConfigurationHistory(ctx, id)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		nodes := []model.ConfigurationNode{}
		for _, node := range history.Nodes {
			if node.ResourceID == resourceID {
				nodes = append(nodes, node)
			}
		}
		if len(nodes) > 0 {
			history.Nodes = nodes
			out = append(out, history)
		}
	}
	return out, nil
}
