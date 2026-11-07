"""Real loopback SSH fixtures; WinRM policy tests never contact Windows."""
import importlib.util
import io
import json
import socket
import subprocess
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

import test_inventory_collectors as fixtures
c = fixtures.c
HAS_SSH = importlib.util.find_spec('paramiko') is not None
HAS_WINRM = importlib.util.find_spec('winrm') is not None
if HAS_SSH:
    import paramiko


class SSHFixture:
    def __init__(self, *, stall=False, huge=False, command_outputs=None, prompt='<edge-vrp>'):
        self.key = paramiko.RSAKey.generate(2048)
        self.auth_calls, self.commands = [], []
        self.stall, self.huge = stall, huge
        self.prompt = prompt
        self.command_outputs = command_outputs or {}
        self.listener = socket.socket(); self.listener.bind(('127.0.0.1', 0)); self.listener.listen(4); self.listener.settimeout(0.1)
        self.port = self.listener.getsockname()[1]
        self.stopping = threading.Event(); self.transports = []
        self.thread = threading.Thread(target=self.serve, name='inventory-ssh-fixture', daemon=True); self.thread.start()

    def profile(self, kind='network', **extra):
        values = {'port': self.port, 'ssh_known_hosts': '[127.0.0.1]:' + str(self.port) + ' ' + self.key.get_name() + ' ' + self.key.get_base64()}
        return fixtures.profile(kind, **{**values, **extra})

    def serve(self):
        owner = self
        class Server(paramiko.ServerInterface):
            def __init__(self): self.ready = threading.Event(); self.command = None
            def check_auth_password(self, username, password):
                owner.auth_calls.append('password')
                return paramiko.AUTH_SUCCESSFUL if (username, password) == ('fixture-user', 'fixture-password') else paramiko.AUTH_FAILED
            def check_auth_publickey(self, username, key):
                owner.auth_calls.append('key')
                return paramiko.AUTH_SUCCESSFUL if username == 'fixture-user' else paramiko.AUTH_FAILED
            def get_allowed_auths(self, username): return 'password,publickey'
            def check_channel_request(self, kind, chanid): return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
            def check_channel_pty_request(self, *args): return True
            def check_channel_shell_request(self, channel): self.ready.set(); return True
            def check_channel_exec_request(self, channel, command): self.command = command.decode(); self.ready.set(); return True
        while not self.stopping.is_set():
            try: connection, _ = self.listener.accept()
            except socket.timeout: continue
            except OSError: return
            transport = paramiko.Transport(connection); self.transports.append(transport); transport.add_server_key(self.key)
            server = Server()
            try:
                transport.start_server(server=server); channel = transport.accept(3)
                if channel is None or not server.ready.wait(3): continue
                if self.stall:
                    self.stopping.wait(2); continue
                if server.command:
                    self.commands.append(server.command)
                    if self.huge: channel.sendall(b'x' * (c.MAX_OUTPUT + 1))
                    else:
                        channel.sendall(json.dumps({'hostname': 'linux-fixture', 'os_name': 'Debian GNU/Linux', 'os_version': '13',
                            'cpu_count': 4, 'memory_mib': 3790, 'virtualization': 'vm', 'disks': [{'name': 'vda', 'size_bytes': 100 * 1024**3}],
                            'interfaces': [{'key': '2', 'name': 'ens3', 'enabled': True, 'link_up': True, 'type': 'virtual',
                                'addresses': [{'address': '192.0.2.1/24', 'vrf': ''}]}],
                            'capabilities': {'interfaces': True, 'addresses': True, 'disks': True}}).encode())
                    channel.send_exit_status(0)
                else:
                    prompt = self.prompt
                    channel.sendall(prompt.encode())
                    stream = channel.makefile('rb')
                    for line in stream:
                        command = line.decode().strip(); self.commands.append(command)
                        if prompt == 'Switch>' and command == 'enable':
                            prompt = 'Switch#'
                        output = {**{'display version': fixtures.VRP_VERSION, 'display interface': fixtures.VRP_INTERFACES,
                                  'display device manuinfo': 'BarCode=VRP123456'}, **self.command_outputs}.get(command, '')
                        channel.sendall((command + '\r\n' + output + '\r\n' + prompt).encode())
            except (OSError, EOFError, paramiko.SSHException): pass
            finally: transport.close()

    def close(self):
        self.stopping.set(); self.listener.close()
        for transport in self.transports: transport.close()
        self.thread.join(4)
        if self.thread.is_alive(): raise AssertionError('SSH fixture worker leaked')


