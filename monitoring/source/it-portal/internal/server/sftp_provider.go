package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"pl/portal/internal/store"
	"strconv"
	"strings"
	"time"
)

func loadSFTPConfig() (*sftpgo.Client, error) {
	endpoint := os.Getenv("PORTAL_SFTP_API_URL")
	if endpoint == "" {
		return nil, nil
	}
	return sftpgo.New(sftpgo.Config{URL: endpoint, CAFile: os.Getenv("PORTAL_SFTP_CA_FILE"), AdminKeyFile: os.Getenv("PORTAL_SFTP_ADMIN_KEY_FILE"), ReaderKeyFile: os.Getenv("PORTAL_SFTP_READER_KEY_FILE"), DeleteKeyFile: os.Getenv("PORTAL_SFTPGO_DELETE_KEY_FILE"), DeleteCredentialFile: os.Getenv("PORTAL_SFTPGO_DELETE_CREDENTIAL_FILE"), DataRoot: env("PORTAL_SFTP_DATA_ROOT", "/srv/sftpgo/data")})
}
func normalizeSFTPPublicKeys(values []string, enabled bool) ([]string, error) {
	if len(values) > 10 || enabled && len(values) == 0 {
		return nil, errors.New("invalid_public_keys")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if len(value) > 16384 || strings.Contains(value, "PRIVATE KEY") {
			return nil, errors.New("invalid_public_keys")
		}
		key, _, options, rest, e := ssh.ParseAuthorizedKey([]byte(value))
		if e != nil || len(options) > 0 || len(strings.TrimSpace(string(rest))) != 0 {
			return nil, errors.New("invalid_public_keys")
		}
		cryptoKey, ok := key.(ssh.CryptoPublicKey)
		if !ok {
			return nil, errors.New("invalid_public_keys")
		}
		switch k := cryptoKey.CryptoPublicKey().(type) {
		case ed25519.PublicKey:
		case *rsa.PublicKey:
			if k.N.BitLen() < 3072 {
				return nil, errors.New("invalid_public_keys")
			}
		case *ecdsa.PublicKey:
			if k.Curve.Params().BitSize != 256 && k.Curve.Params().BitSize != 384 && k.Curve.Params().BitSize != 521 {
				return nil, errors.New("invalid_public_keys")
			}
		default:
			return nil, errors.New("invalid_public_keys")
		}
		normalized := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
		if seen[normalized] {
			return nil, errors.New("duplicate_public_key")
		}
		seen[normalized] = true
		out = append(out, normalized)
	}
	return out, nil
}
func sftpPolicyProblem(w http.ResponseWriter, e error) bool {
	var quota *store.SFTPQuotaError
	if errors.As(e, &quota) {
		message := fmt.Sprintf("Квота пользователя должна быть не меньше суммы квот выбранных папок: %d байт", quota.Minimum)
		code := "invalid_quota_assignment"
		if quota.Collection {
			message = "Увеличьте квоты пользователей, которым назначена эта папка, прежде чем повышать квоту папки"
		}
		if quota.Budget {
			code = "storage_budget_exceeded"
			message = "Сумма квот папок превышает бюджет хранилища 160 ГиБ"
		}
		problem(w, 400, code, message)
		return true
	}
	return false
}
func (s *Server) sftpProviderOverview(ctx context.Context) (model.SFTPProviderState, error) {
	state, e := s.Store.SFTPProviderState(ctx)
	if e != nil {
		return state, e
	}
	state.Configured = s.Config.SFTP != nil
	state.Status = "disabled"
	if !state.Configured {
		return state, nil
	}
	state.Status = "stale"
	if state.QuarantinedReceipts > 0 && state.Error == "" {
		state.Error = "quarantined_receipts"
	}
	if state.Error != "" {
		state.Status = "error"
	} else if state.LastSuccessAt != nil && time.Since(*state.LastSuccessAt) < 3*time.Minute {
		state.Status = "healthy"
	}
	return state, nil
}
func (s *Server) sftpReconcileHTTP(w http.ResponseWriter, r *http.Request) {
	if s.Config.SFTP == nil {
		problem(w, 503, "provider_disabled", "SFTPGo не подключён")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	if e := s.ReconcileSFTP(ctx); e != nil {
		problem(w, 502, "provider_reconcile_failed", "Изменения сохранены. Применение SFTPGo завершилось ошибкой; состояние доступно в панели")
		return
	}
	w.WriteHeader(204)
}

// RunSFTP reconciles durable desired state and native persisted event receipts.
func (s *Server) RunSFTP(ctx context.Context) {
	if s.Config.SFTP == nil {
		return
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			work, cancel := context.WithTimeout(ctx, 5*time.Minute)
			if e := s.ReconcileSFTP(work); e != nil {
				slog.Warn("sftp_reconciliation_failed", "code", sftpgo.ErrorCode(e))
			}
			cancel()
			timer.Reset(time.Minute)
		}
	}
}
func (s *Server) ReconcileSFTP(ctx context.Context) error {
	if s.Config.SFTP == nil {
		return errors.New("provider_disabled")
	}
	// A PostgreSQL session lock prevents overlapping processes without trusting a UI flag.
	conn, e := s.Store.Pool.Acquire(ctx)
	if e != nil {
		return e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(7398219)").Scan(&locked); e != nil {
		return e
	}
	if !locked {
		return &sftpgo.Error{Code: "reconciliation_busy"}
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(release, "SELECT pg_advisory_unlock(7398219)")
	}()
	if e = s.Store.SFTPProviderAttempt(ctx); e != nil {
		return e
	}
	failure := ""
	cursor := int64(0)
	defer func() {
		finish, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := s.Store.SFTPProviderResult(finish, failure, cursor); e != nil {
			slog.Error("sftp_state_persist_failed")
		}
		if s.Hub != nil {
			s.Hub.Notify("sftp-server")
		}
	}()
	if e = s.Config.SFTP.Check(ctx); e != nil {
		failure = sftpgo.ErrorCode(e)
		return e
	}
	state, e := s.Store.SFTPState(ctx, "sftpgo-reconciler", true)
	if e != nil {
		failure = "database_error"
		return e
	}
	collections := map[string]model.SFTPCollection{}
	collectionErrors := map[string]string{}
	folderErrors := map[string]string{}
	for _, collection := range state.Collections {
		collections[collection.ID] = collection
		e = s.Config.SFTP.EnsureFolder(ctx, s.Config.SFTP.Folder(collection.ID))
		code := ""
		if e != nil {
			code = sftpgo.ErrorCode(e)
			failure = code
		}
		collectionErrors[collection.ID] = code
		folderErrors[collection.ID] = code

	}
	accounts := map[string]model.SFTPAccount{}
	for _, account := range state.Accounts {

		want, e := s.sftpDesiredUser(account, collections)
		if e == nil {
			for _, id := range account.CollectionIDs {
				if folderErrors[id] != "" {
					e = &sftpgo.Error{Code: folderErrors[id]}
					break
				}
			}
		}
		if e == nil {
			e = s.Config.SFTP.EnsureUser(ctx, want)
		}
		code := ""
		if e == nil {
			accounts[account.Username] = account
		}
		if e != nil {
			code = sftpgo.ErrorCode(e)
			failure = code
		}
		if code != "" {
			for _, id := range account.CollectionIDs {
				if collectionErrors[id] == "" {
					collectionErrors[id] = "dependent_account_error"
				}
			}
		}
		if update := s.Store.SFTPProvisioned(ctx, "account", account.ID, account.Revision, code); update != nil {
			failure = "database_error"
			return update
		}
	}
	for _, collection := range state.Collections {
		if update := s.Store.SFTPProvisioned(ctx, "collection", collection.ID, collection.Revision, collectionErrors[collection.ID]); update != nil {
			failure = "database_error"
			return update
		}
	}
	provider, e := s.Store.SFTPProviderState(ctx)
	if e != nil {
		failure = "database_error"
		return e
	}
	start := provider.CursorTimestamp - int64(24*time.Hour)
	if start < 0 {
		start = 0
	}
	end := time.Now().Add(-2 * time.Second).UnixNano()
	from := ""
	for page := 0; page < 100; page++ {
		events, e := s.Config.SFTP.Events(ctx, start, end, from)
		if e != nil {
			failure = sftpgo.ErrorCode(e)
			return e
		}
		receiptFailure, e := s.sftpProcessEvents(ctx, events, accounts, collections)
		if receiptFailure != "" {
			failure = receiptFailure
		}
		if e != nil {
			return e
		}
		if len(events) < 500 {
			cursor = end
			break
		}
		if events[len(events)-1].ID == from {
			failure = "provider_invalid_response"
			return &sftpgo.Error{Code: failure}
		}
		from = events[len(events)-1].ID
		if page == 99 {
			failure = "event_backlog"
			return &sftpgo.Error{Code: failure}
		}
	}
	// A receipt is mandatory: file presence/mtime alone never becomes a successful version.
	for _, collection := range state.Collections {
		if folderErrors[collection.ID] != "" {
			continue
		}
		entries, e := s.Config.SFTP.List(ctx, "/collections/"+collection.ID)
		if errors.Is(e, sftpgo.ErrNotFound) {
			continue
		}
		if e != nil {
			failure = sftpgo.ErrorCode(e)
			return e
		}
		for _, entry := range entries {
			if entry.Mode&2401763328 != 0 || !safeSFTPName(entry.Name) {
				failure = "unconfirmed_files"
				continue
			}
			if time.Since(entry.LastModified) < 5*time.Minute {
				continue
			}
			known, e := s.Store.SFTPRemoteKnown(ctx, "", "/collections/"+collection.ID+"/"+entry.Name)
			if e != nil {
				failure = "database_error"
				return e
			}
			if !known {
				failure = "unconfirmed_files"
			}
		}
	}
	latest, e := s.Store.SFTPProviderState(ctx)
	if e != nil {
		failure = "database_error"
		return e
	}
	if latest.QuarantinedReceipts > 0 && (failure == "" || failure == "unconfirmed_files") {
		failure = "quarantined_receipts"
	}
	if failure != "" {
		return &sftpgo.Error{Code: failure}
	}
	return nil
}
func (s *Server) sftpDesiredUser(account model.SFTPAccount, collections map[string]model.SFTPCollection) (sftpgo.User, error) {
	if account.Kind != "" && account.Kind != model.SFTPSender && account.Kind != model.SFTPReceiver {
		return sftpgo.User{}, &sftpgo.Error{Code: "invalid_policy"}
	}
	receiver := account.Kind == model.SFTPReceiver
	keys, e := normalizeSFTPPublicKeys(account.PublicKeys, account.Enabled)
	if e != nil {
		return sftpgo.User{}, &sftpgo.Error{Code: "invalid_policy"}
	}
	want := sftpgo.User{Username: account.Username, PublicKeys: keys, HomeDir: path.Join(s.Config.SFTP.Root, "accounts", account.ID), AdditionalInfo: sftpgo.ManagedMarker(account.ID), Role: "portal-sftp", QuotaSize: account.QuotaBytes, QuotaFiles: 5000, MaxSessions: 2, Permissions: map[string][]string{"/": {"upload"}}, Filesystem: map[string]any{"provider": 0}, Filters: sftpgo.Filters{DeniedLoginMethods: []string{"password", "password-over-SSH", "keyboard-interactive", "publickey+password", "publickey+keyboard-interactive", "TLSCertificate", "TLSCertificate+password"}, DeniedProtocols: []string{"FTP", "DAV", "HTTP"}, AllowAPIKey: false, MaxUploadFileSize: sftpgo.MaxFileBytes, FilePatterns: []sftpgo.Pattern{{Path: "/", Denied: []string{"*"}}}, WebClient: []string{"publickey-change-disabled", "tls-cert-change-disabled", "write-disabled", "mfa-disabled", "password-change-disabled", "api-key-auth-change-disabled", "info-change-disabled", "shares-disabled", "password-reset-disabled"}}}
	if receiver {
		want.QuotaSize = 0
		want.QuotaFiles = 0
		want.Permissions = map[string][]string{"/": {"list"}}
	}
	if account.Enabled {
		want.Status = 1
	}
	var minimum int64
	for _, id := range account.CollectionIDs {
		collection, ok := collections[id]
		if !ok {
			return want, &sftpgo.Error{Code: "invalid_policy"}
		}
		minimum += collection.QuotaBytes
		virtual := "/" + collection.Folder
		folder := s.Config.SFTP.Folder(id)
		virtualFolder := sftpgo.VirtualFolder{Folder: folder, VirtualPath: virtual, QuotaSize: collection.QuotaBytes, QuotaFiles: 5000}
		patterns := []string{"*.zip", "*.7z", "*.gz", "*.bz2", "*.xz", "*.rar"}
		if receiver {
			virtualFolder.QuotaSize = 0
			virtualFolder.QuotaFiles = 0
			patterns = []string{"*"}
		}
		want.VirtualFolders = append(want.VirtualFolders, virtualFolder)
		want.Permissions[virtual] = model.SFTPAccountPermissions(account.Kind)
		filter := sftpgo.Pattern{Path: virtual, Allowed: patterns}
		if receiver {
			filter.Allowed = nil
			filter.Denied = []string{".sftpgo-upload.*"}
			filter.DenyPolicy = 1
		} // Native CheckAllowed short-circuits allowed patterns: do not combine '*' with denies.
		want.Filters.FilePatterns = append(want.Filters.FilePatterns, filter)
	}
	if len(account.CollectionIDs) == 0 || (!receiver && account.QuotaBytes < minimum) {
		return want, &sftpgo.Error{Code: "invalid_policy"}
	}
	return want, nil
}
func (s *Server) sftpReceiveEvent(ctx context.Context, event sftpgo.Event, accounts map[string]model.SFTPAccount, collections map[string]model.SFTPCollection) error {
	// Native persisted successful upload is historical authority. A later business
	// type change cannot invalidate it; downloads are never treated as new versions.
	if event.Action != "upload" || event.Status != 1 {
		return nil
	}
	prefix := path.Join(s.Config.SFTP.Root, "collections") + "/"
	if !strings.HasPrefix(event.FSPath, prefix) {
		return nil
	}
	relative := strings.TrimPrefix(event.FSPath, prefix)
	parts := strings.Split(relative, "/")
	collection, managed := collections[parts[0]]
	if !managed {
		return nil
	} // Unmanaged namespaces are not adopted.
	if len(parts) != 2 || !safeSFTPName(parts[1]) || path.Clean(event.FSPath) != event.FSPath {
		return &sftpgo.Error{Code: "event_integrity_error"}
	}

	if event.Action != "upload" || event.Status != 1 || event.Protocol != "SFTP" || event.FSProvider != 0 || event.Timestamp <= 0 || event.FileSize <= 0 || event.FileSize > sftpgo.MaxFileBytes || len(event.ID) == 0 || len(event.ID) > 512 || len(event.InstanceID) > 200 {
		return &sftpgo.Error{Code: "event_integrity_error"}
	}
	providerPath := "/collections/" + relative
	eventKey := event.InstanceID + ":" + event.ID
	lease, e := s.Store.SFTPLockPath(ctx, providerPath, true)
	if e != nil {
		return e
	}
	defer lease.Close()
	known, e := s.Store.SFTPRemoteReceiptKnown(ctx, eventKey, providerPath, event.FileSize, event.Username)
	if errors.Is(e, store.ErrInvalid) {
		return &sftpgo.Error{Code: "event_path_conflict"}
	}
	if e != nil || known {
		return e
	}
	account, verified := accounts[event.Username]
	if !verified {
		return &sftpgo.Error{Code: "account_not_verified"}
	}
	body, length, e := s.Config.SFTP.OpenFile(ctx, providerPath)
	if e != nil {
		return e
	}
	defer body.Close()
	if length >= 0 && length != event.FileSize {
		return &sftpgo.Error{Code: "event_integrity_error"}
	}
	digest := sha256.New()
	size, e := io.Copy(digest, io.LimitReader(body, sftpgo.MaxFileBytes+1))
	if e != nil {
		return &sftpgo.Error{Code: "provider_unavailable"}
	}
	if size != event.FileSize {
		return &sftpgo.Error{Code: "event_integrity_error"}
	}
	_, e = lease.ReceiveRemote(ctx, model.SFTPVersion{CollectionID: collection.ID, Filename: parts[1], SizeBytes: size, SHA256: hex.EncodeToString(digest.Sum(nil)), ReceivedAt: time.Unix(0, event.Timestamp).UTC(), ReceivedBy: account.Username, ReceivedByName: account.Label, Source: "sftpgo"}, eventKey)
	return e
}

