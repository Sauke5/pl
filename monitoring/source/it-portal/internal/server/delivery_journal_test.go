package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

type deliveryJournalController struct {
	statusFailure bool
	t             *testing.T
	db            *store.Store
	operation     *modules.DeliveryOperation
	ambiguous     bool
	submitted     int
	current       string
}

func (c *deliveryJournalController) Apply(context.Context, modules.Operation) (modules.Observation, error) {
	return modules.Observation{}, nil
}
func (c *deliveryJournalController) Delivery(ctx context.Context, action string, request *modules.DeliveryUpgrade) (modules.DeliveryStatus, error) {
	if action == "status" && c.statusFailure {
		return modules.DeliveryStatus{}, errors.New("status temporarily unavailable")
	}
	if action == "upgrade" || action == "module-upgrade" {
		c.submitted++
		// The durable original actor MUST exist before a successful/ambiguous launch.
		job, err := c.db.Job(ctx, request.OperationID)
		if err != nil || job.Actor != "local-admin" || job.Kind != "delivery" {
			c.t.Fatalf("launch before durable attribution: %#v %v", job, err)
		}
		kind := "upgrade"
		if action == "module-upgrade" {
			kind = "module_upgrade"
			if job.Parameters["version"] != "1.1.0" {
				c.t.Fatal("core version recorded as module version", job)
			}
		}
		c.operation = &modules.DeliveryOperation{OperationID: request.OperationID, Kind: kind, ModuleID: request.ModuleID, Version: "0.6.3", Phase: "downloading"}
		if c.ambiguous {
			return modules.DeliveryStatus{}, errors.New("acknowledgement lost")
		}
	}
	if action == "recover" {
		c.operation.Phase = "restoring"
	}
	return modules.DeliveryStatus{CoreAPI: 1, CurrentVersion: c.current, Modules: []modules.DeliveryModule{{ModuleID: "netmap", Version: "1.1.0", ArtifactSHA256: strings.Repeat("a", 64)}}, Operation: c.operation}, nil
}
func deliveryJournalSetup(t *testing.T) (*Server, apiIdentity, *deliveryJournalController) {
	s, admin := localUsersFixture(t)
	s.Config.PortableRelease = true
	c := &deliveryJournalController{t: t, db: s.Store, current: "0.6.2"}
	s.Modules = modules.New(s.Store, c)
	return s, admin, c
}
func deliveryJournalSubmit(t *testing.T, s *Server, admin apiIdentity, module bool, want int) string {
	t.Helper()
	id := uuid.NewString()
	path := "/api/v1/delivery/upgrade"
	body := map[string]any{"operation_id": id, "version": "0.6.3"}
	if module {
		path = "/api/v1/delivery/module-upgrade"
		body = map[string]any{"operation_id": id, "module_id": "netmap", "artifact_sha256": strings.Repeat("a", 64)}
	}
	response := apiCall(s, admin, "POST", path, body, nil)
	if response.Code != want {
		t.Fatalf("submit %d %s", response.Code, response.Body.String())
	}
	return id
}

func TestDeliveryJournalPersistsInitiatorAcrossRestartAndReadback(t *testing.T) {
	for _, module := range []bool{false, true} {
		t.Run(map[bool]string{false: "core", true: "module"}[module], func(t *testing.T) {
			s, admin, c := deliveryJournalSetup(t)
			id := deliveryJournalSubmit(t, s, admin, module, 200)
			before, err := s.Store.Job(context.Background(), id)
			if err != nil || before.Actor != "local-admin" || before.Status != "running" {
				t.Fatal(before, err)
			}
			if err = s.Store.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			// Reconstruct the API: no process-local actor/cache may be needed afterward.
			restarted := New(s.Store, s.Config, s.Providers, http.DefaultClient)
			restarted.Modules = modules.New(s.Store, c)
			reader := apiUser(t, restarted, "second-admin", true)
			c.operation.Phase = "complete"
			c.current = "0.6.3"
			response := apiCall(restarted, reader, "GET", "/api/v1/operations", nil, nil)
			if response.Code != 200 {
				t.Fatal(response.Code, response.Body.String())
			}
			job, err := s.Store.Job(context.Background(), id)
			if err != nil || job.Status != "succeeded" || job.Actor != "local-admin" {
				t.Fatal(job, err)
			}
			version := "0.6.3"
			if module {
				version = "1.1.0"
			}
			if job.Result["target_version"] != version {
				t.Fatal(job)
			}
			var count int
			if err = s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE body->>'kind'='job.succeeded' AND body #>> '{details,job_id}'=$1", id).Scan(&count); err != nil || count != 1 {
				t.Fatal(count, err)
			}
			for _, path := range []string{"/api/v1/jobs", "/api/v1/events", "/api/v1/event-journal", "/api/v1/delivery"} {
				if got := apiCall(restarted, reader, "GET", path, nil, nil); got.Code != 200 {
					t.Fatal(path, got.Code, got.Body.String())
				}
			}
			var after int
			_ = s.Store.Pool.QueryRow(context.Background(), "SELECT count(*) FROM audit_events WHERE body->>'kind'='job.succeeded' AND body #>> '{details,job_id}'=$1", id).Scan(&after)
			if after != count {
				t.Fatal("GET duplicated terminal audit")
			}
		})
	}
}

