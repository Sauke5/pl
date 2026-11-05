package sftpgo

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"
)

type deleteCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func readDeleteCredential(filename string) (deleteCredential, error) {
	var credential deleteCredential
	f, e := os.Open(filename)
	if e != nil {
		return credential, &Error{Code: "credential_unavailable"}
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() > 4096 || info.Mode().Perm()&0077 != 0 {
		return credential, &Error{Code: "credential_unavailable"}
	}
	decoder := json.NewDecoder(io.LimitReader(f, 4097))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&credential); e != nil {
		return deleteCredential{}, &Error{Code: "credential_unavailable"}
	}
	var extra any
	if e = decoder.Decode(&extra); !errors.Is(e, io.EOF) || credential.Username != "portal-deleter" || len(credential.Password) < 40 || len(credential.Password) > 72 || strings.ContainsFunc(credential.Password, unicode.IsControl) {
		return deleteCredential{}, &Error{Code: "credential_unavailable"}
	}
	return credential, nil
}

// Token login is read-only and restricted to the fixed native endpoint. The password
// and resulting token remain in process memory; no provider response text is returned.
func (c *Client) deleteToken(ctx context.Context) (string, error) {
	credential, e := readDeleteCredential(c.deleteCredentialFile)
	if e != nil {
		return "", e
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", c.base+"/api/v2/user/token", nil)
	if e != nil {
		return "", &Error{Code: "provider_unavailable"}
	}
	req.SetBasicAuth(credential.Username, credential.Password)
	client := *c.http
	client.Timeout = 10 * time.Second
	response, e := client.Do(req)
	if e != nil {
		return "", &Error{Code: "provider_unavailable"}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		code := "provider_error"
		if response.StatusCode == 401 || response.StatusCode == 403 {
			code = "provider_auth_denied"
		}
		return "", &Error{Code: code}
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, 16385))
	if e != nil || len(data) > 16384 {
		return "", &Error{Code: "provider_invalid_response"}
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if json.Unmarshal(data, &token) != nil || len(token.AccessToken) < 32 || len(token.AccessToken) > 8192 || strings.ContainsAny(token.AccessToken, " \t\r\n\x00") {
		return "", &Error{Code: "provider_invalid_response"}
	}
	return token.AccessToken, nil
}
