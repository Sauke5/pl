package providers

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
)

const iperfFixture = `{"start":{"test_start":{"protocol":"TCP"}},"end":{"sum_received":{"seconds":5.02,"bytes":62500000,"bits_per_second":100000000}}}`

func TestIperfOptions(t *testing.T) {
	for _, target := range []string{"host", "host:0", "host:65536", "host:5201,5201", "host:5201-5205", "-x:5201", "10.0.0.0/24:5201", "host;id:5201", "[fe80::1%eth0]:5201"} {
		if ValidateIperfParameters(target, nil) == nil {
			t.Errorf("accepted %q", target)
		}
	}
	for _, params := range []map[string]any{{"direction": "both"}, {"direction": false}, {"duration_seconds": 5.5}, {"duration_seconds": 60}, {"duration_seconds": "5"}, {"duration_seconds": nil}} {
		if ValidateIperfParameters("host:5201", params) == nil {
			t.Errorf("accepted %#v", params)
		}
	}
	for _, target := range []string{"host:80", "host:5206", "host:65201"} {
		if err := ValidateIperfParameters(target, nil); err != nil {
			t.Errorf("custom iperf port rejected %q: %v", target, err)
		}
	}
	h, p, d, s, e := iperfOptions("[fd00::1]:5205", nil)
	if e != nil || h != "fd00::1" || p != 5205 || d != "upload" || s != 10 {
		t.Fatal(h, p, d, s, e)
	}
}

func TestIperfIncompleteNeverBecomesZero(t *testing.T) {
	out, e := parseIperfOutput([]byte(iperfFixture))
	if e != nil || out.BitsPerSecond != 100000000 {
		t.Fatal(out, e)
	}
	for _, data := range []string{"{}", `{"error":"busy"}`, strings.Replace(iperfFixture, `"TCP"`, `"UDP"`, 1), strings.Replace(iperfFixture, `"bits_per_second":100000000`, `"other":0`, 1), strings.Replace(iperfFixture, `100000000`, `null`, 1), strings.Replace(iperfFixture, `100000000`, `-1`, 1), strings.Replace(iperfFixture, `5.02`, `0`, 1)} {
		if _, e := parseIperfOutput([]byte(data)); e == nil {
			t.Errorf("accepted %s", data)
		}
	}
}

type iperfResolver struct {
	ips   []net.IPAddr
	calls int
}

func (r *iperfResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	r.calls++
	return r.ips, nil
}

func TestIperfPinnedProcessAndExecuteParameters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "iperf3")
	argsPath := filepath.Join(dir, "args")
	t.Setenv("IPERF_TEST_ARGS", argsPath)
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$IPERF_TEST_ARGS\"\ncat <<'JSON'\n" + strings.Replace(iperfFixture, "5.02", "15.02", 1) + "\nJSON\n"
	if e := os.WriteFile(path, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("PORTAL_IPERF3_PATH", path)
	resolver := &iperfResolver{ips: []net.IPAddr{{IP: net.ParseIP("10.20.30.40")}}}
	guard, e := netguard.NewWithDependencies([]string{"10.20.30.40/32"}, []int{443}, "", resolver, func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("unexpected dial") })
	if e != nil {
		t.Fatal(e)
	}
	r := New(guard, "")
	r.EnablePublicWebChecks()
	out, e := r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "iperf", "target": "branch.example:5201", "direction": "download", "duration_seconds": float64(5)}}, nil, nil)
	if e != nil || out["throughput_mbps"] != float64(100) || out["origin"] != "monitoring" || out["direction"] != "download" || out["test_seconds"] != 15.02 || out["duration_seconds"] != 5 {
		t.Fatal(out, e)
	}
	args, _ := os.ReadFile(argsPath)
	expected := []string{"-c", "10.20.30.40", "-p", "5201", "-t", "5", "-J", "--connect-timeout", "3000", "-R"}
	if !reflect.DeepEqual(strings.Split(strings.TrimSpace(string(args)), "\n"), expected) || resolver.calls != 1 {
		t.Fatal(string(args), resolver.calls)
	}
	if _, e = guard.Resolve(context.Background(), "8.8.8.8"); !errors.Is(e, netguard.ErrPolicyDenied) {
		t.Fatal("base mutated", e)
	}
	if e = guard.ValidatePortIPs([]net.IP{net.ParseIP("10.20.30.40")}, 5201); !errors.Is(e, netguard.ErrPolicyDenied) {
		t.Fatal("base ports changed", e)
	}
	for _, ips := range [][]net.IPAddr{{{IP: net.ParseIP("8.8.8.8")}}, {{IP: net.ParseIP("169.254.169.254")}}, {{IP: net.ParseIP("10.20.30.40")}, {IP: net.ParseIP("8.8.8.8")}}} {
		resolver.ips = ips
		if _, e = r.iperfCheck(context.Background(), "branch.example:5201", nil); !errors.Is(e, netguard.ErrPolicyDenied) {
			t.Fatal("policy bypass", e)
		}
	}
	r.EnableInteractiveChecks()
	resolver.ips = []net.IPAddr{{IP: net.ParseIP("10.73.43.22")}}
	out, e = r.Execute(context.Background(), model.Job{Kind: "check", Parameters: map[string]any{"kind": "iperf", "target": "branch.example:65201", "direction": "download", "duration_seconds": float64(5)}}, nil, nil)
	if e != nil || out["throughput_mbps"] != float64(100) {
		t.Fatalf("manual custom-port throughput failed: %#v %v", out, e)
	}
	args, _ = os.ReadFile(argsPath)
	expected = []string{"-c", "10.73.43.22", "-p", "65201", "-t", "5", "-J", "--connect-timeout", "3000", "-R"}
	if !reflect.DeepEqual(strings.Split(strings.TrimSpace(string(args)), "\n"), expected) {
		t.Fatalf("custom-port target was not pinned: %s", args)
	}
	iperfActive.Lock()
	_, e = r.iperfCheck(context.Background(), "branch.example:5201", nil)
	iperfActive.Unlock()
	if !errors.Is(e, ErrThroughputBusy) {
		t.Fatal("parallel test allowed", e)
	}
}

func TestIperfRunnerDeadlineAndFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "iperf3")
	if e := os.WriteFile(path, []byte("#!/bin/sh\nexec sleep 5\n"), 0700); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, e := runIperf(ctx, path, nil); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte("#!/bin/sh\necho secret-error >&2\nexit 1\n"), 0700); e != nil {
		t.Fatal(e)
	}
	if _, e := runIperf(context.Background(), path, nil); e == nil || strings.Contains(e.Error(), "secret-error") {
		t.Fatal(e)
	}
}

func TestIperfErrorsRemainReadable(t *testing.T) {
	for _, err := range []error{ErrThroughputBusy, ErrThroughputUnavailable, ErrThroughputIncomplete} {
		classified := classifyEndpointError(err)
		if !errors.Is(classified, err) || CheckErrorMessage(classified) == CheckErrorMessage(ErrEndpointUnavailable) {
			t.Fatal("throughput reason lost", err)
		}
	}
}
