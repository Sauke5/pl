"""Finite host diagnostics expose measurements only, never command execution."""
import io
import fcntl
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import test_module_controller as baseline

pl = baseline.pl

spec = importlib.util.spec_from_file_location('pl_poll_admission_delivery', Path(__file__).resolve().parents[1] / 'delivery.py')
delivery_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery_module)


class ReconcilePollAdmissionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.delivery = object.__new__(delivery_module.Delivery)
        self.delivery.base = Path(temporary.name).resolve()
        self.instance = 'd5dbd2a3-a4e1-431b-8441-851120241d58'
        self.phase('reconciling', True)
        self.calls = []
        def observed(payload):
            with (self.delivery.base / 'delivery.lock').open('rb') as probe:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.calls.append(payload)
            return {'state': 'running'}
        self.native = types.SimpleNamespace(status=observed, read=observed, request=observed)
        self.controller = types.SimpleNamespace(on_demand=True, delivery_guard=self.delivery.rpc_guard,
            read=observed, alertmanager=lambda: self.native, wayline=lambda: self.native)

    def phase(self, phase, committed):
        path = self.delivery.base / 'operation.json'
        path.write_text(json.dumps({'phase': phase, 'data_committed': committed})); path.chmod(0o600)

    def request(self, path, payload, *, signed=True):
        key = b'poll-admission-test-key'; raw = json.dumps(payload).encode(); timestamp = str(int(time.time()))
        signature = hmac.new(key, (timestamp + '\nPOST\n' + path + '\n').encode() + raw, hashlib.sha256).hexdigest()
        headers = http.client.HTTPMessage()
        for name, value in {'Content-Length': str(len(raw)), 'X-PL-Timestamp': timestamp,
                            'X-PL-Signature': signature if signed else '0' * 64}.items(): headers[name] = value
        handler = object.__new__(pl.Handler); handler.command = 'POST'; handler.path = path
        handler.headers = headers; handler.rfile = io.BytesIO(raw)
        handler.server = types.SimpleNamespace(controller=self.controller, key=key)
        replies = []; handler.reply = lambda status, body: replies.append((status, body))
        handler.handle_request()
        self.assertEqual(len(replies), 1)
        return replies[0][0]

    def readers(self):
        result = [('/v1/read', {'instance_id': self.instance, 'path': '/api/v1/targets', 'query': ''}),
                  ('/v1/alertmanager/status', {'instance_id': self.instance}),
                  ('/v1/alertmanager/read', {'instance_id': self.instance, 'path': '/api/v2/alerts', 'query': ''})]
        for path, query in (('/api/v1/targets', ''), ('/api/v1/checks/latest', 'kind=path'), ('/api/v1/checks/latest', 'kind=iperf')):
            result.append(('/v1/wayline/request', {'instance_id': self.instance, 'method': 'GET', 'path': path,
                           'query': query, 'content_type': '', 'body': ''}))
        return result

    def test_authenticated_collectors_read_committed_reconciling_under_shared_delivery_lock(self):
        for path, payload in self.readers():
            with self.subTest(path=path, payload=payload): self.assertEqual(self.request(path, payload), 200)
        self.assertEqual(len(self.calls), 6)
        with (self.delivery.base / 'delivery.lock').open('rb') as probe:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_poll_exception_does_not_bypass_authentication(self):
        for path, payload in self.readers(): self.assertEqual(self.request(path, payload, signed=False), 403)
        self.assertEqual(self.calls, [])

    def test_other_active_phases_and_nonboolean_commit_still_block_collectors(self):
        for phase, committed in (('downloading', True), ('quiescing', True), ('snapshot', True), ('applying', True),
                                 ('verifying', True), ('resuming', True), ('restoring', True), ('recovery_required', True),
                                 ('reconciling', False), ('reconciling', 1), ('reconciling', None)):
            self.phase(phase, committed)
            for path, payload in self.readers():
                with self.subTest(phase=phase, committed=committed, path=path):
                    self.assertEqual(self.request(path, payload), 503)
        self.assertEqual(self.calls, [])

    def test_wayline_writes_and_noncollector_reads_remain_blocked(self):
        base = self.readers()[3][1]
        changes = ({'method': 'POST', 'body': 'e30=', 'content_type': 'application/json'}, {'method': 'PUT'},
                   {'method': 'DELETE'}, {'method': 'HEAD'}, {'path': '/api/v1/targets/1/checks'},
                   {'path': '/metrics'}, {'query': 'unexpected=1'}, {'body': 'eA=='},
                   {'content_type': 'application/json'}, {'path': '/api/v1/checks/latest', 'query': 'kind=unknown'},
                   {'path': '/api/v1/checks/latest', 'query': 'kind=path&kind=iperf'})
        for change in changes:
            with self.subTest(change=change): self.assertEqual(self.request('/v1/wayline/request', base | change), 503)
        for path in ('/v1/alertmanager/preview', '/v1/alertmanager/test-notification', '/v1/configuration/validate'):
            self.assertEqual(self.request(path, {}), 503)
        self.assertEqual(self.calls, [])

    def test_completed_installation_retains_normal_wayline_request_admission(self):
        self.phase('complete', True)
        payload = self.readers()[3][1] | {'method': 'POST', 'content_type': 'application/json', 'body': 'e30='}
        self.assertEqual(self.request('/v1/wayline/request', payload), 200)
        self.assertEqual(self.calls, [payload])


