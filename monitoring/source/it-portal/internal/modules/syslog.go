package modules

import (
	"context"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type SyslogResponse = NativeControlReply

func (m *Manager) SyslogRequest(ctx context.Context, id, action string, payload any) (SyslogResponse, error) {
	if m == nil || m.Store == nil || !canonicalID(id) {
		return SyslogResponse{}, ErrApplicationUnavailable
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil || instance.ModuleID != "syslog" || instance.Mode != "local" || instance.DesiredState != "enabled" || instance.ObservedState != "running" {
		return SyslogResponse{}, ErrApplicationUnavailable
	}
	c, ok := m.Controller.(interface {
		SyslogRequest(context.Context, string, string, any) (SyslogResponse, error)
	})
	if !ok {
		return SyslogResponse{}, ErrApplicationUnavailable
	}
	return c.SyslogRequest(ctx, id, action, payload)
}

func (c *HostController) SyslogRequest(ctx context.Context, id, action string, payload any) (SyslogResponse, error) {
	switch action {
	case "receiver-get", "receiver-set", "sources", "messages":
	default:
		return SyslogResponse{}, ErrApplicationUnavailable
	}
	out, err := c.nativeControl(ctx, "/v1/syslog", id, action, payload, 8192)
	if err != nil {
		return SyslogResponse{}, err
	}
	switch out.Status {
	case 200, 400, 404, 409, 429, 503:
		return out, nil
	default:
		return SyslogResponse{}, ErrApplicationUnavailable
	}
}
