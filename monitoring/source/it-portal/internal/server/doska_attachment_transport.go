package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"pl/portal/internal/organization"
)

const doskaFileLimit int64 = 26214400
const doskaSpoolBudget int64 = 64 << 20
const doskaTransferTimeout = 120 * time.Second
const doskaDownloadLease = 5 * time.Second

// Presence opts in only a local reviewed candidate. Resource budgets are fixed;
// unknown config fields (including attempts to increase them) fail strict JSON.
// This directory must be dedicated, private and owned by the actual process UID.
type DoskaAttachmentConfig struct {
	SpoolDirectory string `json:"spool_directory"`
}

const doskaAttachmentBase = "/doska/api/doska/projects/{id}/tasks/{taskId}"

var doskaAttachmentRequestPath = regexp.MustCompile(`^/doska/api/doska/projects/[A-Za-z0-9_-]{1,128}/tasks/[A-Za-z0-9_-]{1,128}/(?:attachments|attachment-uploads)(?:/|$)`)
var doskaAttachmentUploadPath = regexp.MustCompile(`^/doska/api/doska/projects/[A-Za-z0-9_-]{1,128}/tasks/[A-Za-z0-9_-]{1,128}/attachment-uploads/[A-Za-z0-9_-]{1,128}/content$`)

// Every attachment route needs an explicit kind AND schema, including JSON
// routes. Merely allowing an API prefix or a read/write kind cannot enable it.
func doskaAttachmentRoute(r DoskaGatewayRoute) (bool, bool) {
	relevant := strings.Contains(r.Path, "attachment") || r.Kind == "upload" || r.Kind == "download" || r.Schema != ""
	if !relevant {
		return false, false
	}
	type spec struct{ method, path, kind, schema string }
	specs := []spec{
		{"GET", "/attachments", "read", "attachment-list-v1"},
		{"POST", "/attachment-uploads", "write", "attachment-reserve-v1"},
		{"PUT", "/attachment-uploads/{uploadId}/content", "upload", "attachment-content-v1"},
		{"POST", "/attachment-uploads/{uploadId}/finalize", "write", "attachment-finalize-v1"},
		{"DELETE", "/attachment-uploads/{uploadId}", "write", "attachment-empty-v1"},
		{"GET", "/attachments/{attachmentId}/content", "download", "attachment-download-v1"},
		{"DELETE", "/attachments/{attachmentId}", "write", "attachment-empty-v1"},
	}
	for _, s := range specs {
		if r.Path != doskaAttachmentBase+s.path || r.Method != s.method || r.Kind != s.kind || r.Schema != s.schema {
			continue
		}
		if s.schema != "attachment-list-v1" {
			return true, len(r.Query) == 0
		}
		if len(r.Query) != 2 {
			return true, false
		}
		for name, max := range map[string]int64{"limit": 100, "offset": 10000000} {
			q, ok := r.Query[name]
			min := int64(0)
			if name == "limit" {
				min = 1
			}
			if !ok || q.Kind != "integer" || q.Required || q.Multiple || q.AllowEmpty || q.Minimum == nil || *q.Minimum != min || q.Maximum == nil || *q.Maximum != max || q.MaxBytes != 0 || q.MaxChars != 0 || len(q.Enum) != 0 {
				return true, false
			}
		}
		return true, true
	}
	return true, false
}

func doskaAttachmentJSON(schema string, body []byte) bool {
	switch schema {
	case "attachment-list-v1", "attachment-empty-v1":
		return len(body) == 0
	case "attachment-finalize-v1":
		var v struct{}
		return len(bytes.TrimSpace(body)) > 0 && bytes.TrimSpace(body)[0] == '{' && doskaStrictJSON(body, &v) == nil
	case "attachment-reserve-v1":
		var v struct {
			Filename        string `json:"filename"`
			Size            *int64 `json:"size"`
			SHA256          string `json:"sha256"`
			ClientRequestID string `json:"clientRequestId"`
		}
		if doskaStrictJSON(body, &v) != nil || v.Size == nil || *v.Size < 1 || *v.Size > doskaFileLimit || !gatewayString(v.Filename, 1020, false) || utf8.RuneCountInString(v.Filename) > 255 || !gatewaySafeID.MatchString(v.ClientRequestID) || len(v.ClientRequestID) > 100 || len(v.SHA256) != 64 {
			return false
		}
		b, e := hex.DecodeString(v.SHA256)
		return e == nil && len(b) == 32 && hex.EncodeToString(b) == v.SHA256
	}
	return false
}

