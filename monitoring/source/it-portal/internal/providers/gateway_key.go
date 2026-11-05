package providers

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ResolveGatewayKey reads an explicitly allowlisted raw signing key. Unlike
// text credentials, binary keys must never be trimmed or implicitly decoded.
func ResolveGatewayKey(ref string) ([]byte, error) {
	allowed := false
	for _, item := range strings.Split(os.Getenv("PORTAL_SECRET_REFS"), ",") {
		if strings.TrimSpace(item) == ref && ref != "" {
			allowed = true
		}
	}
	if !allowed || !strings.HasPrefix(ref, "file:") {
		return nil, errors.New("Gateway key reference is not allowlisted")
	}
	name := strings.TrimPrefix(ref, "file:")
	if name == "" || name != filepath.Base(name) || name == "." || name == ".." {
		return nil, errors.New("Invalid gateway key reference")
	}
	directory := os.Getenv("PORTAL_SECRETS_DIR")
	if directory == "" {
		directory = "/run/secrets/portal"
	}
	base, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, errors.New("Gateway key directory unavailable")
	}
	target, err := filepath.EvalSymlinks(filepath.Join(base, name))
	if err != nil || filepath.Dir(target) != base {
		return nil, errors.New("Gateway key unavailable")
	}
	file, err := os.Open(target)
	if err != nil {
		return nil, errors.New("Gateway key unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("Invalid gateway key file")
	}
	key, err := io.ReadAll(io.LimitReader(file, 33))
	if err != nil || len(key) != 32 {
		return nil, errors.New("Gateway key must contain exactly 32 bytes")
	}
	return key, nil
}
