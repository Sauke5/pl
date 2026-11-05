package modules

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

var ErrInitialLoginUnavailable = errors.New("первоначальные данные входа недоступны")

// NativeInitialLogin contains only the human administrator bootstrap account.
// Provider tokens, bot accounts and infrastructure credentials never enter it.
type NativeInitialLogin struct {
	InstanceID string `json:"instance_id"`
	ModuleID   string `json:"module_id"`
	Service    string `json:"service"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	Path       string `json:"path"`
}

type NativeInitialLoginController interface {
	InitialLogin(context.Context, string, string, string) (NativeInitialLogin, error)
}

func initialLoginIdentity(kind, service string) (string, string, bool) {
	switch {
	case kind == "netmap" && service == "netbox":
		return "pl-admin", "/netmap/netbox/login/", true
	case kind == "netmap" && service == "gitea":
		return "pl-admin", "/netmap/gitea/user/login", true
	case kind == "bookstack" && service == "bookstack":
		return "admin@pl.invalid", "/wiki/login", true
	case kind == "grafana" && service == "grafana":
		return "admin", "/grafana/login", true
	default:
		return "", "", false
	}
}

func validInitialLogin(value NativeInitialLogin, id, kind, service string) bool {
	username, path, ok := initialLoginIdentity(kind, service)
	if !ok || value.InstanceID != id || value.ModuleID != kind || value.Service != service || value.Username != username || value.Path != path {
		return false
	}
	if service == "grafana" {
		// Only the pinned official image's initial human login, never legacy
		// pl-bootstrap credentials or an arbitrary provider-supplied secret.
		return value.Password == "admin"
	}
	// Newly created human accounts use eight random letters/digits. Persisted
	// bootstrap receipts retain their complete legacy password without rotation.
	if len(value.Password) == 8 {
		for _, char := range value.Password {
			if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') {
				return false
			}
		}
		return true
	}
	if service == "gitea" {
		if len(value.Password) != 40 {
			return false
		}
		for _, char := range value.Password {
			if char < 33 || char > 126 {
				return false
			}
		}
		return true
	}
	if len(value.Password) != 64 {
		return false
	}
	for _, char := range value.Password {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func (c *HostController) InitialLogin(ctx context.Context, id, kind, service string) (NativeInitialLogin, error) {
	var empty NativeInitialLogin
	if !canonicalID(id) {
		return empty, ErrInitialLoginUnavailable
	}
	if _, _, ok := initialLoginIdentity(kind, service); !ok {
		return empty, ErrInitialLoginUnavailable
	}
	payload, _ := json.Marshal(map[string]string{"instance_id": id, "module_id": kind, "service": service})
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	response, err := c.applicationRequest(ctx, "/v1/native/initial-login", payload, bytes.NewReader(payload), int64(len(payload)), false)
	if err != nil {
		return empty, ErrInitialLoginUnavailable
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || response.StatusCode != http.StatusOK || len(body) > 4096 {
		return empty, ErrInitialLoginUnavailable
	}
	var value NativeInitialLogin
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF || !validInitialLogin(value, id, kind, service) {
		return empty, ErrInitialLoginUnavailable
	}
	return value, nil
}

func (m *Manager) InitialLogin(ctx context.Context, id, service string) (NativeInitialLogin, error) {
	var empty NativeInitialLogin
	if m == nil || m.Store == nil || !canonicalID(id) {
		return empty, ErrInitialLoginUnavailable
	}
	controller, ok := m.Controller.(NativeInitialLoginController)
	if !ok {
		return empty, ErrInitialLoginUnavailable
	}
	load := func() (model.ModuleInstance, error) {
		instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
		if err != nil || instance.Mode != "local" || instance.DesiredState != "enabled" || instance.ObservedState != "running" {
			return instance, ErrInitialLoginUnavailable
		}
		if _, _, ok := initialLoginIdentity(instance.ModuleID, service); !ok {
			return instance, ErrInitialLoginUnavailable
		}
		return instance, nil
	}
	instance, err := load()
	if err != nil {
		return empty, err
	}
	value, err := controller.InitialLogin(ctx, id, instance.ModuleID, service)
	if err != nil || !validInitialLogin(value, id, instance.ModuleID, service) {
		return empty, ErrInitialLoginUnavailable
	}
	after, err := load()
	if err != nil || after.ModuleID != instance.ModuleID {
		return empty, ErrInitialLoginUnavailable
	}
	return value, nil
}
