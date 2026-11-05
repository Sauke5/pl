package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"pl/portal/internal/model"
)

type machinePrincipal struct {
	ID          string    `json:"id"`
	TokenSHA256 string    `json:"token_sha256"`
	Scopes      []string  `json:"scopes"`
	ExpiresAt   time.Time `json:"expires_at"`
}

var machineID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

// machineScope is deliberately a closed route list, independent of admin rights.
func machineScope(method, path string) string {
	if method == http.MethodGet {
		switch path {
		case "/api/v1/doska-directory/identity", "/api/v1/doska-directory/employees", "/api/v1/doska-directory/departments", "/api/v1/doska-directory/changes":
			return "doska:directory:read"
		case "/api/v1/resources", "/api/v1/search", "/api/v1/candidates", "/api/v1/problems", "/api/v1/dictionaries":
			return "catalog:read"
		}
	}
	if method == http.MethodPost {
		switch path {
		case "/api/v1/resources":
			return "catalog:write"
		case "/api/v1/candidates/resolve":
			return "discovery:write"
		}
	}
	parts := strings.Split(path, "/")
	if len(parts) < 5 || len(parts) > 6 || parts[0] != "" || parts[1] != "api" || parts[2] != "v1" {
		return ""
	}
	id, err := uuid.Parse(parts[4])
	if err != nil || id.String() != parts[4] {
		return ""
	}
	if parts[3] == "resources" {
		if method == http.MethodGet && (len(parts) == 5 || parts[5] == "inventory") {
			return "catalog:read"
		}
		if method == http.MethodPut && len(parts) == 5 {
			return "catalog:write"
		}
	}
	if parts[3] == "problems" && len(parts) == 6 && parts[5] == "links" {
		if method == http.MethodGet {
			return "catalog:read"
		}
		if method == http.MethodPut {
			return "problems:write"
		}
	}
	return ""
}

func (s *Server) machineAuth(next http.HandlerFunc, w http.ResponseWriter, r *http.Request) {
	deny := func() {
		problem(w, http.StatusUnauthorized, "machine_auth", "Недействительные учётные данные сервиса")
	}
	if s.Config.MachineCredentialsFile == "" || len(r.Header.Values("Authorization")) != 1 || len(r.Header.Values("Origin")) != 0 || len(r.Header.Values("Cookie")) != 0 {
		deny()
		return
	}
	auth := strings.Fields(r.Header.Get("Authorization"))
	if len(auth) != 2 || !strings.EqualFold(auth[0], "Bearer") || len(auth[1]) < 32 || len(auth[1]) > 4096 {
		deny()
		return
	}
	// Reopen for every request: revocation never waits for a process restart.
	f, err := os.Open(s.Config.MachineCredentialsFile)
	if err != nil {
		deny()
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(data) > 65536 {
		deny()
		return
	}
	var config struct {
		Principals []machinePrincipal `json:"principals"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || decoder.Decode(new(any)) != io.EOF || len(config.Principals) > 100 {
		deny()
		return
	}
	sum := sha256.Sum256([]byte(auth[1]))
	var matched *machinePrincipal
	ids, hashes := map[string]bool{}, map[string]bool{}
	for i := range config.Principals {
		p := &config.Principals[i]
		digest, err := hex.DecodeString(p.TokenSHA256)
		if err != nil || len(digest) != sha256.Size || !machineID.MatchString(p.ID) || ids[p.ID] || hashes[strings.ToLower(p.TokenSHA256)] || p.ExpiresAt.IsZero() || len(p.Scopes) == 0 {
			deny()
			return
		}
		ids[p.ID] = true
		hashes[strings.ToLower(p.TokenSHA256)] = true
		for _, scope := range p.Scopes {
			switch scope {
			case "catalog:read", "catalog:write", "discovery:write", "problems:write", "doska:directory:read":
			default:
				deny()
				return
			}
		}
		if subtle.ConstantTimeCompare(sum[:], digest) == 1 {
			matched = p
		}
	}
	if matched == nil || !time.Now().Before(matched.ExpiresAt) {
		deny()
		return
	}
	scope := machineScope(r.Method, r.URL.Path)
	allowed := false
	for _, granted := range matched.Scopes {
		if scope != "" && granted == scope {
			allowed = true
		}
	}
	if !allowed || r.URL.RawPath != "" {
		problem(w, http.StatusForbidden, "machine_scope", "Операция недоступна этой сервисной учётной записи")
		return
	}
	v := session{User: model.User{ID: "machine:" + matched.ID, Name: matched.ID, Admin: true}, ExpiresAt: matched.ExpiresAt}
	next(w, r.WithContext(context.WithValue(r.Context(), sessionKey, v)))
}
