package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/insomniacslk/dhcp/dhcpv4"
	"golang.org/x/net/ipv4"
	"golang.org/x/sys/unix"
)

const biosFile = "undionly.kpxe"
const efiFile = "x86_64-sb/snponly-shim.efi"

func (s segment) bootfile(architectures []byte) string {
	if len(architectures) == 0 || len(architectures)%2 != 0 {
		return ""
	}
	for len(architectures) > 0 {
		switch binary.BigEndian.Uint16(architectures) {
		case 0:
			if s.bios {
				return biosFile
			}
		case 7, 9:
			if s.efi {
				return efiFile
			}
		}
		architectures = architectures[2:]
	}
	return ""
}

// A proxy offer describes only the next boot service. Lease requests on port
// 67, DHCP relays and boot requests selecting another server belong elsewhere.
func (s segment) answer(packet []byte, peer netip.AddrPort, port int) ([]byte, netip.AddrPort) {
	var none netip.AddrPort
	if len(packet) < 240 || len(packet) > 1472 || !peer.Addr().Is4() || peer.Port() == 0 {
		return nil, none
	}
	req, err := dhcpv4.FromBytes(packet)
	if err != nil || req.OpCode != dhcpv4.OpcodeBootRequest || req.HWType != 1 || len(req.ClientHWAddr) != 6 ||
		req.ClientHWAddr[0]&1 != 0 || bytes.Equal(req.ClientHWAddr, []byte{0, 0, 0, 0, 0, 0}) || req.HopCount != 0 ||
		!req.GatewayIPAddr.IsUnspecified() || req.Options.Get(dhcpv4.OptionRelayAgentInformation) != nil {
		return nil, none
	}
	vendor := req.ClassIdentifier()
	if vendor != "PXEClient" && !strings.HasPrefix(vendor, "PXEClient:") {
		return nil, none
	}
	loader := s.bootfile(req.Options.Get(dhcpv4.OptionClientSystemArchitectureType))
	if loader == "" {
		return nil, none
	}
	local := net.IP(s.address.AsSlice())
	if server := req.Options.Get(dhcpv4.OptionServerIdentifier); server != nil && !bytes.Equal(server, local) {
		return nil, none
	}
	typ := dhcpv4.MessageTypeOffer
	dest := peer
	switch port {
	case 67:
		if req.MessageType() != dhcpv4.MessageTypeDiscover || peer.Port() != 68 || !req.ClientIPAddr.IsUnspecified() ||
			(!peer.Addr().IsUnspecified() && !s.client(peer.Addr())) {
			return nil, none
		}
		if peer.Addr().IsUnspecified() || req.IsBroadcast() {
			dest = netip.AddrPortFrom(netip.AddrFrom4([4]byte{255, 255, 255, 255}), 68)
		}
	case 4011:
		if req.MessageType() != dhcpv4.MessageTypeRequest || !s.client(peer.Addr()) ||
			(!req.ClientIPAddr.IsUnspecified() && !req.ClientIPAddr.Equal(net.IP(peer.Addr().AsSlice()))) {
			return nil, none
		}
		typ = dhcpv4.MessageTypeAck
	default:
		return nil, none
	}
	resp := dhcpv4.DHCPv4{OpCode: dhcpv4.OpcodeBootReply, HWType: req.HWType, TransactionID: req.TransactionID,
		Flags: req.Flags & 0x8000, ClientHWAddr: req.ClientHWAddr, ClientIPAddr: req.ClientIPAddr, YourIPAddr: net.IPv4zero,
		ServerIPAddr: local, GatewayIPAddr: net.IPv4zero, BootFileName: loader, Options: dhcpv4.Options{}}
	resp.UpdateOption(dhcpv4.OptMessageType(typ))
	resp.UpdateOption(dhcpv4.OptServerIdentifier(local))
	resp.UpdateOption(dhcpv4.OptClassIdentifier("PXEClient"))
	resp.UpdateOption(dhcpv4.OptTFTPServerName(s.address.String()))
	resp.UpdateOption(dhcpv4.OptBootFileName(loader))
	// PXE discovery control: use the boot file supplied with this offer.
	resp.UpdateOption(dhcpv4.OptGeneric(dhcpv4.OptionVendorSpecificInformation, []byte{6, 1, 8, 255}))
	if id := req.Options.Get(dhcpv4.OptionClientMachineIdentifier); len(id) == 17 {
		resp.UpdateOption(dhcpv4.OptGeneric(dhcpv4.OptionClientMachineIdentifier, id))
	}
	if id := req.Options.Get(dhcpv4.OptionClientIdentifier); len(id) > 0 && len(id) <= 255 {
		resp.UpdateOption(dhcpv4.OptGeneric(dhcpv4.OptionClientIdentifier, id))
	}
	return resp.ToBytes(), dest
}

// Linux in_pktinfo contains the interface's local IPv4 (ipi_spec_dst) as
// well as the packet destination (often 255.255.255.255 during discovery).
func localDestination(oob []byte, addr netip.Addr) bool {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return false
	}
	for _, msg := range msgs {
		if msg.Header.Level == unix.IPPROTO_IP && msg.Header.Type == unix.IP_PKTINFO && len(msg.Data) == unix.SizeofInet4Pktinfo {
			var info unix.Inet4Pktinfo
			_, err := binary.Decode(msg.Data, binary.NativeEndian, &info)
			return err == nil && info.Spec_dst == addr.As4()
		}
	}
	return false
}

func (s segment) dhcp(conn *net.UDPConn, port int) error {
	buf := make([]byte, 1473)
	control := (&ipv4.ControlMessage{Src: net.IP(s.address.AsSlice())}).Marshal()
	ancillary := make([]byte, unix.CmsgSpace(unix.SizeofInet4Pktinfo))
	var window time.Time
	var sent int
	for {
		n, oobSize, flags, peer, err := conn.ReadMsgUDPAddrPort(buf, ancillary)
		if err != nil {
			return err
		}
		if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || (port == 67 && !localDestination(ancillary[:oobSize], s.address)) {
			continue
		}
		now := time.Now()
		if now.Sub(window) >= time.Second {
			window, sent = now, 0
		}
		if sent >= 64 {
			continue
		}
		body, to := s.answer(buf[:n], peer, port)
		if len(body) == 0 {
			continue
		}
		sent++
		// A retransmitted discovery can originate before a client has an ARP entry.
		// One unreachable client must not interrupt the service for others.
		_, _, _ = conn.WriteMsgUDPAddrPort(body, control, to)
	}
}
