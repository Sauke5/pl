// Package connectorcredentials encrypts credentials bound to one integration
// and canonical origin. Persistent root-key provisioning belongs to the caller.
package connectorcredentials

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

var (
	ErrKey     = errors.New("connector credential key is invalid")
	ErrInvalid = errors.New("connector credential is invalid")
	ErrOpen    = errors.New("connector credential cannot be opened")
)

const maxSecret = 4096

type Codec struct {
	aead           cipher.AEAD
	fingerprintKey [32]byte
}

// New copies an independent, persistent 32-byte key. It never derives a key from
// login credentials. Separate subkeys isolate encryption and request fingerprints.
func New(key []byte) (*Codec, error) {
	if len(key) != 32 {
		return nil, ErrKey
	}
	derive := func(domain string) []byte {
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(domain))
		return mac.Sum(nil)
	}
	block, err := aes.NewCipher(derive("pl.connectorcredentials.encryption.v1"))
	if err != nil {
		return nil, ErrKey
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrKey
	}
	c := &Codec{aead: aead}
	copy(c.fingerprintKey[:], derive("pl.connectorcredentials.fingerprint-key.v1"))
	return c, nil
}

// Fingerprint is stable for idempotency comparisons under the same root key.
// It must not be returned to the browser or used as the credential itself.
func (c *Codec) Fingerprint(secret string) string {
	mac := hmac.New(sha256.New, c.fingerprintKey[:])
	mac.Write([]byte("pl.connectorcredentials.fingerprint.v1\x00"))
	mac.Write([]byte(secret))
	return hex.EncodeToString(mac.Sum(nil))
}

// CanonicalOrigin normalizes only an HTTP(S) origin, never a selectable API path.
// Network authorization and approval of resolved IPs are separate from parsing.
func CanonicalOrigin(raw string) (string, error) {
	if len(raw) == 0 || len(raw) > 2048 || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, "\\%\r\n\x00") {
		return "", ErrInvalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || u.RawPath != "" || (u.Path != "" && u.Path != "/") {
		return "", ErrInvalid
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname())
	if (scheme != "http" && scheme != "https") || host == "" || strings.HasSuffix(u.Host, ":") {
		return "", ErrInvalid
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		host = ip.Unmap().String()
	} else {
		if strings.ContainsAny(u.Host, "[]") {
			return "", ErrInvalid
		}
		host = strings.TrimSuffix(host, ".")
		if len(host) == 0 || len(host) > 253 {
			return "", ErrInvalid
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return "", ErrInvalid
			}
			for _, ch := range label {
				if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
					return "", ErrInvalid
				}
			}
		}
	}
	port := u.Port()
	if port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return "", ErrInvalid
		}
		port = strconv.Itoa(value)
		if scheme == "http" && port == "80" || scheme == "https" && port == "443" {
			port = ""
		}
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return scheme + "://" + host, nil
}

func binding(integrationID, origin string) ([]byte, error) {
	if len(integrationID) == 0 || len(integrationID) > 256 {
		return nil, ErrInvalid
	}
	for _, ch := range integrationID {
		if ch < 0x21 || ch > 0x7e {
			return nil, ErrInvalid
		}
	}
	canonical, err := CanonicalOrigin(origin)
	if err != nil || canonical != origin {
		return nil, ErrInvalid
	}
	aad := []byte("pl.connectorcredentials.envelope.v1\x00")
	aad = binary.BigEndian.AppendUint32(aad, uint32(len(integrationID)))
	aad = append(aad, integrationID...)
	aad = binary.BigEndian.AppendUint32(aad, uint32(len(origin)))
	return append(aad, origin...), nil
}

func validSecret(secret string) bool {
	if len(secret) == 0 || len(secret) > maxSecret {
		return false
	}
	for _, ch := range secret {
		if ch < 0x21 || ch > 0x7e {
			return false
		}
	}
	return true
}

// Seal returns version || random nonce || authenticated ciphertext.
func (c *Codec) Seal(integrationID, origin, secret string) ([]byte, error) {
	aad, err := binding(integrationID, origin)
	if err != nil || !validSecret(secret) || c == nil || c.aead == nil {
		return nil, ErrInvalid
	}
	envelope := make([]byte, 1+c.aead.NonceSize())
	envelope[0] = 1
	if _, err = rand.Read(envelope[1:]); err != nil {
		return nil, ErrInvalid
	}
	return c.aead.Seal(envelope, envelope[1:], []byte(secret), aad), nil
}

func (c *Codec) Open(integrationID, origin string, envelope []byte) (string, error) {
	aad, err := binding(integrationID, origin)
	if err != nil || c == nil || c.aead == nil {
		return "", ErrOpen
	}
	start := 1 + c.aead.NonceSize()
	if len(envelope) < start+c.aead.Overhead()+1 || len(envelope) > start+c.aead.Overhead()+maxSecret || envelope[0] != 1 {
		return "", ErrOpen
	}
	plaintext, err := c.aead.Open(nil, envelope[1:start], envelope[start:], aad)
	if err != nil || !validSecret(string(plaintext)) {
		return "", ErrOpen
	}
	return string(plaintext), nil
}
