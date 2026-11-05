package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"wayline.local/backend/internal/probes"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	token, err := probes.ReadRunnerToken(os.Getenv("WAYLINE_RUNNER_TOKEN_FILE"))
	if err != nil || (os.Getenv("WAYLINE_DEPLOYMENT_MODE") == "platform" && token == "") {
		logger.Error("не настроен токен runner")
		os.Exit(1)
	}
	concurrency := 4
	if value := os.Getenv("WAYLINE_RUNNER_CONCURRENCY"); value != "" {
		concurrency, err = strconv.Atoi(value)
		if err != nil || concurrency < 1 || concurrency > 16 {
			logger.Error("параллельность runner должна быть от 1 до 16")
			os.Exit(1)
		}
	}
	address := os.Getenv("WAYLINE_RUNNER_ADDR")
	if address == "" {
		address = ":8081"
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	server := &http.Server{BaseContext: func(net.Listener) context.Context { return ctx }, Addr: address, Handler: probes.RunnerHandler(probes.NewExecutor(nil, nil), token, concurrency), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 190 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		cancelCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(cancelCtx)
	}()
	logger.Info("wayline runner started", "address", address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("runner остановлен")
		os.Exit(1)
	}
}
