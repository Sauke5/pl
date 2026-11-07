import hashlib
import hmac
import http.client
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

BASE = Path(__file__).resolve().parents[1]
INSTALLATION = 'pl-123456abcdef'
ID = '15b58087-16fc-439a-b8bc-40d93d3ec41d'
ENDPOINT = '/v1/host/log-export'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, BASE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


logs = load('pl_test_log_export', 'log-export.py')
pl = load('pl_test_log_export_controller', 'module-controller.py')


class LogExportTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='pl-logs-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.controller = pl.Controller(self.root, INSTALLATION)
        self.until = int(time.time())
        self.since = self.until - 3600
        self.stamp = logs.utc(self.until - 10)

    def window(self, raw):
        with patch.object(logs.time, 'time', return_value=self.until):
            return logs.window(raw)

    def test_accepts_only_bounded_unix_seconds(self):
        self.assertEqual(self.window(json.dumps({'since': self.since, 'until': self.until})), (self.since, self.until))
        for raw in ('[]', '{"since":1,"since":2,"until":3}', '{"since":1,"until":2,"path":"/etc/shadow"}',
                    json.dumps({'since': True, 'until': self.until}),
                    json.dumps({'since': self.until - logs.MAX_WINDOW - 1, 'until': self.until}),
                    json.dumps({'since': self.since, 'until': self.until + 6}),
                    json.dumps({'since': self.until, 'until': self.until})):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.window(raw)

    def test_command_output_and_time_are_bounded(self):
        run = lambda script, limit, seconds: logs.command(
            self.controller, (sys.executable, '-c', script), time.monotonic() + seconds, limit)
        self.assertEqual(run("print('a' * 10000)", 128, 2), (b'a' * 128, 'read_limit'))
        self.assertEqual(run("import time; time.sleep(10)", 128, 0.15), (b'', 'timeout'))
        self.assertEqual(run("raise SystemExit(1)", 128, 2), (b'', 'command_failed'))

    def test_archive_scopes_sources_and_records_partial_outcomes(self):
        core_api, core_db, native, other = ('a' * 64, 'b' * 64, 'c' * 64, 'd' * 64)
        self.root.joinpath('state/delivery').mkdir(parents=True, exist_ok=True)
        self.root.joinpath('state/installation.json').write_text(json.dumps(
            {'install_id': INSTALLATION, 'product': 'PL', 'version': '0.8.6', 'phase': 'ready', 'env': 'sensitive-install-value'}))
        self.root.joinpath('state/delivery/operation.json').write_text(json.dumps(
            {'operation_id': ID, 'phase': 'verifying', 'artifact': 'sensitive-artifact-value',
             'last_failure': {'type': 'ValueError', 'message': 'sensitive-failure-value',
                              'frames': [{'file': 'delivery.py', 'line': 1400, 'function': 'activate_host'}]}}))
        worker = INSTALLATION + '-upgrade-' + ID.replace('-', '') + '.service'
        invalid = INSTALLATION + '-upgrade-arbitrary.service'
        commands = []

        def journal(unit, message, seconds=None):
            return json.dumps({'_SYSTEMD_UNIT': unit, '__REALTIME_TIMESTAMP': str((seconds or self.until - 10) * 10**6),
                               'MESSAGE': message}).encode() + b'\n'

        def docker_line(message):
            return (self.stamp + ' ' + message + '\n').encode()

        def command(controller, args, deadline, limit, *, merge_stderr=False):
            self.assertIs(controller, self.controller)
            self.assertLess(limit, 4 * 1024**2)
            commands.append(args)
            if args[:3] == logs.DOCKER:
                if args[3:5] == ('container', 'ls'):
                    self.assertIn('--all', args)
                    self.assertIn('--no-trunc', args)
                    label = args[args.index('--filter') + 1]
                    ids = [core_api, core_db] if label == 'label=com.docker.compose.project=' + INSTALLATION else [native, other]
                    return ('\n'.join(ids) + '\n').encode(), ''
                if args[3:5] == ('container', 'inspect'):
                    self.assertNotIn('.Config.Env', args[6])
                    values = [
                        (core_api, '/owned-api-1', INSTALLATION, 'api', '', '', ''),
                        (core_db, '/owned-db-1', INSTALLATION, 'db', '', '', ''),
                        (native, '/owned-netmap-adapter', '', '', INSTALLATION, 'netmap', ID),
                        (other, '/foreign-container', '', '', 'pl-654321abcdef', 'netmap', ID),
                    ]
                    return ('\n'.join('\t'.join(item) for item in values) + '\n').encode(), ''
                self.assertEqual(args[3:5], ('container', 'logs'))
                self.assertTrue(merge_stderr)
                self.assertEqual(args[args.index('--since') + 1], logs.utc(self.since))
                self.assertEqual(args[args.index('--until') + 1], logs.utc(self.until))
                self.assertIn('--timestamps', args)
                if args[-1] == core_api:
                    return docker_line('{"msg":"request failed","request_id":"keep-id","accessToken":"sensitive-json-token",'
                                       '"headers":{"Cookie":"sensitive-cookie"},"other":"first line\\nsensitive-continuation"}'), ''
                if args[-1] == core_db:
                    return b'CLI error with sensitive-docker-stderr\n', 'command_failed'
                self.assertEqual(args[-1], native)
                return docker_line('upstream refused https://user:sensitive-password@example.test/hook-token?sig=sensitive-query'), ''
            self.assertEqual(args[0], 'journalctl')
            self.assertFalse(merge_stderr)
            self.assertIn('--since=@' + str(self.since), args)
            self.assertIn('--until=@' + str(self.until), args)
            if '--unit=' + INSTALLATION + '-upgrade-*.service' in args:
                return (journal(worker, 'delivery stage snapshot') + journal(invalid, 'sensitive-foreign-unit')
                        + journal(worker, 'out-of-window', self.since - 1)), ''
            if '--unit=' + INSTALLATION + '-module-controller.service' in args:
                return journal(INSTALLATION + '-module-controller.service', 'RPC failed; Authorization: Bearer sensitive-auth'), ''
            self.assertIn('--unit=' + INSTALLATION + '-icmp-probe.service', args)
            self.assertIn('--unit=' + INSTALLATION + '-icmp-probe.socket', args)
            self.assertIn('--unit=' + INSTALLATION + '-icmp-*.service', args)
            unit = INSTALLATION + '-icmp-' + ID.replace('-', '') + '-dependency.service'
            return journal(unit, 'ICMP dependency check'), ''

        with patch.object(logs, 'command', side_effect=command):
            output = io.BytesIO()
            size = logs.write_archive(self.controller, output, self.since, self.until)
        self.assertLessEqual(size, logs.MAX_ARCHIVE_BYTES)
        with zipfile.ZipFile(output) as archive:
            self.assertIsNone(archive.testzip())
            self.assertTrue(all(name.startswith('host/') for name in archive.namelist()))
            manifest = json.loads(archive.read('host/manifest.json'))
            self.assertTrue(manifest['partial'])
            self.assertEqual(manifest['since'], logs.utc(self.since))
            sources = {row['source']: row for row in manifest['sources']}
            self.assertEqual(sources['docker:core:web']['reason'], 'container_missing')
            self.assertEqual(sources['docker:db:owned-db-1']['status'], 'unavailable')
            self.assertEqual(sources['docker:api:owned-api-1']['records'], 1)
            self.assertEqual(sources['docker:api:owned-api-1']['first_record_at'], self.stamp)
            self.assertEqual(sources['systemd:icmp-probe']['status'], 'collected')
            self.assertEqual(sources['systemd:delivery-workers']['status'], 'truncated')
            entries = b''.join(archive.read(name) for name in archive.namelist())
        for secret in (b'sensitive-', b'/hook-token', b'out-of-window', b'foreign-container'):
            self.assertNotIn(secret, entries)
        for detail in (b'keep-id', b'request failed', b'example.test', b'delivery stage snapshot', b'activate_host', b'ICMP dependency check'):
            self.assertIn(detail, entries)
        self.assertFalse(any(args[3:5] == ('container', 'logs') and args[-1] == other for args in commands))

    def test_oversize_and_multiline_payloads_keep_safe_tail(self):
        raw = b''.join((self.stamp + ' ' + record + '\n').encode() for record in (
            'older record with useful metadata',
            '-----' + 'BEGIN TEST PRIVATE KEY' + '-----',
            'sensitive-key-data',
            '-----' + 'END TEST PRIVATE KEY' + '-----',
            'huge ' + 'x' * logs.MAX_RECORD_BYTES,
            'error on /api/v1/login?session=sensitive-query',
        ))
        body, reason = logs.log_tail(raw, '', 112)
        self.assertEqual(reason, 'record_limit')
        self.assertIn(b'error on /api/v1/login', body)
        self.assertNotIn(b'sensitive-', body)
        self.assertLessEqual(len(body), 112)

    def test_state_projection_refuses_symlink(self):
        external = self.root / 'other.json'
        external.write_text('{"secret":"fixture"}')
        alias = self.root / 'alias.json'
        alias.symlink_to(external)
        with self.assertRaises(OSError):
            logs.state_file(alias)

    def test_postgres_preserves_error_and_excludes_sql_payload(self):
        raw = b''.join((self.stamp + ' ' + record + '\n').encode() for record in (
            '2026-11-07 12:00:00.300 UTC [41] ERROR:  syntax error at end of input',
            '2026-11-07 12:00:00.300 UTC [41] STATEMENT:  sensitive-sql-value',
            '\tadditional sensitive-sql-value',
            '{"event":"query_failed","parameters":["sensitive-sql-value"]}',
        ))
        body, reason = logs.log_tail(raw, '', 4096)
        self.assertFalse(reason)
        self.assertIn(b'ERROR:  syntax error at end of input', body)
        self.assertIn(b'STATEMENT: [redacted]', body)
        self.assertNotIn(b'sensitive-sql-value', body)

    def test_signed_unix_route_admission_and_zip_response(self):
        sock = self.root / 'control.sock'
        self.controller.on_demand = True
        key = bytes(range(32))
        with pl.Server(str(sock), pl.Handler) as server:
            server.key, server.controller = key, self.controller
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                def request(raw, *, signed=True):
                    headers = {'Content-Type': 'application/json'}
                    now = str(int(time.time()))
                    message = (now + '\nPOST\n' + ENDPOINT + '\n').encode() + raw
                    signature = hmac.new(key, message, hashlib.sha256).hexdigest() if signed else '0' * 64
                    headers.update({'X-PL-Timestamp': now, 'X-PL-Signature': signature})
                    with socket.socket(socket.AF_UNIX) as conn:
                        conn.settimeout(4)
                        conn.connect(str(sock))
                        client = http.client.HTTPConnection('controller')
                        client.sock = conn
                        client.request('POST', ENDPOINT, raw, headers)
                        response = client.getresponse()
                        return response.status, response.headers, response.read()

                body = json.dumps({'since': self.since, 'until': self.until}).encode()
                with patch.object(self.controller, 'delivery_guard', side_effect=AssertionError('export must not wait for lifecycle')), \
                        patch.object(self.controller, 'host_log_exporter') as exporter:
                    self.assertEqual(request(body, signed=False)[0], 403)
                    exporter.assert_not_called()
                    self.controller._host_log_export_lock.acquire()
                    try:
                        self.assertEqual(request(body)[0], 429)
                        exporter.assert_not_called()
                    finally:
                        self.controller._host_log_export_lock.release()
                    exporter.return_value = logs
                    self.assertEqual(request(b'{"since":1,"until":0}')[0], 400)
                    with patch.object(logs, 'command', return_value=(b'', 'command_failed')):
                        status, headers, payload = request(body)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers['Content-Type'], 'application/zip')
                    self.assertEqual(int(headers['Content-Length']), len(payload))
                    self.assertEqual(headers['Cache-Control'], 'no-store')
                    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                        self.assertTrue(json.loads(archive.read('host/manifest.json'))['partial'])
            finally:
                server.shutdown()
                worker.join(timeout=4)
