package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// Historical resource_id also contains document IDs. Keep that raw field, but
// never equate IDs across namespaces in the journal projection or correlation.
const journalObjectKindSQL = `COALESCE(NULLIF(e.body #>> '{details,object_kind}',''),CASE
 WHEN e.body->>'kind' LIKE 'job.%' OR e.body->>'kind'='module.queued' THEN 'job'
 WHEN e.body->>'kind' LIKE 'auth.%' THEN 'session'
 WHEN split_part(e.body->>'kind','.',1) IN ('resource','collection','integration','settings','dictionaries','preferences','dashboard_layout','workspace_preferences','chart_settings','problem_presentation','system','problem') THEN split_part(e.body->>'kind','.',1)
 ELSE '' END)`
const journalObjectIDSQL = `CASE WHEN (` + journalObjectKindSQL + `)='session' THEN ''
 WHEN (` + journalObjectKindSQL + `)='job' THEN COALESCE(e.body #>> '{details,job_id}','')
 WHEN (` + journalObjectKindSQL + `)='problem' THEN COALESCE(e.body #>> '{details,problem_id}','')
 ELSE COALESCE(NULLIF(e.body #>> '{details,object_id}',''),e.body->>'resource_id','') END`

func eventObject(kind, id string, details map[string]any) (string, string) {
	object := detailString(details, "object_kind")
	if object == "" {
		prefix, _, _ := strings.Cut(kind, ".")
		switch prefix {
		case "job":
			object = "job"
		case "module":
			if detailString(details, "job_id") != "" {
				object = "job"
			}
		case "auth":
			object = "session"
		case "resource", "collection", "integration", "settings", "dictionaries", "preferences", "dashboard_layout", "workspace_preferences", "chart_settings", "problem_presentation", "system", "problem":
			object = prefix
		}
	}
	switch object {
	case "session":
		return object, ""
	case "job":
		return object, detailString(details, "job_id")
	case "problem":
		return object, detailString(details, "problem_id")
	}
	if v := detailString(details, "object_id"); v != "" {
		id = v
	}
	return object, id
}
func eventAction(kind string, details map[string]any) string {
	if v := detailString(details, "action"); v != "" {
		return v
	}
	_, action, _ := strings.Cut(kind, ".")
	switch action {
	case "saved", "created", "deleted", "archived", "login", "logout", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "hidden", "unhidden", "links_changed":
		return action
	}
	return ""
}
func auditObjectLabel(kind string) string {
	switch kind {
	case "preferences":
		return "Личные настройки"
	case "dashboard_layout":
		return "Раскладка рабочего пространства"
	case "workspace_preferences":
		return "Настройки рабочего пространства"
	case "chart_settings":
		return "Настройки графиков"
	case "problem_presentation":
		return "Отображение проблем"
	case "settings":
		return "Настройки Платформы"
	case "dictionaries":
		return "Справочники"
	case "session":
		return "Сессия Платформы"
	}
	return ""
}
func auditDocumentDetails(kind string, revision int64, before, after []byte) map[string]any {
	details := map[string]any{"kind": kind, "revision": revision, "action": "saved"}
	if revision == 1 {
		details["action"] = "created"
	}
	var old, next map[string]any
	_ = json.Unmarshal(before, &old)
	_ = json.Unmarshal(after, &next)
	if name, ok := next["name"].(string); ok && name != "" {
		details["object_name"] = name
	}
	fields := map[string][]string{
		"preferences":           {"favorites", "section_order", "hidden_sections", "sidebar_collapsed", "wayline_cards"},
		"dashboard_layout":      {"tiles", "hidden"},
		"workspace_preferences": {"system_ids", "groups"},
	}
	changed := []string{}
	for _, key := range fields[kind] {
		if !reflect.DeepEqual(old[key], next[key]) {
			changed = append(changed, key)
		}
	}
	if len(changed) > 0 {
		details["changed_fields"] = changed
	}
	if kind == "preferences" && !reflect.DeepEqual(old["favorites"], next["favorites"]) {
		change := "membership"
		if sameAuditMembers(old["favorites"], next["favorites"]) {
			change = "order"
		}
		details["favorites_change"] = change
	}
	return details
}
func recordAuditContext(ctx context.Context, db DB, kind, id string, details map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for k, v := range details {
		out[k] = v
	}
	object, objectID := eventObject(kind, id, out)
	if object != "" {
		out["object_kind"] = object
	}
	if objectID != "" {
		out["object_id"] = objectID
	}
	if action := eventAction(kind, out); action != "" {
		out["action"] = action
	}
	if detailString(out, "object_name") == "" {
		name := auditObjectLabel(object)
		if name == "" && objectID != "" && object != "job" && object != "problem" {
			err := db.QueryRow(ctx, "SELECT COALESCE(body->>'name','') FROM documents WHERE kind=$1 AND id=$2", object, objectID).Scan(&name)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
		}
		if name != "" {
			out["object_name"] = name
		}
	}
	return out, nil
}
func auditSavedTitle(kind string, details map[string]any) string {
	fields, _ := details["changed_fields"].([]string)
	if len(fields) == 1 {
		switch fields[0] {
		case "favorites":
			if detailString(details, "favorites_change") == "order" {
				return "Изменён порядок избранного"
			}
			return "Изменён состав избранного"
		case "section_order":
			return "Изменён порядок разделов главной"
		case "hidden_sections", "hidden":
			return "Изменены видимые разделы главной"
		case "sidebar_collapsed":
			return "Изменено состояние бокового меню"
		case "wayline_cards":
			return "Изменены карточки Wayline"
		case "tiles":
			return "Изменена раскладка карточек главной"
		case "system_ids":
			return "Изменён набор систем на главной"
		case "groups":
			return "Изменены группы закреплений"
		}
	}
	if name := auditObjectLabel(kind); name != "" {
		return "Сохранено: " + name
	}
	if name := detailString(details, "object_name"); name != "" {
		return "Сохранён объект: " + name
	}
	return "Сохранена запись каталога"
}
func jobEventContext(ctx context.Context, db DB, j model.Job) (map[string]any, error) {
	details := map[string]any{"job_id": j.ID, "kind": j.Kind, "job_kind": j.Kind, "status": j.Status, "object_kind": "job", "object_id": j.ID}
	for _, target := range []struct{ kind, id, key string }{{"resource", j.ResourceID, "resource_name"}, {"integration", j.IntegrationID, "integration_name"}} {
		if target.id == "" {
			continue
		}
		var name string
		err := db.QueryRow(ctx, "SELECT COALESCE(body->>'name','') FROM documents WHERE kind=$1 AND id=$2", target.kind, target.id).Scan(&name)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if name != "" {
			details[target.key] = name
			if detailString(details, "object_name") == "" {
				details["object_name"] = name
			}
		}
	}
	if j.IntegrationID != "" {
		details["integration_id"] = j.IntegrationID
	}
	if j.Kind == "delivery" {
		for _, key := range []string{"operation_id", "action", "target", "version", "module_id"} {
			if value := detailString(j.Parameters, key); value != "" {
				details[key] = value
			}
		}
		details["object_name"] = detailString(j.Parameters, "target")
		details["phase"] = detailString(j.Result, "phase")
		details["result_summary"] = detailString(j.Result, "summary")
	}
	if j.Kind == "module" {
		id := detailString(j.Parameters, "instance_id")
		details["instance_id"] = id
		details["module_action"] = detailString(j.Parameters, "action")
		details["action"] = detailString(j.Parameters, "action")
		var instance model.ModuleInstance
		if result, ok := j.Result["instance"]; ok {
			raw, _ := json.Marshal(result)
			_ = json.Unmarshal(raw, &instance)
		}
		if instance.ID == "" && id != "" {
			var raw []byte
			err := db.QueryRow(ctx, "SELECT body FROM documents WHERE kind='module_instance' AND id=$1", id).Scan(&raw)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			if err == nil {
				_ = json.Unmarshal(raw, &instance)
			}
		}
		details["module_id"] = instance.ModuleID
		name := instance.Name
		if name == "" {
			if def, found := model.ModuleDefinition(instance.ModuleID); found {
				name = def.Name
			}
		}
		if name == "" {
			name = id
		}
		if name != "" {
			details["object_name"] = name
			details["module_name"] = name
			details["target"] = name
		}
	}
	if target := detailString(j.Parameters, "target"); target != "" && detailString(details, "target") == "" {
		details["target"] = target
	}
	if j.Error != "" {
		details["error"] = j.Error
	}
	if summary := jobResultSummary(j); summary != "" {
		details["result_summary"] = summary
	}
	// Do not copy arbitrary parameters/results: they may contain configuration secrets.
	return details, nil
}

