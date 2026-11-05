package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/netguard"
	"pl/portal/internal/providers"
	"pl/portal/internal/server"
	"pl/portal/internal/store"
	"pl/portal/internal/worker"
)

func main() {
	if len(os.Args) > 1 {
		if e := runCommand(os.Args[1:], os.Stdin, os.Stdout); e != nil {
			_, _ = os.Stderr.WriteString(e.Error() + "\n")
			os.Exit(1)
		}
		return
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if e := run(); e != nil {
		slog.Error("portal_stopped", "error", e.Error())
		os.Exit(1)
	}
}
func run() error {
	c, e := server.LoadConfig()
	if e != nil {
		return e
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	db, e := store.Open(startup, c.DatabaseURL)
	if e != nil {
		return errors.New("database initialization failed")
	}
	defer db.Pool.Close()
	if e = db.Defaults(startup); e != nil {
		return e
	}
	if c.Demo {
		if e = db.SeedDemo(startup); e != nil {
			return e
		}
	}
	if e = db.ReconcileModules(startup); e != nil {
		return errors.New("module integration reconciliation failed")
	}
	guard, e := netguard.New(c.CIDRs, c.Ports, c.OutboundCAFile)
	if e != nil {
		return e
	}
	checkGuard, e := netguard.New(c.CheckCIDRs, c.CheckPorts, c.OutboundCAFile)
	if e != nil {
		return e
	}
	registry := providers.New(guard, c.ExecutorURL)
	registry.SetCheckGuard(checkGuard)
	if c.PublicWebChecks {
		registry.EnablePublicWebChecks()
	}
	registry.EnableInteractiveChecks()
	app := server.New(db, c, registry, guard.Client(15*time.Second))
	controller, e := modules.NewHostController(os.Getenv("PORTAL_MODULE_SOCKET"), os.Getenv("PORTAL_MODULE_KEY_FILE"))
	if e != nil {
		return e
	}
	manager := modules.New(db, nil)
	manager.DeliveryEnabled = c.OnDemandModules
	manager.PublicURL = c.PublicURL
	manager.BookStack = modules.NewBookStackConnector(guard)
	if controller != nil {
		manager.Controller = controller
	}
	registry.ManagedRead = manager.ReadIntegration
	registry.ManagedHealth = manager.ManagedHealth
	manager.Poll = registry.Poll
	manager.Auditor = modules.NewAuditorConnector(guard, func(_ context.Context, integration model.Integration) ([]byte, error) {
		return providers.ResolveGatewayKey(integration.SecretRef)
	})
	registry.ManagedRequest = manager.ProviderRequest
	registry.FileAuditorProbe = func(ctx context.Context, integration model.Integration) error {
		_, err := manager.Auditor.Probe(ctx, integration)
		return err
	}
	app.Modules = manager
	if e = app.InitConnectorCredentials(os.Getenv("PORTAL_CONNECTOR_KEY_FILE"), guard); e != nil {
		return e
	}
	if e = app.InitSFTPAdmin(); e != nil {
		return errors.New("SFTP administration initialization failed")
	}
	if e = app.InitForms(); e != nil {
		return errors.New("Forms initialization failed")
	}
	if e = app.InitDoska(); e != nil {
		return errors.New("Doska initialization failed")
	}
	doskaDone := make(chan struct{})
	go func() { defer close(doskaDone); app.RunDoska(ctx) }()
	sftpDone := make(chan struct{})
	go func() {
		defer close(sftpDone)
		if !c.PortableRelease {
			app.RunSFTP(ctx)
		}
	}()
	jobs := worker.New(db, registry, app.Hub.Notify)
	jobs.Modules = manager
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); jobs.Run(ctx) }()
	httpServer := &http.Server{Addr: c.Addr, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("portal_started", "address", c.Addr, "demo", c.Demo)
		errCh <- httpServer.ListenAndServe()
	}()
	select {
	case e = <-errCh:
		stop()
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}
	<-workerDone
	<-sftpDone
	<-doskaDone
	if e != nil && !errors.Is(e, http.ErrServerClosed) {
		return e
	}
	return nil
}
