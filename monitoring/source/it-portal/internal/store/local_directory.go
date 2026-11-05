package store

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const LocalDirectoryNamespace = "pl-local"
const localDirectoryIdentityTTL = 10 * time.Minute
const localDirectorySnapshotTTL = 15 * time.Minute
const maxLocalDirectoryAccounts = 100000
const maxLocalDirectoryRevision int64 = 9007199254740991

var ErrLocalDirectoryResync = errors.New("local_directory_resync_required")

type LocalDirectoryConfig struct{ UsersEnabled, BuiltinEnabled bool }
type LocalDirectoryIdentity struct {
	SchemaVersion       int       `json:"schema_version"`
	Subject             string    `json:"sub"`
	Name                string    `json:"name"`
	State               string    `json:"state"`
	Revision            int64     `json:"identity_revision"`
	DepartmentState     string    `json:"department_state"`
	PrimaryDepartmentID *string   `json:"primary_department_id"`
	HeadDepartmentIDs   []string  `json:"head_department_ids"`
	ObservedAt          time.Time `json:"observed_at"`
	ValidUntil          time.Time `json:"valid_until"`
}
type LocalDirectoryDepartment struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Revision     int64    `json:"revision"`
	Active       bool     `json:"active"`
	HeadSubjects []string `json:"head_subjects"`
}
type LocalDirectoryPage struct {
	Items         []json.RawMessage `json:"items"`
	NextCursor    string            `json:"next_cursor"`
	ChangesCursor string            `json:"changes_cursor"`
}
type localDirectoryAccount struct {
	Subject, Name, State     string
	Admin                    bool
	Revision, SourceRevision int64
}
type localDirectoryCursor struct{ Snapshot, Kind, After string }

func localDirectorySubject(subject string) bool {
	if subject == "local-admin" {
		return true
	}
	if !strings.HasPrefix(subject, "local:") {
		return false
	}
	id, err := uuid.Parse(strings.TrimPrefix(subject, "local:"))
	return err == nil && "local:"+id.String() == subject
}
func localDirectoryWorkspace(subject string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("urn:pl-local:workspace:"+subject)).String()
}
func localDirectoryIdentity(account localDirectoryAccount, now time.Time) LocalDirectoryIdentity {
	department := localDirectoryWorkspace(account.Subject)
	return LocalDirectoryIdentity{SchemaVersion: 1, Subject: account.Subject, Name: account.Name, State: account.State, Revision: account.Revision, DepartmentState: "resolved", PrimaryDepartmentID: &department, HeadDepartmentIDs: []string{}, ObservedAt: now.UTC(), ValidUntil: now.Add(localDirectoryIdentityTTL).UTC()}
}
func localDirectoryDepartment(account localDirectoryAccount) LocalDirectoryDepartment {
	return LocalDirectoryDepartment{ID: localDirectoryWorkspace(account.Subject), Name: "Личное пространство · " + account.Name, Revision: account.Revision, Active: account.State == "active", HeadSubjects: []string{}}
}
func localDirectoryChangeCursor(sequence int64) string {
	return "pllocal_" + strconv.FormatInt(sequence, 10)
}
func parseLocalDirectoryChangeCursor(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	if !strings.HasPrefix(value, "pllocal_") {
		return 0, ErrInvalid
	}
	number, err := strconv.ParseInt(strings.TrimPrefix(value, "pllocal_"), 10, 64)
	if err != nil || number < 0 || localDirectoryChangeCursor(number) != value {
		return 0, ErrInvalid
	}
	return number, nil
}

// Lock order matches local-user mutations. Only public source columns are read;
// password hashes and sessions are never projected or copied into the feed.
func (s *Store) localDirectoryTransaction(ctx context.Context, c LocalDirectoryConfig, now time.Time) (pgx.Tx, error) {
	return s.localDirectoryTransactionFor(ctx, c, now, "")
}

