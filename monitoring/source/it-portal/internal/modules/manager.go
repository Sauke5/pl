package modules

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type Prober interface {
	Probe(context.Context, string) (Observation, error)
}
type Manager struct {
	DeliveryEnabled bool
	PublicURL       string
	Store           *store.Store
	Controller      Controller
	Probe           Prober
	BookStack       *BookStackConnector
	NetMap          *NetMapConnector
	Auditor         interface {
		Probe(context.Context, model.Integration) (Observation, error)
		Read(context.Context, model.Integration, string, string) (*http.Response, error)
	}
	Poll func(context.Context, model.Integration) (model.Snapshot, error)
}

func New(s *store.Store, c Controller) *Manager {
	return &Manager{Store: s, Controller: c, Probe: NewPrometheusProbe()}
}
func (m *Manager) LocalAvailable() bool { return m != nil && m.Controller != nil }

// ManagedHealth observes local native applications through the authenticated
// controller and external Wiki through its persisted bound connector.
func (m *Manager) ManagedHealth(ctx context.Context, i model.Integration) error {
	if m == nil || m.Store == nil || !canonicalID(i.ManagedModuleID) || !i.Enabled || (i.Kind != "forms" && i.Kind != "doska" && i.Kind != "sftpgo" && i.Kind != "netmap" && i.Kind != "bookstack") {
		return errors.New("Управляемое приложение недоступно")
	}
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", i.ManagedModuleID)
	if err != nil {
		return err
	}
	canonical, err := store.Get[model.Integration](ctx, m.Store, "integration", i.ID)
	if err != nil {
		return err
	}
	if canonical.ManagedModuleID != instance.ID || instance.IntegrationID != i.ID || !canonical.Enabled || canonical.Kind != i.Kind || instance.ModuleID != i.Kind || instance.DesiredState != "enabled" {
		return errors.New("Связь приложения с управляемым модулем не подтверждена")
	}
	if instance.ModuleID == "bookstack" && instance.Mode == "external" {
		if instance.Endpoint != canonical.URL {
			return ErrBookStackConnection
		}
		_, err := m.BookStack.Probe(ctx, canonical, m.PublicURL)
		return err
	}
	if instance.ModuleID == "netmap" && instance.Mode == "external" {
		integration, err := m.externalNetMapIntegration(ctx, instance)
		if err != nil {
			return err
		}
		_, err = m.NetMap.Probe(ctx, integration, m.PublicURL)
		return err
	}
	if instance.Mode != "local" || m.Controller == nil {
		return errors.New("Host controller не настроен")
	}
	observer, ok := m.Controller.(interface {
		Observe(context.Context, string) (Observation, error)
	})
	if !ok {
		return errors.New("Host controller не поддерживает проверку приложения")
	}
	observed, err := observer.Observe(ctx, instance.ID)
	if err != nil {
		return err
	}
	if observed.State != "running" || observed.Version == "" || observed.Endpoint == "" || observed.Error != "" {
		return errors.New("Контроллер не подтвердил готовность установленного приложения")
	}
	return nil
}

