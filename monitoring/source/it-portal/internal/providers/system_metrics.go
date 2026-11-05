package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"pl/portal/internal/model"
)

type systemMetricSpec struct {
	model.SystemMetricDefinition
	metric string
	fixed  map[string]string
	// Expression wraps a fully escaped selector. Freshness always comes from the
	// underlying raw samples, never the evaluation timestamp of an expression.
	expression string
}

var systemMetricSpecs = []systemMetricSpec{
	{model.SystemMetricDefinition{Key: "target.up", Title: "Доступность наблюдаемой цели", Unit: "state", Profiles: []string{"custom"}, Description: "Получает ли Prometheus метрики с этой цели"}, "up", nil, ""},
	{model.SystemMetricDefinition{Key: "linux.cpu", Title: "Загрузка CPU Linux", Unit: "%", Profiles: []string{"linux", "custom"}, Description: "Средняя занятость CPU за последние 5 минут"}, "node_cpu_seconds_total", map[string]string{"mode": "idle"}, "100 * (1 - avg without(cpu,mode) (rate(%s[5m])))"},
	{model.SystemMetricDefinition{Key: "linux.memory", Title: "Доступная память Linux", Unit: "bytes", Profiles: []string{"linux", "custom"}, Description: "Память, доступная приложениям, из node_exporter"}, "node_memory_MemAvailable_bytes", nil, ""},
	{model.SystemMetricDefinition{Key: "linux.memory_total", Title: "Объём памяти Linux", Unit: "bytes", Profiles: []string{"linux", "custom"}, Description: "Общий объём оперативной памяти"}, "node_memory_MemTotal_bytes", nil, ""},
	{model.SystemMetricDefinition{Key: "linux.load", Title: "Load average Linux", Unit: "count", Profiles: []string{"linux", "custom"}, Description: "Среднее число выполняемых и ожидающих задач за 1 минуту"}, "node_load1", nil, ""},
	{model.SystemMetricDefinition{Key: "linux.uptime", Title: "Время работы Linux", Unit: "seconds", Profiles: []string{"linux", "custom"}, Description: "Время с последней загрузки хоста"}, "node_boot_time_seconds", nil, "time() - %s"},
	{model.SystemMetricDefinition{Key: "linux.network_receive", Title: "Получено по интерфейсу Linux", Unit: "bytes", Profiles: []string{"linux", "network", "custom"}, Description: "Накопленный объём принятых данных; интерфейс выбирается условием device"}, "node_network_receive_bytes_total", nil, ""},
	{model.SystemMetricDefinition{Key: "linux.network_transmit", Title: "Отправлено по интерфейсу Linux", Unit: "bytes", Profiles: []string{"linux", "network", "custom"}, Description: "Накопленный объём отправленных данных; интерфейс выбирается условием device"}, "node_network_transmit_bytes_total", nil, ""},
	{model.SystemMetricDefinition{Key: "windows.cpu", Title: "Загрузка CPU Windows", Unit: "%", Profiles: []string{"windows", "custom"}, Description: "Средняя занятость CPU за последние 5 минут"}, "windows_cpu_time_seconds_total", map[string]string{"mode": "idle"}, "100 * (1 - avg without(core,mode) (rate(%s[5m])))"},
	{model.SystemMetricDefinition{Key: "windows.memory", Title: "Доступная память Windows", Unit: "bytes", Profiles: []string{"windows", "custom"}, Description: "Доступная физическая память из windows_exporter"}, "windows_memory_available_bytes", nil, ""},
	{model.SystemMetricDefinition{Key: "sftp.service", Title: "Служба SFTPGo", Unit: "state", Profiles: []string{"sftp"}, Description: "Работает ли служба SFTPGo на выбранном сервере"}, "node_systemd_unit_state", map[string]string{"name": "sftpgo.service", "state": "active"}, ""},
	{model.SystemMetricDefinition{Key: "disk.available", Title: "Свободное место Linux", Unit: "bytes", Profiles: []string{"sftp", "nextcloud", "custom"}, Description: "Выбери сервер и точку монтирования"}, "node_filesystem_avail_bytes", nil, ""},
	{model.SystemMetricDefinition{Key: "disk.inodes", Title: "Свободные inode", Unit: "count", Profiles: []string{"sftp", "nextcloud"}, Description: "Выбери файловую систему"}, "node_filesystem_files_free", nil, ""},
	{model.SystemMetricDefinition{Key: "windows.disk_free", Title: "Свободное место тома", Unit: "bytes", Profiles: []string{"files", "rds", "sql"}, Description: "Сколько места осталось на выбранном томе"}, "windows_logical_disk_free_bytes", nil, ""},
	{model.SystemMetricDefinition{Key: "windows.disk_latency", Title: "Задержка чтения диска", Unit: "seconds", Profiles: []string{"files", "sql"}, Description: "Среднее время чтения за последние 5 минут"}, "windows_logical_disk_read_latency_seconds_total", nil, "rate(%s[5m]) / rate(windows_logical_disk_reads_total%s[5m])"},
	{model.SystemMetricDefinition{Key: "sql.log", Title: "Использование transaction log", Unit: "%", Profiles: []string{"sql"}, Description: "Сколько transaction log занято у выбранных баз"}, "windows_mssql_databases_log_used_percent", nil, ""},
	{model.SystemMetricDefinition{Key: "sql.ple", Title: "Page Life Expectancy", Unit: "seconds", Profiles: []string{"sql"}, Description: "Как долго страницы данных остаются в памяти SQL Server"}, "windows_mssql_bufman_page_life_expectancy_seconds", nil, ""},
	{model.SystemMetricDefinition{Key: "rds.cpu", Title: "CPU серверов RDS", Unit: "%", Profiles: []string{"rds"}, Description: "Занятость CPU за 5 минут"}, "windows_cpu_time_total", map[string]string{"mode": "idle"}, "100 * (1 - avg without(core,mode) (rate(%s[5m])))"},
	{model.SystemMetricDefinition{Key: "rds.memory", Title: "Доступная память RDS", Unit: "bytes", Profiles: []string{"rds"}, Description: "Доступная физическая память"}, "windows_memory_available_bytes", nil, ""},
	{model.SystemMetricDefinition{Key: "rds.sessions", Title: "Сеансы RDS", Unit: "count", Profiles: []string{"rds"}, Description: "Количество сеансов из terminal_services collector"}, "windows_terminal_services_session_info", nil, "count by(instance) (%s == 1)"},
	{model.SystemMetricDefinition{Key: "dsvpn.reachability", Title: "Доступность путей филиалов", Unit: "state", Profiles: []string{"dsvpn"}, Description: "Отвечают ли адреса выбранных филиалов на ICMP-проверку"}, "probe_success", nil, ""},
	{model.SystemMetricDefinition{Key: "dsvpn.tcp", Title: "TCP-проверки филиалов", Unit: "state", Profiles: []string{"dsvpn"}, Description: "Принимают ли адреса филиалов TCP-соединения"}, "probe_success", nil, ""},
	{model.SystemMetricDefinition{Key: "network.latency", Title: "Длительность сетевой проверки", Unit: "seconds", Profiles: []string{"dsvpn"}, Description: "Время выполнения сетевой проверки"}, "probe_duration_seconds", nil, ""},
	{model.SystemMetricDefinition{Key: "application.probe", Title: "Проверка приложения", Unit: "state", Profiles: []string{"mail", "nextcloud", "files", "custom"}, Description: "Результат выбранной проверки приложения"}, "probe_success", nil, ""},
}

