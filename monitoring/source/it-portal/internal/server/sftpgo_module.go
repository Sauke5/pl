package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var sftpGoUploadSlots = make(chan struct{}, 2)
var sftpGoSpoolAdmission struct {
	sync.Mutex
	reserved uint64
}

func (s *Server) sftpgoTransferLifetime(ctx context.Context, id string) (context.Context, error) {
	s.applications.Lock()
	defer s.applications.Unlock()
	instance, err := store.Get[model.ModuleInstance](ctx, s.Store, "module_instance", id)
	if err != nil || instance.ModuleID != "sftpgo" || instance.Mode != "local" || instance.DesiredState != "enabled" {
		return nil, modules.ErrApplicationUnavailable
	}
	if s.applications.handlers == nil {
		s.applications.handlers = map[string]*managedApplicationHandler{}
	}
	key := id + "/sftpgo-transfer"
	if s.applications.handlers[key] == nil {
		s.applications.handlers[key] = newManagedApplicationHandler(http.NotFoundHandler())
	}
	return s.applications.handlers[key].lifetime, nil
}

func (s *Server) registerSFTPGoModuleRoutes(m *http.ServeMux) {
	add := func(pattern string, admin bool, h http.HandlerFunc) { m.HandleFunc(pattern, s.auth(h, admin)) }
	add("GET /api/v1/sftpgo", false, s.sftpgoInstance)
	base := "/api/v1/modules/{id}/sftpgo/"
	for route, action := range map[string]string{
		"GET status": "status", "POST client/login": "client-login", "POST client/logout": "client-logout",
		"GET files": "files-list", "POST files/directory": "files-mkdir", "POST files/rename": "files-rename", "DELETE files": "files-delete",
	} {
		method, suffix, _ := strings.Cut(route, " ")
		add(method+" "+base+suffix, false, s.sftpgoJSON(action))
	}
	for route, action := range map[string]string{
		"GET settings": "settings-get", "GET users": "users-list", "POST users": "users-create", "PUT users/{name}": "users-update", "DELETE users/{name}": "users-delete",
		"GET groups": "groups-list", "POST groups": "groups-save", "PUT groups/{name}": "groups-save", "DELETE groups/{name}": "groups-delete",
		"GET folders": "folders-list", "POST folders": "folders-save", "PUT folders/{name}": "folders-save", "DELETE folders/{name}": "folders-delete",
	} {
		method, suffix, _ := strings.Cut(route, " ")
		add(method+" "+base+suffix, true, s.sftpgoJSON(action))
	}
	add("POST "+base+"settings", true, s.sftpgoSettings)
	add("PUT "+base+"files/content", false, s.sftpgoFile)
	add("GET "+base+"files/content", false, s.sftpgoFile)
}

func (s *Server) sftpgoInstance(w http.ResponseWriter, r *http.Request) {
	rows, err := store.List[model.ModuleInstance](r.Context(), s.Store, "module_instance")
	if err != nil {
		s.fail(w, err)
		return
	}
	var selected *model.ModuleInstance
	for i := range rows {
		v := &rows[i]
		if v.ModuleID == "sftpgo" && v.Mode == "local" && v.DesiredState != "removed" {
			if selected != nil {
				problem(w, 503, "module_ambiguous", "Найдено несколько файловых серверов")
				return
			}
			selected = v
		}
	}
	if selected == nil {
		problem(w, 404, "module_not_installed", "Файловый сервер не установлен")
		return
	}
	respond(w, 200, map[string]any{"instance_id": selected.ID, "name": selected.Name, "state": selected.ObservedState})
}

func (s *Server) sftpgoActor(w http.ResponseWriter, r *http.Request) (modules.SFTPGoActor, bool) {
	if s.Modules == nil {
		problem(w, 503, "module_unavailable", "Host controller недоступен")
		return modules.SFTPGoActor{}, false
	}
	cookie, err := r.Cookie("portal_session")
	if err != nil {
		problem(w, 401, "authentication_required", "Войдите в Платформу")
		return modules.SFTPGoActor{}, false
	}
	user := current(r).User
	actor, err := s.Modules.SFTPGoActor(r.Context(), r.PathValue("id"), user.ID, user.Admin, hash(cookie.Value))
	if err != nil {
		problem(w, 503, "module_unavailable", "Файловый сервер не готов или отключён")
		return actor, false
	}
	return actor, true
}

