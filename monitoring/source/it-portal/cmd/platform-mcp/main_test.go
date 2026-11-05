package main

import (
	"strings"
	"testing"
)

func TestMCPEndpointMustBeExplicit(t *testing.T) {
	for _, args := range [][]string{nil, {"-token-file", "/private/token"}, {"-write"}} {
		o, err := parseOptions(args)
		if err == nil || o.base != "" || !strings.Contains(err.Error(), "-url") {
			t.Fatal("missing endpoint must fail with an actionable error and no implicit destination")
		}
	}
	o, err := parseOptions([]string{"-url", "https://platform.example:8443", "-token-file", "/private/token", "-write"})
	if err != nil || o.base != "https://platform.example:8443" || o.token != "/private/token" || !o.write {
		t.Fatal("explicit configuration was not preserved")
	}
}

func TestMCPParseErrorsDoNotEchoArguments(t *testing.T) {
	_, err := parseOptions([]string{"-unknown", "fixture-private-value"})
	if err == nil || strings.Contains(err.Error(), "fixture-private-value") {
		t.Fatal("invalid flag diagnostics must not expose arbitrary argument values")
	}
}
