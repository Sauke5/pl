package modules

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGrafanaControllerBindsExactIdentityRoleAndRequestWithHMAC(t *testing.T) {
	const id = "22222222-2222-4222-8222-222222222222"
	for _, admin := range []bool{false, true} {
		t.Run(map[bool]string{false: "viewer", true: "admin"}[admin], func(t *testing.T) {
			c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				mac := hmac.New(sha256.New, make([]byte, 32))
				mac.Write([]byte(r.Header.Get("X-Pl-Timestamp") + "\nPOST\n/v1/grafana/request\n"))
				mac.Write(raw)
				if r.Method != "POST" || r.URL.RequestURI() != "/v1/grafana/request" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("X-Pl-Timestamp") == "" || r.Header.Get("X-Pl-Signature") != hex.EncodeToString(mac.Sum(nil)) {
					t.Error("request is not bound to signed root channel")
				}
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Proxy-Authorization") != "" {
					t.Error("browser credentials crossed root channel")
				}
				var input struct {
					InstanceID  string `json:"instance_id"`
					Method      string `json:"method"`
					Path        string `json:"path"`
					Query       string `json:"query"`
					ContentType string `json:"content_type"`
					UserID      string `json:"user_id"`
					UserName    string `json:"user_name"`
					Admin       bool   `json:"admin"`
					Body        string `json:"body"`
				}
				if json.Unmarshal(raw, &input) != nil || input.InstanceID != id || input.Method != "POST" || input.Path != "/grafana/api/ds/query" || input.Query != "q=a%2Fb" || input.ContentType != "application/json" || input.UserID != "fixture-user" || input.UserName != "Тестовый пользователь" || input.Admin != admin || input.Body != base64.StdEncoding.EncodeToString([]byte(`{"queries":[]}`)) {
					t.Error("identity, role, exact target or body changed")
				}
				w.Header().Set("Set-Cookie", "forbidden=fixture")
				w.Header().Set("Proxy-Authenticate", "Basic fixture")
				json.NewEncoder(w).Encode(map[string]any{"instance_id": id, "status": 200, "content_type": "application/json", "body": base64.StdEncoding.EncodeToString([]byte(`{"results":{}}`))})
			})
			response, err := c.RequestGrafana(context.Background(), id, "POST", "/grafana/api/ds/query", "q=a%2Fb", "application/json", "fixture-user", "Тестовый пользователь", admin, []byte(`{"queries":[]}`))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, _ := io.ReadAll(response.Body)
			if response.StatusCode != 200 || string(raw) != `{"results":{}}` || len(response.Header) != 1 || response.Header.Get("Set-Cookie") != "" || response.Header.Get("Proxy-Authenticate") != "" {
				t.Fatal("unsafe or changed response envelope")
			}
		})
	}
}

func TestGrafanaControllerRejectsInvalidAndOversizedResponseWithoutLeakingBody(t *testing.T) {
	const id = "22222222-2222-4222-8222-222222222222"
	const secret = "fixture-upstream-secret-never-return"
	for _, scenario := range []string{"root-error", "wrong-method-root-rejected", "wrong-instance", "redirect", "invalid-base64", "invalid-type", "decoded-too-large", "envelope-too-large", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if scenario == "root-error" || scenario == "wrong-method-root-rejected" {
					status := 500
					if scenario == "wrong-method-root-rejected" {
						status = 405
					}
					w.WriteHeader(status)
					io.WriteString(w, secret)
					return
				}
				if scenario == "envelope-too-large" {
					io.WriteString(w, strings.Repeat(" ", (8<<20)*4/3+4097))
					return
				}
				if scenario == "malformed" {
					io.WriteString(w, secret)
					return
				}
				returnedID, status, ct, body := id, 200, "application/json", base64.StdEncoding.EncodeToString([]byte(secret))
				switch scenario {
				case "wrong-instance":
					returnedID = "foreign"
				case "redirect":
					status = 302
				case "invalid-base64":
					body = "?"
				case "invalid-type":
					ct = "text/html\nX-Secret: " + secret
				case "decoded-too-large":
					body = base64.StdEncoding.EncodeToString(make([]byte, (8<<20)+1))
				}
				json.NewEncoder(w).Encode(map[string]any{"instance_id": returnedID, "status": status, "content_type": ct, "body": body})
			})
			method := "GET"
			if scenario == "wrong-method-root-rejected" {
				method = "TRACE"
			}
			response, err := c.RequestGrafana(context.Background(), id, method, "/grafana/", "", "", "fixture-user", "User", false, nil)
			if response != nil {
				response.Body.Close()
			}
			if err == nil || strings.Contains(err.Error(), secret) {
				t.Fatal("invalid controller response accepted or leaked upstream diagnostic")
			}
		})
	}
}

func TestGrafanaControllerRejectsInvalidRequestBeforeRoot(t *testing.T) {
	calls := 0
	c := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) })
	for _, tc := range []struct {
		id, user, name string
		body           []byte
	}{
		{"foreign", "user", "User", nil},
		{"22222222-2222-4222-8222-222222222222", "", "User", nil},
		{"22222222-2222-4222-8222-222222222222", strings.Repeat("u", 257), "User", nil},
		{"22222222-2222-4222-8222-222222222222", "user", strings.Repeat("n", 513), nil},
		{"22222222-2222-4222-8222-222222222222", "user", "User", make([]byte, (512<<10)+1)},
	} {
		if _, err := c.RequestGrafana(context.Background(), tc.id, "GET", "/grafana/", "", "", tc.user, tc.name, false, tc.body); err == nil {
			t.Error("invalid request accepted")
		}
	}
	if calls != 0 {
		t.Fatal("invalid request reached controller")
	}
}