var sftpDownloadSlots = make(chan struct{}, 2)

func (s *Server) sftpStreamRemote(w http.ResponseWriter, r *http.Request, v model.SFTPVersion, providerPath string) {
	select {
	case sftpDownloadSlots <- struct{}{}:
		defer func() { <-sftpDownloadSlots }()
	default:
		problem(w, 429, "downloads_busy", "Два скачивания уже выполняются. Повторите позже")
		return
	}
	if s.Config.SFTP == nil {
		problem(w, 503, "provider_disabled", "SFTPGo не подключён")
		return
	}
	auditFinished := false
	if e := s.Store.SFTPDownloadAudit(r.Context(), "download.requested", current(r).User.ID, v.CollectionID, v.ID); e != nil {
		s.fail(w, e)
		return
	}
	defer func() {
		if !auditFinished {
			auditCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.Store.SFTPDownloadAudit(auditCtx, "download.failed", current(r).User.ID, v.CollectionID, v.ID)
		}
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	body, length, e := s.Config.SFTP.OpenFile(ctx, providerPath)
	if e != nil {
		problem(w, 502, "provider_download_failed", "Не удалось получить файл с SFTPGo")
		return
	}
	defer body.Close()
	if length >= 0 && length != v.SizeBytes {
		problem(w, 502, "file_integrity_failed", "Размер файла отличается от принятой версии")
		return
	}
	// Bounded disk staging verifies integrity before any untrusted bytes reach browser.
	stage, e := os.CreateTemp("", "portal-sftp-download-*")
	if e != nil {
		problem(w, 503, "download_storage_unavailable", "Не удалось подготовить скачивание")
		return
	}
	defer os.Remove(stage.Name())
	defer stage.Close()
	digest := sha256.New()
	size, e := io.Copy(io.MultiWriter(stage, digest), io.LimitReader(body, sftpgo.MaxFileBytes+1))
	if e != nil || size != v.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != v.SHA256 {
		problem(w, 502, "file_integrity_failed", "Файл отличается от принятой версии")
		return
	}
	// A grant revoked during staging is checked again before serving the archive.
	if _, _, e = s.Store.SFTPRemoteDownload(r.Context(), v.ID, current(r).User.ID); e != nil {
		if errors.Is(e, store.ErrSFTPAccess) {
			problem(w, 403, "file_access_denied", "Нет разрешения на скачивание из этой папки")
		} else if errors.Is(e, store.ErrSFTPDeleted) {
			problem(w, 410, "file_unavailable", "Файл удалён или его удаление проверяется")
		} else {
			s.fail(w, e)
		}
		return
	}
	if e = s.Store.SFTPDownloadAudit(r.Context(), "download.started", current(r).User.ID, v.CollectionID, v.ID); e != nil {
		s.fail(w, e)
		return
	}
	if _, e = stage.Seek(0, 0); e != nil {
		s.fail(w, e)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": v.Filename}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatInt(v.SizeBytes, 10))
	w.WriteHeader(200)
	count, e := io.Copy(w, stage)
	action := "download.completed"
	if e != nil || count != v.SizeBytes {
		action = "download.failed"
	}
	auditCtx, auditCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer auditCancel()
	_ = s.Store.SFTPDownloadAudit(auditCtx, action, current(r).User.ID, v.CollectionID, v.ID)
	auditFinished = true
}

func (s *Server) sftpProcessEvents(ctx context.Context, events []sftpgo.Event, accounts map[string]model.SFTPAccount, collections map[string]model.SFTPCollection) (string, error) {
	failure := ""
	for _, event := range events {
		if e := s.sftpReceiveEvent(ctx, event, accounts, collections); e != nil {
			code := sftpgo.ErrorCode(e)
			if code != "event_integrity_error" && code != "event_path_conflict" {
				return code, e
			}
			// Identity hash never embeds an attacker-controlled path into audit labels.
			body, _ := json.Marshal(struct {
				Instance, ID string
				Timestamp    int64
			}{event.InstanceID, event.ID, event.Timestamp})
			if event.ID == "" {
				body, _ = json.Marshal(event)
			}
			digest := sha256.Sum256(body)
			if e = s.Store.SFTPQuarantineReceipt(ctx, hex.EncodeToString(digest[:]), code, event.Timestamp); e != nil {
				return "database_error", e
			}
			failure = "quarantined_receipts"
		}
	}
	return failure, nil
}
