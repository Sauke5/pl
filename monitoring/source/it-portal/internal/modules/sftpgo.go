package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type SFTPGoActor struct {
	Subject    string `json:"subject"`
	Admin      bool   `json:"admin"`
	SessionKey string `json:"session_key"`
}

type SFTPGoResponse struct {
	InstanceID string          `json:"instance_id"`
	Status     int             `json:"status"`
	Body       json.RawMessage `json:"body"`
}

func (m *Manager) sftpgoController(ctx context.Context, id string) (*HostController, error) {
	if m == nil || m.Store == nil || !canonicalID(id) {
		return nil, ErrApplicationUnavailable
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil || instance.ModuleID != "sftpgo" || instance.Mode != "local" || instance.DesiredState != "enabled" {
		return nil, ErrApplicationUnavailable
	}
	controller, ok := m.Controller.(*HostController)
	if !ok {
		return nil, ErrApplicationUnavailable
	}
	return controller, nil
}

// Only the gateway derives this key. Native login credentials remain scoped to
// one current Pl browser session and one installed file server.
func (m *Manager) SFTPGoActor(ctx context.Context, id, subject string, admin bool, sessionHash string) (SFTPGoActor, error) {
	controller, err := m.sftpgoController(ctx, id)
	if err != nil || subject == "" || len(subject) > 256 || len(sessionHash) != 64 {
		return SFTPGoActor{}, ErrApplicationUnavailable
	}
	if _, err = hex.DecodeString(sessionHash); err != nil {
		return SFTPGoActor{}, ErrApplicationUnavailable
	}
	mac := hmac.New(sha256.New, controller.key)
	mac.Write([]byte("pl-sftpgo-client-session-v1\n" + id + "\n" + subject + "\n" + sessionHash))
	return SFTPGoActor{Subject: subject, Admin: admin, SessionKey: hex.EncodeToString(mac.Sum(nil))}, nil
}

func (m *Manager) SFTPGoRequest(ctx context.Context, id, action string, actor SFTPGoActor, payload any) (SFTPGoResponse, error) {
	var out SFTPGoResponse
	controller, err := m.sftpgoController(ctx, id)
	if err != nil {
		return out, err
	}
	switch action {
	case "status", "settings-get", "settings-prepare", "users-list", "users-create", "users-update", "users-delete", "groups-list", "groups-save", "groups-delete", "folders-list", "folders-save", "folders-delete", "client-login", "client-logout", "files-list", "files-mkdir", "files-rename", "files-delete":
	default:
		return out, errors.New("неподдерживаемая операция файлового сервера")
	}
	body, err := json.Marshal(map[string]any{"instance_id": id, "action": action, "actor": actor, "payload": payload})
	if err != nil || len(body) > 1<<20 {
		return out, ErrApplicationUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	response, err := controller.applicationRequest(ctx, "/v1/sftpgo/request", body, bytes.NewReader(body), int64(len(body)), false)
	if err != nil {
		return out, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || response.StatusCode != http.StatusOK || len(raw) > 4<<20 || json.Unmarshal(raw, &out) != nil || out.InstanceID != id || !json.Valid(out.Body) {
		return SFTPGoResponse{}, ErrApplicationUnavailable
	}
	switch out.Status {
	case 200, 201, 204, 400, 401, 403, 404, 409, 429, 503:
		return out, nil
	default:
		return SFTPGoResponse{}, ErrApplicationUnavailable
	}
}

// Uploads are already hashed into a private disk spool by the authenticated
// browser handler. The host verifies the signed length and digest again.
func (m *Manager) SFTPGoStream(ctx context.Context, id, action string, actor SFTPGoActor, path string, body io.Reader, length int64, digest string) (*http.Response, error) {
	controller, err := m.sftpgoController(ctx, id)
	if err != nil || (action != "file-upload" && action != "file-download") || length < 0 || length > 1<<30 || len(digest) != 64 {
		return nil, ErrApplicationUnavailable
	}
	if _, err = hex.DecodeString(digest); err != nil {
		return nil, ErrApplicationUnavailable
	}
	metadata, err := json.Marshal(map[string]any{"instance_id": id, "action": action, "actor": actor, "payload": map[string]string{"path": path}, "body_length": length, "body_sha256": digest})
	if err != nil {
		return nil, err
	}
	return controller.applicationRequest(ctx, "/v1/sftpgo/stream", metadata, body, length, true)
}