type doskaFileAdmission struct {
	active   int
	subjects map[string]bool
}
type doskaFileTransport struct {
	mu               sync.Mutex
	upload, download doskaFileAdmission
	reserved         int64
	closed           bool
	wg               sync.WaitGroup
	closeOnce        sync.Once
	lifecycle        context.Context
	stop             context.CancelFunc
	root             *os.Root
	lock             *os.File
	// Immutable per-instance constants; tests can shorten time, never production config.
	timeout, lease time.Duration
}
type doskaSpool struct {
	file     *os.File
	name     string
	size     int64
	digest   [32]byte
	complete bool
}

func newDoskaFileTransport(c DoskaAttachmentConfig) (*doskaFileTransport, error) {
	invalid := errors.New("invalid private Doska spool directory")
	path := filepath.Clean(c.SpoolDirectory)
	if !filepath.IsAbs(path) || path == string(filepath.Separator) {
		return nil, invalid
	}
	real, e := filepath.EvalSymlinks(path)
	if e != nil || real != path {
		return nil, invalid
	}
	info, e := os.Lstat(path)
	if e != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return nil, invalid
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Geteuid()) {
		return nil, invalid
	}
	root, e := os.OpenRoot(path)
	if e != nil {
		return nil, invalid
	}
	anchored, e := root.Stat(".")
	if e != nil || !os.SameFile(info, anchored) {
		root.Close()
		return nil, invalid
	}
	fail := func(err error) (*doskaFileTransport, error) { root.Close(); return nil, err }
	// Lock is held until process exit or explicit local fixture Close. A second
	// instance cannot delete files still owned by the first instance.
	if info, e := root.Lstat(".doska-spool.lock"); e == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return fail(invalid)
	} else if e != nil && !os.IsNotExist(e) {
		return fail(invalid)
	}
	lock, e := root.OpenFile(".doska-spool.lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return fail(invalid)
	}
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		lock.Close()
		return fail(errors.New("Doska spool already in use"))
	}
	lifecycle, stop := context.WithCancel(context.Background())
	g := &doskaFileTransport{lifecycle: lifecycle, stop: stop, root: root, lock: lock, timeout: doskaTransferTimeout, lease: doskaDownloadLease, upload: doskaFileAdmission{subjects: map[string]bool{}}, download: doskaFileAdmission{subjects: map[string]bool{}}}
	// Recovery precedes admission. Touch ONLY regular files in our exact namespace;
	// unknown entries, symlinks and other applications' temp files are not removed.
	dir, e := root.Open(".")
	if e != nil {
		g.close()
		return nil, invalid
	}
	entries, e := dir.ReadDir(-1)
	dir.Close()
	if e != nil {
		g.close()
		return nil, invalid
	}
	for _, entry := range entries {
		if !doskaSpoolName.MatchString(entry.Name()) {
			continue
		}
		info, e := root.Lstat(entry.Name())
		if e != nil || !info.Mode().IsRegular() {
			g.close()
			return nil, invalid
		}
		g.reserved += info.Size()
		if e = root.Remove(entry.Name()); e != nil {
			g.close()
			return nil, errors.New("Doska orphan cleanup failed")
		}
		g.reserved -= info.Size()
	}
	// Actually exercise the process UID's write/read/unlink permissions.
	f, e := g.create()
	if e != nil {
		g.close()
		return nil, invalid
	}
	_, e = f.file.Write([]byte{0})
	if e == nil {
		_, e = f.file.ReadAt(make([]byte, 1), 0)
	}
	ce := f.file.Close()
	re := root.Remove(f.name)
	if e != nil || ce != nil || re != nil {
		g.close()
		return nil, invalid
	}
	return g, nil
}

var doskaSpoolName = regexp.MustCompile(`^doska-upload-[A-Za-z0-9_-]{43}\.tmp$`)

func (g *doskaFileTransport) close() error {
	g.closeOnce.Do(func() {
		g.mu.Lock()
		g.closed = true
		g.mu.Unlock()
		if g.stop != nil {
			g.stop()
		}
		g.wg.Wait()
		if g.root != nil {
			g.root.Close()
		}
		if g.lock != nil {
			g.lock.Close()
		}
	})
	return nil
}