func (m *Manager) Execute(ctx context.Context, j model.Job) (map[string]any, error) {
	id, _ := j.Parameters["instance_id"].(string)
	action, _ := j.Parameters["action"].(string)
	instance, err := store.Get[model.ModuleInstance](ctx, m.Store, "module_instance", id)
	if err != nil {
		return nil, err
	}
	if instance.LastJobID != j.ID {
		return nil, store.ErrConflict
	}
	now := time.Now().UTC()
	instance.LastAttempt = &now
	var observed Observation
	allowed := j.Actor == "system:modules" && action == "refresh"
	if !allowed {
		allowed, err = m.Store.ModuleActorAdmin(ctx, j.Actor)
	}
	if err == nil && !allowed {
		err = errors.New("Права администратора изменились; операция отменена")
		if action == "install" || action == "enable" || action == "reconnect" {
			// A denied connection or enable must not later be completed by
			// the system observer using a different administrative identity.
			instance.DesiredState = "disabled"
		}
	}
	switch {
	case err != nil:
	case !model.ModuleModeSupported(instance.ModuleID, instance.Mode):
		err = errors.New("Неизвестный модуль")
	case instance.Mode == "local":
		if m.Controller == nil {
			err = errors.New("Host controller не настроен")
		} else {
			op := Operation{OperationID: j.ID, InstanceID: instance.ID, ModuleID: instance.ModuleID, Action: action}
			if (instance.ModuleID == "forms" || instance.ModuleID == "doska") && (action == "install" || action == "enable") {
				op.PublicURL = m.PublicURL
			}
			if (instance.ModuleID == "grafana" || instance.ModuleID == "netmap" || instance.ModuleID == "bookstack") && (action == "install" || action == "enable") {
				op.PublicURL = m.PublicURL
			}
			if action == "configure" && (instance.ModuleID == "xray" || instance.ModuleID == "alertmanager" || instance.ModuleID == "sftpgo") {
				op.ConfigurationRef, _ = j.Parameters["configuration_ref"].(string)
				if !canonicalID(op.ConfigurationRef) {
					err = errors.New("Некорректный план конфигурации модуля")
				}
			}
			if action == "configure" && instance.ModuleID == "prometheus" {
				var configuration model.PrometheusConfiguration
				raw, marshalErr := json.Marshal(j.Parameters["configuration"])
				if marshalErr != nil || json.Unmarshal(raw, &configuration) != nil {
					err = errors.New("Некорректная конфигурация в операции")
				} else if err = ValidateConfiguration(configuration); err == nil {
					op.Configuration = &configuration
				}
			}
			if err == nil {
				observed, err = m.Controller.Apply(ctx, op)
			}
			if action == "configure" {
				instance.ConfigurationError = ""
				instance.ConfigurationRolledBack = observed.RolledBack
				hashBytes, hashErr := hex.DecodeString(observed.ConfigurationHash)
				expectedRevision := int64(0)
				if instance.ModuleID == "xray" || instance.ModuleID == "alertmanager" || instance.ModuleID == "sftpgo" {
					raw, _ := json.Marshal(j.Parameters["configuration_revision"])
					_ = json.Unmarshal(raw, &expectedRevision)
				} else if op.Configuration != nil {
					expectedRevision = op.Configuration.Revision
				}
				if err == nil && (expectedRevision < 1 || observed.ConfigurationRevision != expectedRevision || hashErr != nil || len(hashBytes) != 32) {
					err = errors.New("Host controller не подтвердил ревизию конфигурации")
				}
				if err == nil {
					if instance.ModuleID == "xray" {
						if instance.XrayDraft == nil || instance.XrayDraft.Ref != op.ConfigurationRef || instance.XrayDraft.Revision != expectedRevision {
							err = errors.New("План Xray не совпадает с операцией")
						} else {
							copy := *instance.XrayDraft
							instance.XrayApplied = &copy
						}
					} else if instance.ModuleID == "alertmanager" {
						if instance.AlertmanagerDraft == nil || instance.AlertmanagerDraft.Ref != op.ConfigurationRef || instance.AlertmanagerDraft.Revision != expectedRevision {
							err = errors.New("План Alertmanager не совпадает с операцией")
						} else {
							copy := *instance.AlertmanagerDraft
							instance.AlertmanagerApplied = &copy
						}
					} else if instance.ModuleID == "sftpgo" {
						if instance.SFTPGoDraft == nil || instance.SFTPGoDraft.Ref != op.ConfigurationRef || instance.SFTPGoDraft.Revision != expectedRevision || instance.SFTPGoDraft.Hash != observed.ConfigurationHash {
							err = errors.New("План SFTPGo не совпадает с операцией")
						} else {
							copy := *instance.SFTPGoDraft
							instance.SFTPGoApplied = &copy
						}
					} else {
						instance.PrometheusApplied = op.Configuration
					}
				} else {
					instance.ConfigurationError = err.Error()
				}
			}
		}
	case instance.Mode == "external" && instance.ModuleID == "prometheus":
		if instance.DesiredState == "removed" {
			observed.State = "absent"
		} else if instance.DesiredState == "disabled" {
			observed.State = "disabled"
		} else {
			observed, err = m.Probe.Probe(ctx, instance.Endpoint)
		}
	case instance.Mode == "external" && instance.ModuleID == "bookstack":
		switch instance.DesiredState {
		case "removed":
			observed.State = "absent"
		case "disabled":
			observed.State = "disabled"
		default:
			integration, loadErr := store.Get[model.Integration](ctx, m.Store, "integration", instance.IntegrationID)
			if loadErr != nil {
				err = loadErr
			} else if integration.ManagedModuleID != instance.ID || integration.URL != instance.Endpoint {
				err = ErrBookStackConnection
			} else {
				observed, err = m.BookStack.Probe(ctx, integration, m.PublicURL)
			}
		}
	case instance.Mode == "external" && instance.ModuleID == "netmap":
		switch instance.DesiredState {
		case "removed":
			observed.State = "absent"
		case "disabled":
			observed.State = "disabled"
		default:
			integration, loadErr := m.externalNetMapIntegration(ctx, instance)
			if loadErr != nil {
				err = loadErr
			} else {
				observed, err = m.NetMap.Probe(ctx, integration, m.PublicURL)
			}
		}
	case instance.Mode == "external" && instance.ModuleID == "mailcow":
		// Registration/lifecycle does not poll disabled groups. The dedicated
		// Mailcow worker owns each group's actual observations and freshness.
		switch instance.DesiredState {
		case "removed":
			observed.State = "absent"
		case "disabled":
			observed.State = "disabled"
		default:
			observed.State, observed.Endpoint = "running", instance.Endpoint
		}
	case instance.Mode == "external" && (instance.ModuleID == "wayline" || instance.ModuleID == "fileauditor"):
		if instance.DesiredState == "removed" {
			observed.State = "absent"
		} else if instance.DesiredState == "disabled" {
			observed.State = "disabled"
		} else if instance.ModuleID == "wayline" {
			observed.State = "running"
			observed.Endpoint = instance.Endpoint
		} else {
			integration, e := store.Get[model.Integration](ctx, m.Store, "integration", instance.IntegrationID)
			if e != nil {
				err = e
			} else if m.Auditor == nil {
				err = errors.New("Коннектор File Auditor не настроен")
			} else {
				observed, err = m.Auditor.Probe(ctx, integration)
			}
		}
	default:
		err = errors.New("Неизвестный способ подключения")
	}
	if err == nil && instance.Mode == "local" {
		if observed.State == "absent" && instance.DesiredState == "disabled" {
			observed.State = "disabled"
		}
		if (instance.DesiredState == "disabled" && observed.State != "disabled") || (instance.DesiredState == "enabled" && observed.State != "running") || (instance.DesiredState == "removed" && observed.State != "absent") {
			err = errors.New("Наблюдаемое состояние модуля не совпадает с запрошенным")
		}
	}
	// Forms, Doska and local Grafana use their native controller readiness.
	// Grafana's native login has no Pl identity gateway to poll.
	if err == nil && observed.State == "running" && (instance.ModuleID == "prometheus" || instance.ModuleID == "alertmanager" || instance.ModuleID == "wayline" || (instance.ModuleID == "grafana" && instance.Mode != "local")) {
		integration, e := store.Get[model.Integration](ctx, m.Store, "integration", instance.IntegrationID)
		if e != nil {
			err = e
		} else if m.Poll == nil {
			err = errors.New("Получение данных интеграции не настроено")
		} else {
			if instance.Mode == "local" {
				integration.URL = observed.Endpoint
			}
			snapshot, pollErr := m.Poll(ctx, integration)
			applyErr := m.Store.ApplySnapshot(ctx, integration, snapshot, pollErr)
			if pollErr != nil {
				err = pollErr
			} else {
				err = applyErr
			}
		}
	}
	if (instance.ModuleID == "xray" || instance.ModuleID == "alertmanager" || instance.ModuleID == "sftpgo") && err != nil {
		cause := error(nil)
		if errors.Is(err, context.DeadlineExceeded) {
			cause = context.DeadlineExceeded
		}
		if errors.Is(err, context.Canceled) {
			cause = context.Canceled
		}
		message := "Операция Xray не подтверждена; проверьте состояние модуля или повторите операцию"
		if instance.ModuleID == "alertmanager" {
			message = "Операция Alertmanager не подтверждена; проверьте состояние модуля или повторите операцию"
		}
		if instance.ModuleID == "sftpgo" {
			message = "Операция SFTPGo не подтверждена; проверьте состояние модуля или повторите операцию"
		}
		err = errors.Join(errors.New(message), cause)
	}
	if action == "configure" && err != nil {
		instance.ConfigurationError = err.Error()
	}
	instance.Error = ""
	if err != nil {
		instance.ObservedState = "unavailable"
		if action == "configure" && observed.RolledBack {
			instance.ObservedState = "running"
		}
		instance.Error = err.Error()
	} else {
		instance.ObservedState = observed.State
		if observed.State == "running" {
			completed := time.Now().UTC()
			instance.LastSuccess = &completed
			instance.Version = observed.Version
			instance.TargetsUp = observed.TargetsUp
			instance.TargetsTotal = observed.TargetsTotal
		}
		if instance.Mode == "local" {
			instance.Endpoint = observed.Endpoint
		}
	}
	return map[string]any{"instance": instance}, err
}

