"""Collector idle/start/reload contracts. CI only; no device or native daemon IO."""
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/netmap-stack'))
SPEC = importlib.util.spec_from_file_location('pl_netmap_collector_test', ROOT / 'apps/netmap-stack/service.py')
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)

WAITING = {'state': 'waiting_targets', 'targets': 0}
RELOAD = '/netmap/oxidized/reload'


class MemoryHandler:
    def __init__(self, path):
        self.path, self.command = path, 'GET'
        self.headers = Message()
        self.rfile, self.wfile = io.BytesIO(), io.BytesIO()
        self.response_headers = {}

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.response_headers[name] = value

    def end_headers(self):
        pass


class Clock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, duration):
        if not 0 < duration <= 0.5:
            raise AssertionError('Unbounded readiness sleep')
        self.now += duration


class CollectorLifecycle(unittest.TestCase):
    def setUp(self):
        self.app = service.Application.__new__(service.Application)
        self.app.config = {'hostname': 'pl.example.test'}
        self.app.bootstrap = Mock(return_value={'push_token': 'fixture'})
        self.app.nodes = Mock(return_value=[])
        self.app.verifier = types.SimpleNamespace(verify=Mock(return_value={}))
        self.handler = service.make_handler(self.app, MemoryHandler)

    def request(self, path='/healthz'):
        handler = self.handler(path)
        handler.dispatch()
        return handler.status, handler.wfile.getvalue()

    def test_empty_health_waits_honestly_without_native_probe(self):
        with patch.object(service.http.client, 'HTTPConnection') as native:
            status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'status': 'ready', 'version': '1.0.0', 'collector': WAITING})
        self.app.bootstrap.assert_called_once_with()
        native.assert_not_called()

    def test_bootstrap_and_source_failures_never_become_empty_success(self):
        for failure in ('bootstrap', 'nodes'):
            with self.subTest(failure=failure), patch.object(self.app, failure, side_effect=RuntimeError('unavailable')), \
                 patch.object(service.http.client, 'HTTPConnection') as native:
                status, body = self.request()
                self.assertEqual((status, json.loads(body)), (503, {'status': 'initializing'}))
                native.assert_not_called()

    def test_configured_health_requires_exact_native_names(self):
        self.app.nodes.return_value = [{'name': 'device-17', 'password': 'fixture'}]
        for records, status in (([], 503), ([{'name': 'device-8'}], 503),
                                ([{'name': 'device-17'}, {'name': 'device-8'}], 503),
                                ([{'name': 'device-17'}], 200)):
            response = Mock(status=200)
            response.read.return_value = json.dumps(records).encode()
            connection = Mock()
            connection.getresponse.return_value = response
            with self.subTest(records=records), patch.object(service.http.client, 'HTTPConnection', return_value=connection):
                actual, body = self.request()
            self.assertEqual(actual, status)
            self.assertNotIn(b'fixture', body)
            if status == 200:
                self.assertEqual(json.loads(body)['collector'], {'state': 'ready', 'targets': 1})
            connection.close.assert_called_once_with()

    def test_invalid_native_inventory_is_not_accepted(self):
        self.app.nodes.return_value = [{'name': 'device-17'}]
        for records in ({'nodes': []}, [None], [{'name': []}], [{'name': 'device-17'}] * 2):
            with self.subTest(records=records), patch.object(self.app, '_collector_get', return_value=json.dumps(records).encode()):
                with self.assertRaises(ValueError):
                    self.app.collector_status()

    def test_empty_poll_probes_once_without_startup_wait_or_reload(self):
        with patch.object(self.app, '_collector_names', side_effect=ConnectionRefusedError) as names, \
             patch.object(self.app, '_collector_get') as request, patch.object(service.time, 'sleep') as sleep:
            self.assertEqual(self.app.reload_collector(service.time.monotonic() + 600), WAITING)
        self.assertEqual(names.call_count, 1)
        self.assertLessEqual(names.call_args.args[0], 2)
        request.assert_not_called()
        sleep.assert_not_called()

    def test_empty_poll_clears_previously_loaded_nodes_once(self):
        for after, accepted in ((set(), True), ({'device-17'}, False)):
            with self.subTest(after=after), patch.object(self.app, '_collector_names', side_effect=[{'device-17'}, after]), \
                 patch.object(self.app, '_collector_get') as request, patch.object(service.time, 'sleep') as sleep:
                if accepted:
                    self.assertEqual(self.app.reload_collector(service.time.monotonic() + 600), WAITING)
                else:
                    with self.assertRaises(ValueError):
                        self.app.reload_collector(service.time.monotonic() + 600)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.args[0], RELOAD)
                self.assertLessEqual(request.call_args.args[1], 2)
                sleep.assert_not_called()

    def test_empty_poll_does_not_hide_broken_native_response(self):
        with patch.object(self.app, '_collector_names', side_effect=ValueError('invalid native response')):
            with self.assertRaises(ValueError):
                self.app.reload_collector(service.time.monotonic() + 600)

    def test_first_target_waits_for_native_then_reloads(self):
        self.app.nodes.return_value = [{'name': 'device-17'}]
        with patch.object(self.app, '_collector_names', side_effect=[ConnectionRefusedError(), set(), {'device-17'}]) as names, \
             patch.object(self.app, '_collector_get') as request, patch.object(service.time, 'sleep') as sleep:
            self.assertEqual(self.app.reload_collector(service.time.monotonic() + 600), {'state': 'ready', 'targets': 1})
        self.assertEqual(names.call_count, 3)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[0], RELOAD)
        sleep.assert_called_once()

    def test_existing_native_names_do_not_block_reload_for_new_targets(self):
        self.app.nodes.return_value = [{'name': 'device-17'}, {'name': 'device-18'}]
        with patch.object(self.app, '_collector_names', side_effect=[{'device-17'}, {'device-17', 'device-18'}]), \
             patch.object(self.app, '_collector_get') as request:
            self.assertEqual(self.app.reload_collector(service.time.monotonic() + 600), {'state': 'ready', 'targets': 2})
        self.assertEqual(request.call_count, 1)

    def test_readiness_is_bounded_by_twenty_seconds_and_overall_deadline(self):
        self.app.nodes.return_value = [{'name': 'device-17'}]
        for deadline, expected_end in ((600, 20), (7, 7)):
            clock = Clock()
            with self.subTest(deadline=deadline), patch.object(service.time, 'monotonic', side_effect=clock.monotonic), \
                 patch.object(service.time, 'sleep', side_effect=clock.sleep), \
                 patch.object(self.app, '_collector_names', side_effect=ConnectionRefusedError) as names, \
                 patch.object(self.app, '_collector_get') as request:
                with self.assertRaises(ValueError):
                    self.app.reload_collector(deadline)
                self.assertEqual(clock.now, expected_end)
                self.assertTrue(all(0 < args.args[0] <= 5 for args in names.call_args_list))
                request.assert_not_called()

    def test_stale_extra_node_after_reload_never_passes(self):
        self.app.nodes.return_value = [{'name': 'device-17'}]
        clock = Clock()
        with patch.object(service.time, 'monotonic', side_effect=clock.monotonic), \
             patch.object(service.time, 'sleep', side_effect=clock.sleep), \
             patch.object(self.app, '_collector_names', return_value={'device-17', 'device-8'}), \
             patch.object(self.app, '_collector_get') as request:
            with self.assertRaises(ValueError):
                self.app.reload_collector(600)
        self.assertEqual(clock.now, 20)
        self.assertEqual(request.call_count, 1)

    def test_unknown_reload_result_is_not_replayed(self):
        self.app.nodes.return_value = [{'name': 'device-17'}]
        with patch.object(self.app, '_collector_names', return_value=set()), \
             patch.object(self.app, '_collector_get', side_effect=OSError('unknown result')) as request:
            with self.assertRaises(OSError):
                self.app.reload_collector(service.time.monotonic() + 600)
        self.assertEqual(request.call_count, 1)

    def test_native_proxy_reports_confirmed_unconfigured_source_only(self):
        for source_error, expected_status in ((None, 409), (RuntimeError('source unavailable'), 502)):
            connection = Mock()
            connection.request.side_effect = ConnectionRefusedError
            with self.subTest(source_error=source_error), patch.object(self.app, 'nodes', side_effect=source_error, return_value=[]), \
                 patch.object(service.http.client, 'HTTPConnection', return_value=connection):
                status, body = self.request('/netmap/oxidized/')
            self.assertEqual(status, expected_status)
            self.assertEqual(json.loads(body)['error'], 'collection_not_configured' if status == 409 else 'NetMap operation unconfirmed')

    def test_working_native_response_is_never_replaced(self):
        response = Mock(status=200)
        response.read.return_value = b'<html>native Oxidized</html>'
        response.getheaders.return_value = [('Content-Type', 'text/html')]
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(service.http.client, 'HTTPConnection', return_value=connection):
            self.assertEqual(self.request('/netmap/oxidized/'), (200, b'<html>native Oxidized</html>'))
        self.app.nodes.assert_not_called()

    def test_snmp_only_explicit_poll_completes_without_extra_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            self.app.store = service.Store(Path(directory) / 'netmap.sqlite3')
            self.app.mutation_lock, self.app.poll_lock = threading.Lock(), threading.Lock()
            self.app.mutation('/api/profiles', {'id': 'fixture', 'snmp_community': 'fixture'}, {'idempotency_key': 'profile', 'sub': 'admin'})
            network = self.app.mutation('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': 'fixture'}, {'idempotency_key': 'network', 'sub': 'admin'})
            def snmp_probe(address, profile, deadline):
                return {'ip': address, 'interfaces': []} if address == '192.0.2.1' else None
            with patch.object(self.app, 'probe', side_effect=snmp_probe) as probe, \
                 patch.object(self.app, 'probe_host', return_value={'ip': '192.0.2.2', 'methods': [], 'warnings': []}) as basic, \
                 patch.object(self.app, 'enroll', return_value=17), patch.object(self.app, 'sync_interfaces', return_value={}), \
                 patch.object(service.http.client, 'HTTPConnection', side_effect=ConnectionRefusedError) as native:
                result = self.app.poll(network['id'], 'poll', 'admin')
            self.assertEqual(result['collector'], WAITING)
            self.assertEqual((result['responders'], result['unresponsive']), (1, 1))
            self.assertEqual(probe.call_count, 2)
            self.assertEqual(result['observed_hosts'], 0)
            basic.assert_called_once()
            self.assertEqual(basic.call_args.args[0], '192.0.2.2')
            native.assert_called_once()
            with self.app.store.connect() as db:
                self.assertEqual(db.execute('SELECT state FROM polls WHERE id=?', ('poll',)).fetchone()[0], 'complete')

    def test_snmp_get_and_walk_each_allow_one_retry_with_fixed_process_bounds(self):
        def snmp(args, **kwargs):
            self.assertEqual(args[args.index('-r') + 1], '1')
            self.assertEqual(args[args.index('-t') + 1], '1')
            self.assertEqual(kwargs['timeout'], 5)
            self.assertNotIn('fixture-community', args)
            if args[0] == 'snmpget':
                return types.SimpleNamespace(returncode=0, stdout=b'"switch"\n"switch description"\n')
            self.assertEqual(args[0], 'snmpwalk')
            return types.SimpleNamespace(returncode=0, stdout=b'')
        with patch.object(service.subprocess, 'run', side_effect=snmp) as run:
            result = self.app.probe('192.0.2.1', {'snmp_community': 'fixture-community'})
        self.assertEqual((result['name'], result['table_errors']), ('switch', 0))
        self.assertEqual(run.call_count, 7)


if __name__ == '__main__':
    unittest.main()