func (s *Server) sftpgoReply(w http.ResponseWriter, response modules.SFTPGoResponse) {
	if response.Status >= 400 {
		var failure struct {
			Error struct{ Code, Message string }
		}
		_ = json.Unmarshal(response.Body, &failure)
		status := response.Status
		// A native file account login failure must not expire the Pl session.
		if status == 401 {
			status = 403
		}
		problem(w, status, "sftpgo_"+failure.Error.Code, "Файловый сервер отклонил операцию. Проверьте учётную запись и права доступа.")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.Status)
	if response.Status != 204 {
		_, _ = w.Write(response.Body)
	}
}

func (s *Server) sftpgoAudit(r *http.Request, action string, status int) error {
	return s.Store.Event(r.Context(), "sftpgo.operation", "Операция файлового сервера", r.PathValue("id"), current(r).User.ID, map[string]any{"action": action, "status": status}, true)
}

func (s *Server) sftpgoJSON(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := s.sftpgoActor(w, r)
		if !ok {
			return
		}
		payload := map[string]any{}
		if r.Method == "GET" || r.Method == "DELETE" {
			q, err := doskaDirectoryQuery(r, []string{"path", "directory", "offset", "limit"})
			if err != nil {
				problem(w, 400, "invalid_query", "Некорректные параметры")
				return
			}
			switch action {
			case "files-list":
				payload["path"] = q.Get("path")
				if payload["path"] == "" {
					payload["path"] = "/"
				}
			case "files-delete":
				value, err := strconv.ParseBool(q.Get("directory"))
				if err != nil {
					problem(w, 400, "invalid_query", "Укажите тип удаляемого объекта")
					return
				}
				payload = map[string]any{"path": q.Get("path"), "directory": value}
			case "users-delete":
				payload["username"] = r.PathValue("name")
			case "groups-delete", "folders-delete":
				payload["name"] = r.PathValue("name")
			case "users-list", "groups-list", "folders-list":
				for _, key := range []string{"offset", "limit"} {
					if q.Has(key) {
						n, err := strconv.Atoi(q.Get(key))
						if err != nil || n < 0 || n > 10000 {
							problem(w, 400, "invalid_query", "Некорректная страница")
							return
						}
						payload[key] = n
					}
				}
			}
		} else {
			if !decode(w, r, &payload) {
				return
			}
			if payload == nil {
				problem(w, 400, "invalid_object", "Укажите параметры операции")
				return
			}
			if name := r.PathValue("name"); name != "" {
				kind, key := "user", "username"
				if action == "groups-save" {
					kind, key = "group", "name"
				}
				if action == "folders-save" {
					kind, key = "folder", "name"
				}
				object, valid := payload[kind].(map[string]any)
				if !valid || object[key] != name {
					problem(w, 400, "invalid_object", "Имя объекта не совпадает с маршрутом")
					return
				}
			}
		}
		write := r.Method != "GET"
		if write {
			if !moduleKeyValid(r.Header.Get("Idempotency-Key")) {
				problem(w, 400, "invalid_operation_key", "Укажите ключ операции")
				return
			}
			if err := s.sftpgoAudit(r, action, 0); err != nil {
				s.fail(w, err)
				return
			}
		}
		result, err := s.Modules.SFTPGoRequest(r.Context(), r.PathValue("id"), action, actor, payload)
		if err != nil {
			problem(w, 503, "controller_unavailable", "Результат операции не подтверждён; обновите состояние перед повтором")
			return
		}
		if write {
			if err := s.sftpgoAudit(r, action, result.Status); err != nil {
				problem(w, 503, "operation_unconfirmed", "Результат операции не удалось записать; обновите состояние перед повтором")
				return
			}
			s.Hub.Notify("all")
		}
		s.sftpgoReply(w, result)
	}
}

