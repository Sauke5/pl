package modules

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type startupDeadlineTransport func(*http.Request) (*http.Response, error)

func (f startupDeadlineTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestControllerStartupBudgetIsPerCallAndPreservesEarlierDeadline(t *testing.T) {
	for _, tc := range []struct {
		module, action string
		parent, want   time.Duration
	}{
		{"netmap", "install", 0, 72 * time.Minute},
		{"netmap", "enable", 0, 72 * time.Minute},
		{"grafana", "install", 0, 55*time.Minute + 10*time.Second},
		{"grafana", "enable", 0, 55*time.Minute + 10*time.Second},
		{"netmap", "refresh", 0, 310 * time.Second},
		{"grafana", "refresh", 0, 310 * time.Second},
		{"grafana", "configure", 0, 310 * time.Second},
		{"unknown", "install", 0, 310 * time.Second},
		{"prometheus", "install", 0, 55*time.Minute + 10*time.Second},
		{"netmap", "install", 2 * time.Second, 2 * time.Second},
		{"grafana", "install", 2 * time.Second, 2 * time.Second},
	} {
		t.Run(tc.module+"/"+tc.action+"/"+tc.parent.String(), func(t *testing.T) {
			ctx := context.Background()
			if tc.parent > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, tc.parent)
				defer cancel()
			}
			client := &http.Client{Timeout: 310 * time.Second, Transport: startupDeadlineTransport(func(r *http.Request) (*http.Response, error) {
				deadline, ok := r.Context().Deadline()
				remaining := time.Until(deadline)
				if !ok || remaining > tc.want || remaining < tc.want-time.Second {
					t.Fatalf("unexpected deadline: %v, present=%v, want %v", remaining, ok, tc.want)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"state":"running","operation_id":"startup"}`))}, nil
			})}
			controller := &HostController{client: client, key: make([]byte, 32)}
			_, err := controller.Apply(ctx, Operation{OperationID: "startup", ModuleID: tc.module, Action: tc.action})
			if err != nil {
				t.Fatal(err)
			}
			if client.Timeout != 310*time.Second {
				t.Fatal("shared client timeout changed")
			}
		})
	}
}

func TestControllerStartupHonorsCallerCancellation(t *testing.T) {
	for _, module := range []string{"netmap", "grafana", "prometheus"} {
		t.Run(module, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			client := &http.Client{Timeout: 310 * time.Second, Transport: startupDeadlineTransport(func(r *http.Request) (*http.Response, error) {
				cancel()
				<-r.Context().Done()
				return nil, r.Context().Err()
			})}
			_, err := (&HostController{client: client, key: make([]byte, 32)}).Apply(ctx, Operation{OperationID: "startup", ModuleID: module, Action: "install"})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
		})
	}
}

func TestControllerColdDeliveryCanOutliveNormalRPCButRefreshStaysShort(t *testing.T) {
	client := controllerFixture(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(30 * time.Millisecond)
		io.WriteString(w, `{"state":"running","operation_id":"cold-delivery"}`)
	})
	client.client.Timeout = 5 * time.Millisecond
	op := Operation{OperationID: "cold-delivery", ModuleID: "grafana", Action: "install"}
	if result, err := client.Apply(context.Background(), op); err != nil || result.State != "running" {
		t.Fatalf("cold delivery expired at the normal RPC budget: %+v %v", result, err)
	}
	if client.client.Timeout != 5*time.Millisecond {
		t.Fatal("startup changed the shared client's normal timeout")
	}
	op.Action = "refresh"
	if _, err := client.Apply(context.Background(), op); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("refresh inherited the cold delivery budget: %v", err)
	}
}
