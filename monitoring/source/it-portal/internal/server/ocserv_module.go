package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var (
	vpnSubject = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,61}$`)
	vpnProfile = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)
	vpnSession = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)
)

func (s *Server) registerOcservRoutes(m *http.ServeMux) {
	const base = "/api/v1/modules/{id}/ocserv/"
	m.HandleFunc("GET "+base+"state", s.moduleAuth(s.ocservAction("state")))
	for _, action := range []string{"profile", "grant", "revoke", "terminate"} {
		m.HandleFunc("POST "+base+action, s.moduleAuth(s.ocservAction(action)))
	}
}

func vpnName(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && utf8.RuneCountInString(value) <= 128 && !strings.ContainsFunc(value, unicode.IsControl)
}

func vpnNetworks(values []string) bool {
	if len(values) < 1 || len(values) > 64 {
		return false
	}
	seen := make(map[netip.Prefix]bool, len(values))
	for _, value := range values {
		p, err := netip.ParsePrefix(value)
		if err != nil || !p.Addr().Is4() || p.Bits() < 1 || p.Masked().String() != value || seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}

// A separate request schema for each operation keeps actor and VPN credentials
// out of user input. The host enforces the revision against its durable state.
func vpnInput(w http.ResponseWriter, r *http.Request, action, actor string) (map[string]any, bool) {
	if r.URL.RawQuery != "" {
		problem(w, 400, "invalid_vpn_query", "В запросе VPN есть лишние параметры")
		return nil, false
	}
	if action == "state" {
		return map[string]any{}, true
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12<<10)
	type version struct {
		Revision *int64 `json:"revision"`
	}
	var v *int64
	data := map[string]any{"actor": actor}
	switch action {
	case "profile":
		var in struct {
			version
			ID       string   `json:"id"`
			Name     string   `json:"name"`
			Networks []string `json:"networks"`
		}
		if !decode(w, r, &in) {
			return nil, false
		}
		if !vpnProfile.MatchString(in.ID) || !vpnName(in.Name) || !vpnNetworks(in.Networks) {
			problem(w, 400, "invalid_vpn_profile", "Проверьте идентификатор, название и список IPv4-подсетей профиля")
			return nil, false
		}
		v = in.Revision
		data["id"], data["name"], data["networks"] = in.ID, in.Name, in.Networks
	case "grant":
		var in struct {
			version
			Subject     string  `json:"subject"`
			DisplayName string  `json:"display_name"`
			ProfileID   string  `json:"profile_id"`
			ExpiresAt   *string `json:"expires_at"`
		}
		if !decode(w, r, &in) {
			return nil, false
		}
		if !vpnSubject.MatchString(in.Subject) || !vpnName(in.DisplayName) || !vpnProfile.MatchString(in.ProfileID) || in.ExpiresAt == nil {
			problem(w, 400, "invalid_vpn_grant", "Проверьте идентификатор сотрудника, имя, профиль и срок доступа")
			return nil, false
		}
		expires := *in.ExpiresAt
		if expires != "" {
			t, err := time.Parse(time.RFC3339, expires)
			if err != nil || !t.After(time.Now()) {
				problem(w, 400, "invalid_vpn_expiry", "Укажите будущие дату и время окончания доступа")
				return nil, false
			}
			expires = t.UTC().Format(time.RFC3339)
		}
		v = in.Revision
		data["subject"], data["display_name"], data["profile_id"], data["expires_at"] = in.Subject, in.DisplayName, in.ProfileID, expires
	case "revoke":
		var in struct {
			version
			Subject string `json:"subject"`
		}
		if !decode(w, r, &in) {
			return nil, false
		}
		if !vpnSubject.MatchString(in.Subject) {
			problem(w, 400, "invalid_vpn_subject", "Проверьте идентификатор сотрудника")
			return nil, false
		}
		v, data["subject"] = in.Revision, in.Subject
	case "terminate":
		var in struct {
			version
			ID string `json:"id"`
		}
		if !decode(w, r, &in) {
			return nil, false
		}
		if !vpnSession.MatchString(in.ID) {
			problem(w, 400, "invalid_vpn_session", "Проверьте идентификатор сессии VPN")
			return nil, false
		}
		v, data["id"] = in.Revision, in.ID
	default:
		return nil, false
	}
	if v == nil || *v < 0 {
		problem(w, 400, "invalid_vpn_revision", "Укажите текущую версию настроек VPN")
		return nil, false
	}
	data["revision"] = *v
	return data, true
}

// The administrative snapshot exposes operational fields only. Native gateway
// configuration can contain private keys and identity-provider credentials.
type vpnSnapshot struct {
	Revision *int64 `json:"revision"`
	Gateway  *struct {
		Name          string `json:"name"`
		AuthMode      string `json:"auth_mode"`
		Ready         bool   `json:"ready"`
		Pool          string `json:"pool"`
		ObservedAt    string `json:"observed_at"`
		SessionsKnown bool   `json:"sessions_known"`
	} `json:"gateway"`
	Profiles []struct {
		ID       string   `json:"id"`
		Name     string   `json:"name"`
		Networks []string `json:"networks"`
	} `json:"profiles"`
	Grants []struct {
		Subject     string `json:"subject"`
		DisplayName string `json:"display_name"`
		ProfileID   string `json:"profile_id"`
		ExpiresAt   string `json:"expires_at"`
		Status      string `json:"status"`
	} `json:"grants"`
	Sessions []struct {
		ID      string `json:"id"`
		Subject string `json:"subject"`
		IP      string `json:"ip"`
		Device  string `json:"device"`
		Since   string `json:"since"`
	} `json:"sessions"`
	Events []struct {
		At      string `json:"at"`
		Actor   string `json:"actor"`
		Action  string `json:"action"`
		Subject string `json:"subject"`
	} `json:"events"`
}

func (s *Server) ocservAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		payload, ok := vpnInput(w, r, action, current(r).User.ID)
		if !ok {
			return
		}
		reply, err := s.Modules.OcservRequest(r.Context(), r.PathValue("id"), action, payload)
		if err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				problem(w, 404, "ocserv_not_installed", "Корпоративный VPN не установлен.")
			case errors.Is(err, modules.ErrOcservDisabled):
				problem(w, 409, "ocserv_disabled", "Модуль VPN отключён.")
			default:
				problem(w, 503, "ocserv_unavailable", "Шлюз VPN недоступен. Проверьте состояние модуля.")
			}
			return
		}
		if reply.Status != http.StatusOK {
			var failure struct {
				Error struct{ Code, Message string }
			}
			if json.Unmarshal(reply.Body, &failure) != nil || failure.Error.Message == "" || len(failure.Error.Message) > 1024 {
				problem(w, 503, "ocserv_unavailable", "Контроллер VPN вернул неизвестную ошибку")
				return
			}
			problem(w, reply.Status, failure.Error.Code, failure.Error.Message)
			return
		}
		var state vpnSnapshot
		if json.Unmarshal(reply.Body, &state) != nil || state.Revision == nil || *state.Revision < 0 || state.Gateway == nil || state.Profiles == nil || state.Grants == nil || state.Sessions == nil || state.Events == nil {
			problem(w, 503, "ocserv_invalid_response", "Контроллер VPN вернул неполное состояние")
			return
		}
		respond(w, http.StatusOK, state)
	}
}
