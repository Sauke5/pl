package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var f12Digest = regexp.MustCompile(`^[0-9a-f]{64}$`)

// All simultaneous browser chunks together occupy at most 16 MiB before forwarding.
var f12Writers = make(chan struct{}, 4)

type f12Image struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Size          int64    `json:"size"`
	Segments      []string `json:"segments"`
	Recipe        string   `json:"recipe"`
	Filesystem    string   `json:"filesystem"`
	Compatibility string   `json:"compatibility"`
	Existing      bool     `json:"existing,omitempty"`
}

type f12Library struct {
	Items    []f12Image        `json:"items"`
	Segments map[string]string `json:"segments"`
	BootURLs map[string]string `json:"boot_urls"`
	PXE      map[string]string `json:"pxe,omitempty"`
	Pending  *struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Size   int64  `json:"size"`
		Offset int64  `json:"offset"`
		State  string `json:"state"`
	} `json:"pending,omitempty"`
}

func (library *f12Library) projectPXE() {
	if library.PXE == nil {
		return
	}
	statuses := make(map[string]string, len(library.Segments))
	for id := range library.Segments {
		switch state := library.PXE[id]; state {
		case "idle", "waiting", "active", "error", "manual":
			statuses[id] = state
		default:
			statuses[id] = "error"
		}
	}
	library.PXE = statuses
}

func (s *Server) registerF12Routes(m *http.ServeMux) {
	const base = "/api/v1/modules/{id}/f12/"
	m.HandleFunc("GET "+base+"library", s.moduleAuth(s.f12Action("library")))
	m.HandleFunc("GET "+base+"menu", s.moduleAuth(s.f12Action("menu")))
	m.HandleFunc("PUT "+base+"images/{image}/networks", s.moduleAuth(s.f12Action("publish")))
	m.HandleFunc("PUT "+base+"uploads/{upload}", s.moduleAuth(s.f12Action("upload-start")))
	m.HandleFunc("PUT "+base+"uploads/{upload}/chunks/{offset}", s.moduleAuth(s.f12Chunk))
	m.HandleFunc("POST "+base+"uploads/{upload}/complete", s.moduleAuth(s.f12Action("upload-finish")))
	m.HandleFunc("DELETE "+base+"uploads/{upload}", s.moduleAuth(s.f12Action("upload-cancel")))
}

