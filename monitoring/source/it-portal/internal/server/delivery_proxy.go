package server

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"pl/portal/internal/modules"
)

func (s *Server) registerDeliveryProxyRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/delivery/proxy", s.moduleAuth(s.deliveryProxyStatus))
	m.HandleFunc("PUT /api/v1/delivery/proxy", s.moduleAuth(s.configureDeliveryProxy))
	m.HandleFunc("POST /api/v1/delivery/proxy/test", s.moduleAuth(s.testDeliveryProxy))
}
func (s *Server) deliveryProxyFailure(w http.ResponseWriter, err error) {
	var typed *modules.DeliveryProxyError
	if errors.As(err, &typed) {
		problem(w, typed.Status, typed.Code, typed.Error())
		return
	}
	problem(w, 503, "delivery_proxy_unavailable", "Не удалось получить подтверждение host controller. Обновите настройки доставки.")
}
func (s *Server) deliveryProxyStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	status, err := s.Modules.DeliveryProxyStatus(r.Context())
	if err != nil {
		s.deliveryProxyFailure(w, err)
		return
	}
	respond(w, 200, status)
}
func (s *Server) deliveryProxyCurrentAdmin(w http.ResponseWriter, r *http.Request) bool {
	actor, err := s.readSession(r)
	if errors.Is(err, errADUnavailable) {
		problem(w, 503, "ad_unavailable", "Не удалось проверить права через AD")
		return false
	}
	if err != nil || !actor.User.Admin {
		problem(w, 403, "forbidden", "Права администратора изменились. Войдите в PL снова.")
		return false
	}
	return true
}
func (s *Server) configureDeliveryProxy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, modules.DeliveryProxyRequestLimit)
	var change modules.DeliveryProxyChange
	if !decode(w, r, &change) {
		return
	}
	id, err := uuid.Parse(change.OperationID)
	if err != nil || id.String() != change.OperationID || change.Revision < 0 || modules.ValidateDeliveryProxyConfiguration(change.Configuration) != nil {
		problem(w, 400, "delivery_proxy_invalid", "Проверьте параметры подключения для загрузки обновлений.")
		return
	}
	if !s.deliveryProxyCurrentAdmin(w, r) {
		return
	}
	result, err := s.Modules.ConfigureDeliveryProxy(r.Context(), change)
	if err != nil {
		s.deliveryProxyFailure(w, err)
		return
	}
	respond(w, 200, result)
}
func (s *Server) testDeliveryProxy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, modules.DeliveryProxyRequestLimit)
	var request modules.DeliveryProxyTestRequest
	if !decode(w, r, &request) {
		return
	}
	if request.Revision < 0 || modules.ValidateDeliveryProxyConfiguration(request.Configuration) != nil {
		problem(w, 400, "delivery_proxy_invalid", "Проверьте параметры подключения для загрузки обновлений.")
		return
	}
	if !s.deliveryProxyCurrentAdmin(w, r) {
		return
	}
	result, err := s.Modules.TestDeliveryProxy(r.Context(), request)
	if err != nil {
		s.deliveryProxyFailure(w, err)
		return
	}
	respond(w, 200, result)
}
