package server

import (
	"context"
	"net/http"
	"regexp"

	"github.com/google/uuid"
	"pl/portal/internal/modules"
)

var deliveryVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?$`)

func (s *Server) RegisterDeliveryRoutes(m *http.ServeMux) {
	if !s.Config.PortableRelease {
		return
	}
	s.registerDeliveryProxyRoutes(m)
	m.HandleFunc("GET /api/v1/delivery", s.moduleAuth(s.deliveryStatus))
	m.HandleFunc("POST /api/v1/delivery/check", s.moduleAuth(s.deliveryCheck))
	m.HandleFunc("POST /api/v1/delivery/upgrade", s.moduleAuth(s.deliveryUpgrade))
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
	if err != nil || id.String() != request.OperationID || !deliveryVersion.MatchString(request.Version) {
		problem(w, 400, "invalid_upgrade", "Укажите опубликованную версию и идентификатор операции")
		return
	}
	s.deliveryRespond(w, r, "upgrade", &request)
}
func (s *Server) deliveryRespond(w http.ResponseWriter, r *http.Request, action string, request *modules.DeliveryUpgrade) {
	status, err := s.Modules.Delivery(r.Context(), action, request)
	if err != nil {
		problem(w, 503, "delivery_unavailable", "Не удалось получить подтверждение host controller. Обновите состояние операции.")
		return
	}
	respond(w, 200, status)
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
