package modules

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

type NativeControlReply struct {
	InstanceID string          `json:"instance_id"`
	Status     int             `json:"status"`
	Body       json.RawMessage `json:"body"`
}

func (c *HostController) nativeControl(ctx context.Context, endpoint, id, action string, payload any, limit int) (NativeControlReply, error) {
	body, err := json.Marshal(map[string]any{"instance_id": id, "action": action, "payload": payload})
	if err != nil || !canonicalID(id) || len(body) > limit {
		return NativeControlReply{}, ErrApplicationUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	response, err := c.applicationRequest(ctx, endpoint, body, bytes.NewReader(body), int64(len(body)), false)
	if err != nil {
		return NativeControlReply{}, err
	}
	defer response.Body.Close()
	const maxResponse = 4 << 20
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	var out NativeControlReply
	if err != nil || len(raw) > maxResponse || response.StatusCode != http.StatusOK || json.Unmarshal(raw, &out) != nil || out.InstanceID != id || len(out.Body) == 0 || out.Body[0] != '{' {
		return NativeControlReply{}, ErrApplicationUnavailable
	}
	return out, nil
}
