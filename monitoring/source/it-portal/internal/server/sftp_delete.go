package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"path"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"pl/portal/internal/store"
	"time"
)

var sftpDeleteSlots = make(chan struct{}, 2)
var errSFTPDeleteIdentity = errors.New("file_identity_conflict")

func (s *Server) sftpRemoteAbsent(ctx context.Context, p string) (bool, error) {
	entries, e := s.Config.SFTP.List(ctx, path.Dir(p))
	if e != nil {
		return false, e
	}
	for _, entry := range entries {
		if entry.Name == path.Base(p) {
			return false, nil
		}
	}
	return true, nil
}
func (s *Server) sftpVerifyDeleteTarget(ctx context.Context, v model.SFTPVersion, p string) (bool, error) {
	if p != "/collections/"+v.CollectionID+"/"+v.Filename || !safeSFTPName(v.Filename) || v.SizeBytes < 1 || v.SizeBytes > sftpgo.MaxFileBytes {
		return false, errSFTPDeleteIdentity
	}
	body, _, e := s.Config.SFTP.OpenFile(ctx, p)
	if errors.Is(e, sftpgo.ErrNotFound) {
		return s.sftpRemoteAbsent(ctx, p)
	}
	if e != nil {
		return false, e
	}
	defer body.Close()
	digest := sha256.New()
	size, e := io.Copy(digest, io.LimitReader(body, sftpgo.MaxFileBytes+1))
	if e != nil {
		return false, e
	}
	if size != v.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != v.SHA256 {
		return false, errSFTPDeleteIdentity
	}
	return false, nil
}
func (s *Server) sftpDeleteVersion(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sftpUUID(w, id) {
		return
	}
	if s.Config.SFTP == nil || !s.Config.SFTP.DeleteEnabled() {
		problem(w, 503, "delete_unavailable", "Удаление файлов не подключено")
		return
	}
	select {
	case sftpDeleteSlots <- struct{}{}:
		defer func() { <-sftpDeleteSlots }()
	default:
		problem(w, 409, "delete_busy", "Удаление уже выполняется; обновите список")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	actor := current(r).User.ID
	op, e := s.Store.SFTPBeginDelete(ctx, id, actor)
	if errors.Is(e, store.ErrNotFound) {
		problem(w, 404, "not_found", "Версия не найдена")
		return
	}
	if errors.Is(e, store.ErrSFTPDeleteBusy) {
		problem(w, 409, "delete_busy", "Удаление этой версии уже выполняется")
		return
	}
	if errors.Is(e, store.ErrSFTPNotOwner) {
		problem(w, 409, "file_identity_conflict", "Эта версия больше не владеет файлом")
		return
	}
	if errors.Is(e, store.ErrInvalid) {
		problem(w, 409, "unsupported_source", "Удаление доступно для файлов SFTP")
		return
	}
	if e != nil {
		s.fail(w, e)
		return
	}
	defer op.Close()
	success := func() {
		respond(w, 200, map[string]any{"status": "deleted", "deleted_at": op.Version.DeletedAt, "deleted_by": op.Version.DeletedBy})
	}
	if op.State == "deleted" {
		success()
		return
	}
	finish := func(state, code string) bool {
		auditCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := op.Finish(auditCtx, state, actor, code); err != nil {
			s.fail(w, err)
			return false
		}
		return true
	}
	// An uncertain native write may have removed one generation followed by a new upload
	// with identical bytes. Existence+hash cannot authorize another destructive write.
	if op.State == "pending" || op.State == "uncertain" {
		absent, readErr := s.sftpRemoteAbsent(ctx, op.ProviderPath)
		if readErr == nil && absent {
			if finish("deleted", "absence_verified") {
				success()
			}
			return
		}
		if finish("uncertain", "requires_reconciliation") {
			problem(w, 503, "delete_uncertain", "Файл существует или недоступен для проверки; требуется сверка, повторное удаление запрещено")
		}
		return
	}
	if e = s.Config.SFTP.EnsureDeleteFolder(ctx, op.Version.CollectionID); e != nil {
		if finish("failed", sftpgo.ErrorCode(e)) {
			problem(w, 503, "delete_failed", "Не удалось проверить настройки удаления файла")
		}
		return
	}
	absent, e := s.sftpVerifyDeleteTarget(ctx, op.Version, op.ProviderPath)
	if errors.Is(e, errSFTPDeleteIdentity) {
		if finish("failed", "file_identity_conflict") {
			problem(w, 409, "file_identity_conflict", "Файл отличается от принятой версии; удаление остановлено")
		}
		return
	}
	if e != nil {
		// A previously uncertain attempt may already have removed the payload. Keep it blocked
		// until a read-only reconciliation succeeds; never reset this to a downloadable failure.
		state := "failed"
		if op.State == "pending" || op.State == "uncertain" {
			state = "uncertain"
		}
		if finish(state, sftpgo.ErrorCode(e)) {
			problem(w, 503, "delete_uncertain", "Не удалось проверить файл; обновите состояние перед повтором")
		}
		return
	}
	if absent {
		if finish("deleted", "already_absent") {
			success()
		}
		return
	}
	deleteErr := s.Config.SFTP.DeleteFile(ctx, op.ProviderPath) // Exactly one write; no automatic retries.
	readCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer stop()
	absent, readErr := s.sftpRemoteAbsent(readCtx, op.ProviderPath)
	if readErr == nil && absent {
		if finish("deleted", "absence_verified") {
			success()
		}
		return
	}
	state, code := "uncertain", "provider_readback_mismatch"
	var typed *sftpgo.Error
	if deleteErr != nil {
		code = sftpgo.ErrorCode(deleteErr)
		if readErr == nil && errors.As(deleteErr, &typed) && !typed.Uncertain {
			state = "failed"
		}
	}
	if !finish(state, code) {
		return
	}
	if state == "uncertain" {
		problem(w, 503, "delete_uncertain", "Результат удаления проверяется; обновите состояние перед повтором")
		return
	}
	problem(w, 502, "delete_failed", "SFTP-сервис отклонил удаление; файл сохранён")
}
