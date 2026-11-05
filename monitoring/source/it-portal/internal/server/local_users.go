package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/store"
)

var localUsernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

func asciiLocalUsername(username string) bool {
	return !strings.ContainsFunc(username, func(r rune) bool { return r > 127 })
}

func validLocalName(name string) bool {
	return utf8.ValidString(name) && utf8.RuneCountInString(name) >= 1 && utf8.RuneCountInString(name) <= 128 && strings.TrimSpace(name) == name && !strings.ContainsFunc(name, unicode.IsControl)
}
func validLocalPassword(password string) bool {
	return utf8.ValidString(password) && utf8.RuneCountInString(password) >= 12 && len(password) <= 1024 && !strings.ContainsAny(password, "\x00\r\n")
}

// These endpoints are browser capabilities. The machine catalog allowlist must
// never be able to grow administrative user-management access accidentally.
func (s *Server) localUsersAuth(next http.HandlerFunc, admin bool) http.HandlerFunc {
	protected := s.auth(next, admin)
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.Config.LocalUsersEnabled {
			http.NotFound(w, r)
			return
		}
		if _, present := r.Header["Authorization"]; present {
			problem(w, 403, "forbidden", "Управление пользователями доступно только через сессию браузера")
			return
		}
		protected(w, r)
	}
}

func (s *Server) listLocalUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.Store.LocalUsers(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	builtin := store.LocalUser{ID: "local-admin", Username: s.Config.LocalAdminUsername, Name: "Локальный администратор", Admin: true, Builtin: true, Revision: 0}
	respond(w, 200, map[string]any{"items": append([]store.LocalUser{builtin}, users...)})
}

func localPasswordSlot(w http.ResponseWriter) bool {
	select {
	case localPasswordSlots <- struct{}{}:
		return true
	default:
		w.Header().Set("Retry-After", "2")
		problem(w, 429, "login_rate_limited", "Обработка пароля занята. Повторите позже.")
		return false
	}
}

func (s *Server) localUserError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrLocalUserForbidden) {
		problem(w, 403, "forbidden", "Недостаточно прав для изменения пользователя")
		return
	}
	s.fail(w, err)
}

