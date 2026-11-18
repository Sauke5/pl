package server

import (
	"archive/zip"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/store"
)

var (
	vpnRevision    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	vpnLocalUser   = regexp.MustCompile(`^local:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
	vpnDNSLabel    = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
	vpnNumericHost = regexp.MustCompile(`^[.0-9]+$`)
)

type vpnSetupState struct {
	ManagedCertificates bool   `json:"managed_certificates"`
	Revision            string `json:"revision"`
	Name                string `json:"name"`
	AuthMode            string `json:"auth_mode"`
	Issuer              string `json:"issuer"`
	ClientID            string `json:"client_id"`
	PublicHost          string `json:"public_host"`
	PublicPort          int    `json:"public_port"`
	BindAddress         string `json:"bind_address"`
	Port                int    `json:"port"`
	Pool                string `json:"pool"`
	HasCertificate      bool   `json:"has_certificate"`
	HasKey              bool   `json:"has_key"`
	HasClientSecret     bool   `json:"has_client_secret"`
	HasIDPCA            bool   `json:"has_idp_ca"`
	CertificatePin      string `json:"certificate_pin"`
	Ready               bool   `json:"ready"`
}

type vpnDiscovery struct {
	Addresses   []string `json:"addresses"`
	BindAddress string   `json:"bind_address"`
	PublicIP    string   `json:"public_ip"`
	Source      string   `json:"source"`
	Pool        string   `json:"pool"`
}

func vpnPublicHost(host string) bool {
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.Is4()
	}
	if len(host) > 253 || vpnNumericHost.MatchString(host) {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if !vpnDNSLabel.MatchString(label) {
			return false
		}
	}
	return true
}

func vpnPort(p int) bool { return p >= 1 && p <= 65535 }

func vpnNoQuery(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		problem(w, 400, "invalid_vpn_query", "В запросе VPN есть лишние параметры")
		return false
	}
	return true
}

func vpnBadReply(w http.ResponseWriter) {
	problem(w, 503, "ocserv_invalid_response", "Контроллер VPN вернул неполное состояние")
}

func vpnRequestError(w http.ResponseWriter, reply modules.NativeControlReply, err error) {
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
	var failure struct {
		Error struct{ Code, Message string }
	}
	if json.Unmarshal(reply.Body, &failure) != nil || failure.Error.Message == "" || len(failure.Error.Message) > 1024 {
		vpnBadReply(w)
		return
	}
	problem(w, reply.Status, failure.Error.Code, failure.Error.Message)
}

func (s *Server) vpnRequest(w http.ResponseWriter, r *http.Request, id, action string, input map[string]any) (modules.NativeControlReply, bool) {
	reply, err := s.Modules.OcservRequest(r.Context(), id, action, input)
	if err != nil || reply.Status != http.StatusOK {
		vpnRequestError(w, reply, err)
		return reply, false
	}
	return reply, true
}

func vpnConfigure(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var in struct {
		Revision     string  `json:"revision"`
		Name         string  `json:"name"`
		AuthMode     string  `json:"auth_mode"`
		Issuer       string  `json:"issuer"`
		ClientID     string  `json:"client_id"`
		PublicHost   string  `json:"public_host"`
		PublicPort   int     `json:"public_port"`
		BindAddress  string  `json:"bind_address"`
		Port         int     `json:"port"`
		Pool         string  `json:"pool"`
		Certificate  *string `json:"cert_pem"`
		Key          *string `json:"key_pem"`
		ClientSecret *string `json:"client_secret"`
		IDPCA        *string `json:"idp_ca_pem"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	if !decode(w, r, &in) {
		return nil, false
	}
	if in.AuthMode == "" {
		in.AuthMode = "oidc"
	}
	addr, err := netip.ParseAddr(in.BindAddress)
	pool, poolErr := netip.ParsePrefix(in.Pool)
	if !vpnRevision.MatchString(in.Revision) || !vpnName(in.Name) || !vpnPublicHost(in.PublicHost) ||
		err != nil || !addr.Is4() || !vpnPort(in.Port) || !vpnPort(in.PublicPort) ||
		poolErr != nil || !pool.Addr().Is4() || pool.Masked().String() != in.Pool || pool.Bits() < 8 || pool.Bits() > 29 ||
		(in.AuthMode != "certificate" && in.AuthMode != "oidc") {
		problem(w, 400, "invalid_vpn_setup", "Проверьте параметры шлюза, порты и пул IPv4.")
		return nil, false
	}
	result := map[string]any{"actor": current(r).User.ID, "revision": in.Revision, "name": in.Name, "auth_mode": in.AuthMode,
		"public_host": in.PublicHost, "public_port": in.PublicPort, "bind_address": in.BindAddress, "port": in.Port, "pool": in.Pool}
	if in.AuthMode == "oidc" {
		u, err := url.Parse(in.Issuer)
		if err != nil || len(in.Issuer) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || in.ClientID == "" || len(in.ClientID) > 256 {
			problem(w, 400, "invalid_vpn_dex", "Проверьте HTTPS-адрес Dex и идентификатор клиента.")
			return nil, false
		}
		result["issuer"], result["client_id"] = in.Issuer, in.ClientID
	} else if in.Issuer != "" || in.ClientID != "" || in.ClientSecret != nil || in.IDPCA != nil {
		problem(w, 400, "invalid_vpn_setup", "Параметры Dex применимы только при входе через Dex.")
		return nil, false
	}
	for key, value := range map[string]*string{"cert_pem": in.Certificate, "key_pem": in.Key, "client_secret": in.ClientSecret, "idp_ca_pem": in.IDPCA} {
		if value != nil {
			if len(*value) > 128<<10 {
				problem(w, 400, "invalid_vpn_size", "Размер одного файла ограничен 128 КиБ.")
				return nil, false
			}
			result[key] = *value
		}
	}
	return result, true
}

func (s *Server) vpnSetup(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !vpnNoQuery(w, r) {
			return
		}
		input := map[string]any{}
		if action == "configure" {
			var ok bool
			if input, ok = vpnConfigure(w, r); !ok {
				return
			}
		}
		reply, ok := s.vpnRequest(w, r, r.PathValue("id"), action, input)
		if !ok {
			return
		}
		if action == "discover" {
			var out vpnDiscovery
			if json.Unmarshal(reply.Body, &out) != nil || out.Addresses == nil ||
				(out.Source != "external" && out.Source != "interface" && out.Source != "unavailable") {
				vpnBadReply(w)
				return
			}
			respond(w, 200, out)
			return
		}
		var out vpnSetupState
		if json.Unmarshal(reply.Body, &out) != nil || !vpnRevision.MatchString(out.Revision) || !vpnName(out.Name) {
			vpnBadReply(w)
			return
		}
		respond(w, 200, out)
	}
}

