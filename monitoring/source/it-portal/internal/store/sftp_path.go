package store

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

// All importer and deletion operations serialize on the physical provider path.
// The lease is held across file verification and native side effects, not just SQL writes.
type SFTPPathLock struct {
	conn *pgxpool.Conn
	path string
}

func (s *Store) SFTPLockPath(ctx context.Context, p string, wait bool) (*SFTPPathLock, error) {
	conn, e := s.Pool.Acquire(ctx)
	if e != nil {
		return nil, e
	}
	query := "SELECT pg_try_advisory_lock(hashtextextended('sftp-file:'||$1,0))"
	if wait {
		query = "SELECT true FROM (SELECT pg_advisory_lock(hashtextextended('sftp-file:'||$1,0))) locked"
	}
	var ok bool
	e = conn.QueryRow(ctx, query, p).Scan(&ok)
	if e != nil || !ok {
		if e != nil {
			closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = conn.Conn().Close(closeCtx)
			cancel()
		}
		conn.Release()
		if e != nil {
			return nil, e
		}
		return nil, ErrSFTPDeleteBusy
	}
	return &SFTPPathLock{conn: conn, path: p}, nil
}
func (l *SFTPPathLock) Close() {
	if l == nil || l.conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, e := l.conn.Exec(ctx, "SELECT pg_advisory_unlock(hashtextextended('sftp-file:'||$1,0))", l.path)
	if e != nil {
		_ = l.conn.Conn().Close(ctx)
	}
	l.conn.Release()
	l.conn = nil
}
