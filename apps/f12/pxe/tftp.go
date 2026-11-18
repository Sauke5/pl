package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pin/tftp/v3"
	"golang.org/x/net/ipv4"
)

type firmwareFile struct {
	name string
	size int64
	hash string
}

func (s segment) firmware(root string) (map[string][]byte, error) {
	var selected []firmwareFile
	files := map[string][]byte{}
	menu := []byte("#!ipxe\nchain http://" + s.address.String() + ":18080/menu.ipxe\n")
	if s.bios {
		selected = append(selected, firmwareFile{biosFile, 67753, "6c006ea8aa474f6caa3aff894cf30913fa8fae667d4cff98d0fc1cdfa63ce2c3"})
		files["autoexec.ipxe"] = menu
	}
	if s.efi {
		selected = append(selected,
			firmwareFile{efiFile, 1048424, "5eecca2780bd49c900565e124516a1bd666ec5e012825f34991b6ba1ef2fa6cf"},
			firmwareFile{"x86_64-sb/snponly.efi", 295784, "b1e67c3e4a1e8708ddfd0079ad4505e3a02245acb55ee9a95437ab3c507be82a"})
		files["x86_64-sb/autoexec.ipxe"] = menu
	}
	for _, item := range selected {
		f, err := os.Open(filepath.Join(root, item.name))
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(f, item.size+1))
		f.Close()
		if err != nil || int64(len(data)) != item.size || fmt.Sprintf("%x", sha256.Sum256(data)) != item.hash {
			return nil, fmt.Errorf("invalid firmware file %s", item.name)
		}
		files[item.name] = data
	}
	return files, nil
}

func filename(name string) string {
	return strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "/")
}

type flight struct {
	until   time.Time
	block   uint16
	waiting bool
}

// Apply the peer/packet limits before tftp creates a transfer goroutine.
// Each RRQ gets a single endpoint, a bounded lifetime and one outstanding ACK.
type transferSocket struct {
	net.PacketConn
	s              segment
	files          map[string][]byte
	mu             sync.Mutex
	active         map[netip.AddrPort]*flight
	oob            []byte
	notFoundWindow time.Time
	notFoundCount  int
}

func readName(p []byte) string {
	if len(p) < 4 || len(p) > 512 || binary.BigEndian.Uint16(p) != 1 || p[len(p)-1] != 0 {
		return ""
	}
	parts := bytes.Split(p[2:len(p)-1], []byte{0})
	if len(parts) < 2 || len(parts)%2 != 0 || len(parts) > 18 || !bytes.EqualFold(parts[1], []byte("octet")) {
		return ""
	}
	for _, field := range parts {
		if len(field) == 0 || len(field) > 120 {
			return ""
		}
	}
	return filename(string(parts[0]))
}

// Shim looks for these optional companion files before loading signed iPXE.
// This immutable firmware set has none of them. A TFTP file-not-found reply
// lets the stock shim continue without waiting for its firmware retry timer.
func (c *transferSocket) missing(p []byte, peer netip.AddrPort, now time.Time) bool {
	if !c.s.efi || !c.s.client(peer.Addr()) || peer.Port() == 0 {
		return false
	}
	switch readName(p) {
	case "x86_64-sb/revocations_sku.efi", "x86_64-sb/revocations_sbat.efi", "x86_64-sb/shim_certificate_0.efi":
	default:
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active[peer] != nil {
		return false
	}
	if now.Sub(c.notFoundWindow) >= time.Second {
		c.notFoundWindow, c.notFoundCount = now, 0
	}
	if c.notFoundCount >= 32 {
		return false
	}
	c.notFoundCount++
	return true
}

func (c *transferSocket) admit(p []byte, peer netip.AddrPort, now time.Time) bool {
	if len(p) < 4 || len(p) > 512 || !c.s.client(peer.Addr()) || peer.Port() == 0 {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	op := binary.BigEndian.Uint16(p)
	f := c.active[peer]
	if f != nil {
		if now.After(f.until) || op != 4 || len(p) != 4 || !f.waiting || binary.BigEndian.Uint16(p[2:]) != f.block {
			return false
		}
		f.waiting = false
		return true
	}
	if op != 1 || len(c.active) >= 16 || c.files[readName(p)] == nil {
		return false
	}
	c.active[peer] = &flight{until: now.Add(60 * time.Second)}
	return true
}

func (c *transferSocket) ReadFrom(buf []byte) (int, net.Addr, error) {
	for {
		n, src, err := c.PacketConn.ReadFrom(buf)
		if err != nil {
			return 0, nil, err
		}
		from, ok := src.(*net.UDPAddr)
		if !ok {
			continue
		}
		now := time.Now()
		if c.admit(buf[:n], from.AddrPort(), now) {
			return n, src, nil
		}
		if c.missing(buf[:n], from.AddrPort(), now) {
			_, _, _ = c.PacketConn.(*net.UDPConn).WriteMsgUDP([]byte("\x00\x05\x00\x01File not found\x00"), c.oob, from)
		}
	}
}

func (c *transferSocket) WriteTo(p []byte, dest net.Addr) (int, error) {
	peer := dest.(*net.UDPAddr)
	c.mu.Lock()
	f := c.active[peer.AddrPort()]
	if f == nil || time.Now().After(f.until) {
		c.mu.Unlock()
		return 0, errors.New("transfer expired")
	}
	if len(p) >= 4 {
		switch binary.BigEndian.Uint16(p) {
		case 6:
			f.block, f.waiting = 0, true
		case 3:
			f.block, f.waiting = binary.BigEndian.Uint16(p[2:]), true
		}
	}
	c.mu.Unlock()
	n, _, err := c.PacketConn.(*net.UDPConn).WriteMsgUDP(p, c.oob, peer)
	return n, err
}

func (s segment) tftp(conn *net.UDPConn, files map[string][]byte) error {
	c := &transferSocket{PacketConn: conn, s: s, files: files, active: make(map[netip.AddrPort]*flight),
		oob: (&ipv4.ControlMessage{Src: net.IP(s.address.AsSlice())}).Marshal()}
	srv := tftp.NewServer(func(name string, dst io.ReaderFrom) error {
		tr := dst.(tftp.OutgoingTransfer)
		addr := tr.RemoteAddr()
		peer := addr.AddrPort()
		defer func() { c.mu.Lock(); delete(c.active, peer); c.mu.Unlock() }()
		data := files[filename(name)]
		tr.SetSize(int64(len(data)))
		_, err := dst.ReadFrom(bytes.NewReader(data))
		return err
	}, nil)
	srv.EnableSinglePort()
	srv.SetBlockSize(1468)
	srv.SetTimeout(time.Second)
	srv.SetRetries(3)
	srv.SetBackoff(func(int) time.Duration { return time.Millisecond * 100 })
	return srv.Serve(c)
}
