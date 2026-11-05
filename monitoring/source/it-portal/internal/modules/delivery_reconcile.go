package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

const DeliveryReconcilePath = "/internal/delivery/reconcile"
const deliveryReconcileDomain = "pl-delivery-reconcile-v1\n"

var (
	ErrDeliveryReconcileInvalid  = errors.New("delivery_reconcile_invalid")
	ErrDeliveryReconcileInactive = errors.New("delivery_not_reconciling")
	ErrDeliveryReconcileFailed   = errors.New("delivery_reconcile_failed")
	ErrDeliveryReconcileTimeout  = errors.New("delivery_reconcile_timeout")
)

type DeliveryReconcileRequest struct {
	OperationID string `json:"operation_id"`
	RequestID   string `json:"request_id"`
}

type DeliveryReconcileResult struct {
	OperationID string `json:"operation_id"`
	Ready       bool   `json:"ready"`
	Instances   int    `json:"instances"`
}

// VerifyDeliveryReconcile authenticates bytes only. It never performs a host
// request or reads the Store, and the shared key stays inside HostController.
func (c *HostController) VerifyDeliveryReconcile(method, path, timestamp, signature string, body []byte) bool {
	if c == nil || len(c.key) != 32 || method != http.MethodPost || path != DeliveryReconcilePath || len(body) > 4096 {
		return false
	}
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	now := time.Now().Unix()
	if err != nil || strconv.FormatInt(ts, 10) != timestamp || ts < now-30 || ts > now+30 {
		return false
	}
	provided, err := hex.DecodeString(signature)
	if err != nil || len(provided) != sha256.Size || hex.EncodeToString(provided) != signature {
		return false
	}
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write([]byte(deliveryReconcileDomain + timestamp + "\nPOST\n" + DeliveryReconcilePath + "\n"))
	_, _ = mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}

func (m *Manager) VerifyDeliveryReconcile(method, path, timestamp, signature string, body []byte) bool {
	if m == nil || !m.DeliveryEnabled {
		return false
	}
	verifier, ok := m.Controller.(interface {
		VerifyDeliveryReconcile(string, string, string, string, []byte) bool
	})
	return ok && verifier.VerifyDeliveryReconcile(method, path, timestamp, signature, body)
}

func (m *Manager) deliveryScheduleAllowed(ctx context.Context) bool {
	status, err := m.Delivery(ctx, "status", nil)
	if err != nil {
		return false
	}
	if status.Operation == nil {
		return true
	}
	switch status.Operation.Phase {
	case "complete", "failed", "rolled_back", "reconciling":
		return true
	default:
		return false
	}
}

func (m *Manager) deliveryReconcileActive(ctx context.Context, id string) error {
	if m == nil || !m.DeliveryEnabled {
		return ErrDeliveryReconcileInactive
	}
	status, err := m.Delivery(ctx, "status", nil)
	if err != nil {
		return ErrDeliveryReconcileInactive
	}
	op := status.Operation
	if op == nil || op.OperationID != id || op.Phase != "reconciling" || op.Kind != "upgrade" && op.Kind != "module_upgrade" && op.Kind != "configuration" {
		return ErrDeliveryReconcileInactive
	}
	return nil
}

func nativeReconcileInstance(instance model.ModuleInstance) bool {
	return instance.Mode == "local" && instance.DesiredState == "enabled" && canonicalID(instance.ID) && deliveredModule(instance.ModuleID)
}

