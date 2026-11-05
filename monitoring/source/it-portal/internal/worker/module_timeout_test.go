package worker

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestModuleJobTimeoutUsesPersistedInstance(t *testing.T) {
	s := workerStore(t)
	w := &Worker{Store: s}
	ctx := context.Background()
	for _, module := range []string{"netmap", "prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "bookstack"} {
		instance, job, err := s.QueueModule(ctx, "test", uuid.NewString(), "", "install", model.ModuleRequest{ModuleID: module, Mode: "local", Name: module})
		if err != nil {
			t.Fatal(err)
		}
		// A caller-provided module name must never grant a longer deadline.
		job.Parameters["module_id"] = "unknown"
		want := 56 * time.Minute
		if module == "netmap" {
			want = 72*time.Minute + 50*time.Second
		}
		if got := w.moduleJobTimeout(ctx, job); got != want {
			t.Fatalf("%s: got %v want %v", module, got, want)
		}
		for _, action := range []string{"enable", "refresh", "disable", "remove", "configure", "read"} {
			job.Parameters["action"] = action
			actionWant := 360 * time.Second
			if action == "enable" {
				actionWant = want
			}
			if got := w.moduleJobTimeout(ctx, job); got != actionWant {
				t.Fatalf("%s/%s: got %v want %v", module, action, got, actionWant)
			}
		}
		job.Parameters["action"] = "install"
		job.ID = uuid.NewString()
		if got := w.moduleJobTimeout(ctx, job); got != 360*time.Second {
			t.Fatal("stale job received startup budget")
		}
		after, err := store.Get[model.ModuleInstance](ctx, s, "module_instance", instance.ID)
		if err != nil || after.Revision != instance.Revision || after.LastJobID != instance.LastJobID {
			t.Fatal("timeout lookup changed persisted instance", err)
		}
	}
}

func TestModuleJobTimeoutUnavailableInstanceKeepsNormalBudget(t *testing.T) {
	job := model.Job{ID: uuid.NewString(), Parameters: map[string]any{"action": "install", "instance_id": uuid.NewString(), "module_id": "netmap"}}
	if got := (&Worker{}).moduleJobTimeout(context.Background(), job); got != 360*time.Second {
		t.Fatal("missing store granted extended timeout")
	}
	w := &Worker{Store: workerStore(t)}
	if got := w.moduleJobTimeout(context.Background(), job); got != 360*time.Second {
		t.Fatal("missing instance granted extended timeout")
	}
	_, err := w.Store.Save(context.Background(), "module_instance", job.Parameters["instance_id"].(string), 0, model.ModuleInstance{ID: job.Parameters["instance_id"].(string), ModuleID: "netmap", Mode: "external", LastJobID: job.ID}, "test")
	if err != nil {
		t.Fatal(err)
	}
	if got := w.moduleJobTimeout(context.Background(), job); got != 360*time.Second {
		t.Fatal("external instance granted extended timeout")
	}
	instance := model.ModuleInstance{ID: uuid.NewString(), ModuleID: "unknown", Mode: "local", LastJobID: job.ID}
	if _, err = w.Store.Save(context.Background(), "module_instance", instance.ID, 0, instance, "test"); err != nil {
		t.Fatal(err)
	}
	job.Parameters["instance_id"] = instance.ID
	job.Parameters["module_id"] = "grafana"
	if got := w.moduleJobTimeout(context.Background(), job); got != 360*time.Second {
		t.Fatal("caller-supplied module name granted an unknown stored instance extended timeout")
	}
}