func (g *doskaGateway) Close() error {
	g.events.close()
	if g.files != nil {
		return g.files.close()
	}
	return nil
}
func (g *doskaFileTransport) create() (*doskaSpool, error) {
	name := "doska-upload-" + randomToken() + ".tmp"
	f, e := g.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	return &doskaSpool{file: f, name: name}, nil
}
func (g *doskaFileTransport) admit(subject string, upload bool) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	a := &g.download
	if upload {
		a = &g.upload
	}
	if g.closed || a.active >= 2 || a.subjects[subject] || upload && g.reserved+doskaFileLimit > doskaSpoolBudget {
		return false
	}
	g.wg.Add(1)
	a.active++
	a.subjects[subject] = true
	if upload {
		g.reserved += doskaFileLimit
	}
	return true
}

// A failed close/unlink retains the permit AND reservation. Disk bytes can never
// silently become free budget while an orphan or open descriptor still exists.
func (g *doskaFileTransport) release(subject string, upload bool, spool *doskaSpool) {
	defer g.wg.Done()
	if spool != nil {
		ce := spool.file.Close()
		re := g.root.Remove(spool.name)
		if ce != nil || re != nil && !os.IsNotExist(re) {
			return
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	a := &g.download
	if upload {
		a = &g.upload
		g.reserved -= doskaFileLimit
	}
	a.active--
	delete(a.subjects, subject)
}

var errDoskaFileSessionExpired = errors.New("Doska file session revoked")

func doskaFileIdentityProblem(w http.ResponseWriter, err error) {
	if errors.Is(err, errDoskaFileSessionExpired) {
		problem(w, 401, "session_expired", "Сессия завершена")
		return
	}
	doskaGatewayIdentityProblem(w, err)
}

func (g *doskaGateway) fileSession(ctx context.Context, r *http.Request, previous session) (session, error) {
	latest, e := g.server.readSession(r.Clone(ctx))
	if e != nil || latest.User.ID != previous.User.ID || latest.CSRF != previous.CSRF {
		return session{}, errDoskaFileSessionExpired
	}
	if _, e = g.identity(ctx, latest.User.ID, time.Now()); e != nil {
		return session{}, e
	}
	return latest, nil
}

func (g *doskaGateway) serveFile(w http.ResponseWriter, r *http.Request, sess session, p organization.Projection, kind string) {
	upload := kind == "upload"
	if len(r.Header.Values("Content-Type")) > 1 || len(r.Header.Values("Content-Encoding")) > 1 || len(r.Header.Values("Range")) > 0 || len(r.Header.Values("Upgrade")) > 0 {
		problem(w, 400, "gateway_headers", "Некорректные заголовки передачи")
		return
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		problem(w, 415, "gateway_encoding", "Кодирование запроса не поддерживается")
		return
	}
	derived := gatewayServiceCSRF(sess.CSRF, "doska")
	if upload {
		if r.Header.Get("Content-Type") != "application/octet-stream" {
			problem(w, 415, "gateway_content_type", "Ожидается application/octet-stream")
			return
		}
		if r.ContentLength > doskaFileLimit {
			problem(w, 413, "gateway_body_limit", "Файл слишком большой")
			return
		}
		if !g.server.gatewayOrigin(r) || !gatewayCSRF(r, nil, sess.CSRF, derived) {
			problem(w, 403, "csrf", "Запрос не прошёл проверку сессии")
			return
		}
	} else if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
		problem(w, 400, "gateway_body", "Тело запроса не поддерживается")
		return
	}
	idem, e := gatewayIdempotency(r, nil, "doska")
	if e != nil {
		problem(w, 400, "gateway_idempotency", "Некорректный ключ операции")
		return
	}
	source := g.server.loginPeer(r)
	if net.ParseIP(source) == nil {
		problem(w, 400, "gateway_peer", "Некорректный адрес клиента")
		return
	}
	// Admission starts the one absolute browser -> spool -> backend deadline.
	deadline := time.Now().Add(g.files.timeout)
	if sess.ExpiresAt.Before(deadline) {
		deadline = sess.ExpiresAt
	}
	if p.ValidUntil.Before(deadline) {
		deadline = p.ValidUntil
	}
	if !g.files.admit(sess.User.ID, upload) {
		problem(w, 429, "gateway_transfer_busy", "Лимит передач Doska занят")
		return
	}
	var spool *doskaSpool
	defer func() { g.files.release(sess.User.ID, upload, spool) }()
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	stopLifecycle := context.AfterFunc(g.files.lifecycle, cancel)
	defer stopLifecycle()
	controller := http.NewResponseController(w)
	// Override the server's general 15s ReadTimeout only for this admitted route.
	// SetReadDeadline interrupts net/http's blocked body read on cancellation.
	_ = controller.SetReadDeadline(deadline)
	_ = controller.SetWriteDeadline(deadline)
	stop := context.AfterFunc(ctx, func() {
		_ = controller.SetReadDeadline(time.Now())
		_ = controller.SetWriteDeadline(time.Now())
		_ = r.Body.Close()
	})
	defer stop()
	out := r.Clone(ctx)
	out.Header = make(http.Header)
	out.GetBody = nil
	out.Header.Set("Accept-Encoding", "identity")
	if upload {
		spool, e = g.files.create()
		if e != nil {
			problem(w, 503, "gateway_spool", "Временное хранилище недоступно")
			return
		}
		h := sha256.New()
		n, e := io.CopyBuffer(io.MultiWriter(spool.file, h), io.LimitReader(r.Body, doskaFileLimit), make([]byte, 64<<10))
		if e != nil || ctx.Err() != nil {
			problem(w, 408, "gateway_transfer_timeout", "Передача прервана")
			return
		}
		var extra [1]byte
		more, re := r.Body.Read(extra[:])
		if more != 0 {
			problem(w, 413, "gateway_body_limit", "Файл слишком большой")
			return
		}
		if re != io.EOF {
			problem(w, 400, "gateway_body", "Не удалось получить файл")
			return
		}
		spool.size = n
		copy(spool.digest[:], h.Sum(nil))
		spool.complete = true
		if _, e = spool.file.Seek(0, io.SeekStart); e != nil {
			problem(w, 503, "gateway_spool", "Временное хранилище недоступно")
			return
		}
		out.Body = io.NopCloser(spool.file)
		out.ContentLength = n
		out.Header.Set("Content-Type", "application/octet-stream")
		out.Header.Set("X-CSRF-Token", derived)
		out.Header.Set("Origin", g.server.Config.PublicURL)
	} else {
		out.Body = nil
		out.ContentLength = 0
	}
	if idem != "" {
		out.Header.Set("Idempotency-Key", idem)
	}
	latest, e := g.fileSession(ctx, r, sess)
	if e != nil {
		doskaFileIdentityProblem(w, e)
		return
	}
	public, _ := url.Parse(g.server.Config.PublicURL)
	out.Host = public.Host
	out.Header.Set("X-Forwarded-Host", public.Host)
	out.Header.Set("X-Forwarded-Proto", public.Scheme)
	out.Header.Set("X-Forwarded-Prefix", "/doska")
	out.Header.Set("X-Forwarded-For", source)
	if upload {
		e = signDoskaUpload(out, spool, latest, g.config.Key, time.Now(), source)
	} else {
		e = signDoskaRequest(out, nil, latest, doskaRouteRead, g.config.Key, time.Now(), false, source)
	}
	if e != nil {
		problem(w, 400, "gateway_identity", "Некорректный запрос Doska")
		return
	}
	out.URL.Path = strings.TrimPrefix(out.URL.Path, "/doska")
	out.URL.Scheme = g.apiUpstream.Scheme
	out.URL.Host = g.apiUpstream.Host
	out.RequestURI = ""
	// GetBody=nil and a non-rewindable raw body prohibit transport PUT retries,
	// including requests with an Idempotency-Key. There is exactly one RoundTrip.
	response, e := g.transport.RoundTrip(out)
	if e != nil {
		problem(w, 502, "gateway_source", "Doska не ответила. Проверьте результат перед повтором")
		return
	}
	defer response.Body.Close()
	if upload || response.StatusCode != http.StatusOK {
		g.fileJSONResponse(w, r, ctx, sess, response)
		return
	}
	if len(response.Header.Values("Content-Encoding")) > 1 || response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" || response.Uncompressed || response.ContentLength < 0 || response.ContentLength > doskaFileLimit || len(response.Header.Values("Content-Range")) > 0 {
		problem(w, 502, "gateway_response", "Неподдерживаемый ответ файла")
		return
	}
	disposition, params, e := mime.ParseMediaType(response.Header.Get("Content-Disposition"))
	filename := params["filename"]
	if len(response.Header.Values("Content-Disposition")) != 1 || e != nil || disposition != "attachment" || filename == "" || !gatewayString(filename, 512, false) {
		problem(w, 502, "gateway_response", "Некорректное имя файла")
		return
	}
	filename = filepath.Base(strings.ReplaceAll(filename, "\\", "/"))
	if filename == "." || filename == "/" {
		filename = "attachment"
	}
	if _, e = g.fileSession(ctx, r, sess); e != nil {
		doskaFileIdentityProblem(w, e)
		return
	}
	// Success leases are measured from completion of a positive check. A hung or
	// failed database check cannot extend the previous lease.
	leaseExpires := time.Now().Add(g.files.lease)
	leaseCtx, leaseCancel := context.WithCancel(ctx)
	defer leaseCancel()
	done := make(chan struct{})
	go func() { defer close(done); g.watchFileSession(leaseCtx, leaseCancel, r, sess, leaseExpires) }()
	stopBody := context.AfterFunc(leaseCtx, func() { _ = controller.SetWriteDeadline(time.Now()); _ = response.Body.Close() })
	defer func() {
		// A successful body can still be buffered by net/http. Disarm the abort
		// hook before stopping the lease watcher, so cleanup cannot expire the
		// downstream write deadline before the server flushes that response.
		stopBody()
		leaseCancel()
		<-done
	}()
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	// Set Content-Length from parsed expected length, never an unchecked duplicate.
	w.Header().Set("Content-Length", strconv.FormatInt(response.ContentLength, 10))
	w.WriteHeader(http.StatusOK)
	n, e := io.CopyBuffer(w, io.LimitReader(response.Body, response.ContentLength), make([]byte, 64<<10))
	if e != nil || n != response.ContentLength || leaseCtx.Err() != nil {
		panic(http.ErrAbortHandler)
	}
	var extra [1]byte
	more, re := response.Body.Read(extra[:])
	if more != 0 || re != io.EOF || leaseCtx.Err() != nil {
		panic(http.ErrAbortHandler)
	}
}

