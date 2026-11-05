package server

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"pl/portal/internal/modules"
)

func (s *Server) RegisterInstallationRoutes(m *http.ServeMux) {
	if !s.Config.PortableRelease {
		return
	}
	m.HandleFunc("GET /api/v1/installation", s.moduleAuth(s.installationSettings))
	m.HandleFunc("PUT /api/v1/installation", s.moduleAuth(s.installationSettings))
}
func (s *Server) installationSettings(w http.ResponseWriter, r *http.Request) {
	var change *modules.InstallationChange
	if r.Method == http.MethodPut {
		change = &modules.InstallationChange{}
		if !decode(w, r, change) {
			return
		}
		if !validInstallationChange(*change) {
			problem(w, 400, "installation_invalid", "Проверьте HTTPS-адрес, интерфейс, разрешённые сети, порты и пару TLS-сертификата с ключом")
			return
		}
		// Certificate uploads may outlive the session/role checked by middleware.
		current, err := s.readSession(r)
		if errors.Is(err, errADUnavailable) {
			problem(w, 503, "ad_unavailable", "Не удалось проверить права через AD")
			return
		}
		if err != nil || !current.User.Admin {
			problem(w, 403, "forbidden", "Права администратора изменились. Войдите в PL снова.")
			return
		}
	}
	result, err := s.Modules.Installation(r.Context(), change)
	if err != nil {
		var conflict *modules.InstallationError
		if errors.As(err, &conflict) {
			problem(w, conflict.Status, conflict.Code, conflict.Message)
		} else {
			problem(w, 503, "installation_unavailable", "Не удалось получить подтверждение host controller. Обновите состояние установки.")
		}
		return
	}
	respond(w, 200, result)
}
func validInstallationChange(v modules.InstallationChange) bool {
	id, err := uuid.Parse(v.OperationID)
	if err != nil || id.String() != v.OperationID || v.Revision < 0 {
		return false
	}
	u, err := url.Parse(v.PublicURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Opaque != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || len(v.PublicURL) > 2048 || strings.TrimSpace(v.PublicURL) != v.PublicURL {
		return false
	}
	if net.ParseIP(v.BindAddress) == nil || len(v.AllowedCIDRs) > 64 || len(v.AllowedPorts) > 64 || len(v.TLSCertPEM) > 65536 || len(v.TLSKeyPEM) > 65536 || (v.TLSCertPEM == "") != (v.TLSKeyPEM == "") {
		return false
	}
	if v.OutboundCAPEM != nil && len(*v.OutboundCAPEM) > 65536 {
		return false
	}
	for _, cidr := range v.AllowedCIDRs {
		ip, n, err := net.ParseCIDR(cidr)
		if err != nil || n.String() != cidr || !ip.Equal(n.IP) {
			return false
		}
	}
	for _, p := range v.AllowedPorts {
		if p < 1 || p > 65535 {
			return false
		}
	}
	return true
}