func TestDeliveryJournalAmbiguousRPCAndRecoveryKeepOriginalActor(t *testing.T) {
	s, admin, c := deliveryJournalSetup(t)
	c.ambiguous = true
	id := deliveryJournalSubmit(t, s, admin, true, 503)
	job, err := s.Store.Job(context.Background(), id)
	if err != nil || job.Status != "unknown" || job.Result["phase"] != "unconfirmed" {
		t.Fatal(job, err)
	}
	c.ambiguous = false
	c.operation.Phase = "recovery_required"
	c.operation.RecoveryMode = "rollback"
	recovery := apiUser(t, s, "recovery-admin", true)
	if got := apiCall(s, recovery, "GET", "/api/v1/delivery", nil, nil); got.Code != 200 {
		t.Fatal(got.Code)
	}
	job, _ = s.Store.Job(context.Background(), id)
	if job.Status != "unknown" || job.Result["phase"] != "recovery_required" {
		t.Fatal(job)
	}
	if got := apiCall(s, recovery, "POST", "/api/v1/delivery/recover", map[string]any{"operation_id": id}, nil); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	job, _ = s.Store.Job(context.Background(), id)
	if job.Status != "running" || job.Actor != "local-admin" {
		t.Fatal(job)
	}
	c.operation.Phase = "rolled_back"
	c.operation.RestoredSnapshot = true
	if got := apiCall(s, recovery, "GET", "/api/v1/events", nil, nil); got.Code != 200 {
		t.Fatal(got.Code)
	}
	job, _ = s.Store.Job(context.Background(), id)
	if job.Status != "failed" || job.Result["restored_snapshot"] != true || job.Actor != "local-admin" {
		t.Fatal(job)
	}
	var actor string
	if err = s.Store.Pool.QueryRow(context.Background(), "SELECT body->>'actor' FROM audit_events WHERE body->>'kind'='delivery.recovery_requested'").Scan(&actor); err != nil || actor != "recovery-admin" {
		t.Fatal(actor, err)
	}
	if c.submitted != 1 {
		t.Fatal("read/recovery relaunched update", c.submitted)
	}
}

func TestDeliveryJournalNeverAttributesLegacyOperationToReader(t *testing.T) {
	s, admin, c := deliveryJournalSetup(t)
	c.operation = &modules.DeliveryOperation{OperationID: uuid.NewString(), Kind: "module_upgrade", ModuleID: "netmap", Phase: "complete"}
	before, _ := s.Store.Jobs(context.Background())
	if got := apiCall(s, admin, "GET", "/api/v1/delivery", nil, nil); got.Code != 200 {
		t.Fatal(got.Code)
	}
	after, _ := s.Store.Jobs(context.Background())
	if len(before) != len(after) {
		t.Fatal("reader fabricated historical attribution")
	}
	// A selected digest must exist in the trusted catalog before actor intent/launch.
	got := apiCall(s, admin, "POST", "/api/v1/delivery/module-upgrade", map[string]any{"operation_id": uuid.NewString(), "module_id": "netmap", "artifact_sha256": strings.Repeat("b", 64)}, nil)
	if got.Code != 409 || c.submitted != 0 {
		t.Fatal(got.Code, c.submitted)
	}
	jobs, _ := s.Store.Jobs(context.Background())
	for _, j := range jobs {
		if j.Kind == "delivery" {
			t.Fatalf("unselectable artifact created intent: %#v", j)
		}
	}
}

func TestDeliveryJournalStrictSyncStopsNewMutationBeforeHostJournalReplacement(t *testing.T) {
	s, admin, c := deliveryJournalSetup(t)
	previousID := deliveryJournalSubmit(t, s, admin, false, 200)
	c.operation.Phase = "complete" // Host finished; its terminal proof is not yet copied.
	c.statusFailure = true
	nextID := deliveryJournalSubmit(t, s, admin, false, 503)
	if c.submitted != 1 {
		t.Fatal("new launch overwrote unconfirmed previous host journal")
	}
	if _, err := s.Store.Job(context.Background(), nextID); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("new intent created despite failed prerequisite sync", err)
	}
	previous, _ := s.Store.Job(context.Background(), previousID)
	if previous.Status != "running" {
		t.Fatal(previous)
	}
	c.statusFailure = false
	_ = deliveryJournalSubmit(t, s, admin, false, 200)
	previous, _ = s.Store.Job(context.Background(), previousID)
	if previous.Status != "succeeded" {
		t.Fatal("previous proof was lost", previous)
	}
}

func TestDeliveryJournalTerminalUUIDCannotRelaunchAfterHostJournalAdvanced(t *testing.T) {
	s, admin, c := deliveryJournalSetup(t)
	id := deliveryJournalSubmit(t, s, admin, false, 200)
	c.operation.Phase = "complete"
	if got := apiCall(s, admin, "GET", "/api/v1/delivery", nil, nil); got.Code != 200 {
		t.Fatal(got.Code)
	}
	c.operation = &modules.DeliveryOperation{OperationID: uuid.NewString(), Kind: "upgrade", Phase: "complete", Version: "0.6.4"}
	got := apiCall(s, admin, "POST", "/api/v1/delivery/upgrade", map[string]any{"operation_id": id, "version": "0.6.3"}, nil)
	if got.Code != 409 || c.submitted != 1 {
		t.Fatal("terminal durable UUID was redispatched", got.Code, c.submitted)
	}
	original, _ := s.Store.Job(context.Background(), id)
	if original.Status != "succeeded" || original.Actor != "local-admin" {
		t.Fatal(original)
	}
}
