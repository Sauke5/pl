// Pl signs only the exact plugin set recorded by the source-build lock.
package main

import (
	"bytes"
	"crypto"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/clearsign"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

type pluginLock struct {
	Plugins []struct {
		ID        string `json:"id"`
		Version   string `json:"version"`
		Directory string `json:"directory"`
	} `json:"plugins"`
}
type manifest struct {
	Plugin          string            `json:"plugin"`
	Version         string            `json:"version"`
	KeyID           string            `json:"keyId"`
	Time            int64             `json:"time"`
	Files           map[string]string `json:"files"`
	ManifestVersion string            `json:"manifestVersion"`
	SignatureType   string            `json:"signatureType"`
	SignedByOrg     string            `json:"signedByOrg"`
	SignedByOrgName string            `json:"signedByOrgName"`
}

func privateKey(path string) (*openpgp.Entity, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 65536 {
		return nil, errors.New("unsafe signing key file")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("signing key unavailable")
	}
	defer func() {
		for i := range raw {
			raw[i] = 0
		}
	}()
	keys, err := openpgp.ReadArmoredKeyRing(bytes.NewReader(raw))
	if err != nil || len(keys) != 1 || keys[0].PrivateKey == nil || keys[0].PrivateKey.Encrypted {
		return nil, errors.New("invalid signing key")
	}
	return keys[0], nil
}

func publicKey(key *openpgp.Entity) (string, error) {
	var out bytes.Buffer
	w, err := armor.Encode(&out, openpgp.PublicKeyType, nil)
	if err != nil {
		return "", err
	}
	if err = key.Serialize(w); err != nil {
		return "", err
	}
	if err = w.Close(); err != nil {
		return "", err
	}
	return out.String(), nil
}

func generateKey(path string) error {
	key, err := openpgp.NewEntity("Pl Grafana Builds", "", "builds@pl.invalid", &packet.Config{RSABits: 3072, DefaultHash: crypto.SHA256})
	if err != nil {
		return errors.New("signing key generation failed")
	}
	var raw bytes.Buffer
	w, err := armor.Encode(&raw, openpgp.PrivateKeyType, nil)
	if err != nil {
		return err
	}
	if err = key.SerializePrivate(w, nil); err != nil {
		return err
	}
	if err = w.Close(); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("signing key destination must be new")
	}
	defer f.Close()
	if _, err = f.Write(raw.Bytes()); err != nil {
		return errors.New("signing key write failed")
	}
	return f.Sync()
}

func hashes(root string) (map[string]string, error) {
	files := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("plugin symlinks are forbidden")
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("plugin contains nonregular file")
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "MANIFEST.txt" {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
		files[rel] = hex.EncodeToString(h.Sum(nil))
		return nil
	})
	if err != nil || len(files) == 0 {
		return nil, errors.New("plugin file enumeration failed")
	}
	return files, nil
}

