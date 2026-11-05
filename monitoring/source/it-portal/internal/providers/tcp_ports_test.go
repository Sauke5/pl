package providers

import (
	"context"
	"errors"
	"net"
	"strconv"
	"testing"
)

func TestNativePortCheckObservesOpenClosedWithoutScanner(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	closed, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, closedText, _ := net.SplitHostPort(closed.Addr().String())
	closedPort, _ := strconv.Atoi(closedText)
	closed.Close()
	_, openText, _ := net.SplitHostPort(listener.Addr().String())
	openPort, _ := strconv.Atoi(openText)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			conn.Close()
		}
	}()
	results, err := connectPortResults(context.Background(), net.ParseIP("127.0.0.1"), []int{openPort, closedPort})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || results[0].State != "open" || results[0].Port != openPort || results[1].State != "closed" || results[1].Reason != "conn-refused" {
		t.Fatal(results)
	}
	if results[0].Service != "" {
		t.Fatal("service fingerprint fabricated")
	}
}
func TestNativePortCheckHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := connectPortResults(ctx, net.ParseIP("127.0.0.1"), []int{1, 2, 3, 4, 5})
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
