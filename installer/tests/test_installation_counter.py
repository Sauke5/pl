"""Exercise the PL counter's v2 sender over local HTTPS."""
from contextlib import redirect_stderr, redirect_stdout
import errno
import http.client
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
from queue import Queue
import ssl
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit


INSTALLER = Path(__file__).resolve().parents[1]
COUNTER_PATH = '/v2/installs'
INSTALLATION = 'pl-0123456789ab'
VERSION = '0.8.9'
MANIFEST_SHA256 = 'b' * 64


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


controller = load('pl_counter_controller', INSTALLER / 'module-controller.py')
delivery = load('pl_counter_delivery', INSTALLER / 'delivery.py')


class CounterEndpoint(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.server.reports.put((self.path, self.headers.get('Content-Type'), body))
        self.send_response_only(self.server.report_status)
        self.end_headers()


class InstallationCounterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temp.cleanup)
        cls.cert = Path(temp.name) / 'test-cert.pem'
        cls.key = Path(temp.name) / 'test-key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=PL counter test', '-addext', 'subjectAltName=IP:127.0.0.1',
                        '-keyout', str(cls.key), '-out', str(cls.cert)], check=True, capture_output=True)

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / 'state/installation.json'
        self.state.parent.mkdir(mode=0o700)
        self.registry = self.root / 'private/module-images.json'
        self.registry.parent.mkdir(mode=0o700)
        self.os_release = self.root / 'os-release'
        os_release = patch.object(controller, 'OS_RELEASE', self.os_release)
        os_release.start()
        self.addCleanup(os_release.stop)

        original_stat = Path.stat

        def root_stat(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if path in (self.registry, self.registry.parent):
                values = list(info)
                values[4] = 0
                return os.stat_result(values)
            return info

        registry_stat = patch.object(Path, 'stat', root_stat)
        registry_stat.start()
        self.addCleanup(registry_stat.stop)

        server = http.server.HTTPServer(('127.0.0.1', 0), CounterEndpoint)
        self.addCleanup(server.server_close)
        server.reports = Queue()
        server.report_status = 204
        self.server = server
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(self.cert, self.key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 2)
        self.addCleanup(server.shutdown)
        self.endpoint = 'https://127.0.0.1:' + str(server.server_port) + COUNTER_PATH

    def write_state(self, version=VERSION, phase='ready'):
        self.state.write_text(json.dumps({'install_id': INSTALLATION, 'version': version, 'phase': phase,
                                         'manifest_sha256': MANIFEST_SHA256,
                                         'config': {'public_url': 'https://local-installation.test'}}))

    def write_registry(self, **modules):
        self.registry.write_text(json.dumps({'schema': 1, 'installation': INSTALLATION,
                                            'manifest_sha256': MANIFEST_SHA256, **modules}))
        self.registry.chmod(0o600)

    def write_receipt(self, module, version):
        path = self.root / 'state/delivery' / ('module-' + module + '.json')
        path.parent.mkdir(mode=0o700, exist_ok=True)
        path.write_text(json.dumps({'module_id': module, 'version': version}))
        path.chmod(0o600)

    def report(self, version=VERSION, phase='ready'):
        self.write_state(version, phase)
        requested, stopped = Mock(), Mock()
        stopped.is_set.side_effect = [False, True]
        controller.report_installation(self.root, urlsplit(self.endpoint), INSTALLATION, version, requested, stopped)
        return requested.wait.call_args.args[0]

    def next_report(self):
        path, content_type, raw = self.server.reports.get(timeout=3)
        self.assertEqual(path, COUNTER_PATH)
        self.assertEqual(content_type, 'application/json')
        self.assertLessEqual(len(raw), 16384)
        return json.loads(raw.decode('utf-8'))

    @staticmethod
    def module_image(module, version):
        return {'labels': {'pl.module.id': module, 'org.opencontainers.image.version': version}}

    def test_uses_stable_installation_id_after_version_change_and_reports_when_ready(self):
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
            self.assertEqual(self.report(phase='upgrading'), 10)
            self.assertTrue(self.server.reports.empty())
            for version in ('0.8.8', VERSION):
                self.assertEqual(self.report(version), 86400)
                report = self.next_report()
                self.assertEqual((report['installation_id'], report['version']), (INSTALLATION, version))

    def test_posts_only_v2_fields_with_installed_artifact_versions_and_receipt_fallback(self):
        self.os_release.write_text('ID="ubuntu"\nVERSION_ID=\'24.04\'\nPRETTY_NAME="Local name"\n')
        self.write_registry(grafana=self.module_image('grafana', '13.2.0'), forms={'adapter': {}},
                            netmap={'database': self.module_image('netmap', '0.8.8'),
                                    'adapter': self.module_image('netmap', '0.8.9')}, sftpgo={'server': {}})
        self.write_receipt('forms', '0.1.0+build')
        self.write_receipt('netmap', '0.8.8')
        self.write_receipt('sftpgo', 'bad/version')
        self.write_receipt('wayline', '0.7.0')
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}), \
                patch.object(controller.platform, 'machine', return_value='x86_64'):
            self.assertEqual(self.report(), 86400)
        self.assertEqual(self.next_report(), {
            'installation_id': INSTALLATION, 'version': VERSION, 'os': {'id': 'ubuntu', 'version': '24.04'},
            'arch': 'amd64', 'modules': [{'id': 'forms', 'version': '0.1.0+build'}, {'id': 'grafana', 'version': '13.2.0'},
                                        {'id': 'netmap', 'version': '0.8.9'}, {'id': 'sftpgo', 'version': None}],
        })

    def test_unknown_inventory_and_empty_module_registry_are_distinct(self):
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
            with patch.object(controller.platform, 'machine', return_value='riscv64'):
                self.assertEqual(self.report(), 86400)
            self.assertEqual(self.next_report(), {'installation_id': INSTALLATION, 'version': VERSION,
                                                  'os': None, 'arch': None, 'modules': None})
            self.os_release.write_text('ID=debian\nVERSION_CODENAME=trixie\n')
            self.write_registry()
            with patch.object(controller.platform, 'machine', return_value='aarch64'):
                self.assertEqual(self.report(), 86400)
            self.assertEqual(self.next_report(), {'installation_id': INSTALLATION, 'version': VERSION,
                                                  'os': {'id': 'debian', 'version': None}, 'arch': 'arm64', 'modules': []})
            self.registry.write_text('invalid JSON')
            self.assertEqual(self.report(), 86400)
            self.assertIsNone(self.next_report()['modules'])

    def test_tls_and_http_failures_are_ignored_silently(self):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(self.report(), 10)
            self.assertTrue(self.server.reports.empty())
            self.server.report_status = 503
            with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
                self.assertEqual(self.report(), 10)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), '')
        self.assertEqual(self.next_report()['installation_id'], INSTALLATION)

    def test_network_recovery_sends_on_next_short_retry(self):
        self.write_state()
        destination = urlsplit(self.endpoint)
        requested, stopped = Mock(), Mock()
        stopped.is_set.side_effect = [False, False, True]
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
            online = http.client.HTTPSConnection(destination.hostname, destination.port, timeout=2)
            with patch.object(controller.http.client, 'HTTPSConnection',
                              side_effect=[OSError(errno.ENETUNREACH, 'fixture'), online]):
                controller.report_installation(self.root, destination, INSTALLATION, VERSION, requested, stopped)
        self.assertEqual([call.args[0] for call in requested.wait.call_args_list], [10, 86400])
        report = self.next_report()
        self.assertEqual((report['installation_id'], report['version']), (INSTALLATION, VERSION))

    def test_host_worker_takes_destination_from_activated_package(self):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'version': VERSION, 'installation_counter_url': self.endpoint}))
        with patch.object(controller, '__file__', str(self.root / 'module-controller.py')), \
                patch.object(controller.threading, 'Thread') as thread:
            with controller.installation_counter(self.root, INSTALLATION) as request_report:
                kwargs = thread.call_args.kwargs
                self.assertIs(kwargs['target'], controller.report_installation)
                self.assertEqual(kwargs['args'][:-2], (self.root, urlsplit(self.endpoint), INSTALLATION, VERSION))
                thread.return_value.start.assert_called_once_with()
                request_report()
                self.assertTrue(kwargs['args'][-2].is_set())
            self.assertTrue(kwargs['args'][-1].is_set())

    def test_catalog_check_wakes_report_with_fresh_inventory_while_github_download_is_in_progress(self):
        updates = delivery.Delivery(SimpleNamespace(root=self.root, installation=INSTALLATION))
        self.write_state()
        self.write_registry()
        (self.root / 'manifest.json').write_text(json.dumps({'version': VERSION, 'installation_counter_url': self.endpoint}))

        def download_catalog(url, *_):
            self.assertEqual(url, delivery.CATALOG_URL)
            self.assertEqual(self.next_report()['modules'], [{'id': 'grafana', 'version': '13.2.0'}])
            raise OSError('Fixture GitHub failure')

        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}), \
                patch.object(controller, '__file__', str(self.root / 'module-controller.py')), \
                patch.object(updates, 'download', side_effect=download_catalog) as download, \
                patch.object(updates, 'status', return_value={}):
            with controller.installation_counter(self.root, INSTALLATION) as request_report:
                self.assertEqual(self.next_report()['modules'], [])
                self.write_registry(grafana=self.module_image('grafana', '13.2.0'))
                updates.request_installation_report = request_report
                updates.check({})
                download.assert_called_once()
