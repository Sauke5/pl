"""Finite GitHub proxy settings and real loopback CONNECT/SOCKS/TLS acceptance."""
import base64
import contextlib
from contextlib import nullcontext
import copy
import hashlib
import hmac
import importlib.util
import json
import io
from pathlib import Path
import select
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
import uuid
from unittest.mock import Mock, patch

import test_install_proxy as fixtures

SPEC = importlib.util.spec_from_file_location('pl_delivery_proxy_test', Path(__file__).resolve().parents[1] / 'delivery-proxy.py')
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


def backend(root):
    for name in ('private', 'state', 'modules', 'releases'):
        (root / name).mkdir(mode=0o700)
    return p.files.Delivery(types.SimpleNamespace(root=root, installation='pl-proxy-fixture'))


def external(protocol='http', port=1080, ca=''):
    return {'mode': 'external', 'ca_pem': ca, 'external': {'protocol': protocol, 'host': '127.0.0.1', 'port': port,
            'auth': 'password', 'username': 'fixture-user', 'password_action': 'set', 'password': 'fixture-password'}}


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.delivery = backend(self.root)
        self.proxy = p.DeliveryProxy(self.delivery)

    def request(self, configuration, revision=0):
        return {'operation_id': str(uuid.uuid4()), 'revision': revision, 'configuration': configuration}

    def test_atomic_revision_idempotency_secret_keep_clear_and_public_projection(self):
        initial = self.request(external())
        result = self.proxy.configure(initial)
        self.assertEqual(result['revision'], 1)
        self.assertTrue(result['configuration']['external']['password_configured'])
        self.assertNotIn('fixture-password', json.dumps(result))
        self.assertEqual(self.proxy.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.proxy.configure(initial)['revision'], 1)
        changed = copy.deepcopy(initial); changed['configuration']['external']['port'] = 1081
        with self.assertRaises(p.ProxyError) as failure:
            self.proxy.configure(changed)
        self.assertEqual(failure.exception.public_code, 'delivery_proxy_conflict')
        keep = external(); keep['external'].pop('password'); keep['external']['password_action'] = 'keep'
        self.assertEqual(self.proxy.configure(self.request(keep, 1))['revision'], 2)
        self.assertEqual(self.proxy.load()['configuration']['external']['password'], 'fixture-password')
        keep['external']['host'] = 'other.invalid'
        with self.assertRaises(p.ProxyError): self.proxy.configure(self.request(keep, 2))
        clear = external(); clear['external'].update(auth='none', username='', password_action='clear'); clear['external'].pop('password')
        self.assertFalse(self.proxy.configure(self.request(clear, 2))['configuration']['external']['password_configured'])
        self.assertEqual(self.proxy.configure(initial)['revision'], 3)
        self.assertNotIn('fixture-password', self.proxy.path.read_text())

    def test_profiles_fail_closed_for_invalid_auth_types_urls_ca_and_permissions(self):
        invalid = []
        for key, value in (('host', 'http://proxy.invalid:1080'), ('host', 'host/path'), ('port', True),
                           ('username', 'user\nheader'), ('username', 'user:name'), ('password', 'x' * 1025),
                           ('password_action', 'clear')):
            candidate = external(); candidate['external'][key] = value; invalid.append(candidate)
        candidate = external('socks5'); candidate['external']['password'] = 'я' * 128; invalid.append(candidate)
        invalid += [{'mode': 'direct', 'external': {}}, {'mode': 'unknown'}, {'mode': 'direct', 'ca_pem': 'PRIVATE KEY'},
                    {'mode': 'xray', 'xray': {'instance_id': '../outside', 'inbound_tag': 'local'}}]
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(p.ProxyError):
                self.proxy.configure(self.request(candidate))
        self.assertFalse(self.proxy.path.exists())
        self.proxy.configure(self.request(external()))
        self.proxy.path.chmod(0o644)
        with self.assertRaises(p.ProxyError): self.proxy.status({})

    def test_mutation_and_dry_run_share_delivery_worker_and_lifecycle_guards(self):
        for lock in (self.delivery.lock, self.delivery.worker_lock, self.delivery.lifecycle_lock):
            with self.subTest(lock=lock), lock(), self.assertRaises(p.ProxyError) as failure:
                self.proxy.configure(self.request(external()))
            self.assertEqual(failure.exception.public_code, 'delivery_proxy_busy')
        p.files.atomic(self.delivery.base / 'operation.json', {'phase': 'applying'})
        with self.assertRaises(p.ProxyError) as failure:
            self.proxy.test({'revision': 0, 'configuration': {'mode': 'direct'}})
        self.assertEqual(failure.exception.public_code, 'delivery_proxy_busy')
        self.assertFalse(self.proxy.path.exists())

    def test_managed_xray_uses_existing_owned_plan_and_tracks_credentials_without_copying_secrets(self):
        instance = str(uuid.uuid4())
        (self.root / 'modules/xray/instances' / instance).mkdir(parents=True)
        public = {'tag': 'local', 'protocol': 'socks', 'listen': '127.0.0.1', 'port': 18080, 'auth': 'password'}
        account = {'user': 'private-user', 'pass': 'first-private-password'}
        plan = {'public': {'inbounds': [public]}, 'config': {'inbounds': [{'tag': 'local', 'settings': {'accounts': [account]}}]}}
        xray = types.SimpleNamespace(instance_lock=lambda _: nullcontext(), active=lambda _: {'current': 'ref'},
                                     selected=lambda *_: plan, inspect=Mock(return_value={'State': {'Running': True}}))
        self.delivery.parent.xray = lambda: xray
        selection = {'mode': 'xray', 'xray': {'instance_id': instance, 'inbound_tag': 'local'}}
        result = self.proxy.configure(self.request(selection))
        self.assertEqual(result['xray_inbounds'][0]['protocol'], 'socks5')
        self.assertEqual(self.proxy.route(self.proxy.load()['configuration'])['password'], account['pass'])
        account['pass'] = 'rotated-private-password'
        self.assertEqual(self.proxy.route(self.proxy.load()['configuration'])['password'], account['pass'])
        self.assertNotIn('private-password', self.proxy.path.read_text())
        xray.inspect.return_value = {'State': {'Running': False}}
        self.assertEqual(self.proxy.status({})['error_code'], 'delivery_proxy_unavailable')
        with self.assertRaises(p.ProxyError): self.proxy.route(self.proxy.load()['configuration'])
        xray.inspect.side_effect = ValueError('foreign container with private diagnostic data')
        result = self.proxy.status({})
        self.assertNotIn('private diagnostic', json.dumps(result))

    def test_xray_candidates_and_status_are_bounded_without_private_fields(self):
        instance = str(uuid.uuid4())
        (self.root / 'modules/xray/instances' / instance).mkdir(parents=True)
        items = [{'tag': 'inbound-' + str(i), 'protocol': 'http', 'listen': '127.0.0.1', 'port': 18000 + i, 'auth': 'none'} for i in range(80)]
        self.delivery.parent.xray = lambda: types.SimpleNamespace(instance_lock=lambda _: nullcontext(), active=lambda _: {'current': 'ref'},
            selected=lambda *_: {'public': {'inbounds': items}}, inspect=lambda _: {'State': {'Running': True}})
        result = self.proxy.status({})
        self.assertEqual(len(result['xray_inbounds']), 64)
        self.assertLess(len(json.dumps(result).encode()), 65536)