func SystemMetricDefinitions() []model.SystemMetricDefinition {
	out := make([]model.SystemMetricDefinition, 0, len(systemMetricSpecs))
	for _, spec := range systemMetricSpecs {
		out = append(out, spec.SystemMetricDefinition)
	}
	return out
}

func SystemProfiles() []model.SystemProfile {
	return []model.SystemProfile{
		{Key: "custom", Title: "Пользовательская система", Description: "Любая группа приложений и инфраструктуры; показатели необязательны", Metrics: []string{}},
		{Key: "linux", Title: "Linux-серверы", Description: "Доступность, процессор, память и диски", Metrics: []string{"target.up", "linux.cpu", "linux.memory", "disk.available"}},
		{Key: "windows", Title: "Windows-серверы", Description: "Доступность, процессор, память и тома", Metrics: []string{"target.up", "windows.cpu", "windows.memory", "windows.disk_free"}},
		{Key: "network", Title: "Сеть и соединения", Description: "Доступность сетевых целей и длительность проверок", Metrics: []string{"target.up", "application.probe", "network.latency"}},
		{Key: "application", Title: "Приложения и веб-сервисы", Description: "Проверки приложения и его источников метрик", Metrics: []string{"application.probe", "target.up"}},
		{Key: "dsvpn", Title: "DSVPN", Description: "Проверки сетевых путей филиалов", Metrics: []string{"dsvpn.reachability", "dsvpn.tcp", "network.latency"}},
		{Key: "files", Title: "Файловые серверы", Description: "Файловая служба, место и I/O", Metrics: []string{"windows.disk_free", "windows.disk_latency"}},
		{Key: "sftp", Title: "SFTP", Description: "Готовность службы, место и inode", Metrics: []string{"sftp.service", "disk.available", "disk.inodes"}},
		{Key: "sql", Title: "SQL", Description: "Состояние SQL Server и его баз", Metrics: []string{"sql.log", "sql.ple"}},
		{Key: "rds", Title: "RDS", Description: "Сеансы, CPU и память фермы", Metrics: []string{"rds.cpu", "rds.memory", "rds.sessions"}},
		{Key: "mail", Title: "Почта", Description: "Подключается после развёртывания", Metrics: []string{"application.probe"}},
		{Key: "nextcloud", Title: "Nextcloud", Description: "Подключается после развёртывания", Metrics: []string{"application.probe", "disk.available"}},
	}
}