func (g *doskaGateway) watchFileSession(ctx context.Context, cancel context.CancelFunc, r *http.Request, sess session, expires time.Time) {
	for {
		timer := time.NewTimer(g.files.lease / 2)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		checkCtx, checkCancel := context.WithDeadline(ctx, expires)
		result := make(chan error, 1)
		go func() { _, e := g.fileSession(checkCtx, r, sess); result <- e }()
		expiry := time.NewTimer(time.Until(expires))
		select {
		case <-ctx.Done():
			expiry.Stop()
			checkCancel()
			return
		case <-expiry.C:
			checkCancel()
			cancel()
			return
		case e := <-result:
			expiry.Stop()
			checkCancel()
			if e != nil || !time.Now().Before(expires) {
				cancel()
				return
			}
			expires = time.Now().Add(g.files.lease)
		}
	}
}

func (g *doskaGateway) fileJSONResponse(w http.ResponseWriter, r *http.Request, ctx context.Context, sess session, response *http.Response) {
	if response.StatusCode == 101 || response.StatusCode >= 300 && response.StatusCode < 400 {
		problem(w, 502, "gateway_response", "Неподдерживаемый ответ Doska")
		return
	}
	g.filterResponse(response, false)
	data, e := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
	if e != nil || len(data) > 16<<20 || ctx.Err() != nil {
		problem(w, 502, "gateway_response", "Не удалось получить ответ Doska")
		return
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != 204 && media != "application/json" && !strings.HasSuffix(media, "+json") {
		problem(w, 502, "gateway_response_type", "Неподдерживаемый ответ API")
		return
	}
	if _, e = g.fileSession(ctx, r, sess); e != nil {
		doskaFileIdentityProblem(w, e)
		return
	}
	for name, values := range response.Header {
		for _, v := range values {
			w.Header().Add(name, v)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(data)
}
