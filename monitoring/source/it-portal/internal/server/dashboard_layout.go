package server

import (
	"errors"
	"net/http"
	"pl/portal/internal/store"
	"regexp"
)

type dashboardTile struct {
	ID         string `json:"id"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	HeightRows *int   `json:"heightRows,omitempty"`
	Pinned     bool   `json:"pinned"`
}

type dashboardLayoutState struct {
	Revision int64           `json:"revision"`
	Tiles    []dashboardTile `json:"tiles"`
	Hidden   []string        `json:"hidden"`
}

var dashboardTileID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func (s *Server) dashboardLayout(w http.ResponseWriter, r *http.Request) {
	view := r.URL.Query().Get("view")
	if view != "admin" && view != "employee" {
		problem(w, 400, "invalid_view", "Неизвестный вид главной")
		return
	}
	if view == "admin" && !current(r).User.Admin {
		problem(w, 403, "forbidden", "Доступ только для IT-группы")
		return
	}
	id := current(r).User.ID + ":" + view
	if r.Method == http.MethodGet {
		layout, err := store.Get[dashboardLayoutState](r.Context(), s.Store, "dashboard_layout", id)
		if errors.Is(err, store.ErrNotFound) {
			respond(w, 200, dashboardLayoutState{Tiles: []dashboardTile{}, Hidden: []string{}})
			return
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, layout)
		return
	}
	var layout dashboardLayoutState
	if !decode(w, r, &layout) {
		return
	}
	if len(layout.Tiles) > 100 || len(layout.Hidden) > 100 {
		problem(w, 400, "invalid_layout", "Слишком много карточек")
		return
	}
	seen := map[string]bool{}
	for _, tile := range layout.Tiles {
		minWidth, maxWidth := 3, 12
		if view == "employee" {
			minWidth, maxWidth = 2, 8
		}
		if !validDashboardID(view, tile.ID) || seen[tile.ID] || tile.Width < minWidth || tile.Width > maxWidth || tile.Height < 0 || tile.Height > 12 || tile.HeightRows != nil && (*tile.HeightRows < 0 || *tile.HeightRows > 100 || *tile.HeightRows != 0 && *tile.HeightRows < 5) {
			problem(w, 400, "invalid_layout", "Некорректная раскладка")
			return
		}
		seen[tile.ID] = true
	}
	hidden := map[string]bool{}
	for _, item := range layout.Hidden {
		if !validDashboardID(view, item) || hidden[item] {
			problem(w, 400, "invalid_layout", "Некорректный скрытый блок")
			return
		}
		hidden[item] = true
	}
	if layout.Tiles == nil {
		layout.Tiles = []dashboardTile{}
	}
	if layout.Hidden == nil {
		layout.Hidden = []string{}
	}
	out, err := s.Store.Save(r.Context(), "dashboard_layout", id, layout.Revision, layout, current(r).User.ID)
	if err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, out)
}

func validDashboardID(view, id string) bool {
	if view == "employee" {
		return dashboardTileID.MatchString(id)
	}
	switch id {
	case "favorites", "problems", "directions", "reports", "events", "tools", "integrations", "wayline", "grafana", "systems":
		return true
	}
	return validWorkspaceGroupTile(id)
}