@unittest.skipUnless(HAS_SSH, 'Install the pinned inventory requirements for real SSH acceptance')
class SSHTests(unittest.TestCase):
    def fixture(self, **kwargs):
        server = SSHFixture(**kwargs); self.addCleanup(server.close); return server

    def collect_local(self, server, kind='network', **extra):
        # Production validation forbids loopback; only the test's caller-side
        # address guard is replaced. SSH, host-key/auth, channel IO remain real.
        with patch.object(c, '_target', return_value='127.0.0.1'):
            return c._collect_impl(fixtures.target(kind), server.profile(kind, **extra), deadline=time.monotonic() + 4)

    def test_real_huawei_shell_collects_structured_facts_only_finite_commands(self):
        server = self.fixture()
        value = self.collect_local(server)
        self.assertEqual(value['serial'], 'VRP123456')
        self.assertEqual(len(value['interfaces']), 2)
        self.assertEqual(server.commands, list(c.COMMANDS['huawei_vrp']) + [c.HUAWEI_OPTIONAL[0], 'display vlan', *c.HUAWEI_OPTIONAL[1:]])
        self.assertEqual(server.auth_calls, ['password'])

    def test_real_keenetic_cli_uses_show_commands_and_reads_arp(self):
        server = self.fixture(prompt='(config)>', command_outputs={
            c.KEENETIC_VERSION: 'release: 4.3.1\nvendor: Keenetic\nmodel: Hopper',
            c.KEENETIC_PORTS: 'id: Bridge0\ntype: Bridge\naddress: 192.0.2.1\nmask: 255.255.255.0',
            c.KEENETIC_ARP: 'IP MAC Interface\n192.0.2.10 02:11:22:33:44:10 Bridge0',
            c.KEENETIC_DHCP: '',
        })
        value = self.collect_local(server, driver='keenetic')
        self.assertEqual(value['model'], 'Hopper')
        self.assertEqual(value['neighbors'][0]['local_port'], 'Bridge0')
        self.assertTrue(value['capabilities']['neighbors_dhcp'])
        self.assertEqual(server.commands, [c.KEENETIC_VERSION, c.KEENETIC_PORTS, c.KEENETIC_ARP, c.KEENETIC_DHCP])

    def test_real_tplink_cli_elevates_exec_session_and_never_enters_configuration(self):
        server = self.fixture(prompt='Switch>', command_outputs={
            c.TPLINK_SYSTEM: 'System Description - JetStream managed switch\nHardware Version - T2600G-28TS 3.0\n'
                            'Software Version - 3.0.0 Build 20170820\nSystem Name - Switch',
            c.TPLINK_PORTS: 'Gi1/0/1 LinkUp 1000M Full\n',
            c.TPLINK_IP_BRIEF: '% Invalid input detected',
            c.TPLINK_IP: 'IP Address - 192.0.2.1\nSubnet Mask - 255.255.255.0\nManagement VLAN - 2',
            c.TPLINK_FDB: '2 0211.2233.4410 DYNAMIC Gi1/0/1',
        })
        value = self.collect_local(server, driver='tplink_jetstream')
        self.assertEqual(value['manufacturer'], 'TP-Link')
        self.assertEqual(value['interfaces'][1]['addresses'][0]['address'], '192.0.2.1/24')
        self.assertEqual(value['neighbors'][0]['protocol'], 'fdb')
        self.assertEqual(server.commands, ['enable', c.TPLINK_SYSTEM, c.TPLINK_PORTS,
                                           c.TPLINK_IP_BRIEF, c.TPLINK_IP, c.TPLINK_FDB])

    def test_real_usg_optional_serial_fallback_and_mandatory_command_failure(self):
        errors = {'display version': fixtures.USG_VERSION,
                  'display device manuinfo': "Error:Too many parameters found at '^' position.",
                  'display esn': 'ESN: SYNTHETIC-USG-001'}
        server = self.fixture(command_outputs=errors)
        value = self.collect_local(server)
        self.assertEqual((value['model'], value['serial']), ('USG6530E', 'SYNTHETIC-USG-001'))
        self.assertEqual(server.commands, list(c.COMMANDS['huawei_vrp']) + ['display esn', c.HUAWEI_OPTIONAL[0], 'display vlan', *c.HUAWEI_OPTIONAL[1:]])
        denied = self.fixture(command_outputs={'display interface': 'Error: Insufficient privilege.'})
        with self.assertRaises(c.InventoryCollectionError) as error: self.collect_local(denied)
        self.assertEqual(error.exception.code, 'inventory_command_failed')
        self.assertNotIn('display device manuinfo', denied.commands)

    def test_real_ssh_optional_vlan_fallback_vrf_and_stack(self):
        server = self.fixture(command_outputs={
            'display vlan brief': 'Error: Wrong parameter found at position.',
            'display vlan': 'VLAN ID Status Unknown-Unicast Description\n10 enable forward Office\n20 enable forward Voice',
            'display port vlan': 'Port Link Type PVID Trunk VLAN List\nGigabitEthernet0/0/0 trunk 10 10 20',
            'display ip vpn-instance': 'VPN-Instance Name RD Address-family\noffice 65000:10 IPv4',
            'display ip vpn-instance interface': 'VPN-Instance Name and ID : office, 1\nInterface list : GigabitEthernet0/0/0',
            'display stack': 'Slot Role MAC Address Priority Device Type\n0 Master 0011-2233-4455 100 S5735-L48T4X-A1'})
        value = self.collect_local(server)
        self.assertEqual([row['vid'] for row in value['vlans']], [10, 20])
        self.assertEqual(value['interfaces'][0]['tagged_vlans'], [20])
        self.assertEqual(value['interfaces'][0]['addresses'][0]['vrf'], 'office')
        self.assertEqual(value['chassis'][0]['slot'], 0)
        self.assertEqual(value['warnings'], [])
        self.assertEqual(server.commands, list(c.COMMANDS['huawei_vrp']) + [c.HUAWEI_OPTIONAL[0], 'display vlan', *c.HUAWEI_OPTIONAL[1:]])

    def test_real_linux_exec_uses_fixed_readonly_payload(self):
        server = self.fixture(); value = self.collect_local(server, 'linux')
        self.assertEqual((value['hostname'], value['cpu_count'], value['memory_mib']), ('linux-fixture', 4, 3790))
        self.assertEqual(server.commands, [c.LINUX_COMMAND])
        self.assertEqual(value['disks'][0]['size_bytes'], 100 * 1024**3)

    def test_real_private_key_auth_does_not_fall_back_to_password_or_agent(self):
        server = self.fixture(); key = paramiko.RSAKey.generate(2048); output = io.StringIO(); key.write_private_key(output)
        self.collect_local(server, 'linux', auth_method='key', password='', private_key=output.getvalue())
        self.assertEqual(server.auth_calls, ['key'])

    def test_unknown_and_changed_host_key_fail_before_authentication(self):
        server = self.fixture()
        for hosts in ('127.0.0.2 ' + fixtures.KEY,
                      '[127.0.0.1]:' + str(server.port) + ' ssh-rsa ' + paramiko.RSAKey.generate(2048).get_base64()):
            with self.subTest(case='untrusted key'), self.assertRaises(c.InventoryCollectionError) as error:
                self.collect_local(server, 'linux', ssh_known_hosts=hosts)
            self.assertEqual(error.exception.code, 'inventory_host_key_failed')
        self.assertEqual(server.auth_calls, [])

    def test_bad_password_has_safe_error_without_secret(self):
        server = self.fixture()
        with self.assertRaises(c.InventoryCollectionError) as error: self.collect_local(server, 'linux', password='DO_NOT_PRINT_FIXTURE')
        self.assertEqual(error.exception.code, 'inventory_auth_failed')
        self.assertNotIn('DO_NOT_PRINT_FIXTURE', str(error.exception))

    def test_stalled_shell_and_output_limit_close_transport(self):
        server = self.fixture(stall=True)
        before = time.monotonic()
        with patch.object(c, '_target', return_value='127.0.0.1'), self.assertRaises(c.InventoryCollectionError) as error:
            c._collect_impl(fixtures.target(), server.profile(), deadline=time.monotonic() + 0.2)
        self.assertEqual(error.exception.code, 'inventory_timeout'); self.assertLess(time.monotonic() - before, 1)
        oversized = self.fixture(huge=True)
        with self.assertRaises(c.InventoryCollectionError) as error: self.collect_local(oversized, 'linux')
        self.assertEqual(error.exception.code, 'inventory_output_limit')