// Schedule uses the same queue and per-instance lock as manual actions. No
// concurrent poll or background config writer bypasses the durable lifecycle.
func (m *Manager) Schedule(ctx context.Context) {
	blockedModule := ""
	if m.DeliveryEnabled {
		op, allowed := m.deliveryScheduleOperation(ctx)
		if !allowed {
			return
		}
		if op != nil && op.Scope == "module" {
			switch op.Phase {
			case "complete", "failed", "rolled_back", "reconciling":
			default:
				blockedModule = op.ModuleID
			}
		}
	}
	instances, err := store.List[model.ModuleInstance](ctx, m.Store, "module_instance")
	if err != nil {
		return
	}
	now := time.Now().UTC()
	for _, instance := range instances {
		if blockedModule != "" && instance.ModuleID == blockedModule {
			continue
		}
		if instance.ModuleID == "mailcow" {
			continue
		}
		if instance.DesiredState != "enabled" || instance.ObservedState == "pending" || instance.LastAttempt != nil && now.Sub(*instance.LastAttempt) < 60*time.Second {
			continue
		}
		_, _, _ = m.Store.QueueModule(ctx, "system:modules", "poll:"+instance.ID+":"+now.Format("200601021504"), instance.ID, "refresh", model.ModuleRequest{})
	}
}
