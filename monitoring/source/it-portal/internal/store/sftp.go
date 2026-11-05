package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

var ErrSFTPAccess = errors.New("sftp_access_denied")

type SFTPState struct {
	AvailableReaders []model.SFTPReader     `json:"available_readers"`
	VersionsTotal    int64                  `json:"versions_total"`
	AuditTotal       int64                  `json:"audit_total"`
	Collections      []model.SFTPCollection `json:"collections"`
	Accounts         []model.SFTPAccount    `json:"accounts"`
	Versions         []model.SFTPVersion    `json:"versions"`
	Audit            []model.SFTPAudit      `json:"audit"`
}

func (s *Store) SFTPState(ctx context.Context, actor string, admin bool) (SFTPState, error) {
	out := SFTPState{Collections: []model.SFTPCollection{}, Accounts: []model.SFTPAccount{}, Versions: []model.SFTPVersion{}, Audit: []model.SFTPAudit{}, AvailableReaders: []model.SFTPReader{}}
	rows, e := s.Pool.Query(ctx, "SELECT id,branch,label,folder,quota_bytes,created_at,revision,applied_revision,provisioning_error,last_applied_at, ARRAY(SELECT user_id FROM sftp_collection_readers r WHERE r.collection_id=c.id ORDER BY user_id) FROM sftp_collections c WHERE c.retired_at IS NULL ORDER BY branch,label")
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var v model.SFTPCollection
		if e = rows.Scan(&v.ID, &v.Branch, &v.Label, &v.Folder, &v.QuotaBytes, &v.CreatedAt, &v.Revision, &v.AppliedRevision, &v.ProvisioningError, &v.LastAppliedAt, &v.ReaderIDs); e != nil {
			rows.Close()
			return out, e
		}
		if !admin {
			v.ReaderIDs = []string{}
		}
		v.ProvisioningState = sftpProvisioningState(v.Revision, v.AppliedRevision, v.ProvisioningError)
		out.Collections = append(out.Collections, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	if admin {
		rows, e = s.Pool.Query(ctx, `WITH identities AS (
 SELECT user_id FROM sessions WHERE expires_at>now()
 UNION SELECT r.user_id FROM sftp_collection_readers r JOIN sftp_collections c ON c.id=r.collection_id WHERE c.retired_at IS NULL
 UNION SELECT actor FROM sftp_access_audit WHERE actor_name<>'' AND actor_name<>actor
) SELECT i.user_id,COALESCE(
 NULLIF((SELECT user_name FROM sessions s WHERE s.user_id=i.user_id ORDER BY expires_at DESC LIMIT 1),''),
 (SELECT actor_name FROM sftp_access_audit a WHERE a.actor=i.user_id AND a.actor_name<>'' AND a.actor_name<>a.actor ORDER BY id DESC LIMIT 1),
 i.user_id) FROM identities i ORDER BY 2,1`)
		if e != nil {
			return out, e
		}
		for rows.Next() {
			var v model.SFTPReader
			if e = rows.Scan(&v.ID, &v.Name); e != nil {
				rows.Close()
				return out, e
			}
			out.AvailableReaders = append(out.AvailableReaders, v)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return out, e
		}
		rows, e = s.Pool.Query(ctx, `SELECT a.id,a.username,a.label,a.quota_bytes,a.enabled,a.kind,a.public_keys,a.revision,a.applied_revision,a.provisioning_error,a.last_applied_at,COALESCE(array_agg(c.collection_id::text) FILTER(WHERE c.collection_id IS NOT NULL),'{}') FROM sftp_accounts a LEFT JOIN sftp_account_collections c ON c.account_id=a.id WHERE NOT EXISTS(SELECT 1 FROM sftp_account_collections ac JOIN sftp_collections retired ON retired.id=ac.collection_id WHERE ac.account_id=a.id AND retired.retired_at IS NOT NULL) GROUP BY a.id ORDER BY a.username`)
		if e != nil {
			return out, e
		}
		for rows.Next() {
			var v model.SFTPAccount
			if e = rows.Scan(&v.ID, &v.Username, &v.Label, &v.QuotaBytes, &v.Enabled, &v.Kind, &v.PublicKeys, &v.Revision, &v.AppliedRevision, &v.ProvisioningError, &v.LastAppliedAt, &v.CollectionIDs); e != nil {
				rows.Close()
				return out, e
			}
			v.Permissions = model.SFTPAccountPermissions(v.Kind)
			v.ProvisioningState = sftpProvisioningState(v.Revision, v.AppliedRevision, v.ProvisioningError)
			out.Accounts = append(out.Accounts, v)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return out, e
		}
	}
	rows, e = s.Pool.Query(ctx, `SELECT v.id,v.collection_id,v.filename,v.size_bytes,v.sha256,v.received_at,v.received_by,v.received_by_name,NOT EXISTS(SELECT 1 FROM sftp_version_seen x WHERE x.version_id=v.id AND x.user_id=$1),v.source,EXISTS(SELECT 1 FROM sftp_collection_readers r WHERE r.collection_id=v.collection_id AND r.user_id=$1) AND COALESCE(d.state,'') NOT IN ('pending','deleted','uncertain') AND (v.source<>'sftpgo' OR EXISTS(SELECT 1 FROM sftp_active_files a WHERE a.version_id=v.id AND a.provider_path=v.provider_path)),COALESCE(d.state,''),d.deleted_at,CASE WHEN d.state='deleted' THEN d.actor ELSE '' END FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL LEFT JOIN sftp_version_deletions d ON d.version_id=v.id ORDER BY v.received_at DESC LIMIT 1000`, actor)
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var v model.SFTPVersion
		if e = rows.Scan(&v.ID, &v.CollectionID, &v.Filename, &v.SizeBytes, &v.SHA256, &v.ReceivedAt, &v.ReceivedBy, &v.ReceivedByName, &v.IsNew, &v.Source, &v.CanDownload, &v.DeletionState, &v.DeletedAt, &v.DeletedBy); e != nil {
			rows.Close()
			return out, e
		}
		v.CanDelete = admin && v.Source == "sftpgo" && v.DeletionState != "deleted"
		out.Versions = append(out.Versions, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	// Account policy changes and other users' access are administrator-only.
	rows, e = s.Pool.Query(ctx, `SELECT id,action,actor,occurred_at,collection_id,version_id,actor_name,details FROM sftp_access_audit WHERE $1 OR actor=$2 ORDER BY id DESC LIMIT 100`, admin, actor)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	for rows.Next() {
		var v model.SFTPAudit
		if e = rows.Scan(&v.ID, &v.Action, &v.Actor, &v.OccurredAt, &v.CollectionID, &v.VersionID, &v.ActorName, &v.Details); e != nil {
			return out, e
		}
		out.Audit = append(out.Audit, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id WHERE c.retired_at IS NULL").Scan(&out.VersionsTotal); e != nil {
		return out, e
	}
	e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_access_audit WHERE $1 OR actor=$2", admin, actor).Scan(&out.AuditTotal)
	return out, e
}
func sftpAudit(ctx context.Context, db DB, action, actor, collection, version string, details ...any) error {
	payload := []byte("{}")
	if len(details) > 0 {
		var e error
		payload, e = json.Marshal(details[0])
		if e != nil {
			return e
		}
	}
	_, e := db.Exec(ctx, "INSERT INTO sftp_access_audit(action,actor,collection_id,version_id,actor_name,details) VALUES($1,$2,$3,$4,COALESCE((SELECT user_name FROM sessions WHERE user_id=$2 ORDER BY expires_at DESC LIMIT 1),$2),$5::jsonb)", action, actor, collection, version, string(payload))
	return e
}
func (s *Store) SFTPAccess(ctx context.Context, actor string) error {
	return sftpAudit(ctx, s.Pool, "panel.open", actor, "", "")
}
func (s *Store) SFTPSaveCollection(ctx context.Context, v model.SFTPCollection, actor string) (model.SFTPCollection, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return v, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
		return v, e
	}
	if v.ID != "" {
		var revision int64
		if e = tx.QueryRow(ctx, "SELECT revision FROM sftp_collections WHERE id=$1 AND retired_at IS NULL FOR UPDATE", v.ID).Scan(&revision); e != nil {
			return v, translate(e)
		}
		if v.Revision < 1 || revision != v.Revision {
			return v, ErrConflict
		}
	}
	var allocated int64
	if e = tx.QueryRow(ctx, "SELECT COALESCE(sum(quota_bytes),0) FROM sftp_collections WHERE id::text<>$1 AND retired_at IS NULL", v.ID).Scan(&allocated); e != nil {
		return v, e
	}
	if v.QuotaBytes > (160<<30)-allocated {
		return v, &SFTPQuotaError{Minimum: 0, Budget: true}
	}
	if v.ID != "" {
		var invalid bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sftp_accounts a JOIN sftp_account_collections ac ON ac.account_id=a.id WHERE ac.collection_id=$1 AND a.kind='sender' AND a.quota_bytes < $2 + (SELECT COALESCE(sum(c.quota_bytes),0) FROM sftp_account_collections x JOIN sftp_collections c ON c.id=x.collection_id WHERE x.account_id=a.id AND x.collection_id<>$1 AND c.retired_at IS NULL))`, v.ID, v.QuotaBytes).Scan(&invalid)
		if e != nil {
			return v, e
		}
		if invalid {
			return v, &SFTPQuotaError{Minimum: v.QuotaBytes, Collection: true}
		}
	}
	if v.ID == "" {
		v.ID = uuid.NewString()
		e = tx.QueryRow(ctx, "INSERT INTO sftp_collections(id,branch,label,folder,quota_bytes) VALUES($1,$2,$3,$4,$5) RETURNING created_at,revision", v.ID, v.Branch, v.Label, v.Folder, v.QuotaBytes).Scan(&v.CreatedAt, &v.Revision)
	} else {
		e = tx.QueryRow(ctx, "UPDATE sftp_collections SET branch=$2,label=$3,folder=$4,quota_bytes=$5,revision=revision+1,provisioning_error='' WHERE id=$1 AND revision=$6 AND retired_at IS NULL RETURNING created_at,revision", v.ID, v.Branch, v.Label, v.Folder, v.QuotaBytes, v.Revision).Scan(&v.CreatedAt, &v.Revision)
	}
	if e != nil {
		return v, translate(e)
	}
	v.ProvisioningState = "pending"
	v.ProvisioningError = ""
	if _, e = tx.Exec(ctx, "DELETE FROM sftp_collection_readers WHERE collection_id=$1", v.ID); e != nil {
		return v, e
	}
	for _, user := range v.ReaderIDs {
		if _, e = tx.Exec(ctx, "INSERT INTO sftp_collection_readers(collection_id,user_id) VALUES($1,$2)", v.ID, user); e != nil {
			return v, translate(e)
		}
	}
	if e = sftpAudit(ctx, tx, "collection.saved", actor, v.ID, "", v); e != nil {
		return v, e
	}
	return v, tx.Commit(ctx)
}
func (s *Store) SFTPSaveAccount(ctx context.Context, v model.SFTPAccount, actor string) (model.SFTPAccount, error) {
	if v.Kind != "" && v.Kind != model.SFTPSender && v.Kind != model.SFTPReceiver {
		return v, ErrInvalid
	}
	if len(v.CollectionIDs) < 1 || len(v.CollectionIDs) > 100 {
		return v, ErrInvalid
	}
	if v.PublicKeys == nil {
		v.PublicKeys = []string{}
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return v, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
		return v, e
	}
	if v.ID != "" {
		var revision int64
		var kind string
		if e = tx.QueryRow(ctx, "SELECT revision,kind FROM sftp_accounts WHERE id=$1 FOR UPDATE", v.ID).Scan(&revision, &kind); e != nil {
			return v, translate(e)
		}
		if v.Revision < 1 || revision != v.Revision {
			return v, ErrConflict
		}
		if v.Kind == "" {
			v.Kind = kind
		}
	}
	if v.Kind == "" {
		v.Kind = model.SFTPSender
	}
	if v.Kind == model.SFTPReceiver {
		v.QuotaBytes = 0
	} else if v.QuotaBytes < 1 || v.QuotaBytes > 10<<40 {
		return v, ErrInvalid
	}
	var minimum int64
	for _, id := range v.CollectionIDs {
		var quota int64
		if e = tx.QueryRow(ctx, "SELECT quota_bytes FROM sftp_collections WHERE id=$1 AND retired_at IS NULL FOR SHARE", id).Scan(&quota); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return v, ErrInvalid
			}
			return v, e
		}
		minimum += quota
	}
	if v.Kind == model.SFTPSender && v.QuotaBytes < minimum {
		return v, &SFTPQuotaError{Minimum: minimum}
	}
	if v.ID != "" {
		var username string
		if e = tx.QueryRow(ctx, "SELECT username FROM sftp_accounts WHERE id=$1", v.ID).Scan(&username); e != nil {
			return v, translate(e)
		}
		if username != v.Username {
			return v, ErrInvalid
		}
	}
	if v.ID == "" {
		v.ID = uuid.NewString()
		_, e = tx.Exec(ctx, "INSERT INTO sftp_accounts(id,username,label,quota_bytes,enabled,public_keys,kind) VALUES($1,$2,$3,$4,$5,$6,$7)", v.ID, v.Username, v.Label, v.QuotaBytes, v.Enabled, v.PublicKeys, v.Kind)
		v.Revision = 1
	} else {
		var tag interface{ RowsAffected() int64 }
		tag, e = tx.Exec(ctx, "UPDATE sftp_accounts SET username=$2,label=$3,quota_bytes=$4,enabled=$5,public_keys=$6,kind=$7,revision=revision+1,provisioning_error='' WHERE id=$1 AND revision=$8", v.ID, v.Username, v.Label, v.QuotaBytes, v.Enabled, v.PublicKeys, v.Kind, v.Revision)
		if e == nil && tag.RowsAffected() == 0 {
			return v, ErrConflict
		}
		v.Revision++
	}
	if e != nil {
		return v, translate(e)
	}
	if _, e = tx.Exec(ctx, "DELETE FROM sftp_account_collections WHERE account_id=$1", v.ID); e != nil {
		return v, e
	}
	for _, id := range v.CollectionIDs {
		if _, e = tx.Exec(ctx, "INSERT INTO sftp_account_collections(account_id,collection_id) VALUES($1,$2)", v.ID, id); e != nil {
			return v, translate(e)
		}
	}
	v.Permissions = model.SFTPAccountPermissions(v.Kind)
	v.ProvisioningState = "pending"
	if e = sftpAudit(ctx, tx, "account.policy_saved", actor, "", "", v); e != nil {
		return v, e
	}
	return v, tx.Commit(ctx)
}
func (s *Store) SFTPReceiveTest(ctx context.Context, collection, filename, actor string, data []byte) (model.SFTPVersion, bool, error) {
	var v model.SFTPVersion
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return v, false, e
	}
	defer tx.Rollback(ctx)
	var quota, used int64
	e = tx.QueryRow(ctx, "SELECT quota_bytes FROM sftp_collections WHERE id=$1 AND retired_at IS NULL FOR UPDATE", collection).Scan(&quota)
	if e != nil {
		return v, false, translate(e)
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	e = tx.QueryRow(ctx, "SELECT id,collection_id,filename,size_bytes,sha256,received_at,received_by,received_by_name,source FROM sftp_versions WHERE collection_id=$1 AND sha256=$2 AND source='test'", collection, digest).Scan(&v.ID, &v.CollectionID, &v.Filename, &v.SizeBytes, &v.SHA256, &v.ReceivedAt, &v.ReceivedBy, &v.ReceivedByName, &v.Source)
	if e == nil {
		if e = sftpAudit(ctx, tx, "upload.duplicate", actor, collection, v.ID); e != nil {
			return v, false, e
		}
		return v, true, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return v, false, e
	}
	if e = tx.QueryRow(ctx, "SELECT COALESCE(sum(size_bytes),0) FROM sftp_versions WHERE collection_id=$1", collection).Scan(&used); e != nil {
		return v, false, e
	}
	if int64(len(data)) > quota-used {
		return v, false, ErrInvalid
	}
	v = model.SFTPVersion{ID: uuid.NewString(), CollectionID: collection, Filename: filename, SizeBytes: int64(len(data)), SHA256: digest, ReceivedBy: actor, Source: "test", IsNew: true}
	e = tx.QueryRow(ctx, "INSERT INTO sftp_versions(id,collection_id,filename,size_bytes,sha256,received_by,received_by_name,source,content) VALUES($1,$2,$3,$4,$5,$6,COALESCE((SELECT user_name FROM sessions WHERE user_id=$6 ORDER BY expires_at DESC LIMIT 1),$6),'test',$7) RETURNING received_at,received_by_name", v.ID, collection, filename, v.SizeBytes, digest, actor, data).Scan(&v.ReceivedAt, &v.ReceivedByName)
	if e != nil {
		return v, false, e
	}
	if e = sftpAudit(ctx, tx, "version.received", actor, collection, v.ID); e != nil {
		return v, false, e
	}
	return v, false, tx.Commit(ctx)
}
func (s *Store) SFTPSeen(ctx context.Context, id, actor string) error {
	tag, e := s.Pool.Exec(ctx, "INSERT INTO sftp_version_seen(version_id,user_id) SELECT v.id,$2 FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL WHERE v.id=$1 ON CONFLICT DO NOTHING", id, actor)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		e = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL WHERE v.id=$1)", id).Scan(&exists)
		if e != nil {
			return e
		}
		if !exists {
			return ErrNotFound
		}
	}
	return nil
}
func (s *Store) SFTPDownload(ctx context.Context, id, actor string) (string, []byte, error) {
	var filename, collection string
	var data []byte
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return "", nil, e
	}
	defer tx.Rollback(ctx)
	var allowed bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sftp_collection_readers r JOIN sftp_versions v ON v.collection_id=r.collection_id JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL WHERE v.id=$1 AND r.user_id=$2)", id, actor).Scan(&allowed)
	if e != nil {
		return "", nil, e
	}
	if !allowed {
		if e = sftpAudit(ctx, tx, "download.denied", actor, "", id); e != nil {
			return "", nil, e
		}
		if e = tx.Commit(ctx); e != nil {
			return "", nil, e
		}
		return "", nil, ErrSFTPAccess
	}
	e = tx.QueryRow(ctx, "SELECT v.filename,v.collection_id,v.content FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL WHERE v.id=$1", id).Scan(&filename, &collection, &data)
	if e != nil {
		return "", nil, translate(e)
	}
	if e = sftpAudit(ctx, tx, "download.started", actor, collection, id); e != nil {
		return "", nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return "", nil, e
	}
	return filename, data, nil
}

type SFTPQuotaError struct {
	Minimum    int64
	Budget     bool
	Collection bool
}

func (e *SFTPQuotaError) Error() string { return "invalid_quota_assignment" }
func sftpProvisioningState(revision, applied int64, failure string) string {
	if failure != "" {
		if failure == "ownership_conflict" {
			return "conflict"
		}
		return "error"
	}
	if applied >= revision && revision > 0 {
		return "applied"
	}
	return "pending"
}
func (s *Store) SFTPProviderState(ctx context.Context) (model.SFTPProviderState, error) {
	var v model.SFTPProviderState
	e := s.Pool.QueryRow(ctx, "SELECT last_attempt_at,last_success_at,error,cursor_timestamp,(SELECT count(*) FROM sftp_receipt_rejections) FROM sftp_provider_state WHERE id=true").Scan(&v.LastAttemptAt, &v.LastSuccessAt, &v.Error, &v.CursorTimestamp, &v.QuarantinedReceipts)
	return v, e
}
func (s *Store) SFTPProviderAttempt(ctx context.Context) error {
	_, e := s.Pool.Exec(ctx, "UPDATE sftp_provider_state SET last_attempt_at=now() WHERE id=true")
	return e
}
func (s *Store) SFTPProviderResult(ctx context.Context, failure string, cursor int64) error {
	_, e := s.Pool.Exec(ctx, "UPDATE sftp_provider_state SET error=$1,last_success_at=CASE WHEN $1='' THEN now() ELSE last_success_at END,cursor_timestamp=GREATEST(cursor_timestamp,$2) WHERE id=true", failure, cursor)
	return e
}
func (s *Store) SFTPProvisioned(ctx context.Context, kind, id string, revision int64, failure string) error {
	table := "sftp_accounts"
	if kind == "collection" {
		table = "sftp_collections"
	} else if kind != "account" {
		return ErrInvalid
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var activeID string
	activeQuery := "SELECT id::text FROM sftp_collections WHERE id=$1 AND retired_at IS NULL FOR SHARE"
	if kind == "account" {
		activeQuery = "SELECT id::text FROM sftp_accounts a WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM sftp_account_collections ac JOIN sftp_collections c ON c.id=ac.collection_id WHERE ac.account_id=a.id AND c.retired_at IS NOT NULL) FOR SHARE"
	}
	if e = tx.QueryRow(ctx, activeQuery, id).Scan(&activeID); e != nil {
		return translate(e)
	}
	tag, e := tx.Exec(ctx, "UPDATE "+table+" SET provisioning_error=$3,applied_revision=CASE WHEN $3='' THEN $2 ELSE applied_revision END,last_applied_at=CASE WHEN $3='' THEN now() ELSE last_applied_at END WHERE id=$1 AND revision=$2 AND (applied_revision<>$2 OR provisioning_error<>$3)", id, revision, failure)
	if e != nil {
		return e
	}
	if tag.RowsAffected() > 0 {
		action := "provisioning.applied"
		if failure != "" {
			action = "provisioning.failed"
		}
		if e = sftpAudit(ctx, tx, action, "sftpgo-reconciler", id, "", map[string]any{"kind": kind, "revision": revision, "error": failure}); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

// SFTPReceiveRemote persists only independently verified metadata. Payload stays on receiver.
func (s *Store) SFTPReceiveRemote(ctx context.Context, v model.SFTPVersion, providerPath, eventKey string) (bool, error) {
	lease, e := s.SFTPLockPath(ctx, providerPath, true)
	if e != nil {
		return false, e
	}
	defer lease.Close()
	return lease.ReceiveRemote(ctx, v, eventKey)
}
func (l *SFTPPathLock) ReceiveRemote(ctx context.Context, v model.SFTPVersion, eventKey string) (bool, error) {
	tx, e := l.conn.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var activeID string
	if e = tx.QueryRow(ctx, "SELECT id::text FROM sftp_collections WHERE id=$1 AND retired_at IS NULL FOR SHARE", v.CollectionID).Scan(&activeID); e != nil {
		return false, translate(e)
	}
	var stored model.SFTPVersion
	var storedPath string
	e = tx.QueryRow(ctx, "SELECT collection_id,filename,size_bytes,sha256,received_by,provider_path FROM sftp_versions WHERE provider_event_key=$1", eventKey).Scan(&stored.CollectionID, &stored.Filename, &stored.SizeBytes, &stored.SHA256, &stored.ReceivedBy, &storedPath)
	if e == nil {
		if storedPath != l.path || stored.CollectionID != v.CollectionID || stored.Filename != v.Filename || stored.SizeBytes != v.SizeBytes || stored.SHA256 != v.SHA256 || stored.ReceivedBy != v.ReceivedBy {
			return false, ErrInvalid
		}
		return true, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return false, e
	}
	var exists bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sftp_active_files WHERE provider_path=$1)", l.path).Scan(&exists); e != nil {
		return false, e
	}
	if exists {
		return false, ErrInvalid
	}
	id := uuid.NewString()
	_, e = tx.Exec(ctx, `INSERT INTO sftp_versions(id,collection_id,filename,size_bytes,sha256,received_at,received_by,received_by_name,source,provider_path,provider_event_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'sftpgo',$9,$10)`, id, v.CollectionID, v.Filename, v.SizeBytes, v.SHA256, v.ReceivedAt, v.ReceivedBy, v.ReceivedByName, l.path, eventKey)
	if e == nil {
		_, e = tx.Exec(ctx, "INSERT INTO sftp_active_files(provider_path,version_id) VALUES($1,$2)", l.path, id)
	}
	if e == nil {
		e = sftpAudit(ctx, tx, "version.received", v.ReceivedBy, v.CollectionID, id, map[string]any{"filename": v.Filename, "size_bytes": v.SizeBytes, "event_key": eventKey})
	}
	if e != nil {
		return false, e
	}
	return false, tx.Commit(ctx)
}
func (s *Store) SFTPRemoteKnown(ctx context.Context, eventKey, path string) (bool, error) {
	var exists bool
	e := s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sftp_versions WHERE provider_event_key=$1) OR EXISTS(SELECT 1 FROM sftp_active_files WHERE provider_path=$2)", eventKey, path).Scan(&exists)
	return exists, e
}
func (s *Store) SFTPRemoteDownload(ctx context.Context, id, actor string) (model.SFTPVersion, string, error) {
	var v model.SFTPVersion
	var providerPath string
	var allowed bool
	var deletion string
	var owned bool
	e := s.Pool.QueryRow(ctx, `SELECT v.id,v.collection_id,v.filename,v.size_bytes,v.sha256,v.source,COALESCE(v.provider_path,''),EXISTS(SELECT 1 FROM sftp_collection_readers r WHERE r.collection_id=v.collection_id AND r.user_id=$2),COALESCE(d.state,''),(v.source<>'sftpgo' OR EXISTS(SELECT 1 FROM sftp_active_files a WHERE a.version_id=v.id AND a.provider_path=v.provider_path)) FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL LEFT JOIN sftp_version_deletions d ON d.version_id=v.id WHERE v.id=$1`, id, actor).Scan(&v.ID, &v.CollectionID, &v.Filename, &v.SizeBytes, &v.SHA256, &v.Source, &providerPath, &allowed, &deletion, &owned)
	if e != nil {
		return v, "", translate(e)
	}
	if !allowed {
		if e = sftpAudit(ctx, s.Pool, "download.denied", actor, v.CollectionID, id); e != nil {
			return v, "", e
		}
		return v, "", ErrSFTPAccess
	}
	if !owned || deletion == "pending" || deletion == "deleted" || deletion == "uncertain" {
		return v, "", ErrSFTPDeleted
	}
	return v, providerPath, nil
}
func (s *Store) SFTPDownloadAudit(ctx context.Context, action, actor, collection, id string) error {
	return sftpAudit(ctx, s.Pool, action, actor, collection, id)
}

func (s *Store) SFTPRemoteReceiptKnown(ctx context.Context, eventKey, providerPath string, size int64, username string) (bool, error) {
	var storedPath, storedKey, storedUser string
	var storedSize int64
	e := s.Pool.QueryRow(ctx, "SELECT provider_path,provider_event_key,size_bytes,received_by FROM sftp_versions WHERE provider_event_key=$1", eventKey).Scan(&storedPath, &storedKey, &storedSize, &storedUser)
	if errors.Is(e, pgx.ErrNoRows) {
		var claimed bool
		e = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sftp_active_files WHERE provider_path=$1)", providerPath).Scan(&claimed)
		if e != nil {
			return false, e
		}
		if claimed {
			return false, ErrInvalid
		}
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if storedPath != providerPath || storedKey != eventKey || storedSize != size || storedUser != username {
		return false, ErrInvalid
	}
	return true, nil
}

func (s *Store) SFTPQuarantineReceipt(ctx context.Context, key, reason string, timestamp int64) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	tag, e := tx.Exec(ctx, "INSERT INTO sftp_receipt_rejections(event_key,reason,source_timestamp) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", key, reason, timestamp)
	if e != nil {
		return e
	}
	if tag.RowsAffected() > 0 {
		if e = sftpAudit(ctx, tx, "receipt.quarantined", "sftpgo-reconciler", "", "", map[string]string{"receipt_key": key, "reason": reason}); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
