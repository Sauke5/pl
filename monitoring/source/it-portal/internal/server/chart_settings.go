package server

import (
	"errors"
	"net/http"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
	"regexp"
)

var chartIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

func (s *Server) chartSettings(w http.ResponseWriter, r *http.Request) {
	id := current(r).User.ID
	if r.Method == "GET" {
		state, e := store.Get[model.ChartSettings](r.Context(), s.Store, "chart_settings", id)
		if errors.Is(e, store.ErrNotFound) {
			respond(w, 200, model.ChartSettings{Charts: []model.ChartSelection{}})
			return
		}
		if e != nil {
			s.fail(w, e)
			return
		}
		respond(w, 200, state)
		return
	}
	var input struct {
		Revision *int64                  `json:"revision"`
		Charts   *[]model.ChartSelection `json:"charts"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Revision == nil || *input.Revision < 0 || input.Charts == nil || len(*input.Charts) > 6 {
		problem(w, 400, "invalid_charts", "Укажите текущую версию и не больше шести графиков")
		return
	}
	seen := map[string]bool{}
	for _, chart := range *input.Charts {
		if !chartIdentifier.MatchString(chart.ID) || !chartIdentifier.MatchString(chart.DashboardUID) || chart.PanelID < 1 || chart.PanelID > 1000000 || seen[chart.ID] || !store.Contains([]string{"1h", "6h", "24h", "7d"}, chart.Range) {
			problem(w, 400, "invalid_chart", "Проверьте выбранную панель и период")
			return
		}
		seen[chart.ID] = true
		integration, e := store.Get[model.Integration](r.Context(), s.Store, "integration", chart.IntegrationID)
		if e != nil {
			s.fail(w, e)
			return
		}
		if integration.Kind != "grafana" {
			problem(w, 400, "invalid_chart", "Выберите подключение Grafana")
			return
		}
	}
	state := model.ChartSettings{Revision: *input.Revision, Charts: *input.Charts}
	result, e := s.Store.Save(r.Context(), "chart_settings", id, state.Revision, state, id)
	if e != nil {
		s.fail(w, e)
		return
	}
	respond(w, 200, result)
}
