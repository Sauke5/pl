package server

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

type Hub struct {
	mu      sync.Mutex
	clients map[chan string]struct{}
}

func NewHub() *Hub { return &Hub{clients: map[chan string]struct{}{}} }
func (h *Hub) Notify(topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- topic:
		default:
		}
	}
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		problem(w, 500, "stream_unavailable", "SSE недоступен")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-cache")
	ch := make(chan string, 1)
	s.Hub.mu.Lock()
	s.Hub.clients[ch] = struct{}{}
	s.Hub.mu.Unlock()
	defer func() { s.Hub.mu.Lock(); delete(s.Hub.clients, ch); s.Hub.mu.Unlock() }()
	_, _ = fmt.Fprint(w, "event: change\ndata: {\"topic\":\"all\"}\n\n")
	f.Flush()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			if _, e := s.readSession(r); e != nil {
				_, _ = fmt.Fprint(w, "event: session_expired\ndata: {}\n\n")
				f.Flush()
				return
			}
			_, _ = fmt.Fprint(w, ": heartbeat\n\n")
			f.Flush()
		case topic := <-ch:
			_, _ = fmt.Fprintf(w, "event: change\ndata: {\"topic\":%q}\n\n", topic)
			f.Flush()
		}
	}
}
