package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/argon2"
	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

// Bound aggregate KDF memory even when multiple requests arrive simultaneously.
// Every valid credential attempt, including an unknown username, takes the same KDF path.
var localPasswordSlots = make(chan struct{}, 4)

const localAuthFailure = "Неверное имя пользователя или пароль"

type localPasswordHash struct {
	memory      uint32
	iterations  uint32
	parallelism uint8
	salt        []byte
	key         []byte
}

// GenerateLocalAdminPasswordHash uses the same bounded PHC contract as login.
// It does not read server configuration and never includes input in errors.
func GenerateLocalAdminPasswordHash(password []byte) (string, error) {
	if len(password) < 1 || len(password) > 1024 {
		return "", errors.New("password must contain 1..1024 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", errors.New("password hash generation failed")
	}
	const memory, iterations, parallelism = 65536, 3, 1
	key := argon2.IDKey(password, salt, iterations, memory, parallelism, 32)
	defer clear(key)
	encoded := fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", memory, iterations, parallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
	if _, err := parseLocalPasswordHash(encoded); err != nil {
		return "", errors.New("password hash generation failed")
	}
	return encoded, nil
}

func parseLocalPasswordHash(encoded string) (localPasswordHash, error) {
	var out localPasswordHash
	invalid := errors.New("invalid local administrator password hash")
	if len(encoded) > 512 {
		return out, invalid
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return out, invalid
	}
	params := strings.Split(parts[3], ",")
	if len(params) != 3 {
		return out, invalid
	}
	values := make([]uint64, 3)
	for i, prefix := range []string{"m=", "t=", "p="} {
		if !strings.HasPrefix(params[i], prefix) {
			return out, invalid
		}
		value := strings.TrimPrefix(params[i], prefix)
		if value == "" || strings.Trim(value, "0123456789") != "" {
			return out, invalid
		}
		n, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return out, invalid
		}
		values[i] = n
	}
	// Only deliberate, reasonably strong and bounded configurations are accepted.
	if values[0] < 32768 || values[0] > 65536 || values[1] < 2 || values[1] > 4 || values[2] < 1 || values[2] > 2 {
		return out, invalid
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil || len(salt) < 16 || len(salt) > 32 {
		return out, invalid
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil || len(key) != 32 {
		return out, invalid
	}
	out = localPasswordHash{uint32(values[0]), uint32(values[1]), uint8(values[2]), salt, key}
	return out, nil
}

func readLocalPasswordHash(path string) (localPasswordHash, error) {
	var out localPasswordHash
	f, err := os.Open(path)
	if err != nil {
		return out, errors.New("local administrator hash unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 512 {
		return out, errors.New("invalid local administrator hash file")
	}
	b, err := io.ReadAll(io.LimitReader(f, 513))
	if err != nil || len(b) > 512 {
		return out, errors.New("invalid local administrator hash file")
	}
	return parseLocalPasswordHash(strings.TrimSpace(string(b)))
}

// ValidateLocalAdminHashFile is for fail-fast startup validation; it never includes hash data in errors.
func ValidateLocalAdminHashFile(path string) error {
	_, err := readLocalPasswordHash(path)
	return err
}

func (h localPasswordHash) verify(password string) bool {
	actual := argon2.IDKey([]byte(password), h.salt, h.iterations, h.memory, h.parallelism, uint32(len(h.key)))
	return subtle.ConstantTimeCompare(actual, h.key) == 1
}

func localPeer(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "unknown-peer"
	}
	return ip.String() // Never trust X-Forwarded-For supplied by a browser or proxy.
}

// Trust one overwritten header only from explicitly trusted immediate proxies.
// X-Forwarded-For chains are deliberately not used for authentication limits.
func (s *Server) loginPeer(r *http.Request) string {
	peer := localPeer(r)
	ip := net.ParseIP(peer)
	if ip == nil {
		return peer
	}
	for _, cidr := range s.Config.TrustedProxyCIDRs {
		_, network, e := net.ParseCIDR(cidr)
		if e != nil || !network.Contains(ip) {
			continue
		}
		values := r.Header.Values("X-Real-IP")
		if len(values) != 1 {
			return peer
		}
		real := net.ParseIP(strings.TrimSpace(values[0]))
		if real == nil || real.IsUnspecified() || real.IsMulticast() {
			return peer
		}
		return real.String()
	}
	return peer
}

type loginReservedBucket struct {
	key    string
	window time.Time
}
type loginReservation []loginReservedBucket

// Tests and other callers that intentionally count failures do not refund.
func (s *Server) consumeLocalLoginAttempt(ctx context.Context, peer, username string) (bool, error) {
	_, allowed, e := s.reserveLoginAttempt(ctx, peer, username)
	return allowed, e
}

func (s *Server) reserveLoginAttempt(ctx context.Context, peer, username string) (loginReservation, bool, error) {
	reservation := loginReservation{}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return reservation, false, err
	}
	defer tx.Rollback(ctx)
	// No username or client address is stored in plaintext in the limiter.
	keys := []struct {
		key   string
		limit int
	}{
		{hash("local-ip\x00" + peer), 20},
		{hash("local-pair\x00" + peer + "\x00" + strings.ToLower(strings.TrimSpace(username))), 5},
	}
	_, err = tx.Exec(ctx, "DELETE FROM local_login_attempts WHERE window_start < now() - interval '1 day'")
	if err != nil {
		return reservation, false, err
	}
	allowed := true
	for _, bucket := range keys {
		var attempts int
		var window time.Time
		err = tx.QueryRow(ctx, `INSERT INTO local_login_attempts(bucket,attempts) VALUES($1,1)
            ON CONFLICT(bucket) DO UPDATE SET
              attempts=CASE WHEN local_login_attempts.window_start <= now()-interval '15 minutes' THEN 1 ELSE LEAST(local_login_attempts.attempts+1,1000000) END,
              window_start=CASE WHEN local_login_attempts.window_start <= now()-interval '15 minutes' THEN now() ELSE local_login_attempts.window_start END
            RETURNING attempts, window_start`, bucket.key).Scan(&attempts, &window)
		if err != nil {
			return reservation, false, err
		}
		reservation = append(reservation, loginReservedBucket{key: bucket.key, window: window})
		if attempts > bucket.limit {
			allowed = false
			break
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return reservation, false, err
	}
	return reservation, allowed, nil
}

// Refund exactly this successful attempt. Never reset a bucket: that would erase
// concurrent failures. The timestamp prevents refunding into a newer window.
func (s *Server) refundLoginAttempt(ctx context.Context, reservation loginReservation) error {
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	for _, bucket := range reservation {
		var attempts int
		e = tx.QueryRow(ctx, "SELECT attempts FROM local_login_attempts WHERE bucket=$1 AND window_start=$2 FOR UPDATE", bucket.key, bucket.window).Scan(&attempts)
		if errors.Is(e, pgx.ErrNoRows) {
			continue
		}
		if e != nil {
			return e
		}
		if attempts <= 1 {
			_, e = tx.Exec(ctx, "DELETE FROM local_login_attempts WHERE bucket=$1 AND window_start=$2", bucket.key, bucket.window)
		} else {
			_, e = tx.Exec(ctx, "UPDATE local_login_attempts SET attempts=attempts-1 WHERE bucket=$1 AND window_start=$2", bucket.key, bucket.window)
		}
		if e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

func (s *Server) localLogin(w http.ResponseWriter, r *http.Request) {
	// Keep old-password verification/session creation outside the revoke/replace window.
	s.localAuthMu.Lock()
	defer s.localAuthMu.Unlock()
	if s.Config.LocalAdminHashFile == "" {
		http.NotFound(w, r)
		return
	}
	if !s.sameOrigin(r) {
		problem(w, 403, "csrf", "Недопустимый источник запроса")
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		problem(w, 415, "content_type", "Ожидается application/json")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		problem(w, 400, "invalid_json", "Некорректный запрос входа")
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		problem(w, 400, "invalid_json", "Ожидается один JSON-документ")
		return
	}
	if len(input.Username) > 128 || len(input.Password) > 1024 {
		problem(w, 400, "invalid_json", "Некорректный запрос входа")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	select {
	case localPasswordSlots <- struct{}{}:
		defer func() { <-localPasswordSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		problem(w, 429, "login_rate_limited", "Вход занят. Повторите через несколько секунд.")
		return
	}
	reservation, allowed, err := s.reserveLoginAttempt(ctx, s.loginPeer(r), input.Username)
	if err != nil {
		problem(w, 503, "login_unavailable", "Вход временно недоступен")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		problem(w, 429, "login_rate_limited", "Слишком много попыток входа. Повторите через 15 минут.")
		return
	}
	passwordHash, err := readLocalPasswordHash(s.Config.LocalAdminHashFile)
	if err != nil {
		problem(w, 503, "login_unavailable", "Вход временно недоступен")
		return
	}
	lifetime, policyErr := s.sessionLifetime(ctx)
	if policyErr != nil {
		problem(w, 503, "login_unavailable", "Настройки входа недоступны")
		return
	}
	if s.Config.LocalUsersEnabled && (!asciiLocalUsername(input.Username) || !strings.EqualFold(input.Username, s.Config.LocalAdminUsername)) {
		token, csrf := randomToken(), randomToken()
		username := strings.ToLower(input.Username)
		if !asciiLocalUsername(input.Username) {
			// Empty usernames cannot exist. Preserve the dummy KDF path instead
			// of mapping Unicode lookalikes to a real ASCII account.
			username = ""
		}
		previous := ""
		if c, e := r.Cookie("portal_session"); e == nil {
			previous = hash(c.Value)
		}
		_, err = s.Store.LocalUserLogin(ctx, username, hash(token), csrf, previous, time.Now().Add(lifetime), func(encoded string) (bool, error) {
			// DB passwords are generated with this fixed work factor. Unknown
			// usernames pay the same cost without comparing to the builtin secret.
			h := localPasswordHash{memory: 65536, iterations: 3, parallelism: 1, salt: make([]byte, 16), key: make([]byte, 32)}
			if encoded != "" {
				var e error
				h, e = parseLocalPasswordHash(encoded)
				if e != nil {
					return false, e
				}
			}
			return h.verify(input.Password), nil
		})
		if errors.Is(err, store.ErrInvalid) {
			problem(w, 401, "invalid_credentials", localAuthFailure)
			return
		}
		if err != nil {
			problem(w, 503, "login_unavailable", "Вход временно недоступен")
			return
		}
		if err = s.refundLoginAttempt(ctx, reservation); err != nil {
			_, _ = s.Store.Pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1", hash(token))
			problem(w, 503, "login_unavailable", "Вход временно недоступен")
			return
		}
		s.cookie(w, "portal_session", token, int(lifetime.Seconds()))
		respond(w, 200, map[string]bool{"ok": true})
		return
	}
	validPassword := passwordHash.verify(input.Password)
	expected, supplied := s.Config.LocalAdminUsername, input.Username
	if s.Config.LocalUsersEnabled {
		expected, supplied = strings.ToLower(expected), strings.ToLower(supplied)
	}
	expectedUsername := sha256.Sum256([]byte(expected))
	suppliedUsername := sha256.Sum256([]byte(supplied))
	validUsername := subtle.ConstantTimeCompare(expectedUsername[:], suppliedUsername[:]) == 1
	if !validPassword || !validUsername {
		problem(w, 401, "invalid_credentials", localAuthFailure)
		return
	}
	if err := s.refundLoginAttempt(ctx, reservation); err != nil {
		problem(w, 503, "login_unavailable", "Вход временно недоступен")
		return
	}
	user := model.User{ID: "local-admin", Name: "Локальный администратор", Admin: true}
	if err := s.newSession(w, r, user, time.Now().Add(lifetime)); err != nil {
		s.fail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