func (s *Server) sftpgoSettings(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.sftpgoActor(w, r)
	if !ok {
		return
	}
	var input struct {
		Configuration struct {
			ListenIP string `json:"listen_ip"`
			Port     int    `json:"port"`
		} `json:"configuration"`
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !decode(w, r, &input) {
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if !moduleKeyValid(key) {
		problem(w, 400, "invalid_operation_key", "Укажите ключ операции")
		return
	}
	requestBody, _ := json.Marshal(input)
	requestSum := sha256.Sum256(requestBody)
	requestHash := hex.EncodeToString(requestSum[:])
	if instance, job, exists, e := s.Store.SFTPGoConfigurationJob(r.Context(), r.PathValue("id"), actor.Subject, key, requestHash); e != nil {
		s.fail(w, e)
		return
	} else if exists {
		respond(w, 202, map[string]any{"instance": instance, "job": job})
		return
	}
	prepared, err := s.Modules.SFTPGoRequest(r.Context(), r.PathValue("id"), "settings-prepare", actor, input)
	if err != nil {
		problem(w, 503, "controller_unavailable", "Не удалось подготовить настройки")
		return
	}
	if prepared.Status != 200 {
		s.sftpgoReply(w, prepared)
		return
	}
	var plan struct {
		Ref           string `json:"configuration_ref"`
		Revision      int64  `json:"revision"`
		Hash          string `json:"configuration_hash"`
		Configuration struct {
			ListenIP string `json:"listen_ip"`
			Port     int    `json:"port"`
		} `json:"configuration"`
	}
	if json.Unmarshal(prepared.Body, &plan) != nil {
		problem(w, 502, "invalid_controller_response", "Контроллер не подтвердил настройки")
		return
	}
	configuration := model.SFTPGoConfiguration{Ref: plan.Ref, Revision: plan.Revision, Hash: plan.Hash, ListenIP: plan.Configuration.ListenIP, Port: plan.Configuration.Port}
	if _, err = s.Store.SaveSFTPGoDraft(r.Context(), r.PathValue("id"), actor.Subject, configuration); err != nil {
		s.fail(w, err)
		return
	}
	instance, job, err := s.Store.QueueModule(r.Context(), actor.Subject, key, r.PathValue("id"), "configure", model.ModuleRequest{ConfigurationRevision: plan.Revision, Config: map[string]string{"configuration_ref": plan.Ref, "request_hash": requestHash}})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("all")
	respond(w, 202, map[string]any{"instance": instance, "job": job})
}

func validSFTPGoPath(value string) bool {
	return utf8.ValidString(value) && len(value) > 0 && len(value) <= 4096 && strings.HasPrefix(value, "/") && path.Clean(value) == value && !strings.Contains(value, "\\") && !strings.ContainsFunc(value, unicode.IsControl)
}

func sftpgoFilePath(r *http.Request) (string, bool) {
	if r.URL.RawPath != "" || r.URL.ForceQuery || len(r.URL.RawQuery) > 8192 || len(r.TransferEncoding) != 0 ||
		((r.Method == http.MethodGet || r.Method == http.MethodHead) && r.ContentLength != 0) {
		return "", false
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["path"]) != 1 {
		return "", false
	}
	filePath := query.Get("path")
	return filePath, validSFTPGoPath(filePath)
}

func (s *Server) sftpgoFile(w http.ResponseWriter, r *http.Request) {
	s.sftpgoFileWithSpool(w, r, "/var/lib/pl/transfers")
}

func (s *Server) sftpgoFileWithSpool(w http.ResponseWriter, r *http.Request, spool string) {
	actor, ok := s.sftpgoActor(w, r)
	if !ok {
		return
	}
	filePath, ok := sftpgoFilePath(r)
	if !ok {
		problem(w, 400, "invalid_path", "Некорректный путь файла")
		return
	}
	deadline := time.Now().Add(30 * time.Minute)
	if current(r).ExpiresAt.Before(deadline) {
		deadline = current(r).ExpiresAt
	}
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	lifetime, err := s.sftpgoTransferLifetime(ctx, r.PathValue("id"))
	if err != nil {
		problem(w, 503, "module_unavailable", "Файловый сервер отключён")
		return
	}
	stopRevocation := context.AfterFunc(lifetime, cancel)
	defer stopRevocation()
	r = r.WithContext(ctx)
	// Cancellation must also interrupt a browser that stopped sending its body.
	stopRead := context.AfterFunc(ctx, func() {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
	})
	defer stopRead()
	go func() {
		tick := time.NewTicker(15 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if _, err := s.readSession(r); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	body := io.Reader(http.NoBody)
	size := int64(0)
	sum := sha256.Sum256(nil)
	digest := hex.EncodeToString(sum[:])
	action := "file-download"
	if r.Method == "PUT" {
		action = "file-upload"
		if encoding := r.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
			problem(w, 415, "unsupported_encoding", "Отправьте исходное содержимое файла")
			return
		}
		if !moduleKeyValid(r.Header.Get("Idempotency-Key")) {
			problem(w, 400, "invalid_operation_key", "Укажите ключ операции")
			return
		}
		if r.ContentLength < 0 || r.ContentLength > 1<<30 {
			problem(w, 413, "upload_limit", "Размер файла должен быть известен и не превышать 1 ГиБ")
			return
		}
		select {
		case sftpGoUploadSlots <- struct{}{}:
			defer func() { <-sftpGoUploadSlots }()
		default:
			problem(w, 429, "transfer_busy", "Уже выполняются другие загрузки")
			return
		}
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Minute))
		info, e := os.Lstat(spool)
		real, linkErr := filepath.EvalSymlinks(spool)
		if e != nil || linkErr != nil || real != spool || !info.IsDir() || info.Mode().Perm() != 0700 {
			problem(w, 503, "transfer_storage_unavailable", "Временное хранилище недоступно")
			return
		}
		owner, valid := info.Sys().(*syscall.Stat_t)
		var disk syscall.Statfs_t
		sftpGoSpoolAdmission.Lock()
		reserved := uint64(r.ContentLength)
		if !valid || owner.Uid != uint32(os.Geteuid()) || syscall.Statfs(spool, &disk) != nil || uint64(disk.Bavail)*uint64(disk.Bsize) < reserved+sftpGoSpoolAdmission.reserved+(256<<20) {
			sftpGoSpoolAdmission.Unlock()
			problem(w, 507, "transfer_storage_unavailable", "Недостаточно места для загрузки")
			return
		}
		// Reserve the full outstanding bodies atomically. Independent checks can
		// both pass before either simultaneous upload has consumed disk space.
		sftpGoSpoolAdmission.reserved += reserved
		sftpGoSpoolAdmission.Unlock()
		defer func() {
			sftpGoSpoolAdmission.Lock()
			sftpGoSpoolAdmission.reserved -= reserved
			sftpGoSpoolAdmission.Unlock()
		}()
		file, e := os.CreateTemp(spool, "sftpgo-upload-")
		if e != nil {
			problem(w, 503, "transfer_storage_unavailable", "Не удалось подготовить загрузку")
			return
		}
		defer file.Close()
		defer os.Remove(file.Name())
		// Unlink immediately: even a process crash cannot leave a payload orphan.
		if e = os.Remove(file.Name()); e != nil {
			problem(w, 503, "transfer_storage_unavailable", "Не удалось подготовить загрузку")
			return
		}
		hasher := sha256.New()
		size, e = io.Copy(io.MultiWriter(file, hasher), http.MaxBytesReader(w, r.Body, 1<<30))
		if e != nil || size != r.ContentLength {
			problem(w, 400, "upload_incomplete", "Файл получен не полностью")
			return
		}
		if _, e = file.Seek(0, io.SeekStart); e != nil {
			problem(w, 503, "transfer_storage_unavailable", "Не удалось прочитать загрузку")
			return
		}
		digest = hex.EncodeToString(hasher.Sum(nil))
		body = file
	}
	if err = s.sftpgoAudit(r, action, 0); err != nil {
		s.fail(w, err)
		return
	}
	response, err := s.Modules.SFTPGoStream(ctx, r.PathValue("id"), action, actor, filePath, body, size, digest)
	if err != nil {
		problem(w, 503, "transfer_unconfirmed", "Передача не подтверждена; проверьте файл перед повтором")
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		status := response.StatusCode
		code := "sftpgo_transfer_failed"
		if status == 401 {
			status = 403
			code = "sftpgo_authentication_required"
		}
		if status > 599 {
			status = 502
		}
		problem(w, status, code, "Передача отклонена файловым сервером")
		return
	}
	if response.StatusCode != 200 && response.StatusCode != 201 && response.StatusCode != 204 {
		problem(w, 502, "invalid_controller_response", "Некорректный ответ файлового сервера")
		return
	}
	for _, key := range []string{"Content-Type", "Content-Length", "Content-Disposition"} {
		if values := response.Header.Values(key); len(values) == 1 {
			w.Header().Set(key, values[0])
		}
	}
	if action == "file-download" {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(filePath)}))
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(response.StatusCode)
	_, copyErr := io.Copy(w, response.Body)
	status := response.StatusCode
	if copyErr != nil {
		status = 502
	}
	_ = s.sftpgoAudit(r, action, status)
}
