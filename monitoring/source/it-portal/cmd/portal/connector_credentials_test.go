package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCredentialVerifierRejectsUnsafeKeyBeforeDatabase(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "key")
	for _, sample := range []struct {
		content string
		mode    os.FileMode
	}{{strings.Repeat("x", 31), 0600}, {strings.Repeat("x", 32), 0644}} {
		if err := os.WriteFile(path, []byte(sample.content), sample.mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, sample.mode); err != nil {
			t.Fatal(err)
		}
		err := verifyConnectorCredentials(context.Background(), "not a database URL with private details", path)
		if err == nil || err.Error() != "integration credential verification failed" {
			t.Fatal("unsafe key was accepted or diagnostics exposed input", err)
		}
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if err := verifyConnectorCredentials(context.Background(), "", link); err == nil {
		t.Fatal("symlink key accepted")
	}
}
