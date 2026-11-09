package server

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-ldap/ldap/v3"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// AD login has its own persistent contract. It does not configure or reuse the
// independent directory projection used by Doska.
type adLoginConfiguration struct {
	URL          string `json:"url"`
	BaseDN       string `json:"base_dn"`
	UserSuffix   string `json:"user_suffix"`
	AdminGroupDN string `json:"admin_group_dn"`
	BindUsername string `json:"bind_username"`
	CAPEM        string `json:"ca_pem"`
}
type adSettingsInput struct {
	adLoginConfiguration
	Revision int64  `json:"revision"`
	Password string `json:"password"`
}
type adSettingsResponse struct {
	adLoginConfiguration
	Revision    int64      `json:"revision"`
	Configured  bool       `json:"configured"`
	Writable    bool       `json:"writable"`
	PasswordSet bool       `json:"password_set"`
	Source      string     `json:"source"`
	UpdatedAt   *time.Time `json:"updated_at,omitempty"`
	TestedAt    *time.Time `json:"tested_at,omitempty"`
}

func (s *Server) RegisterADSettingsRoutes(m *http.ServeMux) {
	protect := func(next http.HandlerFunc) http.HandlerFunc {
		authenticated := s.auth(next, true)
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if _, ok := r.Header["Authorization"]; ok {
				problem(w, 403, "forbidden", "Настройки AD доступны только через сессию администратора")
				return
			}
			authenticated(w, r)
		}
	}
	m.HandleFunc("GET /api/v1/settings/ad", protect(s.getADSettings))
	m.HandleFunc("POST /api/v1/settings/ad/test", protect(s.testADSettings))
	m.HandleFunc("PUT /api/v1/settings/ad", protect(s.saveADSettings))
}

func (v adLoginConfiguration) config(base Config) (Config, error) {
	c := base
	c.ADURL, c.ADBaseDN, c.ADUserSuffix, c.ADGroupDN, c.ADGroup = v.URL, v.BaseDN, v.UserSuffix, v.AdminGroupDN, ""
	c.CAFile = ""
	c.ADCAPEM = v.CAPEM
	if c.PortableRelease && c.ADCAPEM == "" {
		c.CAFile = c.OutboundCAFile
	}
	if len(v.URL) > 2048 || strings.TrimSpace(v.URL) != v.URL || !c.adEnabled() || len(v.BindUsername) == 0 || len(v.BindUsername) > 2048 || !utf8.ValidString(v.BindUsername) || strings.TrimSpace(v.BindUsername) != v.BindUsername || strings.ContainsAny(v.BindUsername, "\x00\r\n") || len(v.CAPEM) > 65536 {
		return c, store.ErrInvalid
	}
	if _, err := ldap.ParseDN(v.BindUsername); err != nil {
		if strings.Count(v.BindUsername, "@") != 1 || strings.ContainsAny(v.BindUsername, " \\/") {
			return c, store.ErrInvalid
		}
	}
	if v.CAPEM != "" {
		rest := []byte(v.CAPEM)
		found := false
		for len(strings.TrimSpace(string(rest))) > 0 {
			if !strings.HasPrefix(strings.TrimSpace(string(rest)), "-----BEGIN CERTIFICATE-----") {
				return c, store.ErrInvalid
			}
			block, left := pem.Decode(rest)
			if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) > 0 {
				return c, store.ErrInvalid
			}
			certificate, err := x509.ParseCertificate(block.Bytes)
			if err != nil || !certificate.IsCA {
				return c, store.ErrInvalid
			}
			found = true
			rest = left
		}
		if !found {
			return c, store.ErrInvalid
		}
	}
	if err := validateADConfig(c); err != nil {
		return c, store.ErrInvalid
	}
	return c, nil
}

func (v adLoginConfiguration) binding() string {
	// The codec accepts canonical HTTP origins. This internal origin is solely an
	// authenticated encryption binding; it is never requested over the network.
	b, _ := json.Marshal(v)
	return "ad-login:" + hash(string(b))
}

const adCredentialOrigin = "https://ad-login.invalid"

