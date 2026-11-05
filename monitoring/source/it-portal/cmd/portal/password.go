package main

import (
	"bytes"
	"errors"
	"io"
	"unicode/utf8"

	"pl/portal/internal/server"
)

// Commands run before the HTTP server starts. Password hashing does not access
// configuration or a database and accepts passwords only on stdin.
func runCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) == 1 && args[0] == "verify-connector-credentials" {
		return verifyConnectorCredentialsFromEnvironment()
	}
	if len(args) != 1 || args[0] != "hash-password" {
		return errors.New("usage: portal hash-password (password on stdin)")
	}
	password, err := io.ReadAll(io.LimitReader(input, 1027))
	defer clear(password)
	if err != nil {
		return errors.New("cannot read password from stdin")
	}
	password = bytes.TrimSuffix(password, []byte("\n"))
	password = bytes.TrimSuffix(password, []byte("\r"))
	if len(password) < 1 || len(password) > 1024 || !utf8.Valid(password) || bytes.ContainsAny(password, "\r\n\x00") {
		return errors.New("password must be one UTF-8 line of 1..1024 bytes")
	}
	encoded, err := server.GenerateLocalAdminPasswordHash(password)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(output, encoded+"\n"); err != nil {
		return errors.New("cannot write password hash")
	}
	return nil
}