func (s *Server) vpnAdminDownload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query, err := url.ParseQuery(r.URL.RawQuery)
	subject := query.Get("subject")
	if err != nil || len(query) != 1 || len(query["subject"]) != 1 || !vpnSubject.MatchString(subject) {
		problem(w, 400, "invalid_vpn_subject", "Укажите сотрудника VPN.")
		return
	}
	reply, ok := s.vpnRequest(w, r, r.PathValue("id"), "connection", map[string]any{"subject": subject})
	if ok {
		vpnProfileResponse(w, reply.Body, subject, "", false)
	}
}

func (s *Server) vpnSelf(status bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if _, present := r.Header["Authorization"]; present {
			problem(w, 403, "forbidden", "Подключение доступно через личную сессию сотрудника.")
			return
		}
		s.auth(func(w http.ResponseWriter, r *http.Request) {
			if !vpnNoQuery(w, r) {
				return
			}
			uid := current(r).User.ID
			if (!vpnRevision.MatchString(uid) && !vpnLocalUser.MatchString(uid)) || s.Modules == nil {
				vpnNoProfile(w, status)
				return
			}
			items, err := store.List[model.ModuleInstance](r.Context(), s.Store, "module_instance")
			if err != nil {
				s.fail(w, err)
				return
			}
			for _, instance := range items {
				if instance.ModuleID != "ocserv" || instance.Mode != "local" || instance.DesiredState != "enabled" {
					continue
				}
				input := map[string]any{"portal_user_id": uid}
				if status {
					input["status_only"] = true
				}
				reply, err := s.Modules.OcservRequest(r.Context(), instance.ID, "connection", input)
				if errors.Is(err, store.ErrNotFound) || (err == nil && reply.Status == 404) {
					continue
				}
				if err != nil || reply.Status != 200 {
					vpnRequestError(w, reply, err)
					return
				}
				vpnProfileResponse(w, reply.Body, "", uid, status)
				return
			}
			vpnNoProfile(w, status)
		}, false)(w, r)
	}
}

