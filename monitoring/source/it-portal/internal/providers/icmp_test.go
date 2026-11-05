package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

func TestICMPPinnedTargetAndCompleteOutput(t *testing.T) {
	for _, target := range []string{"--flood", "https://host/", "host:80", "10.1.2.3;id", "10.1.2.3/24", "::1"} {
		if ValidateICMPTarget(target) == nil {
			t.Fatal(target)
		}
	}
	directory, err := os.MkdirTemp("/tmp", "icmp-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	path := filepath.Join(directory, "probe.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	output := strings.Builder{}
	for n := 0; n < 2000; n++ {
		fmt.Fprintf(&output, "icmp_seq=%d rtt=0.5 ms\n", n)
	}
	var calls atomic.Int32
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		var payload map[string]string
		if request.Method != "POST" || request.URL.Path != "/v1/icmp" || json.NewDecoder(request.Body).Decode(&payload) != nil || len(payload) != 1 || payload["target"] != "10.20.30.40" {
			t.Error("invalid helper request")
			w.WriteHeader(400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"kind": "icmp", "count": 2000, "interval_us": 2000, "transmitted": 2000, "received": 2000, "loss_percent": 0, "raw_output": output.String(), "scanned_address": payload["target"]})
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	g, err := netguard.NewWithDependencies([]string{"10.20.30.40/32"}, []int{443}, "", &iperfResolver{ips: []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}}, (&net.Dialer{}).DialContext)
	if err != nil {
		t.Fatal(err)
	}
	registry := New(g, "")
	registry.SetICMPExecutor("unix://" + path)
	registry.SetICMPGuard(g)
	out, err := registry.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "icmp", "target": "test.example"}}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out["target"] != "test.example" || out["raw_output"] != output.String() || calls.Load() != 1 {
		t.Fatal("output or target changed")
	}
	registry.EnablePublicWebChecks()
	_, err = registry.icmpCheck(context.Background(), "8.8.8.8")
	if !errors.Is(err, ErrPolicyDenied) || calls.Load() != 1 {
		t.Fatalf("public-web policy escaped into raw ICMP: %v", err)
	}
}