func systemMetricSpecFor(key string) (systemMetricSpec, bool) {
	for _, spec := range systemMetricSpecs {
		if spec.Key == key {
			return spec, true
		}
	}
	return systemMetricSpec{}, false
}

var systemLabels = map[string]bool{"instance": true, "job": true, "device": true, "host": true, "service": true, "site": true, "branch": true, "source": true, "inbound": true, "volume": true, "mountpoint": true, "name": true, "database": true, "repository_name": true, "job_name": true, "env": true, "location": true, "check_type": true}

// ValidateSystemMetricDraft accepts incomplete selectors for later configuration.
// The execution validator below still forbids an unscoped query.
func ValidateSystemMetricDraft(binding model.SystemMetricBinding) error {
	spec, ok := systemMetricSpecFor(binding.Metric)
	if !ok || len(binding.Labels) > 12 {
		return ErrBrowseInvalid
	}
	for key, value := range binding.Labels {
		if !systemLabels[key] || len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") {
			return ErrBrowseInvalid
		}
		if fixed, exists := spec.fixed[key]; exists && value != "" && fixed != value {
			return ErrBrowseInvalid
		}
	}
	return nil
}

func ValidateSystemMetric(binding model.SystemMetricBinding) error {
	if err := ValidateSystemMetricDraft(binding); err != nil {
		return err
	}
	// Every deployment selects its own job/target labels. No profile implies a
	// site-specific scrape job or silently queries every observed endpoint.
	if len(binding.Labels) == 0 {
		return ErrBrowseInvalid
	}
	for _, value := range binding.Labels {
		if strings.TrimSpace(value) == "" {
			return ErrBrowseInvalid
		}
	}
	return nil
}

