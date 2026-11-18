package modules

import (
	"context"
	"errors"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

var ErrOcservDisabled = errors.New("VPN module is disabled")

func (m *Manager) OcservRequest(ctx context.Context, id, action string, payload any) (NativeControlReply, error) {
	if m == nil || m.Store == nil {
		return NativeControlReply{}, ErrApplicationUnavailable
	}
	if !canonicalID(id) {
		return NativeControlReply{}, store.ErrNotFound
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil {
		return NativeControlReply{}, err
	}
	if instance.ModuleID != "ocserv" || instance.Mode != "local" || instance.DesiredState == "removed" {
		return NativeControlReply{}, store.ErrNotFound
	}
	if instance.DesiredState == "disabled" {
		return NativeControlReply{}, ErrOcservDisabled
	}
	if instance.DesiredState != "enabled" || instance.ObservedState != "running" {
		return NativeControlReply{}, ErrApplicationUnavailable
	}
	c, ok := m.Controller.(interface {
		OcservRequest(context.Context, string, string, any) (NativeControlReply, error)
	})
	if !ok {
		return NativeControlReply{}, ErrApplicationUnavailable
	}
	return c.OcservRequest(ctx, id, action, payload)
}

func (c *HostController) OcservRequest(ctx context.Context, id, action string, payload any) (NativeControlReply, error) {
	switch action {
	case "state", "profile", "grant", "revoke", "terminate":
	default:
		return NativeControlReply{}, ErrApplicationUnavailable
	}
	out, err := c.nativeControl(ctx, "/v1/ocserv", id, action, payload, 16384)
	if err != nil {
		return NativeControlReply{}, err
	}
	switch out.Status {
	case 200, 400, 404, 409, 422, 429, 503:
		return out, nil
	default:
		return NativeControlReply{}, ErrApplicationUnavailable
	}
}
