package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"pl/portal/internal/executor"
	"syscall"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func main() {
	if e := run(); e != nil {
		log.Fatal(e)
	}
}
func run() error {
	socket := env("PORTAL_EXECUTOR_SOCKET", "/run/portal-executor/executor.sock")
	x, e := executor.Open(env("PORTAL_EXECUTOR_JOURNAL", "/var/lib/portal-executor/journal.json"), env("PORTAL_EXECUTOR_ALLOWLIST", "/etc/portal-executor/allowlist.json"), env("PORTAL_EXECUTOR_DOCKER_SOCKET", "/var/run/docker.sock"))
	if e != nil {
		return e
	}
	defer x.Close()
	if !filepath.IsAbs(socket) {
		return errors.New("socket path must be absolute")
	}
	if e = os.MkdirAll(filepath.Dir(socket), 0750); e != nil {
		return e
	}
	if os.Geteuid() == 0 {
		if e = os.Chown(filepath.Dir(socket), -1, 10001); e != nil {
			return e
		}
	}
	if st, e := os.Lstat(socket); e == nil {
		if st.Mode()&os.ModeSocket == 0 {
			return errors.New("refusing to replace non-socket path")
		}
		conn, e := net.DialTimeout("unix", socket, time.Second)
		if e == nil {
			conn.Close()
			return errors.New("executor socket already active")
		}
		if e = os.Remove(socket); e != nil {
			return e
		}
	}
	l, e := net.Listen("unix", socket)
	if e != nil {
		return e
	}
	defer l.Close()
	defer os.Remove(socket)
	if e = os.Chmod(socket, 0660); e != nil {
		return e
	}
	if os.Geteuid() == 0 {
		if e = os.Chown(socket, -1, 10001); e != nil {
			return e
		}
	}
	server := &http.Server{Handler: x.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 70 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 65*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Print("restricted executor listening on Unix socket")
	e = server.Serve(l)
	if errors.Is(e, http.ErrServerClosed) {
		<-shutdownDone
		return nil
	}
	return e
}
