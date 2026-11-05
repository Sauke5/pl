package worker

import (
	"context"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func (w *Worker) moduleJobTimeout(ctx context.Context, job model.Job) time.Duration {
	const normal = 360 * time.Second
	action, _ := job.Parameters["action"].(string)
	id, _ := job.Parameters["instance_id"].(string)
	if w.Store == nil || id == "" || (action != "install" && action != "enable") {
		return normal
	}
	lookup, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	instance, err := store.Get[model.ModuleInstance](lookup, w.Store, "module_instance", id)
	if err != nil || instance.Mode != "local" || instance.LastJobID != job.ID {
		return normal
	}
	if timeout := model.ModuleStartupControllerTimeout(instance.ModuleID, action); timeout > 0 {
		// Leave time to persist the controller outcome before the job expires.
		return timeout + 50*time.Second
	}
	return normal
}
