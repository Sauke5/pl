package worker

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

func TestManagedModuleNeverUsesIndependentIntegrationPoller(t *testing.T) {
	var calls atomic.Int32
	w, s := testWorker(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`[]`))
	})
	i := workerIntegration(t, s, "alertmanager")
	i.ManagedModuleID = "module-owner"
	b, err := s.Save(context.Background(), "integration", i.ID, i.Revision, i, "test")
	if err != nil {
		t.Fatal(err)
	}
	i, err = store.Decode[model.Integration](b)
	if err != nil {
		t.Fatal(err)
	}
	w.schedule(context.Background())
	w.pollWG.Wait()
	if err = w.poll(context.Background(), i); err == nil || err.Error() != "module_refresh_required" {
		t.Fatalf("manual legacy refresh bypassed module lifecycle: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("managed integration was polled outside serialized module jobs")
	}
	actual, err := store.Get[model.Integration](context.Background(), s, "integration", i.ID)
	if err != nil || actual.LastAttempt != nil {
		t.Fatal("independent poller changed module-owned integration", err)
	}
}
