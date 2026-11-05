package worker

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func mailcowWorkerFixture(t *testing.T, handler http.HandlerFunc) (*Worker, model.ModuleInstance) {
	t.Helper()
	s := workerStore(t)
	ctx := context.Background()
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_MAILCOW_TEST")
	t.Setenv("PORTAL_SECRET_MAILCOW_TEST", "fixture-read-only-key")
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	guard, err := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{80}, "", testResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(server.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	instance, job, err := s.QueueModule(ctx, "test", uuid.NewString(), "", "install", model.ModuleRequest{ModuleID: "mailcow", Mode: "external", Name: "Mail test", Endpoint: "http://test-source", SecretRef: "env:PORTAL_SECRET_MAILCOW_TEST"})
	if err != nil {
		t.Fatal(err)
	}
	instance.ObservedState = "running"
	job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	return New(s, providers.New(guard, ""), func(string) {}), instance
}

func enableMailcowWorkerGroup(t *testing.T, w *Worker, id, group string, enabled bool) model.Integration {
	t.Helper()
	ctx := context.Background()
	snapshot, err := w.Store.MailcowSnapshot(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	settings := model.MailcowSettings{Revision: snapshot.Revision, Groups: map[string]model.MailcowGroupSettings{}}
	for key, value := range snapshot.Groups {
		settings.Groups[key] = model.MailcowGroupSettings{Enabled: value.Enabled, IntervalSeconds: value.IntervalSeconds}
	}
	value := settings.Groups[group]
	value.Enabled = enabled
	settings.Groups[group] = value
	if err = w.Store.SaveMailcowSettings(ctx, id, "test", settings); err != nil {
		t.Fatal(err)
	}
	source, err := store.Get[model.Integration](ctx, w.Store, "integration", snapshot.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func TestMailcowWorkerOnlyPollsOptedInGroupsAndHonorsInterval(t *testing.T) {
	var calls atomic.Int32
	w, instance := mailcowWorkerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/api/v1/get/mailbox/all" || r.Header.Get("X-API-Key") != "fixture-read-only-key" {
			t.Error("unexpected native Mailcow request")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	})
	ctx := context.Background()
	source, err := store.Get[model.Integration](ctx, w.Store, "integration", instance.IntegrationID)
	if err != nil {
		t.Fatal(err)
	}
	w.scheduleMailcow(ctx, source)
	w.pollWG.Wait()
	if calls.Load() != 0 {
		t.Fatal("disabled groups made requests")
	}
	source = enableMailcowWorkerGroup(t, w, instance.ID, "mailboxes", true)
	w.scheduleMailcow(ctx, source)
	w.pollWG.Wait()
	snapshot, err := w.Store.MailcowSnapshot(ctx, instance.ID)
	if err != nil || snapshot.Groups["mailboxes"].Status != "ok" || snapshot.Groups["mailboxes"].LastSuccess == nil {
		t.Fatal("native collection not cached", err)
	}
	w.scheduleMailcow(ctx, source)
	w.pollWG.Wait()
	if calls.Load() != 1 {
		t.Fatal("poll interval ignored or disabled groups requested")
	}
	for group, value := range snapshot.Groups {
		if group != "mailboxes" && (len(value.Data) != 0 && string(value.Data) != "null" || value.LastAttempt != nil) {
			t.Fatal("disabled group has synthetic data")
		}
	}
}

func TestMailcowWorkerDiscardsResultWhenDisabledDuringRequest(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	w, instance := mailcowWorkerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Write([]byte(`[]`))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	source := enableMailcowWorkerGroup(t, w, instance.ID, "mailboxes", true)
	w.scheduleMailcow(ctx, source)
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("native request did not start")
	}
	disabled := enableMailcowWorkerGroup(t, w, instance.ID, "mailboxes", false)
	close(release)
	w.pollWG.Wait()
	snapshot, err := w.Store.MailcowSnapshot(ctx, instance.ID)
	if err != nil || snapshot.Groups["mailboxes"].Status != "disabled" || snapshot.Groups["mailboxes"].LastSuccess != nil || snapshot.Groups["mailboxes"].Data != nil {
		t.Fatal("disabled in-flight result was accepted", err)
	}
	w.scheduleMailcow(ctx, disabled)
	w.pollWG.Wait()
	if calls.Load() != 1 {
		t.Fatal("disabled group kept polling")
	}
}