class ControllerFailureDiagnosticTests(unittest.TestCase):
    def handler(self, path='/v1/doska/transport', started=False):
        handler = object.__new__(pl.Handler); handler.path = path; handler._response_started = started
        return handler

    def test_failure_diagnostic_keeps_bounded_source_frames_without_exception_or_request_values(self):
        namespace = {}
        exec(compile("def failed():\n raise ValueError('fixture-password /sensitive/private-root Bearer fixture-token')\n",
                     '/sensitive/package/doska-controller.py', 'exec'), namespace)
        try: namespace['failed']()
        except ValueError as error:
            with patch.object(pl.os, 'write') as output: self.handler().report_failure(error)
        output.assert_called_once(); descriptor, body = output.call_args.args
        self.assertEqual(descriptor, 2); self.assertLess(len(body), 4096)
        value = json.loads(body)
        self.assertEqual(value['error_type'], 'ValueError'); self.assertEqual(value['rpc'], '/v1/doska/transport')
        self.assertEqual(value['frames'], [{'file': 'doska-controller.py', 'line': 2, 'function': 'failed'}])
        for secret in (b'fixture-password', b'private-root', b'fixture-token', b'/sensitive', b'Bearer'):
            self.assertNotIn(secret, body)

    def test_unknown_rpc_and_os_error_keep_only_finite_metadata(self):
        error = PermissionError(13, 'fixture-secret', '/private/credential')
        with patch.object(pl.os, 'write') as output:
            self.handler('/v1/private-fixture-secret?token=fixture-token').report_failure(error)
        value = json.loads(output.call_args.args[1])
        self.assertEqual(value['rpc'], 'other'); self.assertEqual(value['errno'], 13)
        self.assertEqual(value['error_type'], 'PermissionError'); self.assertEqual(value['frames'], [])
        self.assertNotIn(b'fixture-secret', output.call_args.args[1]); self.assertNotIn(b'credential', output.call_args.args[1])

    def test_normal_stream_disconnects_are_quiet_and_logging_failure_does_not_escape(self):
        for error in (BrokenPipeError(), ConnectionResetError()):
            with patch.object(pl.os, 'write') as output: self.handler(started=True).report_failure(error)
            output.assert_not_called()
        with patch.object(pl.os, 'write', side_effect=OSError('fixture-log-unavailable')):
            self.handler().report_failure(ValueError('fixture-secret'))

class HostStatusTests(unittest.TestCase):
    def test_reads_host_memory_uptime_and_owned_root_storage(self):
        controller = object.__new__(pl.Controller)
        controller.root = Path('/fixture/pl')
        controller.installation = 'pl-0123456789ab'
        def opened(name, **kwargs):
            if name == '/proc/meminfo':
                return io.StringIO('MemTotal: 32768 kB\nMemAvailable: 16384 kB\n')
            if name == '/proc/uptime':
                return io.StringIO('12345.50 20000.00\n')
            raise AssertionError('Unexpected diagnostic file')
        with patch('builtins.open', side_effect=opened), patch.object(pl.os, 'uname', return_value=types.SimpleNamespace(nodename='lab', release='kernel-fixture')), patch.object(pl.os, 'cpu_count', return_value=6), patch.object(pl.os, 'getloadavg', return_value=(0.1, 0.2, 0.3)), patch.object(pl.shutil, 'disk_usage', return_value=types.SimpleNamespace(total=1000, used=250, free=750)) as storage:
            status = controller.host_status({})
        self.assertEqual(status['memory'], {'total_bytes': 32768 * 1024, 'available_bytes': 16384 * 1024})
        self.assertEqual(status['uptime_seconds'], 12345.5)
        self.assertEqual(status['cpus'], 6)
        self.assertEqual(status['storage']['free_bytes'], 750)
        self.assertEqual(status['hostname'], 'lab')
        storage.assert_called_once_with(controller.root)

    def test_rejects_arguments_before_accessing_host(self):
        controller = object.__new__(pl.Controller)
        with patch('builtins.open', side_effect=AssertionError('Unexpected file access')):
            for body in ({'path': '/etc/shadow'}, {'command': 'reboot'}, [], None):
                with self.subTest(body=body), self.assertRaises(ValueError):
                    controller.host_status(body)
