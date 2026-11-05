package store

import (
	"context"
	"errors"

	"pl/portal/internal/model"
)

var ErrSFTPDeleted = errors.New("sftp_file_unavailable")
var ErrSFTPNotOwner = errors.New("sftp_file_not_owned")
var ErrSFTPDeleteBusy = errors.New("sftp_delete_busy")

type SFTPDeleteOperation struct {
	*SFTPPathLock
	Version      model.SFTPVersion
	ProviderPath string
	State        string
}

// Session advisory lock serializes attempts across API replicas while each audit/state
// transaction commits before external I/O. Closing a bad connection releases the lock.
func (s *Store) SFTPBeginDelete(ctx context.Context, id, actor string) (*SFTPDeleteOperation, error) {
	var providerPath string
	e := s.Pool.QueryRow(ctx, "SELECT COALESCE(v.provider_path,'') FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL WHERE v.id=$1", id).Scan(&providerPath)
	if e != nil {
		return nil, translate(e)
	}
	lease, e := s.SFTPLockPath(ctx, providerPath, false)
	if e != nil {
		return nil, e
	}
	op := &SFTPDeleteOperation{SFTPPathLock: lease}
	conn := lease.conn
	v := &op.Version
	e = conn.QueryRow(ctx, `SELECT v.id,v.collection_id,v.filename,v.size_bytes,v.sha256,v.source,COALESCE(v.provider_path,''),COALESCE(d.state,''),d.deleted_at,COALESCE(d.actor,'') FROM sftp_versions v JOIN sftp_collections c ON c.id=v.collection_id AND c.retired_at IS NULL LEFT JOIN sftp_version_deletions d ON d.version_id=v.id WHERE v.id=$1`, id).Scan(&v.ID, &v.CollectionID, &v.Filename, &v.SizeBytes, &v.SHA256, &v.Source, &op.ProviderPath, &op.State, &v.DeletedAt, &v.DeletedBy)
	if e != nil {
		op.Close()
		return nil, translate(e)
	}
	if op.State == "deleted" {
		return op, nil
	}
	if v.Source != "sftpgo" {
		op.Close()
		return nil, ErrInvalid
	}
	var owned bool
	if e = conn.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sftp_active_files WHERE provider_path=$1 AND version_id=$2)", op.ProviderPath, id).Scan(&owned); e != nil || !owned {
		op.Close()
		if e != nil {
			return nil, e
		}
		return nil, ErrSFTPNotOwner
	}

	tx, e := conn.Begin(ctx)
	if e != nil {
		op.Close()
		return nil, e
	}
	defer tx.Rollback(ctx)
	_, e = tx.Exec(ctx, `INSERT INTO sftp_version_deletions(version_id,state,actor) VALUES($1,'pending',$2) ON CONFLICT(version_id) DO UPDATE SET state='pending',actor=$2,updated_at=now(),error='',deleted_at=NULL`, id, actor)
	if e == nil {
		e = sftpAudit(ctx, tx, "file.delete.requested", actor, v.CollectionID, id)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		op.Close()
		return nil, e
	}
	return op, nil
}
func (op *SFTPDeleteOperation) Finish(ctx context.Context, state, actor, code string) error {
	if state != "deleted" && state != "failed" && state != "uncertain" {
		return ErrInvalid
	}
	tx, e := op.conn.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	e = tx.QueryRow(ctx, `UPDATE sftp_version_deletions SET state=$2,actor=$3,error=$4,updated_at=now(),deleted_at=CASE WHEN $2='deleted' THEN now() ELSE NULL END WHERE version_id=$1 RETURNING deleted_at,actor`, op.Version.ID, state, actor, code).Scan(&op.Version.DeletedAt, &op.Version.DeletedBy)
	if e == nil && state == "deleted" {
		_, e = tx.Exec(ctx, "DELETE FROM sftp_active_files WHERE provider_path=$1 AND version_id=$2", op.ProviderPath, op.Version.ID)
	}
	if e == nil {
		e = sftpAudit(ctx, tx, "file.delete."+state, actor, op.Version.CollectionID, op.Version.ID, map[string]any{"code": code})
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e == nil {
		op.State = state
	}
	return e
}
