package store

import (
	"context"
	"fmt"
	"time"

	"pl/portal/internal/model"
)

// SeedDemo is only called for explicitly configured demo processes, never on OIDC failure.
// The same persistent documents and API serve demo and live records.
func (s *Store) SeedDemo(ctx context.Context) error {
	var exists bool
	if e := s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM documents WHERE kind='demo_seed' AND id='v1')").Scan(&exists); e != nil {
		return e
	}
	if exists {
		return nil
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398217)"); e != nil {
		return e
	}
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM documents WHERE kind='demo_seed' AND id='v1')").Scan(&exists); e != nil {
		return e
	}
	if exists {
		return nil
	}
	names := []string{"Grafana", "Prometheus", "Alertmanager", "Файловый аудит", "vCenter", "iDRAC", "RDS Broker", "NetBox", "Документация", "Резервное копирование", "Harbor", "Loki", "AD Manager", "Сетевые устройства", "Файловое хранилище", "GitLab"}
	directions := []string{"Мониторинг", "Мониторинг", "Мониторинг", "Файлы", "Виртуализация", "Управление", "AD / Windows", "Сети", "Управление", "Файлы", "Контейнеры", "Мониторинг", "AD / Windows", "Сети", "Файлы", "Контейнеры"}
	descriptions := []string{"Дашборды и диагностика инфраструктуры", "Метрики и обнаружение targets", "Актуальные оповещения", "Проверка структуры и доступа к файлам", "Управление виртуальными машинами", "Management-интерфейс сервера", "Удалённые рабочие столы", "Адресное пространство и оборудование", "База технических знаний", "Задания и результаты резервного копирования", "Реестр контейнерных образов", "Переход к журналам приложений", "Службы каталогов Windows", "Коммутаторы и маршрутизация", "Общие файловые ресурсы", "Репозитории проектов"}
	favorites := []string{}
	now := time.Now().UTC()
	ids := []string{}
	for n := 0; n < 104; n++ {
		base := n % len(names)
		name := names[base]
		if n >= len(names) {
			name = fmt.Sprintf("%s · стенд %02d", name, n/len(names)+1)
		}
		id := SourceID("demo", fmt.Sprint(n))
		ids = append(ids, id)
		if n < 8 {
			favorites = append(favorites, id)
		}
		site := []string{"Москва", "Казань", "Лаборатория"}[n%3]
		environment := []string{"Prod", "Prod", "Lab", "Test"}[n%4]
		r := model.Resource{ID: id, Name: name, Description: descriptions[base] + ". Демонстрационная запись.", Type: "Приложение", URL: fmt.Sprintf("https://service-%03d.example.invalid", n+1), IP: fmt.Sprintf("192.0.2.%d", n+1), Hostname: fmt.Sprintf("demo-srv-%03d.example.invalid", n+1), Aliases: []string{fmt.Sprintf("сервис %d", n+1), fmt.Sprintf("service-%03d", n+1)}, Directions: []string{directions[base]}, Site: site, Environment: environment, Tags: []string{"демо", []string{"инфраструктура", "поддержка", "платформа"}[n%3]}, Endpoints: []model.Endpoint{}, Links: []model.Endpoint{{Name: "Документация", URL: "https://docs.example.invalid"}}, Relations: []model.Relation{}, ExternalIDs: []string{}, Operations: []string{"check"}, Source: "demo", Lifecycle: "active", CreatedAt: now, UpdatedAt: now}
		if n == 0 {
			r.Aliases = append(r.Aliases, "графана", "дашборды")
		}
		if _, e = save(ctx, tx, "resource", id, 0, r); e != nil {
			return e
		}
	}
	if _, e = save(ctx, tx, "preferences", "demo-admin", 0, model.Preferences{Favorites: favorites, HiddenSections: []string{}}); e != nil {
		return e
	}
	if _, e = save(ctx, tx, "collection", SourceID("demo", "collection"), 0, model.Collection{Mode: "manual", ID: SourceID("demo", "collection"), Name: "Наблюдаемость", Description: "Демо-подборка сервисов мониторинга", ResourceIDs: ids[:3]}); e != nil {
		return e
	}
	stale := now.Add(-35 * time.Minute)
	iid := SourceID("demo", "alertmanager")
	pid := SourceID("demo", "prometheus")
	for _, i := range []model.Integration{{ID: iid, Name: "Alertmanager · демо", Kind: "alertmanager", URL: "https://alerts.example.invalid", Enabled: false, PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 1, Config: map[string]string{}, Status: "disabled", LastSuccess: &stale, LastAttempt: &stale, Error: "Демонстрационный источник отключён", Capabilities: []string{"problems"}}, {ID: pid, Name: "Prometheus · демо", Kind: "prometheus", URL: "https://metrics.example.invalid", Enabled: false, PollSeconds: 60, TimeoutSeconds: 10, Concurrency: 1, Config: map[string]string{}, Status: "disabled", Capabilities: []string{"discovery"}}} {
		if _, e = save(ctx, tx, "integration", i.ID, 0, i); e != nil {
			return e
		}
	}
	for n, title := range []string{"Недоступна точка входа", "Недостаточно места в хранилище", "Проверка сертификата требует внимания"} {
		id := SourceID("demo", fmt.Sprintf("problem-%d", n))
		severity := []string{"critical", "warning", "warning"}[n]
		p := model.Problem{ID: id, IntegrationID: iid, ExternalID: fmt.Sprintf("demo-alert-%d", n), Severity: severity, Title: title, Description: "Демонстрационная проблема. Источник отключён; показано последнее известное состояние.", ResourceID: ids[n+4], StartedAt: now.Add(-time.Duration(n+1) * time.Hour), LastSeen: stale, Status: "firing", Stale: true, SourceURL: "https://alerts.example.invalid", Labels: map[string]string{"demo": "true"}}
		if _, e = save(ctx, tx, "problem", id, 0, p); e != nil {
			return e
		}
	}
	for n := 0; n < 5; n++ {
		id := SourceID("demo", fmt.Sprintf("candidate-%d", n))
		c := model.Candidate{ID: id, IntegrationID: pid, ExternalID: fmt.Sprintf("demo-target-%d", n), Name: fmt.Sprintf("Новый сервер %02d", n+1), URL: fmt.Sprintf("https://new-%d.example.invalid", n+1), Labels: map[string]string{"job": "node-exporter", "demo": "true"}, State: "pending", LastSeen: stale}
		if _, e = save(ctx, tx, "candidate", id, 0, c); e != nil {
			return e
		}
	}
	for _, title := range []string{"Подготовлен демонстрационный каталог", "Добавлена подборка «Наблюдаемость»", "Получены кандидаты из демо-фикстуры", "Демонстрационные источники отключены"} {
		if e = record(ctx, tx, "demo.seed", title, "", "demo", map[string]any{"demo": true}, false); e != nil {
			return e
		}
	}
	if _, e = save(ctx, tx, "demo_seed", "v1", 0, map[string]any{"seeded_at": now}); e != nil {
		return e
	}
	if e = reindex(ctx, tx); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
