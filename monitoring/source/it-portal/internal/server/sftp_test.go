package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"pl/portal/internal/model"
	"pl/portal/internal/sftpgo"
	"strings"
	"testing"
	"time"
)

func sftpZipFixture(t *testing.T, name string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	f, e := w.Create(name)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte("synthetic DBF fixture, no production data")); e != nil {
		t.Fatal(e)
	}
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestSFTPZipSafety(t *testing.T) {
	for _, name := range []string{"../test.dbf", "/test.dbf", "a/../../test.dbf", "a\\test.dbf", "C:/test.dbf", "a/./test.dbf"} {
		if e := validateSFTPZip(sftpZipFixture(t, name)); e == nil {
			t.Errorf("accepted unsafe name %q", name)
		}
	}
	if e := validateSFTPZip([]byte("not a ZIP")); e == nil {
		t.Fatal("accepted invalid archive")
	}
	if !safeSFTPName(strings.Repeat("a", 251)+".zip") || safeSFTPName(strings.Repeat("a", 252)+".zip") || safeSFTPName(string([]byte{0xff})+".zip") {
		t.Fatal("filename byte/UTF-8 boundary not enforced")
	}
	good := sftpZipFixture(t, "base/test.dbf")
	if e := validateSFTPZip(good); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"../base.zip", "a\\base.zip", "a:base.zip", "a\n.zip", "."} {
		if safeSFTPName(name) {
			t.Errorf("unsafe filename %q", name)
		}
	}
	// A valid ZIP header with corrupted compressed data must fail CRC/deflate validation.
	z, e := zip.NewReader(bytes.NewReader(good), int64(len(good)))
	if e != nil {
		t.Fatal(e)
	}
	offset, e := z.File[0].DataOffset()
	if e != nil {
		t.Fatal(e)
	}
	good[offset] ^= 255
	if e := validateSFTPZip(good); e == nil {
		t.Fatal("accepted corrupted ZIP")
	}
}
func TestSFTPBrowserOnlyAndDisabledUpload(t *testing.T) {
	s := &Server{}
	m := http.NewServeMux()
	s.registerSFTPRoutes(m)
	for _, tc := range []struct {
		method, path, authorization string
		want                        int
	}{{"GET", "/api/v1/sftp-server", "", 401}, {"GET", "/api/v1/sftp-server", "Bearer machine", 401}, {"POST", "/api/v1/sftp-server/test-upload", "", 404}} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		if tc.authorization != "" {
			r.Header.Set("Authorization", tc.authorization)
		}
		w := httptest.NewRecorder()
		m.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s %s: got %d want %d", tc.method, tc.path, w.Code, tc.want)
		}
	}
}
func TestSFTPConnectedModeRejectsDemoUpload(t *testing.T) {
	s := &Server{Config: Config{Demo: true, SFTP: &sftpgo.Client{}}}
	m := http.NewServeMux()
	s.registerSFTPRoutes(m)
	r := httptest.NewRequest("POST", "/api/v1/sftp-server/test-upload", nil)
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("testpayloadrouteavailablewhileconnected: %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.sftpTestUpload(w, r)
	if w.Code != 404 {
		t.Fatalf("testpayloadhandleravailablewhileconnected: %d", w.Code)
	}
}

func TestSFTPAuthenticatedCandidate(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	s := &Server{Store: st, Config: Config{Demo: true, PublicURL: "http://localhost"}}
	for _, role := range []string{"admin", "viewer"} {
		_, e := st.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,$2,$2,$3,'test-csrf',$4)", hash(role), role, role == "admin", time.Now().Add(time.Hour))
		if e != nil {
			t.Fatal(e)
		}
	}
	m := http.NewServeMux()
	s.registerSFTPRoutes(m)
	request := func(method, url, role string, body io.Reader, contentType, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, body)
		r.AddCookie(&http.Cookie{Name: "portal_session", Value: role})
		r.Header.Set("X-CSRF-Token", csrf)
		if contentType != "" {
			r.Header.Set("Content-Type", contentType)
		}
		w := httptest.NewRecorder()
		m.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/api/v1/sftp-server", "viewer", nil, "", ""); w.Code != 200 {
		t.Fatalf("viewer read: %d %s", w.Code, w.Body)
	}
	var count int
	if e := st.Pool.QueryRow(ctx, "SELECT count(*) FROM sftp_access_audit").Scan(&count); e != nil || count != 0 {
		t.Fatalf("GET mutated audit: %d %v", count, e)
	}
	if w := request("POST", "/api/v1/sftp-server/access", "viewer", nil, "", ""); w.Code != 403 {
		t.Fatalf("missing csrf: %d", w.Code)
	}
	if w := request("POST", "/api/v1/sftp-server/access", "viewer", nil, "", "test-csrf"); w.Code != 204 {
		t.Fatalf("access audit: %d", w.Code)
	}
	collection := `{"branch":"Тест","label":"DBF","folder":"test","quota_bytes":10485760,"reader_ids":["viewer"]}`
	if w := request("POST", "/api/v1/sftp-server/collections", "viewer", strings.NewReader(collection), "application/json", "test-csrf"); w.Code != 403 {
		t.Fatalf("viewer write: %d", w.Code)
	}
	w := request("POST", "/api/v1/sftp-server/collections", "admin", strings.NewReader(collection), "application/json", "test-csrf")
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var c model.SFTPCollection
	if e := json.Unmarshal(w.Body.Bytes(), &c); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []struct {
		name string
		data []byte
	}{{"../escape.zip", sftpZipFixture(t, "test.dbf")}, {"broken.zip", []byte("broken")}, {"unsafe.zip", sftpZipFixture(t, "../escape.dbf")}} {
		var badBody bytes.Buffer
		writer := multipart.NewWriter(&badBody)
		writer.WriteField("collection_id", c.ID)
		file, _ := writer.CreateFormFile("file", bad.name)
		file.Write(bad.data)
		writer.Close()
		badResponse := request("POST", "/api/v1/sftp-server/test-upload", "admin", &badBody, writer.FormDataContentType(), "test-csrf")
		if badResponse.Code != 400 {
			t.Fatalf("unsafe upload %q accepted: %d %s", bad.name, badResponse.Code, badResponse.Body)
		}
	}
	var b bytes.Buffer
	mp := multipart.NewWriter(&b)
	if e := mp.WriteField("collection_id", c.ID); e != nil {
		t.Fatal(e)
	}
	f, e := mp.CreateFormFile("file", "test.zip")
	if e != nil {
		t.Fatal(e)
	}
	f.Write(sftpZipFixture(t, "test.dbf"))
	mp.Close()
	payload := append([]byte(nil), b.Bytes()...)
	w = request("POST", "/api/v1/sftp-server/test-upload", "admin", bytes.NewReader(payload), mp.FormDataContentType(), "test-csrf")
	if w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body)
	}
	var result struct {
		Version   model.SFTPVersion `json:"version"`
		Duplicate bool              `json:"duplicate"`
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	if result.Version.ID == "" || result.Duplicate {
		t.Fatal("missing version")
	}
	if w = request("POST", "/api/v1/sftp-server/test-upload", "admin", bytes.NewReader(payload), mp.FormDataContentType(), "test-csrf"); w.Code != 200 || !strings.Contains(w.Body.String(), `"duplicate":true`) {
		t.Fatalf("duplicate: %d %s", w.Code, w.Body)
	}
	if denied := request("GET", "/api/v1/sftp-server/versions/"+result.Version.ID+"/download", "admin", nil, "", ""); denied.Code != 403 {
		t.Fatalf("admin bypassed reader grants: %d", denied.Code)
	}
	if w = request("GET", "/api/v1/sftp-server/versions/"+result.Version.ID+"/download", "viewer", nil, "", ""); w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("download: %d", w.Code)
	}
	if w = request("POST", "/api/v1/sftp-server/versions/"+result.Version.ID+"/seen", "viewer", nil, "", "test-csrf"); w.Code != 204 {
		t.Fatalf("seen: %d", w.Code)
	}
	viewer, e := st.SFTPState(ctx, "viewer", false)
	if e != nil || len(viewer.Versions) != 1 || viewer.Versions[0].IsNew {
		t.Fatalf("viewer marker: %+v %v", viewer, e)
	}
	admin, e := st.SFTPState(ctx, "admin", true)
	if e != nil || len(admin.Versions) != 1 || !admin.Versions[0].IsNew {
		t.Fatalf("marker leaked to admin: %+v %v", admin, e)
	}
	if _, e := st.Pool.Exec(ctx, "UPDATE sftp_versions SET filename='changed' WHERE id=$1", result.Version.ID); e == nil {
		t.Fatal("immutable version updated")
	}
}