func (s *Server) adConfiguration(ctx context.Context) (Config, *store.ADLoginSettings, error) {
	if s.Store == nil {
		return s.Config, nil, nil
	}
	record, err := s.Store.ADLoginSettings(ctx)
	if errors.Is(err, store.ErrNotFound) {
		return s.Config, nil, nil
	}
	if err != nil {
		return Config{}, nil, errADUnavailable
	}
	var settings adLoginConfiguration
	if json.Unmarshal(record.Configuration, &settings) != nil {
		return Config{}, nil, errADUnavailable
	}
	c, err := settings.config(s.Config)
	if err != nil {
		return Config{}, nil, errADUnavailable
	}
	return c, &record, nil
}
func (s *Server) adStoredPassword(v adLoginConfiguration, record store.ADLoginSettings) (string, error) {
	if s.connectorCredentials == nil {
		return "", errADUnavailable
	}
	encoded, err := s.connectorCredentials.codec.Open(v.binding(), adCredentialOrigin, record.PasswordEnvelope)
	if err != nil {
		return "", errADUnavailable
	}
	password, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || !validADBindPassword(string(password)) {
		return "", errADUnavailable
	}
	return string(password), nil
}
func validADBindPassword(value string) bool {
	return len(value) > 0 && len(value) <= 1024 && utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\r\n")
}
func (s *Server) getADSettings(w http.ResponseWriter, r *http.Request) {
	_, record, err := s.adConfiguration(r.Context())
	if err != nil {
		problem(w, 503, "ad_settings_unavailable", "Не удалось прочитать настройки AD")
		return
	}
	response := adSettingsResponse{Writable: s.connectorCredentials != nil, Source: "web"}
	if record != nil {
		_ = json.Unmarshal(record.Configuration, &response.adLoginConfiguration)
		response.Revision = record.Revision
		response.Configured = true
		response.PasswordSet = true
		response.UpdatedAt = &record.UpdatedAt
		response.TestedAt = &record.TestedAt
	} else if s.Config.adEnabled() {
		response.Configured = true
		response.Source = "environment"
		response.adLoginConfiguration = adLoginConfiguration{URL: s.Config.ADURL, BaseDN: s.Config.ADBaseDN, UserSuffix: s.Config.ADUserSuffix, AdminGroupDN: s.Config.ADGroupDN}
	}
	respond(w, 200, response)
}
func (s *Server) prepareADSettings(ctx context.Context, input adSettingsInput) (Config, string, []byte, error) {
	if s.connectorCredentials == nil || s.Store == nil {
		return Config{}, "", nil, errADUnavailable
	}
	c, err := input.adLoginConfiguration.config(s.Config)
	if err != nil || input.Revision < 0 {
		return Config{}, "", nil, store.ErrInvalid
	}
	record, err := s.Store.ADLoginSettings(ctx)
	if errors.Is(err, store.ErrNotFound) {
		record = store.ADLoginSettings{}
	} else if err != nil {
		return Config{}, "", nil, errADUnavailable
	}
	if record.Revision != input.Revision {
		return Config{}, "", nil, store.ErrConflict
	}
	password := input.Password
	if password == "" && record.Revision > 0 {
		var previous adLoginConfiguration
		if json.Unmarshal(record.Configuration, &previous) != nil {
			return Config{}, "", nil, errADUnavailable
		}
		// Keeping a password while changing its login identity/destination must not
		// send an existing credential to an unrelated directory.
		if previous.URL != input.URL || previous.BindUsername != input.BindUsername {
			return Config{}, "", nil, store.ErrInvalid
		}
		password, err = s.adStoredPassword(previous, record)
		if err != nil {
			return Config{}, "", nil, err
		}
	}
	if !validADBindPassword(password) {
		return Config{}, "", nil, store.ErrInvalid
	}
	envelope, err := s.connectorCredentials.codec.Seal(input.binding(), adCredentialOrigin, base64.RawStdEncoding.EncodeToString([]byte(password)))
	return c, password, envelope, err
}

