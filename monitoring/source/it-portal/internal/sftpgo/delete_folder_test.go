package sftpgo

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeleteFolderOwnershipQuotaBindingAndPreservation(t *testing.T) {
	for _, mode := range []string{"bind", "bound", "key-unbound", "foreign-user", "foreign-folder", "uncertain-applied"} {
		t.Run(mode, func(t *testing.T) {
			id := "12345678-1234-1234-1234-123456789abc"
			root := "/srv/sftpgo/data"
			password := strings.Repeat("p", 64)
			writes := 0
			folder := Folder{Name: "pl-" + id, MappedPath: root + "/collections/" + id, Description: ManagedMarker(id), Filesystem: map[string]any{"provider": float64(0)}}
			user := User{Username: "portal-deleter", Status: 1, Role: "portal-sftp", HomeDir: root, AdditionalInfo: ManagedMarker("portal-deleter"), Permissions: map[string][]string{"/": {"list"}, "/collections": {"list", "delete_files"}}, Filters: Filters{DeniedProtocols: []string{"SSH", "FTP", "DAV"}}, Filesystem: map[string]any{"provider": float64(0)}}
			if mode == "foreign-user" {
				user.AdditionalInfo = "unmanaged"
			}
			if mode == "bind" || mode == "uncertain-applied" {
				user.VirtualFolders = []VirtualFolder{{Folder: Folder{Name: "other-qa-mapping", MappedPath: root + "/collections/other", Description: "preserved", Filesystem: map[string]any{"provider": float64(0)}}, VirtualPath: "/collections/other"}}
			}

			if mode == "bound" {
				user.VirtualFolders = []VirtualFolder{{Folder: folder, VirtualPath: "/collections/" + id}}
			}
			raw := map[string]any{}
			b, _ := json.Marshal(user)
			json.Unmarshal(b, &raw)
			raw["custom_preserved"] = map[string]any{"value": "do not drop"}
			c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/api/v2/folders/") {
					f := folder
					if mode == "foreign-folder" {
						f.Description = "unmanaged"
					}
					json.NewEncoder(w).Encode(f)
					return
				}
				if r.URL.Path != "/api/v2/users/portal-deleter" {
					t.Error("unexpected path")
				}
				if r.Method == "PUT" {
					writes++
					if r.URL.Query().Get("disconnect") != "1" {
						t.Error("sessions not disconnected")
					}
					incoming := map[string]any{}
					json.NewDecoder(r.Body).Decode(&incoming)
					if incoming["password"] != password {
						t.Error("missing password preservation")
					}
					if incoming["custom_preserved"] == nil {
						t.Error("unknown native fields lost")
					}
					bindings := incoming["virtual_folders"].([]any)
					last := bindings[len(bindings)-1].(map[string]any)
					if len(bindings) != 2 || bindings[0].(map[string]any)["name"] != "other-qa-mapping" {
						t.Error("existing folder mappings lost")
					}

					if last["virtual_path"] != "/collections/"+id || last["quota_size"] != float64(0) || last["quota_files"] != float64(0) {
						t.Error("incorrect shared folder quota binding")
					}
					last["mapped_path"] = folder.MappedPath
					last["description"] = folder.Description
					last["filesystem"] = folder.Filesystem
					incoming["password"] = ""
					raw = incoming
					if mode == "uncertain-applied" {
						w.WriteHeader(500)
					} else {
						w.Write([]byte(`{}`))
					}
					return
				}
				json.NewEncoder(w).Encode(raw)
			})
			if mode != "key-unbound" && mode != "bound" {
				c.deleteCredentialFile = filepath.Join(t.TempDir(), "credential")
				os.WriteFile(c.deleteCredentialFile, []byte(`{"username":"portal-deleter","password":"`+password+`"}`), 0600)
			}
			e := c.EnsureDeleteFolder(context.Background(), id)
			if mode == "foreign-user" || mode == "foreign-folder" || mode == "key-unbound" {
				if e == nil || writes != 0 {
					t.Fatal("unsafe ownership/profile mutation", e, writes)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			want := 1
			if mode == "bound" {
				want = 0
			}
			if writes != want {
				t.Fatalf("writes%d want%d", writes, want)
			}
			if e = c.EnsureDeleteFolder(context.Background(), id); e != nil || writes != want {
				t.Fatal("bound readback not idempotent", e, writes)
			}
		})
	}
}
