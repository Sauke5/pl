package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
	"pl/portal/internal/store/sqlgen"
)

var ErrManagedModule = errors.New("managed_module")

// SettingsChange is an allowlisted configuration change. Operational observations
// and credential values are never copied into the settings history projection.
type SettingsChange struct {
	Field  string `json:"field"`
	Label  string `json:"label"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

type SettingsHistoryEntry struct {
	ID         string           `json:"id"`
	Kind       string           `json:"kind"`
	ObjectID   string           `json:"object_id"`
	ObjectName string           `json:"object_name"`
	Action     string           `json:"action"`
	Actor      string           `json:"actor"`
	ActorName  string           `json:"actor_name"`
	CreatedAt  time.Time        `json:"created_at"`
	Revision   int64            `json:"revision"`
	Detailed   bool             `json:"detailed"`
	Changes    []SettingsChange `json:"changes"`
}

type SettingsHistoryFilter struct {
	Kind, ID, Group, Cursor string
	Limit                   int
}

type SettingsHistoryPage struct {
	Items      []SettingsHistoryEntry `json:"items"`
	NextCursor string                 `json:"next_cursor"`
}

type settingsHistoryCursor struct {
	Kind, ID, Group string
	At              time.Time
	EventID         string
}

type settingsHistoryDetails struct {
	Kind           string           `json:"kind"`
	Revision       int64            `json:"revision"`
	HistoryVersion int              `json:"settings_history_version"`
	ObjectName     string           `json:"object_name"`
	Action         string           `json:"action"`
	Changes        []SettingsChange `json:"changes"`
}

var settingsHistoryFields = map[string][]SettingsChange{
	"settings": {
		{Field: "board_enabled", Label: "Публикация Board"},
		{Field: "board_anonymous", Label: "Анонимный доступ"},
		{Field: "board_title", Label: "Заголовок Board"},
		{Field: "board_resource_ids", Label: "Публикуемые ресурсы"},
		{Field: "timezone", Label: "Часовой пояс"},
		{Field: "stale_after_seconds", Label: "Порог устаревания, с"},
		{Field: "session_lifetime_minutes", Label: "Срок новой сессии, мин"},
		{Field: "local_password_min_length", Label: "Минимальная длина пароля"},
	},
	"dictionaries": {
		{Field: "directions", Label: "Направления"},
		{Field: "sites", Label: "Площадки"},
		{Field: "environments", Label: "Среды"},
		{Field: "types", Label: "Типы ресурсов"},
		{Field: "relation_types", Label: "Типы связей"},
	},
	"integration": {
		{Field: "name", Label: "Название"},
		{Field: "kind", Label: "Адаптер"},
		{Field: "url", Label: "Базовый URL"},
		{Field: "enabled", Label: "Подключение включено"},
		{Field: "poll_seconds", Label: "Интервал опроса, с"},
		{Field: "timeout_seconds", Label: "Таймаут, с"},
		{Field: "concurrency", Label: "Параллелизм"},
		{Field: "secret_ref", Label: "Учётные данные"},
		{Field: "config.dashboard_url", Label: "Ссылка на дашборд"},
		{Field: "config.reports_base_url", Label: "Публичный адрес отчётов"},
		{Field: "config.public_url", Label: "Публичный адрес"},
		{Field: "config.http_host", Label: "HTTP Host"},
		{Field: "config.instance_label", Label: "Метка экземпляра"},
		{Field: "config.resource_label", Label: "Метка ресурса"},
		{Field: "config.include_job", Label: "Включённые job"},
		{Field: "config.exclude_job", Label: "Исключённые job"},
		{Field: "config.match_label", Label: "Метка отбора"},
		{Field: "config.match_value", Label: "Значение отбора"},
		{Field: "config.discovery_enabled", Label: "Обнаружение ресурсов"},
		{Field: "config.basic_username", Label: "Учётная запись Wayline"},
		{Field: "config.stale_after_seconds", Label: "Порог устаревания Wayline, с"},
		{Field: "config.gitea_repository_url", Label: "Репозиторий Gitea"},
		{Field: "config.gitea_branch", Label: "Ветка Gitea"},
		{Field: "config.node_bindings", Label: "Соответствия устройств"},
	},
}

// SaveSettingsWorkspace accepts an administrative draft and records its
// configuration delta in the same transaction as the document update.
func (s *Store) SaveSettingsWorkspace(ctx context.Context, kind, id string, revision int64, value any, actor string) (json.RawMessage, error) {
	return s.saveSettingsWorkspace(ctx, kind, id, revision, value, actor, true)
}

// SaveSettingsWithHistory is the compatibility hook for low-level Store.Save.
// It adds history without changing that method's treatment of observed state.
func (s *Store) SaveSettingsWithHistory(ctx context.Context, kind, id string, revision int64, value any, actor string) (json.RawMessage, error) {
	return s.saveSettingsWorkspace(ctx, kind, id, revision, value, actor, false)
}

func (s *Store) saveSettingsWorkspace(ctx context.Context, kind, id string, revision int64, value any, actor string, draft bool) (json.RawMessage, error) {
	if _, ok := settingsHistoryFields[kind]; !ok || id == "" || revision < 0 {
		return nil, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var before []byte
	if revision > 0 {
		var actual int64
		if err = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind=$1 AND id=$2 FOR UPDATE", kind, id).Scan(&actual, &before); err != nil {
			return nil, translate(err)
		}
		if actual != revision {
			return nil, ErrConflict
		}
	}
	if kind == "integration" && draft {
		value, err = settingsIntegrationRuntime(value, before)
		if err != nil {
			return nil, err
		}
	}
	out, err := save(ctx, tx, kind, id, revision, value)
	if err != nil {
		return nil, err
	}
	action := "saved"
	if revision == 0 {
		action = "created"
	}
	if err = recordSettingsChange(ctx, tx, kind, id, revision+1, actor, action, before, out); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func settingsIntegrationRuntime(value any, before []byte) (model.Integration, error) {
	var next, previous model.Integration
	if json.Unmarshal(encode(value), &next) != nil {
		return next, ErrInvalid
	}
	if next.ManagedModuleID != "" {
		return next, ErrManagedModule
	}
	if len(before) > 0 {
		if json.Unmarshal(before, &previous) != nil {
			return next, ErrInvalid
		}
		if previous.ManagedModuleID != "" {
			return next, ErrManagedModule
		}
		next.Status, next.Error = previous.Status, previous.Error
		next.LastAttempt, next.LastSuccess = previous.LastAttempt, previous.LastSuccess
		if next.Kind != previous.Kind || next.URL != previous.URL || next.SecretRef != previous.SecretRef || !reflect.DeepEqual(next.Config, previous.Config) {
			next.Status, next.Error = "unconfigured", ""
			next.LastAttempt, next.LastSuccess = nil, nil
		} else if next.Enabled && !previous.Enabled {
			next.Status = "unconfigured"
		}
	} else {
		next.Status, next.Error = "unconfigured", ""
		next.LastAttempt, next.LastSuccess = nil, nil
	}
	if !next.Enabled {
		next.Status = "disabled"
	}
	return next, nil
}

func (s *Store) DeleteSettingsWorkspace(ctx context.Context, kind, id string, revision int64, actor string) error {
	if kind != "integration" || revision < 1 {
		return ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var actual int64
	var before []byte
	if err = tx.QueryRow(ctx, "SELECT revision,body FROM documents WHERE kind=$1 AND id=$2 FOR UPDATE", kind, id).Scan(&actual, &before); err != nil {
		return translate(err)
	}
	if actual != revision {
		return ErrConflict
	}
	var integration model.Integration
	if json.Unmarshal(before, &integration) != nil {
		return ErrInvalid
	}
	if integration.ManagedModuleID != "" {
		return ErrManagedModule
	}
	n, err := sqlgen.New(tx).DeleteDocument(ctx, sqlgen.DeleteDocumentParams{Kind: kind, ID: id, Revision: revision})
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	if err = recordSettingsChange(ctx, tx, kind, id, revision, actor, "deleted", before, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func settingsMap(body []byte) map[string]any {
	var out map[string]any
	_ = json.Unmarshal(body, &out)
	if out == nil {
		out = map[string]any{}
	}
	if config, ok := out["config"].(map[string]any); ok {
		for key, value := range config {
			out["config."+key] = value
		}
	}
	return out
}

func settingsHistoryValue(field string, value any) any {
	if value == nil {
		return nil
	}
	if field == "secret_ref" || field == "config.basic_username" {
		if value == "" {
			return "Не задано"
		}
		return "Задано"
	}
	if field == "url" || strings.HasSuffix(field, "_url") {
		raw, ok := value.(string)
		if !ok {
			return nil
		}
		u, err := url.Parse(raw)
		if err != nil {
			return "Некорректный адрес"
		}
		u.User, u.RawQuery, u.Fragment, u.RawFragment = nil, "", "", ""
		u.ForceQuery = false
		return u.String()
	}
	return value
}

func settingsDelta(kind string, before, after []byte) []SettingsChange {
	old, next := settingsMap(before), settingsMap(after)
	changes := []SettingsChange{}
	for _, field := range settingsHistoryFields[kind] {
		a, b := old[field.Field], next[field.Field]
		if reflect.DeepEqual(a, b) {
			continue
		}
		field.Before, field.After = settingsHistoryValue(field.Field, a), settingsHistoryValue(field.Field, b)
		if (field.Field == "secret_ref" || field.Field == "config.basic_username") && field.Before == "Задано" && field.After == "Задано" {
			field.After = "Изменено"
		}
		changes = append(changes, field)
	}
	return changes
}

func recordSettingsChange(ctx context.Context, tx pgx.Tx, kind, id string, revision int64, actor, action string, before, after []byte) error {
	name := "Настройки Платформы"
	if kind == "dictionaries" {
		name = "Справочники"
	} else if kind == "integration" {
		body := after
		if len(body) == 0 {
			body = before
		}
		name, _ = settingsMap(body)["name"].(string)
	}
	details := settingsHistoryDetails{Kind: kind, Revision: revision, HistoryVersion: 1, ObjectName: name, Action: action, Changes: settingsDelta(kind, before, after)}
	var data map[string]any
	_ = json.Unmarshal(encode(details), &data)
	suffix, title := ".saved", "Изменены настройки"
	if action == "created" {
		title = "Добавлено подключение"
	} else if action == "deleted" {
		suffix, title = ".deleted", "Удалено подключение"
	}
	return record(ctx, tx, kind+suffix, title, id, actor, data, true)
}

func settingsFieldInGroup(field, group string) bool {
	return group == "" || (group == "general" && (field == "timezone" || field == "stale_after_seconds" || field == "session_lifetime_minutes" || field == "local_password_min_length")) || (group == "publication" && strings.HasPrefix(field, "board_"))
}

func (s *Store) SettingsHistory(ctx context.Context, filter SettingsHistoryFilter) (SettingsHistoryPage, error) {
	page := SettingsHistoryPage{Items: []SettingsHistoryEntry{}}
	if _, ok := settingsHistoryFields[filter.Kind]; !ok || filter.ID == "" || len(filter.ID) > 160 || (filter.Group != "" && (filter.Kind != "settings" || (filter.Group != "general" && filter.Group != "publication"))) || filter.Limit < 1 || filter.Limit > 100 {
		return page, ErrInvalid
	}
	cursor := settingsHistoryCursor{Kind: filter.Kind, ID: filter.ID, Group: filter.Group}
	if filter.Cursor != "" {
		if len(filter.Cursor) > 1024 {
			return page, ErrInvalid
		}
		b, err := base64.RawURLEncoding.DecodeString(filter.Cursor)
		if err != nil || json.Unmarshal(b, &cursor) != nil || cursor.Kind != filter.Kind || cursor.ID != filter.ID || cursor.Group != filter.Group || cursor.At.IsZero() || cursor.EventID == "" || len(cursor.EventID) > 160 {
			return page, ErrInvalid
		}
	}
	// Filter before pagination: a page of unrelated setting changes must not hide
	// older changes belonging to the selected group.
	rows, err := s.Pool.Query(ctx, `SELECT id,created_at,body FROM audit_events
WHERE body->>'kind'=ANY($1::text[]) AND body->>'resource_id'=$2
 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
 AND ($5::text='' OR COALESCE(body->'details'->>'settings_history_version','')<>'1'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(body->'details'->'changes')='array' THEN body->'details'->'changes' ELSE '[]'::jsonb END) c
   WHERE ($5='general' AND c->>'field' IN ('timezone','stale_after_seconds')) OR ($5='publication' AND c->>'field' LIKE 'board\_%' ESCAPE '\')))
ORDER BY created_at DESC,id DESC LIMIT $6`, []string{filter.Kind + ".saved", filter.Kind + ".deleted"}, filter.ID, nullableSettingsTime(cursor.At), cursor.EventID, filter.Group, filter.Limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var at time.Time
		var body []byte
		if err = rows.Scan(&id, &at, &body); err != nil {
			return page, err
		}
		if len(page.Items) == filter.Limit {
			last := page.Items[len(page.Items)-1]
			page.NextCursor = base64.RawURLEncoding.EncodeToString(encode(settingsHistoryCursor{Kind: filter.Kind, ID: filter.ID, Group: filter.Group, At: last.CreatedAt, EventID: last.ID}))
			break
		}
		var event model.Event
		var stored struct {
			Details settingsHistoryDetails `json:"details"`
		}
		if json.Unmarshal(body, &event) != nil || json.Unmarshal(body, &stored) != nil {
			return page, ErrInvalid
		}
		d := stored.Details
		entry := SettingsHistoryEntry{ID: id, Kind: filter.Kind, ObjectID: filter.ID, ObjectName: d.ObjectName, Action: d.Action, Actor: event.Actor, ActorName: event.ActorName, CreatedAt: at, Revision: d.Revision, Detailed: d.HistoryVersion == 1, Changes: []SettingsChange{}}
		if entry.Action == "" {
			entry.Action = "saved"
			if strings.HasSuffix(event.Kind, ".deleted") {
				entry.Action = "deleted"
			}
		}
		if entry.Detailed {
			for _, field := range settingsHistoryFields[filter.Kind] {
				if !settingsFieldInGroup(field.Field, filter.Group) {
					continue
				}
				for _, change := range d.Changes {
					if change.Field == field.Field {
						// Values were projected before persistence. Never re-read current
						// configuration to fill historical gaps.
						field.Before, field.After = change.Before, change.After
						entry.Changes = append(entry.Changes, field)
						break
					}
				}
			}
		}
		page.Items = append(page.Items, entry)
	}
	return page, rows.Err()
}

func nullableSettingsTime(at time.Time) any {
	if at.IsZero() {
		return nil
	}
	return at
}
