import importlib.util, json, sqlite3, sys, tempfile, threading, time, unittest
from pathlib import Path
from unittest.mock import Mock, patch
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/netmap-stack'))
spec = importlib.util.spec_from_file_location('netmap_ordered_prototype', ROOT / 'apps/netmap-stack/service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

class OrderedProfiles(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state.db'
        self.app = service.Application.__new__(service.Application)
        self.app.store = service.Store(self.path)
        self.app.mutation_lock = threading.Lock()
        self.app.poll_lock = threading.Lock()
        self.n = 0
        for name in ('a', 'b', 'c', 'd', 'e'):
            self.change('/api/profiles', {'id': name, 'snmp_community': 'private-' + name})

    def change(self, path, body):
        self.n += 1
        return self.app.mutation(path, body, {'idempotency_key': 'case-' + str(self.n), 'sub': 'fixture'})

    def network(self, **extra):
        return self.change('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': 'a', **extra})['id']

    def test_create_only_preserves_network_access_for_an_existing_canonical_cidr(self):
        body = {'cidr': '2001:db8::/126', 'name': 'Configured', 'profile': 'a',
                'snmp_profiles': ['b', 'a'], 'create_only': True}
        original = self.change('/api/networks', body)
        self.assertTrue(original['created'])
        duplicate = self.change('/api/networks', {**body, 'cidr': '2001:0db8:0:0:0:0:0:0/126',
                                                   'name': 'Duplicate', 'profile': '', 'snmp_profiles': []})
        self.assertEqual(duplicate, {**original, 'created': False})
        network = self.app.networks_view()['items'][0]
        self.assertEqual((network['name'], network['profile'], network['snmp_profiles']),
                         ('Configured', 'a', ['b', 'a']))

    def test_four_column_legacy_rows_and_omission_preserve_explicit_order_and_empty(self):
        network = self.network(snmp_profiles=['b', 'a'])
        self.network(profile='c')
        self.assertEqual(self.app.store.snmp_profiles(network), ['b', 'a'])
        self.network(snmp_profiles=[])
        self.network()
        self.assertEqual(self.app.store.snmp_profiles(network), [])
        with self.app.store.connect() as db:
            self.assertEqual([r['name'] for r in db.execute('PRAGMA table_info(networks)')], ['id', 'cidr', 'name', 'profile'])
            db.execute('INSERT INTO networks VALUES(?,?,?,?)', ('legacy', '192.0.2.4/30', 'Legacy', 'b'))
        reopened = service.Store(self.path)
        self.assertEqual(reopened.snmp_profiles(network), [])
        self.assertIsNone(reopened.snmp_profiles('legacy'))
        self.assertEqual([n for n, p in self.app.snmp_candidates(next((n for n in self.app.store.networks() if n['id'] == 'legacy')))], ['b'])

    def test_order_is_explicit_unique_bounded_and_resolves_snmp_profiles(self):
        for bad in (None, 'a', ['a', 'a'], ['a', 'b', 'c', 'd', 'e'], ['missing'], [{}], ['a/foreign']):
            with self.subTest(bad=bad), self.assertRaises(service.RequestError):
                self.network(snmp_profiles=bad)

    def test_first_valid_response_short_circuits_in_order_and_records_only_safe_metadata(self):
        network = self.network(snmp_profiles=['b', 'a', 'c'])
        row = self.app.store.networks()[0]
        calls = []

        def probe(address, profile, deadline):
            calls.append(profile['snmp_community'])
            return {'ip': address} if profile['snmp_community'] == 'private-a' else None
        self.app.probe = probe
        deadline = time.monotonic() + 600
        found, attempts = self.app.probe_profiles('192.0.2.1', self.app.snmp_candidates(row), deadline)
        self.assertEqual(calls, ['private-b', 'private-a'])
        self.assertEqual([a['profile_id'] for a in attempts], ['b', 'a'])
        self.assertEqual([a['outcome'] for a in attempts], ['unconfirmed', 'responded'])
        self.assertNotIn('private', json.dumps(attempts))
        self.assertEqual(found['ip'], '192.0.2.1')

    def test_profiles_share_one_deadline_and_do_not_start_after_expiry(self):
        self.network(snmp_profiles=['a', 'b'])
        candidates = self.app.snmp_candidates(self.app.store.networks()[0])
        clock = [0]
        seen = []

        def probe(address, profile, deadline):
            seen.append(deadline)
            clock[0] = 600
            return None
        self.app.probe = probe
        with patch.object(service.time, 'monotonic', side_effect=lambda: clock[0]):
            found, attempts = self.app.probe_profiles('192.0.2.1', candidates, 600)
        self.assertIsNone(found)
        self.assertEqual(seen, [600])
        self.assertEqual(len(attempts), 1)

    def test_each_native_subprocess_timeout_is_capped_to_remaining_poll_budget(self):
        with patch.object(service.time, 'monotonic', return_value=9.75), patch.object(service.subprocess, 'run', return_value=type('Response', (), {'returncode': 1})()) as run:
            self.assertIsNone(self.app.probe('192.0.2.1', {'snmp_community': 'secret'}, 10))
        self.assertEqual(run.call_args.kwargs['timeout'], 0.25)
        self.assertNotIn('secret', ' '.join(run.call_args.args[0]))

    def test_two_devices_choose_different_profiles_in_one_network_poll(self):
        network = self.network(snmp_profiles=['a', 'b'])
        seen = []

        def probe(address, profile, deadline):
            seen.append((address, profile['snmp_community']))
            return {'ip': address, 'interfaces': []} if (address, profile['snmp_community']) in [('192.0.2.1', 'private-a'), ('192.0.2.2', 'private-b')] else None
        self.app.probe = probe
        self.app.enroll = Mock(side_effect=lambda n, o: int(o['ip'].split('.')[-1]))
        self.app.sync_interfaces = Mock(return_value={})
        self.app.reload_collector = Mock(return_value={'state': 'waiting_targets', 'targets': 0})
        self.app.probe_host = Mock()
        result = self.app.poll(network, 'poll-operation', 'fixture')
        self.assertEqual(result['devices'], 2)
        self.assertEqual([(x['ip'], [a['profile_id'] for a in x['attempts']]) for x in result['snmp_attempts']], [('192.0.2.1', ['a']), ('192.0.2.2', ['a', 'b'])])
        self.app.probe_host.assert_not_called()
        self.assertNotIn('private', json.dumps(result))
if __name__ == '__main__':
    unittest.main()
