// Package sftpgo is a narrow adapter for SFTPGo v2.7.6 native REST APIs.
// Its URL and credentials are deployment configuration, never request input.
package sftpgo

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"
)

const MaxFileBytes int64 = 512 << 20

var ErrNotFound = errors.New("sftpgo_not_found")
var ErrConflict = errors.New("sftpgo_ownership_conflict")

type Error struct {
	Code      string
	Uncertain bool
}

func (e *Error) Error() string { return e.Code }
func ErrorCode(e error) string {
	var typed *Error
	if errors.As(e, &typed) {
		return typed.Code
	}
	if errors.Is(e, ErrConflict) {
		return "ownership_conflict"
	}
	if errors.Is(e, ErrNotFound) {
		return "not_found"
	}
	return "provider_unavailable"
}

type Config struct{ URL, CAFile, AdminKeyFile, ReaderKeyFile, DeleteKeyFile, DeleteCredentialFile, DataRoot string }
type Client struct {
	base                              string
	adminKey, readerKey, deleteKey    string
	deleteCredentialFile, bearerToken string
	Root                              string
	http                              *http.Client
}

func New(c Config) (*Client, error) {
	u, e := url.Parse(c.URL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return nil, errors.New("invalid SFTPGo HTTPS API URL")
	}
	if c.AdminKeyFile == "" || c.ReaderKeyFile == "" || c.DataRoot == "" || !path.IsAbs(c.DataRoot) || path.Clean(c.DataRoot) != c.DataRoot || c.DataRoot == "/" {
		return nil, errors.New("invalid SFTPGo credentials or data root")
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if c.CAFile != "" {
		pem, e := os.ReadFile(c.CAFile)
		if e != nil || !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid SFTPGo CA file")
		}
	}
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 15 * time.Second, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 6}
	client := &Client{base: strings.TrimRight(c.URL, "/"), adminKey: c.AdminKeyFile, readerKey: c.ReaderKeyFile, deleteKey: c.DeleteKeyFile, deleteCredentialFile: c.DeleteCredentialFile, Root: c.DataRoot, http: &http.Client{Transport: tr, Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	for _, p := range []string{c.AdminKeyFile, c.ReaderKeyFile} {
		if _, e := readKey(p); e != nil {
			return nil, e
		}
	}
	if c.DeleteKeyFile != "" {
		if _, e := readKey(c.DeleteKeyFile); e != nil {
			return nil, e
		}
	}
	if c.DeleteCredentialFile != "" {
		if c.DeleteKeyFile != "" {
			return nil, errors.New("ambiguous SFTPGo deletion credentials")
		}
		if _, e := readDeleteCredential(c.DeleteCredentialFile); e != nil {
			return nil, e
		}
	}
	return client, nil
}
func readKey(filename string) (string, error) {
	f, e := os.Open(filename)
	if e != nil {
		return "", errors.New("SFTPGo credential unavailable")
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 4097))
	key := strings.TrimSpace(string(b))
	if e != nil || len(key) < 32 || len(b) > 4096 || strings.ContainsAny(key, "\r\n\x00") {
		return "", errors.New("invalid SFTPGo credential file")
	}
	return key, nil
}
func (c *Client) request(ctx context.Context, method, endpoint string, query url.Values, body any, reader bool) (*http.Response, error) {
	var payload io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		payload = bytes.NewReader(b)
	}
	target := c.base + "/api/v2" + endpoint
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, e := http.NewRequestWithContext(ctx, method, target, payload)
	if e != nil {
		return nil, e
	}
	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	} else {
		keyFile := c.adminKey
		if reader {
			keyFile = c.readerKey
		}
		key, e := readKey(keyFile)
		if e != nil {
			return nil, &Error{Code: "credential_unavailable"}
		}
		req.Header.Set("X-SFTPGO-API-KEY", key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, e := c.http.Do(req)
	if e != nil {
		return nil, &Error{Code: "provider_unavailable", Uncertain: method != "GET"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode == 404 {
			return nil, ErrNotFound
		}
		code := "provider_error"
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			code = "provider_auth_denied"
		}
		return nil, &Error{Code: code, Uncertain: method != "GET" && resp.StatusCode >= 500}
	}
	return resp, nil
}
func (c *Client) json(ctx context.Context, method, endpoint string, query url.Values, input, output any) error {
	resp, e := c.request(ctx, method, endpoint, query, input, false)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if output == nil {
		_, e = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<20))
		return e
	}
	d := json.NewDecoder(io.LimitReader(resp.Body, 4<<20))
	if e = d.Decode(output); e != nil {
		return &Error{Code: "provider_invalid_response", Uncertain: method != "GET"}
	}
	return nil
}

