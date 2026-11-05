package connectorcredentials_test

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"pl/portal/internal/connectorcredentials"
)

func codec(t *testing.T, fill byte) *connectorcredentials.Codec {
	t.Helper()
	c, err := connectorcredentials.New(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestEnvelopeAuthenticatesOwnerOriginAndEveryByte(t *testing.T) {
	c := codec(t, 7)
	const secret = "mailcow-readonly-secret-fixture"
	envelope, err := c.Seal("integration-a", "https://mail.example.test", secret)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(envelope, []byte(secret)) {
		t.Fatal("plaintext in envelope")
	}
	opened, err := c.Open("integration-a", "https://mail.example.test", envelope)
	if err != nil || opened != secret {
		t.Fatal("round trip failed")
	}
	second, err := c.Seal("integration-a", "https://mail.example.test", secret)
	if err != nil || bytes.Equal(envelope, second) || bytes.Equal(envelope[1:13], second[1:13]) {
		t.Fatal("encryption did not use an independent random nonce")
	}
	for _, tc := range []struct {
		name, id, origin string
		codec            *connectorcredentials.Codec
	}{
		{"owner", "integration-b", "https://mail.example.test", c},
		{"hostname", "integration-a", "https://other.example.test", c},
		{"scheme", "integration-a", "http://mail.example.test", c},
		{"port", "integration-a", "https://mail.example.test:8443", c},
		{"noncanonical", "integration-a", "https://mail.example.test/", c},
		{"key", "integration-a", "https://mail.example.test", codec(t, 8)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value, err := tc.codec.Open(tc.id, tc.origin, envelope)
			if value != "" || !errors.Is(err, connectorcredentials.ErrOpen) {
				t.Fatal("wrong binding/key yielded a credential")
			}
		})
	}
	// Includes the version, nonce, ciphertext and authentication tag.
	for index := range envelope {
		changed := bytes.Clone(envelope)
		changed[index] ^= 1
		value, err := c.Open("integration-a", "https://mail.example.test", changed)
		if value != "" || !errors.Is(err, connectorcredentials.ErrOpen) {
			t.Fatalf("tampering at byte %d was accepted", index)
		}
	}
	for length := 0; length < len(envelope); length++ {
		value, err := c.Open("integration-a", "https://mail.example.test", envelope[:length])
		if value != "" || !errors.Is(err, connectorcredentials.ErrOpen) {
			t.Fatalf("truncated envelope %d was accepted", length)
		}
	}
	if value, err := c.Open("integration-a", "https://mail.example.test", append(bytes.Clone(envelope), 0)); value != "" || !errors.Is(err, connectorcredentials.ErrOpen) {
		t.Fatal("extended envelope was accepted")
	}
}

func TestKeyOwnershipFingerprintsAndBounds(t *testing.T) {
	for _, size := range []int{0, 1, 16, 31, 33, 64} {
		if c, err := connectorcredentials.New(make([]byte, size)); c != nil || !errors.Is(err, connectorcredentials.ErrKey) {
			t.Fatalf("accepted key length %d", size)
		}
	}
	key := bytes.Repeat([]byte{5}, 32)
	c, err := connectorcredentials.New(key)
	if err != nil {
		t.Fatal(err)
	}
	key[0] ^= 1
	const secret = "stable-idempotency-fixture"
	fingerprint := c.Fingerprint(secret)
	if len(fingerprint) != 64 || fingerprint != codec(t, 5).Fingerprint(secret) || fingerprint == codec(t, 6).Fingerprint(secret) || fingerprint == c.Fingerprint(secret+"x") {
		t.Fatal("fingerprint is not stable, keyed and sensitive to the full secret")
	}
	envelope, err := c.Seal("integration", "https://mail.example.test", strings.Repeat("k", 4096))
	if err != nil {
		t.Fatal("maximum token rejected")
	}
	value, err := codec(t, 5).Open("integration", "https://mail.example.test", envelope)
	if err != nil || len(value) != 4096 {
		t.Fatal("caller mutation changed the codec key")
	}
	for _, secret := range []string{"", " ", "token\n", "two words", "token\x00", "токен", strings.Repeat("k", 4097)} {
		if envelope, err := c.Seal("integration", "https://mail.example.test", secret); envelope != nil || !errors.Is(err, connectorcredentials.ErrInvalid) {
			t.Fatal("invalid token accepted")
		}
	}
	for _, id := range []string{"", "with space", "with\x00", strings.Repeat("i", 257)} {
		if envelope, err := c.Seal(id, "https://mail.example.test", secret); envelope != nil || !errors.Is(err, connectorcredentials.ErrInvalid) {
			t.Fatal("invalid owner accepted")
		}
	}
}

func TestCanonicalOriginAndExactBinding(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"HTTPS://Mail.Example.Test:443/", "https://mail.example.test"},
		{"http://mail.example.test.:080/", "http://mail.example.test"},
		{"https://mail.example.test:08443", "https://mail.example.test:8443"},
		{"https://[2001:0db8:0000::1]:443/", "https://[2001:db8::1]"},
		{"http://[::ffff:192.0.2.8]:8080/", "http://192.0.2.8:8080"},
	} {
		got, err := connectorcredentials.CanonicalOrigin(tc.input)
		if err != nil || got != tc.want {
			t.Fatalf("origin normalization: got %q, want %q (%v)", got, tc.want, err)
		}
		if again, err := connectorcredentials.CanonicalOrigin(got); err != nil || again != got {
			t.Fatal("normalization is not idempotent")
		}
	}
	c := codec(t, 9)
	for _, input := range []string{"https://MAIL.example.test", "https://mail.example.test/", "https://mail.example.test:443"} {
		if envelope, err := c.Seal("integration", input, "key"); envelope != nil || !errors.Is(err, connectorcredentials.ErrInvalid) {
			t.Fatal("noncanonical binding accepted")
		}
	}
	for _, input := range []string{"", " https://mail.test", "https://mail.test ", "ftp://mail.test", "//mail.test", "https://user:key@mail.test", "https://mail.test/api", "https://mail.test?", "https://mail.test?q=x", "https://mail.test#", "https://mail.test/#fragment", "https://mail.test/%2f", "https://mail.test\\evil", "https://mail.test:", "https://mail.test:0", "https://mail.test:65536", "https://[fe80::1%25eth0]", "https://[mail.test]", "https://bad_host", "https://-bad.test", "https://bad..test", "https://mail.test\n"} {
		if origin, err := connectorcredentials.CanonicalOrigin(input); origin != "" || !errors.Is(err, connectorcredentials.ErrInvalid) {
			t.Fatalf("invalid origin accepted: %q", input)
		}
	}
}
