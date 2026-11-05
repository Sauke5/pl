package sftpgo

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
)

var deleteFolderSlot = make(chan struct{}, 1)

func (c *Client) deleteUserOwned(u User) bool {
	if u.Username != "portal-deleter" || u.Status != 1 || u.Role != "portal-sftp" || u.HomeDir != c.Root || u.AdditionalInfo != ManagedMarker("portal-deleter") || len(u.PublicKeys) != 0 || len(u.Groups) != 0 || !localFilesystem(u.Filesystem) {
		return false
	}
	denied := map[string]bool{}
	for _, p := range u.Filters.DeniedProtocols {
		denied[p] = true
	}
	if !denied["SSH"] || !denied["FTP"] || !denied["DAV"] {
		return false
	}
	if len(u.Permissions) == 0 {
		return false
	}
	for p, permissions := range u.Permissions {
		if p != "/" && p != "/collections" && !validDeletePath(p+"/probe.zip") {
			return false
		}
		for _, permission := range permissions {
			if permission != "list" && (permission != "delete_files" || p == "/") {
				return false
			}
		}
	}
	return true
}
func validDeleteBinding(u User, want Folder, virtual string) (bool, error) {
	for _, folder := range u.VirtualFolders {
		if folder.VirtualPath != virtual {
			continue
		}
		if folder.Name != want.Name || folder.MappedPath != want.MappedPath || folder.Description != want.Description || folder.QuotaSize != 0 || folder.QuotaFiles != 0 || !localFilesystem(folder.Filesystem) {
			return false, ErrConflict
		}
		return true, nil
	}
	return false, nil
}

// EnsureDeleteFolder attaches only the explicitly requested managed collection.
// Preserving the full native profile avoids revoking mappings from other environments.
// Its native VF identity makes DELETE update the shared folder quota, not home quota.
func (c *Client) EnsureDeleteFolder(ctx context.Context, collection string) error {
	if !validDeletePath("/collections/" + collection + "/probe.zip") {
		return &Error{Code: "invalid_file_path"}
	}
	select {
	case deleteFolderSlot <- struct{}{}:
		defer func() { <-deleteFolderSlot }()
	case <-ctx.Done():
		return &Error{Code: "provider_unavailable"}
	}
	want := c.Folder(collection)
	var folder Folder
	if e := c.json(ctx, "GET", "/folders/"+url.PathEscape(want.Name), nil, nil, &folder); e != nil {
		return e
	}
	if folder.Name != want.Name || folder.MappedPath != want.MappedPath || folder.Description != want.Description || !localFilesystem(folder.Filesystem) {
		return ErrConflict
	}
	endpoint := "/users/portal-deleter"
	raw := map[string]any{}
	if e := c.json(ctx, "GET", endpoint, nil, nil, &raw); e != nil {
		return e
	}
	decode := func(value any) (User, error) {
		b, e := json.Marshal(value)
		var u User
		if e == nil {
			e = json.Unmarshal(b, &u)
		}
		return u, e
	}
	user, e := decode(raw)
	if e != nil || !c.deleteUserOwned(user) {
		return ErrConflict
	}
	virtual := "/collections/" + collection
	bound, e := validDeleteBinding(user, want, virtual)
	if e != nil || bound {
		return e
	}
	// Without a local password, require an already-bound folder; never guess whether
	// omitting the native password in PUT preserves a deployed authentication scheme.
	if c.deleteCredentialFile == "" {
		return &Error{Code: "delete_folder_unbound"}
	}
	credential, e := readDeleteCredential(c.deleteCredentialFile)
	if e != nil {
		return e
	}
	bindings, ok := raw["virtual_folders"].([]any)
	if !ok && raw["virtual_folders"] != nil {
		return &Error{Code: "provider_invalid_response"}
	}
	for _, entry := range bindings {
		m, ok := entry.(map[string]any)
		if !ok {
			return &Error{Code: "provider_invalid_response"}
		}
		if p, ok := m["virtual_path"].(string); ok && strings.TrimRight(p, "/") == virtual {
			return ErrConflict
		}
	}
	raw["virtual_folders"] = append(bindings, map[string]any{"name": want.Name, "virtual_path": virtual, "quota_size": 0, "quota_files": 0})
	raw["password"] = credential.Password
	writeErr := c.json(ctx, "PUT", endpoint, url.Values{"disconnect": {"1"}}, raw, nil)
	var got User
	if e = c.json(ctx, "GET", endpoint, nil, nil, &got); e != nil {
		if writeErr != nil {
			return writeErr
		}
		return e
	}
	if !c.deleteUserOwned(got) {
		return ErrConflict
	}
	bound, e = validDeleteBinding(got, want, virtual)
	if e != nil {
		return e
	}
	if bound {
		return nil
	}
	if writeErr != nil {
		return writeErr
	}
	return &Error{Code: "provider_readback_mismatch"}
}
