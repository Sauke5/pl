"""Finite collector boundaries and parsers. No remote/production endpoints."""
import base64
import contextlib
import io
import types
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('inventory_collectors_tests', ROOT / 'apps/netmap-stack/inventory_collectors.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
KEY = 'ssh-ed25519 ' + base64.b64encode(b'\0\0\0\x0bssh-ed25519' + b'\0\0\0 ' + bytes(range(32))).decode()


def profile(kind='network', **extra):
    value = {'id': 'fixture', 'name': 'Fixture', 'kind': kind, 'username': 'fixture-user', 'password': 'fixture-password'}
    if kind != 'windows': value['ssh_known_hosts'] = '192.0.2.1 ' + KEY
    if kind == 'network': value['driver'] = 'huawei_vrp'
    return {**value, **extra}


def target(kind='network', **extra):
    return {'id': str(uuid.uuid4()), 'kind': kind, 'address': '192.0.2.1', 'profile_id': 'fixture', 'name': 'Fixture', **extra}


VRP_VERSION = '''Huawei Versatile Routing Platform Software
VRP (R) software, Version 5.170 (AR720 V300R021C10SPC100)
HUAWEI AR720 Routing Switch uptime is 5 days
'''
VRP_INTERFACES = '''GigabitEthernet0/0/0 current state : UP
Line protocol current state : UP
Description: fixture uplink
Route Port,The Maximum Transmit Unit is 1500
Internet Address is 192.0.2.1/24
Hardware address is 0011-2233-4455
Port Mode: COMMON COPPER
Speed : 1000
LoopBack0 current state : UP
Line protocol current state : UP
The Maximum Transmit Unit is 1500
Internet Address is 2001:db8::1/128
'''
USG_VERSION = """Huawei Versatile Routing Platform Software
VRP (R) Software, Version 5.170 (USG6500E V600R007C20SPC600)
RTOS Version 207.6
USG6530E uptime is 0 week, 1 day, 0 hours, 1 minute
"""
IOS_VERSION = '''Cisco IOS Software, Version 15.2(7)E9, RELEASE SOFTWARE
edge-ios uptime is 3 days
cisco WS-C2960X-24TS-L (APM86XXX) processor
Processor board ID FOC12345678
'''
IOS_INTERFACES = '''GigabitEthernet1/0/1 is up, line protocol is up (connected)
 Hardware is Gigabit Ethernet, address is 0011.2233.4455
 Description: fixture LAN
 Internet address is 192.0.2.2/24
 MTU 1500 bytes, BW 1000000 Kbit/sec
Vlan42 is administratively down, line protocol is down
 Hardware is EtherSVI, address is 0011.2233.4466
 Internet address is 198.51.100.1/24
 MTU 1500 bytes, BW 1000000 Kbit/sec
'''
JUNOS_VERSION = '<rpc-reply xmlns="http://xml.juniper.net/junos"><software-information><host-name>edge-junos</host-name><product-model>ex2300-24t</product-model><junos-version>23.4R2</junos-version></software-information></rpc-reply>'
JUNOS_INTERFACES = '''<rpc-reply><interface-information><physical-interface><name>ge-0/0/0</name><snmp-index>501</snmp-index><admin-status>up</admin-status><oper-status>up</oper-status><if-type>Ethernet</if-type><mtu>1514</mtu><speed>1000mbps</speed><current-physical-address>00:11:22:33:44:55</current-physical-address><logical-interface><name>ge-0/0/0.0</name><snmp-index>502</snmp-index><address-family><interface-address><ifa-local>192.0.2.3</ifa-local><ifa-destination>192.0.2.0/24</ifa-destination></interface-address></address-family></logical-interface></physical-interface></interface-information></rpc-reply>'''

OPENWRT_BOARD = json.dumps({'hostname': 'lab-router', 'model': 'FriendlyElec NanoPi R3S LTS',
    'board_name': 'friendlyarm,nanopi-r3s', 'release': {'distribution': 'OpenWrt', 'version': '25.12.2'}})
OPENWRT_PORTS = '''1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN
    inet 127.0.0.1/8 scope host lo
2: eth0.11@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP
    link/ether 02:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff
3: br-lan: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP
    link/ether 02:11:22:33:44:56 brd ff:ff:ff:ff:ff:ff
    inet 192.0.2.1/24 brd 192.0.2.255 scope global br-lan
    inet6 2001:db8::1/64 scope global
'''
OPENWRT_ARP = '''192.0.2.13 dev br-lan lladdr 02:11:22:33:44:13 STALE
192.0.2.14 dev br-lan INCOMPLETE
192.0.2.15 dev br-lan lladdr ff:ff:ff:ff:ff:ff NOARP
'''
OPENWRT_DHCP = '2000000000 02:11:22:33:44:13 192.0.2.13 lab-host clientid-not-for-inventory\n'


class RouterDriverTests(unittest.TestCase):
    def test_friendlywrt_reads_observations_without_python_or_optional_commands(self):
        outputs = {c.OPENWRT_BOARD: OPENWRT_BOARD, c.OPENWRT_PORTS: OPENWRT_PORTS,
                   c.OPENWRT_ARP: OPENWRT_ARP, c.OPENWRT_NDP: '', c.OPENWRT_DHCP: OPENWRT_DHCP}
        commands = []

        def read(_client, command, _budget, **kwargs):
            commands.append(command)
            if command not in outputs:
                c.fail('inventory_command_failed')
            return outputs[command]

        with patch.object(c, '_exec', side_effect=read):
            value = c._collect_network(object(), {'driver': 'auto'}, c.Budget())
        self.assertEqual(commands, [c.OPENWRT_BOARD, c.OPENWRT_PORTS, c.OPENWRT_ARP,
                                   c.OPENWRT_NDP, c.OPENWRT_DHCP, c.OPENWRT_FDB])
        self.assertEqual((value['manufacturer'], value['hostname'], value['os_name']),
                         ('FriendlyElec', 'lab-router', 'OpenWrt'))
        self.assertEqual([p['name'] for p in value['interfaces']], ['eth0.11', 'br-lan'])
        self.assertEqual([a['address'] for a in value['interfaces'][1]['addresses']],
                         ['192.0.2.1/24', '2001:db8::1/64'])
        self.assertEqual([x['protocol'] for x in value['neighbors']], ['arp', 'dhcp'])
        self.assertEqual(value['neighbors'][0]['local_port'], 'br-lan')
        self.assertEqual(value['neighbors'][1]['hostname'], 'lab-host')
        self.assertTrue(value['capabilities']['neighbors_ndp'])
        self.assertNotIn('neighbors_fdb', value['capabilities'])
        self.assertNotIn('clientid-not-for-inventory', json.dumps(value))

    def test_fallback_arp_and_invalid_optional_format_preserve_table_authority(self):
        outputs = {c.OPENWRT_PORTS: OPENWRT_PORTS,
                   c.OPENWRT_ARP_FALLBACK: 'IP address HW type Flags HW address Mask Device\n'
                    '192.0.2.13 0x1 0x2 02:11:22:33:44:13 * br-lan\n'
                    '192.0.2.14 0x1 0x0 00:00:00:00:00:00 * br-lan\n',
                   c.OPENWRT_DHCP: 'unexpected lease provider format'}
        value = c._openwrt_snapshot(c._openwrt_board(OPENWRT_BOARD), outputs)
        self.assertEqual([x['address'] for x in value['neighbors']], ['192.0.2.13'])
        self.assertTrue(value['capabilities']['neighbors_arp'])
        self.assertNotIn('neighbors_dhcp', value['capabilities'])
        self.assertIn('neighbor_format_unrecognized', value['warnings'])
        with patch.object(c, 'MAX_NEIGHBORS', 1):
            value = c._openwrt_snapshot(c._openwrt_board(OPENWRT_BOARD), {**outputs, c.OPENWRT_DHCP: OPENWRT_DHCP})
        self.assertEqual([x['protocol'] for x in value['neighbors']], ['arp'])
        self.assertNotIn('neighbors_dhcp', value['capabilities'])
        self.assertIn('neighbor_limit_reached', value['warnings'])

    def test_routeros_uses_named_ports_and_distinguishes_neighbor_protocols(self):
        outputs = {c.ROS_SYSTEM: 'version: 7.20.1 (stable)\nboard-name: hEX\nplatform: MikroTik',
                   c.ROS_IDENTITY: 'name: edge-router', c.ROS_BOARD: 'model: RB750Gr3\nserial-number: DEMO1234',
                   c.ROS_INTERFACES: 'Flags: R - RUNNING; X - DISABLED\n'
                    '0 R name="uplink port" type=ether actual-mtu=1500 mac-address=02:11:22:33:44:55\n'
                    '1 X name=ether2 type=ether actual-mtu=1500',
                   c.ROS_IP: '0 address=192.0.2.1/24 interface="uplink port"',
                   c.ROS_IPV6: '0 D address=2001:db8::1/64 interface="uplink port"',
                   c.ROS_DHCP: '0 D address=192.0.2.13 mac-address=02:11:22:33:44:13 status=bound host-name=lab-host expires-after=1h2m3s\n'
                    '1 address=192.0.2.14 mac-address=02:11:22:33:44:14 status=waiting',
                   c.ROS_ARP: '0 DC address=192.0.2.13 mac-address=02:11:22:33:44:13 interface="uplink port"',
                   c.ROS_FDB: '0 D mac-address=02:11:22:33:44:13 on-interface="uplink port"\n'
                    '1 DL mac-address=02:11:22:33:44:55 on-interface="uplink port"',
                   c.ROS_NEIGHBOR: '0 interface="uplink port" address=192.0.2.2 mac-address=02:11:22:33:44:02 '
                    'identity="Switch 1" discovered-by=lldp,cdp interface-name=Gi1/0/1\n'
                    '1 interface=ether2 address=192.0.2.3 mac-address=02:11:22:33:44:03 discovered-by=mndp'}
        value = c._routeros_snapshot(outputs)
        self.assertEqual((value['model'], value['serial'], value['hostname']), ('RB750Gr3', 'DEMO1234', 'edge-router'))
        self.assertEqual(value['interfaces'][0]['name'], 'uplink port')
        self.assertEqual(len(value['interfaces'][0]['addresses']), 2)
        self.assertFalse(value['interfaces'][1]['enabled'])
        rows = {x['protocol']: x for x in value['neighbors']}
        self.assertEqual(set(rows), {'arp', 'dhcp', 'fdb', 'lldp', 'cdp'})
        self.assertNotIn('remote_port', rows['lldp'])
        self.assertEqual(rows['cdp']['remote_port'], 'Gi1/0/1')
        self.assertEqual(rows['dhcp']['hostname'], 'lab-host')
        old = c._routeros_snapshot({**outputs, c.ROS_NEIGHBOR: '0 interface=ether2 address=192.0.2.3 identity=legacy'})
        self.assertNotIn('neighbors_lldp', old['capabilities'])

    def test_keenetic_parses_nested_ports_and_remaining_lease(self):
        outputs = {c.KEENETIC_VERSION: 'release: 4.2.1\nmanufacturer: Keenetic Ltd.\nmodel: Hero DSL\n',
                   c.KEENETIC_PORTS: 'interface, name = "Home":\n  id: Bridge0\n type: Bridge\n'
                    '  state: up\n  link: up\n  address: 192.0.2.1\n mask: 255.255.255.0\n'
                    'interface, name = "Switch":\n id: GigabitEthernet0\n type: GigabitEthernet\n'
                    ' port, name = 1:\n id: GigabitEthernet0/0\n type: Port\n link: down\n',
                   c.KEENETIC_ARP: 'IP MAC Interface\n======================\n192.0.2.13 02:11:22:33:44:13 Home\n',
                   c.KEENETIC_DHCP: 'lease:\n ip: 192.0.2.13\n mac: 02:11:22:33:44:13\n expires: 300\n hostname: lab-host\n'}
        value = c._keenetic_snapshot(outputs)
        self.assertEqual(value['os_name'], 'KeeneticOS')
        self.assertEqual([x['name'] for x in value['interfaces']], ['Bridge0', 'GigabitEthernet0', 'GigabitEthernet0/0'])
        self.assertEqual(value['interfaces'][0]['addresses'][0]['address'], '192.0.2.1/24')
        self.assertFalse(value['interfaces'][2]['link_up'])
        self.assertEqual(value['neighbors'][1]['hostname'], 'lab-host')
        self.assertIn('expires_at', value['neighbors'][1])

    def test_jetstream_keeps_fdb_direction_separate_from_ip_interfaces(self):
        outputs = {c.TPLINK_SYSTEM: 'System Description - JetStream 24-Port Managed Switch\n'
                    'System Name - edge-switch\nHardware Version - T2600G-28TS 3.0\n'
                    'Software Version - 3.0.0 Build 20170820\nSerial Number - DEMO1234\n',
                   c.TPLINK_PORTS: 'Port Status Speed Duplex\nGi1/0/1 LinkUp 1000M Full\nGi1/0/2 LinkDown N/A N/A\n',
                   c.TPLINK_IP_BRIEF: 'Interface IP-Address Method Status Protocol Shutdown\n'
                    'VLAN2 192.0.2.1/24 Static Up Up no\n',
                   c.TPLINK_FDB: 'Vlan Mac Address Type Ports\n2 0211.2233.4413 DYNAMIC Gi1/0/1\n'
                    '2 0211.2233.4414 STATIC Gi1/0/2\n'}
        value = c._tplink_snapshot(outputs)
        self.assertEqual(value['interfaces'][0]['speed_mbps'], 1000)
        self.assertEqual(value['interfaces'][2]['addresses'][0]['address'], '192.0.2.1/24')
        self.assertEqual(value['neighbors'], [{'protocol': 'fdb', 'mac': '02:11:22:33:44:13', 'local_port': 'Gi1/0/1'}])

    def test_unknown_appliance_is_not_guessed_as_openwrt_or_routeros(self):
        self.assertIsNone(c._openwrt_board('{"release":{"distribution":"other","version":"1.0"}}'))
        self.assertIsNone(c._keenetic_identity('release: 4.2\nmanufacturer: generic'))
        with self.assertRaises(c.InventoryCollectionError) as error:
            c._routeros_snapshot({c.ROS_SYSTEM: 'version: 7.20\nplatform: generic'})
        self.assertEqual(error.exception.code, 'inventory_driver_unsupported')


class BoundaryTests(unittest.TestCase):
    def test_profile_strict_auth_driver_trust_and_defaults(self):
        p = c.validate_profile(profile())
        self.assertEqual((p['port'], p['auth_method']), (22, 'password'))
        self.assertEqual(c.validate_profile(profile('windows'))['port'], 5986)
        self.assertEqual(c.validate_profile(profile('windows', scheme='http'))['port'], 5985)
        for extra in ({'driver': 'vendor/arbitrary.py'}, {'ssh_known_hosts': ''}, {'ssh_known_hosts': '# no key'},
                      {'ssh_known_hosts': '*.example ' + KEY}, {'auth_method': 'key'}, {'port': True},
                      {'private_key': 'secret'}, {'command': 'reboot'}, {'username': 'user\nsecret'}):
            with self.subTest(fields=list(extra)), self.assertRaises(c.InventoryCollectionError):
                c.validate_profile(profile(**extra))
        for extra in ({'transport': 'basic'}, {'server_cert_validation': 'ignore'}, {'ca_pem': 'INVALID'}, {'scheme': 'http', 'ca_pem': 'x'}, {'scheme': 'ftp'}):
            with self.subTest(fields=list(extra)), self.assertRaises(c.InventoryCollectionError):
                c.validate_profile(profile('windows', **extra))

    def test_target_rejects_metadata_loopback_dns_and_scoped_ipv6_before_network(self):
        for address in ('127.0.0.1', '::1', '169.254.169.254', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'fd00:ec2::254', '100.100.100.200', 'fe80::1', 'fe80::1%eth0', '224.0.0.1', '0.0.0.0', 'router.example'):
            with self.subTest(address=address), patch.object(c.subprocess, 'Popen') as spawn:
                with self.assertRaises(c.InventoryCollectionError) as error:
                    c.collect(target(address=address), profile())
                self.assertEqual(error.exception.code, 'inventory_target_invalid'); spawn.assert_not_called()
        self.assertEqual(c._target(target(address='2001:db8::1'), 'network'), '2001:db8::1')
        self.assertEqual(c._target(target('linux', network_id=''), 'linux'), '192.0.2.1')
        with self.assertRaises(c.InventoryCollectionError): c._target(target(network_id='foreign'), 'network')

    def test_hard_deadline_kills_and_reaps_finite_child_without_argv_credentials(self):
        actual = subprocess.Popen; children = []
        def launch(args, **kwargs):
            self.assertNotIn('fixture-password', ' '.join(args))
            child = actual([sys.executable, '-c', 'import time;time.sleep(30)'], **kwargs)
            children.append(child); return child
        before = time.monotonic()
        with patch.object(c.subprocess, 'Popen', side_effect=launch), self.assertRaises(c.InventoryCollectionError) as error:
            c.collect(target(), profile(), deadline=before + 0.15)
        self.assertEqual(error.exception.code, 'inventory_timeout')
        self.assertLess(time.monotonic() - before, 2)
        self.assertIsNotNone(children[0].poll())

    def test_deadline_already_expired_does_not_leave_child(self):
        with patch.object(c.subprocess, 'Popen') as spawn, self.assertRaises(c.InventoryCollectionError):
            c.collect(target(), profile(), deadline=time.monotonic() - 1)
        # Validate budget before process creation, not just before communicate.
        spawn.assert_not_called()

    def test_safe_codes_never_include_arbitrary_error_text(self):
        error = c.InventoryCollectionError('fixture-password/raw-output')
        self.assertEqual(str(error), 'inventory_command_failed')
        with self.assertRaises(c.InventoryCollectionError) as error:
            c.validate_profile(profile(password='fixture-password\n'))
        self.assertNotIn('fixture-password', str(error.exception))


class ParserTests(unittest.TestCase):
    def test_huawei_vrp_real_shape_facts_ports_addresses_no_name_based_type_guess(self):
        value = c.parse_network('huawei_vrp', {'display version': VRP_VERSION, 'display interface': VRP_INTERFACES,
            'display device manuinfo': 'BarCode=VRP123456'}, '<edge-vrp>')
        self.assertEqual((value['hostname'], value['manufacturer'], value['model'], value['serial']), ('edge-vrp', 'Huawei', 'AR720', 'VRP123456'))
        port, loopback = value['interfaces']
        self.assertEqual((port['mtu'], port['speed_mbps'], port['mac_address'], port['type']), (1500, 1000, '00:11:22:33:44:55', 'physical'))
        self.assertEqual(port['addresses'], [{'address': '192.0.2.1/24', 'vrf': ''}])
        self.assertEqual(loopback['addresses'], [{'address': '2001:db8::1/128', 'vrf': ''}])
        self.assertEqual(loopback['type'], 'unknown')
        self.assertFalse(value['capabilities']['neighbors'])
        self.assertNotIn('neighbors_unsupported', value['warnings'])

    def test_usg_version_without_huawei_model_prefix_and_optional_esn_fallback(self):
        outputs = {'display version': USG_VERSION, 'display interface': VRP_INTERFACES,
                   'display device manuinfo': "Error:Too many parameters found at '^' position.",
                   'display esn': 'ESN: SYNTHETIC-USG-001'}
        value = c.parse_network('huawei_vrp', outputs, '<fixture-usg>')
        self.assertEqual(value['model'], 'USG6530E')
        self.assertEqual(value['serial'], 'SYNTHETIC-USG-001')
        self.assertNotIn('serial_unavailable', value['warnings'])
        outputs['display esn'] = 'Error: Unrecognized command found at position.'
        value = c.parse_network('huawei_vrp', outputs, '<fixture-usg>')
        self.assertEqual(len(value['interfaces']), 2)
        self.assertIn('serial_unavailable', value['warnings'])
        for mandatory in ('display version', 'display interface'):
            broken = {**outputs, mandatory: 'Error: Insufficient privilege.'}
            with self.subTest(mandatory=mandatory), self.assertRaises(c.InventoryCollectionError) as error:
                c.parse_network('huawei_vrp', broken, '<fixture-usg>')
            self.assertEqual(error.exception.code, 'inventory_command_failed')
        with self.assertRaises(c.InventoryCollectionError):
            c.parse_network('huawei_vrp', {**outputs, 'display interface': 'unexpected unreadable response'}, '<fixture-usg>')

    def test_huawei_optional_vlan_vrf_and_chassis_are_structured_and_bounded(self):
        outputs = {'display version': VRP_VERSION, 'display interface': VRP_INTERFACES,
            'display device manuinfo': 'BarCode=VRP123456',
            'display vlan': "VID  Status  Property  MAC-LRN  Statistics  Description\n1    enable  default   enable   disable     VLAN 0001\n10   enable  default   enable   disable     Office\n20   enable  default   enable   disable     Voice\n",
            'display port vlan': "Port                    Link Type    PVID  Trunk VLAN List\nGigabitEthernet0/0/0    trunk        10    10 20\n",
            'display ip vpn-instance': "VPN-Instance Name RD Address-family\noffice 65000:10 IPv4\n",
            'display ip vpn-instance interface': " VPN-Instance Name and ID : office, 1\n Interface list : GigabitEthernet0/0/0\n",
            'display stack': "Slot Role MAC Address Priority Device Type\n0 Master 0011-2233-4455 100 AR720\n"}
        value = c.parse_network('huawei_vrp', outputs, '<fixture>')
        self.assertEqual(value['vlans'], [{'vid': 1, 'name': 'VLAN 0001'}, {'vid': 10, 'name': 'Office'}, {'vid': 20, 'name': 'Voice'}])
        self.assertEqual(value['vrfs'], [{'name': 'office', 'rd': '65000:10'}])
        port = value['interfaces'][0]
        self.assertEqual((port['mode'], port['untagged_vlan'], port['tagged_vlans']), ('tagged', 10, [20]))
        self.assertEqual(port['addresses'][0]['vrf'], 'office')
        self.assertTrue(value['capabilities']['chassis'])
        self.assertEqual(value['chassis'][0]['role'], 'Master')
        for command in c.HUAWEI_OPTIONAL:
            broken = {**outputs, command: 'Error: Unrecognized command.'}
            if command == 'display vlan brief': broken['display vlan'] = 'Error: Unrecognized command.'
            observed = c.parse_network('huawei_vrp', broken, '<fixture>')
            self.assertEqual(len(observed['interfaces']), 2)
            self.assertTrue(observed['warnings'])
        unsupported = c.parse_network('huawei_vrp', {**outputs, 'display port vlan': 'unexpected format'}, '<fixture>')
        self.assertNotIn('mode', unsupported['interfaces'][0])
        self.assertFalse(unsupported['capabilities']['interface_vlans'])

    def test_usg_optional_tables_missing_rd_and_switch_vlan_fallback_real_shapes(self):
        outputs = {'display version': USG_VERSION, 'display interface': VRP_INTERFACES,
            'display esn': 'ESN: SYNTHETIC-USG-001',
            'display vlan brief': "Error: Wrong parameter found at position.",
            'display vlan': "VLAN ID Status   Unknown-Unicast Description\n1       enable   forward         VLAN 0001\n",
            'display port vlan': "Port Link Type PVID Trunk VLAN List\n",
            'display ip vpn-instance': "Total VPN-Instances configured : 2\nVPN-Instance Name RD Address-family\nmgmt IPv4\nempty IPv4\n",
            'display ip vpn-instance interface': "VPN-Instance Name and ID : mgmt, 20\nInterface Number : 1\nInterface list : GigabitEthernet0/0/0\nVPN-Instance Name and ID : empty, 21\nInterface Number : 0\n",
            'display stack': "Error: Wrong parameter found at position."}
        value = c.parse_network('huawei_vrp', outputs, '<fixture>')
        self.assertEqual(value['vlans'], [{'vid': 1, 'name': 'VLAN 0001'}])
        self.assertEqual(value['vrfs'], [{'name': 'empty', 'rd': None}, {'name': 'mgmt', 'rd': None}])
        self.assertEqual(value['interfaces'][0]['addresses'][0]['vrf'], 'mgmt')
        self.assertFalse(value['capabilities']['chassis'])
        self.assertTrue(value['capabilities']['interface_vlans'])
        self.assertNotIn('mode', value['interfaces'][0])
        outputs['display port vlan'] = "Port Link Type PVID Trunk VLAN List\nGigabitEthernet0/0/0 trunk 1 1 10-12\n                                        20 30\nLoopBack0 auto 1 1-4094\n"
        value = c.parse_network('huawei_vrp', outputs, '<fixture>')
        self.assertEqual(value['interfaces'][0]['tagged_vlans'], [10, 11, 12, 20, 30])
        self.assertNotIn('mode', value['interfaces'][1])
        outputs['display port vlan'] = "Port Link Type PVID Trunk VLAN List\nGigabitEthernet0/0/0 hybrid 1 1-4094\n"
        value = c.parse_network('huawei_vrp', outputs, '<fixture>')
        self.assertNotIn('mode', value['interfaces'][0])
        self.assertIn('hybrid_vlan_unrepresented', value['warnings'])
        outputs['display port vlan'] = "Port Link Type PVID Trunk VLAN List\nGigabitEthernet0/0/0 trunk 1 1-4094\n"
        value = c.parse_network('huawei_vrp', outputs, '<fixture>')
        self.assertEqual(value['interfaces'][0]['mode'], 'tagged-all')
        self.assertEqual(value['interfaces'][0]['tagged_vlans'], [])
        for invalid in ('0', '4095', '30-10', 'all-invalid'):
            with self.assertRaises(ValueError): c._vlan_ids(invalid)

    def test_cisco_ios_admin_link_and_hardware_classification(self):
        value = c.parse_network('cisco_ios', {'show version': IOS_VERSION, 'show interfaces': IOS_INTERFACES}, 'edge-ios#')
        self.assertEqual((value['hostname'], value['model'], value['serial']), ('edge-ios', 'WS-C2960X-24TS-L', 'FOC12345678'))
        active, disabled = value['interfaces']
        self.assertTrue(active['enabled']); self.assertTrue(active['link_up'])
        self.assertFalse(disabled['enabled']); self.assertFalse(disabled['link_up'])
        self.assertEqual(disabled['type'], 'virtual')
        self.assertIsNone(active['speed_mbps'], 'Configured BW must not masquerade as negotiated physical speed')
        negotiated = c.parse_network('cisco_ios', {'show version': IOS_VERSION, 'show interfaces': IOS_INTERFACES.replace(' MTU 1500 bytes, BW 1000000 Kbit/sec', ' Full-duplex, 1Gb/s', 1)})
        self.assertEqual(negotiated['interfaces'][0]['speed_mbps'], 1000)

    def test_junos_xml_namespace_logical_interfaces_and_network_mask(self):
        value = c.parse_network('junos', {c.COMMANDS['junos'][1]: JUNOS_VERSION, c.COMMANDS['junos'][2]: JUNOS_INTERFACES,
            c.COMMANDS['junos'][3]: '<rpc-reply><chassis><serial-number>JN123</serial-number></chassis></rpc-reply>'})
        self.assertEqual((value['hostname'], value['model'], value['serial']), ('edge-junos', 'ex2300-24t', 'JN123'))
        self.assertEqual([v['key'] for v in value['interfaces']], ['501', '502'])
        gigabit = c.parse_network('junos', {c.COMMANDS['junos'][1]: JUNOS_VERSION, c.COMMANDS['junos'][2]: JUNOS_INTERFACES.replace('1000mbps', '10Gbps')})
        self.assertEqual(gigabit['interfaces'][0]['speed_mbps'], 10000)
        self.assertEqual(value['interfaces'][1]['addresses'], [{'address': '192.0.2.3/24', 'vrf': ''}])
        with self.assertRaises(c.InventoryCollectionError): c._xml('<!DOCTYPE x [<!ENTITY secret "x">]>' + JUNOS_VERSION)

    def test_host_normalization_preserves_json_nulls_and_rejects_duplicate_interface_identity(self):
        raw = {'hostname': 'linux-fixture', 'cpu_count': 4, 'memory_mib': 4096, 'interfaces': [
            {'key': '2', 'name': 'eth0', 'enabled': True, 'link_up': True, 'mtu': 1500,
             'addresses': [{'address': '192.0.2.4', 'prefix': '255.255.255.0'}, {'address': '2001:db8::4', 'prefix': '64'}]}],
             'disks': [{'name': 'sda', 'size_bytes': 1024}], 'capabilities': {'interfaces': True, 'addresses': True, 'disks': True}}
        value = c._host_snapshot('windows', json.dumps(raw))
        self.assertEqual([x['address'] for x in value['interfaces'][0]['addresses']], ['192.0.2.4/24', '2001:db8::4/64'])
        self.assertIsNone(value['interfaces'][0]['speed_mbps'])
        self.assertEqual(value['virtualization'], 'unknown')
        self.assertIn('virtualization_unconfirmed', value['warnings'])
        raw['interfaces'].append(raw['interfaces'][0])
        with self.assertRaises(c.InventoryCollectionError): c._host_snapshot('linux', json.dumps(raw))

    def test_linux_loopback_is_an_interface_without_a_assignable_hardware_mac(self):
        value = c._host_snapshot('linux', json.dumps({'hostname': 'linux', 'interfaces': [
            {'key': 'lo', 'name': 'lo', 'type': 'virtual', 'mtu': 65536, 'mac_address': '00:00:00:00:00:00',
             'addresses': [{'address': '127.0.0.1/8'}]}], 'disks': []}))
        self.assertEqual(value['interfaces'][0]['mtu'], 65536)
        self.assertEqual(value['interfaces'][0]['mac_address'], '')
        self.assertEqual(value['interfaces'][0]['addresses'], [{'address': '127.0.0.1/8', 'vrf': ''}])

    def test_linux_actual_link_metadata_filters_loopback_veth_and_retains_management_bridges(self):
        links = [
            {'ifindex': 1, 'ifname': 'lo', 'link_type': 'loopback', 'flags': ['LOOPBACK', 'UP']},
            {'ifindex': 2, 'ifname': 'unexpected-name', 'linkinfo': {'info_kind': 'veth'}},
            {'ifindex': 3, 'ifname': 'br0', 'linkinfo': {'info_kind': 'bridge'}, 'flags': ['UP'],
             'addr_info': [{'local': '192.0.2.1', 'prefixlen': 24}]},
            {'ifindex': 4, 'ifname': 'veth-looking-but-vlan', 'linkinfo': {'info_kind': 'vlan'}},
            {'ifindex': 5, 'ifname': 'bond0', 'linkinfo': {'info_kind': 'bond'}},
            {'ifindex': 6, 'ifname': 'docker-looking-bridge', 'linkinfo': {'info_kind': 'bridge'}},
        ]
        def run(args, **kwargs):
            if args == ['ip', '-j', '-d', 'address', 'show']: body = json.dumps(links)
            elif args == ['systemd-detect-virt', '--vm']: body = 'kvm\n'
            elif args == ['lsblk', '-b', '-J', '-o', 'NAME,SIZE,TYPE']: body = '{"blockdevices":[]}'
            else: raise AssertionError('Unexpected remote command ' + str(args))
            return types.SimpleNamespace(returncode=0, stdout=body.encode())
        with patch('subprocess.run', side_effect=run), contextlib.redirect_stdout(io.StringIO()) as output:
            exec(c.LINUX_SCRIPT, {})
        value = c._host_snapshot('linux', output.getvalue())
        self.assertEqual([port['name'] for port in value['interfaces']], ['br0', 'veth-looking-but-vlan', 'bond0', 'docker-looking-bridge'])
        self.assertEqual(value['interfaces'][0]['addresses'], [{'address': '192.0.2.1/24', 'vrf': ''}])
        self.assertEqual([port['type'] for port in value['interfaces']], ['virtual', 'virtual', 'lag', 'virtual'])

    def test_invalid_address_warning_survives_host_normalization(self):
        value = c._host_snapshot('linux', json.dumps({'hostname': 'linux', 'interfaces': [
            {'key': 'eth0', 'name': 'eth0', 'addresses': [{'address': 'bad-address', 'prefix': '24'}]}],
            'warnings': [], 'disks': []}))
        self.assertIn('address_invalid', value['warnings'])

    def test_unbounded_remote_records_are_rejected_not_silently_truncated(self):
        for raw in ({'interfaces': [{}] * 1025}, {'disks': [{}] * 129}):
            with self.assertRaises(c.InventoryCollectionError) as error: c._host_snapshot('linux', json.dumps(raw))
            self.assertEqual(error.exception.code, 'inventory_output_limit')
        with self.assertRaises(c.InventoryCollectionError): c.Budget().add(b'x' * (c.MAX_OUTPUT + 1))

    def test_fixed_remote_payloads_do_not_contain_mutating_commands(self):
        self.assertIn('Get-CimInstance -OperationTimeoutSec 5', c.WINDOWS_SCRIPT)
        for command in ('Set-CimInstance', 'Invoke-CimMethod', 'Install-', 'Restart-', 'Set-Item'):
            self.assertNotIn(command, c.WINDOWS_SCRIPT)
        self.assertNotIn('sudo', c.LINUX_SCRIPT)
        for commands in c.COMMANDS.values():
            self.assertFalse(any('configuration' in value or 'save' in value or 'commit' in value for value in commands))


if __name__ == '__main__': unittest.main()
