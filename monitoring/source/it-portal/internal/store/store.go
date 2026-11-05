package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	migrations "pl/portal/db"
	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

var ErrConflict = errors.New("revision_conflict")
var ErrNotFound = errors.New("not_found")
var ErrInvalid = errors.New("invalid_data")

type Store struct {
	Pool *pgxpool.Pool
	Q    *sqlgen.Queries
}
type DB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func Open(ctx context.Context, url string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 8
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	s := &Store{Pool: p, Q: sqlgen.New(p)}
	if err = s.Migrate(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398215)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	names, err := fs.Glob(migrations.Migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		var exists bool
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", name).Scan(&exists)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		body, e := migrations.Migrations.ReadFile(name)
		if e != nil {
			return e
		}
		if _, err = tx.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES($1)", name); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func translate(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var p *pgconn.PgError
	if errors.As(err, &p) && p.Code == "23505" {
		return ErrConflict
	}
	return err
}
func Normalize(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), "ё", "е")), " ")
}
func document(d sqlgen.Document) json.RawMessage {
	var m map[string]any
	_ = json.Unmarshal(d.Body, &m)
	if d.Kind != "settings" && d.Kind != "preferences" && d.Kind != "dictionaries" {
		m["id"] = d.ID
	}
	m["revision"] = d.Revision
	b, _ := json.Marshal(m)
	return b
}
func (s *Store) Get(ctx context.Context, kind, id string) (json.RawMessage, error) {
	d, e := s.Q.GetDocument(ctx, sqlgen.GetDocumentParams{Kind: kind, ID: id})
	if e != nil {
		return nil, translate(e)
	}
	return document(d), nil
}
func (s *Store) List(ctx context.Context, kind string) ([]json.RawMessage, error) {
	ds, e := s.Q.ListDocuments(ctx, kind)
	if e != nil {
		return nil, e
	}
	out := make([]json.RawMessage, 0, len(ds))
	for _, d := range ds {
		out = append(out, document(d))
	}
	return out, nil
}
func Decode[T any](b []byte) (T, error) { var v T; e := json.Unmarshal(b, &v); return v, e }
func Get[T any](ctx context.Context, s *Store, kind, id string) (T, error) {
	b, e := s.Get(ctx, kind, id)
	if e != nil {
		var zero T
		return zero, e
	}
	return Decode[T](b)
}
func List[T any](ctx context.Context, s *Store, kind string) ([]T, error) {
	bs, e := s.List(ctx, kind)
	if e != nil {
		return nil, e
	}
	out := make([]T, 0, len(bs))
	for _, b := range bs {
		v, e := Decode[T](b)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}
func encode(v any) []byte { b, _ := json.Marshal(v); return b }
func (s *Store) Save(ctx context.Context, kind, id string, revision int64, value any, actor string) (json.RawMessage, error) {
	if kind == "integration" || kind == "settings" || kind == "dictionaries" {
		return s.SaveSettingsWithHistory(ctx, kind, id, revision, value, actor)
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if kind == "resource" || kind == "collection" {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
			return nil, e
		}
	}
	if kind == "resource" {
		resource, err := Decode[model.Resource](encode(value))
		if err != nil {
			return nil, err
		}
		if err = prepareResourceIPSource(ctx, tx, id, revision, &resource); err != nil {
			return nil, err
		}
		value = resource
	}
	var auditBefore []byte
	if err := tx.QueryRow(ctx, "SELECT body FROM documents WHERE kind=$1 AND id=$2", kind, id).Scan(&auditBefore); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	out, e := save(ctx, tx, kind, id, revision, value)
	if e != nil {
		return nil, e
	}
	auditDetails := auditDocumentDetails(kind, revision+1, auditBefore, encode(value))
	if e = record(ctx, tx, kind+".saved", auditSavedTitle(kind, auditDetails), id, actor, auditDetails, true); e != nil {
		return nil, e
	}
	if kind == "resource" || kind == "collection" {
		if e = reindex(ctx, tx); e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return out, nil
}
func save(ctx context.Context, tx pgx.Tx, kind, id string, revision int64, value any) (json.RawMessage, error) {
	b := encode(value)
	q := sqlgen.New(tx)
	var d sqlgen.Document
	var e error
	if revision == 0 {
		d, e = q.InsertDocument(ctx, sqlgen.InsertDocumentParams{Kind: kind, ID: id, Body: b, SearchText: ""})
	} else {
		d, e = q.UpdateDocument(ctx, sqlgen.UpdateDocumentParams{Kind: kind, ID: id, Body: b, SearchText: "", Revision: revision})
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, ErrConflict
		}
	}
	if e != nil {
		return nil, translate(e)
	}
	return document(d), nil
}
func (s *Store) Delete(ctx context.Context, kind, id string, revision int64, actor string) error {
	if kind == "integration" {
		return s.DeleteSettingsWorkspace(ctx, kind, id, revision, actor)
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if kind == "resource" || kind == "collection" {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); e != nil {
			return e
		}
	}
	var deletedName string
	if err := tx.QueryRow(ctx, "SELECT COALESCE(body->>'name','') FROM documents WHERE kind=$1 AND id=$2 AND revision=$3", kind, id, revision).Scan(&deletedName); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	n, e := sqlgen.New(tx).DeleteDocument(ctx, sqlgen.DeleteDocumentParams{Kind: kind, ID: id, Revision: revision})
	if e != nil {
		return e
	}
	if n != 1 {
		return ErrConflict
	}
	details := map[string]any{"object_name": deletedName, "action": "deleted"}
	title := "Удалена запись"
	if deletedName != "" {
		title = "Удалён объект: " + deletedName
	}
	if e = record(ctx, tx, kind+".deleted", title, id, actor, details, true); e != nil {
		return e
	}
	if kind == "collection" {
		if e = reindex(ctx, tx); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func record(ctx context.Context, db DB, kind, title, resource, actor string, details map[string]any, audit bool) error {
	if audit {
		var err error
		details, err = recordAuditContext(ctx, db, kind, resource, details)
		if err != nil {
			return err
		}
	}
	ev := model.Event{ID: uuid.NewString(), Kind: kind, Title: title, ResourceID: resource, Actor: actor, CreatedAt: time.Now().UTC(), Details: details}
	// Keep the stable actor ID for audit and a display-name snapshot for readers.
	if actor != "" {
		e := db.QueryRow(ctx, "SELECT user_name FROM sessions WHERE user_id=$1 ORDER BY expires_at DESC LIMIT 1", actor).Scan(&ev.ActorName)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
	}
	table := "events"
	if audit {
		table = "audit_events"
	}
	_, e := db.Exec(ctx, "INSERT INTO "+table+"(id,body) VALUES($1,$2)", ev.ID, encode(ev))
	return e
}
func (s *Store) Event(ctx context.Context, kind, title, resource, actor string, details map[string]any, audit bool) error {
	return record(ctx, s.Pool, kind, title, resource, actor, details, audit)
}
func (s *Store) Events(ctx context.Context, audit bool) ([]model.Event, error) {
	table := "events"
	if audit {
		table = "audit_events"
	}
	// Resolve only absent display names for this page in one read-only query.
	// Stable user IDs join the records; a session is preferred over historical
	// display names. Existing event snapshots always keep their original name.
	rows, e := s.Pool.Query(ctx, `
WITH recent AS MATERIALIZED (
 SELECT body, created_at FROM `+table+` ORDER BY created_at DESC LIMIT 200
), missing AS (
 SELECT DISTINCT body->>'actor' AS actor FROM recent
 WHERE COALESCE(body->>'actor_name','')='' AND COALESCE(body->>'actor','')<>''
), candidates AS (
 SELECT s.user_id AS actor, s.user_name AS name, 0 AS priority, s.expires_at AS observed_at
 FROM sessions s JOIN missing m ON m.actor=s.user_id WHERE s.user_name<>''
 UNION ALL
 SELECT e.body->>'actor', e.body->>'actor_name', 1, e.created_at
 FROM events e JOIN missing m ON m.actor=e.body->>'actor'
 WHERE COALESCE(e.body->>'actor_name','')<>''
 UNION ALL
 SELECT e.body->>'actor', e.body->>'actor_name', 1, e.created_at
 FROM audit_events e JOIN missing m ON m.actor=e.body->>'actor'
 WHERE COALESCE(e.body->>'actor_name','')<>''
), names AS (
 SELECT DISTINCT ON (actor) actor, name FROM candidates
 ORDER BY actor, priority, observed_at DESC, name
)
SELECT r.body, COALESCE(n.name,'') FROM recent r
LEFT JOIN names n ON n.actor=r.body->>'actor'
ORDER BY r.created_at DESC`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []model.Event{}
	for rows.Next() {
		var b []byte
		var actorName string
		if e = rows.Scan(&b, &actorName); e != nil {
			return nil, e
		}
		v, e := Decode[model.Event](b)
		if e != nil {
			return nil, e
		}
		if v.ActorName == "" {
			v.ActorName = actorName
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Defaults(ctx context.Context) error {
	for k, v := range map[string]any{"settings": model.Settings{BoardTitle: "Platform · Состояние сервисов", BoardResourceIDs: []string{}, Timezone: "Europe/Moscow", StaleAfterSeconds: 180}, "dictionaries": model.Dictionaries{Directions: []string{"Мониторинг", "Сети", "AD / Windows", "Виртуализация", "Контейнеры", "Файлы", "Управление"}, Sites: []string{}, Environments: []string{"Prod", "Test", "Lab"}, Types: []string{"Приложение", "Сервер", "Сетевое устройство", "Хранилище", "Management"}, RelationTypes: []string{"Размещено на", "Использует БД", "Зависит от", "Резервируется на"}}} {
		_, e := s.Pool.Exec(ctx, "INSERT INTO documents(kind,id,body) VALUES($1,'global',$2) ON CONFLICT DO NOTHING", k, encode(v))
		if e != nil {
			return e
		}
	}
	return nil
}

// Rebuild search context atomically: names of collections and explicit relations are searchable.
func reindex(ctx context.Context, tx pgx.Tx) error {
	q := sqlgen.New(tx)
	ds, e := q.ListDocuments(ctx, "resource")
	if e != nil {
		return e
	}
	cs, e := q.ListDocuments(ctx, "collection")
	if e != nil {
		return e
	}
	resources := map[string]model.Resource{}
	for _, d := range ds {
		v, e := Decode[model.Resource](document(d))
		if e != nil {
			return e
		}
		resources[v.ID] = v
	}
	collections := []model.Collection{}
	for _, c := range cs {
		v, e := Decode[model.Collection](document(c))
		if e != nil {
			return e
		}
		collections = append(collections, v)
	}
	for id, r := range resources {
		words := []string{r.Name, r.Description, r.Type, r.URL, r.IP, r.Hostname, r.Site, r.Environment}
		words = append(words, r.Aliases...)
		words = append(words, r.Directions...)
		words = append(words, r.Tags...)
		for _, ep := range r.Endpoints {
			words = append(words, ep.Name, ep.URL)
		}
		for _, rel := range r.Relations {
			words = append(words, rel.Label, resources[rel.ResourceID].Name)
		}
		if _, e = tx.Exec(ctx, "UPDATE documents SET search_text=$2 WHERE kind='resource' AND id=$1", id, Normalize(strings.Join(words, " "))); e != nil {
			return e
		}
	}
	collectionNames := map[string][]string{}
	for _, c := range collections {
		if c.Mode == "filter" {
			matches, e := q.SearchResources(ctx, strings.Fields(Normalize(c.Filter.Q)))
			if e != nil {
				return e
			}
			filter := c.Filter
			filter.Q = ""
			for _, d := range matches {
				r := resources[d.ID]
				if Matches(r, filter) {
					collectionNames[d.ID] = append(collectionNames[d.ID], c.Name)
				}
			}
		} else {
			for _, id := range c.ResourceIDs {
				collectionNames[id] = append(collectionNames[id], c.Name)
			}
		}
	}
	for id, names := range collectionNames {
		if _, e = tx.Exec(ctx, "UPDATE documents SET search_text=search_text||' '||$2 WHERE kind='resource' AND id=$1", id, Normalize(strings.Join(names, " "))); e != nil {
			return e
		}
	}
	return nil
}
func Contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}
func Matches(r model.Resource, f model.Filter) bool {
	return (f.Direction == "" || Contains(r.Directions, f.Direction)) && (f.Site == "" || r.Site == f.Site) && (f.Environment == "" || r.Environment == f.Environment) && (f.Tag == "" || Contains(r.Tags, f.Tag)) && (f.Lifecycle == "" || r.Lifecycle == f.Lifecycle) && (f.Q == "" || strings.Contains(Normalize(r.Name+" "+r.Description+" "+strings.Join(r.Aliases, " ")+" "+r.Hostname+" "+r.IP), Normalize(f.Q)))
}
func (s *Store) Search(ctx context.Context, f model.Filter, favorites []string) ([]model.Resource, error) {
	ds, e := s.Q.SearchResources(ctx, strings.Fields(Normalize(f.Q)))
	if e != nil {
		return nil, e
	}
	out := []model.Resource{}
	var collection *model.Collection
	collectionMatches := map[string]bool{}
	if f.Collection != "" {
		c, e := Get[model.Collection](ctx, s, "collection", f.Collection)
		if e != nil {
			return nil, e
		}
		collection = &c
		if c.Mode == "filter" {
			filter := c.Filter
			filter.Collection = ""
			matches, e := s.Search(ctx, filter, nil)
			if e != nil {
				return nil, e
			}
			for _, v := range matches {
				collectionMatches[v.ID] = true
			}
		}
	}
	sf := f
	sf.Q = ""
	if sf.Lifecycle == "all" {
		sf.Lifecycle = ""
	} else if sf.Lifecycle == "" {
		sf.Lifecycle = "active"
	}
	for _, d := range ds {
		r, e := Decode[model.Resource](document(d))
		if e != nil {
			return nil, e
		}
		if !Matches(r, sf) {
			continue
		}
		if collection != nil && !((collection.Mode != "filter" && Contains(collection.ResourceIDs, r.ID)) || (collection.Mode == "filter" && collectionMatches[r.ID])) {
			continue
		}
		out = append(out, r)
	}
	score := func(r model.Resource) int {
		q := Normalize(f.Q)
		n := Normalize(r.Name)
		if q == "" {
			return 0
		}
		v := 100
		if n == q || Normalize(r.IP) == q || Normalize(r.Hostname) == q {
			v = 10000
		} else if Contains(normalized(r.Aliases), q) {
			v = 9500
		} else if strings.HasPrefix(n, q) || strings.HasPrefix(Normalize(r.Hostname), q) || strings.HasPrefix(r.IP, q) {
			v = 8000
		} else if strings.Contains(n, q) {
			v = 6000
		} else if Near(n, q) {
			v = 5000
		}
		if Contains(favorites, r.ID) {
			v++
		}
		return v
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := score(out[i]), score(out[j])
		if a != b {
			return a > b
		}
		if f.Sort == "updated" {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return Normalize(out[i].Name) < Normalize(out[j].Name)
	})
	return out, nil
}
func normalized(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = Normalize(s)
	}
	return out
}