func (s *Server) createLocalUser(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Name     string `json:"name"`
		Admin    bool   `json:"admin"`
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !decode(w, r, &input) {
		return
	}
	if !asciiLocalUsername(input.Username) || !localUsernamePattern.MatchString(strings.ToLower(input.Username)) {
		problem(w, 400, "invalid_username", "Логин: 1–64 латинских букв, цифр и символов . _ -, начало — буква или цифра")
		return
	}
	input.Username = strings.ToLower(input.Username)
	if strings.EqualFold(input.Username, s.Config.LocalAdminUsername) {
		problem(w, 400, "reserved_username", "Логин встроенного администратора зарезервирован")
		return
	}
	if !validLocalName(input.Name) {
		problem(w, 400, "invalid_name", "Укажите имя длиной 1–128 символов без крайних пробелов и управляющих символов")
		return
	}
	if !s.validPasswordForRequest(r, input.Password) {
		problem(w, 400, "invalid_password", "Пароль должен соответствовать настроенной минимальной длине и не более 1024 байт без переводов строк")
		return
	}
	if !localPasswordSlot(w) {
		return
	}
	defer func() { <-localPasswordSlots }()
	encoded, err := GenerateLocalAdminPasswordHash([]byte(input.Password))
	if err != nil {
		s.fail(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	u, err := s.Store.CreateLocalUser(ctx, current(r).User, input.Username, input.Name, encoded, input.Admin)
	if errors.Is(err, store.ErrConflict) {
		problem(w, 409, "username_conflict", "Пользователь с таким логином уже существует")
		return
	}
	if err != nil {
		s.localUserError(w, err)
		return
	}
	if s.Hub != nil {
		s.Hub.Notify("local-users")
	}
	respond(w, 201, u)
}

func mutableLocalUserID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if id == "local-admin" {
		problem(w, 403, "builtin_protected", "Встроенного администратора нельзя изменять через управление пользователями")
		return "", false
	}
	parsed, err := uuid.Parse(strings.TrimPrefix(id, "local:"))
	if err != nil || id != "local:"+parsed.String() {
		problem(w, 404, "not_found", "Пользователь не найден")
		return "", false
	}
	return id, true
}

func (s *Server) updateLocalUser(w http.ResponseWriter, r *http.Request) {
	id, ok := mutableLocalUserID(w, r)
	if !ok {
		return
	}
	var input struct {
		Name     *string `json:"name"`
		Admin    *bool   `json:"admin"`
		Disabled *bool   `json:"disabled"`
		Revision int64   `json:"revision"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !decode(w, r, &input) {
		return
	}
	if input.Revision < 1 {
		problem(w, 428, "revision_required", "Укажите текущую revision")
		return
	}
	if input.Name == nil || !validLocalName(*input.Name) {
		problem(w, 400, "invalid_name", "Укажите имя длиной 1–128 символов без крайних пробелов и управляющих символов")
		return
	}
	if input.Admin == nil || input.Disabled == nil {
		problem(w, 400, "invalid_data", "Укажите роль и состояние пользователя")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	u, err := s.Store.UpdateLocalUser(ctx, current(r).User, id, *input.Name, *input.Admin, *input.Disabled, input.Revision)
	if err != nil {
		s.localUserError(w, err)
		return
	}
	if current(r).User.ID == id {
		s.cookie(w, "portal_session", "", -1)
	}
	if s.Hub != nil {
		s.Hub.Notify("local-users")
	}
	respond(w, 200, u)
}

func (s *Server) resetLocalUserPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := mutableLocalUserID(w, r)
	if !ok {
		return
	}
	var input struct {
		Password string `json:"password"`
		Revision int64  `json:"revision"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !decode(w, r, &input) {
		return
	}
	if input.Revision < 1 {
		problem(w, 428, "revision_required", "Укажите текущую revision")
		return
	}
	if !s.validPasswordForRequest(r, input.Password) {
		problem(w, 400, "invalid_password", "Пароль должен соответствовать настроенной минимальной длине и не более 1024 байт без переводов строк")
		return
	}
	if !localPasswordSlot(w) {
		return
	}
	defer func() { <-localPasswordSlots }()
	encoded, err := GenerateLocalAdminPasswordHash([]byte(input.Password))
	if err != nil {
		s.fail(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	u, err := s.Store.ResetLocalUserPassword(ctx, current(r).User, id, encoded, input.Revision)
	if err != nil {
		s.localUserError(w, err)
		return
	}
	if current(r).User.ID == id {
		s.cookie(w, "portal_session", "", -1)
	}
	if s.Hub != nil {
		s.Hub.Notify("local-users")
	}
	respond(w, 200, u)
}

func (s *Server) changeOwnLocalUserPassword(w http.ResponseWriter, r *http.Request) {
	actor := current(r).User
	if !strings.HasPrefix(actor.ID, "local:") {
		problem(w, 403, "forbidden", "Пароль этой учётной записи изменяется другим способом")
		return
	}
	var input struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !decode(w, r, &input) {
		return
	}
	if len(input.Current) > 1024 || !s.validPasswordForRequest(r, input.New) || input.Current == input.New {
		problem(w, 400, "invalid_password", "Новый пароль должен отличаться от текущего и соответствовать настроенной минимальной длине, не более 1024 байт без переводов строк")
		return
	}
	if !localPasswordSlot(w) {
		return
	}
	defer func() { <-localPasswordSlots }()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var encoded, username string
	var revision int64
	err := s.Store.Pool.QueryRow(ctx, "SELECT password_hash,username,revision FROM local_users WHERE id=$1 AND NOT disabled", actor.ID).Scan(&encoded, &username, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, 401, "session_expired", "Войдите в портал")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	reservation, allowed, err := s.reserveLoginAttempt(ctx, s.loginPeer(r), username)
	if err != nil {
		problem(w, 503, "password_change_unavailable", "Изменение пароля временно недоступно")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		problem(w, 429, "login_rate_limited", "Слишком много попыток. Повторите через 15 минут.")
		return
	}
	old, err := parseLocalPasswordHash(encoded)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !old.verify(input.Current) {
		problem(w, 400, "invalid_current_password", "Текущий пароль неверен")
		return
	}
	next, err := GenerateLocalAdminPasswordHash([]byte(input.New))
	if err != nil {
		s.fail(w, err)
		return
	}
	if err = s.Store.ChangeLocalUserPassword(ctx, actor.ID, encoded, next, revision); err != nil {
		s.localUserError(w, err)
		return
	}
	_ = s.refundLoginAttempt(ctx, reservation)
	s.cookie(w, "portal_session", "", -1)
	w.WriteHeader(204)
}