type Folder struct {
	Name        string         `json:"name"`
	MappedPath  string         `json:"mapped_path"`
	Description string         `json:"description"`
	Filesystem  map[string]any `json:"filesystem"`
}
type VirtualFolder struct {
	Folder
	VirtualPath string `json:"virtual_path"`
	QuotaSize   int64  `json:"quota_size"`
	QuotaFiles  int    `json:"quota_files"`
}
type Pattern struct {
	DenyPolicy int      `json:"deny_policy,omitempty"`
	Path       string   `json:"path"`
	Allowed    []string `json:"allowed_patterns,omitempty"`
	Denied     []string `json:"denied_patterns,omitempty"`
}
type Filters struct {
	DeniedLoginMethods []string  `json:"denied_login_methods"`
	DeniedProtocols    []string  `json:"denied_protocols"`
	AllowAPIKey        bool      `json:"allow_api_key_auth"`
	MaxUploadFileSize  int64     `json:"max_upload_file_size"`
	FilePatterns       []Pattern `json:"file_patterns"`
	WebClient          []string  `json:"web_client"`
}
type User struct {
	Groups         []json.RawMessage   `json:"groups"`
	Role           string              `json:"role"`
	Username       string              `json:"username"`
	Status         int                 `json:"status"`
	PublicKeys     []string            `json:"public_keys"`
	Password       string              `json:"password"`
	HasPassword    bool                `json:"has_password,omitempty"`
	HomeDir        string              `json:"home_dir"`
	AdditionalInfo string              `json:"additional_info"`
	QuotaSize      int64               `json:"quota_size"`
	QuotaFiles     int                 `json:"quota_files"`
	MaxSessions    int                 `json:"max_sessions"`
	Permissions    map[string][]string `json:"permissions"`
	VirtualFolders []VirtualFolder     `json:"virtual_folders"`
	Filters        Filters             `json:"filters"`
	Filesystem     map[string]any      `json:"filesystem"`
}

func ManagedMarker(id string) string { return "pl:sftp:" + id }
func (c *Client) Folder(id string) Folder {
	return Folder{Name: "pl-" + id, MappedPath: path.Join(c.Root, "collections", id), Description: ManagedMarker(id), Filesystem: map[string]any{"provider": float64(0)}}
}

