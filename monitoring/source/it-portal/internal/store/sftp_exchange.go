package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"pl/portal/internal/model"
)

// SFTPExchangeBranches returns receipt facts already persisted by the SFTPGo
// reconciler. It performs no provider calls and never treats local test uploads
// as business receipts.
func (s *Store) SFTPExchangeBranches(ctx context.Context) ([]model.SFTPExchangeBranch, error) {
	rows, err := s.Pool.Query(ctx, `
SELECT c.id,c.branch,c.label,c.folder,
       latest.id,latest.filename,latest.size_bytes,latest.received_at,latest.received_by_name,
       latest.received_count,COALESCE(d.state,''),active.version_id IS NOT NULL
FROM sftp_collections c
LEFT JOIN LATERAL (
 SELECT v.id,v.filename,v.size_bytes,v.received_at,v.received_by_name,
        count(*) OVER() AS received_count
 FROM sftp_versions v
 WHERE v.collection_id=c.id AND v.source='sftpgo'
 ORDER BY v.received_at DESC,v.id DESC
 LIMIT 1
) latest ON true
LEFT JOIN sftp_version_deletions d ON d.version_id=latest.id
LEFT JOIN sftp_active_files active ON active.version_id=latest.id
WHERE c.retired_at IS NULL
ORDER BY c.branch,c.label,c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.SFTPExchangeBranch{}
	for rows.Next() {
		var branch model.SFTPExchangeBranch
		var receiptID, filename, sender, deletionState pgtype.Text
		var sizeBytes, receivedCount pgtype.Int8
		var receivedAt pgtype.Timestamptz
		var active bool
		if err = rows.Scan(
			&branch.ID, &branch.Branch, &branch.Label, &branch.Folder,
			&receiptID, &filename, &sizeBytes, &receivedAt, &sender,
			&receivedCount, &deletionState, &active,
		); err != nil {
			return nil, err
		}
		if receivedCount.Valid {
			branch.ReceivedCount = receivedCount.Int64
		}
		if receiptID.Valid {
			availability := "available"
			switch {
			case deletionState.String == "deleted":
				availability = "deleted"
			case deletionState.String == "pending":
				availability = "pending"
			case deletionState.String == "uncertain":
				availability = "uncertain"
			case !active:
				availability = "uncertain"
			}
			branch.LastReceived = &model.SFTPExchangeReceipt{
				ID:           receiptID.String,
				Filename:     filename.String,
				SizeBytes:    sizeBytes.Int64,
				ReceivedAt:   receivedAt.Time,
				Sender:       sender.String,
				Availability: availability,
			}
		}
		out = append(out, branch)
	}
	return out, rows.Err()
}
