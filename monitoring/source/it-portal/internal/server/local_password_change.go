package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func (s *Server) passwordChangeMarker() string {
	return filepath.Join(filepath.Dir(s.Config.LocalAdminHashFile), "password-change-required")
}

func (s *Server) localPasswordChangeRequired() bool {
	info, err := os.Lstat(s.passwordChangeMarker())
	return err == nil && info.Mode().IsRegular()
}

// Prepare the complete replacement before revoking sessions. A failed rename leaves
// the previous hash intact; revocation must finish before publishing the new hash.
func stageLocalPasswordHash(path, encoded string) (string, error) {
	invalid := errors.New("local administrator password storage unavailable")
	for _, name := range []string{filepath.Dir(path), path} {
		info, err := os.Lstat(name)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return "", invalid
		}
		owner, ok := info.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0022 != 0 {
			return "", invalid
		}
		if name == path && !info.Mode().IsRegular() || name != path && !info.IsDir() {
			return "", invalid
		}
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".local-admin-hash-*")
	if err != nil {
		return "", invalid
	}
	name := f.Name()
	good := false
	defer func() {
		_ = f.Close()
		if !good {
			_ = os.Remove(name)
		}
	}()
	if err = f.Chmod(0600); err == nil {
		_, err = io.WriteString(f, encoded+"\n")
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", invalid
	}
	good = true
	return name, nil
}

func (s *Server) changeLocalAdminPassword(w http.ResponseWriter, r *http.Request) {
	if !s.Config.LocalAdminPasswordChange || s.Config.LocalAdminHashFile == "" {
		http.NotFound(w, r)
		return
	}
	if current(r).User.ID != "local-admin" || !current(r).User.Admin {
		problem(w, 403, "forbidden", "Изменить пароль может только локальный администратор")
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		problem(w, 415, "content_type", "Ожидается application/json")
		return
	}
	var input struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		problem(w, 400, "invalid_password", "Некорректный запрос изменения пароля")
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || len(input.Current) > 1024 || !s.validPasswordForRequest(r, input.New) || input.Current == input.New {
		problem(w, 400, "invalid_password", "Новый пароль должен отличаться от текущего и соответствовать настроенной минимальной длине, не более 1024 байт без переводов строк")
		return
	}
	select {
	case localPasswordSlots <- struct{}{}:
		defer func() { <-localPasswordSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		problem(w, 429, "login_rate_limited", "Изменение пароля занято. Повторите позже.")
		return
	}
	s.localAuthMu.Lock()
	defer s.localAuthMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	reservation, allowed, err := s.reserveLoginAttempt(ctx, s.loginPeer(r), s.Config.LocalAdminUsername)
	if err != nil {
		problem(w, 503, "password_change_unavailable", "Изменение пароля временно недоступно")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		problem(w, 429, "login_rate_limited", "Слишком много попыток. Повторите через 15 минут.")
		return
	}
	old, err := readLocalPasswordHash(s.Config.LocalAdminHashFile)
	if err != nil {
		problem(w, 503, "password_change_unavailable", "Хранилище пароля недоступно")
		return
	}
	if !old.verify(input.Current) {
		problem(w, 400, "invalid_current_password", "Текущий пароль неверен")
		return
	}
	encoded, err := GenerateLocalAdminPasswordHash([]byte(input.New))
	if err != nil {
		problem(w, 503, "password_change_unavailable", "Не удалось подготовить новый пароль")
		return
	}
	temp, err := stageLocalPasswordHash(s.Config.LocalAdminHashFile, encoded)
	if err != nil {
		problem(w, 503, "password_change_unavailable", "Хранилище пароля недоступно для записи")
		return
	}
	defer os.Remove(temp)
	// A DB failure cannot publish the new hash. A later file failure may log users
	// out, but the old password remains usable and no old session survives a success.
	if _, err = s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id='local-admin'"); err != nil {
		problem(w, 503, "password_change_unavailable", "Не удалось завершить сессии. Пароль не изменён.")
		return
	}
	s.cookie(w, "portal_session", "", -1)
	if err = os.Rename(temp, s.Config.LocalAdminHashFile); err != nil {
		problem(w, 503, "password_change_unavailable", "Пароль не изменён. Войдите с прежним паролем и повторите.")
		return
	}
	_ = os.Remove(s.passwordChangeMarker())
	_ = s.refundLoginAttempt(ctx, reservation)
	_ = s.Store.Event(ctx, "auth.password_changed", "Изменён пароль локального администратора", "", "local-admin", nil, true)
	w.WriteHeader(http.StatusNoContent)
}
