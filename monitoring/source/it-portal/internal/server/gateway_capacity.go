package server

import (
	"context"
	"time"
)

type gatewayCapacity struct {
	slots        chan struct{}
	pending      chan struct{}
	queueTimeout time.Duration
}

// acquire bounds active requests and waiters; cancellation never reaches upstream.
func (g *gatewayCapacity) acquire(ctx context.Context) bool {
	if ctx.Err() != nil {
		return false
	}
	select {
	case g.slots <- struct{}{}:
		if ctx.Err() != nil {
			<-g.slots
			return false
		}
		return true
	default:
	}
	select {
	case g.pending <- struct{}{}:
	default:
		return false
	}
	defer func() { <-g.pending }()
	wait, cancel := context.WithTimeout(ctx, g.queueTimeout)
	defer cancel()
	select {
	case g.slots <- struct{}{}:
		if wait.Err() != nil {
			<-g.slots
			return false
		}
		return true
	case <-wait.Done():
		return false
	}
}

// newGatewayStaticCapacity reserves a bounded browser asset fan-out.
func newGatewayStaticCapacity() *gatewayCapacity {
	return &gatewayCapacity{slots: make(chan struct{}, 8), pending: make(chan struct{}, 32), queueTimeout: 5 * time.Second}
}

// acquireGatewayCapacity also serves Doska's existing four-active, sixteen-waiter lane.
func acquireGatewayCapacity(ctx context.Context, slots, pending chan struct{}, timeout time.Duration) bool {
	return (&gatewayCapacity{slots: slots, pending: pending, queueTimeout: timeout}).acquire(ctx)
}

// Reads queue behind the existing operation slots; writes keep their admission policy.
func newGatewayReadCapacity(slots chan struct{}) *gatewayCapacity {
	return &gatewayCapacity{slots: slots, pending: make(chan struct{}, 16), queueTimeout: 5 * time.Second}
}
