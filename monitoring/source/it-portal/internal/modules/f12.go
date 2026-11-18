package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

const F12ChunkLimit = 4 << 20
const F12ImageLimit = 32 << 30

type F12Response struct {
	InstanceID string          `json:"instance_id"`
	Status     int             `json:"status"`
	Body       json.RawMessage `json:"body"`
}

// The actor binds unfinished uploads to one current browser login and installation.
// Only the controller and this gateway possess the signing key.
func (m *Manager) F12Request(ctx context.Context, id, sessionHash, subject, action string, payload any, chunk []byte) (F12Response, error) {
	if m == nil || m.Store == nil || !canonicalID(id) || subject == "" || len(sessionHash) != 64 {
		return F12Response{}, ErrApplicationUnavailable
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil || instance.ModuleID != "f12" || instance.Mode != "local" || instance.DesiredState != "enabled" || instance.ObservedState != "running" {
		return F12Response{}, ErrApplicationUnavailable
	}
	c, ok := m.Controller.(*HostController)
	if !ok || c == nil {
		return F12Response{}, ErrApplicationUnavailable
	}
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte("pl-f12-upload-session-v1\n" + id + "\n" + subject + "\n" + sessionHash))
	return c.f12Request(ctx, id, hex.EncodeToString(mac.Sum(nil)), action, payload, chunk)
}

func (c *HostController) f12Request(ctx context.Context, id, actor, action string, payload any, chunk []byte) (F12Response, error) {
	metadata := map[string]any{"instance_id": id, "actor": actor, "action": action, "payload": payload}
	stream := action == "upload-chunk"
	endpoint := "/v1/f12/request"
	switch action {
	case "library", "menu", "publish", "upload-start", "upload-finish", "upload-cancel":
		if chunk != nil {
			return F12Response{}, ErrApplicationUnavailable
		}
	case "upload-chunk":
		if len(chunk) == 0 || len(chunk) > F12ChunkLimit {
			return F12Response{}, ErrApplicationUnavailable
		}
		sum := sha256.Sum256(chunk)
		metadata["body_length"] = len(chunk)
		metadata["body_sha256"] = hex.EncodeToString(sum[:])
		endpoint = "/v1/f12/stream"
	default:
		return F12Response{}, ErrApplicationUnavailable
	}
	meta, err := json.Marshal(metadata)
	if err != nil || len(meta) > 32<<10 {
		return F12Response{}, ErrApplicationUnavailable
	}
	data := meta
	if stream {
		data = chunk
	}
	ctx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	response, err := c.applicationRequest(ctx, endpoint, meta, bytes.NewReader(data), int64(len(data)), stream)
	if err != nil {
		return F12Response{}, err
	}
	defer response.Body.Close()
	const limit = 4 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	var reply F12Response
	if err != nil || len(body) > limit || response.StatusCode != http.StatusOK || json.Unmarshal(body, &reply) != nil || reply.InstanceID != id || len(reply.Body) == 0 || reply.Body[0] != '{' {
		return F12Response{}, ErrApplicationUnavailable
	}
	switch reply.Status {
	case 200, 201, 400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503, 507:
		return reply, nil
	case 202:
		if action == "upload-finish" {
			return reply, nil
		}
	}
	return F12Response{}, ErrApplicationUnavailable
}
