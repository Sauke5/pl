package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func reconcileFixtureSignature(key []byte, timestamp, method, path string, raw []byte, domain string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(domain + timestamp + "\n" + method + "\n" + path + "\n"))
	mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestDeliveryReconcileHMACIsFiniteDomainSeparatedAndPerformsNoIO(t *testing.T) {
	key := []byte(strings.Repeat("r", 32))
	c := &HostController{key: key}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	expired := strconv.FormatInt(time.Now().Unix()-60, 10)
	future := strconv.FormatInt(time.Now().Unix()+60, 10)
	raw := []byte(`{"operation_id":"727b18f8-99da-410f-b94f-e677f2967731","request_id":"e211a233-c5ab-4437-9bf9-4b3a603347af"}`)
	signature := reconcileFixtureSignature(key, ts, "POST", "/internal/delivery/reconcile", raw, "pl-delivery-reconcile-v1\n")
	if !c.VerifyDeliveryReconcile(http.MethodPost, DeliveryReconcilePath, ts, signature, raw) {
		t.Fatal("exact host signature rejected")
	}
	for _, tc := range []struct {
		name, method, path, timestamp, signature string
		body                                     []byte
	}{
		{"method", "GET", DeliveryReconcilePath, ts, signature, raw},
		{"path", "POST", DeliveryReconcilePath + "/extra", ts, signature, raw},
		{"body", "POST", DeliveryReconcilePath, ts, signature, append(append([]byte{}, raw...), ' ')},
		{"another request", "POST", DeliveryReconcilePath, ts, signature, []byte(strings.Replace(string(raw), "e211a233", "a211a233", 1))},
		{"expired", "POST", DeliveryReconcilePath, expired, reconcileFixtureSignature(key, expired, "POST", DeliveryReconcilePath, raw, "pl-delivery-reconcile-v1\n"), raw},
		{"future", "POST", DeliveryReconcilePath, future, reconcileFixtureSignature(key, future, "POST", DeliveryReconcilePath, raw, "pl-delivery-reconcile-v1\n"), raw},
		{"noncanonical timestamp", "POST", DeliveryReconcilePath, "+" + ts, reconcileFixtureSignature(key, "+"+ts, "POST", DeliveryReconcilePath, raw, "pl-delivery-reconcile-v1\n"), raw},
		{"upper hex", "POST", DeliveryReconcilePath, ts, strings.ToUpper(signature), raw},
		{"short hex", "POST", DeliveryReconcilePath, ts, signature[:62], raw},
		{"ordinary host domain", "POST", DeliveryReconcilePath, ts, reconcileFixtureSignature(key, ts, "POST", DeliveryReconcilePath, raw, ""), raw},
		{"oversize", "POST", DeliveryReconcilePath, ts, signature, make([]byte, 4097)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if c.VerifyDeliveryReconcile(tc.method, tc.path, tc.timestamp, tc.signature, tc.body) {
				t.Fatal("forged or unbounded message accepted")
			}
		})
	}
	manager := New(nil, c)
	if manager.VerifyDeliveryReconcile("POST", DeliveryReconcilePath, ts, signature, raw) {
		t.Fatal("legacy manager acquired a delivery capability")
	}
	manager.DeliveryEnabled = true
	if !manager.VerifyDeliveryReconcile("POST", DeliveryReconcilePath, ts, signature, raw) {
		t.Fatal("manager did not forward the pure key verifier")
	}
}

type reconcileScheduleController struct {
	status DeliveryStatus
	err    error
	calls  int
}

func (c *reconcileScheduleController) Apply(context.Context, Operation) (Observation, error) {
	return Observation{}, errors.New("unexpected apply")
}
func (c *reconcileScheduleController) Delivery(context.Context, string, *DeliveryUpgrade) (DeliveryStatus, error) {
	c.calls++
	return c.status, c.err
}

func TestDeliveryReconcileAcceptsCommittedConfigurationPhase(t *testing.T) {
	id := "727b18f8-99da-410f-b94f-e677f2967731"
	c := &reconcileScheduleController{status: DeliveryStatus{CoreAPI: 1,
		Operation: &DeliveryOperation{Kind: "configuration", OperationID: id, Phase: "reconciling"}}}
	m := New(nil, c)
	m.DeliveryEnabled = true
	if err := m.deliveryReconcileActive(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.deliveryReconcileActive(context.Background(), "other-operation"); err == nil {
		t.Fatal("configuration callback accepted a different operation")
	}
}

func TestDeliverySchedulerSuppressesMaintenanceBeforeAnyStoreRead(t *testing.T) {
	c := &reconcileScheduleController{status: DeliveryStatus{CoreAPI: 1}}
	m := New(nil, c)
	m.DeliveryEnabled = true
	for _, phase := range []string{"queued", "downloading", "quiescing", "snapshot", "applying", "verifying", "resuming", "recovery_required", "unknown"} {
		c.status.Operation = &DeliveryOperation{Kind: "upgrade", Phase: phase}
		m.Schedule(context.Background()) // A Store access would panic: Store is nil.
		if m.deliveryScheduleAllowed(context.Background()) {
			t.Fatal("scheduler admitted an unready phase", phase)
		}
	}
	for _, phase := range []string{"reconciling", "complete", "failed", "rolled_back"} {
		c.status.Operation.Phase = phase
		if !m.deliveryScheduleAllowed(context.Background()) {
			t.Fatal("scheduler denied a permitted phase", phase)
		}
	}
	c.status.Operation = nil
	if !m.deliveryScheduleAllowed(context.Background()) {
		t.Fatal("idle delivery controller suppressed scheduling")
	}
	c.err = errors.New("host unavailable")
	m.Schedule(context.Background())
}