func f12Segments(ids []string) bool {
	if ids == nil || len(ids) > 128 {
		return false
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !f12Digest.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (s *Server) f12Action(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if action != "menu" && r.URL.RawQuery != "" {
			problem(w, 400, "invalid_f12_query", "Лишние параметры запроса F12")
			return
		}
		upload := r.PathValue("upload")
		if strings.HasPrefix(action, "upload-") && !canonicalUUID(upload) {
			problem(w, 400, "invalid_f12_upload", "Некорректный идентификатор загрузки ISO")
			return
		}
		payload := map[string]any{}
		switch action {
		case "menu":
			q, err := url.ParseQuery(r.URL.RawQuery)
			if err != nil || len(q) != 1 || len(q["segment"]) != 1 || !f12Digest.MatchString(q.Get("segment")) {
				problem(w, 400, "invalid_f12_segment", "Выберите сеть для просмотра меню")
				return
			}
			payload["segment"] = q.Get("segment")
		case "publish", "upload-start":
			var segments []string
			if action == "publish" {
				var v struct {
					Segments []string `json:"segments"`
				}
				if !decode(w, r, &v) {
					return
				}
				if !f12Digest.MatchString(r.PathValue("image")) {
					problem(w, 400, "invalid_f12_image", "Некорректный идентификатор образа")
					return
				}
				payload["id"], segments = r.PathValue("image"), v.Segments
			} else {
				var v struct {
					Name     string   `json:"name"`
					Size     int64    `json:"size"`
					Segments []string `json:"segments"`
				}
				if !decode(w, r, &v) {
					return
				}
				if v.Size < 1 || v.Size > modules.F12ImageLimit || !utf8.ValidString(v.Name) || strings.TrimSpace(v.Name) != v.Name || len(v.Name) <= 4 || len(v.Name) > 240 || strings.ContainsAny(v.Name, "/\\") || strings.ContainsFunc(v.Name, unicode.IsControl) || !strings.HasSuffix(strings.ToLower(v.Name), ".iso") {
					problem(w, 400, "invalid_f12_file", "Выберите файл .iso размером до 32 ГиБ")
					return
				}
				payload["id"], payload["name"], payload["size"], segments = upload, v.Name, v.Size, v.Segments
			}
			if !f12Segments(segments) {
				problem(w, 400, "invalid_f12_networks", "Укажите список сетей публикации")
				return
			}
			payload["segments"] = segments
		case "upload-finish", "upload-cancel":
			if r.ContentLength != 0 {
				var empty struct{}
				if !decode(w, r, &empty) {
					return
				}
			}
			payload["id"] = upload
		}
		s.f12Reply(w, r, action, payload, nil)
	}
}

func (s *Server) f12Chunk(w http.ResponseWriter, r *http.Request) {
	offset, err := strconv.ParseInt(r.PathValue("offset"), 10, 64)
	if r.URL.RawQuery != "" || !canonicalUUID(r.PathValue("upload")) || err != nil || offset < 0 || strconv.FormatInt(offset, 10) != r.PathValue("offset") || offset >= modules.F12ImageLimit {
		problem(w, 400, "invalid_f12_offset", "Некорректный адрес части файла")
		return
	}
	if r.Header.Get("Content-Type") != "application/octet-stream" || r.Header.Get("Content-Encoding") != "" {
		problem(w, 415, "invalid_f12_data", "Ожидается часть исходного ISO")
		return
	}
	if r.ContentLength < 1 || r.ContentLength > modules.F12ChunkLimit || offset+r.ContentLength > modules.F12ImageLimit {
		problem(w, 413, "invalid_f12_length", "Размер части файла должен быть от 1 байта до 4 МиБ")
		return
	}
	select {
	case f12Writers <- struct{}{}:
		defer func() { <-f12Writers }()
	default:
		w.Header().Set("Retry-After", "1")
		problem(w, 429, "f12_busy", "Идёт передача данных. Повторите отправку части файла.")
		return
	}
	chunk := make([]byte, int(r.ContentLength))
	if _, err := io.ReadFull(r.Body, chunk); err != nil {
		problem(w, 400, "incomplete_f12_chunk", "Часть файла получена не полностью")
		return
	}
	s.f12Reply(w, r, "upload-chunk", map[string]any{"id": r.PathValue("upload"), "offset": offset}, chunk)
}

func (s *Server) f12Reply(w http.ResponseWriter, r *http.Request, action string, payload map[string]any, chunk []byte) {
	w.Header().Set("Cache-Control", "no-store")
	cookie, err := r.Cookie("portal_session")
	if err != nil {
		problem(w, 401, "authentication_required", "Войдите в PL")
		return
	}
	id := r.PathValue("id")
	reply, err := s.Modules.F12Request(r.Context(), id, hash(cookie.Value), current(r).User.ID, action, payload, chunk)
	if err != nil {
		problem(w, 503, "f12_unavailable", "Библиотека F12 недоступна. Проверьте состояние модуля.")
		return
	}
	if reply.Status >= 400 {
		var failure struct{ Error string }
		if json.Unmarshal(reply.Body, &failure) != nil || failure.Error == "" || len(failure.Error) > 1024 {
			failure.Error = "Сервис F12 не смог выполнить запрос"
		}
		problem(w, reply.Status, "f12_request_failed", failure.Error)
		return
	}
	var result any
	switch {
	case action == "library":
		result = &f12Library{}
	case action == "menu":
		result = &struct {
			Segment string `json:"segment"`
			Items   []struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Recipe string `json:"recipe"`
			} `json:"items"`
		}{}
	case action == "publish" || action == "upload-finish" && reply.Status != 202:
		result = &f12Image{}
	default:
		result = &struct {
			ID     string `json:"id"`
			Offset int64  `json:"offset"`
			Status string `json:"status,omitempty"`
		}{}
	}
	if json.Unmarshal(reply.Body, result) != nil {
		problem(w, 503, "f12_invalid_response", "Сервис F12 вернул некорректный ответ")
		return
	}
	if library, ok := result.(*f12Library); ok {
		library.projectPXE()
	}
	if image, ok := result.(*f12Image); ok {
		if !f12Digest.MatchString(image.ID) || image.Name == "" {
			problem(w, 503, "f12_invalid_image", "Сервис F12 не вернул сведения об образе")
			return
		}
		details := map[string]any{"image": image.ID, "segments": image.Segments}
		user := current(r).User.ID
		if action == "publish" {
			err = s.Store.Event(r.Context(), "f12.publish", "Изменены сети публикации образа", id, user, details, true)
		} else {
			title := "Добавлен загрузочный образ"
			if image.Existing {
				title = "Повторно загружен образ"
			}
			eventID := store.SourceID("f12-upload-"+id, r.PathValue("upload"))
			err = s.Store.AuditOnce(r.Context(), eventID, "f12.upload", title, id, user, details)
		}
		if err != nil {
			s.fail(w, err)
			return
		}
	}
	respond(w, reply.Status, result)
}
