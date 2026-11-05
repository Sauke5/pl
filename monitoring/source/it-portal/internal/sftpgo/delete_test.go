package sftpgo

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeleteFileSeparateCredentialAndExactNativePath(t *testing.T) {
	calls := 0
	p := "/collections/" + uuid.NewString() + "/archive ü.zip"
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "DELETE" || r.URL.Path != "/api/v2/user/files" || r.URL.Query().Get("path") != p || len(r.URL.Query()) != 1 {
			t.Error("unexpected delete target")
		}
		if r.Header.Get("X-SFTPGO-API-KEY") != strings.Repeat("d", 64) {
			t.Error("delete did not use separate credential")
		}
		w.Write([]byte(`{"message":"ok"}`))
	})
	c.deleteKey = filepath.Join(t.TempDir(), "delete-key")
	os.WriteFile(c.deleteKey, []byte(strings.Repeat("d", 64)), 0600)
	if err := c.DeleteFile(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"/", "/collections/../bad.zip", "/collections/" + uuid.NewString() + "/../bad.zip", p + "/nested", strings.ReplaceAll(p, "/collections/", "/accounts/")} {
		if c.DeleteFile(context.Background(), bad) == nil {
			t.Error("unsafe target accepted")
		}
	}
	c.deleteKey = ""
	if c.DeleteFile(context.Background(), p) == nil {
		t.Fatal("reader fallback allowed")
	}
	if calls != 1 {
		t.Fatalf("unexpected writes %d", calls)
	}
}
func TestDeleteFileUncertainResponseNeverRetries(t *testing.T) {
	for _, status := range []int{401, 403, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(status) })
			c.deleteKey = c.readerKey
			err := c.DeleteFile(context.Background(), "/collections/"+uuid.NewString()+"/file.zip")
			var e *Error
			if !errors.As(err, &e) || e.Uncertain != (status == 500) || calls != 1 {
				t.Fatalf("incorrect uncertain handling: %v calls=%d", err, calls)
			}
		})
	}
}
