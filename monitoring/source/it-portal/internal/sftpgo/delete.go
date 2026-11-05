package sftpgo

import (
	"context"
	"github.com/google/uuid"
	"io"
	"net/url"
	"path"
	"strings"
)

func validDeletePath(p string) bool {
	parts := strings.Split(p, "/")
	if len(parts) != 4 || parts[0] != "" || parts[1] != "collections" || parts[3] == "" || parts[3] == "." || parts[3] == ".." || path.Clean(p) != p || strings.ContainsAny(p, "\\\x00\r\n") {
		return false
	}
	id, e := uuid.Parse(parts[2])
	return e == nil && id.String() == parts[2]
}
func (c *Client) DeleteEnabled() bool {
	return c != nil && (c.deleteKey != "" || c.deleteCredentialFile != "")
}

// Native user-scope API. A separate delete-only identity is mandatory; no reader fallback.
// An uncertain response is returned to the caller for read-only reconciliation, never retried here.
func (c *Client) DeleteFile(ctx context.Context, p string) error {
	if !validDeletePath(p) {
		return &Error{Code: "invalid_file_path"}
	}
	if !c.DeleteEnabled() {
		return &Error{Code: "delete_not_configured"}
	}
	// Mapping updates may change the native password hash/token signature. Keep
	// token acquisition and its single DELETE mutually exclusive with those PUTs.
	select {
	case deleteFolderSlot <- struct{}{}:
		defer func() { <-deleteFolderSlot }()
	case <-ctx.Done():
		return &Error{Code: "provider_unavailable"}
	}

	scoped := *c
	if c.deleteCredentialFile != "" {
		token, e := c.deleteToken(ctx)
		if e != nil {
			return e
		}
		scoped.bearerToken = token
	} else {
		scoped.readerKey = c.deleteKey
	}
	resp, e := scoped.request(ctx, "DELETE", "/user/files", url.Values{"path": {p}}, nil, true)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return &Error{Code: "provider_invalid_response", Uncertain: true}
	}
	if _, e = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)); e != nil {
		return &Error{Code: "provider_unavailable", Uncertain: true}
	}
	return nil
}
