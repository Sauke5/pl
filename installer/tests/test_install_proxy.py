"""Download-proxy contract tests. Only loopback sockets and CI-generated TLS keys.

These tests do not install packages, invoke Docker, or contact public endpoints.
The origin.test name is mapped to loopback inside each test; the CONNECT fixture
also accepts only that origin and its actual ephemeral port.
"""
import base64
import contextlib
import hashlib
import hmac
import http.server
import io
import json
import os
from pathlib import Path
import select
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'install.sh'
SOURCE = SCRIPT.read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]


class FixtureServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, request, address):
        # Failed TLS/tunnel cases are expected; never emit request headers.
        self.failures.append('connection-closed')


class Origin(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.observations.append({'path': self.path, 'headers': dict(self.headers)})
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', self.server.redirect_url)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
            return
        body = b'PL proxy acceptance payload\n'
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)


class Connect(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        self.server.observations.append({'authority': self.path, 'headers': dict(self.headers)})
        expected = 'Basic ' + base64.b64encode(b'fixture-user:fixture-password').decode()
        status = self.server.response_status
        if self.headers.get('Proxy-Authorization') != expected:
            status = 407
        if self.path != 'origin.test:' + str(self.server.origin_port):
            status = 502
        if status != 200:
            self.send_response(status)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            if status == 407:
                self.send_header('Proxy-Authenticate', 'Basic realm="local-fixture"')
            self.end_headers()
            return
        with socket.create_connection(('127.0.0.1', self.server.origin_port), timeout=3) as upstream:
            self.send_response(200, 'Connection established')
            self.end_headers()
            self.wfile.flush()
            self.connection.settimeout(3)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                ready, _, _ = select.select([self.connection, upstream], [], [], 0.1)
                for source in ready:
                    data = source.recv(64 * 1024)
                    if not data:
                        return
                    destination = upstream if source is self.connection else self.connection
                    destination.sendall(data)


def installer_module():
    module = types.ModuleType('pl_install_proxy_test')
    exec(compile(SOURCE, str(SCRIPT), 'exec'), module.__dict__)
    return module


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.module = installer_module()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / 'proxy.json'

    def profile(self, value=None):
        self.path.write_text(json.dumps(value or {'url': 'http://proxy.example:3128'}))
        self.path.chmod(0o600)
        return self.path

    def rejected(self, path):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(self.module.InstallError) as caught:
                self.module.load_download_proxy(path)
        text = str(caught.exception) + output.getvalue()
        self.assertTrue('fixture-password' not in text and 'fixture-user' not in text and 'proxy.example' not in text,
                        'Invalid profile diagnostics must not disclose supplied fields')

    def test_profile_accepts_explicit_http_proxy_credentials_and_exceptions(self):
        profile = {'url': 'http://proxy.example:3128', 'username': 'fixture-user', 'password': 'fixture-password',
                   'no_proxy': ['origin.test', '.internal.test', '10.20.0.0/16', 'fd00::/8']}
        self.assertTrue(self.module.load_download_proxy(self.profile(profile)) == profile, 'Valid private profile must preserve selected fields')
        self.assertEqual(self.module.load_download_proxy(self.profile()), {'url': 'http://proxy.example:3128'})

    def test_invalid_profiles_fail_without_echoing_credentials_or_address(self):
        profiles = [[], {'url': 'https://proxy.example:3128'}, {'url': 'socks5://proxy.example:1080'},
                    {'url': 'http://proxy.example'}, {'url': 'http://fixture-user:fixture-password@proxy.example:3128'},
                    {'url': 'http://proxy.example:3128/path'}, {'url': 'http://proxy.example:3128?token=fixture-password'},
                    {'url': 'http://proxy.example:3128', 'username': 'fixture-user'},
                    {'url': 'http://proxy.example:3128', 'password': 'fixture-password'},
                    {'url': 'http://proxy.example:3128', 'username': 'x:y', 'password': 'fixture-password'},
                    {'url': 'http://proxy.example:3128', 'username': 'fixture-user', 'password': 'line\nbreak'},
                    {'url': 'http://proxy.example:3128', 'no_proxy': '*'},
                    {'url': 'http://proxy.example:3128', 'no_proxy': ['*']},
                    {'url': 'http://proxy.example:3128', 'no_proxy': ['10.20.1.1/16']},
                    {'url': 'http://proxy.example:3128', 'no_proxy': ['origin.test:443']},
                    {'url': 'http://proxy.example:3128', 'unknown': 'fixture-password'},
                    {'url': 'http://proxy.example:3128', 'ca_file': 'relative.pem'}]
        for profile in profiles:
            with self.subTest(profile_type=type(profile).__name__):
                self.path.write_text(json.dumps(profile)); self.path.chmod(0o600)
                self.rejected(self.path)

    def test_profile_requires_regular_owner_only_bounded_file_and_no_symlink_parents(self):
        self.profile()
        self.path.chmod(0o640); self.rejected(self.path)
        self.path.chmod(0o600)
        with patch.object(self.module.os, 'geteuid', return_value=os.geteuid() + 1):
            self.rejected(self.path)
        alias = self.root / 'alias.json'; alias.symlink_to(self.path)
        self.rejected(alias)
        directory = self.root / 'private'; directory.mkdir()
        nested = directory / 'proxy.json'; nested.write_bytes(self.path.read_bytes()); nested.chmod(0o600)
        linked = self.root / 'linked'; linked.symlink_to(directory, target_is_directory=True)
        self.rejected(linked / 'proxy.json')
        self.path.write_bytes(b'x' * 16385); self.rejected(self.path)
        self.path.write_bytes(b'{invalid-json'); self.rejected(self.path)
        self.rejected(directory)
        self.rejected(self.root / 'missing.json')
        fifo = self.root / 'profile.fifo'; os.mkfifo(fifo, mode=0o600)
        self.rejected(fifo)

    def test_no_proxy_match_is_explicit_and_respects_domain_boundaries(self):
        cases = [('origin.test', ['origin.test'], True), ('Origin.Test', ['origin.test'], True),
                 ('sub.origin.test', ['origin.test'], False), ('evil-origin.test', ['.origin.test'], False),
                 ('origin.test.evil', ['.origin.test'], False), ('origin.test', ['.origin.test'], True),
                 ('sub.origin.test', ['.origin.test'], True), ('10.20.1.2', ['10.20.0.0/16'], True),
                 ('10.21.1.2', ['10.20.0.0/16'], False), ('fd00::12', ['fd00::/8'], True),
                 ('localhost', [], True), ('127.0.0.1', [], True), ('127.99.1.2', [], True), ('::1', [], True)]
        for host, exceptions, expected in cases:
            with self.subTest(host=host, exceptions=exceptions):
                self.assertIs(self.module.download_bypasses_proxy(host, exceptions), expected)

    def test_cli_invalid_proxy_file_stops_before_host_preflight(self):
        self.profile(); self.path.chmod(0o644)
        with patch.object(self.module, 'preflight') as preflight, patch.object(self.module, 'prepare_root') as prepare:
            with self.assertRaises(self.module.InstallError):
                self.module.main(['--check', '--download-proxy-file', str(self.path)])
            preflight.assert_not_called(); prepare.assert_not_called()

    def test_cli_passes_selected_profile_to_package_and_docker_key_download_only(self):
        profile = {'url': 'http://proxy.example:3128', 'username': 'fixture-user', 'password': 'fixture-password'}
        self.profile(profile)
        calls = []
        def download(url, destination, limit=self.module.MAX_PACKAGE, proxy=None):
            self.assertTrue(proxy == profile, 'Selected proxy profile must reach the download helper')
            calls.append(('download', url))
            destination.write_bytes(b'fixture')
        with patch.object(self.module, 'preflight', return_value={'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64'}), \
                patch.object(self.module, 'download', side_effect=download), patch.object(self.module, 'verify_package', return_value={'version': 'test'}), \
                patch.object(self.module, 'prepare_root'), patch.object(self.module, 'stage_release', return_value=self.root / 'release'), \
                patch.object(self.module, 'install_docker') as docker, patch.object(self.module, 'ensure_openssl'), \
                patch.object(self.module, 'run') as run, contextlib.redirect_stdout(io.StringIO()) as output:
            self.module.main(['--root', str(self.root / 'install'), '--package-url', 'https://origin.test/package',
                              '--package-sha256', hashlib.sha256(b'fixture').hexdigest(), '--public-url', 'https://pl.example',
                              '--self-signed', '--download-proxy-file', str(self.path)])
            self.assertEqual(len(calls), 1)
            self.assertTrue(docker.call_args.kwargs.get('download_proxy') == profile, 'Selected profile must reach Docker key preparation')
            diagnostics = repr(run.call_args_list) + output.getvalue()
            self.assertTrue('fixture-password' not in diagnostics and 'fixture-user' not in diagnostics,
                            'Credentials must not enter subprocess argv or user output')


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which('openssl') is None:
            raise RuntimeError('OpenSSL is required for real local TLS proxy acceptance; no synthetic fallback')
        cls.temp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.temp.name).resolve()
        def openssl(*args):
            result = subprocess.run(['openssl', *args], cwd=cls.base, stdin=subprocess.DEVNULL,
                                    capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError('CI TLS fixture generation failed; output suppressed')
        try:
            openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=PL fixture CA',
                    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                    '-addext', 'subjectKeyIdentifier=hash', '-keyout', 'ca.key', '-out', 'ca.pem')
            openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=origin.test',
                    '-keyout', 'origin.key', '-out', 'origin.csr')
            (cls.base / 'origin.ext').write_text('subjectAltName=DNS:origin.test,DNS:localhost,IP:127.0.0.1,IP:192.0.2.10\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
            openssl('x509', '-req', '-days', '1', '-in', 'origin.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
                    '-CAcreateserial', '-extfile', 'origin.ext', '-out', 'origin.pem')
            openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Different fixture CA',
                    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                    '-addext', 'subjectKeyIdentifier=hash', '-keyout', 'wrong.key', '-out', 'wrong.pem')
        except Exception:
            cls.temp.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.module = installer_module()
        self.download_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.download_dir.cleanup)
        self.destination = Path(self.download_dir.name) / 'payload'
        self.origin = FixtureServer(('127.0.0.1', 0), Origin)
        self.origin.observations, self.origin.failures = [], []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.base / 'origin.pem', self.base / 'origin.key')
        self.origin.socket = context.wrap_socket(self.origin.socket, server_side=True)
        self.proxy = FixtureServer(('127.0.0.1', 0), Connect)
        self.proxy.observations, self.proxy.failures = [], []
        self.proxy.origin_port, self.proxy.response_status = self.origin.server_port, 200
        for server in (self.origin, self.proxy):
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
            thread.start()
            self.addCleanup(self.close_server, server, thread)
        self.profile = {'url': 'http://127.0.0.1:' + str(self.proxy.server_port), 'username': 'fixture-user',
                        'password': 'fixture-password', 'ca_file': str(self.base / 'ca.pem')}
        profile_path = Path(self.download_dir.name) / 'proxy.json'
        profile_path.write_text(json.dumps(self.profile)); profile_path.chmod(0o600)
        self.profile = self.module.load_download_proxy(profile_path)
        self.url = 'https://origin.test:' + str(self.origin.server_port) + '/package'
        original = socket.getaddrinfo
        def local_dns(host, port, *args, **kwargs):
            if host in ('origin.test', 'sub.origin.test', '192.0.2.10'):
                host = '127.0.0.1'
            if host not in ('127.0.0.1', 'localhost', '::1'):
                raise AssertionError('Proxy acceptance attempted a non-local network destination')
            return original(host, port, *args, **kwargs)
        dns = patch.object(socket, 'getaddrinfo', side_effect=local_dns)
        dns.start()
        self.addCleanup(dns.stop)

    @staticmethod
    def close_server(server, thread):
        server.shutdown(); server.server_close(); thread.join(timeout=2)

    def assert_payload(self):
        self.assertEqual(self.destination.read_bytes(), b'PL proxy acceptance payload\n')
        self.assertEqual(len(self.origin.observations), 1)
        self.assertFalse(any(key.lower() == 'proxy-authorization' for key in self.origin.observations[0]['headers']))

    def test_authenticated_connect_ignores_ambient_no_proxy_and_never_forwards_credentials(self):
        environment = {'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
                       'http_proxy': 'http://127.0.0.1:9', 'https_proxy': 'http://127.0.0.1:9',
                       'NO_PROXY': '*', 'no_proxy': '*'}
        with patch.dict(os.environ, environment), contextlib.redirect_stdout(io.StringIO()) as output:
            self.module.download(self.url, self.destination, proxy=self.profile)
        self.assert_payload()
        self.assertEqual(len(self.proxy.observations), 1)
        connect = self.proxy.observations[0]
        self.assertEqual(connect['authority'], 'origin.test:' + str(self.origin.server_port))
        expected_auth = 'Basic ' + base64.b64encode(b'fixture-user:fixture-password').decode()
        self.assertTrue(hmac.compare_digest(connect['headers'].get('Proxy-Authorization', ''), expected_auth),
                        'CONNECT must authenticate against the selected proxy')
        self.assertTrue('fixture-password' not in output.getvalue() and 'fixture-user' not in output.getvalue(),
                        'Download output must not disclose proxy credentials')

    def test_default_direct_mode_ignores_environment_proxy(self):
        environment = {'SSL_CERT_FILE': str(self.base / 'ca.pem'), 'HTTPS_PROXY': self.profile['url'],
                       'https_proxy': self.profile['url'], 'NO_PROXY': '', 'no_proxy': ''}
        with patch.dict(os.environ, environment):
            self.module.download(self.url, self.destination)
        self.assert_payload()
        self.assertEqual(len(self.proxy.observations), 0)

    def test_explicit_exact_and_suffix_bypass_uses_verified_direct_tls(self):
        for exceptions in (['origin.test'], ['.origin.test']):
            with self.subTest(exceptions=exceptions):
                self.destination.unlink(missing_ok=True)
                self.origin.observations.clear()
                self.module.download(self.url, self.destination, proxy=dict(self.profile, no_proxy=exceptions))
                self.assert_payload()
                self.assertEqual(len(self.proxy.observations), 0)

    def test_explicit_cidr_bypass_uses_verified_direct_tls(self):
        # RFC5737 fixture address is mapped to loopback by local_dns; it never
        # enters host routing. Unlike 127/8 it exercises the selected CIDR rule.
        self.module.download('https://192.0.2.10:' + str(self.origin.server_port) + '/package', self.destination,
                             proxy=dict(self.profile, no_proxy=['192.0.2.0/24']))
        self.assert_payload()
        self.assertEqual(len(self.proxy.observations), 0)

    def test_literal_loopback_is_always_direct_even_with_unavailable_proxy(self):
        self.module.download('https://127.0.0.1:' + str(self.origin.server_port) + '/package', self.destination,
                             proxy=dict(self.profile, url='http://127.0.0.1:9'))
        self.assert_payload()
        self.assertEqual(len(self.proxy.observations), 0)

    def test_proxy_407_and_502_fail_without_direct_fallback_or_secret_output(self):
        for status in (407, 502):
            self.proxy.response_status = status
            with self.subTest(status=status), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as error:
                with self.assertRaises(self.module.InstallError) as caught:
                    self.module.download(self.url, self.destination, proxy=self.profile)
                text = output.getvalue() + error.getvalue() + str(caught.exception)
                self.assertTrue('fixture-password' not in text and 'fixture-user' not in text and self.url not in text,
                                'Failure diagnostics must not disclose credentials or target URL')
            self.assertEqual(len(self.origin.observations), 0)
            self.assertFalse(self.destination.exists())
        self.assertEqual(len(self.proxy.observations), 2)

    def test_wrong_ca_and_wrong_hostname_do_not_disable_certificate_validation(self):
        with self.assertRaises(self.module.InstallError):
            self.module.download(self.url, self.destination, proxy=dict(self.profile, ca_file=str(self.base / 'wrong.pem')))
        self.assertEqual(len(self.origin.observations), 0)
        self.assertFalse(self.destination.exists())
        # The selected CA is trusted, but sub.origin.test is not in the SAN.
        with self.assertRaises(self.module.InstallError):
            self.module.download('https://sub.origin.test:' + str(self.origin.server_port) + '/package', self.destination,
                                 proxy=dict(self.profile, no_proxy=['.origin.test']))
        self.assertEqual(len(self.origin.observations), 0)
        self.assertFalse(self.destination.exists())

    def test_https_redirect_to_localhost_bypasses_proxy_without_forwarding_auth(self):
        self.origin.redirect_url = 'https://localhost:' + str(self.origin.server_port) + '/package'
        redirect = 'https://origin.test:' + str(self.origin.server_port) + '/redirect'
        self.module.download(redirect, self.destination, proxy=self.profile)
        self.assertEqual(self.destination.read_bytes(), b'PL proxy acceptance payload\n')
        self.assertEqual(len(self.proxy.observations), 1)
        self.assertEqual(len(self.origin.observations), 2)
        self.assertTrue([entry['path'] for entry in self.origin.observations] == ['/redirect', '/package'],
                        'Verified HTTPS redirect must reach the expected second origin path')
        self.assertFalse(any(key.lower() == 'proxy-authorization' for entry in self.origin.observations
                             for key in entry['headers']),
                         'Proxy credentials must not reach either redirect target')

    def test_https_redirect_downgrade_is_rejected_before_second_request(self):
        self.origin.redirect_url = 'http://localhost:' + str(self.origin.server_port) + '/package'
        redirect = 'https://origin.test:' + str(self.origin.server_port) + '/redirect'
        with self.assertRaises(self.module.InstallError):
            self.module.download(redirect, self.destination, proxy=self.profile)
        self.assertEqual(len(self.proxy.observations), 1)
        self.assertEqual(len(self.origin.observations), 1)
        self.assertEqual(self.origin.observations[0]['path'], '/redirect')
        self.assertFalse(any(key.lower() == 'proxy-authorization' for key in self.origin.observations[0]['headers']),
                         'Proxy credentials must not reach the initial redirect target')
        self.assertFalse(self.destination.exists())

    def test_https_only_and_size_limit_remain_enforced_with_proxy(self):
        with self.assertRaises(self.module.InstallError):
            self.module.download('http://origin.test:' + str(self.origin.server_port), self.destination, proxy=self.profile)
        self.assertEqual(len(self.proxy.observations), 0)
        with self.assertRaises(self.module.InstallError):
            self.module.download(self.url, self.destination, limit=3, proxy=self.profile)
        self.assertEqual(len(self.proxy.observations), 1)


if __name__ == '__main__':
    unittest.main()
