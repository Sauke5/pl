"""Address discovery contracts without network or Docker access."""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/netmap-stack'))
sys.path.insert(0, str(ROOT / 'apps/netmap'))
spec = importlib.util.spec_from_file_location('pl_netmap_host_test', ROOT / 'apps/netmap-stack/service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class HostDiscovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = service.Application.__new__(service.Application)
        self.app.store = service.Store(Path(self.temp.name) / 'state.sqlite3')
        self.app.mutation_lock = threading.Lock()
        self.app.poll_lock = threading.Lock()
        self.app.reload_collector = Mock(return_value={'state': 'waiting_targets', 'targets': 0})
        self.app.netbox = Mock()
        self.app.netbox.all.side_effect = lambda path: []

    def add_network(self, profile=''):
        return self.app.mutation('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Test', 'profile': profile},
                                 {'idempotency_key': 'network', 'sub': 'tester'})['id']

    def test_basic_probe_only_accepts_ping_or_successful_tcp(self):
        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=None)
        def connect(target, timeout):
            self.assertLessEqual(timeout, 0.2)
            if target[1] == 443:
                return connection
            raise ConnectionRefusedError()
        with patch.object(service.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)), \
             patch.object(service.socket, 'create_connection', side_effect=connect):
            observed = self.app.probe_host('192.0.2.1', time.monotonic() + 30)
        self.assertEqual(observed['methods'], ['tcp:443'])
        self.assertEqual(observed['warnings'], [])
        with patch.object(service.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)), \
             patch.object(service.socket, 'create_connection', side_effect=ConnectionRefusedError):
            observed = self.app.probe_host('192.0.2.1', time.monotonic() + 30)
        self.assertEqual(observed['methods'], ['icmp'])

    def test_collected_vm_is_visible_in_scope_without_invented_host_or_cable(self):
        network = self.add_network()
        machines = [{'id': 1, 'name': 'Observed VM', 'custom_fields': {'pl_inventory_source': 'inventory:test',
            'pl_inventory': {'observed': {'collector_ip': '192.0.2.1'}}}},
            {'id': 2, 'name': 'Other scope', 'custom_fields': {}, 'primary_ip4': {'address': '198.51.100.2/24'}}]
        ports = [{'id': 9, 'name': 'ens18', 'virtual_machine': {'id': 1}, 'enabled': True}]
        self.app.netbox.all.side_effect = lambda path: machines if path == '/virtualization/virtual-machines/' else ports if path == '/virtualization/interfaces/' else []
        graph = self.app.graph('/api/sites/network-' + network)
        self.assertEqual([n['id'] for n in graph['nodes']], ['vm:1'])
        self.assertEqual(graph['nodes'][0]['kind'], 'vm')
        self.assertEqual(graph['nodes'][0]['ports'][0]['name'], 'ens18')
        self.assertIn('/virtualization/virtual-machines/1/', graph['nodes'][0]['netbox_url'])
        self.assertEqual(graph['edges'], [])
        self.assertEqual({n['id'] for n in self.app.graph()['nodes']}, {'vm:1', 'vm:2'})
        self.app.netbox.request.assert_not_called()

    def test_missing_ping_is_visible_while_tcp_still_runs(self):
        with patch.object(service.subprocess, 'run', side_effect=FileNotFoundError), \
             patch.object(service.socket, 'create_connection', side_effect=socket.timeout) as connect:
            observed = self.app.probe_host('192.0.2.1', time.monotonic() + 30)
        self.assertEqual(observed['warnings'], ['icmp_unavailable'])
        self.assertEqual(observed['methods'], [])
        self.assertEqual([call.args[0][1] for call in connect.call_args_list], [22, 80, 443, 445, 3389])

    def test_empty_profile_is_admitted_without_snmp(self):
        network = self.add_network()
        with patch.object(service.threading, 'Thread') as worker:
            result = self.app.start_poll(network, 'basic-poll', 'tester')
        self.assertEqual(result, {'id': 'basic-poll', 'state': 'running'})
        worker.return_value.start.assert_called_once_with()
        self.app.poll_lock.release()

    def test_empty_profile_poll_persists_address_and_stale_without_netbox_mutation(self):
        network = self.add_network()
        def host(address, deadline):
            return {'ip': address, 'methods': ['icmp'] if address.endswith('.1') else [], 'warnings': []}
        with patch.object(self.app, 'probe_host', side_effect=host), patch.object(self.app, 'probe') as snmp:
            first = self.app.poll(network, 'first', 'tester')
        snmp.assert_not_called()
        self.app.netbox.request.assert_not_called()
        self.assertEqual((first['responders'], first['observed_hosts'], first['unresponsive']), (1, 1, 1))
        graph = self.app.graph('/api/sites/network-' + network)
        self.assertEqual(len(graph['nodes']), 1)
        node = graph['nodes'][0]
        self.assertEqual(node['id'], 'observed:' + network + ':192.0.2.1')
        self.assertEqual(node['details']['observation_methods'], ['icmp'])
        self.assertEqual(node['details']['observation_state'], 'observed')
        self.assertTrue(node['details']['last_seen'])
        self.assertEqual(graph['edges'], [])
        with patch.object(self.app, 'probe_host', side_effect=lambda address, deadline: {'ip': address, 'methods': [], 'warnings': ['icmp_unavailable']}):
            second = self.app.poll(network, 'second', 'tester')
        stale = self.app.graph('/api/sites/network-' + network)['nodes'][0]
        self.assertEqual(stale['details']['observation_state'], 'stale')
        self.assertEqual(stale['details']['last_seen'], node['details']['last_seen'])
        self.assertEqual(second['warnings'], ['icmp_unavailable'])

    def test_snmp_enriches_only_snmp_response_and_retains_older_address_observation(self):
        self.app.mutation('/api/profiles', {'id': 'test', 'snmp_community': 'sample', 'username': 'user', 'password': 'secret', 'oxidized_model': 'ios'},
                          {'idempotency_key': 'profile', 'sub': 'tester'})
        network = self.add_network('test')
        device = {'id': 17, 'name': 'Switch', 'role': {'slug': 'pl-network'},
                  'custom_fields': {'pl_source': 'network:' + network, 'collector_ip': '192.0.2.1'}}
        self.app.netbox.all.side_effect = lambda path: [device] if path == '/dcim/devices/' else []
        def snmp(address, profile, deadline):
            return {'ip': address, 'name': 'Switch', 'description': '', 'interfaces': [], 'table_errors': 0} if address.endswith('.1') else None
        def host(address, deadline):
            return {'ip': address, 'methods': ['tcp:443'], 'warnings': []}
        self.app.store.record_observations(network, [{'ip': '192.0.2.1', 'methods': ['icmp']}], '2026-01-01T00:00:00+00:00')
        with patch.object(self.app, 'probe', side_effect=snmp), patch.object(self.app, 'probe_host', side_effect=host), \
             patch.object(self.app, 'enroll', return_value=17) as enroll, \
             patch.object(self.app, 'sync_interfaces', return_value={'interfaces_created': 0, 'interfaces_updated': 0, 'manual_conflicts': 0, 'errors': 0}):
            result = self.app.poll(network, 'poll', 'tester')
        self.assertEqual(enroll.call_count, 1)
        self.assertEqual(enroll.call_args.args[1]['ip'], '192.0.2.1')
        self.assertEqual(result['observed_hosts'], 1)
        graph = self.app.graph('/api/sites/network-' + network)
        self.assertEqual({node['id'] for node in graph['nodes']}, {'device:17', 'observed:' + network + ':192.0.2.1', 'observed:' + network + ':192.0.2.2'})
        prior = next(node for node in graph['nodes'] if node['id'] == 'observed:' + network + ':192.0.2.1')
        self.assertEqual(prior['details']['observation_state'], 'stale')
        self.assertEqual(prior['details']['inventory_matches'], [17])
        self.assertTrue(prior['details']['identity_unconfirmed'])
        self.assertEqual(graph['edges'], [])

    def test_interrupted_poll_preserves_previous_freshness(self):
        network = self.add_network()
        self.app.store.record_observations(network, [{'ip': '192.0.2.1', 'methods': ['icmp']}], '2026-01-01T00:00:00+00:00')
        with patch.object(self.app, 'probe_host', side_effect=RuntimeError('failure')):
            with self.assertRaises(RuntimeError):
                self.app.poll(network, 'poll', 'tester')
        self.assertEqual(self.app.store.observations(network)[0]['state'], 'observed')
        with self.app.store.connect() as db:
            row = db.execute('SELECT state,result FROM polls WHERE id=?', ('poll',)).fetchone()
        self.assertEqual(row['state'], 'error')
        self.assertNotIn('failure', row['result'])

    def test_graph_limits_sql_projection_and_keeps_all_stored_evidence(self):
        network = self.add_network()
        addresses = ['192.0.2.0', '192.0.2.1', '192.0.2.2']
        self.app.store.record_observations(network, [{'ip': ip, 'methods': ['icmp']} for ip in addresses], '2020-01-01T00:00:00+00:00')
        self.app.import_observations(network, {'source': 'router', 'records': [{'ip': ip, 'methods': ['arp']} for ip in addresses]})
        # An observation kept for a removed network must not consume the
        # active projection limit or suppress current-network evidence.
        with self.app.store.connect() as db:
            db.execute("INSERT INTO host_observations VALUES(?,?,?,?,?)", ('0000000000000000', '192.0.2.1', '2020-01-01T00:00:00+00:00', '[\"icmp\"]', 'stale'))
        queries = []
        connect = self.app.store.connect
        def traced_connect():
            db = connect()
            db.set_trace_callback(queries.append)
            return db
        with patch.object(service, 'GRAPH_OBSERVATION_LIMIT', 2), patch.object(service, 'GRAPH_REPORT_LIMIT', 2), \
             patch.object(self.app.store, 'connect', side_effect=traced_connect):
            for path in ('/api/topology', '/api/sites/network-' + network):
                graph = self.app.graph(path)
                self.assertEqual({node['management_ip'] for node in graph['nodes']}, set(addresses[:2]))
                self.assertEqual(len(graph['warnings']), 1)
                self.assertIn('неполн', graph['warnings'][0])
                self.assertIn('наблюдений', graph['warnings'][0])
                self.assertIn('конкретную сеть', graph['warnings'][0])
        for table in ('host_observations', 'host_reports'):
            projections = [query for query in queries if query.startswith('SELECT * FROM ' + table)]
            self.assertEqual(len(projections), 2)
            self.assertTrue(all('LIMIT 3' in query for query in projections))
        self.assertEqual(len(self.app.store.observations(network)), 3)
        self.assertEqual(len(self.app.store.reports(network)), 3)
        self.assertEqual(self.app.graph()['warnings'], [])

    def test_import_reports_are_evidence_not_live_and_do_not_create_cables(self):
        network = self.add_network()
        body = {'source': 'router:dhcp', 'records': [
            {'ip': '192.0.2.1', 'hostname': 'phone', 'mac': 'AA:BB:CC:DD:EE:FF', 'methods': ['dhcp', 'arp'],
             'observed_at': '2020-01-01T00:00:00Z', 'expires_at': '2099-01-01T00:00:00Z'},
            {'ip': '192.0.2.2', 'methods': ['wifi'], 'observed_at': '2020-01-01T00:00:00Z', 'expires_at': '2020-01-02T00:00:00Z'},
        ]}
        result = self.app.mutation('/api/networks/' + network + '/observations', body, {'idempotency_key': 'import', 'sub': 'tester'})
        self.assertEqual(result, {'accepted': 2, 'source': 'router:dhcp'})
        self.app.netbox.request.assert_not_called()
        graph = self.app.graph('/api/sites/network-' + network)
        nodes = {node['management_ip']: node for node in graph['nodes']}
        self.assertEqual(nodes['192.0.2.1']['name'], 'phone')
        self.assertEqual(nodes['192.0.2.1']['details']['observation_state'], 'reported')
        self.assertEqual(nodes['192.0.2.1']['details']['reports'][0]['mac'], 'aa:bb:cc:dd:ee:ff')
        self.assertNotIn('last_seen', nodes['192.0.2.1']['details'])
        self.assertEqual(nodes['192.0.2.2']['details']['observation_state'], 'stale')
        self.assertEqual(graph['edges'], [])
        # An older report cannot roll back the latest report; a separate source survives.
        self.app.import_observations(network, {'source': 'router:dhcp', 'records': [
            {'ip': '192.0.2.1', 'hostname': 'old', 'methods': ['dhcp'], 'observed_at': '2019-01-01T00:00:00Z'}]})
        self.app.import_observations(network, {'source': 'ap', 'records': [
            {'ip': '192.0.2.1', 'methods': ['wifi'], 'observed_at': '2020-01-02T00:00:00Z'}]})
        reports = self.app.store.reports(network)
        self.assertEqual(len(reports), 3)
        self.assertEqual(next(row for row in reports if row['source'] == 'router:dhcp' and row['ip'].endswith('.1'))['hostname'], 'phone')
        node = next(node for node in self.app.graph()['nodes'] if node['management_ip'].endswith('.1'))
        self.assertEqual(len(node['details']['reports']), 2)

    def test_invalid_report_batch_is_rejected_atomically(self):
        network = self.add_network()
        good = {'ip': '192.0.2.1', 'methods': ['arp']}
        bad = [
            {'ip': '198.51.100.1', 'methods': ['arp']},
            {'ip': '192.0.2.1', 'methods': ['arp']},
            {'ip': '192.0.2.2', 'methods': ['ping']},
            {'ip': '192.0.2.2', 'methods': ['arp'], 'mac': 'not-a-mac'},
            {'ip': '192.0.2.2', 'methods': ['arp'], 'hostname': 'bad\nname'},
            {'ip': '192.0.2.2', 'methods': ['arp'], 'observed_at': '2099-01-01T00:00:00Z'},
            {'ip': '192.0.2.2', 'methods': ['arp'], 'expires_at': 'invalid'},
        ]
        for invalid in bad:
            with self.subTest(invalid=invalid), self.assertRaises(service.RequestError) as raised:
                self.app.import_observations(network, {'source': 'router', 'records': [good, invalid]})
            self.assertEqual(raised.exception.code, 'netmap_invalid_observations')
            self.assertEqual(self.app.store.reports(network), [])
        for source in ('', 'contains whitespace', 'x' * 65):
            with self.subTest(source=source), self.assertRaises(service.RequestError):
                self.app.import_observations(network, {'source': source, 'records': []})

    def test_report_merges_with_poll_observation_without_assuming_netbox_identity(self):
        network = self.add_network()
        self.app.store.record_observations(network, [{'ip': '192.0.2.1', 'methods': ['icmp']}], '2020-01-01T00:00:00+00:00')
        self.app.import_observations(network, {'source': 'router', 'records': [{'ip': '192.0.2.1', 'hostname': 'phone',
            'methods': ['dhcp'], 'observed_at': '2020-01-02T00:00:00Z'}]})
        self.app.import_observations(network, {'source': 'old-source', 'records': [{'ip': '192.0.2.1', 'hostname': 'older',
            'methods': ['arp'], 'observed_at': '2020-01-01T00:00:00Z'}]})
        self.app.import_observations(network, {'source': 'expired-source', 'records': [{'ip': '192.0.2.1', 'hostname': 'expired',
            'methods': ['dhcp'], 'observed_at': '2020-01-03T00:00:00Z', 'expires_at': '2020-01-04T00:00:00Z'}]})
        node, = self.app.graph()['nodes']
        self.assertEqual(node['name'], 'phone')
        self.assertEqual(node['details']['observation_state'], 'observed')
        self.assertEqual(len(node['details']['reports']), 3)
        self.assertEqual(next(report for report in node['details']['reports'] if report['source'] == 'router')['methods'], ['dhcp'])
        self.app.import_observations(network, {'source': 'new-source', 'records': [{'ip': '192.0.2.1', 'hostname': 'new-phone',
            'methods': ['wifi'], 'observed_at': '2020-01-05T00:00:00Z'}]})
        node, = self.app.graph()['nodes']
        self.assertEqual(node['name'], 'new-phone')
        self.assertEqual(len(node['details']['reports']), 4)
        self.app.netbox.all.side_effect = lambda path: ([{'id': 3, 'name': 'Manual', 'role': {'slug': 'pl-network'},
            'custom_fields': {'pl_source': 'network:' + network, 'collector_ip': '192.0.2.1'}}] if path == '/dcim/devices/' else [])
        nodes = self.app.graph()['nodes']
        self.assertEqual({node['id'] for node in nodes}, {'device:3', 'observed:' + network + ':192.0.2.1'})
        device = next(node for node in nodes if node['id'] == 'device:3')
        observation = next(node for node in nodes if node['id'].startswith('observed:'))
        self.assertEqual(device['name'], 'Manual')
        self.assertEqual(observation['name'], 'new-phone')
        self.assertEqual(observation['details']['inventory_matches'], [3])
        self.assertTrue(observation['details']['identity_unconfirmed'])
        self.assertEqual(len(observation['details']['reports']), 4)

    def test_overlapping_networks_keep_address_observations_and_scope_matches(self):
        first = self.add_network()
        second = self.app.mutation('/api/networks', {'cidr': '192.0.2.0/29', 'name': 'Second', 'profile': ''},
                                   {'idempotency_key': 'second-network', 'sub': 'tester'})['id']
        for network, source in ((first, 'first'), (second, 'second')):
            self.app.import_observations(network, {'source': source, 'records': [{'ip': '192.0.2.1', 'methods': ['dhcp']}]})
        devices = [{'id': number, 'name': label, 'role': {'slug': 'pl-network'},
                    'custom_fields': {'pl_source': 'network:' + network, 'collector_ip': '192.0.2.1'}}
                   for number, label, network in ((1, 'First', first), (2, 'Second', second))]
        self.app.netbox.all.side_effect = lambda path: devices if path == '/dcim/devices/' else []
        for network, expected in ((first, 1), (second, 2)):
            graph = self.app.graph('/api/sites/network-' + network)
            observed = [node for node in graph['nodes'] if node['id'].startswith('observed:')]
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0]['id'], 'observed:' + network + ':192.0.2.1')
            self.assertEqual(observed[0]['details']['inventory_matches'], [expected])
            self.assertTrue(observed[0]['details']['identity_unconfirmed'])
            self.assertEqual(graph['edges'], [])
        graph = self.app.graph()
        observed = [node for node in graph['nodes'] if node['id'].startswith('observed:')]
        self.assertEqual({node['id'] for node in observed}, {'observed:' + first + ':192.0.2.1', 'observed:' + second + ':192.0.2.1'})


if __name__ == '__main__':
    unittest.main()