class Origin(fixtures.Origin):
    def do_GET(self):
        self.server.observations.append({'path': self.path, 'headers': dict(self.headers)})
        body = self.server.body
        if self.server.slow_headers:
            for byte in b'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n':
                self.wfile.write(bytes((byte,))); self.wfile.flush(); time.sleep(0.03)
            return
        self.send_response(302 if self.path == '/redirect' else 200)
        if self.path == '/redirect': self.send_header('Location', self.server.redirect_url)
        if not self.server.omit_length: self.send_header('Content-Length', str(0 if self.path == '/redirect' else len(body)))
        self.send_header('Connection', 'close'); self.end_headers()
        if self.path != '/redirect':
            if self.server.slow_body:
                for byte in body:
                    self.wfile.write(bytes((byte,))); self.wfile.flush(); time.sleep(0.03)
            else:
                self.wfile.write(body)


class Socks(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        def exact(count):
            data = bytearray()
            while len(data) < count:
                block = self.request.recv(count - len(data))
                if not block: raise OSError('closed fixture socket')
                data.extend(block)
            return bytes(data)
        try:
            greeting = exact(2); methods = exact(greeting[1])
            self.server.observations.append({'methods': list(methods)})
            method = 2 if self.server.auth else 0
            if greeting[0] != 5 or method not in methods:
                self.request.sendall(b'\x05\xff'); return
            self.request.sendall(bytes((5, method)))
            if method == 2:
                version, length = exact(2)
                user = exact(length); length = exact(1)[0]; password = exact(length)
                accepted = version == 1 and user == b'fixture-user' and password == b'fixture-password'
                self.request.sendall(bytes((1, 0 if accepted else 1)))
                if not accepted: return
            header = exact(4)
            if header != b'\x05\x01\x00\x03': return
            name = exact(exact(1)[0]).decode('ascii'); port = int.from_bytes(exact(2), 'big')
            self.server.observations.append({'atyp': header[3], 'host': name, 'port': port})
            if self.server.malformed:
                self.request.sendall(b'\x05\x00\x00\xff'); return
            if name not in ('origin.test', 'sub.origin.test') or port != self.server.origin_port:
                self.request.sendall(b'\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00'); return
            with socket.create_connection(('127.0.0.1', port), timeout=3) as upstream:
                self.request.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    ready, _, _ = select.select([self.request, upstream], [], [], 0.1)
                    for source in ready:
                        data = source.recv(65536)
                        if not data: return
                        (upstream if source is self.request else self.request).sendall(data)
        except OSError:
            pass


class SocksServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    block_on_close = False


class NetworkTests(unittest.TestCase):
    close_server = staticmethod(fixtures.DownloadTests.close_server)

    @classmethod
    def setUpClass(cls):
        fixtures.DownloadTests.setUpClass.__func__(cls)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.release_private, cls.release_public = cls.base / 'release-private.pem', cls.base / 'release-public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(cls.release_private)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(cls.release_private), '-pubout', '-out', str(cls.release_public)], check=True, capture_output=True)

    def setUp(self):
        fixtures.DownloadTests.setUp(self)
        self.origin.RequestHandlerClass = Origin
        self.origin.body = b'PL proxy acceptance payload\n'
        self.origin.omit_length = False
        self.origin.slow_headers = self.origin.slow_body = False
        self.socks = SocksServer(('127.0.0.1', 0), Socks)
        self.socks.auth, self.socks.malformed = True, False
        self.socks.origin_port, self.socks.observations = self.origin.server_port, []
        thread = threading.Thread(target=self.socks.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True); thread.start()
        self.addCleanup(self.close_server, self.socks, thread)
        self.root = Path(self.download_dir.name) / 'managed'; self.root.mkdir(mode=0o700)
        self.delivery = backend(self.root); self.delivery.key = self.release_public
        self.client = p.DeliveryProxy(self.delivery)
        self.ca = (self.base / 'ca.pem').read_text()
        original = p.files.asset_url
        def fixture_url(url, redirect=False):
            value = urllib.parse.urlsplit(url)
            if value.scheme == 'https' and value.hostname in ('origin.test', 'sub.origin.test') and value.port == self.origin.server_port:
                return url
            return original(url, redirect=redirect)
        guard = patch.object(p.files, 'asset_url', side_effect=fixture_url); guard.start(); self.addCleanup(guard.stop)

    def configuration(self, protocol='http'):
        return external(protocol, self.proxy.server_port if protocol == 'http' else self.socks.server_address[1], self.ca)

    def download(self, configuration, *, expected=None, size=100):
        return self.client.download(self.url, self.destination, size, expected,
                                    configuration=p.normalize(configuration, {}))

    def signed(self, *, sequence=7, expires=None):
        value = {'schema': 1, 'product': 'PL', 'core_api': 1, 'sequence': sequence, 'version': '0.4.0',
                 'core': {'amd64': {'url': 'https://github.com/Sauke5/pl/releases/download/v0.4.0/core.tar.gz',
                                     'sha256': 'a' * 64, 'size': 100}}, 'modules': {}}
        if expires is not None: value['expires_at'] = expires
        payload = p.files.json_bytes(value); source = self.root / 'signed.json'; source.write_bytes(payload)
        signature = subprocess.check_output(['openssl', 'pkeyutl', '-sign', '-inkey', str(self.release_private), '-rawin', '-in', str(source)])
        return {'payload': base64.b64encode(payload).decode(), 'signature': base64.b64encode(signature).decode()}

    def test_authenticated_http_connect_ignores_ambient_proxy_and_keeps_auth_out_of_origin(self):
        with patch.dict('os.environ', {'HTTPS_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': '*', 'ALL_PROXY': 'http://127.0.0.1:9'}):
            self.download(self.configuration())
        self.assertEqual(self.destination.read_bytes(), self.origin.body)
        self.assertEqual(len(self.proxy.observations), 1)
        self.assertFalse(any(k.lower() == 'proxy-authorization' for k in self.origin.observations[0]['headers']))

    def test_socks_auth_and_remote_dns_are_real_tunnel_messages(self):
        original = socket.getaddrinfo
        def proxy_only(host, port, *args, **kwargs):
            if host not in ('127.0.0.1', 'localhost', '::1'): raise AssertionError('Destination DNS must remain on SOCKS proxy')
            return original(host, port, *args, **kwargs)
        with patch.object(socket, 'getaddrinfo', side_effect=proxy_only): self.download(self.configuration('socks5'))
        self.assertEqual(self.destination.read_bytes(), self.origin.body)
        self.assertEqual(self.socks.observations, [{'methods': [2]}, {'atyp': 3, 'host': 'origin.test', 'port': self.origin.server_port}])

    def test_unauthenticated_socks_and_allowed_redirect_use_the_same_selected_route(self):
        self.socks.auth = False
        candidate = self.configuration('socks5'); candidate['external'].update(auth='none', username='', password_action='clear')
        candidate['external'].pop('password')
        self.origin.redirect_url = self.url
        self.url = self.url.replace('/package', '/redirect')
        self.download(candidate, expected=hashlib.sha256(self.origin.body).hexdigest(), size=len(self.origin.body))
        self.assertEqual(self.destination.read_bytes(), self.origin.body)
        self.assertEqual(len(self.socks.observations), 4)
        self.assertEqual(self.socks.observations[0], {'methods': [0]})

    def test_proxy_failure_wrong_password_and_bad_socks_reply_never_fall_back(self):
        for protocol in ('http', 'socks5'):
            candidate = self.configuration(protocol); candidate['external']['password'] = 'wrong-private-password'
            with self.subTest(protocol=protocol), self.assertRaises(p.ProxyError) as failure: self.download(candidate)
            self.assertEqual(failure.exception.public_code, 'delivery_proxy_auth')
            self.assertNotIn('wrong-private-password', str(failure.exception))
            self.assertFalse(self.destination.exists())
        self.assertEqual(self.origin.observations, [])
        self.socks.malformed = True
        with self.assertRaises(p.ProxyError): self.download(self.configuration('socks5'))
        self.assertEqual(self.origin.observations, [])
        with patch.object(socket, 'create_connection', side_effect=ConnectionRefusedError('private endpoint')) as connect:
            with self.assertRaises(p.ProxyError) as failure: self.download(self.configuration())
            self.assertEqual(failure.exception.public_code, 'delivery_proxy_unavailable')
            connect.assert_called_once()
        with patch.object(socket, 'create_connection', side_effect=socket.timeout('private exception detail')):
            with self.assertRaises(p.ProxyError) as failure: self.download(self.configuration())
        self.assertEqual(failure.exception.public_code, 'delivery_proxy_timeout')
        self.assertNotIn('private exception detail', str(failure.exception))
        self.assertEqual(self.origin.observations, [])

    def test_total_budget_interrupts_slow_body_and_headers_and_releases_operation_locks(self):
        request = {'revision': 0, 'configuration': self.configuration()}
        self.origin.body = b'0123456789'
        for phase in ('slow_body', 'slow_headers'):
            with self.subTest(phase=phase):
                self.origin.slow_body = phase == 'slow_body'; self.origin.slow_headers = phase == 'slow_headers'
                started = time.monotonic()
                with patch.object(p, 'TEST_TIMEOUT', 0.08), patch.object(p.files, 'CATALOG_URL', self.url):
                    result = self.client.test(request)
                self.assertFalse(result['ok'])
                self.assertEqual(result['error_code'], 'delivery_proxy_timeout')
                self.assertLess(time.monotonic() - started, 0.25)
                with self.delivery.lock(blocking=False), self.delivery.worker_lock(blocking=False), self.delivery.lifecycle_lock(blocking=False): pass
                self.assertFalse(self.client.path.exists())
                self.assertFalse((self.delivery.base / 'catalog.json').exists())
                self.assertFalse(self.destination.exists())

    def test_tls_ca_hostname_redirect_and_stream_integrity_stay_enforced(self):
        candidate = self.configuration(); candidate['ca_pem'] = (self.base / 'wrong.pem').read_text()
        with self.assertRaises(p.ProxyError) as failure: self.download(candidate)
        self.assertEqual(failure.exception.public_code, 'delivery_proxy_tls')
        self.url = self.url.replace('origin.test', 'sub.origin.test')
        with self.assertRaises(p.ProxyError) as failure: self.download(self.configuration('socks5'))
        self.assertEqual(failure.exception.public_code, 'delivery_proxy_tls')
        self.url = self.url.replace('sub.origin.test', 'origin.test')
        self.origin.omit_length = True
        with self.assertRaises(p.ProxyError): self.download(self.configuration(), size=3)
        with self.assertRaises(p.ProxyError): self.download(self.configuration(), expected='0' * 64, size=len(self.origin.body))
        self.assertFalse(self.destination.exists())
        self.origin.redirect_url = 'https://169.254.169.254/latest/metadata'
        self.url = self.url.replace('/package', '/redirect')
        with self.assertRaises(p.ProxyError): self.download(self.configuration())
        self.assertFalse(self.destination.exists())

    def test_dry_run_verifies_real_signed_catalog_and_never_persists_candidate_or_cache(self):
        self.origin.body = p.files.json_bytes(self.signed())
        request = {'revision': 0, 'configuration': self.configuration('socks5')}
        with patch.object(p.files, 'CATALOG_URL', self.url): result = self.client.test(request)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['latest_version'], '0.4.0')
        self.assertFalse(self.client.path.exists())
        self.assertFalse((self.delivery.base / 'catalog.json').exists())
        cached = self.signed(sequence=8); p.files.atomic(self.delivery.base / 'catalog.json', cached)
        for envelope in (self.signed(sequence=7), self.signed(sequence=9, expires=1),
                         {**self.signed(sequence=9), 'signature': base64.b64encode(b'x' * 64).decode()}):
            self.origin.body = p.files.json_bytes(envelope)
            with patch.object(p.files, 'CATALOG_URL', self.url): result = self.client.test(request)
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'delivery_proxy_catalog')
            self.assertEqual(p.files.read(self.delivery.base / 'catalog.json'), cached)
        self.assertFalse(self.client.path.exists())


