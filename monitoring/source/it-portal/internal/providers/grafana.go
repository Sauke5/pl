package providers

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"pl/portal/internal/model"
)

type DashboardOption struct {
	UID   string `json:"uid"`
	Title string `json:"title"`
}
type DashboardOptions struct {
	Dashboards []DashboardOption `json:"dashboards"`
	Truncated  bool              `json:"truncated"`
	ObservedAt time.Time         `json:"observed_at"`
}
type PanelOption struct {
	ID        int    `json:"id"`
	Title     string `json:"title"`
	Type      string `json:"type"`
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	Unit      string `json:"unit,omitempty"`
}
type PanelOptions struct {
	DashboardUID string        `json:"dashboard_uid"`
	Title        string        `json:"title"`
	Panels       []PanelOption `json:"panels"`
	ObservedAt   time.Time     `json:"observed_at"`
}
type GrafanaQuery struct {
	DashboardUID string    `json:"dashboard_uid"`
	PanelID      int       `json:"panel_id"`
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
}
type ChartSeries struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
	Unit   string            `json:"unit,omitempty"`
	Points [][2]*float64     `json:"points"`
}
type ChartResult struct {
	DashboardUID string        `json:"dashboard_uid"`
	PanelID      int           `json:"panel_id"`
	Title        string        `json:"title"`
	Unit         string        `json:"unit,omitempty"`
	From         time.Time     `json:"from"`
	To           time.Time     `json:"to"`
	Series       []ChartSeries `json:"series"`
	ObservedAt   time.Time     `json:"observed_at"`
}

