package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// LocalUser is the public projection. Password material is never part of it.
type LocalUser struct {
	ID        string     `json:"id"`
	Username  string     `json:"username"`
	Name      string     `json:"name"`
	Admin     bool       `json:"admin"`
	Disabled  bool       `json:"disabled"`
	Builtin   bool       `json:"builtin"`
	Revision  int64      `json:"revision"`
	CreatedAt *time.Time `json:"created_at"`
	UpdatedAt *time.Time `json:"updated_at"`
}

const localUserColumns = "id,username,name,admin,disabled,revision,created_at,updated_at"

// Dedicated database-wide namespace: 7398215 is migrations, 7398216 is the
// worker's session-long singleton, and 7398217..7398220 serve other store flows.
// User writes must not wait on the worker for the lifetime of the process.
const localUsersMutationLock int64 = 7398221

func scanLocalUser(row pgx.Row) (u LocalUser, err error) {
	err = row.Scan(&u.ID, &u.Username, &u.Name, &u.Admin, &u.Disabled, &u.Revision, &u.CreatedAt, &u.UpdatedAt)
	return u, translate(err)
}

var ErrLocalUserForbidden = errors.New("local_user_forbidden")

func (s *Store) LocalUsers(ctx context.Context) ([]LocalUser, error) {
	rows, err := s.Pool.Query(ctx, "SELECT "+localUserColumns+" FROM local_users ORDER BY username,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []LocalUser{}
	for rows.Next() {
		u, e := scanLocalUser(rows)
		if e != nil {
			return nil, e
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// One transaction serializes local-user writes, rechecks the actor's current role,
// changes the record, revokes sessions and records the audit event atomically.
// The lock order also prevents two administrators editing each other from deadlocking.
func (s *Store) localUserMutation(ctx context.Context, actor model.User, run func(pgx.Tx) (LocalUser, error)) (LocalUser, error) {
	var zero LocalUser
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", localUsersMutationLock); err != nil {
		return zero, err
	}
	if !actor.Admin {
		return zero, ErrLocalUserForbidden
	}
	if strings.HasPrefix(actor.ID, "local:") {
		var allowed bool
		err = tx.QueryRow(ctx, "SELECT admin AND NOT disabled FROM local_users WHERE id=$1 FOR SHARE", actor.ID).Scan(&allowed)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && !allowed {
			return zero, ErrLocalUserForbidden
		}
		if err != nil {
			return zero, err
		}
	}
	u, err := run(tx)
	if err != nil {
		return zero, err
	}
	if err = tx.Commit(ctx); err != nil {
		return zero, err
	}
	return u, nil
}

func (s *Store) CreateLocalUser(ctx context.Context, actor model.User, username, name, passwordHash string, admin bool) (LocalUser, error) {
	return s.localUserMutation(ctx, actor, func(tx pgx.Tx) (LocalUser, error) {
		u, err := scanLocalUser(tx.QueryRow(ctx, "INSERT INTO local_users(id,username,name,admin,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING "+localUserColumns, "local:"+uuid.NewString(), username, name, admin, passwordHash))
		if err != nil {
			return u, err
		}
		err = record(ctx, tx, "local_user.created", "Создан локальный пользователь", u.ID, actor.ID, map[string]any{"username": u.Username, "admin": u.Admin}, true)
		return u, err
	})
}

func (s *Store) UpdateLocalUser(ctx context.Context, actor model.User, id, name string, admin, disabled bool, revision int64) (LocalUser, error) {
	return s.localUserMutation(ctx, actor, func(tx pgx.Tx) (LocalUser, error) {
		old, err := scanLocalUser(tx.QueryRow(ctx, "SELECT "+localUserColumns+" FROM local_users WHERE id=$1 FOR UPDATE", id))
		if err != nil {
			return old, err
		}
		if old.Revision != revision {
			return old, ErrConflict
		}
		u, err := scanLocalUser(tx.QueryRow(ctx, "UPDATE local_users SET name=$2,admin=$3,disabled=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING "+localUserColumns, id, name, admin, disabled))
		if err != nil {
			return u, err
		}
		if err = record(ctx, tx, "local_user.updated", "Изменён локальный пользователь", id, actor.ID, map[string]any{"username": u.Username, "admin": u.Admin, "disabled": u.Disabled}, true); err != nil {
			return u, err
		}
		_, err = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", id)
		return u, err
	})
}

func (s *Store) ResetLocalUserPassword(ctx context.Context, actor model.User, id, passwordHash string, revision int64) (LocalUser, error) {
	return s.localUserMutation(ctx, actor, func(tx pgx.Tx) (LocalUser, error) {
		u, err := scanLocalUser(tx.QueryRow(ctx, "SELECT "+localUserColumns+" FROM local_users WHERE id=$1 FOR UPDATE", id))
		if err != nil {
			return u, err
		}
		if u.Revision != revision {
			return u, ErrConflict
		}
		return replaceLocalUserPassword(ctx, tx, u, passwordHash, actor.ID, "local_user.password_reset")
	})
}

// Called while the user row is locked, so login and password replacement cannot
// create a surviving session authenticated with an obsolete password.
func replaceLocalUserPassword(ctx context.Context, tx pgx.Tx, u LocalUser, passwordHash, actor, kind string) (LocalUser, error) {
	next, err := scanLocalUser(tx.QueryRow(ctx, "UPDATE local_users SET password_hash=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING "+localUserColumns, u.ID, passwordHash))
	if err != nil {
		return next, err
	}
	if err = record(ctx, tx, kind, "Изменён пароль локального пользователя", u.ID, actor, map[string]any{"username": u.Username}, true); err != nil {
		return next, err
	}
	_, err = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", u.ID)
	return next, err
}

// ChangeLocalUserPassword rechecks the previously verified password hash and the
// revision under a row lock. The caller must never put either hash into an event.
func (s *Store) ChangeLocalUserPassword(ctx context.Context, id, oldHash, newHash string, revision int64) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Match the administrative mutation lock order before taking a row lock.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", localUsersMutationLock); err != nil {
		return err
	}
	var currentHash string
	var disabled bool
	var rev int64
	err = tx.QueryRow(ctx, "SELECT password_hash,disabled,revision FROM local_users WHERE id=$1 FOR UPDATE", id).Scan(&currentHash, &disabled, &rev)
	if err != nil {
		return translate(err)
	}
	if disabled {
		return ErrLocalUserForbidden
	}
	if currentHash != oldHash || rev != revision {
		return ErrConflict
	}
	u, err := scanLocalUser(tx.QueryRow(ctx, "SELECT "+localUserColumns+" FROM local_users WHERE id=$1", id))
	if err != nil {
		return err
	}
	if _, err = replaceLocalUserPassword(ctx, tx, u, newHash, id, "local_user.password_changed"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LocalUserLogin holds a shared row lock from credential lookup through session
// insertion. Password/role writers then revoke this session after obtaining their
// exclusive lock, including when login and an edit happen in different processes.
// For an unknown user verify is still called with an empty hash (dummy KDF).
func (s *Store) LocalUserLogin(ctx context.Context, username, tokenHash, csrf, previousTokenHash string, expires time.Time, verify func(string) (bool, error)) (model.User, error) {
	var u model.User
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return u, err
	}
	defer tx.Rollback(ctx)
	var encoded string
	var disabled bool
	err = tx.QueryRow(ctx, "SELECT id,name,admin,disabled,password_hash FROM local_users WHERE username=$1 FOR SHARE", username).Scan(&u.ID, &u.Name, &u.Admin, &disabled, &encoded)
	known := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return u, err
	}
	valid, err := verify(encoded)
	if err != nil {
		return u, err
	}
	if !known || disabled || encoded == "" || !valid {
		return model.User{}, ErrInvalid
	}
	if previousTokenHash != "" {
		if _, err = tx.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1", previousTokenHash); err != nil {
			return u, err
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,$2,$3,$4,$5,$6)", tokenHash, u.ID, u.Name, u.Admin, csrf, expires); err != nil {
		return u, err
	}
	if err = record(ctx, tx, "auth.login", "Вход в портал", "", u.ID, nil, true); err != nil {
		return u, err
	}
	return u, tx.Commit(ctx)
}
