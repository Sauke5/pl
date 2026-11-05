package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestHashPasswordCommand(t *testing.T) {
	var output bytes.Buffer
	if err := runCommand([]string{"hash-password"}, strings.NewReader("fixture password\n"), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(output.String(), "$argon2id$v=19$m=65536,t=3,p=1$") || strings.Count(output.String(), "\n") != 1 {
		t.Fatal("command must emit only one PHC line")
	}
	if strings.Contains(output.String(), "fixture password") {
		t.Fatal("password leaked into output")
	}
}

func TestHashPasswordCommandRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{"", "\n", "first\nsecond", "nul\x00byte", strings.Repeat("x", 1025), "\xff"} {
		var output bytes.Buffer
		err := runCommand([]string{"hash-password"}, strings.NewReader(input), &output)
		if err == nil || output.Len() != 0 || strings.Contains(err.Error(), "$argon2id$") {
			t.Fatal("invalid input must fail without PHC output")
		}
	}
	for _, args := range [][]string{{}, {"unknown"}, {"hash-password", "argv-fixture-secret"}} {
		var output bytes.Buffer
		err := runCommand(args, strings.NewReader("fixture"), &output)
		if err == nil || output.Len() != 0 || strings.Contains(err.Error(), "argv-fixture-secret") {
			t.Fatal("arguments must not become password input or error output")
		}
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("fixture-secret") }

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("fixture-secret") }

func TestHashPasswordCommandErrorsDoNotExposeIOErrors(t *testing.T) {
	for _, readFailure := range []bool{true, false} {
		var err error
		if readFailure {
			err = runCommand([]string{"hash-password"}, failingReader{}, &bytes.Buffer{})
		} else {
			err = runCommand([]string{"hash-password"}, strings.NewReader("fixture"), failingWriter{})
		}
		if err == nil || strings.Contains(err.Error(), "fixture-secret") || strings.Contains(err.Error(), "$argon2id$") {
			t.Fatal("I/O errors must be generic")
		}
	}
}
