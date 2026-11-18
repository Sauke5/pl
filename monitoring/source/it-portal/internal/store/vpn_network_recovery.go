package store

import (
	"context"
	"strings"
	"time"

	"pl/portal/internal/model"
)

// The current observation may already have replaced the install error with a
// failed probe. Inspect the latest lifecycle job, including any later change
// of intent, while ignoring read-only refresh jobs.
func failedVPNNetworkInstall(ctx context.Context, db DB, instance model.ModuleInstance) (model.Job, error) {
	if instance.ModuleID != "ocserv" || instance.Mode != "local" || instance.DesiredState != "enabled" ||
		instance.ObservedState != "unavailable" || instance.Version != "" || instance.LastSuccess != nil {
		return model.Job{}, ErrNotFound
	}
	var raw []byte
	err := db.QueryRow(ctx, `SELECT body FROM jobs
WHERE kind='module' AND target=$1 AND body #>> '{parameters,action}' IS DISTINCT FROM 'refresh'
ORDER BY created_at DESC, id DESC LIMIT 1`, instance.ID).Scan(&raw)
	if err != nil {
		return model.Job{}, translate(err)
	}
	job, err := Decode[model.Job](raw)
	if err != nil {
		return model.Job{}, err
	}
	if job.Status != "failed" || job.Actor == "" || job.CreatedAt.IsZero() || job.FinishedAt == nil ||
		job.Parameters["action"] != "install" || job.Parameters["instance_id"] != instance.ID {
		return model.Job{}, ErrNotFound
	}
	result, err := Decode[model.ModuleInstance](encode(job.Result["instance"]))
	if err != nil {
		return model.Job{}, err
	}
	if result.ID != instance.ID || result.ModuleID != "ocserv" || result.Mode != "local" || result.LastJobID != job.ID ||
		result.DesiredState != "enabled" || result.ObservedState != "unavailable" || result.Version != "" || result.LastSuccess != nil ||
		!strings.HasPrefix(result.Error, "module_network_pool_exhausted:") {
		return model.Job{}, ErrNotFound
	}
	return job, nil
}

// VPNInstallNeedsNetworkRecovery covers failures which predate the update.
func (s *Store) VPNInstallNeedsNetworkRecovery(ctx context.Context, instance model.ModuleInstance, before time.Time) (bool, error) {
	_, found, err := s.vpnInstallBefore(ctx, instance, before)
	return found, err
}

func (s *Store) vpnInstallBefore(ctx context.Context, instance model.ModuleInstance, before time.Time) (model.Job, bool, error) {
	job, err := failedVPNNetworkInstall(ctx, s.Pool, instance)
	if err == ErrNotFound {
		return model.Job{}, false, nil
	}
	return job, err == nil && job.CreatedAt.Before(before), err
}

// QueueVPNNetworkRecovery uses the original actor and the ordinary enable
// operation. The worker checks the actor's current rights before applying it.
func (s *Store) QueueVPNNetworkRecovery(ctx context.Context, instance model.ModuleInstance, before time.Time) (bool, error) {
	job, beforeUpgrade, err := s.vpnInstallBefore(ctx, instance, before)
	if err != nil || job.ID == "" {
		return false, err
	}
	if !beforeUpgrade {
		// "Update all" can replace the host's completed core operation with
		// a module operation before this scheduler gets its next turn.
		err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs
WHERE kind='delivery' AND status='succeeded' AND body #>> '{parameters,action}'='upgrade'
AND body #>> '{result,phase}'='complete' AND finished_at IS NOT NULL AND created_at > $1
AND body #>> '{result,current_version}'=body #>> '{parameters,version}'
AND body #>> '{result,restored_snapshot}' IS DISTINCT FROM 'true')`, job.CreatedAt).Scan(&beforeUpgrade)
		if err != nil || !beforeUpgrade {
			return false, err
		}
	}
	_, _, err = s.queueModule(ctx, job.Actor, "vpn-network-recovery:"+job.ID, instance.ID, "enable", model.ModuleRequest{}, nil, job.ID)
	return err == nil, err
}