class SignedRouteTests(unittest.TestCase):
    key = b'proxy-boundary-fixture-key'
    now = 1700000000

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('pl_proxy_rpc_controller', Path(__file__).resolve().parents[1] / 'module-controller.py')
        cls.controller_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.controller_module)

    def request(self, path, body, signed_path=None, failure=None):
        raw = json.dumps(body).encode(); timestamp = str(self.now)
        signature = hmac.new(self.key, (timestamp + '\nPOST\n' + (signed_path or path) + '\n').encode() + raw, hashlib.sha256).hexdigest()
        methods = types.SimpleNamespace(**{name: Mock(return_value={'action': name}) for name in ('status', 'configure', 'test')})
        if failure is not None: methods.configure.side_effect = failure
        controller = types.SimpleNamespace(delivery=Mock(return_value=types.SimpleNamespace(github_proxy=Mock(return_value=methods))))
        handler = object.__new__(self.controller_module.Handler)
        handler.command, handler.path = 'POST', path
        handler.headers = {'Content-Length': str(len(raw)), 'X-PL-Timestamp': timestamp, 'X-PL-Signature': signature}
        handler.server = types.SimpleNamespace(key=self.key, controller=controller)
        handler.rfile = io.BytesIO(raw); replies = []; handler.reply = lambda code, data: replies.append((code, data))
        output = io.StringIO()
        with patch.object(self.controller_module.time, 'time', return_value=self.now), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output): handler.handle_request()
        self.assertEqual(output.getvalue(), '')
        return replies, controller

    def test_only_authenticated_exact_bounded_routes_reach_the_lazy_helper(self):
        for name in ('status', 'configure', 'test'):
            replies, _ = self.request('/v1/delivery/proxy/' + name, {})
            self.assertEqual(replies, [(200, {'action': name})])
        replies, controller = self.request('/v1/delivery/proxy/configure', external(), signed_path='/v1/delivery/proxy/test')
        self.assertEqual(replies[0][0], 403); controller.delivery.assert_not_called()
        replies, controller = self.request('/v1/delivery/proxy/test', {'password': 'x' * (96 * 1024)})
        self.assertEqual(replies[0][0], 400); controller.delivery.assert_not_called()
        replies, controller = self.request('/v1/delivery/proxy/exec', {})
        self.assertEqual(replies[0][0], 404); controller.delivery.assert_not_called()

    def test_only_fixed_proxy_error_codes_and_messages_cross_the_signed_boundary(self):
        for code, (status, message) in p.ERRORS.items():
            replies, _ = self.request('/v1/delivery/proxy/configure', {}, failure=p.ProxyError(code))
            self.assertEqual(replies, [(status, {'error': {'code': code, 'message': message}})])
        failure = ValueError('private-password-and-endpoint'); failure.public_code = 'unreviewed'
        replies, _ = self.request('/v1/delivery/proxy/configure', {}, failure=failure)
        self.assertNotIn('private-password', json.dumps(replies))


if __name__ == '__main__': unittest.main()
