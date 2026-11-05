package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
	"pl/portal/internal/worker"
)

var reconcileTestKey = []byte(strings.Repeat("r", 32))

type reconcileTestController struct {
	verifier  *modules.HostController
	mu        sync.Mutex
	op        modules.DeliveryOperation
	status    int
	applies   []modules.Operation
	endpoints map[string]string
	fail      bool
	stopAfter int
}

func reconcileController(t *testing.T) *reconcileTestController {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fixture-key")
	if err := os.WriteFile(path, reconcileTestKey, 0600); err != nil {
		t.Fatal(err)
	}
	verifier, err := modules.NewHostController(filepath.Join(dir, "unused.sock"), path)
	if err != nil {
		t.Fatal(err)
	}
	return &reconcileTestController{verifier: verifier, op: modules.DeliveryOperation{Kind: "upgrade", OperationID: uuid.NewString(), Phase: "reconciling"}, endpoints: map[string]string{}}
}

func (c *reconcileTestController) VerifyDeliveryReconcile(method, path, ts, sig string, raw []byte) bool {
	return c.verifier.VerifyDeliveryReconcile(method, path, ts, sig, raw)
}
func (c *reconcileTestController) Delivery(context.Context, string, *modules.DeliveryUpgrade) (modules.DeliveryStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status++
	op := c.op
	if c.stopAfter > 0 && c.status >= c.stopAfter {
		op.Phase = "complete"
	}
	return modules.DeliveryStatus{CoreAPI: 1, Operation: &op}, nil
}
func (c *reconcileTestController) Apply(_ context.Context, op modules.Operation) (modules.Observation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.applies = append(c.applies, op)
	if c.fail {
		return modules.Observation{}, errors.New("fixture native refresh failure")
	}
	return modules.Observation{State: "running", Version: "fixture-0.4.2", Endpoint: c.endpoints[op.InstanceID], OperationID: op.OperationID}, nil
}

func reconcileRequest(raw string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, modules.DeliveryReconcilePath, strings.NewReader(raw))
	r.RemoteAddr = "10.240.0.1:50123"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, reconcileTestKey)
	mac.Write([]byte("pl-delivery-reconcile-v1\n" + ts + "\nPOST\n/internal/delivery/reconcile\n" + raw))
	r.Header.Set("X-PL-Delivery-Timestamp", ts)
	r.Header.Set("X-PL-Delivery-Signature", hex.EncodeToString(mac.Sum(nil)))
	r.Header.Set("Content-Type", "application/json")
	return r
}
func reconcileBody(operation, request string) string {
	raw, _ := json.Marshal(modules.DeliveryReconcileRequest{OperationID: operation, RequestID: request})
	return string(raw)
}
func reconcileCall(s *Server, raw string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	s.RegisterDeliveryReconcileRoutes(mux)
	mux.ServeHTTP(w, reconcileRequest(raw))
	return w
}

func TestDeliveryReconcileAuthenticatesBeforeHostOrStoreIO(t *testing.T) {
	c := reconcileController(t)
	m := modules.New(nil, c)
	m.DeliveryEnabled = true
	s := &Server{Config: Config{OnDemandModules: true}, Modules: m}
	valid := reconcileBody(c.op.OperationID, uuid.NewString())
	for _, tc := range []struct {
		name   string
		change func(*http.Request)
	}{
		{"signature", func(r *http.Request) { r.Header.Set("X-PL-Delivery-Signature", strings.Repeat("0", 64)) }},
		{"method", func(r *http.Request) { r.Method = http.MethodGet }},
		{"query", func(r *http.Request) { r.URL.RawQuery = "instance=foreign" }},
		{"public peer", func(r *http.Request) { r.RemoteAddr = "192.0.2.5:12345"; r.Header.Set("X-Forwarded-For", "10.240.0.1") }},
		{"loopback peer", func(r *http.Request) { r.RemoteAddr = "127.0.0.1:12345" }},
		{"browser", func(r *http.Request) { r.Header.Set("Origin", "https://pl.example") }},
		{"cookie", func(r *http.Request) { r.Header.Set("Cookie", "portal_session=fixture") }},
		{"machine", func(r *http.Request) { r.Header.Set("Authorization", "Bearer fixture") }},
		{"duplicate timestamp", func(r *http.Request) {
			r.Header.Add("X-PL-Delivery-Timestamp", r.Header.Get("X-PL-Delivery-Timestamp"))
		}},
		{"duplicate signature", func(r *http.Request) {
			r.Header.Add("X-PL-Delivery-Signature", r.Header.Get("X-PL-Delivery-Signature"))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := reconcileRequest(valid)
			tc.change(r)
			w := httptest.NewRecorder()
			s.deliveryReconcile(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("forged request: %d %s", w.Code, w.Body.String())
			}
		})
	}
	for _, raw := range []string{
		`{}`, `[]`, `null`, `{"operation_id":"bad","request_id":"bad"}`,
		`{"operation_id":"` + c.op.OperationID + `","request_id":"` + uuid.NewString() + `","instance_id":"foreign"}`,
		`{"operation_id":"` + c.op.OperationID + `","operation_id":"` + c.op.OperationID + `","request_id":"` + uuid.NewString() + `"}`,
		valid + `{}`, `{"operation_id":null,"request_id":"` + uuid.NewString() + `"}`,
	} {
		w := reconcileCall(s, raw)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid exact body: %d %s", w.Code, w.Body.String())
		}
	}
	if w := reconcileCall(s, strings.Repeat("x", 4097)); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatal("body limit was not enforced")
	}
	if c.status != 0 || len(c.applies) != 0 {
		t.Fatal("unauthenticated/invalid request reached the host")
	}
	s.Config.OnDemandModules = false
	if w := reconcileCall(s, valid); w.Code != http.StatusNotFound {
		t.Fatal("legacy profile exposed delivery reconcile")
	}
}

