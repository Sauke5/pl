"""Bootstrap HTTP CONNECT acceptance: local TLS, signed catalog, no host install."""
import base64
import contextlib
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import ssl
import select
import socket
import socketserver
import threading
import time
import subprocess
import tarfile
import types
import unittest
from unittest.mock import patch

import test_install_proxy as fixtures

SCRIPT = Path(__file__).resolve().parents[1] / 'get-pl.sh'
SOURCE = SCRIPT.read_text().split("<<'PL_BOOTSTRAP_PY'\n", 1)[1].rsplit('\nPL_BOOTSTRAP_PY', 1)[0]
SOURCE = SOURCE[:SOURCE.rindex('\ntry:\n')]


def bootstrap_module():
    module = types.ModuleType('pl_bootstrap_proxy_test')
    exec(compile(SOURCE, str(SCRIPT), 'exec'), module.__dict__)
    return module


class PayloadOrigin(fixtures.Origin):
    def do_GET(self):
        if not hasattr(self.server, 'bodies') or self.path not in self.server.bodies:
            return super().do_GET()
        self.server.observations.append({'path': self.path, 'headers': dict(self.headers)})
        body = self.server.bodies[self.path]
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)



class SocksFixture(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        def exact(count):
            result = b''
            while len(result) < count:
                part = self.request.recv(count - len(result))
                if not part: raise OSError('closed')
                result += part
            return result
        try:
            version, length = exact(2)
            methods = exact(length)
            method = 2 if self.server.auth else 0
            if version != 5 or method not in methods:
                self.request.sendall(b'\x05\xff'); return
            self.request.sendall(bytes((5, method)))
            if method == 2:
                auth_version, count = exact(2)
                user = exact(count)
                password = exact(exact(1)[0])
                if auth_version != 1 or (user, password) != getattr(self.server, 'credentials', (b'fixture-user', b'fixture-password')) or self.server.reject_auth:
                    self.request.sendall(b'\x01\x01'); return
                self.request.sendall(b'\x01\x00')
            version, command, reserved, kind = exact(4)
            if (version, command, reserved, kind) != (5, 1, 0, 3):
                raise OSError('Expected remote DNS domain request')
            host = exact(exact(1)[0]).decode('ascii')
            port = int.from_bytes(exact(2), 'big')
            self.server.observations.append((host, port))
            if self.server.reject_connect or host not in ('origin.test', 'download.docker.com') or port != self.server.origin_port:
                self.request.sendall(b'\x05\x05\x00\x01' + b'\0' * 6); return
            with socket.create_connection(('127.0.0.1', port), timeout=3) as upstream:
                self.request.sendall(b'\x05\x00\x00\x01' + b'\0' * 6)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    ready, _, _ = select.select([self.request, upstream], [], [], 0.1)
                    for source in ready:
                        body = source.recv(65536)
                        if not body: return
                        (upstream if source is self.request else self.request).sendall(body)
        except OSError:
            pass


class SocksServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    block_on_close = False


class BootstrapProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.DownloadTests.setUpClass.__func__(cls)
        extension = cls.base / 'origin.ext'
        extension.write_text(extension.read_text().replace('DNS:origin.test,', 'DNS:origin.test,DNS:download.docker.com,'))
        subprocess.run(['openssl', 'x509', '-req', '-days', '1', '-in', str(cls.base / 'origin.csr'),
                        '-CA', str(cls.base / 'ca.pem'), '-CAkey', str(cls.base / 'ca.key'),
                        '-CAcreateserial', '-extfile', str(extension), '-out', str(cls.base / 'origin.pem')],
                       check=True, capture_output=True)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(cls.base / 'signing.key')],
                       check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(cls.base / 'signing.key'), '-pubout',
                        '-out', str(cls.base / 'signing.pem')], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        fixtures.DownloadTests.tearDownClass.__func__(cls)

    close_server = staticmethod(fixtures.DownloadTests.close_server)
    assert_payload = fixtures.DownloadTests.assert_payload

    def setUp(self):
        fixtures.DownloadTests.setUp(self)
        self.module = bootstrap_module()
        self.origin.RequestHandlerClass = PayloadOrigin
        self.profile_path = Path(self.download_dir.name) / 'proxy.json'
        # Only these fixture origins bypass the production URL allowlist. All
        # TLS, CONNECT, redirect, digest and signature checks remain real.
        original = self.module.check_url
        def fixture_url(url, redirect=False):
            value = self.module.urllib.parse.urlsplit(url)
            if value.scheme == 'https' and value.hostname in ('origin.test', 'localhost') and value.port == self.origin.server_port:
                return
            return original(url, redirect)
        allow = patch.object(self.module, 'check_url', side_effect=fixture_url)
        allow.start(); self.addCleanup(allow.stop)

    def start_socks(self, *, auth=True):
        server = SocksServer(('127.0.0.1', 0), SocksFixture)
        server.auth, server.reject_auth, server.reject_connect = auth, False, False
        server.origin_port, server.observations = self.origin.server_port, []
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start(); self.addCleanup(self.close_server, server, thread)
        profile = {'url': 'socks5h://127.0.0.1:' + str(server.server_address[1]), 'ca_file': self.profile['ca_file']}
        if auth: profile.update(username='fixture-user', password='fixture-password')
        allowed = patch.object(self.module, 'SOCKS_DESTINATIONS', {('origin.test', self.origin.server_port),
            ('download.docker.com', self.origin.server_port)})
        allowed.start(); self.addCleanup(allowed.stop)
        # A SOCKS route must not resolve the target on the installing host.
        actual_dns = socket.getaddrinfo
        def forbid_target_dns(host, *args, **kwargs):
            if host in ('origin.test', 'download.docker.com'):
                raise AssertionError('SOCKS target DNS escaped to local resolver')
            return actual_dns(host, *args, **kwargs)
        dns = patch.object(socket, 'getaddrinfo', side_effect=forbid_target_dns)
        dns.start(); self.addCleanup(dns.stop)
        return server, profile

    def test_socks_remote_dns_auth_and_no_auth_transport_tls_hash(self):
        for auth in (True, False):
            with self.subTest(auth=auth):
                server, profile = self.start_socks(auth=auth)
                with self.module.socks_adapter(profile) as adapter:
                    self.module.download(self.url, self.destination, 1024,
                        expected_hash=hashlib.sha256(b'PL proxy acceptance payload\n').hexdigest(), proxy=adapter)
                    self.assertEqual(server.observations, [('origin.test', self.origin.server_port)])
                    address = self.module.urllib.parse.urlsplit(adapter['url'])
                self.assertEqual(self.destination.read_bytes(), b'PL proxy acceptance payload\n')
                self.destination.unlink()
                with self.assertRaises(OSError): socket.create_connection((address.hostname, address.port), timeout=1)
        self.assertFalse(any('Proxy-Authorization' in event['headers'] for event in self.origin.observations))

    def test_socks_rejections_and_tls_failure_have_no_direct_fallback(self):
        server, profile = self.start_socks()
        for failure in ('auth', 'connect', 'tls'):
            server.reject_auth, server.reject_connect = failure == 'auth', failure == 'connect'
            selected = dict(profile, ca_file=str(self.base / 'wrong.pem')) if failure == 'tls' else profile
            with self.subTest(failure=failure), self.module.socks_adapter(selected) as adapter:
                with self.assertRaises(ValueError) as error:
                    self.module.download(self.url, self.destination, 1024, proxy=adapter)
                self.assertNotIn('fixture-password', str(error.exception))
            self.assertFalse(self.origin.observations)
            self.assertFalse(self.destination.exists())

    def test_socks_adapter_requires_random_auth_and_exact_allowed_destination(self):
        server, profile = self.start_socks()
        with self.module.socks_adapter(profile) as adapter:
            selected = dict(adapter, password='wrong')
            with self.assertRaises(ValueError): self.module.download(self.url, self.destination, 1024, proxy=selected)
            with patch.object(self.module, 'SOCKS_DESTINATIONS', set()):
                with self.assertRaises(ValueError): self.module.download(self.url, self.destination, 1024, proxy=adapter)
        self.assertFalse(server.observations)
        self.assertFalse(self.origin.observations)

    def test_authenticated_connect_ignores_env_and_keeps_credentials_off_origin(self):
        environment = {'HTTPS_PROXY': 'http://127.0.0.1:9', 'https_proxy': 'http://127.0.0.1:9',
                       'NO_PROXY': '*', 'no_proxy': '*'}
        body = b'PL proxy acceptance payload\n'
        with patch.dict(os.environ, environment):
            self.module.download(self.url, self.destination, 1024, len(body), hashlib.sha256(body).hexdigest(), proxy=self.profile)
        self.assert_payload()
        self.assertEqual(len(self.proxy.observations), 1)
        self.assertIn('Proxy-Authorization', self.proxy.observations[0]['headers'])

    def test_default_direct_mode_ignores_environment_proxy(self):
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.base / 'ca.pem'),
                                     'HTTPS_PROXY': self.profile['url'], 'https_proxy': self.profile['url'],
                                     'NO_PROXY': '', 'no_proxy': ''}):
            self.module.download(self.url, self.destination, 1024)
        self.assert_payload()
        self.assertFalse(self.proxy.observations)

    def test_tls_and_proxy_failure_never_fall_back_to_direct(self):
        for profile, status in ((self.profile, 407), (self.profile, 502),
                                (dict(self.profile, ca_file=str(self.base / 'wrong.pem')), 200)):
            self.proxy.response_status = status
            with self.subTest(status=status), self.assertRaises(ValueError) as failure:
                self.module.download(self.url, self.destination, 1024, proxy=profile)
            self.assertFalse(self.destination.exists())
            self.assertFalse(self.origin.observations)
            self.assertNotIn('fixture-password', str(failure.exception))
            self.assertNotIn('fixture-user', str(failure.exception))
        self.assertEqual(len(self.proxy.observations), 3)

    def test_hash_and_size_remain_required_after_proxy_transport(self):
        for options in ({'expected_hash': '0' * 64}, {'expected_size': 1}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.module.download(self.url, self.destination, 1024, proxy=self.profile, **options)
            self.destination.unlink(missing_ok=True)
        self.assertEqual(len(self.proxy.observations), 2)

    def test_redirect_uses_proxy_and_downgrade_or_foreign_origin_is_rejected(self):
        self.origin.redirect_url = self.url
        self.module.download(self.url.replace('/package', '/redirect'), self.destination, 1024, proxy=self.profile)
        self.assertEqual(len(self.proxy.observations), 2)
        self.assertFalse(any('Proxy-Authorization' in event['headers'] for event in self.origin.observations))
        for target in ('http://origin.test/package', 'https://untrusted.test/package'):
            self.destination.unlink(missing_ok=True)
            self.origin.redirect_url = target
            before = len(self.origin.observations)
            with self.assertRaises(ValueError):
                self.module.download(self.url.replace('/package', '/redirect'), self.destination, 1024, proxy=self.profile)
            self.assertEqual(len(self.origin.observations), before + 1)

    def test_profile_contract_and_private_file_reject_unsafe_values(self):
        for value in ({'url': 'socks4://proxy.test:1080'}, {'url': 'http://user:fixture-password@proxy.test:3128'},
                      {'url': 'http://proxy.test:3128', 'username': 'fixture-user'},
                      {'url': 'http://proxy.test:3128', 'unknown': True}):
            self.profile_path.write_text(json.dumps(value)); self.profile_path.chmod(0o600)
            with self.subTest(value=list(value)), self.assertRaises(ValueError) as failure:
                self.module.load_download_proxy(self.profile_path)
            self.assertNotIn('fixture-password', str(failure.exception))
        self.profile_path.write_text(json.dumps(self.profile)); self.profile_path.chmod(0o644)
        with self.assertRaises(ValueError): self.module.load_download_proxy(self.profile_path)
        self.profile_path.chmod(0o600)
        link = self.profile_path.with_name('linked.json'); link.symlink_to(self.profile_path)
        with self.assertRaises(ValueError): self.module.load_download_proxy(link)

    def signed_catalog(self, *, bad_signature=False):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            body = b'echo verified-fixture\n'
            item = tarfile.TarInfo('install.sh'); item.size = len(body)
            archive.addfile(item, io.BytesIO(body))
        package = output.getvalue()
        payload = json.dumps({'schema': 1, 'product': 'PL', 'core_api': 1, 'version': 'fixture',
            'core': {'amd64': {'url': self.url, 'size': len(package), 'sha256': hashlib.sha256(package).hexdigest()}}}).encode()
        path = Path(self.download_dir.name) / 'payload.json'; path.write_bytes(payload)
        signature = subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(self.base / 'signing.key'),
                                    '-rawin', '-in', str(path)], capture_output=True, check=True).stdout
        if bad_signature: signature = b'x' * 64
        self.origin.bodies = {'/catalog': json.dumps({'payload': base64.b64encode(payload).decode(),
                                                     'signature': base64.b64encode(signature).decode()}).encode(),
                              '/package': package}
        self.module.PUBLIC_KEY = (self.base / 'signing.pem').read_bytes()
        self.module.CATALOG = self.url.replace('/package', '/catalog')

    def run_bootstrap(self, arguments, *, bad_signature=False, installer_download=None, installer_environment=None):
        self.signed_catalog(bad_signature=bad_signature)
        installed = []
        actual_run = subprocess.run
        def installer(command, **kwargs):
            if command[0] != '/bin/sh': return actual_run(command, **kwargs)
            if installer_environment:
                installer_environment(kwargs.get('env'))
            profile = Path(command[command.index('--download-proxy-file') + 1])
            self.assertEqual(profile.stat().st_mode & 0o777, 0o600)
            installed.append((command, json.loads(profile.read_text())))
            if installer_download:
                installer_download(profile)
            return subprocess.CompletedProcess(command, 0)
        with patch.object(self.module.os, 'geteuid', side_effect=itertools.chain([0], itertools.repeat(os.geteuid()))), \
             patch.object(self.module.platform, 'system', return_value='Linux'), \
             patch.object(self.module.platform, 'machine', return_value='x86_64'), \
             patch.object(self.module.subprocess, 'run', side_effect=installer), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            if bad_signature:
                with self.assertRaisesRegex(ValueError, 'Подпись'):
                    self.module.main(['--public-url', 'https://pl.example', '--production', *arguments])
            else:
                self.assertEqual(self.module.main(['--public-url', 'https://pl.example', '--production', *arguments]), 0)
        return installed, output.getvalue()

    def test_signed_installer_uses_c_locale_on_russian_host(self):
        def inspect_environment(environment):
            self.assertIsInstance(environment, dict)
            self.assertEqual(environment.get('LC_ALL'), 'C')
            self.assertEqual(environment.get('LANG'), 'C')
            self.assertEqual(environment.get('PL_FIXTURE_VALUE'), 'preserved')
        with patch.dict(self.module.os.environ, {'LC_ALL': 'ru_RU.UTF-8', 'LANG': 'ru_RU.UTF-8', 'PL_FIXTURE_VALUE': 'preserved'}):
            self.run_bootstrap(['--proxy-file', str(self.profile_path)], installer_environment=inspect_environment)

    def test_signed_catalog_and_whole_artifact_cross_connect_then_private_profile_reaches_installer(self):
        installed, output = self.run_bootstrap(['--proxy-file', str(self.profile_path)])
        self.assertEqual(len(installed), 1)
        self.assertEqual(installed[0][1], self.profile)
        self.assertIn('--production', installed[0][0])
        self.assertEqual([entry['path'] for entry in self.origin.observations], ['/catalog', '/package'])
        self.assertEqual(len(self.proxy.observations), 2)
        self.assertNotIn('fixture-password', output)
        self.assertIn('apt', output)
        self.assertIn('настройках доставки', output)

    def test_socks_signed_bootstrap_and_legacy_installer_download_share_live_adapter(self):
        server, profile = self.start_socks()
        profile['password'] = 'fixture:пароль:tail'
        server.credentials = (profile['username'].encode(), profile['password'].encode())
        self.profile_path.write_text(json.dumps(profile)); self.profile_path.chmod(0o600)
        # The bundled 0.5.6 installer is still HTTP-only: exercise its actual
        # profile parser/downloader while the bootstrap keeps the adapter alive.
        def installer_download(path):
            install = fixtures.installer_module()
            http_profile = install.load_download_proxy(path)
            self.assertTrue(http_profile['url'].startswith('http://127.0.0.1:'))
            target = Path(self.download_dir.name) / 'docker-gpg'
            self.origin.bodies['/linux/debian/gpg'] = b'fixture Docker signing key'
            install.download('https://download.docker.com:' + str(self.origin.server_port) + '/linux/debian/gpg',
                             target, proxy=http_profile)
            self.assertEqual(target.read_bytes(), b'fixture Docker signing key')
        with patch.dict(os.environ, {'SSL_CERT_FILE': profile['ca_file']}):
            installed, output = self.run_bootstrap(['--proxy', profile['url'], '--proxy-user',
                profile['username'] + ':' + profile['password']], installer_download=installer_download)
        self.assertNotIn(profile['username'], output)
        self.assertNotIn(profile['password'], output)
        self.assertEqual(len(installed), 1)
        self.assertEqual(server.observations, [('origin.test', self.origin.server_port)] * 2
                         + [('download.docker.com', self.origin.server_port)])
        self.assertFalse(Path(installed[0][0][-1]).exists())
        self.assertNotEqual(installed[0][1]['password'], profile['password'])

    def test_inline_http_credentials_reach_real_connect_and_verified_installer(self):
        credentials = self.profile['username'] + ':' + self.profile['password']
        endpoint = self.module.urllib.parse.urlsplit(self.profile['url'])
        encoded_url = endpoint._replace(netloc=self.module.urllib.parse.quote(self.profile['username'], safe='') + ':'
            + self.module.urllib.parse.quote(self.profile['password'], safe='') + '@' + endpoint.netloc).geturl()
        for arguments in (['--proxy', self.profile['url'], '--proxy-user', credentials], ['--proxy', encoded_url]):
            with self.subTest(style=arguments[0]), patch.dict(os.environ, {'SSL_CERT_FILE': self.profile['ca_file']}):
                installed, output = self.run_bootstrap(arguments)
            self.assertEqual(installed[0][1], {key: self.profile[key] for key in ('url', 'username', 'password')})
            self.assertNotIn(self.profile['username'], output)
            self.assertNotIn(self.profile['password'], output)
        self.assertEqual(len(self.proxy.observations), 4)
        self.assertFalse(any('Proxy-Authorization' in event['headers'] for event in self.origin.observations))

    def test_inline_credentials_preserve_utf8_password_colons_and_decode_url_userinfo(self):
        user, password = 'fixture-user', 'пароль:with:colons@%'
        endpoint = 'socks5h://proxy.test:1080'
        expected = {'url': endpoint, 'username': user, 'password': password}
        self.assertEqual(self.module.inline_proxy_profile(endpoint, user + ':' + password), expected)
        parsed = self.module.urllib.parse.urlsplit(endpoint)
        url = parsed._replace(netloc=self.module.urllib.parse.quote(user, safe='') + ':'
            + self.module.urllib.parse.quote(password, safe='') + '@' + parsed.netloc).geturl()
        self.assertEqual(self.module.inline_proxy_profile(url), expected)
        self.profile_path.write_text(json.dumps(expected)); self.profile_path.chmod(0o600)
        self.assertEqual(self.module.load_download_proxy(self.profile_path), expected)
        for credentials in ('missing-separator', ':password', 'user:', 'user:line\nbreak'):
            with self.subTest(style='invalid credentials'):
                with self.assertRaises(ValueError) as error:
                    profile = self.module.inline_proxy_profile(endpoint, credentials)
                    self.profile_path.write_text(json.dumps(profile))
                    self.module.load_download_proxy(self.profile_path)
                self.assertNotIn(credentials, str(error.exception))
        with self.assertRaises(ValueError): self.module.inline_proxy_profile(url, user + ':' + password)
        for arguments in (['--proxy-user', 'fixture:password'],
                          ['--proxy-file', str(self.profile_path), '--proxy-user', 'fixture:password']):
            with self.assertRaisesRegex(ValueError, '--proxy-user'):
                self.module.main(arguments)

    def test_unsigned_catalog_never_reaches_payload_or_installer(self):
        installed, _ = self.run_bootstrap(['--proxy-file', str(self.profile_path)], bad_signature=True)
        self.assertEqual(installed, [])
        self.assertEqual([entry['path'] for entry in self.origin.observations], ['/catalog'])

    def test_proxy_argument_creates_private_temporary_profile_for_installer(self):
        # URL-only mode has no credentials; keep this test scoped to argument
        # plumbing, while profile mode above proves real authenticated CONNECT.
        self.signed_catalog()
        actual_download = self.module.download
        profiles = []
        def download(url, target, *args, **kwargs):
            profiles.append(kwargs['proxy'])
            return actual_download(url, target, *args, proxy=self.profile)
        with patch.object(self.module, 'download', side_effect=download):
            installed, _ = self.run_bootstrap(['--proxy', self.profile['url']])
        self.assertEqual(profiles, [{'url': self.profile['url']}] * 2)
        self.assertEqual(installed[0][1], {'url': self.profile['url']})
        self.assertFalse(Path(installed[0][0][-1]).exists(), 'Temporary proxy profile must be removed after bootstrap')


if __name__ == '__main__':
    unittest.main()