func systemSelector(spec systemMetricSpec, binding model.SystemMetricBinding) string {
	labels := map[string]string{}
	for k, v := range spec.fixed {
		labels[k] = v
	}
	for k, v := range binding.Labels {
		labels[k] = v
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+strconv.Quote(labels[k]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

type systemQueryRow struct {
	Metric map[string]string `json:"metric"`
	Value  []json.RawMessage `json:"value"`
}

// A workspace loads several systems concurrently. Their per-snapshot workers
// must share admission before entering the smaller browse queue. Keep the
// existing transport cap (including non-system browsing) and bound both work
// and waiting; request cancellation includes time spent in this queue.
var systemMetricSlots = make(chan struct{}, 4)
var systemMetricWaiters = make(chan struct{}, 128)

func systemMetricContext(ctx context.Context) (context.Context, func(), error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	select {
	case systemMetricWaiters <- struct{}{}:
	default:
		cancel()
		return nil, nil, ErrBrowseBusy
	}
	select {
	case systemMetricSlots <- struct{}{}:
		<-systemMetricWaiters
		if ctx.Err() != nil {
			<-systemMetricSlots
			cancel()
			return nil, nil, ErrBrowseUnavailable
		}
		return ctx, func() { <-systemMetricSlots; cancel() }, nil
	case <-ctx.Done():
		<-systemMetricWaiters
		cancel()
		return nil, nil, ErrBrowseUnavailable
	}
}

func (r *Registry) systemInstant(ctx context.Context, i model.Integration, query string) ([]systemQueryRow, error) {
	var response struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string           `json:"resultType"`
			Result     []systemQueryRow `json:"result"`
		} `json:"data"`
	}
	if err := r.browseJSON(ctx, i, "GET", "/api/v1/query", url.Values{"query": {query}}, nil, &response); err != nil {
		return nil, err
	}
	if response.Status != "success" || response.Data.ResultType != "vector" {
		return nil, ErrBrowseUnavailable
	}
	if len(response.Data.Result) > 100 {
		return nil, ErrBrowseLimit
	}
	return response.Data.Result, nil
}

func systemSampleValue(row systemQueryRow) (float64, bool) {
	if len(row.Value) != 2 {
		return 0, false
	}
	var value string
	if json.Unmarshal(row.Value[1], &value) != nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(value, 64)
	return v, err == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
}

func (r *Registry) SystemMetric(ctx context.Context, i model.Integration, binding model.SystemMetricBinding, now time.Time) model.SystemMetricResult {
	out := model.SystemMetricResult{ID: binding.ID, ResourceID: binding.ResourceID, Metric: binding.Metric, Title: binding.Title, State: "unconfigured", Source: i.Name, Samples: []model.SystemMetricSample{}}
	spec, ok := systemMetricSpecFor(binding.Metric)
	if !ok {
		out.State = "unsupported"
		return out
	}
	out.Unit = spec.Unit
	if out.Title == "" {
		out.Title = spec.Title
	}
	if !i.Enabled || i.Kind != "prometheus" || r == nil {
		return out
	}
	if err := ValidateSystemMetricDraft(binding); err != nil {
		out.State = "error"
		out.Error = "Проверь источник и условия отбора показателя"
		return out
	}
	if ValidateSystemMetric(binding) != nil {
		return out
	}
	ctx, release, err := systemMetricContext(ctx)
	if err != nil {
		out.State = "error"
		out.Error = BrowseErrorMessage(err)
		return out
	}
	defer release()
	ctx, done, err := browseContext(ctx)
	if err != nil {
		out.State = "error"
		out.Error = BrowseErrorMessage(err)
		return out
	}
	defer done()
	selector := systemSelector(spec, binding)
	base := spec.metric + selector
	query := base
	if spec.expression != "" {
		if strings.Count(spec.expression, "%s") == 2 {
			query = fmt.Sprintf(spec.expression, base, selector)
		} else {
			query = fmt.Sprintf(spec.expression, base)
		}
	}
	rows, err := r.systemInstant(ctx, i, query)
	if err != nil {
		out.State = "error"
		out.Error = BrowseErrorMessage(err)
		return out
	}
	if len(rows) == 0 {
		out.State = "no_data"
		return out
	}
	// One conservative timestamp per binding: every selected raw series must be
	// fresh. Expression evaluation timestamps cannot conceal stale telemetry.
	times, err := r.systemInstant(ctx, i, "min(timestamp("+base+"))")
	if err != nil || len(times) != 1 {
		out.State = "error"
		out.Error = "Не удалось получить время обновления показателя"
		return out
	}
	timestamp, valid := systemSampleValue(times[0])
	if !valid || timestamp <= 0 || timestamp > float64(now.Unix()+30) {
		out.State = "no_data"
		return out
	}
	observed := time.Unix(int64(timestamp), 0).UTC()
	out.State = "fresh"
	if now.Sub(observed) > 3*time.Minute {
		out.State = "stale"
	}
	for _, row := range rows {
		value, valid := systemSampleValue(row)
		if !valid {
			continue
		}
		if spec.Unit == "enum" && value != 1 {
			continue
		}
		out.Samples = append(out.Samples, model.SystemMetricSample{Labels: safeLabels(row.Metric), Value: value, ObservedAt: observed})
	}
	if len(out.Samples) == 0 {
		out.State = "no_data"
	}
	return out
}

func SystemMetricKnown(key string) bool { _, ok := systemMetricSpecFor(key); return ok }
