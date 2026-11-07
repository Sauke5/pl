"""Persistent async inventory orchestration, admission and secret boundaries."""
import copy
import base64
from concurrent.futures import Future
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import Mock, patch

import test_netmap_access_profiles as shared
from test_inventory_collectors_transport import HAS_SSH, SSHFixture
import inventory_jobs as jobs


class QueuedExecutor:
    def __init__(self):
        self.calls = []

    def submit(self, function, *args):
        self.calls.append((function, args))
        return Future()

    def run(self):
        function, args = self.calls.pop(0)
        function(*args)

    def shutdown(self, **kwargs):
        pass


class InventoryJobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = shared.service.Application.__new__(shared.service.Application)
        self.app.store = shared.service.Store(Path(self.temp.name) / 'state.sqlite3')
        self.app.poll_lock, self.app.mutation_lock = threading.Lock(), threading.Lock()
        self.app.netbox = Mock()
        self.executor = QueuedExecutor()
        self.snapshot = {'schema': 1, 'kind': 'linux', 'observed_at': jobs.now(), 'hostname': 'test-linux',
            'interfaces': [{'name': 'eth0', 'addresses': [{'address': '192.0.2.1/24'}]}], 'disks': [], 'warnings': []}
        self.collector = Mock(return_value=self.snapshot)
        self.writer = Mock(return_value={'schema': 1, 'state': 'succeeded', 'object_id': 4, 'created': 1, 'conflicts': 0, 'errors': 0})
        self.manager = self.app.inventory = jobs.InventoryJobs(self.app, collector=self.collector, writer=self.writer, executor=self.executor)
        # Profile normalization/transport are exercised by collector tests. Keep
        # orchestration failures independent of SSH crypto availability here.
        self.validation = patch.object(jobs, 'validate_profile', side_effect=lambda value: value)
        self.validation.start()
        self.addCleanup(self.validation.stop)
        self.profile = self.manager.save_profile({'name': 'Linux', 'kind': 'linux', 'username': 'readonly',
            'password': 'fixture-password', 'ssh_known_hosts': 'fixture-trusted-host', 'auth_method': 'password'})['id']
        self.target = self.manager.save_target({'name': 'Linux test', 'kind': 'linux', 'address': '192.0.2.1', 'profile_id': self.profile})['id']

    def start(self, target=None):
        return self.app.mutation('/api/inventory/targets/' + (target or self.target) + '/collect', {},
            {'idempotency_key': str(uuid.uuid4()), 'sub': 'local:test'})

    def test_accept_returns_before_network_io_and_replay_does_not_repeat(self):
        operation = str(uuid.uuid4())
        claims = {'idempotency_key': operation, 'sub': 'local:test'}
        path = '/api/inventory/targets/' + self.target + '/collect'
        first = self.app.mutation(path, {}, claims)
        self.assertEqual(first, {'id': operation, 'state': 'queued'})
        self.assertEqual(self.app.mutation(path, {}, claims), first)
        self.assertEqual(len(self.executor.calls), 1)
        self.collector.assert_not_called()
        self.executor.run()
        item = self.manager.jobs()['items'][0]
        self.assertEqual(item['state'], 'succeeded')
        self.assertEqual(item['result']['summary']['addresses'], 1)
        self.assertEqual(item['result']['sync']['object_id'], 4)
        self.assertEqual(item['actor'], 'local:test')
        self.assertNotIn('fixture-password', json.dumps(item))
        self.assertNotIn('fixture-trusted-host', json.dumps(self.manager.profiles()))

    def test_guided_enrollment_saves_device_and_queues_first_collection_once(self):
        operation = str(uuid.uuid4())
        claims = {'idempotency_key': operation, 'sub': 'local:test'}
        body = {'address': '192.0.2.20', 'kind': 'network',
                'profile': {'username': 'router-reader', 'password': 'enrollment-fixture',
                            'port': 2222, 'ssh_known_hosts': '[192.0.2.20]:2222 ssh-ed25519 fixture'}}
        result = self.app.mutation('/api/inventory/enroll', body, claims)
        self.assertEqual(result['job_id'], operation)
        self.assertEqual(result['state'], 'queued')
        self.assertEqual(self.manager.target(result['target_id'])['profile_id'], result['profile_id'])
        self.assertEqual(self.manager.target(result['target_id'])['name'], body['address'])
        self.assertEqual(self.manager.profile(result['profile_id'])['driver'], 'auto')
        self.collector.assert_not_called()
        self.assertEqual(self.app.mutation('/api/inventory/enroll', body, claims), result)
        with self.assertRaises(jobs.InventoryError) as conflict:
            self.app.mutation('/api/inventory/enroll', {**body, 'name': 'Different device'}, claims)
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(len(self.executor.calls), 1)
        self.executor.run()
        self.assertEqual(self.manager.jobs()['items'][0]['state'], 'succeeded')
        for view in (result, self.manager.jobs(), self.manager.targets(), self.manager.profiles()):
            self.assertNotIn('enrollment-fixture', json.dumps(view))

    def test_rejected_enrollment_leaves_no_orphan_profile_or_target(self):
        path = '/api/inventory/enroll'
        initial = (self.manager.profiles(), self.manager.targets(), self.manager.jobs())
        body = {'address': '192.0.2.1', 'kind': 'network', 'profile': {
            'username': 'router-reader', 'password': 'enrollment-fixture',
            'ssh_known_hosts': '192.0.2.1 ssh-ed25519 fixture'}}
        for candidate, error in (
            (body, 'inventory_address_exists'),
            ({**body, 'address': '192.0.2.2'}, 'inventory_host_key_required'),
            ({**body, 'network_id': '1234567890abcdef'}, 'inventory_network_mismatch'),
        ):
            with self.subTest(error=error), self.assertRaises(jobs.InventoryError) as rejected:
                self.app.mutation(path, candidate, {'idempotency_key': str(uuid.uuid4()), 'sub': 'local:test'})
            self.assertEqual(rejected.exception.code, error)
            self.assertEqual(initial, (self.manager.profiles(), self.manager.targets(), self.manager.jobs()))
        self.assertEqual(self.executor.calls, [])

    def test_host_key_preview_checks_address_port_and_carries_no_credentials(self):
        path = '/api/inventory/ssh-host-key'
        claims = {'idempotency_key': str(uuid.uuid4()), 'sub': 'local:test'}
        body = {'address': '192.0.2.20', 'port': 22}
        with patch.object(jobs, 'read_ssh_host_key', return_value={'fingerprint': 'SHA256:fixture'}) as read:
            result = self.app.mutation(path, body, claims)
            self.assertEqual(self.app.mutation(path, body, claims), result)
            for invalid in ({**body, 'password': 'disallowed'}, {**body, 'port': True},
                            {**body, 'address': '169.254.169.254'}, {**body, 'address': '127.0.0.1'}):
                with self.assertRaises(jobs.InventoryError):
                    self.app.mutation(path, invalid, {**claims, 'idempotency_key': str(uuid.uuid4())})
            read.assert_called_once_with('192.0.2.20', 22)
        self.collector.assert_not_called()
        self.assertFalse(self.executor.calls)

    @unittest.skipUnless(HAS_SSH, 'Install pinned SSH requirements for transport acceptance')
    def test_host_key_exchange_stops_before_authentication(self):
        server = SSHFixture()
        self.addCleanup(server.close)
        key = jobs.read_ssh_host_key('127.0.0.1', server.port)
        expected = base64.b64encode(hashlib.sha256(server.key.asbytes()).digest()).decode().rstrip('=')
        self.assertEqual(key['fingerprint'], 'SHA256:' + expected)
        self.assertEqual(key['known_hosts'], f'[127.0.0.1]:{server.port} {server.key.get_name()} {server.key.get_base64()}')
        self.assertEqual(server.auth_calls, [])
        self.assertEqual(server.commands, [])

    def test_interrupted_mutation_reservation_cannot_be_replayed_as_success(self):
        operation = str(uuid.uuid4())
        path = '/api/inventory/targets/' + self.target + '/collect'
        import hashlib
        fingerprint = hashlib.sha256(path.encode() + b'\n{}').hexdigest()
        with self.app.store.connect() as db:
            db.execute('INSERT INTO requests VALUES(?,?,?)', (operation, fingerprint,
                json.dumps({'error': 'operation interrupted; inspect before explicit retry'})))
        with self.assertRaises(jobs.InventoryError) as error:
            self.app.mutation(path, {}, {'idempotency_key': operation, 'sub': 'local:test'})
        self.assertEqual((error.exception.code, error.exception.status), ('inventory_interrupted', 503))
        self.assertFalse(self.executor.calls)

    def test_pending_job_protects_target_profile_and_queue_is_bounded(self):
        self.start()
        for change in (lambda: self.start(),
                       lambda: self.manager.remove('profiles', self.profile),
                       lambda: self.manager.remove('targets', self.target),
                       lambda: self.manager.save_profile({'id': self.profile, 'password': 'new'}),
                       lambda: self.manager.save_target({'id': self.target, 'name': 'Changed'})):
            with self.assertRaises(jobs.InventoryError) as error:
                change()
            self.assertEqual(error.exception.status, 409)
        for index in range(2, 17):
            target = self.manager.save_target({'name': str(index), 'kind': 'linux', 'address': '192.0.2.' + str(index), 'profile_id': self.profile})['id']
            self.start(target)
        target = self.manager.save_target({'name': 'Overflow', 'kind': 'linux', 'address': '192.0.2.17', 'profile_id': self.profile})['id']
        with self.assertRaises(jobs.InventoryError) as error:
            self.start(target)
        self.assertEqual(error.exception.code, 'inventory_busy')

    def test_edit_preserves_credentials_and_auth_switch_clears_old_method(self):
        self.manager.save_profile({'id': self.profile, 'name': 'Renamed', 'password': '', 'ssh_known_hosts': ''})
        value = self.manager.profile(self.profile)
        self.assertEqual((value['password'], value['ssh_known_hosts']), ('fixture-password', 'fixture-trusted-host'))
        self.manager.save_profile({'id': self.profile, 'auth_method': 'key', 'private_key': 'fixture-new-key', 'passphrase': 'phrase'})
        self.assertEqual(self.manager.profile(self.profile)['password'], '')
        self.manager.save_profile({'id': self.profile, 'clear_secrets': ['passphrase']})
        self.assertEqual(self.manager.profile(self.profile)['passphrase'], '')
        public = self.manager.profiles()['items'][0]
        self.assertTrue(public['private_key_set'])
        self.assertFalse(public['password_set'])
        for field in jobs.SECRETS:
            self.assertNotIn(field, public)
        with self.assertRaises(jobs.InventoryError):
            self.manager.save_profile({'id': self.profile, 'clear_secrets': ['foreign']})

    def test_failure_never_becomes_empty_sync_or_leaks_remote_text(self):
        self.collector.side_effect = jobs.InventoryCollectionError('inventory_auth_failed')
        self.start()
        self.executor.run()
        item = self.manager.jobs()['items'][0]
        self.assertEqual(item['state'], 'failed')
        self.writer.assert_not_called()
        self.assertEqual(item['error'], 'inventory_auth_failed')
        self.collector.side_effect = RuntimeError('fixture-password remote private output')
        self.start()
        self.executor.run()
        self.assertNotIn('fixture-password', json.dumps(self.manager.jobs()))

    def test_partial_sync_keeps_report_and_restart_does_not_replay(self):
        self.writer.return_value = {'state': 'partial', 'created': 1, 'conflicts': 1, 'errors': 0}
        self.start()
        self.executor.run()
        self.assertEqual(self.manager.jobs()['items'][0]['state'], 'partial')
        self.start()
        reopened = jobs.InventoryJobs(self.app, collector=self.collector, writer=self.writer, executor=QueuedExecutor())
        item = reopened.jobs()['items'][0]
        self.assertEqual((item['state'], item['error']), ('failed', 'inventory_interrupted'))
        self.assertEqual(len(reopened.executor.calls), 0)

    def test_preview_reads_without_netbox_and_removal_keeps_job_history(self):
        value = self.manager.test_profile(self.profile, {'address': '192.0.2.1'})
        self.assertEqual(value['summary']['hostname'], 'test-linux')
        self.writer.assert_not_called()
        self.assertFalse(self.manager.jobs()['items'])
        with self.assertRaises(jobs.InventoryError):
            self.manager.remove('profiles', self.profile)
        self.start()
        self.executor.run()
        self.manager.remove('targets', self.target)
        self.manager.remove('profiles', self.profile)
        self.assertTrue(self.manager.jobs()['items'])
        self.app.netbox.assert_not_called()

    def test_slow_previews_do_not_hold_mutation_locks_or_queue_unbounded_work(self):
        release = threading.Event()
        entered = threading.Semaphore(0)
        failures = []
        def blocked(*args, **kwargs):
            entered.release()
            if not release.wait(3):
                raise AssertionError('Preview deadlocked the mutation lanes')
            return self.snapshot
        self.collector.side_effect = blocked
        path = '/api/inventory/profiles/' + self.profile + '/test'
        operations = [str(uuid.uuid4()) for _ in range(2)]
        def run(operation):
            try:
                self.app.mutation(path, {'address': '192.0.2.1'}, {'idempotency_key': operation, 'sub': 'local:test'})
            except BaseException as exc:
                failures.append(exc)
        threads = [threading.Thread(target=run, args=(operation,)) for operation in operations]
        try:
            for thread in threads:
                thread.start()
                self.assertTrue(entered.acquire(timeout=1))
            with self.assertRaises(jobs.InventoryError) as error:
                run_result = self.app.mutation(path, {'address': '192.0.2.1'}, {'idempotency_key': str(uuid.uuid4()), 'sub': 'local:test'})
            self.assertEqual(error.exception.code, 'inventory_busy')
            with self.assertRaises(jobs.InventoryError) as duplicate:
                self.app.mutation(path, {'address': '192.0.2.1'}, {'idempotency_key': operations[0], 'sub': 'local:test'})
            self.assertEqual(duplicate.exception.code, 'inventory_preview_running')
            self.assertTrue(self.app.mutation_lock.acquire(timeout=0.1))
            self.app.mutation_lock.release()
            self.assertTrue(self.manager.lock.acquire(timeout=0.1))
            self.manager.lock.release()
            self.manager.save_target({'id': self.target, 'name': 'Still editable'})
        finally:
            release.set()
            for thread in threads:
                thread.join(timeout=3)
        self.assertFalse(failures)
        self.writer.assert_not_called()

    def test_explicit_schedule_no_startup_scan_and_duplicate_tick_does_not_enqueue(self):
        self.manager.schedule_due()
        self.assertFalse(self.executor.calls)
        self.manager.save_target({'id': self.target, 'interval_minutes': 15})
        self.manager.schedule_due()
        self.assertFalse(self.executor.calls)
        with self.app.store.connect() as db:
            db.execute('UPDATE inventory_targets SET next_due=?', (time.time() - 1,))
        self.manager.schedule_due()
        self.manager.schedule_due()
        self.assertEqual(len(self.executor.calls), 1)
        self.assertEqual(self.manager.jobs()['items'][0]['actor'], 'system:netmap-inventory')

    def test_profile_kind_numeric_address_unique_source_and_interval_are_enforced(self):
        for extra in ({'address': '127.0.0.1'}, {'address': '169.254.169.254'}, {'address': '::ffff:127.0.0.1'},
                      {'address': 'localhost'}, {'kind': 'windows'}, {'interval_minutes': True},
                      {'interval_minutes': 1}, {'network_id': 'f' * 16}):
            with self.subTest(extra=extra), self.assertRaises(jobs.InventoryError):
                self.manager.save_target({'id': self.target, **extra})
        with self.assertRaises(jobs.InventoryError):
            self.manager.save_target({'name': 'Duplicate', 'kind': 'linux', 'address': '192.0.2.1', 'profile_id': self.profile})
        self.assertEqual(self.manager.target(self.target)['address'], '192.0.2.1')

    def test_stored_standalone_target_is_accepted_by_real_collector_validation(self):
        self.validation.stop()
        import inventory_collectors as real
        keytype = b'ssh-ed25519'
        public_key = len(keytype).to_bytes(4, 'big') + keytype + (32).to_bytes(4, 'big') + bytes(range(32))
        for kind in ('linux', 'windows', 'network'):
            profile = {'name': kind, 'kind': kind, 'username': 'readonly', 'password': 'fixture-password'}
            if kind == 'windows':
                profile.update(scheme='http', transport='ntlm', port=5985)
            else:
                profile['ssh_known_hosts'] = '192.0.2.9 ssh-ed25519 ' + base64.b64encode(public_key).decode()
            if kind == 'network':
                profile['driver'] = 'huawei_vrp'
            key = self.manager.save_profile(profile)['id']
            target_id = self.manager.save_target({'name': kind, 'kind': kind, 'address': '192.0.2.' + str(10 + len(self.manager.targets()['items'])), 'profile_id': key})['id']
            target = self.manager.target(target_id)
            self.assertEqual(real._target(target, kind), target['address'])
            self.assertEqual(real.validate_profile(self.manager.profile(key))['kind'], kind)


if __name__ == '__main__':
    unittest.main()
