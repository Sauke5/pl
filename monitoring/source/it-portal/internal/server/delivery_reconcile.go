package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/modules"
)

func (s *Server) RegisterDeliveryReconcileRoutes(mux *http.ServeMux) {
	if s.Config.OnDemandModules {
		mux.HandleFunc("POST "+modules.DeliveryReconcilePath, s.deliveryReconcile)
	}
}

func reconcilePrivatePeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.Unmap().IsPrivate()
}

func decodeDeliveryReconcile(raw []byte) (modules.DeliveryReconcileRequest, bool) {
	var value modules.DeliveryReconcileRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return value, false
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err = decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] || key != "operation_id" && key != "request_id" {
			return value, false
		}
		seen[key] = true
		var id string
		if decoder.Decode(&id) != nil {
			return value, false
		}
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.String() != id {
			return value, false
		}
		if key == "operation_id" {
			value.OperationID = id
		} else {
			value.RequestID = id
		}
	}
	token, err = decoder.Token()
	var trailing any
	return value, err == nil && token == json.Delim('}') && len(seen) == 2 && decoder.Decode(&trailing) == io.EOF
}

func (s *Server) deliveryReconcile(w http.ResponseWriter, r *http.Request) {
	unauthorized := func() {
		problem(w, http.StatusUnauthorized, "delivery_reconcile_unauthorized", "Запрос согласования обновления не подтверждён")
	}
	if !s.Config.OnDemandModules || r.Method != http.MethodPost || r.URL.EscapedPath() != modules.DeliveryReconcilePath || r.URL.RawQuery != "" || !reconcilePrivatePeer(r) {
		unauthorized()
		return
	}
	for _, header := range []string{"Authorization", "Proxy-Authorization", "Cookie", "Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Forwarded", "X-Forwarded-For", "X-Real-IP"} {
		if _, present := r.Header[http.CanonicalHeaderKey(header)]; present {
			unauthorized()
			return
		}
	}
	timestamps, signatures := r.Header.Values("X-PL-Delivery-Timestamp"), r.Header.Values("X-PL-Delivery-Signature")
	if len(timestamps) != 1 || len(signatures) != 1 || s.Modules == nil {
		unauthorized()
		return
	}
	// The internal peer sends a tiny finite body. Bound a stalled TCP reader too;
	// httptest and other non-network ResponseWriters may not support deadlines.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(5 * time.Second))
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	_ = controller.SetReadDeadline(time.Time{})
	if err != nil || len(raw) > 4096 {
		problem(w, http.StatusRequestEntityTooLarge, "delivery_reconcile_body", "Некорректное тело запроса согласования")
		return
	}
	if !s.Modules.VerifyDeliveryReconcile(r.Method, r.URL.EscapedPath(), timestamps[0], signatures[0], raw) {
		unauthorized()
		return
	}
	request, ok := decodeDeliveryReconcile(raw)
	if !ok {
		problem(w, http.StatusBadRequest, "delivery_reconcile_invalid", "Ожидаются только operation_id и request_id")
		return
	}
	result, err := s.Modules.ReconcileDelivery(r.Context(), request)
	if err != nil {
		switch {
		case errors.Is(err, modules.ErrDeliveryReconcileInactive):
			problem(w, http.StatusConflict, "delivery_not_reconciling", "Обновление не ожидает согласования привязок")
		case errors.Is(err, modules.ErrDeliveryReconcileTimeout):
			problem(w, http.StatusGatewayTimeout, "delivery_reconcile_timeout", "Не удалось дождаться подтверждения привязок модулей")
		default:
			problem(w, http.StatusServiceUnavailable, "delivery_reconcile_failed", "Не удалось подтвердить привязки модулей")
		}
		return
	}
	respond(w, http.StatusOK, result)
}
