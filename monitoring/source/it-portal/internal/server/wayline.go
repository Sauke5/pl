package server

import (
	"context"
	"net/http"
	"pl/portal/internal/model"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
	"sync"
	"time"
)

func (s *Server) wayline(w http.ResponseWriter, r *http.Request) {
	integrations, err := store.List[model.Integration](r.Context(), s.Store, "integration")
	if err != nil {
		s.fail(w, err)
		return
	}
	sources := []providers.WaylineSource{}
	selected := []model.Integration{}
	for _, i := range integrations {
		if i.Kind == "wayline" {
			selected = append(selected, i)
		}
	}
	sources = make([]providers.WaylineSource, len(selected))
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for n, i := range selected {
		wg.Add(1)
		go func(n int, i model.Integration) {
			defer wg.Done()
			item := providers.WaylineSource{IntegrationID: i.ID, Name: i.Name, URL: i.URL, Status: "disabled", Targets: []providers.WaylineTarget{}}
			if i.Config["public_url"] != "" {
				item.URL = i.Config["public_url"]
			}
			defer func() { sources[n] = item }()
			if !i.Enabled {
				return
			}
			item.Status = "error"
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				item.Error = "Источник Wayline не ответил вовремя"
				return
			}
			targets, e := s.Providers.Wayline(ctx, i)
			if e != nil {
				item.Error = "Не удалось получить данные Wayline. Проверьте доступность и настройки источника."
				return
			}
			item.Status = "ok"
			item.FetchedAt = time.Now().UTC()
			item.Targets = targets
		}(n, i)
	}
	wg.Wait()
	respond(w, http.StatusOK, map[string]any{"sources": sources})
}