type grafanaDatasource struct {
	UID      string `json:"uid"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Default  bool   `json:"isDefault"`
	JSONData struct {
		Interval string `json:"timeInterval"`
	} `json:"jsonData"`
}
type grafanaVariable struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Multi      bool   `json:"multi"`
	IncludeAll bool   `json:"includeAll"`
	AllValue   string `json:"allValue"`
	Current    struct {
		Value any `json:"value"`
	} `json:"current"`
	Filters []json.RawMessage `json:"filters"`
}
type grafanaTarget struct {
	RefID      string          `json:"refId"`
	Expr       string          `json:"expr"`
	Datasource json.RawMessage `json:"datasource"`
	Hide       bool            `json:"hide"`
	Instant    bool            `json:"instant"`
	Range      bool            `json:"range"`
	Legend     string          `json:"legendFormat"`
	Interval   string          `json:"interval"`
}
type grafanaPanel struct {
	ID              int               `json:"id"`
	Title           string            `json:"title"`
	Type            string            `json:"type"`
	Datasource      json.RawMessage   `json:"datasource"`
	Targets         []grafanaTarget   `json:"targets"`
	Panels          []grafanaPanel    `json:"panels"`
	Transformations []json.RawMessage `json:"transformations"`
	Repeat          string            `json:"repeat"`
	TimeFrom        string            `json:"timeFrom"`
	TimeShift       string            `json:"timeShift"`
	Interval        string            `json:"interval"`
	LibraryPanel    json.RawMessage   `json:"libraryPanel"`
	FieldConfig     struct {
		Defaults struct {
			Unit string `json:"unit"`
		} `json:"defaults"`
		Overrides []json.RawMessage `json:"overrides"`
	} `json:"fieldConfig"`
}
type grafanaDashboard struct {
	UID        string         `json:"uid"`
	Title      string         `json:"title"`
	Panels     []grafanaPanel `json:"panels"`
	Templating struct {
		List []grafanaVariable `json:"list"`
	} `json:"templating"`
}

func (r *Registry) GrafanaDashboards(ctx context.Context, i model.Integration) (DashboardOptions, error) {
	out := DashboardOptions{Dashboards: []DashboardOption{}}
	if !i.Enabled || i.Kind != "grafana" {
		return out, ErrBrowseInvalid
	}
	ctx, done, e := browseContext(ctx)
	if e != nil {
		return out, e
	}
	defer done()
	var list []struct {
		UID   string `json:"uid"`
		Title string `json:"title"`
		Type  string `json:"type"`
	}
	if e = r.browseJSON(ctx, i, "GET", "/api/search", url.Values{"type": {"dash-db"}, "limit": {"201"}}, nil, &list); e != nil {
		return out, e
	}
	if list == nil {
		return out, ErrBrowseUnavailable
	}
	for _, d := range list {
		if d.Type == "dash-db" && providerUID.MatchString(d.UID) {
			out.Dashboards = append(out.Dashboards, DashboardOption{d.UID, boundedText(d.Title, 256)})
		}
	}
	if len(out.Dashboards) > 200 {
		out.Truncated = true
		out.Dashboards = out.Dashboards[:200]
	}
	out.ObservedAt = time.Now().UTC()
	return out, nil
}
func (r *Registry) grafanaDefinition(ctx context.Context, i model.Integration, uid string) (grafanaDashboard, []grafanaDatasource, error) {
	var v struct {
		Dashboard *grafanaDashboard `json:"dashboard"`
	}
	if e := r.browseJSON(ctx, i, "GET", "/api/dashboards/uid/"+uid, nil, nil, &v); e != nil {
		return grafanaDashboard{}, nil, e
	}
	if v.Dashboard == nil || v.Dashboard.UID != uid {
		return grafanaDashboard{}, nil, ErrBrowseUnavailable
	}
	var ds []grafanaDatasource
	if e := r.browseJSON(ctx, i, "GET", "/api/datasources", nil, nil, &ds); e != nil {
		return grafanaDashboard{}, nil, e
	}
	if len(ds) > 200 {
		return grafanaDashboard{}, nil, ErrBrowseLimit
	}
	return *v.Dashboard, ds, nil
}
func flattenPanels(panels []grafanaPanel) ([]grafanaPanel, error) {
	out := []grafanaPanel{}
	seen := map[int]bool{}
	var visit func([]grafanaPanel, int) error
	visit = func(ps []grafanaPanel, depth int) error {
		if depth > 8 {
			return ErrBrowseLimit
		}
		for _, p := range ps {
			if p.Type == "row" {
				if e := visit(p.Panels, depth+1); e != nil {
					return e
				}
				continue
			}
			if p.ID <= 0 || seen[p.ID] {
				return ErrBrowseUnavailable
			}
			seen[p.ID] = true
			out = append(out, p)
			if len(out) > 300 {
				return ErrBrowseLimit
			}
		}
		return nil
	}
	e := visit(panels, 0)
	return out, e
}
func (r *Registry) GrafanaPanels(ctx context.Context, i model.Integration, uid string) (PanelOptions, error) {
	out := PanelOptions{DashboardUID: uid, Panels: []PanelOption{}}
	if !i.Enabled || i.Kind != "grafana" || !providerUID.MatchString(uid) {
		return out, ErrBrowseInvalid
	}
	ctx, done, e := browseContext(ctx)
	if e != nil {
		return out, e
	}
	defer done()
	board, ds, e := r.grafanaDefinition(ctx, i, uid)
	if e != nil {
		return out, e
	}
	panels, e := flattenPanels(board.Panels)
	if e != nil {
		return out, e
	}
	now := time.Now().UTC()
	q := GrafanaQuery{DashboardUID: uid, From: now.Add(-time.Hour), To: now}
	for _, p := range panels {
		_, reason := panelQueries(board, p, ds, q)
		out.Panels = append(out.Panels, PanelOption{p.ID, boundedText(p.Title, 256), boundedText(p.Type, 64), reason == "", reason, boundedText(p.FieldConfig.Defaults.Unit, 64)})
	}
	out.Title = boundedText(board.Title, 256)
	out.ObservedAt = now
	return out, nil
}
func (r *Registry) GrafanaQuery(ctx context.Context, i model.Integration, q GrafanaQuery) (ChartResult, error) {
	out := ChartResult{DashboardUID: q.DashboardUID, PanelID: q.PanelID, From: q.From, To: q.To, Series: []ChartSeries{}}
	now := time.Now().UTC()
	if !i.Enabled || i.Kind != "grafana" || !providerUID.MatchString(q.DashboardUID) || q.PanelID <= 0 || q.From.IsZero() || q.To.IsZero() || !q.To.After(q.From) || q.To.Sub(q.From) > 7*24*time.Hour || q.To.After(now.Add(time.Minute)) || q.From.Before(now.Add(-366*24*time.Hour)) {
		return out, ErrBrowseInvalid
	}
	ctx, done, e := browseContext(ctx)
	if e != nil {
		return out, e
	}
	defer done()
	board, ds, e := r.grafanaDefinition(ctx, i, q.DashboardUID)
	if e != nil {
		return out, e
	}
	panels, e := flattenPanels(board.Panels)
	if e != nil {
		return out, e
	}
	var selected *grafanaPanel
	for n := range panels {
		if panels[n].ID == q.PanelID {
			selected = &panels[n]
			break
		}
	}
	if selected == nil {
		return out, ErrBrowseInvalid
	}
	queries, reason := panelQueries(board, *selected, ds, q)
	if reason != "" {
		return out, ErrPanelUnsupported
	}
	var response grafanaFrames
	payload := map[string]any{"queries": queries, "from": strconv.FormatInt(q.From.UnixMilli(), 10), "to": strconv.FormatInt(q.To.UnixMilli(), 10)}
	if e = r.browseJSON(ctx, i, "POST", "/api/ds/query", nil, payload, &response); e != nil {
		return out, e
	}
	refs := []string{}
	for _, v := range queries {
		refs = append(refs, v["refId"].(string))
	}
	out.Series, e = chartFrames(response, refs, q)
	if e != nil {
		return out, e
	}
	out.Title = boundedText(selected.Title, 256)
	out.Unit = boundedText(selected.FieldConfig.Defaults.Unit, 64)
	out.ObservedAt = time.Now().UTC()
	return out, nil
}

var grafanaVariableRE = regexp.MustCompile(`\$(?:\{([A-Za-z_][A-Za-z_0-9]*)(?::([A-Za-z_][A-Za-z_0-9]*))?\}|([A-Za-z_][A-Za-z_0-9]*))`)

func panelQueries(board grafanaDashboard, p grafanaPanel, sources []grafanaDatasource, q GrafanaQuery) ([]map[string]any, string) {
	if p.Type != "timeseries" && p.Type != "graph" {
		return nil, "Поддерживаются только временные графики Prometheus."
	}
	if len(p.Transformations) > 0 || p.Repeat != "" || p.TimeFrom != "" || p.TimeShift != "" || (len(p.LibraryPanel) > 0 && string(p.LibraryPanel) != "null") {
		return nil, "Панель использует преобразования, повторение или собственный период."
	}
	// Field overrides can carry math/display transforms which this renderer does not reproduce.
	for _, raw := range p.FieldConfig.Overrides {
		var override struct {
			Properties []struct {
				ID string `json:"id"`
			} `json:"properties"`
		}
		if json.Unmarshal(raw, &override) != nil {
			return nil, "Некорректные настройки панели."
		}
		for _, v := range override.Properties {
			if v.ID == "unit" || v.ID == "custom.transform" {
				return nil, "Панель использует индивидуальные единицы или преобразование ряда."
			}
		}
	}
	vars := map[string]grafanaVariable{}
	for _, v := range board.Templating.List {
		if v.Type == "adhoc" && len(v.Filters) > 0 {
			return nil, "Панель использует дополнительные фильтры Grafana."
		}
		vars[v.Name] = v
	}
	queries := []map[string]any{}
	refs := map[string]bool{}
	interval := time.Duration(math.Ceil(q.To.Sub(q.From).Seconds()/999)) * time.Second
	if interval < 15*time.Second {
		interval = 15 * time.Second
	}
	for _, t := range p.Targets {
		if t.Hide {
			continue
		}
		if len(queries) >= 6 || t.Expr == "" || len(t.Expr) > 16000 || !providerUID.MatchString(t.RefID) || refs[t.RefID] || (t.Instant && !t.Range) {
			return nil, "Панель содержит неподдерживаемые или слишком многочисленные запросы."
		}
		rawDS := t.Datasource
		if len(rawDS) == 0 || string(rawDS) == "null" {
			rawDS = p.Datasource
		}
		ds, ok := resolveDatasource(rawDS, vars, sources)
		if !ok {
			return nil, "Источник Prometheus панели не определён."
		}
		scrape := 15 * time.Second
		if v, e := time.ParseDuration(ds.JSONData.Interval); e == nil && v > 0 && v <= time.Hour {
			scrape = v
		}
		step := interval
		for _, minimum := range []string{p.Interval, t.Interval} {
			if minimum == "" {
				continue
			}
			expanded, ok := expandGrafana(minimum, vars, map[string]string{"__interval": durationProm(interval)})
			if !ok {
				return nil, "Переменная интервала панели не задана."
			}
			v, e := time.ParseDuration(strings.TrimPrefix(expanded, ">"))
			if e != nil || v <= 0 || v > 24*time.Hour {
				return nil, "Интервал панели не поддерживается."
			}
			if v > step {
				step = v
			}
		}
		rate := step + scrape
		if rate < 4*scrape {
			rate = 4 * scrape
		}
		builtins := map[string]string{"__interval": durationProm(step), "__interval_ms": strconv.FormatInt(step.Milliseconds(), 10), "__rate_interval": durationProm(rate), "__range": durationProm(q.To.Sub(q.From)), "__range_s": strconv.FormatInt(int64(q.To.Sub(q.From).Seconds()), 10), "__range_ms": strconv.FormatInt(q.To.Sub(q.From).Milliseconds(), 10), "__from": strconv.FormatInt(q.From.UnixMilli(), 10), "__to": strconv.FormatInt(q.To.UnixMilli(), 10)}
		expr, ok := expandGrafana(t.Expr, vars, builtins)
		if !ok {
			return nil, "Задайте и сохраните значения переменных дашборда в Grafana."
		}
		refs[t.RefID] = true
		queries = append(queries, map[string]any{"refId": t.RefID, "expr": expr, "datasource": map[string]string{"uid": ds.UID, "type": "prometheus"}, "format": "time_series", "instant": false, "range": true, "maxDataPoints": 1000, "intervalMs": step.Milliseconds(), "legendFormat": boundedText(t.Legend, 256)})
	}
	if len(queries) == 0 {
		return nil, "У панели нет доступных запросов."
	}
	return queries, ""
}
func resolveDatasource(raw json.RawMessage, vars map[string]grafanaVariable, sources []grafanaDatasource) (grafanaDatasource, bool) {
	name, kind := "", ""
	if len(raw) > 0 && string(raw) != "null" {
		if json.Unmarshal(raw, &name) != nil {
			var v struct {
				UID  string `json:"uid"`
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &v) != nil {
				return grafanaDatasource{}, false
			}
			name, kind = v.UID, v.Type
		}
	}
	if kind != "" && kind != "prometheus" {
		return grafanaDatasource{}, false
	}
	if strings.HasPrefix(name, "$") {
		m := grafanaVariableRE.FindStringSubmatch(name)
		if m == nil || m[0] != name {
			return grafanaDatasource{}, false
		}
		key := m[1]
		if key == "" {
			key = m[3]
		}
		v, ok := vars[key]
		if !ok || v.Type != "datasource" {
			return grafanaDatasource{}, false
		}
		if v.Current.Value == nil {
			name = ""
		} else {
			var yes bool
			name, yes = v.Current.Value.(string)
			if !yes {
				return grafanaDatasource{}, false
			}
		}
	}
	for _, ds := range sources {
		if ds.Type == "prometheus" && providerUID.MatchString(ds.UID) && ((name == "" && ds.Default) || ds.UID == name || ds.Name == name) {
			return ds, true
		}
	}
	return grafanaDatasource{}, false
}
func expandGrafana(input string, vars map[string]grafanaVariable, builtins map[string]string) (string, bool) {
	valid := true
	out := grafanaVariableRE.ReplaceAllStringFunc(input, func(token string) string {
		m := grafanaVariableRE.FindStringSubmatch(token)
		key, mode := m[1], m[2]
		if key == "" {
			key = m[3]
		}
		if value, ok := builtins[key]; ok {
			if mode != "" {
				valid = false
			}
			return value
		}
		v, ok := vars[key]
		if !ok || v.Type == "datasource" || (mode != "" && mode != "regex") {
			valid = false
			return ""
		}
		values := []string{}
		switch value := v.Current.Value.(type) {
		case string:
			values = append(values, value)
		case []any:
			for _, item := range value {
				s, ok := item.(string)
				if !ok {
					valid = false
					continue
				}
				values = append(values, s)
			}
		default:
			valid = false
		}
		if len(values) == 0 || len(values) > 100 {
			valid = false
			return ""
		}
		for _, value := range values {
			if value == "$__all" {
				if !v.IncludeAll || v.AllValue == "" || len(v.AllValue) > 512 {
					valid = false
					return ""
				}
				if _, e := regexp.Compile(v.AllValue); e != nil {
					valid = false
				}
				return promQuotedContent(v.AllValue)
			}
		}
		regex := mode == "regex" || v.Multi || v.IncludeAll
		for n, value := range values {
			if value == "" || len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") {
				valid = false
			}
			if regex {
				value = regexp.QuoteMeta(value)
			}
			values[n] = value
		}
		value := strings.Join(values, "|")
		if len(values) > 1 {
			if !regex {
				valid = false
			}
			value = "(" + value + ")"
		}
		return promQuotedContent(value)
	})
	return out, valid
}
func promQuotedContent(s string) string { quoted := strconv.Quote(s); return quoted[1 : len(quoted)-1] }
func durationProm(d time.Duration) string {
	seconds := int64(math.Ceil(d.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10) + "s"
}
func boundedText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

type grafanaFrames struct {
	Results map[string]struct {
		Status int    `json:"status"`
		Error  string `json:"error"`
		Frames []struct {
			Schema struct {
				Name   string `json:"name"`
				Fields []struct {
					Name   string            `json:"name"`
					Type   string            `json:"type"`
					Labels map[string]string `json:"labels"`
					Config struct {
						DisplayName string `json:"displayNameFromDS"`
						Unit        string `json:"unit"`
					} `json:"config"`
				} `json:"fields"`
			} `json:"schema"`
			Data struct {
				Values [][]*float64 `json:"values"`
			} `json:"data"`
		} `json:"frames"`
	} `json:"results"`
}

func chartFrames(response grafanaFrames, refs []string, q GrafanaQuery) ([]ChartSeries, error) {
	out := []ChartSeries{}
	for _, ref := range refs {
		result, ok := response.Results[ref]
		if !ok || result.Error != "" || (result.Status != 0 && result.Status != 200) {
			return nil, ErrBrowseUnavailable
		}
		for _, frame := range result.Frames {
			fields, values := frame.Schema.Fields, frame.Data.Values
			if len(fields) != len(values) {
				return nil, ErrBrowseUnavailable
			}
			timeIndex := -1
			for n, f := range fields {
				if f.Type == "time" {
					if timeIndex != -1 {
						return nil, ErrPanelUnsupported
					}
					timeIndex = n
				} else if f.Type != "number" {
					return nil, ErrPanelUnsupported
				}
			}
			if timeIndex < 0 {
				return nil, ErrPanelUnsupported
			}
			times := values[timeIndex]
			if len(times) > 1000 {
				return nil, ErrBrowseLimit
			}
			for n, f := range fields {
				if n == timeIndex {
					continue
				}
				if len(out) >= 60 {
					return nil, ErrBrowseLimit
				}
				if len(values[n]) != len(times) {
					return nil, ErrBrowseUnavailable
				}
				labels := safeLabels(f.Labels)
				if len(labels) > 64 {
					return nil, ErrBrowseLimit
				}
				for key, value := range labels {
					if len(key) > 128 || len(value) > 512 {
						return nil, ErrBrowseLimit
					}
				}
				name := f.Config.DisplayName
				if len(labels) != len(f.Labels) {
					name = ref
				}
				if name == "" {
					name = frame.Schema.Name
				}
				if name == "" {
					name = f.Name
				}
				if name == "" {
					name = ref
				}
				series := ChartSeries{Name: boundedText(name, 256), Labels: labels, Unit: boundedText(f.Config.Unit, 64), Points: [][2]*float64{}}
				previous := float64(0)
				for k, timestamp := range times {
					if timestamp == nil || math.IsNaN(*timestamp) || math.IsInf(*timestamp, 0) || *timestamp < previous {
						return nil, ErrBrowseUnavailable
					}
					previous = *timestamp
					if *timestamp < float64(q.From.UnixMilli())-1000 || *timestamp > float64(q.To.UnixMilli())+1000 {
						continue
					}
					value := values[n][k]
					if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0)) {
						value = nil
					}
					series.Points = append(series.Points, [2]*float64{timestamp, value})
				}
				out = append(out, series)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Keep diagnostics from remote plugins out of API errors.
func BrowseErrorMessage(err error) string {
	switch err {
	case ErrBrowseAuth:
		return "Источник требует действующий токен с правами чтения дашбордов и данных."
	case ErrBrowseInvalid:
		return "Проверьте источник, панель и период (не более 7 дней)."
	case ErrBrowseLimit:
		return "Ответ источника превышает лимит графика. Выберите более узкую панель или период."
	case ErrBrowseBusy:
		return "Все слоты запросов заняты. Повторите через несколько секунд."
	case ErrPanelUnsupported:
		return "Эта панель пока не поддерживается. Проверьте её тип, переменные и преобразования в Grafana."
	default:
		return "Не удалось получить данные источника. Проверьте доступность и настройки подключения."
	}
}