// EnsureFolder never adopts or rewrites an unmanaged provider object.
func (c *Client) EnsureFolder(ctx context.Context, want Folder) error {
	var got Folder
	e := c.json(ctx, "GET", "/folders/"+url.PathEscape(want.Name), nil, nil, &got)
	if e == nil {
		if got.MappedPath != want.MappedPath || got.Description != want.Description || !localFilesystem(got.Filesystem) {
			return ErrConflict
		}
		return nil
	}
	if !errors.Is(e, ErrNotFound) {
		return e
	}
	writeErr := c.json(ctx, "POST", "/folders", nil, want, nil)
	// Read-back is mandatory even on uncertain create. Never blindly retry a write.
	if e = c.json(ctx, "GET", "/folders/"+url.PathEscape(want.Name), nil, nil, &got); e != nil {
		if writeErr != nil {
			return writeErr
		}
		return e
	}
	if got.MappedPath != want.MappedPath || got.Description != want.Description || !localFilesystem(got.Filesystem) {
		return ErrConflict
	}
	return nil
}
func sameStrings(a, b []string) bool {
	a = slices.Clone(a)
	b = slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
func managedUserEqual(got, want User) bool {
	return localFilesystem(got.Filesystem) && len(got.Groups) == 0 && got.Role == want.Role && got.Username == want.Username && got.Status == want.Status && got.HomeDir == want.HomeDir && got.AdditionalInfo == want.AdditionalInfo && got.QuotaSize == want.QuotaSize && got.QuotaFiles == want.QuotaFiles && got.MaxSessions == want.MaxSessions && !got.HasPassword && sameStrings(got.PublicKeys, want.PublicKeys) && reflect.DeepEqual(got.Permissions, want.Permissions) && filtersEqual(got.Filters, want.Filters) && foldersEqual(got.VirtualFolders, want.VirtualFolders)
}
func filtersEqual(a, b Filters) bool {
	if !sameStrings(a.DeniedLoginMethods, b.DeniedLoginMethods) || !sameStrings(a.DeniedProtocols, b.DeniedProtocols) || a.AllowAPIKey != b.AllowAPIKey || a.MaxUploadFileSize != b.MaxUploadFileSize || !sameStrings(a.WebClient, b.WebClient) || len(a.FilePatterns) != len(b.FilePatterns) {
		return false
	}
	for _, want := range b.FilePatterns {
		found := false
		for _, got := range a.FilePatterns {
			if got.Path == want.Path && got.DenyPolicy == want.DenyPolicy && sameStrings(got.Allowed, want.Allowed) && sameStrings(got.Denied, want.Denied) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func foldersEqual(a, b []VirtualFolder) bool {
	if len(a) != len(b) {
		return false
	}
	for _, want := range b {
		found := false
		for _, got := range a {
			if got.Name == want.Name && got.MappedPath == want.MappedPath && got.VirtualPath == want.VirtualPath && got.QuotaSize == want.QuotaSize && got.QuotaFiles == want.QuotaFiles {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func (c *Client) EnsureUser(ctx context.Context, want User) error {
	endpoint := "/users/" + url.PathEscape(want.Username)
	var got User
	e := c.json(ctx, "GET", endpoint, nil, nil, &got)
	method := "PUT"
	target := endpoint
	query := url.Values{"disconnect": {"1"}}
	if errors.Is(e, ErrNotFound) {
		method = "POST"
		target = "/users"
		query = nil
	} else if e != nil {
		return e
	} else {
		if got.AdditionalInfo != want.AdditionalInfo || got.HomeDir != want.HomeDir || got.Role != want.Role {
			return ErrConflict
		}
		if managedUserEqual(got, want) {
			return nil
		}
	}
	writeErr := c.json(ctx, method, target, query, want, nil)
	got = User{} // JSON decoding into a reused map retains revoked path keys.
	if e = c.json(ctx, "GET", endpoint, nil, nil, &got); e != nil {
		if writeErr != nil {
			return writeErr
		}
		return e
	}
	if got.AdditionalInfo != want.AdditionalInfo || got.HomeDir != want.HomeDir || got.Role != want.Role {
		return ErrConflict
	}
	if !managedUserEqual(got, want) {
		if writeErr != nil {
			return writeErr
		}
		return &Error{Code: "provider_readback_mismatch"}
	}
	return nil
}

type Event struct {
	ID          string `json:"id"`
	Timestamp   int64  `json:"timestamp"`
	Action      string `json:"action"`
	Username    string `json:"username"`
	FSPath      string `json:"fs_path"`
	VirtualPath string `json:"virtual_path"`
	FileSize    int64  `json:"file_size"`
	Status      int    `json:"status"`
	Protocol    string `json:"protocol"`
	FSProvider  int    `json:"fs_provider"`
	InstanceID  string `json:"instance_id"`
}

func (c *Client) Events(ctx context.Context, start, end int64, from string) ([]Event, error) {
	q := url.Values{"start_timestamp": {strconv.FormatInt(start, 10)}, "end_timestamp": {strconv.FormatInt(end, 10)}, "order": {"ASC"}, "actions": {"upload"}, "statuses": {"1"}, "protocols": {"SFTP"}, "limit": {"500"}}
	if from != "" {
		q.Set("from_id", from)
	}
	events := []Event{}
	e := c.json(ctx, "GET", "/events/fs", q, nil, &events)
	return events, e
}
func (c *Client) OpenFile(ctx context.Context, relativePath string) (io.ReadCloser, int64, error) {
	if !strings.HasPrefix(relativePath, "/collections/") || path.Clean(relativePath) != relativePath || strings.ContainsAny(relativePath, "\\\x00") {
		return nil, 0, &Error{Code: "invalid_file_path"}
	}
	resp, e := c.request(ctx, "GET", "/user/files", url.Values{"path": {relativePath}}, nil, true)
	if e != nil {
		return nil, 0, e
	}
	if resp.StatusCode != 200 || resp.ContentLength > MaxFileBytes || resp.ContentLength == 0 {
		resp.Body.Close()
		return nil, 0, &Error{Code: "invalid_file_size"}
	}
	return resp.Body, resp.ContentLength, nil
}

type DirEntry struct {
	Name         string    `json:"name"`
	Size         int64     `json:"size"`
	Mode         uint32    `json:"mode"`
	LastModified time.Time `json:"last_modified"`
}

func (c *Client) List(ctx context.Context, relativePath string) ([]DirEntry, error) {
	if !strings.HasPrefix(relativePath, "/collections/") || path.Clean(relativePath) != relativePath {
		return nil, &Error{Code: "invalid_file_path"}
	}
	resp, e := c.request(ctx, "GET", "/user/dirs", url.Values{"path": {relativePath}}, nil, true)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	var out []DirEntry
	e = json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&out)
	if e != nil {
		return nil, &Error{Code: "provider_invalid_response"}
	}
	return out, nil
}

func (c *Client) Check(ctx context.Context) error {
	if e := c.json(ctx, "GET", "/status", nil, nil, nil); e != nil {
		return e
	}
	response, e := c.request(ctx, "GET", "/user/dirs", url.Values{"path": {"/"}}, nil, true)
	if e != nil {
		return e
	}
	defer response.Body.Close()
	_, e = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<20))
	return e
}

func localFilesystem(configuration map[string]any) bool {
	provider, ok := configuration["provider"].(float64)
	if !ok || provider != 0 {
		return false
	}
	for name, value := range configuration {
		if name != "provider" && !emptyJSON(value) {
			return false
		}
	}
	return true
}
func emptyJSON(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case bool:
		return !v
	case string:
		return v == ""
	case float64:
		return v == 0
	case map[string]any:
		for _, item := range v {
			if !emptyJSON(item) {
				return false
			}
		}
		return true
	case []any:
		for _, item := range v {
			if !emptyJSON(item) {
				return false
			}
		}
		return true
	}
	return false
}
