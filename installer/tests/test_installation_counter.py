"""The PL host reports ready installations and the receiver counts distinct IDs."""
from contextlib import closing, redirect_stderr, redirect_stdout
import errno
import http.client
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
from queue import Queue
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
from urllib.parse import urlsplit
import urllib.request


INSTALLER = Path(__file__).resolve().parents[1]
RECEIVER = INSTALLER.parent / 'release/installation-counter-receiver.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


controller = load('pl_counter_controller', INSTALLER / 'module-controller.py')
delivery = load('pl_counter_delivery', INSTALLER / 'delivery.py')
receiver = load('pl_counter_receiver', RECEIVER)


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
        self.database = self.root / 'installations.sqlite3'
        self.state = self.root / 'installation.json'
        receiver.initialize(self.database)
        server = http.server.HTTPServer(('127.0.0.1', 0), receiver.Handler)
        self.addCleanup(server.server_close)
        server.database = self.database
        self.server = server
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(self.cert, self.key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 2)
        self.addCleanup(server.shutdown)
        self.endpoint = 'https://127.0.0.1:' + str(server.server_port) + '/v1/installs'

    def report(self, installation, version, phase='ready'):
        self.state.write_text(json.dumps({'install_id': installation, 'version': version, 'phase': phase,
                                         'config': {'public_url': 'https://local-installation.test'}}))
        requested, stopped = Mock(), Mock()
        stopped.is_set.side_effect = [False, True]
        controller.report_installation(self.state, urlsplit(self.endpoint), installation, version, requested, stopped)
        return requested.wait.call_args.args[0]

    def rows(self):
        with closing(sqlite3.connect(self.database)) as connection:
            return connection.execute('SELECT installation_id, version FROM installations ORDER BY installation_id').fetchall()

    def test_repeated_reports_and_updates_count_one_installation_per_id(self):
        first, second = 'pl-0123456789ab', 'pl-abcdef012345'
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
            self.assertEqual(self.report(first, '0.8.4', 'upgrading'), 10)
            self.assertEqual(self.rows(), [])
            for installation, version in ((first, '0.8.4'), (first, '0.8.4'), (first, '0.8.5'), (second, '0.8.4')):
                self.assertEqual(self.report(installation, version), 86400)
        self.assertEqual(self.rows(), [(first, '0.8.5'), (second, '0.8.4')])
        count = subprocess.check_output([sys.executable, str(RECEIVER), '--database', str(self.database), '--count'], text=True)
        self.assertEqual(count.strip(), '2')

    def test_tls_and_http_failures_are_ignored_silently(self):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(self.report('pl-0123456789ab', '0.8.4'), 10)
            self.server.database = self.root
            with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
                self.assertEqual(self.report('pl-0123456789ab', '0.8.4'), 10)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), '')
        self.assertEqual(self.rows(), [])

    def test_network_recovery_sends_on_next_short_retry(self):
        installation, version = 'pl-0123456789ab', '0.8.5'
        self.state.write_text(json.dumps({'install_id': installation, 'version': version, 'phase': 'ready'}))
        destination = urlsplit(self.endpoint)
        requested, stopped = Mock(), Mock()
        stopped.is_set.side_effect = [False, False, True]
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}):
            online = http.client.HTTPSConnection(destination.hostname, destination.port, timeout=2)
            with patch.object(controller.http.client, 'HTTPSConnection',
                              side_effect=[OSError(errno.ENETUNREACH, 'fixture'), online]):
                controller.report_installation(self.state, destination, installation, version, requested, stopped)
        self.assertEqual([call.args[0] for call in requested.wait.call_args_list], [10, 86400])
        self.assertEqual(self.rows(), [(installation, version)])

    def test_receiver_refuses_unexpected_payload_fields(self):
        body = json.dumps({'installation_id': 'pl-0123456789ab', 'version': '0.8.4', 'hostname': 'internal.test'}).encode()
        request = urllib.request.Request(self.endpoint, data=body, headers={'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                             urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=self.cert)))
        with self.assertRaises(urllib.error.HTTPError) as error:
            opener.open(request, timeout=2)
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.assertEqual(self.rows(), [])

    def test_host_worker_takes_destination_from_activated_package(self):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'version': '0.8.5', 'installation_counter_url': self.endpoint}))
        installation = 'pl-0123456789ab'
        with patch.object(controller, '__file__', str(self.root / 'module-controller.py')), \
                patch.object(controller.threading, 'Thread') as thread:
            with controller.installation_counter(self.root, installation) as request_report:
                kwargs = thread.call_args.kwargs
                self.assertIs(kwargs['target'], controller.report_installation)
                self.assertEqual(kwargs['args'][:-2], (self.root / 'state/installation.json', urlsplit(self.endpoint), installation, '0.8.5'))
                thread.return_value.start.assert_called_once_with()
                request_report()
                self.assertTrue(kwargs['args'][-2].is_set())
            self.assertTrue(kwargs['args'][-1].is_set())

    def test_catalog_check_wakes_report_while_github_download_is_in_progress(self):
        installation, version = 'pl-0123456789ab', '0.8.5'
        updates = delivery.Delivery(SimpleNamespace(root=self.root, installation=installation))
        state = self.root / 'state/installation.json'
        state.write_text(json.dumps({'install_id': installation, 'version': version, 'phase': 'ready'}))
        (self.root / 'manifest.json').write_text(json.dumps({'version': version, 'installation_counter_url': self.endpoint}))
        reports = Queue()
        handle_post = receiver.Handler.do_POST

        def observed_post(handler):
            handle_post(handler)
            reports.put(handler.path)

        def download_catalog(url, *_):
            self.assertEqual(url, delivery.CATALOG_URL)
            self.assertEqual(reports.get(timeout=3), '/v1/installs')
            raise OSError('Fixture GitHub failure')

        with patch.dict(os.environ, {'SSL_CERT_FILE': str(self.cert)}), \
                patch.object(controller, '__file__', str(self.root / 'module-controller.py')), \
                patch.object(receiver.Handler, 'do_POST', observed_post), \
                patch.object(updates, 'download', side_effect=download_catalog) as download, \
                patch.object(updates, 'status', return_value={}):
            with controller.installation_counter(self.root, installation) as request_report:
                self.assertEqual(reports.get(timeout=3), '/v1/installs')
                updates.request_installation_report = request_report
                updates.check({})
                download.assert_called_once()
        self.assertEqual(self.rows(), [(installation, version)])