func vpnNoProfile(w http.ResponseWriter, status bool) {
	if status {
		respond(w, 200, map[string]bool{"available": false})
		return
	}
	problem(w, 404, "ocserv_connection", "Профиль подключения VPN недоступен.")
}

func vpnProfileResponse(w http.ResponseWriter, raw json.RawMessage, subject, uid string, statusOnly bool) {
	var p struct {
		Subject string `json:"subject"`
		Issuer  string `json:"issuer"`
		Mode    string `json:"auth_mode"`
		Host    string `json:"public_host"`
		Port    int    `json:"public_port"`
		Pin     string `json:"certificate_pin"`
		Cert    string `json:"client_cert_pem"`
		Key     string `json:"client_key_pem"`
	}
	if json.Unmarshal(raw, &p) != nil || !vpnSubject.MatchString(p.Subject) || !vpnPublicHost(p.Host) || !vpnPort(p.Port) ||
		(p.Mode != "certificate" && p.Mode != "oidc") || (p.Mode == "oidc" && p.Issuer == "") {
		vpnBadReply(w)
		return
	}
	encoded, found := strings.CutPrefix(p.Pin, "pin-sha256:")
	digest, err := base64.StdEncoding.DecodeString(encoded)
	if !found || err != nil || len(digest) != 32 || base64.StdEncoding.EncodeToString(digest) != encoded {
		vpnBadReply(w)
		return
	}
	owner := p.Subject
	if p.Mode == "oidc" {
		owner = hash(p.Issuer + "\x00" + p.Subject)
	}
	if (subject != "" && subject != p.Subject) || (uid != "" && uid != owner) {
		vpnNoProfile(w, statusOnly)
		return
	}
	if statusOnly {
		respond(w, 200, map[string]bool{"available": true})
		return
	}

	url := "https://" + p.Host
	if p.Port != 443 {
		url += ":" + strconv.Itoa(p.Port)
	}
	conf := "protocol=anyconnect\nserver=" + url + "\nservercert=" + p.Pin + "\n"
	name := "pl-vpn-" + strings.ReplaceAll(p.Subject, ":", "-")
	var content []byte
	kind := "application/octet-stream"
	if p.Mode == "certificate" {
		if _, err := tls.X509KeyPair([]byte(p.Cert), []byte(p.Key)); err != nil {
			vpnBadReply(w)
			return
		}
		conf += "certificate=client.crt\nsslkey=client.key\n"
		content, err = vpnProfileZip(conf, p.Cert, p.Key)
		if err != nil {
			vpnBadReply(w)
			return
		}
		kind, name = "application/zip", name+".zip"
	} else {
		content, name = []byte(conf), name+".conf"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Type", kind)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(200)
	_, _ = w.Write(content)
}

func vpnProfileZip(config, cert, key string) ([]byte, error) {
	const instructions = "Распакуйте архив в личную папку. Он содержит ваш закрытый ключ.\r\nОткройте терминал в этой папке. Для подключения нужен OpenConnect.\r\nLinux и macOS: sudo openconnect --config pl-vpn.conf\r\nWindows (терминал администратора): openconnect.exe --config pl-vpn.conf\r\n"
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []struct{ name, body string }{{"pl-vpn.conf", config}, {"client.crt", cert}, {"client.key", key}, {"README.txt", instructions}} {
		header := zip.FileHeader{Name: f.name, Method: zip.Store}
		header.SetMode(0600)
		w, err := zw.CreateHeader(&header)
		if err != nil {
			return nil, err
		}
		if _, err = fmt.Fprint(w, f.body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
