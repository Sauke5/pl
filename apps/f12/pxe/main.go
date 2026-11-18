// F12 serves one explicitly selected network through three inherited Linux sockets.
package main

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type segment struct {
	address   netip.Addr
	network   netip.Prefix
	bios, efi bool
}

func configuration(ip, network, firmware string) (segment, error) {
	addr, e := netip.ParseAddr(ip)
	cidr, f := netip.ParsePrefix(network)
	if e != nil || f != nil || !addr.Is4() || !addr.IsGlobalUnicast() || !cidr.Addr().Is4() ||
		cidr != cidr.Masked() || !cidr.Contains(addr) || cidr.Bits() == 0 {
		return segment{}, errors.New("invalid IPv4 address or network")
	}
	s := segment{address: addr, network: cidr}
	switch firmware {
	case "bios":
		s.bios = true
	case "uefi-x64":
		s.efi = true
	case "bios,uefi-x64":
		s.bios, s.efi = true, true
	default:
		return segment{}, errors.New("invalid firmware selection")
	}
	return s, nil
}

func (s segment) client(addr netip.Addr) bool {
	if !addr.Is4() || !addr.IsGlobalUnicast() || !s.network.Contains(addr) || addr == s.address {
		return false
	}
	if s.network.Bits() > 30 {
		return true
	}
	a := addr.As4()
	host := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
	mask := ^uint32(0) >> s.network.Bits()
	return host&mask != 0 && host&mask != mask
}

func descriptors(input string) ([3]int, error) {
	var result [3]int
	parts := strings.Split(input, ",")
	if len(parts) != 3 {
		return result, errors.New("expected three inherited sockets")
	}
	for i, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil || value < 3 || strconv.Itoa(value) != part {
			return result, errors.New("invalid inherited socket number")
		}
		for _, old := range result[:i] {
			if value == old {
				return result, errors.New("duplicate inherited socket")
			}
		}
		result[i] = value
	}
	return result, nil
}

func inherited(fd, port int, iface string, address netip.Addr) (*net.UDPConn, error) {
	bound, err := unix.GetsockoptString(fd, unix.SOL_SOCKET, unix.SO_BINDTODEVICE)
	if err != nil || bound != iface {
		return nil, errors.New("socket is not bound to the selected interface")
	}
	kind, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE)
	if err != nil || kind != unix.SOCK_DGRAM {
		return nil, errors.New("expected a datagram socket")
	}
	proto, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_PROTOCOL)
	if err != nil || proto != unix.IPPROTO_UDP {
		return nil, errors.New("expected UDP")
	}
	sock, err := unix.Getsockname(fd)
	v4, ok := sock.(*unix.SockaddrInet4)
	boundAddr := address.As4()
	if port == 67 {
		boundAddr = [4]byte{}
	}
	if err != nil || !ok || v4.Port != port || v4.Addr != boundAddr {
		return nil, errors.New("unexpected IPv4 socket address or port")
	}
	reuse, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEPORT)
	if err != nil || reuse != 0 {
		return nil, errors.New("shared UDP port")
	}
	if port == 67 {
		broadcast, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_BROADCAST)
		if err != nil || broadcast != 1 {
			return nil, errors.New("discovery socket lacks broadcast permission")
		}
		pktinfo, err := unix.GetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_PKTINFO)
		if err != nil || pktinfo != 1 {
			return nil, errors.New("discovery socket lacks IPv4 packet information")
		}
	}
	file := os.NewFile(uintptr(fd), "f12-udp")
	pc, err := net.FilePacketConn(file)
	file.Close() // FilePacketConn duplicated this descriptor.
	if err != nil {
		return nil, err
	}
	udp, ok := pc.(*net.UDPConn)
	if !ok {
		pc.Close()
		return nil, errors.New("expected a UDP connection")
	}
	return udp, nil
}

func run() error {
	iface := flag.String("interface", "", "selected Linux interface")
	addr := flag.String("address", "", "assigned IPv4 address")
	cidr := flag.String("cidr", "", "selected network")
	firmware := flag.String("firmware", "", "published firmware")
	fds := flag.String("fds", "3,4,5", "UDP descriptors in 67,4011,69 order")
	flag.Parse()
	if flag.NArg() != 0 || *iface == "" || len(*iface) >= unix.IFNAMSIZ || strings.ContainsAny(*iface, "/\x00") {
		return errors.New("invalid interface or arguments")
	}
	s, err := configuration(*addr, *cidr, *firmware)
	if err != nil {
		return err
	}
	numbers, err := descriptors(*fds)
	if err != nil {
		return err
	}
	var conns [3]*net.UDPConn
	for i, port := range [3]int{67, 4011, 69} {
		conns[i], err = inherited(numbers[i], port, *iface, s.address)
		if err != nil {
			return fmt.Errorf("UDP %d: %w", port, err)
		}
		defer conns[i].Close()
	}
	files, err := s.firmware("/opt/pl-f12/firmware")
	if err != nil {
		return err
	}
	done := make(chan error, 3)
	go func() { done <- s.dhcp(conns[0], 67) }()
	go func() { done <- s.dhcp(conns[1], 4011) }()
	go func() { done <- s.tftp(conns[2], files) }()
	fmt.Println("READY")
	return <-done
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
