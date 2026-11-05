//go:build optional_module_acceptance

package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

// This opt-in acceptance test runs the exact native product, not a mock HTTP API.
// All accounts, SQLite data, keys and uploaded content live in its removed fixture.
func TestSFTPAdminNative276RoundTrip(t *testing.T) {
	if os.Getenv("PORTAL_SFTP_ADM_NATIVE_TEST") != "1" {
		t.Fatal("set PORTAL_SFTP_ADM_NATIVE_TEST=1 to run isolated native Docker acceptance")
	}
	const image = "drakkan/sftpgo@sha256:1edd28d80de2a008863fbfc58c8ff7db47b1b410bae48d4e6076192337809b11"
	dir := t.TempDir()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(123456), Subject: pkix.Name{CommonName: "SFTP administration TEST ONLY"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"host.docker.internal", "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	write := func(name string, b []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("ca.pem", certPEM)
	write("tls.pem", certPEM)
	write("tls.key", keyPEM)
	write("oidc.key", keyPEM)
	write("oidc.secret", []byte(strings.Repeat("test-only-secret-", 3)))
	mux := http.NewServeMux()
	portal := httptest.NewUnstartedServer(mux)
	portal.Listener.Close()
	portal.Listener, err = net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	portal.TLS = &tls.Config{Certificates: []tls.Certificate{tlsCert}, MinVersion: tls.VersionTLS12}
	portal.StartTLS()
	t.Cleanup(portal.Close)
	_, port, _ := net.SplitHostPort(portal.Listener.Addr().String())
	publicURL := "https://host.docker.internal:" + port
	s := &Server{Config: Config{PublicURL: publicURL}}
	issuer, err := newSFTPAdminOIDC(s, SFTPAdminOIDCConfig{Issuer: publicURL + sftpAdminIssuerPath, ClientID: "pl-sftp-adm", RedirectURL: publicURL + "/sftp-adm/web/oidc/redirect", ClientSecretFile: filepath.Join(dir, "oidc.secret"), SigningKeyFile: filepath.Join(dir, "oidc.key")})
	if err != nil {
		t.Fatal(err)
	}
	sessions := map[string]session{}
	issuer.lookup = func(_ context.Context, key string) (session, error) {
		v, ok := sessions[key]
		if !ok {
			return session{}, os.ErrNotExist
		}
		return v, nil
	}
	issuer.audit = func(context.Context, sftpAdminGrant) error { return nil }
	issuer.registerRoutes(mux)
	cfg := map[string]any{
		"sftpd": map[string]any{"bindings": []map[string]any{{"port": 0}}}, "ftpd": map[string]any{"bindings": []map[string]any{{"port": 0}}}, "webdavd": map[string]any{"bindings": []map[string]any{{"port": 0}}}, "telemetry": map[string]any{"bind_port": 0},
		"data_provider": map[string]any{"driver": "sqlite", "name": "/fixture/sftpgo.db", "create_default_admin": true, "users_base_dir": "/fixture/data"},
		"http":          map[string]any{"ca_certificates": []string{"/fixture/ca.pem"}},
		"httpd":         map[string]any{"web_root": "/sftp-adm", "templates_path": "/usr/share/sftpgo/templates", "static_files_path": "/usr/share/sftpgo/static", "openapi_path": "/usr/share/sftpgo/openapi", "bindings": []map[string]any{{"address": "0.0.0.0", "port": 8443, "enable_web_admin": true, "enable_web_client": true, "enable_rest_api": true, "enable_https": true, "certificate_file": "/fixture/tls.pem", "certificate_key_file": "/fixture/tls.key", "disabled_login_methods": 12, "oidc": map[string]any{"client_id": "pl-sftp-adm", "client_secret_file": "/fixture/oidc.secret", "config_url": issuer.config.Issuer, "redirect_base_url": publicURL, "username_field": "preferred_username", "implicit_roles": true, "scopes": []string{"openid", "profile"}}}}},
	}
	raw, _ := json.Marshal(cfg)
	write("sftpgo.json", raw)
	name := "pl-sftp-adm-native-" + hash(dir)[:12]
	cmd := exec.Command("docker", "run", "-d", "--name", name, "--user", "0:0", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", dir+":/fixture", "-p", "127.0.0.1::8443", "-e", "SFTPGO_DEFAULT_ADMIN_USERNAME=fixture-bootstrap", "-e", "SSL_CERT_FILE=/fixture/ca.pem", "-e", "SFTPGO_DEFAULT_ADMIN_PASSWORD=test-only-native-bootstrap-password", image, "sftpgo", "serve", "--config-dir", "/fixture", "--config-file", "sftpgo.json", "--log-file-path", "")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("native container start: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	out, err := exec.Command("docker", "port", name, "8443/tcp").Output()
	if err != nil {
		t.Fatal(err)
	}
	nativeURL := "https://" + strings.TrimSpace(string(out))
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(certPEM)
	tr := &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		h, p, _ := net.SplitHostPort(address)
		if h == "host.docker.internal" {
			address = net.JoinHostPort("127.0.0.1", p)
		}
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, network, address)
	}}
	direct := &http.Client{Transport: tr, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var accessToken string
	deadline := time.Now().Add(35 * time.Second)
	for time.Now().Before(deadline) {
		r, _ := http.NewRequest("GET", nativeURL+"/api/v2/token", nil)
		r.SetBasicAuth("fixture-bootstrap", "test-only-native-bootstrap-password")
		response, e := direct.Do(r)
		if e == nil {
			var v struct {
				AccessToken string `json:"access_token"`
			}
			json.NewDecoder(response.Body).Decode(&v)
			response.Body.Close()
			if response.StatusCode == 200 {
				accessToken = v.AccessToken
				break
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	if accessToken == "" {
		logs, _ := exec.Command("docker", "logs", "--tail", "15", name).CombinedOutput()
		t.Fatalf("native startup failed: %s", logs)
	}
	nativeAPI := func(method, path string, input any, output any) {
		t.Helper()
		var body io.Reader
		if input != nil {
			b, _ := json.Marshal(input)
			body = bytes.NewReader(b)
		}
		r, _ := http.NewRequest(method, nativeURL+path, body)
		r.Header.Set("Authorization", "Bearer "+accessToken)
		r.Header.Set("Content-Type", "application/json")
		resp, e := direct.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			t.Fatalf("native API %s %s status:%d", method, path, resp.StatusCode)
		}
		if output != nil {
			if e = json.NewDecoder(resp.Body).Decode(output); e != nil {
				t.Fatal(e)
			}
		}
	}
	provisioner := map[string]any{"username": "fixture-provisioner", "password": "test-only-native-provisioner-password", "status": 1, "permissions": []string{"*"}, "filters": map[string]any{"allow_api_key_auth": true}}
	nativeAPI("POST", "/api/v2/admins", provisioner, nil)
	var apiKey struct {
		Key string `json:"key"`
	}
	nativeAPI("POST", "/api/v2/apikeys", map[string]any{"name": "fixture-provisioner", "scope": 1, "admin": "fixture-provisioner"}, &apiKey)
	write("native.key", []byte(apiKey.Key))
	gateway, err := newSFTPAdminGateway(s, SFTPAdminConfig{UpstreamURL: nativeURL, CAFile: filepath.Join(dir, "ca.pem"), AdminKeyFile: filepath.Join(dir, "native.key"), DataRoot: "/fixture/data", AllowedCIDRs: []string{"127.0.0.1/32"}}, issuer)
	if err != nil {
		t.Fatal(err)
	}
	gateway.readSession = func(r *http.Request) (session, error) { v, _, e := issuer.readSession(r); return v, e }
	gateway.registerRoutes(mux)
	browser := func(id string, admin bool) *http.Client {
		t.Helper()
		token := "native-fixture-" + id
		sessions[hash(token)] = session{User: model.User{ID: id, Name: "Fixture " + id, Admin: admin}, CSRF: "fixture-csrf-" + id, ExpiresAt: time.Now().Add(time.Hour)}
		jar, _ := cookiejar.New(nil)
		u, _ := url.Parse(publicURL)
		jar.SetCookies(u, []*http.Cookie{{Name: "portal_session", Value: token, Path: "/", Secure: true, HttpOnly: true}})
		return &http.Client{Transport: tr, Jar: jar, Timeout: 15 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) > 10 {
				return fmt.Errorf("too many native redirects")
			}
			if r.URL.Scheme+"://"+r.URL.Host != publicURL {
				return fmt.Errorf("native redirect escaped Portal origin")
			}
			return nil
		}}
	}
	fetch := func(c *http.Client, method, path string, body io.Reader, headers map[string]string) (int, []byte, http.Header) {
		t.Helper()
		r, _ := http.NewRequest(method, publicURL+path, body)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		res, e := c.Do(r)
		if e != nil {
			t.Fatalf("%s %s: %v", method, path, e)
		}
		defer res.Body.Close()
		b, e := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		if e != nil {
			t.Fatal(e)
		}
		if res.Header.Get("Set-Cookie") != "" {
			for _, cookie := range res.Cookies() {
				if cookie.Name != "pl_sftp_flow" {
					t.Fatalf("native cookie leaked:%s", cookie.Name)
				}
			}
		}
		return res.StatusCode, b, res.Header
	}
	admin := browser("admin-person", true)
	status, body, _ := fetch(admin, "GET", "/sftp-adm/open/admin", nil, nil)
	if status != 200 {
		t.Fatalf("native admin login status:%d body:%s", status, body[:min(len(body), 500)])
	}
	status, body, _ = fetch(admin, "GET", "/sftp-adm/web/admin/users/json", nil, nil)
	if status != 200 || !json.Valid(body) {
		t.Fatalf("native admin users listing:%d %s", status, body)
	}
	status, body, _ = fetch(admin, "GET", "/sftp-adm/web/admin/folder", nil, nil)
	if status != 200 {
		t.Fatalf("native admin folder form:%d", status)
	}
	formTokenRE := regexp.MustCompile(`name="_form_token" value="([^"]+)"`)
	formMatch := formTokenRE.FindSubmatch(body)
	if len(formMatch) != 2 {
		t.Fatal("native folder form missing CSRF field")
	}
	postFolder := func(name, mappedPath, token string) (int, []byte) {
		var data bytes.Buffer
		form := multipart.NewWriter(&data)
		for key, value := range map[string]string{"name": name, "mapped_path": mappedPath, "fs_provider": "0", "_form_token": token} {
			if err := form.WriteField(key, value); err != nil {
				t.Fatal(err)
			}
		}
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		status, response, _ := fetch(admin, "POST", "/sftp-adm/web/admin/folder", &data, map[string]string{"Origin": publicURL, "Content-Type": form.FormDataContentType()})
		return status, response
	}
	status, _ = postFolder("Папка 1", "/fixture/data/shared", string(formMatch[1]))
	if status != 200 {
		t.Fatalf("native valid folder form:%d", status)
	}
	var createdFolder struct {
		Name       string `json:"name"`
		MappedPath string `json:"mapped_path"`
	}
	nativeAPI("GET", "/api/v2/folders/"+url.PathEscape("Папка 1"), nil, &createdFolder)
	if createdFolder.Name != "Папка 1" || createdFolder.MappedPath != "/fixture/data/shared" {
		t.Fatal("native folder form was not applied")
	}
	status, body, _ = fetch(admin, "GET", "/sftp-adm/web/admin/folder/"+url.PathEscape("Папка 1"), nil, nil)
	if status != 200 || !bytes.Contains(body, []byte(`value="Папка 1"`)) {
		t.Fatalf("native Unicode folder edit form:%d", status)
	}
	status, response := postFolder("forbidden-secrets", "/etc/sftpgo-files", string(formMatch[1]))
	if status != 403 || !bytes.Contains(response, []byte("sftp_storage_boundary")) {
		t.Fatalf("native unsafe folder was not rejected by gateway:%d", status)
	}
	request, _ := http.NewRequest("GET", nativeURL+"/api/v2/folders/forbidden-secrets", nil)
	request.Header.Set("Authorization", "Bearer "+accessToken)
	deniedFolder, err := direct.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	deniedFolder.Body.Close()
	if deniedFolder.StatusCode != 404 {
		t.Fatal("forbidden folder reached native datastore")
	}
	status, _ = postFolder("missing-csrf", "/fixture/data/missing-csrf", "")
	if status != 403 {
		t.Fatalf("native admin form lost CSRF check:%d", status)
	}
	status, body, _ = fetch(admin, "GET", "/sftp-adm/open/files", nil, nil)
	if status != 200 {
		t.Fatalf("native file login:%d %s", status, body[:min(len(body), 500)])
	}
	csrfRE := regexp.MustCompile(`'X-CSRF-TOKEN':\s*'([^']+)'`)
	csrfMatch := csrfRE.FindSubmatch(body)
	if len(csrfMatch) != 2 {
		t.Fatal("native files page has no native CSRF token")
	}
	csrf := string(csrfMatch[1])
	upload := []byte("synthetic native SFTP acceptance\n")
	headers := map[string]string{"Origin": publicURL, "Content-Type": "application/octet-stream", "X-CSRF-TOKEN": csrf}
	status, body, _ = fetch(admin, "POST", "/sftp-adm/web/client/file?path=/synthetic.txt", bytes.NewReader(upload), headers)
	if status != 201 {
		t.Fatalf("native file upload:%d %s", status, body)
	}

	status, body, _ = fetch(admin, "GET", "/sftp-adm/web/client/dirs?path=/", nil, nil)
	if status != 200 || !bytes.Contains(body, []byte("synthetic.txt")) {
		t.Fatalf("native directory listing:%d %s", status, body)
	}
	status, body, h := fetch(admin, "GET", "/sftp-adm/web/client/file?path=/synthetic.txt", nil, map[string]string{"X-CSRF-TOKEN": csrf})
	if status != 200 || string(body) != "synthetic native SFTP acceptance\n" || !strings.HasPrefix(h.Get("Content-Disposition"), "attachment") {
		t.Fatalf("native download:%d", status)
	}
	status, _, _ = fetch(admin, "POST", "/sftp-adm/web/client/dirs?path=/forbidden", nil, map[string]string{"Origin": publicURL})
	if status != 403 {
		t.Fatalf("missing native CSRF accepted:%d", status)
	}
	status, body, _ = fetch(admin, "GET", "/sftp-adm/web/admin/users/json", nil, nil)
	if status != 200 || !json.Valid(body) {
		t.Fatalf("native admin cookie jar lost after file mode:%d", status)
	}
	viewer := browser("viewer-person", false)
	status, _, _ = fetch(viewer, "GET", "/sftp-adm/web/admin/users", nil, nil)
	if status != 403 {
		t.Fatalf("viewer native administrator access:%d", status)
	}
	status, body, _ = fetch(viewer, "GET", "/sftp-adm/open/files", nil, nil)
	if status != 200 {
		t.Fatalf("viewer file login:%d", status)
	}
	status, body, _ = fetch(viewer, "GET", "/sftp-adm/web/client/dirs?path=/", nil, nil)
	if status != 200 || bytes.Contains(body, []byte("synthetic.txt")) {
		t.Fatalf("cross-user native files leaked:%d", status)
	}
	delete(sessions, hash("native-fixture-admin-person"))
	status, _, _ = fetch(admin, "GET", "/sftp-adm/web/client/dirs?path=/", nil, nil)
	if status != 401 {
		t.Fatalf("revoked Portal session retained native access:%d", status)
	}
	t.Log("native v2.7.6: OIDC per-user admin and client, users listing, valid multipart Unicode folder creation/readback/edit form, forbidden path rejected before upstream, native CSRF, synthetic upload/list/download, cross-user isolation and live session revocation PASS")
}
