package server

import (
	"net/http"
	"time"
)

func serverTime(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	respond(w, http.StatusOK, map[string]string{"server_time": time.Now().UTC().Format(time.RFC3339Nano)})
}
