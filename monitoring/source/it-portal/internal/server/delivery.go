package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var deliveryVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?$`)
var deliveryArtifactHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Server) RegisterDeliveryRoutes(m *http.ServeMux) {
	if !s.Config.PortableRelease {
		return
	}
	s.registerDeliveryProxyRoutes(m)
	s.RegisterDeliveryReconcileRoutes(m)
	m.HandleFunc("GET /api/v1/delivery", s.moduleAuth(s.deliveryStatus))
	m.HandleFunc("POST /api/v1/delivery/check", s.moduleAuth(s.deliveryCheck))
	m.HandleFunc("POST /api/v1/delivery/upgrade", s.moduleAuth(s.deliveryUpgrade))
	m.HandleFunc("POST /api/v1/delivery/module-upgrade", s.moduleAuth(s.deliveryModuleUpgrade))
	m.HandleFunc("POST /api/v1/delivery/recover", s.moduleAuth(s.deliveryRecover))
}
func (s *Server) deliveryRecover(w http.ResponseWriter, r *http.Request) {
	var request struct {
		OperationID string `json:"operation_id"`
	}
	if !decode(w, r, &request) {
		return
	}
	id, err := uuid.Parse(request.OperationID)
	if err != nil || id.String() != request.OperationID {
		problem(w, 400, "invalid_recovery", "Укажите идентификатор прерванной операции")
		return
	}
	s.deliveryRespond(w, r, "recover", &modules.DeliveryUpgrade{OperationID: request.OperationID})
}
func (s *Server) deliveryStatus(w http.ResponseWriter, r *http.Request) {
	s.deliveryRespond(w, r, "status", nil)
}
func (s *Server) deliveryCheck(w http.ResponseWriter, r *http.Request) {
	var empty struct{}
	if !decode(w, r, &empty) {
		return
	}
	s.deliveryRespond(w, r, "check", nil)
}
func (s *Server) deliveryUpgrade(w http.ResponseWriter, r *http.Request) {
	var request modules.DeliveryUpgrade
	if !decode(w, r, &request) {
		return
	}
	id, err := uuid.Parse(request.OperationID)
	if err != nil || id.String() != request.OperationID || !deliveryVersion.MatchString(request.Version) || request.ModuleID != "" || request.ArtifactSHA256 != "" {
		problem(w, 400, "invalid_upgrade", "Укажите опубликованную версию и идентификатор операции")
		return
	}
	s.deliveryRespond(w, r, "upgrade", &request)
}
func (s *Server) deliveryModuleUpgrade(w http.ResponseWriter, r *http.Request) {
	var request struct {
		OperationID    string `json:"operation_id"`
		ModuleID       string `json:"module_id"`
		ArtifactSHA256 string `json:"artifact_sha256"`
	}
	if !decode(w, r, &request) {
		return
	}
	id, err := uuid.Parse(request.OperationID)
	allowed := false
	switch request.ModuleID {
	case "prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "netmap", "bookstack":
		allowed = true
	}
	if err != nil || id.String() != request.OperationID || !allowed || !deliveryArtifactHash.MatchString(request.ArtifactSHA256) {
		problem(w, 400, "invalid_module_upgrade", "Укажите модуль, опубликованную сборку и идентификатор операции")
		return
	}
	s.deliveryRespond(w, r, "module-upgrade", &modules.DeliveryUpgrade{OperationID: request.OperationID,
		ModuleID: request.ModuleID, ArtifactSHA256: request.ArtifactSHA256})
}
func (s *Server) deliveryRespond(w http.ResponseWriter, r *http.Request, action string, request *modules.DeliveryUpgrade) {
	if request != nil {
		if err := s.reconcileDelivery(r.Context()); err != nil {
			problem(w, 503, "delivery_unavailable", "Не удалось сохранить подтверждённое состояние предыдущей операции. Обновите её состояние перед новым запуском.")
			return
		}
		if action == "recover" {
			if err := s.Store.RecordDeliveryRecovery(r.Context(), request.OperationID, current(r).User.ID); err != nil {
				s.fail(w, err)
				return
			}
		} else if action == "upgrade" || action == "module-upgrade" {
			target, version := "Платформа", request.Version
			previous, previousErr := s.Store.Job(r.Context(), request.OperationID)
			if previousErr == nil && previous.Kind == "delivery" {
				if previous.Status == "succeeded" || previous.Status == "failed" {
					problem(w, 409, "delivery_operation_finished", "Операция с этим идентификатором уже завершена. Её результат сохранён в журнале.")
					return
				}
				// Retries retain the original catalog version even if the
				// channel has advanced since this operation was accepted.
				target, _ = previous.Parameters["target"].(string)
				if action == "module-upgrade" {
					version, _ = previous.Parameters["version"].(string)
				}
			} else if previousErr != nil && !errors.Is(previousErr, store.ErrNotFound) {
				s.fail(w, previousErr)
				return
			} else if action == "module-upgrade" {
				catalog, err := s.Modules.Delivery(r.Context(), "status", nil)
				if err != nil {
					problem(w, 503, "delivery_unavailable", "Не удалось подтвердить опубликованную версию модуля.")
					return
				}
				if err = s.observeDelivery(r.Context(), catalog); err != nil {
					s.fail(w, err)
					return
				}
				for _, candidate := range catalog.Modules {
					if candidate.ModuleID == request.ModuleID && candidate.ArtifactSHA256 == request.ArtifactSHA256 {
						version = candidate.Version
						break
					}
				}
				if !deliveryVersion.MatchString(version) {
					problem(w, 409, "delivery_catalog_changed", "Поставка модуля изменилась. Проверьте обновления ещё раз.")
					return
				}
				target = request.ModuleID
				if definition, ok := model.ModuleDefinition(request.ModuleID); ok {
					target = definition.Name
				}
			}
			if _, err := s.Store.BeginDelivery(r.Context(), store.DeliveryRequest{ID: request.OperationID, Actor: current(r).User.ID, Action: action, ModuleID: request.ModuleID, Target: target, Version: version, ArtifactSHA256: request.ArtifactSHA256}); err != nil {
				s.fail(w, err)
				return
			}
		}
	}
	status, err := s.Modules.Delivery(r.Context(), action, request)
	if err != nil {
		if request != nil && action != "recover" {
			_ = s.Store.ObserveDelivery(r.Context(), store.DeliveryObservation{ID: request.OperationID, Phase: "unconfirmed"})
		}
		problem(w, 503, "delivery_unavailable", "Не удалось получить подтверждение host controller. Обновите состояние операции.")
		return
	}
	if err := s.observeDelivery(r.Context(), status); err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, status)
}

func (s *Server) observeDelivery(ctx context.Context, status modules.DeliveryStatus) error {
	operation := status.Operation
	if operation == nil {
		return nil
	}
	return s.Store.ObserveDelivery(ctx, store.DeliveryObservation{ID: operation.OperationID, Kind: operation.Kind, ModuleID: operation.ModuleID,
		Phase: operation.Phase, Error: operation.Error, CurrentVersion: status.CurrentVersion, RecoveryMode: operation.RecoveryMode, RestoredSnapshot: operation.RestoredSnapshot})
}

// A read may refresh only an existing intent; it never supplies an actor or
// creates a job for a historical host operation. Failure leaves its last proof.
func (s *Server) reconcileDelivery(ctx context.Context) error {
	if !s.Config.PortableRelease || s.Modules == nil {
		return nil
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	pending, err := s.Store.HasPendingDelivery(bounded)
	if err != nil {
		return err
	}
	if !pending {
		return nil
	}
	status, err := s.Modules.Delivery(bounded, "status", nil)
	if err != nil {
		return err
	}
	return s.observeDelivery(bounded, status)
}

func (s *Server) availableModuleVersions(ctx context.Context) map[string]string {
	if !s.Config.OnDemandModules {
		return s.Config.ModuleVersions
	}
	versions := map[string]string{}
	status, err := s.Modules.Delivery(ctx, "status", nil)
	if err == nil {
		for _, m := range status.Modules {
			if deliveryVersion.MatchString(m.Version) {
				versions[m.ModuleID] = m.Version
			}
		}
	}
	return versions
}
