package server

import (
	"context"
	"testing"
	"time"
)

func TestGatewayReadCapacitySharesOperationSlotsAndBoundsWaiters(t *testing.T) {
	slots := make(chan struct{}, 4)
	reads := newGatewayReadCapacity(slots)
	if reads.slots != slots || cap(reads.pending) != 16 || reads.queueTimeout != 5*time.Second {
		t.Fatal("read budget changed")
	}
	for i := 0; i < 4; i++ {
		slots <- struct{}{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan bool, 16)
	for i := 0; i < 16; i++ {
		go func() { done <- reads.acquire(ctx) }()
	}
	waitServicePending(t, reads, 16)
	if reads.acquire(context.Background()) {
		t.Fatal("read queue overflow admitted")
	}
	cancel()
	for i := 0; i < 16; i++ {
		select {
		case ok := <-done:
			if ok {
				t.Fatal("cancelled read admitted")
			}
		case <-time.After(time.Second):
			t.Fatal("cancelled read blocked")
		}
	}
	if len(slots) != 4 || len(reads.pending) != 0 {
		t.Fatal("read cancellation leaked shared capacity")
	}
	reads.queueTimeout = 10 * time.Millisecond
	if reads.acquire(context.Background()) || len(slots) != 4 || len(reads.pending) != 0 {
		t.Fatal("read timeout leaked shared capacity")
	}
}
