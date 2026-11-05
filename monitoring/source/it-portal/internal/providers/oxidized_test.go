package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func oxidizedFixture() model.Integration {
	return model.Integration{ID: "oxidized", Kind: "oxidized", URL: "http://test", TimeoutSeconds: 2, Config: map[string]string{"gitea_repository_url": "https://git.example/ops/configs"}}
}

func TestOxidizedTypedMetadataAndExactRoutes(t *testing.T) {
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_OX")
	t.Setenv("PORTAL_SECRET_OX", "test-private")
	var calls atomic.Int32
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls.Add(1)
		if q.Header.Get("Authorization") != "Bearer test-private" {
			t.Error("missing bearer auth")
		}
		switch q.URL.Path {
		case "/nodes.json":
			fmt.Fprint(w, `[{"name":"router one","group":"msk","status":"success","last":{"status":"success","end":"2026-10-26 10:00:00 UTC"},"ip":"private-ip","vars":{"password":"private-value"}}]`)
		case "/node/version.json":
			if q.URL.Query().Get("node_full") != "msk/router one" || len(q.URL.Query()) != 1 {
				t.Error("non-exact version query", q.URL)
			}
			fmt.Fprint(w, `[{"oid":"abcdefabcdefabcdefabcdefabcdefabcdefabcd","time":"2026-10-25T10:00:00Z","author":"private-author","message":"private-message","date":"private-date"}]`)
		default:
			t.Error("forbidden route", q.URL)
			http.Error(w, "unexpected", 500)
		}
	})
	i := oxidizedFixture()
	i.SecretRef = "env:PORTAL_SECRET_OX"
	snapshot, err := r.pollOxidized(context.Background(), i)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || snapshot.Configuration == nil || len(snapshot.Configuration.Nodes) != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	node := snapshot.Configuration.Nodes[0]
	if node.Key != "msk/router one" || node.CollectionStatus != "success" || node.LastChangeAt == nil || node.LastSuccessfulCollectionAt == nil || !model.ValidConfigurationRevision(node.Revision) {
		t.Fatalf("missing metadata: %+v", node)
	}
	data, _ := json.Marshal(snapshot)
	for _, private := range []string{"private-ip", "private-value", "password", "private-author", "private-message", "private-date"} {
		if strings.Contains(string(data), private) {
			t.Fatalf("private field survived: %s", private)
		}
	}
}

func TestOxidizedVersionFailureRetainsCollectionEvidence(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/nodes.json" {
			fmt.Fprint(w, `[{"name":"r1","group":"msk","status":"success","last":{"status":"success","end":"2026-10-26 10:00:00 UTC"}}]`)
			return
		}
		http.Error(w, "private upstream error", 500)
	})
	snapshot, err := r.pollOxidized(context.Background(), oxidizedFixture())
	if err != nil {
		t.Fatal(err)
	}
	node := snapshot.Configuration.Nodes[0]
	if node.CollectionStatus != "success" || node.LastSuccessfulCollectionAt == nil || node.Error == "" || node.Revision != "" || node.LastChangeAt != nil {
		t.Fatal(node)
	}
}

func TestOxidizedNilVersionMetadataIsPartialAndProbeFails(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/nodes.json" {
			fmt.Fprint(w, `[{"name":"r1","group":"msk","status":"success","last":{"status":"success","end":"2026-10-26 10:00:00 UTC"}}]`)
			return
		}
		fmt.Fprint(w, `null`)
	})
	snapshot, err := r.pollOxidized(context.Background(), oxidizedFixture())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Configuration == nil || len(snapshot.Configuration.Nodes) != 1 || snapshot.Configuration.Nodes[0].Error == "" {
		t.Fatalf("nil version metadata accepted: %+v", snapshot.Configuration)
	}
	if err = r.ProbeOxidized(context.Background(), oxidizedFixture()); err == nil {
		t.Fatal("partial node metadata passed optional probe")
	}
}

func TestOxidizedRejectsMalformedAndDuplicateNodes(t *testing.T) {
	for _, body := range []string{`null`, `{}`, `[{"group":"a","name":"r"},{"group":"a","name":"r"}]`, `[{"group":"../a","name":"r"}]`, `[{"group":"a","name":"../r"}]`, strings.Repeat("x", (1<<20)+1)} {
		t.Run(fmt.Sprint(len(body)), func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) { fmt.Fprint(w, body) })
			if _, err := r.pollOxidized(context.Background(), oxidizedFixture()); err == nil {
				t.Fatal("accepted malformed list")
			}
		})
	}
}

func TestOxidizedBoundedConcurrencyAndDeadline(t *testing.T) {
	var active, peak atomic.Int32
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.URL.Path == "/nodes.json" {
			fmt.Fprint(w, "[")
			for n := 0; n < 12; n++ {
				if n > 0 {
					fmt.Fprint(w, ",")
				}
				fmt.Fprintf(w, `{"group":"a","name":"r%d"}`, n)
			}
			fmt.Fprint(w, "]")
			return
		}
		a := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); a > old; old = peak.Load() {
			if peak.CompareAndSwap(old, a) {
				break
			}
		}
		select {
		case <-q.Context().Done():
			return
		case <-time.After(150 * time.Millisecond):
			fmt.Fprint(w, "[]")
		}
	})
	i := oxidizedFixture()
	i.Concurrency = 20
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
	defer cancel()
	start := time.Now()
	snapshot, err := r.pollOxidized(ctx, i)
	if err != nil || snapshot.Configuration == nil || peak.Load() > 4 || time.Since(start) > time.Second {
		t.Fatalf("unbounded poll: peak=%d elapsed=%s error=%v", peak.Load(), time.Since(start), err)
	}
	for _, node := range snapshot.Configuration.Nodes {
		if node.Error == "" {
			t.Fatal("deadline concealed")
		}
	}
}

func TestOxidizedSafeLinksAndBindingValidation(t *testing.T) {
	cfg := oxidizedFixture().Config
	history, diff, err := model.ConfigurationLinks(cfg, "msk/router one", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	if err != nil || history != "https://git.example/ops/configs/commits/branch/main/msk/router%20one" || !strings.HasSuffix(diff, "/commit/abcdefabcdefabcdefabcdefabcdefabcdefabcd") {
		t.Fatal(history, diff, err)
	}
	for _, bad := range []string{"https://user:secret@git.example/ops/configs", "https://git.example/ops/configs?token=x", "https://git.example/ops/%2e%2e/configs", "https://git.example/ops/configs#x"} {
		if err := model.ValidateOxidizedConfig(map[string]string{"gitea_repository_url": bad}); err == nil {
			t.Fatal("accepted unsafe repository", bad)
		}
	}
	cfg["node_bindings"] = `{"msk/router":"not-a-resource-uuid"}`
	if _, err := model.OxidizedBindings(cfg); err == nil {
		t.Fatal("invalid binding accepted")
	}
}
