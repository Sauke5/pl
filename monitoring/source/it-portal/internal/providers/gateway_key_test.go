package providers

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveGatewayKeyPreservesExactBinaryBytes(t *testing.T) {
	directory := t.TempDir()
	key := make([]byte, 32)
	for n := range key {
		key[n] = byte(255 - n)
	}
	key[0], key[1], key[2], key[31] = ' ', '\n', '\r', ' '
	if err := os.WriteFile(filepath.Join(directory, "auditor.key"), key, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_SECRETS_DIR", directory)
	t.Setenv("PORTAL_SECRET_REFS", "file:other.key, file:auditor.key ")
	got, err := ResolveGatewayKey("file:auditor.key")
	if err != nil || !bytes.Equal(got, key) {
		t.Fatal("raw binary gateway key was rejected, trimmed or decoded")
	}
}

func TestResolveGatewayKeyRejectsUnapprovedEscapingAndNonFileReferences(t *testing.T) {
	directory, outside := t.TempDir(), t.TempDir()
	key := bytes.Repeat([]byte{42}, 32)
	if err := os.WriteFile(filepath.Join(directory, "valid.key"), key, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "outside.key"), key, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "outside.key"), filepath.Join(directory, "escape.key")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_SECRETS_DIR", directory)
	for _, ref := range []string{"", "file:valid.key", "env:PORTAL_SECRET_AUDITOR", "file:", "file:.", "file:..", "file:../outside.key", "file:/tmp/outside.key", "file:escape.key", "file:missing.key"} {
		t.Run(ref, func(t *testing.T) {
			allowlist := ref
			if ref == "file:valid.key" {
				allowlist = "file:other.key"
			}
			t.Setenv("PORTAL_SECRET_REFS", allowlist)
			if value, err := ResolveGatewayKey(ref); err == nil || len(value) != 0 || strings.Contains(err.Error(), outside) || strings.Contains(err.Error(), directory) {
				t.Fatal("unapproved key accepted or private file path exposed")
			}
		})
	}
}

func TestResolveGatewayKeyRejectsWrongSizeAndNonRegularFiles(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("PORTAL_SECRETS_DIR", directory)
	for _, size := range []int{0, 1, 31, 33, 8192} {
		name := filepath.Join(directory, "wrong.key")
		if err := os.WriteFile(name, bytes.Repeat([]byte{42}, size), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PORTAL_SECRET_REFS", "file:wrong.key")
		if value, err := ResolveGatewayKey("file:wrong.key"); err == nil || len(value) != 0 {
			t.Fatalf("accepted key size %d", size)
		}
	}
	if err := os.Mkdir(filepath.Join(directory, "directory.key"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PORTAL_SECRET_REFS", "file:directory.key")
	if value, err := ResolveGatewayKey("file:directory.key"); err == nil || len(value) != 0 {
		t.Fatal("directory accepted as signing key")
	}
}