func TestDeliveryReconcileRequiresExactActiveHostOperationBeforeStore(t *testing.T) {
	for _, tc := range []struct {
		kind, phase string
		wrongID     bool
	}{
		{"upgrade", "complete", false}, {"upgrade", "resuming", false}, {"upgrade", "failed", false},
		{"settings", "reconciling", false}, {"upgrade", "reconciling", true},
	} {
		c := reconcileController(t)
		c.op.Kind, c.op.Phase = tc.kind, tc.phase
		m := modules.New(nil, c)
		m.DeliveryEnabled = true
		s := &Server{Config: Config{OnDemandModules: true}, Modules: m}
		id := c.op.OperationID
		if tc.wrongID {
			id = uuid.NewString()
		}
		w := reconcileCall(s, reconcileBody(id, uuid.NewString()))
		if w.Code != http.StatusConflict || c.status != 1 {
			t.Fatalf("inactive operation reached Store: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestDeliveryReconcileFullHandlerAuthenticatesBeforeBootstrapSessionIO(t *testing.T) {
	c := reconcileController(t)
	m := modules.New(nil, c)
	m.DeliveryEnabled = true
	dir := t.TempDir()
	s := &Server{Config: Config{PortableRelease: true, OnDemandModules: true, LocalAdminPasswordChange: true,
		LocalAdminHashFile: filepath.Join(dir, "local-admin.hash"), MaintenanceDir: t.TempDir()}, Modules: m}
	if err := os.WriteFile(s.passwordChangeMarker(), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Config.MaintenanceDir, "active"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	raw := reconcileBody(c.op.OperationID, uuid.NewString())
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		r := reconcileRequest(raw)
		r.Method = method
		r.Header.Set("Cookie", "portal_session=forged-bootstrap-cookie")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r) // Server and Manager Store are nil: any IO panics.
		want := http.StatusUnauthorized
		if method == http.MethodGet {
			want = http.StatusMethodNotAllowed
		}
		if w.Code != want {
			t.Fatalf("full handler reached bootstrap Store before its own auth: %s %d %s", method, w.Code, w.Body.String())
		}
	}
	if c.status != 0 {
		t.Fatal("browser-shaped internal request reached host RPC")
	}
}

func reconcileSeed(t *testing.T, s *Server, moduleID, mode, desired string) model.ModuleInstance {
	t.Helper()
	ctx := context.Background()
	input := model.ModuleRequest{ModuleID: moduleID, Mode: mode, Name: moduleID + " fixture", Endpoint: "http://127.0.0.1:32000", AdditionalInstance: true}
	instance, job, err := s.Store.QueueModule(ctx, "local-admin", "seed:"+uuid.NewString(), "", "install", input)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	old := now.Add(-time.Hour)
	instance.ObservedState, instance.Endpoint, instance.Version = "running", input.Endpoint, "before-update"
	if moduleID == "xray" {
		instance.Endpoint = ""
	}
	instance.LastAttempt, instance.LastSuccess = &now, &old
	job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Store.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	instance, err = store.Get[model.ModuleInstance](ctx, s.Store, "module_instance", instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	if desired == "disabled" {
		instance, job, err = s.Store.QueueModule(ctx, "local-admin", "disable:"+uuid.NewString(), instance.ID, "disable", model.ModuleRequest{})
		if err != nil {
			t.Fatal(err)
		}
		instance.ObservedState = "disabled"
		job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
		if err = s.Store.Finish(ctx, job); err != nil {
			t.Fatal(err)
		}
	}
	return instance
}

func TestDeliveryReconcileRealPostgresWorkerPublishesFreshPortsAndReplaysSameJobs(t *testing.T) {
	s := apiFixture(t)
	s.Config.OnDemandModules = true
	c := reconcileController(t)
	c.op.Kind = "module_upgrade"
	m := modules.New(s.Store, c)
	m.DeliveryEnabled = true
	m.PublicURL = s.Config.PublicURL
	m.Poll = func(_ context.Context, integration model.Integration) (model.Snapshot, error) {
		return model.Snapshot{Candidates: []model.Candidate{}}, nil
	}
	s.Modules = m
	one := reconcileSeed(t, s, "prometheus", "local", "enabled")
	two := reconcileSeed(t, s, "doska", "local", "enabled")
	xray := reconcileSeed(t, s, "xray", "local", "enabled")
	disabled := reconcileSeed(t, s, "prometheus", "local", "disabled")
	external := reconcileSeed(t, s, "prometheus", "external", "enabled")
	c.endpoints[one.ID], c.endpoints[two.ID], c.endpoints[xray.ID] = "http://127.0.0.1:32971", "http://127.0.0.1:32972", ""
	// Reconciliation must wait for the earlier job, then queue its own fresh one.
	if _, _, err := s.Store.QueueModule(context.Background(), "system:modules", "earlier-refresh", one.ID, "refresh", model.ModuleRequest{}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	w := worker.New(s.Store, providers.New(nil, ""), func(string) {})
	w.Modules = m
	go func() { defer close(done); w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	})
	requestID := uuid.NewString()
	raw := reconcileBody(c.op.OperationID, requestID)
	response := reconcileCall(s, raw)
	if response.Code != http.StatusOK {
		jobs, _ := s.Store.Jobs(ctx)
		for _, job := range jobs {
			t.Logf("fixture job: id=%s key=%s status=%s params=%v result=%v", job.ID, job.IdempotencyKey, job.Status, job.Parameters, job.Result)
		}
	}
	result := apiDecode[modules.DeliveryReconcileResult](t, response, http.StatusOK)
	if !result.Ready || result.Instances != 3 || result.OperationID != c.op.OperationID {
		t.Fatalf("incomplete reconciliation: %#v", result)
	}
	for _, instance := range []model.ModuleInstance{one, two} {
		current, err := store.Get[model.ModuleInstance](ctx, s.Store, "module_instance", instance.ID)
		if err != nil {
			t.Fatal(err)
		}
		integration, err := store.Get[model.Integration](ctx, s.Store, "integration", current.IntegrationID)
		if err != nil || current.Endpoint != c.endpoints[instance.ID] || integration.URL != current.Endpoint || current.LastSuccess == nil {
			t.Fatal("ready preceded fresh committed integration binding")
		}
	}
	before, err := s.Store.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if w := reconcileCall(s, raw); w.Code != http.StatusOK {
		t.Fatalf("idempotent replay: %d %s", w.Code, w.Body.String())
	}
	after, _ := s.Store.Jobs(ctx)
	if len(after) != len(before) {
		t.Fatal("same request replay enqueued additional jobs")
	}
	var public map[string]any
	if json.Unmarshal(response.Body.Bytes(), &public) != nil || len(public) != 3 || strings.Contains(response.Body.String(), "127.0.0.1") {
		t.Fatal("response exposed private bindings")
	}
	c.mu.Lock()
	for _, applied := range c.applies {
		if applied.Action != "refresh" || applied.InstanceID == disabled.ID || applied.InstanceID == external.ID {
			t.Fatal("reconciler dispatched a foreign or disabled instance")
		}
	}
	c.fail = true
	c.mu.Unlock()
	failed := reconcileBody(c.op.OperationID, uuid.NewString())
	if response := reconcileCall(s, failed); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed native refresh returned ready: %d %s", response.Code, response.Body.String())
	}
	if response := reconcileCall(s, failed); response.Code != http.StatusServiceUnavailable {
		t.Fatal("failed request replay silently created a new attempt")
	}
	c.mu.Lock()
	c.fail = false
	c.mu.Unlock()
	if response := reconcileCall(s, reconcileBody(c.op.OperationID, uuid.NewString())); response.Code != http.StatusOK {
		t.Fatalf("new request could not retry failed refresh: %d %s", response.Code, response.Body.String())
	}
}

func TestDeliveryReconcileStopsWhenHostLeavesReconcilingAndHonorsShortDeadline(t *testing.T) {
	s := apiFixture(t)
	c := reconcileController(t)
	m := modules.New(s.Store, c)
	m.DeliveryEnabled = true
	s.Modules = m
	s.Config.OnDemandModules = true
	reconcileSeed(t, s, "prometheus", "local", "enabled")
	c.stopAfter = 3
	if response := reconcileCall(s, reconcileBody(c.op.OperationID, uuid.NewString())); response.Code != http.StatusConflict {
		t.Fatal("phase change returned ready", response.Code)
	}
	c.stopAfter = 0
	r := reconcileRequest(reconcileBody(c.op.OperationID, uuid.NewString()))
	ctx, cancel := context.WithTimeout(r.Context(), 250*time.Millisecond)
	defer cancel()
	r = r.WithContext(ctx)
	response := httptest.NewRecorder()
	s.deliveryReconcile(response, r)
	if response.Code != http.StatusGatewayTimeout {
		t.Fatalf("busy queue did not honor finite deadline: %d %s", response.Code, response.Body.String())
	}
}

func TestDeliveryReconcileRejectsSucceededJobWithStaleObservation(t *testing.T) {
	s := apiFixture(t)
	c := reconcileController(t)
	m := modules.New(s.Store, c)
	m.DeliveryEnabled = true
	s.Modules, s.Config.OnDemandModules = m, true
	instance := reconcileSeed(t, s, "prometheus", "local", "enabled")
	requestID := uuid.NewString()
	r := reconcileRequest(reconcileBody(c.op.OperationID, requestID))
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	responses := make(chan *httptest.ResponseRecorder, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w := httptest.NewRecorder()
		s.deliveryReconcile(w, r.WithContext(ctx))
		responses <- w
	}()
	t.Cleanup(func() { cancel(); <-done })
	var queued model.Job
	for queued.ID == "" && ctx.Err() == nil {
		jobs, err := s.Store.Jobs(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, job := range jobs {
			if job.IdempotencyKey == "delivery:"+c.op.OperationID+":"+requestID+":"+instance.ID {
				queued = job
			}
		}
		if queued.ID == "" {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if queued.ID == "" {
		t.Fatal("reconciliation did not enqueue its durable job")
	}
	current, err := store.Get[model.ModuleInstance](ctx, s.Store, "module_instance", instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	old := queued.CreatedAt.Add(-time.Minute)
	current.LastSuccess, current.ObservedState, current.Version = &old, "running", "stale-fixture"
	queued.Status, queued.Result = "succeeded", map[string]any{"instance": current}
	if err = s.Store.Finish(ctx, queued); err != nil {
		t.Fatal(err)
	}
	response := <-responses
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("a succeeded label bypassed freshness proof: %d %s", response.Code, response.Body.String())
	}
}

func TestDeliverySchedulerLegacyModeDoesNotCallDeliveryRPC(t *testing.T) {
	s := apiFixture(t)
	c := reconcileController(t)
	m := modules.New(s.Store, c)
	instance := reconcileSeed(t, s, "prometheus", "local", "enabled")
	// A completed old observation is due for the ordinary legacy scheduler.
	_, job, err := s.Store.QueueModule(context.Background(), "system:modules", "legacy-seed-refresh", instance.ID, "refresh", model.ModuleRequest{})
	if err != nil {
		t.Fatal(err)
	}
	instance, err = store.Get[model.ModuleInstance](context.Background(), s.Store, "module_instance", instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	instance.LastAttempt = nil
	job.Status, job.Result = "succeeded", map[string]any{"instance": instance}
	if err = s.Store.Finish(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	m.Schedule(context.Background())
	if c.status != 0 {
		t.Fatal("legacy/bundled scheduling acquired delivery RPC dependency")
	}
	jobs, err := s.Store.Jobs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	queued := 0
	for _, job := range jobs {
		if job.Status == "queued" && strings.HasPrefix(job.IdempotencyKey, "poll:") {
			queued++
		}
	}
	if queued != 1 {
		t.Fatal("legacy scheduler did not retain its ordinary poll queue")
	}
}
