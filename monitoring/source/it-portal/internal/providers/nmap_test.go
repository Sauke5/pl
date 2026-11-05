package providers

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"pl/portal/internal/netguard"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNmapTargetValidation(t *testing.T) {
	for _, target := range []string{"", "host", "host:0", "host:65536", "host:80-90", "host:80,--script", "host:80;id", "-iL:80", "host/name:80", "host:$(id)", "[fe80::1%eth0]:80", "host:80,", "host:1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17"} {
		if _, _, e := parseNmapTarget(target); e == nil {
			t.Errorf("accepted %q", target)
		}
	}
	h, p, e := parseNmapTarget("[2001:4860::8888]:443,80,443")
	if e != nil || h != "2001:4860::8888" || !reflect.DeepEqual(p, []int{80, 443}) {
		t.Fatal(h, p, e)
	}
}

const nmapFixture = `<?xml version="1.0"?><!DOCTYPE nmaprun><nmaprun><host><address addr="8.8.8.8" addrtype="ipv4"/><ports><extraports state="closed" count="1"><extrareasons reason="conn-refused" count="1"/></extraports><port protocol="tcp" portid="443"><state state="open" reason="syn-ack"/><service name="https"/></port></ports></host><runstats><finished exit="success"/></runstats></nmaprun>`

func TestNmapParseResults(t *testing.T) {
	out, e := parseNmapOutput([]byte(nmapFixture), net.ParseIP("8.8.8.8"), []int{80, 443})
	if e != nil || len(out) != 2 || out[0].State != "closed" || out[1].Service != "https" {
		t.Fatal(out, e)
	}
	for _, data := range []string{strings.ReplaceAll(nmapFixture, "success", "error"), strings.ReplaceAll(nmapFixture, "8.8.8.8", "1.1.1.1"), "<nmaprun>"} {
		if _, e := parseNmapOutput([]byte(data), net.ParseIP("8.8.8.8"), []int{443}); e == nil {
			t.Fatal("invalid XML accepted")
		}
	}
	out, e = parseNmapOutput([]byte(nmapFixture), net.ParseIP("8.8.8.8"), []int{80, 81, 443})
	if e != nil || out[0].State != "unknown" || out[1].State != "unknown" {
		t.Fatal("aggregate guessed", out, e)
	}
}
func TestNmapRunnerAndPolicy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "scanner")
	argsPath := filepath.Join(dir, "args")
	t.Setenv("NMAP_TEST_ARGS", argsPath)
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NMAP_TEST_ARGS\"\ncat <<'XML'\n" + nmapFixture + "\nXML\n"
	if e := os.WriteFile(path, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("PORTAL_NMAP_PATH", path)
	g, e := netguard.NewWithDependencies(nil, []int{443}, "", quickResolver{}, func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("unexpected dial") })
	if e != nil {
		t.Fatal(e)
	}
	r := New(g, "")
	r.EnablePublicWebChecks()
	out, e := r.nmapCheck(context.Background(), "public.example:443,80")
	if e != nil || out["scanned_address"] != "8.8.8.8" {
		t.Fatal(out, e)
	}
	args, _ := os.ReadFile(argsPath)
	expected := []string{"-sT", "-Pn", "-n", "--max-retries", "1", "--host-timeout", "20s", "--reason", "-p", "80,443", "-oX", "-", "8.8.8.8"}
	if !reflect.DeepEqual(strings.Split(strings.TrimSpace(string(args)), "\n"), expected) {
		t.Fatal(string(args))
	}
	if _, e = r.nmapCheck(context.Background(), "public.example:22"); !errors.Is(e, netguard.ErrPolicyDenied) {
		t.Fatal("policy bypass", e)
	}
	if _, e = r.nmapCheck(context.Background(), "169.254.169.254:80"); !errors.Is(e, netguard.ErrPolicyDenied) {
		t.Fatal("metadata bypass", e)
	}
}
func TestNmapRunnerBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scanner")
	if e := os.WriteFile(path, []byte("#!/bin/sh\nexec sleep 5\n"), 0700); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, e := runNmap(ctx, path, nil); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	var b nmapLimitedBuffer
	if _, e := b.Write(make([]byte, nmapOutputLimit+1)); e == nil || !b.exceeded || b.Len() > nmapOutputLimit {
		t.Fatal("unbounded output")
	}
}
