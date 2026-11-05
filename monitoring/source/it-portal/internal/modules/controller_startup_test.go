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
		{"netmap", "install", 0, 22 * time.Minute},
		{"netmap", "enable", 0, 22 * time.Minute},
		{"netmap", "refresh", 0, 310 * time.Second},
		{"prometheus", "install", 0, 310 * time.Second},
		{"netmap", "install", 2 * time.Second, 2 * time.Second},
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
	ctx, cancel := context.WithCancel(context.Background())
	client := &http.Client{Timeout: 310 * time.Second, Transport: startupDeadlineTransport(func(r *http.Request) (*http.Response, error) {
		cancel()
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	_, err := (&HostController{client: client, key: make([]byte, 32)}).Apply(ctx, Operation{OperationID: "startup", ModuleID: "netmap", Action: "install"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}
