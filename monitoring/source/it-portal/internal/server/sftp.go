package server

import (
	"archive/zip"
	"bytes"
	"errors"
	"github.com/google/uuid"
	"io"
	"mime"
	"net/http"
	"path"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const sftpTestLimit = 8 << 20

var sftpSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func (s *Server) registerSFTPRoutes(m *http.ServeMux) {
	add := func(pattern string, h http.HandlerFunc, admin bool) {
		m.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			// Native browser module must not inherit machine-auth scopes.
			if _, ok := r.Header["Authorization"]; ok {
				problem(w, 401, "browser_session_required", "Требуется сессия Платформы")
				return
			}
			s.auth(h, admin)(w, r)
		})
	}
	add("GET /api/v1/sftp-server", s.sftpState, false)
	add("POST /api/v1/sftp-server/access", s.sftpAccess, false)
	add("POST /api/v1/sftp-server/reconcile", s.sftpReconcileHTTP, true)
	add("POST /api/v1/sftp-server/collections", s.sftpSaveCollection, true)
	add("PUT /api/v1/sftp-server/collections/{id}", s.sftpSaveCollection, true)
	add("POST /api/v1/sftp-server/accounts", s.sftpSaveAccount, true)
	add("PUT /api/v1/sftp-server/accounts/{id}", s.sftpSaveAccount, true)
	add("POST /api/v1/sftp-server/versions/{id}/seen", s.sftpSeen, false)
	add("GET /api/v1/sftp-server/versions/{id}/download", s.sftpDownload, false)
	add("DELETE /api/v1/sftp-server/versions/{id}", s.sftpDeleteVersion, true)
	if s.Config.Demo && s.Config.SFTP == nil {
		add("POST /api/v1/sftp-server/test-upload", s.sftpTestUpload, true)
	}
}
func (s *Server) sftpState(w http.ResponseWriter, r *http.Request) {
	state, e := s.Store.SFTPState(r.Context(), current(r).User.ID, current(r).User.Admin)
	if e != nil {
		s.fail(w, e)
		return
	}
	provider, e := s.sftpProviderOverview(r.Context())
	if e != nil {
		s.fail(w, e)
		return
	}
	for i := range state.Versions {
		state.Versions[i].CanDelete = state.Versions[i].CanDelete && s.Config.SFTP != nil && s.Config.SFTP.DeleteEnabled()
	}
	mode := "local_candidate"
	if provider.Configured {
		mode = "connected"
	}
	respond(w, 200, map[string]any{"provider": provider, "mode": mode, "sftp_connected": provider.Status == "healthy", "demo_upload_enabled": s.Config.Demo && s.Config.SFTP == nil, "can_manage": current(r).User.Admin, "retention_months": 2, "retention_enforced": false, "versions_total": state.VersionsTotal, "versions_limit": 1000, "versions_has_more": state.VersionsTotal > int64(len(state.Versions)), "audit_total": state.AuditTotal, "audit_limit": 100, "collections": state.Collections, "available_readers": state.AvailableReaders, "accounts": state.Accounts, "versions": state.Versions, "audit": state.Audit})
}
func (s *Server) sftpAccess(w http.ResponseWriter, r *http.Request) {
	if e := s.Store.SFTPAccess(r.Context(), current(r).User.ID); e != nil {
		s.fail(w, e)
		return
	}
	w.WriteHeader(204)
}
func sftpText(v string) bool {
	return strings.TrimSpace(v) != "" && len(v) <= 200 && !strings.ContainsFunc(v, unicode.IsControl)
}
func sftpUUID(w http.ResponseWriter, id string) bool {
	_, e := uuid.Parse(id)
	if e != nil {
		problem(w, 400, "invalid_id", "Некорректный идентификатор")
		return false
	}
	return true
}
func (s *Server) sftpSaveCollection(w http.ResponseWriter, r *http.Request) {
	var v model.SFTPCollection
	if !decode(w, r, &v) {
		return
	}
	v.ID = r.PathValue("id")
	if v.ID != "" && !sftpUUID(w, v.ID) {
		return
	}
	if v.ID != "" && v.Revision < 1 {
		problem(w, 428, "revision_required", "Укажите актуальную revision редактируемой записи")
		return
	}
	if !sftpText(v.Branch) || !sftpText(v.Label) || !sftpSlug.MatchString(v.Folder) || v.QuotaBytes < 1 || v.QuotaBytes > 10<<40 {
		problem(w, 400, "invalid_policy", "Укажите филиал, название, папку a-z/0-9/_/- и положительную квоту до 10 ТиБ")
		return
	}
	if len(v.ReaderIDs) > 100 {
		problem(w, 400, "invalid_readers", "Слишком много пользователей")
		return
	}
	readers := map[string]bool{}
	for _, user := range v.ReaderIDs {
		if !sftpText(user) || readers[user] {
			problem(w, 400, "invalid_readers", "Укажите уникальные идентификаторы пользователей Платформы")
			return
		}
		readers[user] = true
	}
	if v.ReaderIDs == nil {
		v.ReaderIDs = []string{}
	}
	out, e := s.Store.SFTPSaveCollection(r.Context(), v, current(r).User.ID)
	if e != nil {
		if sftpPolicyProblem(w, e) {
			return
		}
		s.fail(w, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) sftpSaveAccount(w http.ResponseWriter, r *http.Request) {
	var v model.SFTPAccount
	if !decode(w, r, &v) {
		return
	}
	v.ID = r.PathValue("id")
	if v.ID != "" && !sftpUUID(w, v.ID) {
		return
	}
	if v.ID != "" && v.Revision < 1 {
		problem(w, 428, "revision_required", "Укажите актуальную revision редактируемой записи")
		return
	}
	if v.Kind != "" && v.Kind != model.SFTPSender && v.Kind != model.SFTPReceiver {
		problem(w, 400, "invalid_account_kind", "Выберите тип учётной записи: отправитель или получатель")
		return
	}
	if v.Kind == model.SFTPReceiver {
		v.QuotaBytes = 0
	}
	requiresBudget := v.Kind == model.SFTPSender || (v.Kind == "" && v.ID == "")
	if !sftpSlug.MatchString(v.Username) || !sftpText(v.Label) || (requiresBudget && v.QuotaBytes < 1) || v.QuotaBytes < 0 || v.QuotaBytes > 10<<40 || len(v.CollectionIDs) < 1 || len(v.CollectionIDs) > 100 {
		problem(w, 400, "invalid_policy", "Укажите имя a-z/0-9/_/-, название, квоту и доступные папки")
		return
	}
	unique := map[string]bool{}
	for _, id := range v.CollectionIDs {
		if !sftpUUID(w, id) {
			return
		}
		if unique[id] {
			problem(w, 400, "invalid_policy", "Папки не должны повторяться")
			return
		}
		unique[id] = true
	}
	if s.Config.SFTP != nil || len(v.PublicKeys) > 0 {
		keys, e := normalizeSFTPPublicKeys(v.PublicKeys, v.Enabled)
		if e != nil {
			problem(w, 400, "invalid_public_keys", "Укажите SSH public keys Ed25519, RSA не менее 3072 бит или ECDSA. Приватные ключи не принимаются")
			return
		}
		v.PublicKeys = keys
	}
	if v.PublicKeys == nil {
		v.PublicKeys = []string{}
	}
	out, e := s.Store.SFTPSaveAccount(r.Context(), v, current(r).User.ID)
	if e != nil {
		if sftpPolicyProblem(w, e) {
			return
		}
		s.fail(w, e)
		return
	}
	respond(w, 200, out)
}
func (s *Server) sftpSeen(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sftpUUID(w, id) {
		return
	}
	if e := s.Store.SFTPSeen(r.Context(), id, current(r).User.ID); e != nil {
		s.fail(w, e)
		return
	}
	w.WriteHeader(204)
}
func safeSFTPName(name string) bool {
	return name != "" && len(name) <= 255 && utf8.ValidString(name) && name == path.Base(name) && !strings.ContainsAny(name, "\\/:") && !strings.ContainsFunc(name, unicode.IsControl) && name != "." && name != ".."
}
func validateSFTPZip(data []byte) error {
	z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		return e
	}
	if len(z.File) == 0 || len(z.File) > 256 {
		return errors.New("archive entry count")
	}
	var total uint64
	names := map[string]bool{}
	files := 0
	for _, f := range z.File {
		name := strings.TrimSuffix(f.Name, "/")
		if name == "" || path.IsAbs(name) || path.Clean(name) != name || strings.ContainsAny(name, "\\:") || strings.ContainsFunc(name, unicode.IsControl) || name == ".." || strings.HasPrefix(name, "../") || len(name) > 240 || !f.Mode().IsRegular() && !f.FileInfo().IsDir() {
			return errors.New("unsafe entry")
		}
		if names[name] {
			return errors.New("duplicate entry")
		}
		names[name] = true
		if f.FileInfo().IsDir() {
			continue
		}
		files++
		total += f.UncompressedSize64
		if f.UncompressedSize64 > 32<<20 || total > 64<<20 {
			return errors.New("expanded archive too large")
		}
		reader, e := f.Open()
		if e != nil {
			return e
		}
		n, e := io.Copy(io.Discard, io.LimitReader(reader, 32<<20+1))
		reader.Close()
		if e != nil || n > 32<<20 {
			return errors.New("invalid entry content")
		}
	}
	if files == 0 {
		return errors.New("no files")
	}
	return nil
}
func (s *Server) sftpTestUpload(w http.ResponseWriter, r *http.Request) {
	if !s.Config.Demo || s.Config.SFTP != nil {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, sftpTestLimit+(64<<10))
	if e := r.ParseMultipartForm(sftpTestLimit + (64 << 10)); e != nil {
		problem(w, 400, "invalid_upload", "Ожидается ZIP до 8 МиБ")
		return
	}
	defer r.MultipartForm.RemoveAll()
	if len(r.MultipartForm.File) != 1 || len(r.MultipartForm.File["file"]) != 1 || len(r.MultipartForm.Value["collection_id"]) != 1 {
		problem(w, 400, "invalid_upload", "Укажите один файл и папку")
		return
	}
	id := r.FormValue("collection_id")
	if !sftpUUID(w, id) {
		return
	}
	f, h, e := r.FormFile("file")
	if e != nil {
		problem(w, 400, "invalid_upload", "Файл не передан")
		return
	}
	defer f.Close()
	_, params, e := mime.ParseMediaType(h.Header.Get("Content-Disposition"))
	name := params["filename"]
	if e != nil || !safeSFTPName(name) || !strings.EqualFold(path.Ext(name), ".zip") {
		problem(w, 400, "invalid_filename", "Тестовая загрузка принимает ZIP с безопасным именем")
		return
	}
	data, e := io.ReadAll(io.LimitReader(f, sftpTestLimit+1))
	if e != nil || len(data) == 0 || len(data) > sftpTestLimit {
		problem(w, 400, "invalid_upload", "Ожидается ZIP до 8 МиБ")
		return
	}
	if e = validateSFTPZip(data); e != nil {
		problem(w, 400, "invalid_archive", "Архив повреждён, содержит небезопасные пути или превышает тестовые ограничения")
		return
	}
	v, duplicate, e := s.Store.SFTPReceiveTest(r.Context(), id, name, current(r).User.ID, data)
	if e != nil {
		s.fail(w, e)
		return
	}
	status := 201
	if duplicate {
		status = 200
	}
	respond(w, status, map[string]any{"version": v, "duplicate": duplicate})
}
func (s *Server) sftpDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sftpUUID(w, id) {
		return
	}
	version, providerPath, e := s.Store.SFTPRemoteDownload(r.Context(), id, current(r).User.ID)
	if errors.Is(e, store.ErrSFTPDeleted) {
		problem(w, 410, "file_unavailable", "Файл удалён или его удаление проверяется")
		return
	}
	if errors.Is(e, store.ErrSFTPAccess) {
		problem(w, 403, "file_access_denied", "Нет разрешения на скачивание из этой папки")
		return
	}
	if e != nil {
		s.fail(w, e)
		return
	}
	if version.Source == "sftpgo" {
		s.sftpStreamRemote(w, r, version, providerPath)
		return
	}
	name, data, e := s.Store.SFTPDownload(r.Context(), id, current(r).User.ID)
	if errors.Is(e, store.ErrSFTPAccess) {
		problem(w, 403, "file_access_denied", "Нет разрешения на скачивание из этой папки")
		return
	}
	if e != nil {
		s.fail(w, e)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
