package main

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/insomniacslk/dhcp/dhcpv4"
	"golang.org/x/sys/unix"
)

func example(t *testing.T) segment {
	t.Helper()
	s, err := configuration("192.0.2.10", "192.0.2.0/24", "bios,uefi-x64")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func discover(t *testing.T, arch byte) *dhcpv4.DHCPv4 {
	t.Helper()
	r, err := dhcpv4.NewDiscovery(net.HardwareAddr{2, 1, 2, 3, 4, 5},
		dhcpv4.WithOption(dhcpv4.OptClassIdentifier("PXEClient:Arch:00000:UNDI:002001")),
		dhcpv4.WithOption(dhcpv4.OptGeneric(dhcpv4.OptionClientSystemArchitectureType, []byte{0, arch})))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDiscoveryAndBootRequest(t *testing.T) {
	s := example(t)
	for _, arch := range []byte{0, 7, 9} {
		r := discover(t, arch)
		body, dst := s.answer(r.ToBytes(), netip.MustParseAddrPort("0.0.0.0:68"), 67)
		reply, err := dhcpv4.FromBytes(body)
		if err != nil || dst != netip.MustParseAddrPort("255.255.255.255:68") {
			t.Fatal(arch, dst, err)
		}
		name := efiFile
		if arch == 0 {
			name = biosFile
		}
		if reply.BootFileName != name || !reply.YourIPAddr.IsUnspecified() || reply.TransactionID != r.TransactionID ||
			reply.OpCode != dhcpv4.OpcodeBootReply || reply.MessageType() != dhcpv4.MessageTypeOffer ||
			!reply.ServerIPAddr.Equal(net.IP(s.address.AsSlice())) {
			t.Fatalf("invalid proxy offer for architecture %d: %v", arch, reply)
		}
		for _, code := range []dhcpv4.OptionCode{dhcpv4.OptionSubnetMask, dhcpv4.OptionRouter, dhcpv4.OptionDomainNameServer, dhcpv4.OptionIPAddressLeaseTime} {
			if reply.Options.Get(code) != nil {
				t.Fatalf("unexpected lease option %v", code)
			}
		}
		peer := netip.MustParseAddrPort("192.0.2.34:68")
		r.ClientIPAddr = net.IP(peer.Addr().AsSlice())
		r.UpdateOption(dhcpv4.OptMessageType(dhcpv4.MessageTypeRequest))
		r.UpdateOption(dhcpv4.OptServerIdentifier(net.IP(s.address.AsSlice())))
		body, dst = s.answer(r.ToBytes(), peer, 4011)
		reply, err = dhcpv4.FromBytes(body)
		if err != nil || peer != dst || reply.MessageType() != dhcpv4.MessageTypeAck || reply.BootFileName != name || !reply.YourIPAddr.IsUnspecified() {
			t.Fatal("invalid boot response", dst, err)
		}
	}
}

func TestUnrelatedClientsGetNoResponse(t *testing.T) {
	s := example(t)
	check := func(r *dhcpv4.DHCPv4, peer string, port int) {
		t.Helper()
		if body, _ := s.answer(r.ToBytes(), netip.MustParseAddrPort(peer), port); body != nil {
			t.Fatalf("unexpected response to %v", r)
		}
	}
	for name, edit := range map[string]func(*dhcpv4.DHCPv4){
		"ordinary": func(r *dhcpv4.DHCPv4) { r.UpdateOption(dhcpv4.OptClassIdentifier("MSFT 5.0")) },
		"reply":    func(r *dhcpv4.DHCPv4) { r.OpCode = dhcpv4.OpcodeBootReply },
		"relay":    func(r *dhcpv4.DHCPv4) { r.GatewayIPAddr = net.IPv4(192, 0, 2, 1) },
		"relay option": func(r *dhcpv4.DHCPv4) {
			r.UpdateOption(dhcpv4.OptGeneric(dhcpv4.OptionRelayAgentInformation, []byte{1, 1, 1}))
		},
		"wrong server":  func(r *dhcpv4.DHCPv4) { r.UpdateOption(dhcpv4.OptServerIdentifier(net.IPv4(192, 0, 2, 1).To4())) },
		"lease request": func(r *dhcpv4.DHCPv4) { r.UpdateOption(dhcpv4.OptMessageType(dhcpv4.MessageTypeRequest)) },
		"unknown architecture": func(r *dhcpv4.DHCPv4) {
			r.UpdateOption(dhcpv4.OptGeneric(dhcpv4.OptionClientSystemArchitectureType, []byte{0, 11}))
		},
	} {
		t.Run(name, func(t *testing.T) { r := discover(t, 0); edit(r); check(r, "0.0.0.0:68", 67) })
	}
	check(discover(t, 0), "198.51.100.2:68", 67)
	check(discover(t, 0), "0.0.0.0:67", 67)
	check(discover(t, 0), "192.0.2.34:68", 4011)
	s.efi = false
	check(discover(t, 7), "0.0.0.0:68", 67)
}

func TestKernelSelectedAddressAndDescriptors(t *testing.T) {
	s := example(t)
	info := unix.Inet4Pktinfo{Ifindex: 4, Spec_dst: s.address.As4(), Addr: [4]byte{255, 255, 255, 255}}
	if !localDestination(unix.PktInfo4(&info), s.address) {
		t.Fatal("lost original broadcast")
	}
	info.Spec_dst = [4]byte{198, 51, 100, 10}
	if localDestination(unix.PktInfo4(&info), s.address) || localDestination(nil, s.address) {
		t.Fatal("accepted changed or missing interface address")
	}
	for _, v := range []string{"3,3,4", "1,4,5", "03,4,5", "4,5", "3,4,5,6"} {
		if _, err := descriptors(v); err == nil {
			t.Fatal(v)
		}
	}
	if f, err := descriptors("11,13,17"); err != nil || f != [3]int{11, 13, 17} {
		t.Fatal(f, err)
	}
}

func TestBoundedReadOnlyTFTP(t *testing.T) {
	s := example(t)
	c := transferSocket{s: s, files: map[string][]byte{"autoexec.ipxe": []byte("#!ipxe")}, active: map[netip.AddrPort]*flight{}}
	start := time.Now()
	ok := []byte("\x00\x01autoexec.ipxe\x00octet\x00tsize\x000\x00")
	peer := netip.MustParseAddrPort("192.0.2.30:1200")
	for _, p := range []string{"\x00\x02autoexec.ipxe\x00octet\x00", "\x00\x01../autoexec.ipxe\x00octet\x00", "\x00\x01autoexec.ipxe\x00netascii\x00", "\x00\x01autoexec.ipxe\x00octet\x00tsize\x00", "\x00\x04\x00\x01"} {
		if c.admit([]byte(p), peer, start) {
			t.Fatal("unexpected TFTP admission")
		}
	}
	if c.admit(ok, netip.MustParseAddrPort("198.51.100.30:1200"), start) || !c.admit(ok, peer, start) {
		t.Fatal("wrong subnet admission")
	}
	if c.admit(ok, peer, start) {
		t.Fatal("duplicate transfer")
	}
	c.active[peer].waiting = true
	if !c.admit([]byte{0, 4, 0, 0}, peer, start) || c.admit([]byte{0, 4, 0, 0}, peer, start) {
		t.Fatal("duplicate ACK admitted")
	}
	c.active[peer].waiting = true
	if c.admit([]byte{0, 4, 0, 0}, peer, start.Add(61*time.Second)) {
		t.Fatal("transfer deadline ignored")
	}
	for i := 1; i < 16; i++ {
		if !c.admit(ok, netip.AddrPortFrom(peer.Addr(), uint16(1200+i)), start) {
			t.Fatal(i)
		}
	}
	if c.admit(ok, netip.AddrPortFrom(peer.Addr(), 2000), start) {
		t.Fatal("too many active transfers")
	}
}

func TestOnlyStockShimGetsBoundedFileNotFound(t *testing.T) {
	c := transferSocket{s: example(t), active: map[netip.AddrPort]*flight{}}
	now := time.Now()
	peer := netip.MustParseAddrPort("192.0.2.33:1201")
	rrq := func(n string) []byte { return []byte("\x00\x01" + n + "\x00octet\x00") }
	for _, name := range []string{"revocations_sku.efi", "revocations_sbat.efi", "shim_certificate_0.efi"} {
		if !c.missing(rrq("x86_64-sb/"+name), peer, now) {
			t.Fatal(name)
		}
	}
	request := rrq("x86_64-sb/revocations_sbat.efi")
	if c.missing(rrq("x86_64-sb/another.efi"), peer, now) || c.missing(request, netip.MustParseAddrPort("198.51.100.33:1201"), now) {
		t.Fatal("unexpected error reply")
	}
	c.s.efi = false
	if c.missing(request, peer, now) {
		t.Fatal("UEFI inactive")
	}
	c.s.efi = true
	c.notFoundCount = 32
	if c.missing(request, peer, now) || !c.missing(request, peer, now.Add(time.Second)) {
		t.Fatal("error reply rate limit")
	}
}