func moduleActionLabel(action string) string {
	if label := map[string]string{"enable": "Включение модуля", "disable": "Отключение модуля", "refresh": "Обновление состояния модуля", "install": "Установка модуля", "connect": "Подключение модуля", "reconnect": "Переподключение модуля", "configure": "Применение конфигурации модуля", "remove": "Удаление модуля", "start": "Запуск модуля", "stop": "Остановка модуля", "restart": "Перезапуск модуля", "update": "Обновление модуля"}[action]; label != "" {
		return label
	}
	if action != "" {
		return "Модуль: " + action
	}
	return "Операция с модулем"
}

func jobEventTitle(j model.Job, details map[string]any) string {
	label := map[string]string{"refresh": "Обновление источника", "check": "Проверка доступности", "enrich": "Обогащение ресурса", "report": "Формирование отчёта", "restart": "Перезапуск контейнера"}[j.Kind]
	if j.Kind == "delivery" {
		label = "Обновление Платформы"
		if detailString(j.Parameters, "action") == "module-upgrade" {
			label = "Обновление модуля"
		}
	}
	if j.Kind == "module" {
		label = moduleActionLabel(detailString(details, "module_action"))
	}
	if label == "" {
		label = "Задание"
	}
	if name := detailString(details, "object_name"); name != "" {
		label += " · " + name
	}
	state := map[string]string{"queued": "в очереди", "running": "выполняется", "succeeded": "завершено", "failed": "завершилось ошибкой", "unknown": "результат неизвестен", "cancelled": "отменено"}[j.Status]
	if state != "" {
		label += " — " + state
	}
	return label
}