@unittest.skipUnless(HAS_WINRM, 'Install the pinned inventory requirements for WinRM policy acceptance')
class WinRMPolicyTests(unittest.TestCase):
    def test_only_ntlm_encrypted_verified_transport_fixed_cim_script_and_cleanup(self):
        import requests
        for scheme in ('https', 'http'):
            with self.subTest(scheme=scheme):
                session = requests.Session()
                transport = types.SimpleNamespace(build_session=Mock(return_value=session), setup_encryption=Mock())
                protocol = types.SimpleNamespace(transport=transport, open_shell=Mock(return_value='shell'),
                    run_command=Mock(return_value='command'), get_command_output_raw=Mock(return_value=(b'{"hostname":"windows-fixture","interfaces":[],"disks":[]}', b'', 0, True)),
                    cleanup_command=Mock(), close_shell=Mock())
                with patch('winrm.protocol.Protocol', return_value=protocol) as constructor:
                    value = c._windows('192.0.2.5', c.validate_profile(fixtures.profile('windows', scheme=scheme)), c.Budget())
                kwargs = constructor.call_args.kwargs
                self.assertEqual(kwargs['message_encryption'], 'always')
                self.assertEqual(kwargs['server_cert_validation'], 'validate')
                self.assertIsNone(kwargs['proxy'])
                self.assertFalse(session.trust_env); self.assertEqual(session.proxies, {})
                self.assertEqual(value['hostname'], 'windows-fixture')
                command = protocol.run_command.call_args.args
                self.assertEqual(command[:2], ('shell', 'powershell.exe'))
                self.assertEqual(command[2][:3], ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
                protocol.cleanup_command.assert_called_once_with('shell', 'command'); protocol.close_shell.assert_called_once_with('shell')

    def test_failed_cim_query_does_not_return_empty_success(self):
        import requests
        protocol = types.SimpleNamespace(transport=types.SimpleNamespace(build_session=lambda: requests.Session(), setup_encryption=Mock()),
            open_shell=lambda: 's', run_command=lambda *args: 'c', get_command_output_raw=lambda *args: (b'', b'private raw error', 1, True), cleanup_command=Mock(), close_shell=Mock())
        with patch('winrm.protocol.Protocol', return_value=protocol), self.assertRaises(c.InventoryCollectionError) as error:
            c._windows('192.0.2.5', c.validate_profile(fixtures.profile('windows')), c.Budget())
        self.assertEqual(error.exception.code, 'inventory_command_failed')
        self.assertNotIn('private raw error', str(error.exception))

@unittest.skipUnless(HAS_WINRM, 'Install the pinned inventory requirements for real TLS acceptance')
class WinRMTLSBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import test_install_proxy as tls
        cls.tls = tls
        tls.DownloadTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        cls.tls.DownloadTests.tearDownClass.__func__(cls)

    def test_verified_tls_redirect_rejected_and_wrong_ca_never_reaches_http(self):
        import http.server
        import ssl
        class Redirect(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                self.server.posts += 1
                self.send_response(307)
                self.send_header('Location', 'https://127.0.0.1:9/never-follow')
                self.send_header('Content-Length', '0')
                self.send_header('Connection', 'close')
                self.end_headers()
        server = self.tls.FixtureServer(('127.0.0.1', 0), Redirect)
        server.posts, server.failures = 0, []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.base / 'origin.pem', self.base / 'origin.key')
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True); thread.start()
        self.addCleanup(self.tls.DownloadTests.close_server, server, thread)
        ca = (self.base / 'ca.pem').read_text()
        profile = c.validate_profile(fixtures.profile('windows', port=server.server_port, ca_pem=ca))
        with self.assertRaises(c.InventoryCollectionError) as error:
            c._windows('127.0.0.1', profile, c.Budget(time.monotonic() + 3))
        self.assertEqual(error.exception.code, 'inventory_connection_failed')
        self.assertEqual(server.posts, 1, 'Redirect must stop before creating a second connection')
        profile['ca_pem'] = (self.base / 'wrong.pem').read_text()
        with self.assertRaises(c.InventoryCollectionError) as error:
            c._windows('127.0.0.1', profile, c.Budget(time.monotonic() + 3))
        self.assertEqual(error.exception.code, 'inventory_tls_failed')
        self.assertEqual(server.posts, 1)


    def test_real_ntlm_401_handshake_retains_tls_raw_socket_for_channel_binding(self):
        import base64
        import http.server
        import os
        import ssl
        import tempfile
        from pathlib import Path
        import spnego
        from spnego.channel_bindings import GssChannelBindings
        from requests_ntlm.requests_ntlm import _get_certificate_hash
        certificate = ssl.PEM_cert_to_DER_cert((self.base / 'origin.pem').read_text())
        bindings = GssChannelBindings(application_data=b'tls-server-end-point:' + _get_certificate_hash(certificate))
        class NTLM(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args): pass
            def setup(self):
                super().setup(); self.ntlm = None
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                header = self.headers.get('Authorization', '')
                if not header:
                    challenge = None
                else:
                    token = base64.b64decode(header.split(' ', 1)[1])
                    self.server.types.append(int.from_bytes(token[8:12], 'little'))
                    if self.ntlm is None:
                        self.ntlm = spnego.server(protocol='ntlm', hostname='localhost', service='HTTP',
                            channel_bindings=bindings, options=spnego.NegotiateOptions.use_ntlm)
                    challenge = self.ntlm.step(token)
                    if self.ntlm.complete:
                        self.server.authenticated = True
                        self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers(); return
                self.send_response(401)
                self.send_header('WWW-Authenticate', 'NTLM' + (' ' + base64.b64encode(challenge).decode() if challenge else ''))
                self.send_header('Content-Length', '0'); self.end_headers()
        server = self.tls.FixtureServer(('127.0.0.1', 0), NTLM)
        server.authenticated, server.types, server.failures = False, [], []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.base / 'origin.pem', self.base / 'origin.key')
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True); thread.start()
        self.addCleanup(self.tls.DownloadTests.close_server, server, thread)
        with tempfile.TemporaryDirectory() as directory:
            users = Path(directory, 'ntlm-users'); users.write_text(':fixture-user:fixture-password\n'); users.chmod(0o600)
            def stop_after_auth(*args, **kwargs):
                self.assertTrue(server.authenticated, 'Real NTLM authentication must finish before opening the WinRM shell')
                raise c.InventoryCollectionError('inventory_command_failed')
            profile = c.validate_profile(fixtures.profile('windows', port=server.server_port, ca_pem=(self.base / 'ca.pem').read_text()))
            with patch.dict(os.environ, {'NTLM_USER_FILE': str(users)}), \
                 patch('winrm.protocol.Protocol.open_shell', side_effect=stop_after_auth), \
                 self.assertRaises(c.InventoryCollectionError) as error:
                c._windows('127.0.0.1', profile, c.Budget(time.monotonic() + 5))
            self.assertEqual(error.exception.code, 'inventory_command_failed')
        self.assertTrue(server.authenticated)
        self.assertEqual(server.types, [1, 3])


if __name__ == '__main__': unittest.main()