func testADConnection(ctx context.Context, c Config, username, password string) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	conn, err := dialAD(ctx, c)
	if err != nil {
		return errADUnavailable
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if err = conn.Bind(username, password); err != nil {
		return errADUnavailable
	}
	// A successful TLS handshake/bind alone is insufficient: prove that the
	// configured search root and administrator group are visible and exact.
	base, err := adSearch(conn, c.ADBaseDN, ldap.ScopeBaseObject, "(objectClass=*)", []string{"1.1"}, 1)
	if err != nil || len(base.Entries) != 1 {
		return errADUnavailable
	}
	group, err := adSearch(conn, c.ADGroupDN, ldap.ScopeBaseObject, "(objectClass=group)", []string{"distinguishedName"}, 1)
	if err != nil || len(group.Entries) != 1 {
		return errADUnavailable
	}
	found, err := ldap.ParseDN(group.Entries[0].DN)
	if err != nil {
		return errADUnavailable
	}
	expected, err := ldap.ParseDN(c.ADGroupDN)
	if err != nil || !found.EqualFold(expected) {
		return errADUnavailable
	}
	return nil
}
func (s *Server) applyADSettings(w http.ResponseWriter, r *http.Request, save bool) {
	var input adSettingsInput
	if !decode(w, r, &input) {
		return
	}
	c, password, envelope, err := s.prepareADSettings(r.Context(), input)
	input.Password = ""
	if err == nil {
		select {
		case adLoginSlots <- struct{}{}:
			err = func() error {
				defer func() { <-adLoginSlots }()
				return testADConnection(r.Context(), c, input.BindUsername, password)
			}()
		default:
			problem(w, 429, "ad_busy", "Проверка AD занята. Повторите через несколько секунд.")
			return
		}
	}
	password = ""
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			s.fail(w, err)
			return
		}
		if errors.Is(err, store.ErrInvalid) {
			problem(w, 400, "invalid_ad_settings", "Проверьте адрес AD, DN, домен входа, CA и учётные данные. При изменении адреса или учётной записи укажите пароль заново.")
			return
		}
		problem(w, 503, "ad_connection_failed", "Не удалось проверить AD. Проверьте TLS, доступность сервера, учётную запись чтения, Base DN и группу администраторов.")
		return
	}
	if !save {
		respond(w, 200, map[string]any{"ok": true, "tested_at": time.Now().UTC()})
		return
	}
	// Testing the directory can take several seconds. Recheck the session and
	// current administrator role before changing the installation's login policy.
	actor, sessionErr := s.readSession(r)
	if sessionErr != nil {
		if errors.Is(sessionErr, errADUnavailable) {
			problem(w, 503, "ad_unavailable", "Не удалось проверить права администратора через AD")
		} else {
			problem(w, 401, "session_expired", "Войдите в портал")
		}
		return
	}
	if !actor.User.Admin {
		problem(w, 403, "forbidden", "Настройки AD доступны только администратору")
		return
	}
	raw, _ := json.Marshal(input.adLoginConfiguration)
	err = s.Store.SaveADLoginSettings(r.Context(), store.ADLoginSettings{Configuration: raw, PasswordEnvelope: envelope, TestedAt: time.Now().UTC()}, input.Revision, actor.User.ID)
	if err != nil {
		s.fail(w, err)
		return
	}
	_ = s.Store.Event(r.Context(), "auth.ad_configured", "Изменены настройки входа через AD", "", current(r).User.ID, nil, true)
	s.getADSettings(w, r)
}
func (s *Server) testADSettings(w http.ResponseWriter, r *http.Request) {
	s.applyADSettings(w, r, false)
}
func (s *Server) saveADSettings(w http.ResponseWriter, r *http.Request) {
	s.applyADSettings(w, r, true)
}

// Existing managed AD sessions use the current group/account state, never the
// role copied into the session at login. Local recovery access is independent.
func (s *Server) revalidateADSession(ctx context.Context, c Config, record store.ADLoginSettings, user model.User) (model.User, error) {
	var settings adLoginConfiguration
	if json.Unmarshal(record.Configuration, &settings) != nil {
		return model.User{}, errADUnavailable
	}
	password, err := s.adStoredPassword(settings, record)
	if err != nil {
		return model.User{}, err
	}
	namespace := "ad:" + hash(strings.ToLower(c.ADBaseDN))[:16] + ":"
	if !strings.HasPrefix(user.ID, namespace) {
		return model.User{}, errADCredentials
	}
	guid, err := hex.DecodeString(strings.TrimPrefix(user.ID, namespace))
	if err != nil || len(guid) != 16 {
		return model.User{}, errADCredentials
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	select {
	case adLoginSlots <- struct{}{}:
		defer func() { <-adLoginSlots }()
	case <-ctx.Done():
		return model.User{}, errADUnavailable
	}
	conn, err := dialAD(ctx, c)
	if err != nil {
		return model.User{}, errADUnavailable
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if err = conn.Bind(settings.BindUsername, password); err != nil {
		return model.User{}, errADUnavailable
	}
	password = ""
	escaped := strings.Builder{}
	for _, b := range guid {
		escaped.WriteByte('\\')
		escaped.WriteString(hex.EncodeToString([]byte{b}))
	}
	result, err := adSearch(conn, c.ADBaseDN, ldap.ScopeWholeSubtree, "(&(objectClass=user)(objectGUID="+escaped.String()+"))", []string{"objectGUID", "sAMAccountName", "displayName", "userAccountControl", "accountExpires"}, 2)
	if err != nil {
		return model.User{}, err
	}
	if len(result.Entries) != 1 {
		return model.User{}, errADCredentials
	}
	entry := result.Entries[0]
	if hex.EncodeToString(entry.GetRawAttributeValue("objectGUID")) != hex.EncodeToString(guid) {
		return model.User{}, errADUnavailable
	}
	if err = validADAccount(entry); err != nil {
		return model.User{}, err
	}
	membership, err := adSearch(conn, entry.DN, ldap.ScopeBaseObject, "(&(objectClass=user)(memberOf:"+adChainRule+":="+ldap.EscapeFilter(c.ADGroupDN)+"))", []string{"1.1"}, 1)
	if err != nil || len(membership.Entries) > 1 {
		return model.User{}, errADUnavailable
	}
	user.Admin = len(membership.Entries) == 1
	user.Name = entry.GetAttributeValue("displayName")
	if user.Name == "" {
		user.Name = entry.GetAttributeValue("sAMAccountName")
	}
	return user, nil
}
