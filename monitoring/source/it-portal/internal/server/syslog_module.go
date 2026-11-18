package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

func (s *Server) registerSyslogModuleRoutes(m *http.ServeMux) {
	const base = "/api/v1/modules/{id}/syslog/"
	m.HandleFunc("GET "+base+"receiver", s.moduleAuth(s.syslogRead("receiver-get")))
	m.HandleFunc("GET "+base+"sources", s.moduleAuth(s.syslogRead("sources")))
	m.HandleFunc("GET "+base+"messages", s.moduleAuth(s.syslogRead("messages")))
	m.HandleFunc("PUT "+base+"receiver", s.moduleAuth(s.syslogSetReceiver))
}

func syslogFilters(action, raw string) (map[string]string, error) {
	invalid := errors.New("Проверьте период и фильтры журнала")
	q, err := url.ParseQuery(raw)
	if err != nil {
		return nil, invalid
	}
	out := make(map[string]string, len(q))
	for k, values := range q {
		if len(values) != 1 || action == "receiver-get" || len(values[0]) > 512 || !utf8.ValidString(values[0]) || strings.ContainsFunc(values[0], unicode.IsControl) {
			return nil, invalid
		}
		value := values[0]
		switch k {
		case "from", "to":
		case "source", "text", "address", "severity":
			if action != "messages" || value == "" {
				return nil, invalid
			}
			if k == "severity" && (len(value) != 1 || value[0] < '0' || value[0] > '7') {
				return nil, invalid
			}
			if k == "address" {
				ip, err := netip.ParseAddr(value)
				if err != nil || ip.Zone() != "" {
					return nil, invalid
				}
			}
		default:
			return nil, invalid
		}
		out[k] = value
	}
	if action != "receiver-get" {
		from, errFrom := time.Parse(time.RFC3339Nano, out["from"])
		to, errTo := time.Parse(time.RFC3339Nano, out["to"])
		if errFrom != nil || errTo != nil || !from.Before(to) || to.Sub(from) > 31*24*time.Hour {
			return nil, errors.New("Выберите период до 31 дня")
		}
	}
	return out, nil
}

func (s *Server) syslogRead(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query, err := syslogFilters(action, r.URL.RawQuery)
		if err != nil {
			problem(w, 400, "invalid_syslog_query", err.Error())
			return
		}
		s.syslogReply(w, r, action, query)
	}
}

type syslogReceiver struct {
	Address          *string `json:"address"`
	Port             int     `json:"port"`
	TCP              *bool   `json:"tcp"`
	UDP              *bool   `json:"udp"`
	RetentionDays    int     `json:"retention_days"`
	ExpectedRevision *int64  `json:"expected_revision"`
}

func (s *Server) syslogSetReceiver(w http.ResponseWriter, r *http.Request) {
	var settings syslogReceiver
	if !decode(w, r, &settings) {
		return
	}
	if settings.Address == nil || settings.TCP == nil || settings.UDP == nil || settings.ExpectedRevision == nil || *settings.ExpectedRevision < 0 || settings.Port < 1 || settings.Port > 65535 || settings.RetentionDays < 1 || settings.RetentionDays > 365 || !*settings.TCP && !*settings.UDP {
		problem(w, 400, "invalid_syslog_receiver", "Укажите интерфейс, порт, протокол и срок хранения от 1 до 365 дней")
		return
	}
	if *settings.Address != "" {
		ip, err := netip.ParseAddr(*settings.Address)
		if err != nil || !ip.Is4() || ip.IsUnspecified() || ip.IsMulticast() {
			problem(w, 400, "invalid_syslog_address", "Выберите IPv4-адрес интерфейса сервера PL")
			return
		}
	}
	s.syslogReply(w, r, "receiver-set", settings)
}

func (s *Server) syslogReply(w http.ResponseWriter, r *http.Request, action string, payload any) {
	id := r.PathValue("id")
	response, err := s.Modules.SyslogRequest(r.Context(), id, action, payload)
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		problem(w, 503, "syslog_unavailable", "Журнал syslog недоступен. Проверьте состояние модуля.")
		return
	}
	if response.Status != 200 {
		var failure struct {
			Error struct{ Code, Message string }
		}
		if json.Unmarshal(response.Body, &failure) != nil || failure.Error.Message == "" {
			problem(w, 503, "syslog_unavailable", "Контроллер syslog не смог выполнить операцию")
			return
		}
		problem(w, response.Status, failure.Error.Code, failure.Error.Message)
		return
	}
	if action == "receiver-set" {
		if err := s.Store.Event(r.Context(), "syslog.receiver", "Изменены настройки приёма syslog", id, current(r).User.ID, nil, true); err != nil {
			s.fail(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(response.Body)
}