func (m *Manager) deliveryReconcileFinished(ctx context.Context, id string, job model.Job) (bool, error) {
	if job.Status == "queued" || job.Status == "running" {
		return false, nil
	}
	if job.Status != "succeeded" || job.Actor != "system:modules" || job.Parameters["instance_id"] != id || job.Parameters["action"] != "refresh" {
		return false, ErrDeliveryReconcileFailed
	}
	var observed model.ModuleInstance
	data, err := json.Marshal(job.Result["instance"])
	if err != nil || json.Unmarshal(data, &observed) != nil || observed.ID != id || !nativeReconcileInstance(observed) ||
		observed.ObservedState != "running" || observed.Error != "" || observed.Version == "" || observed.LastSuccess == nil || observed.LastSuccess.Before(job.CreatedAt) {
		return false, ErrDeliveryReconcileFailed
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil || !nativeReconcileInstance(instance) || instance.ModuleID != observed.ModuleID || instance.ObservedState != "running" ||
		instance.Error != "" || instance.LastSuccess == nil || instance.LastSuccess.Before(*observed.LastSuccess) || instance.Endpoint != observed.Endpoint {
		return false, ErrDeliveryReconcileFailed
	}
	// Xray is observed through its private statistics socket and has no source
	// integration or HTTP endpoint. Its durable successful observation is enough.
	if instance.ModuleID == "xray" {
		if instance.IntegrationID != "" || observed.IntegrationID != "" || instance.Endpoint != "" {
			return false, ErrDeliveryReconcileFailed
		}
		return true, nil
	}
	if instance.Endpoint == "" || instance.IntegrationID == "" || observed.IntegrationID != instance.IntegrationID {
		return false, ErrDeliveryReconcileFailed
	}
	integration, err := store.Get[model.Integration](ctx, m.Store, "integration", instance.IntegrationID)
	definition, known := model.ModuleDefinition(instance.ModuleID)
	if err != nil || !known || integration.Kind != definition.IntegrationKind || integration.ManagedModuleID != id || !integration.Enabled || integration.URL != instance.Endpoint || integration.Error != "" || integration.Status != "connected" {
		return false, ErrDeliveryReconcileFailed
	}
	return true, nil
}

// ReconcileDelivery queues ordinary durable module jobs and waits for the same
// Store.Finish transaction that publishes their integration/source bindings.
// Replays reuse the jobs; a failed request needs a new request_id to retry.
func (m *Manager) ReconcileDelivery(ctx context.Context, request DeliveryReconcileRequest) (result DeliveryReconcileResult, err error) {
	if !canonicalID(request.OperationID) || !canonicalID(request.RequestID) {
		return result, ErrDeliveryReconcileInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	defer func() {
		if err != nil && ctx.Err() != nil {
			err = ErrDeliveryReconcileTimeout
		}
	}()
	if err := m.deliveryReconcileActive(ctx, request.OperationID); err != nil {
		return result, err
	}
	if m.Store == nil || m.Store.Pool == nil {
		return result, ErrDeliveryReconcileFailed
	}
	instances, err := store.List[model.ModuleInstance](ctx, m.Store, "module_instance")
	if err != nil {
		return result, ErrDeliveryReconcileFailed
	}
	ids := []string{}
	for _, instance := range instances {
		if nativeReconcileInstance(instance) {
			ids = append(ids, instance.ID)
		}
	}
	sort.Strings(ids)
	jobs := map[string]string{}
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		if ctx.Err() != nil {
			return result, ErrDeliveryReconcileTimeout
		}
		if err := m.deliveryReconcileActive(ctx, request.OperationID); err != nil {
			if ctx.Err() != nil {
				return result, ErrDeliveryReconcileTimeout
			}
			return result, err
		}
		ready := 0
		for _, id := range ids {
			if jobs[id] == "" {
				instance, loadErr := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
				if loadErr != nil || !nativeReconcileInstance(instance) {
					return result, ErrDeliveryReconcileFailed
				}
				key := "delivery:" + request.OperationID + ":" + request.RequestID + ":" + id
				_, job, queueErr := m.Store.QueueModule(ctx, "system:modules", key, id, "refresh", model.ModuleRequest{})
				if errors.Is(queueErr, store.ErrConflict) {
					continue
				}
				if queueErr != nil {
					return result, ErrDeliveryReconcileFailed
				}
				jobs[id] = job.ID
			}
			job, loadErr := m.Store.Job(ctx, jobs[id])
			if loadErr != nil {
				return result, ErrDeliveryReconcileFailed
			}
			done, finishErr := m.deliveryReconcileFinished(ctx, id, job)
			if finishErr != nil {
				return result, finishErr
			}
			if done {
				ready++
			}
		}
		if ready == len(ids) {
			if err := m.deliveryReconcileActive(ctx, request.OperationID); err != nil {
				return result, err
			}
			if ctx.Err() != nil {
				return result, ErrDeliveryReconcileTimeout
			}
			return DeliveryReconcileResult{OperationID: request.OperationID, Ready: true, Instances: len(ids)}, nil
		}
		select {
		case <-ctx.Done():
			return result, ErrDeliveryReconcileTimeout
		case <-tick.C:
		}
	}
}