// Compare multiplicities as well as values: repeated IDs must not turn a
// membership change into a claimed reorder.
func sameAuditMembers(before, after any) bool {
	a, okA := before.([]any)
	b, okB := after.([]any)
	if !okA || !okB || len(a) != len(b) {
		return false
	}
	counts := map[string]int{}
	for _, v := range a {
		text, ok := v.(string)
		if !ok {
			return false
		}
		counts[text]++
	}
	for _, v := range b {
		text, ok := v.(string)
		if !ok {
			return false
		}
		counts[text]--
	}
	for _, n := range counts {
		if n != 0 {
			return false
		}
	}
	return true
}

// Only observed result fields are summarized; success never implies availability.
func jobResultSummary(j model.Job) string {
	if j.Kind != "module" || j.Status != "succeeded" {
		return ""
	}
	if detailString(j.Parameters, "action") == "remove" {
		return "Модуль удалён"
	}
	raw, ok := j.Result["instance"]
	if !ok {
		return ""
	}
	b, _ := json.Marshal(raw)
	var instance model.ModuleInstance
	if json.Unmarshal(b, &instance) != nil {
		return ""
	}
	parts := []string{}
	if state := instance.ObservedState; state != "" {
		label := map[string]string{"running": "работает", "connected": "подключён", "unavailable": "недоступен", "absent": "отсутствует", "stopped": "остановлен", "disabled": "отключён", "unknown": "неизвестно"}[state]
		if label == "" {
			label = state
		}
		parts = append(parts, "Состояние: "+label)
	}
	if instance.Version != "" {
		parts = append(parts, "Версия: "+instance.Version)
	}
	return strings.Join(parts, " · ")
}