func (s *Store) localDirectoryTransactionFor(ctx context.Context, c LocalDirectoryConfig, now time.Time, subject string) (pgx.Tx, error) {
	if now.IsZero() {
		return nil, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (pgx.Tx, error) { _ = tx.Rollback(ctx); return nil, err }
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", localUsersMutationLock); err != nil {
		return fail(err)
	}
	source := map[string]localDirectoryAccount{}
	if c.BuiltinEnabled && (subject == "" || subject == "local-admin") {
		source["local-admin"] = localDirectoryAccount{Subject: "local-admin", Name: "Локальный администратор", State: "active", Admin: true, SourceRevision: 1}
	}
	sourceQuery := "SELECT id,name,admin,disabled,revision FROM local_users"
	var sourceArgs []any
	if subject != "" {
		sourceQuery += " WHERE id=$1"
		sourceArgs = []any{subject}
	}
	rows, err := tx.Query(ctx, sourceQuery+" ORDER BY id LIMIT 100001", sourceArgs...)
	if err != nil {
		return fail(err)
	}
	for rows.Next() {
		var account localDirectoryAccount
		var disabled bool
		if err = rows.Scan(&account.Subject, &account.Name, &account.Admin, &disabled, &account.SourceRevision); err != nil {
			rows.Close()
			return fail(err)
		}
		if !localDirectorySubject(account.Subject) || strings.TrimSpace(account.Name) == "" || account.SourceRevision < 1 {
			rows.Close()
			return fail(ErrInvalid)
		}
		account.State = "active"
		if disabled || !c.UsersEnabled {
			account.State = "disabled"
		}
		source[account.Subject] = account
		if len(source) > maxLocalDirectoryAccounts {
			rows.Close()
			return fail(ErrInvalid)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fail(err)
	}
	cached := map[string]localDirectoryAccount{}
	cachedQuery := "SELECT subject,name,admin,state,revision,source_revision FROM pl_local_directory_accounts"
	if subject != "" {
		cachedQuery += " WHERE subject=$1"
	}
	rows, err = tx.Query(ctx, cachedQuery+" ORDER BY subject", sourceArgs...)
	if err != nil {
		return fail(err)
	}
	for rows.Next() {
		var account localDirectoryAccount
		if err = rows.Scan(&account.Subject, &account.Name, &account.Admin, &account.State, &account.Revision, &account.SourceRevision); err != nil {
			rows.Close()
			return fail(err)
		}
		cached[account.Subject] = account
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fail(err)
	}
	// Missing sources are retained as revocations, so authorship and invitations
	// never move to another account after a deletion or a disabled login method.
	for subject, previous := range cached {
		if _, exists := source[subject]; !exists {
			previous.State = "missing"
			source[subject] = previous
		}
	}
	if len(source) > maxLocalDirectoryAccounts {
		return fail(ErrInvalid)
	}
	subjects := make([]string, 0, len(source))
	for subject := range source {
		subjects = append(subjects, subject)
	}
	// Deterministic feed order within a generation.
	sort.Strings(subjects)
	for _, subject := range subjects {
		account := source[subject]
		previous, exists := cached[subject]
		if exists && previous.Name == account.Name && previous.Admin == account.Admin && previous.State == account.State && previous.SourceRevision == account.SourceRevision {
			continue
		}
		account.Revision = 1
		if exists {
			account.Revision = previous.Revision + 1
		}
		if account.Revision <= 0 || account.Revision > maxLocalDirectoryRevision {
			return fail(ErrInvalid)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO pl_local_directory_accounts(subject,revision,source_revision,name,admin,state,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT(subject) DO UPDATE SET revision=EXCLUDED.revision,source_revision=EXCLUDED.source_revision,name=EXCLUDED.name,admin=EXCLUDED.admin,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`, subject, account.Revision, account.SourceRevision, account.Name, account.Admin, account.State, now); err != nil {
			return fail(err)
		}
		department := localDirectoryDepartment(account)
		if err = localDirectoryEvent(ctx, tx, map[string]any{"type": "department.changed", "department": department}, now); err != nil {
			return fail(err)
		}
		identity := localDirectoryIdentity(account, now)
		var previousDepartment *string
		if exists {
			value := localDirectoryWorkspace(subject)
			previousDepartment = &value
		}
		if err = localDirectoryEvent(ctx, tx, map[string]any{"type": "identity.changed", "subject": subject, "identity_revision": account.Revision, "previous_department_id": previousDepartment, "primary_department_id": identity.PrimaryDepartmentID, "identity": identity}, now); err != nil {
			return fail(err)
		}
	}
	return tx, nil
}

func localDirectoryEvent(ctx context.Context, tx pgx.Tx, event map[string]any, now time.Time) error {
	id := uuid.NewString()
	event["event_id"], event["occurred_at"] = id, now.UTC()
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO pl_local_directory_events(event_id,body,created_at) VALUES($1,$2,$3)", id, raw, now)
	return err
}
func scanLocalDirectoryAccount(row pgx.Row) (account localDirectoryAccount, err error) {
	err = row.Scan(&account.Subject, &account.Name, &account.Admin, &account.State, &account.Revision, &account.SourceRevision)
	return account, translate(err)
}
func (s *Store) LocalDirectoryIdentity(ctx context.Context, c LocalDirectoryConfig, subject string, now time.Time) (LocalDirectoryIdentity, error) {
	if !localDirectorySubject(subject) {
		return LocalDirectoryIdentity{}, ErrNotFound
	}
	tx, err := s.localDirectoryTransactionFor(ctx, c, now, subject)
	if err != nil {
		return LocalDirectoryIdentity{}, err
	}
	defer tx.Rollback(ctx)
	account, err := scanLocalDirectoryAccount(tx.QueryRow(ctx, "SELECT subject,name,admin,state,revision,source_revision FROM pl_local_directory_accounts WHERE subject=$1", subject))
	if err != nil {
		return LocalDirectoryIdentity{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return LocalDirectoryIdentity{}, err
	}
	return localDirectoryIdentity(account, now), nil
}
func parseLocalDirectoryCursor(value string) (localDirectoryCursor, error) {
	var cursor localDirectoryCursor
	raw, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(raw) > 2048 {
		return cursor, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cursor) != nil || decoder.Decode(new(any)) != io.EOF {
		return cursor, ErrInvalid
	}
	id, err := uuid.Parse(cursor.Snapshot)
	if err != nil || id.String() != cursor.Snapshot || len(cursor.After) > 256 {
		return cursor, ErrInvalid
	}
	return cursor, nil
}
func (s *Store) LocalDirectorySnapshot(ctx context.Context, c LocalDirectoryConfig, kind, cursorValue string, limit int, now time.Time) (LocalDirectoryPage, error) {
	page := LocalDirectoryPage{Items: []json.RawMessage{}}
	if (kind != "employees" && kind != "departments") || limit < 1 || limit > 100 {
		return page, ErrInvalid
	}
	var tx pgx.Tx
	var err error
	if now.IsZero() {
		return page, ErrInvalid
	}
	if cursorValue == "" {
		tx, err = s.localDirectoryTransaction(ctx, c, now)
	} else {
		tx, err = s.Pool.Begin(ctx)
	}
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	var cursor localDirectoryCursor
	var watermark int64
	if cursorValue == "" {
		cursor = localDirectoryCursor{Snapshot: uuid.NewString(), Kind: kind}
		if err = tx.QueryRow(ctx, "SELECT COALESCE(max(sequence),0) FROM pl_local_directory_events").Scan(&watermark); err != nil {
			return page, err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM pl_local_directory_snapshots WHERE expires_at<=$1", now); err != nil {
			return page, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO pl_local_directory_snapshots(id,watermark,expires_at) VALUES($1,$2,$3)", cursor.Snapshot, watermark, now.Add(localDirectorySnapshotTTL)); err != nil {
			return page, err
		}
		rows, e := tx.Query(ctx, "SELECT subject,name,admin,state,revision,source_revision FROM pl_local_directory_accounts ORDER BY subject")
		if e != nil {
			return page, e
		}
		accounts := []localDirectoryAccount{}
		for rows.Next() {
			var account localDirectoryAccount
			if e = rows.Scan(&account.Subject, &account.Name, &account.Admin, &account.State, &account.Revision, &account.SourceRevision); e != nil {
				rows.Close()
				return page, e
			}
			accounts = append(accounts, account)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return page, e
		}
		for _, account := range accounts {
			key := account.Subject
			var body any = localDirectoryIdentity(account, now)
			if kind == "departments" {
				department := localDirectoryDepartment(account)
				key, body = department.ID, department
			}
			if _, e = tx.Exec(ctx, "INSERT INTO pl_local_directory_snapshot_items(snapshot_id,kind,item_key,body) VALUES($1,$2,$3,$4)", cursor.Snapshot, kind, key, encode(body)); e != nil {
				return page, e
			}
		}
	} else {
		cursor, err = parseLocalDirectoryCursor(cursorValue)
		if err != nil || cursor.Kind != kind {
			return page, ErrInvalid
		}
		if err = tx.QueryRow(ctx, "SELECT watermark FROM pl_local_directory_snapshots WHERE id=$1 AND expires_at>$2", cursor.Snapshot, now).Scan(&watermark); errors.Is(err, pgx.ErrNoRows) {
			return page, ErrLocalDirectoryResync
		} else if err != nil {
			return page, err
		}
	}
	rows, err := tx.Query(ctx, "SELECT item_key,body FROM pl_local_directory_snapshot_items WHERE snapshot_id=$1 AND kind=$2 AND item_key>$3 ORDER BY item_key LIMIT $4", cursor.Snapshot, kind, cursor.After, limit+1)
	if err != nil {
		return page, err
	}
	var last string
	for rows.Next() {
		var key string
		var raw []byte
		if err = rows.Scan(&key, &raw); err != nil {
			rows.Close()
			return page, err
		}
		if len(page.Items) < limit {
			page.Items = append(page.Items, json.RawMessage(raw))
			last = key
		} else {
			cursor.After = last
			page.NextCursor = base64.RawURLEncoding.EncodeToString(encode(cursor))
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return page, err
	}
	page.ChangesCursor = localDirectoryChangeCursor(watermark)
	if err = tx.Commit(ctx); err != nil {
		return page, err
	}
	return page, nil
}
func (s *Store) LocalDirectoryChanges(ctx context.Context, c LocalDirectoryConfig, after string, limit int, now time.Time) (LocalDirectoryPage, error) {
	page := LocalDirectoryPage{Items: []json.RawMessage{}}
	sequence, err := parseLocalDirectoryChangeCursor(after)
	if err != nil || limit < 1 || limit > 100 {
		return page, ErrInvalid
	}
	tx, err := s.localDirectoryTransaction(ctx, c, now)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	var watermark int64
	if err = tx.QueryRow(ctx, "SELECT COALESCE(max(sequence),0) FROM pl_local_directory_events").Scan(&watermark); err != nil {
		return page, err
	}
	if sequence > watermark {
		return page, ErrInvalid
	}
	rows, err := tx.Query(ctx, `SELECT sequence,body FROM pl_local_directory_events WHERE sequence>$1 ORDER BY sequence LIMIT $2`, sequence, limit)
	if err != nil {
		return page, err
	}
	type eventRow struct {
		Sequence int64
		Body     []byte
	}
	events := []eventRow{}
	for rows.Next() {
		var row eventRow
		if err = rows.Scan(&row.Sequence, &row.Body); err != nil {
			rows.Close()
			return page, err
		}
		events = append(events, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return page, err
	}
	last := sequence
	for _, event := range events {
		var body map[string]json.RawMessage
		if json.Unmarshal(event.Body, &body) != nil {
			return page, ErrInvalid
		}
		if string(body["type"]) == `"identity.changed"` {
			var identity LocalDirectoryIdentity
			if json.Unmarshal(body["identity"], &identity) != nil {
				return page, ErrInvalid
			}
			account, e := scanLocalDirectoryAccount(tx.QueryRow(ctx, "SELECT subject,name,admin,state,revision,source_revision FROM pl_local_directory_accounts WHERE subject=$1", identity.Subject))
			if e != nil {
				return page, e
			}
			// Only the current exact revision gets a new successful observation time.
			if account.Revision == identity.Revision {
				body["identity"] = encode(localDirectoryIdentity(account, now))
			}
		}
		body["cursor"] = encode(localDirectoryChangeCursor(event.Sequence))
		page.Items = append(page.Items, encode(body))
		last = event.Sequence
	}
	if len(events) < limit {
		last = watermark
	}
	page.NextCursor = localDirectoryChangeCursor(last)
	if err = tx.Commit(ctx); err != nil {
		return page, err
	}
	return page, nil
}
