package server

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"pl/portal/internal/organization"
)

const doskaADRefreshBatch = 25

type DoskaDirectorySync struct {
	store  *organization.Store
	source *DoskaADSource
	mu     sync.Mutex
}

type DoskaDirectorySyncResult struct{ Refreshed, Discovered int }

func NewDoskaDirectorySync(store *organization.Store, source *DoskaADSource) (*DoskaDirectorySync, error) {
	if store == nil || source == nil {
		return nil, errors.New("Doska directory sync requires store and AD source")
	}
	return &DoskaDirectorySync{store: store, source: source}, nil
}

// RefreshSubject is the login hook after RegisterADLogin. Registration itself
// does not prove membership freshness. Errors leave last-good facts untouched.
func (s *DoskaDirectorySync) RefreshSubject(ctx context.Context, subject string, now time.Time) (organization.Projection, error) {
	p, err := s.store.ADPlan(ctx, s.source.Namespace(), subject, "", 1)
	if err != nil {
		return organization.Projection{}, err
	}
	observations, err := s.source.ReadPlan(ctx, p, now)
	if err != nil {
		return organization.Projection{}, err
	}
	if _, err = s.store.ApplyADObservations(ctx, p, observations, "ad-sync", now); err != nil {
		return organization.Projection{}, err
	}
	return s.store.Lookup(ctx, subject, now)
}

// RefreshOnce reads known GUIDs in bounded batches, then optionally discovers
// users only through explicitly configured scope groups. There is no user-wide
// LDAP scan and no fallback from an AD failure to a successful empty result.
func (s *DoskaDirectorySync) RefreshOnce(ctx context.Context, now time.Time) (DoskaDirectorySyncResult, error) {
	var result DoskaDirectorySyncResult
	if now.IsZero() {
		return result, organization.ErrInvalid
	}
	if !s.mu.TryLock() {
		return result, errors.New("doska_directory_sync_busy")
	}
	defer s.mu.Unlock()
	after := ""
	for {
		p, err := s.store.ADPlan(ctx, s.source.Namespace(), "", after, doskaADRefreshBatch)
		if err != nil {
			return result, err
		}
		if len(p.Identities) > 0 {
			observations, err := s.source.ReadPlan(ctx, p, now)
			if err != nil {
				return result, err
			}
			updated, err := s.store.ApplyADObservations(ctx, p, observations, "ad-sync", now)
			if err != nil {
				return result, err
			}
			result.Refreshed += len(updated)
		}
		if p.NextSubject == "" {
			break
		}
		after = p.NextSubject
	}
	if s.source.HasDiscoveryScope() {
		// Discovery is deliberately bounded to a pilot-sized identity set. Fail
		// closed rather than silently omit expected revisions beyond this bound.
		p, err := s.store.ADPlan(ctx, s.source.Namespace(), "", "", organization.MaxADBatch)
		if err != nil {
			return result, err
		}
		if p.NextSubject != "" {
			return result, errors.New("doska_ad_discovery_known_identity_bound")
		}
		p, observations, err := s.source.Discover(ctx, p, now)
		if err != nil {
			return result, err
		}
		if len(observations) > 0 {
			updated, err := s.store.ApplyADObservations(ctx, p, observations, "ad-discovery", now)
			if err != nil {
				return result, err
			}
			result.Discovered = len(updated)
		}
	}
	return result, nil
}

// Run performs an immediate bounded refresh and repeats every ten minutes.
// Parent cancellation stops both LDAP work and the scheduler. Only the stage
// and generic outcome are logged; LDAP diagnostics and credentials are omitted.
func (s *DoskaDirectorySync) Run(ctx context.Context) {
	refresh := func() {
		if _, err := s.RefreshOnce(ctx, time.Now().UTC()); err != nil && ctx.Err() == nil {
			slog.Warn("doska_directory_sync_failed")
		}
	}
	refresh()
	ticker := time.NewTicker(organization.DefaultSyncInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}
