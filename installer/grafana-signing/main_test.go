package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/clearsign"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

func TestSigningBindsExactPluginSetAndRejectsUnsafeInputs(t *testing.T) {
	base := t.TempDir()
	keyPath := filepath.Join(base, "signing-key.asc")
	if err := generateKey(keyPath); err != nil {
		t.Fatal(err)
	}
	if err := generateKey(keyPath); err == nil {
		t.Fatal("existing signing key overwritten")
	}
	key, err := privateKey(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "plugins")
	if err = os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	entries := []map[string]string{}
	for i := 0; i < 13; i++ {
		id := fmt.Sprintf("datasource-%02d", i)
		path := filepath.Join(root, id)
		if err = os.Mkdir(path, 0755); err != nil {
			t.Fatal(err)
		}
		entry := map[string]string{"id": id, "version": "1.0.0", "directory": id}
		entries = append(entries, entry)
		data, _ := json.Marshal(map[string]any{"id": id, "info": map[string]string{"version": "1.0.0"}})
		if err = os.WriteFile(filepath.Join(path, "plugin.json"), data, 0644); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(path, "backend"), []byte("rebuilt-payload-"+id), 0755); err != nil {
			t.Fatal(err)
		}
	}
	lockPath, trustPath := filepath.Join(base, "lock.json"), filepath.Join(base, "public.go")
	lock, _ := json.Marshal(map[string]any{"plugins": entries})
	if err = os.WriteFile(lockPath, lock, 0644); err != nil {
		t.Fatal(err)
	}
	if err = signPlugins(root, lockPath, keyPath, trustPath, 1791891663, hex.EncodeToString(key.PrimaryKey.Fingerprint[:])); err != nil {
		t.Fatal(err)
	}
	public, err := os.ReadFile(trustPath)
	if err != nil || bytes.Contains(public, []byte("PRIVATE KEY")) {
		t.Fatal("invalid public trust output")
	}
	if strings.Count(string(public), `datasource-`) < 13 {
		t.Fatal("trust output lost plugin identities")
	}
	pub, err := publicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyring, err := openpgp.ReadArmoredKeyRing(strings.NewReader(pub))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		body, err := os.ReadFile(filepath.Join(root, entry["id"], "MANIFEST.txt"))
		if err != nil {
			t.Fatal(err)
		}
		block, _ := clearsign.Decode(body)
		if block == nil {
			t.Fatal("manifest not clearsigned")
		}
		if _, err = openpgp.CheckDetachedSignature(keyring, bytes.NewReader(block.Bytes), block.ArmoredSignature.Body, &packet.Config{}); err != nil {
			t.Fatal(err)
		}
		var m manifest
		if json.Unmarshal(block.Plaintext, &m) != nil || m.Plugin != entry["id"] || m.Version != "1.0.0" || len(m.Files) != 2 {
			t.Fatal("signed identity or file set lost")
		}
		payload, err := os.ReadFile(filepath.Join(root, entry["id"], "backend"))
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(payload)
		if m.Files["backend"] != hex.EncodeToString(h[:]) {
			t.Fatal("signed backend hash mismatch")
		}
		h = sha256.Sum256(block.Bytes)
		if !bytes.Contains(public, []byte(hex.EncodeToString(h[:]))) {
			t.Fatal("manifest not bound into core trust")
		}
	}
	first := filepath.Join(root, entries[0]["id"])
	privateCopy := filepath.Join(first, "private.asc")
	privateBytes, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(privateCopy, privateBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err = signPlugins(root, lockPath, privateCopy, trustPath, 1791891663, hex.EncodeToString(key.PrimaryKey.Fingerprint[:])); err == nil {
		t.Fatal("private key in plugin output accepted")
	}
	if err = os.Remove(privateCopy); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink("/etc/passwd", filepath.Join(first, "escape")); err != nil {
		t.Fatal(err)
	}
	if err = signPlugins(root, lockPath, keyPath, trustPath, 1791891663, hex.EncodeToString(key.PrimaryKey.Fingerprint[:])); err == nil {
		t.Fatal("plugin symlink signed")
	}
	if err = os.Remove(filepath.Join(first, "escape")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(root, "foreign-plugin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err = signPlugins(root, lockPath, keyPath, trustPath, 1791891663, hex.EncodeToString(key.PrimaryKey.Fingerprint[:])); err == nil {
		t.Fatal("unlocked plugin signed")
	}
	if err = os.Chmod(keyPath, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = privateKey(keyPath); err == nil {
		t.Fatal("world-readable key accepted")
	}
}
