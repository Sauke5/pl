package server

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"time"

	"pl/portal/internal/connectorcredentials"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/netguard"
	"pl/portal/internal/store"
)

type connectorCredentialService struct {
	codec *connectorcredentials.Codec
	guard *netguard.Guard
}

// InitConnectorCredentials enables write-only credentials for installations
// carrying their independent persistent key. Legacy file/env references retain
// their existing policy and remain available without this capability.
func (s *Server) InitConnectorCredentials(keyFile string, guard *netguard.Guard) error {
	if keyFile == "" {
		return nil
	}
	info, err := os.Lstat(keyFile)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0007 != 0 || info.Size() != 32 || guard == nil || s.Providers == nil || s.Store == nil {
		return errors.New("integration credential key is unavailable or unsafe")
	}
	key, err := os.ReadFile(keyFile)
	if err != nil {
		return errors.New("integration credential key is unavailable")
	}
	codec, err := connectorcredentials.New(key)
	for n := range key {
		key[n] = 0
	}
	if err != nil {
		return errors.New("integration credential key is invalid")
	}
	s.connectorCredentials = &connectorCredentialService{codec: codec, guard: guard}
	s.Providers.MailcowCredential = func(ctx context.Context, integration model.Integration) (string, *netguard.Guard, error) {
		if integration.Kind != "mailcow" || integration.SecretRef != "managed:"+integration.ID {
			return "", nil, netguard.ErrPolicyDenied
		}
		credential, err := s.Store.IntegrationCredential(ctx, integration.ID)
		if err != nil {
			return "", nil, errors.New("integration credential is unavailable")
		}
		origin, err := connectorcredentials.CanonicalOrigin(integration.URL)
		if err != nil || origin != credential.Origin {
			return "", nil, netguard.ErrPolicyDenied
		}
		bound, err := guard.BoundOrigin(credential.Origin, credential.ApprovedIPs)
		if err != nil {
			return "", nil, netguard.ErrPolicyDenied
		}
		secret, err := codec.Open(integration.ID, credential.Origin, credential.Envelope)
		return secret, bound, err
	}
	if s.Modules != nil {
		s.Modules.NetMap = modules.NewNetMapConnector(guard, func(ctx context.Context, integration model.Integration) ([]byte, *netguard.Guard, error) {
			if integration.Kind != "netmap" || integration.SecretRef != "managed:"+integration.ID || integration.Config["module_mode"] != "external" {
				return nil, nil, modules.ErrNetMapConnection
			}
			credential, err := s.Store.IntegrationCredential(ctx, integration.ID)
			if err != nil {
				return nil, nil, modules.ErrNetMapConnection
			}
			origin, err := connectorcredentials.CanonicalOrigin(integration.URL)
			if err != nil || origin != integration.URL || origin != credential.Origin {
				return nil, nil, modules.ErrNetMapConnection
			}
			bound, err := guard.BoundOrigin(credential.Origin, credential.ApprovedIPs)
			if err != nil {
				return nil, nil, modules.ErrNetMapConnection
			}
			secret, err := codec.Open(integration.ID, credential.Origin, credential.Envelope)
			if err != nil {
				return nil, nil, modules.ErrNetMapConnection
			}
			key, err := modules.NetMapGatewayKey(secret)
			return key, bound, err
		})
	}
	return nil
}

func (s *Server) prepareNetMapCredential(ctx context.Context, endpoint, value string) (string, *store.ModuleCredential, error) {
	if s.connectorCredentials == nil || s.Modules == nil || s.Modules.NetMap == nil {
		return "", nil, modules.ErrNetMapConnection
	}
	key, err := modules.NetMapGatewayKey(value)
	if err != nil {
		return "", nil, err
	}
	defer clear(key)
	origin, ips, err := s.Modules.NetMap.Approve(ctx, endpoint, s.Config.PublicURL, key)
	if err != nil {
		return "", nil, err
	}
	secret := hex.EncodeToString(key)
	codec := s.connectorCredentials.codec
	return origin, &store.ModuleCredential{Fingerprint: codec.Fingerprint(secret), Origin: origin, ApprovedIPs: ips,
		Seal: func(id string) ([]byte, error) { return codec.Seal(id, origin, secret) }}, nil
}

func validConnectorKey(value string) bool {
	if len(value) == 0 || len(value) > 4096 {
		return false
	}
	for _, ch := range value {
		if ch < 0x21 || ch > 0x7e {
			return false
		}
	}
	return true
}

func (s *Server) prepareConnectorCredential(ctx context.Context, endpoint, key string) (*store.ModuleCredential, error) {
	service := s.connectorCredentials
	if service == nil || !validConnectorKey(key) {
		return nil, store.ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	origin, ips, err := service.guard.ApproveConnector(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	return &store.ModuleCredential{Fingerprint: service.codec.Fingerprint(key), Origin: origin, ApprovedIPs: ips,
		Seal: func(integrationID string) ([]byte, error) { return service.codec.Seal(integrationID, origin, key) }}, nil
}