func signedManifest(value manifest, key *openpgp.Entity, epoch int64) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	w, err := clearsign.Encode(&out, key.PrivateKey, &packet.Config{DefaultHash: crypto.SHA256, Time: func() time.Time { return time.Unix(epoch, 0) }})
	if err != nil {
		return nil, err
	}
	if _, err = w.Write(append(raw, '\n')); err != nil {
		return nil, err
	}
	if err = w.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func signPlugins(root, lockPath, keyPath, trustPath string, epoch int64, expectedFingerprint string) error {
	if epoch <= 0 {
		return errors.New("source epoch is required")
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return errors.New("plugin output directory unavailable")
	}
	realKey, err := filepath.EvalSymlinks(keyPath)
	if err != nil {
		return errors.New("signing key unavailable")
	}
	rel, err := filepath.Rel(realRoot, realKey)
	if err != nil || rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("signing key must be outside plugin outputs")
	}
	keyAbs, _ := filepath.Abs(realKey)
	trustAbs, err := filepath.Abs(trustPath)
	if err != nil || keyAbs == trustAbs || keyAbs == trustAbs+".json" {
		return errors.New("signing key must differ from public outputs")
	}
	key, err := privateKey(keyPath)
	if err != nil {
		return err
	}
	if expectedFingerprint != hex.EncodeToString(key.PrimaryKey.Fingerprint[:]) {
		return errors.New("signing identity differs from expected public fingerprint")
	}
	// A signature must not predate its key. A persistent CI key makes this
	// deterministic for the same source epoch and signing identity.
	if created := key.PrimaryKey.CreationTime.Unix(); epoch < created {
		epoch = created
	}
	pub, err := publicKey(key)
	if err != nil {
		return err
	}
	keyID := key.PrimaryKey.KeyIdString()
	raw, err := os.ReadFile(lockPath)
	if err != nil {
		return err
	}
	var lock pluginLock
	if err = json.Unmarshal(raw, &lock); err != nil || len(lock.Plugins) != 13 {
		return errors.New("exact thirteen-plugin lock required")
	}
	expected, ids := map[string]bool{}, map[string]bool{}
	bindings := map[string]string{}
	fixture := ""
	for _, p := range lock.Plugins {
		if p.Directory == "" || p.Directory != filepath.Base(p.Directory) || strings.ContainsAny(p.Directory, "/\\") || p.Directory == "." || p.Directory == ".." || p.ID == "" || p.Version == "" || expected[p.Directory] || ids[p.ID] {
			return errors.New("invalid or duplicate plugin lock entry")
		}
		expected[p.Directory], ids[p.ID] = true, true
		path := filepath.Join(root, p.Directory)
		info, e := os.Lstat(path)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("locked plugin directory unavailable")
		}
		data, e := os.ReadFile(filepath.Join(path, "plugin.json"))
		if e != nil {
			return errors.New("plugin descriptor unavailable")
		}
		var desc struct {
			ID   string `json:"id"`
			Info struct {
				Version string `json:"version"`
			} `json:"info"`
		}
		if json.Unmarshal(data, &desc) != nil || desc.ID != p.ID || desc.Info.Version != p.Version {
			return errors.New("plugin identity differs from source lock")
		}
		files, e := hashes(path)
		if e != nil {
			return e
		}
		value := manifest{Plugin: p.ID, Version: p.Version, KeyID: keyID, Time: epoch * 1000, Files: files, ManifestVersion: "2.0.0", SignatureType: "community", SignedByOrg: "pl", SignedByOrgName: "Pl"}
		body, e := signedManifest(value, key, epoch)
		if e != nil {
			return errors.New("plugin signing failed")
		}
		block, _ := clearsign.Decode(body)
		if block == nil {
			return errors.New("signed manifest decode failed")
		}
		hash := sha256.Sum256(block.Bytes)
		bindings[p.ID+"\x00"+p.Version] = hex.EncodeToString(hash[:])
		if fixture == "" {
			fixture = string(body)
		}
		if err = os.WriteFile(filepath.Join(path, "MANIFEST.txt"), body, 0644); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !expected[e.Name()] {
			return errors.New("unlocked plugin in output")
		}
	}
	var generated strings.Builder
	fmt.Fprintln(&generated, "// Code generated by Pl plugin signer; DO NOT EDIT.\npackage signature")
	fmt.Fprintf(&generated, "const plSigningKeyID = %s\nconst plSigningPublicKey = %s\nconst plSigningFixture = %s\n", strconv.Quote(keyID), strconv.Quote(pub), strconv.Quote(fixture))
	fmt.Fprintln(&generated, "var plSigningManifests = map[string]string{")
	keys := make([]string, 0, len(bindings))
	for k := range bindings {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&generated, "%s:%s,\n", strconv.Quote(k), strconv.Quote(bindings[k]))
	}
	fmt.Fprintln(&generated, "}")
	formatted, err := format.Source([]byte(generated.String()))
	if err != nil {
		return errors.New("public trust generation failed")
	}
	if err = os.WriteFile(trustPath, formatted, 0644); err != nil {
		return err
	}
	report, err := json.MarshalIndent(map[string]any{"schema": 1, "publisher": "Pl", "key_id": keyID, "fingerprint": hex.EncodeToString(key.PrimaryKey.Fingerprint[:]), "public_key": pub, "manifests": bindings, "signature_epoch": epoch}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(trustPath+".json", append(report, '\n'), 0644)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "expected keygen or sign")
		os.Exit(2)
	}
	f := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
	key := f.String("private-key-file", "", "protected ASCII-armored private key")
	root := f.String("plugins-dir", "", "exact rebuilt plugin directory")
	lock := f.String("lock-file", "", "pinned plugin lock")
	trust := f.String("trust-go", "", "generated public trust Go file")
	epoch := f.Int64("epoch", 0, "source epoch")
	fingerprint := f.String("expected-fingerprint", "", "approved public signing-key fingerprint")
	if f.Parse(os.Args[2:]) != nil {
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = generateKey(*key)
		if err == nil {
			err = printIdentity(*key)
		}
	case "public":
		err = printIdentity(*key)
	case "sign":
		err = signPlugins(*root, *lock, *key, *trust, *epoch, *fingerprint)
	default:
		err = errors.New("unknown signing operation")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Pl signing failed:", err)
		os.Exit(1)
	}
}

func printIdentity(path string) error {
	key, err := privateKey(path)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"fingerprint": hex.EncodeToString(key.PrimaryKey.Fingerprint[:]), "key_id": key.PrimaryKey.KeyIdString()})
}
