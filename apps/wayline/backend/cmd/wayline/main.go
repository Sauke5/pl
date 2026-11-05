package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"wayline.local/backend/internal/checks"
	"wayline.local/backend/internal/httpapi"
	"wayline.local/backend/internal/probes"
	"wayline.local/backend/internal/targets"
)

var version = "dev"

func main() {
	address := envOrDefault("WAYLINE_HTTP_ADDR", ":8080")
	databasePath := envOrDefault("WAYLINE_DB_PATH", "data/wayline.db")
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	repository, err := targets.OpenSQLite(databasePath)
	if err != nil {
		logger.Error("не удалось открыть базу Wayline", "error", err)
		os.Exit(1)
	}
	defer repository.Close()
	targetService := targets.NewService(repository)
	checkRepository := checks.NewSQLiteRepository(repository.DB())
	var executor checks.ProbeExecutor = probes.NewExecutor(nil, nil)
	runnerURL := os.Getenv("WAYLINE_RUNNER_URL")
	if runnerURL != "" {
		token, tokenErr := probes.ReadRunnerToken(os.Getenv("WAYLINE_RUNNER_TOKEN_FILE"))
		if tokenErr != nil || (os.Getenv("WAYLINE_DEPLOYMENT_MODE") == "platform" && token == "") {
			logger.Error("не настроен токен изолированного runner")
			os.Exit(1)
		}
		executor, err = probes.NewRemoteExecutor(runnerURL, token)
		if err != nil {
			logger.Error("некорректный адрес runner")
			os.Exit(1)
		}
	} else if os.Getenv("WAYLINE_DEPLOYMENT_MODE") == "platform" {
		logger.Error("для режима платформы требуется изолированный runner")
		os.Exit(1)
	}
	checkService := checks.NewService(targetService, checkRepository, checks.NewLocalDispatcher(executor))
	concurrency := envIntOrDefault("WAYLINE_CHECK_CONCURRENCY", 4)
	scheduler := checks.NewScheduler(targetService, checkRepository, checkService, logger, concurrency)
	server := &http.Server{
		Addr:              address,
		Handler:           httpapi.New(version, targetService, checkService, repository).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// Максимальная MTR-проверка занимает до 180 секунд. MVP возвращает
		// ручной результат синхронно; proxy timeout должен быть не меньше 210s.
		WriteTimeout: 210 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	schedulerDone := make(chan struct{})
	go func() { defer close(schedulerDone); scheduler.Run(ctx) }()
	defer func() {
		stop()
		<-schedulerDone
	}()

	go func() {
		<-ctx.Done()
		// Scheduler сначала отменяет active probes и успевает сохранить их
		// финальный статус, пока SQLite ещё открыт.
		<-schedulerDone
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("http shutdown failed", "error", err)
		}
	}()

	logger.Info("wayline API started", "address", address, "version", version)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("wayline API stopped unexpectedly", "error", err)
		return
	}
}

func envIntOrDefault(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
