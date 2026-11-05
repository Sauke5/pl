package main

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"pl/portal/internal/connectorcredentials"
)

// Maintenance runs this against a staging database before replacing live data.
// It neither migrates the database nor emits record identities or credentials.
func verifyConnectorCredentialsFromEnvironment() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return verifyConnectorCredentials(ctx, os.Getenv("PORTAL_DATABASE_URL"), os.Getenv("PORTAL_CONNECTOR_KEY_FILE"))
}

func verifyConnectorCredentials(ctx context.Context, databaseURL, keyFile string) error {
	failure := errors.New("integration credential verification failed")
	info, err := os.Lstat(keyFile)
	if err != nil || !info.Mode().IsRegular() || info.Size() != 32 || info.Mode().Perm()&0007 != 0 {
		return failure
	}
	key, err := os.ReadFile(keyFile)
	if err != nil {
		return failure
	}
	codec, err := connectorcredentials.New(key)
	clear(key)
	if err != nil || databaseURL == "" {
		return failure
	}
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return failure
	}
	config.RuntimeParams["default_transaction_read_only"] = "on"
	connection, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return failure
	}
	defer connection.Close(ctx)
	rows, err := connection.Query(ctx, "SELECT integration_id,origin,envelope FROM public.integration_credentials ORDER BY integration_id")
	if err != nil {
		return failure
	}
	defer rows.Close()
	for rows.Next() {
		var id, origin string
		var envelope []byte
		if err = rows.Scan(&id, &origin, &envelope); err != nil {
			return failure
		}
		if _, err = codec.Open(id, origin, envelope); err != nil {
			return failure
		}
	}
	if rows.Err() != nil {
		return failure
	}
	return nil
}
