package model

import (
	"encoding/json"
	"time"
)

// SFTP policies are desired local configuration until a receiver is connected.
type SFTPCollection struct {
	Revision          int64      `json:"revision"`
	AppliedRevision   int64      `json:"-"`
	ProvisioningState string     `json:"provisioning_state"`
	ProvisioningError string     `json:"provisioning_error"`
	LastAppliedAt     *time.Time `json:"last_applied_at"`
	ReaderIDs         []string   `json:"reader_ids"`
	ID                string     `json:"id"`
	Branch            string     `json:"branch"`
	Label             string     `json:"label"`
	Folder            string     `json:"folder"`
	QuotaBytes        int64      `json:"quota_bytes"`
	CreatedAt         time.Time  `json:"created_at"`
}

const SFTPSender = "sender"
const SFTPReceiver = "receiver"

type SFTPAccount struct {
	Kind              string     `json:"kind"`
	Revision          int64      `json:"revision"`
	AppliedRevision   int64      `json:"-"`
	ProvisioningError string     `json:"provisioning_error"`
	LastAppliedAt     *time.Time `json:"last_applied_at"`
	PublicKeys        []string   `json:"public_keys"`
	ID                string     `json:"id"`
	Username          string     `json:"username"`
	Label             string     `json:"label"`
	CollectionIDs     []string   `json:"collection_ids"`
	QuotaBytes        int64      `json:"quota_bytes"`
	Enabled           bool       `json:"enabled"`
	ProvisioningState string     `json:"provisioning_state"`
	Permissions       []string   `json:"permissions"`
}
type SFTPVersion struct {
	DeletionState  string     `json:"deletion_state"`
	DeletedAt      *time.Time `json:"deleted_at"`
	DeletedBy      string     `json:"deleted_by"`
	CanDelete      bool       `json:"can_delete"`
	ReceivedByName string     `json:"received_by_name"`
	CanDownload    bool       `json:"can_download"`
	ID             string     `json:"id"`
	CollectionID   string     `json:"collection_id"`
	Filename       string     `json:"filename"`
	SizeBytes      int64      `json:"size_bytes"`
	SHA256         string     `json:"sha256"`
	ReceivedAt     time.Time  `json:"received_at"`
	ReceivedBy     string     `json:"received_by"`
	IsNew          bool       `json:"is_new"`
	Source         string     `json:"source"`
}
type SFTPAudit struct {
	ActorName    string          `json:"actor_name"`
	Details      json.RawMessage `json:"details"`
	ID           int64           `json:"id"`
	Action       string          `json:"action"`
	Actor        string          `json:"actor"`
	OccurredAt   time.Time       `json:"occurred_at"`
	CollectionID string          `json:"collection_id"`
	VersionID    string          `json:"version_id"`
}

// SFTPReader is a known Platform identity; it does not create an account.
type SFTPReader struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type SFTPProviderState struct {
	QuarantinedReceipts int64      `json:"quarantined_receipts"`
	Configured          bool       `json:"configured"`
	Status              string     `json:"status"`
	LastAttemptAt       *time.Time `json:"last_attempt_at"`
	LastSuccessAt       *time.Time `json:"last_success_at"`
	Error               string     `json:"error"`
	CursorTimestamp     int64      `json:"-"`
}

func SFTPAccountPermissions(kind string) []string {
	if kind == SFTPReceiver {
		return []string{"list", "download"}
	}
	return []string{"upload"}
}
