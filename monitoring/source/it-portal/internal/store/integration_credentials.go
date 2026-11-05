package store

import (
	"context"
	"net/netip"
	"strings"

	"pl/portal/internal/connectorcredentials"
)

// IntegrationCredential is deliberately not a JSON entity. The API may expose
// only whether credentials exist; encryption/decryption belongs to its caller.
type IntegrationCredential struct {
	IntegrationID string   `json:"-"`
	Origin        string   `json:"-"`
	ApprovedIPs   []string `json:"-"`
	Envelope      []byte   `json:"-"`
}

// putIntegrationCredential participates in QueueModule's transaction. Insert-only
// semantics preserve existing credentials on retries or conflicting requests.
func putIntegrationCredential(ctx context.Context, tx DB, credential IntegrationCredential) error {
	canonical, err := connectorcredentials.CanonicalOrigin(credential.Origin)
	if err != nil || canonical != credential.Origin || len(credential.IntegrationID) == 0 || len(credential.IntegrationID) > 256 || strings.ContainsFunc(credential.IntegrationID, func(ch rune) bool { return ch < 0x21 || ch > 0x7e }) || len(credential.Envelope) == 0 || len(credential.Envelope) > 8192 || len(credential.ApprovedIPs) == 0 || len(credential.ApprovedIPs) > 32 {
		return ErrInvalid
	}
	seen := make(map[string]bool, len(credential.ApprovedIPs))
	for _, raw := range credential.ApprovedIPs {
		ip, err := netip.ParseAddr(raw)
		if err != nil || ip.Zone() != "" || ip.Unmap().String() != raw || seen[raw] {
			return ErrInvalid
		}
		seen[raw] = true
	}
	_, err = tx.Exec(ctx, `INSERT INTO integration_credentials(integration_id,origin,approved_ips,envelope) VALUES($1,$2,$3,$4)`, credential.IntegrationID, credential.Origin, credential.ApprovedIPs, credential.Envelope)
	return translate(err)
}

func (s *Store) IntegrationCredential(ctx context.Context, id string) (IntegrationCredential, error) {
	var credential IntegrationCredential
	err := s.Pool.QueryRow(ctx, `SELECT integration_id,origin,approved_ips,envelope FROM integration_credentials WHERE integration_id=$1`, id).Scan(&credential.IntegrationID, &credential.Origin, &credential.ApprovedIPs, &credential.Envelope)
	if err != nil {
		return IntegrationCredential{}, translate(err)
	}
	return credential, nil
}
