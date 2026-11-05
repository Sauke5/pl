"""The HTTPS update screen remains truthful when its API is stopped."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest
import uuid
from unittest.mock import Mock, patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pl_upgrade_status_delivery', BASE / 'delivery.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)
spec = importlib.util.spec_from_file_location('pl_upgrade_status_bootstrap', BASE / 'bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class UpgradeStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('config', 'private', 'state', 'releases'):
            (self.root / name).mkdir(mode=0o700)
        self.state = {'product': 'PL', 'install_id': 'pl-123456abcdef', 'version': '0.4.4',
                      'phase': 'ready', 'config': {'secret': 'not-public'}}
        delivery.atomic(self.root / 'state/installation.json', self.state)
        self.parent = types.SimpleNamespace(root=self.root, installation=self.state['install_id'], docker=Mock())
        self.d = delivery.Delivery(self.parent)
        self.path = self.root / 'run/upgrade-status/status.json'
        self.operation = {'operation_id': str(uuid.uuid4()), 'kind': 'upgrade', 'version': '0.4.5',
                          'phase': 'queued', 'started_at': '2026-11-05T20:00:00Z',
                          'artifact': {'url': 'https://example.test/private-token'}, 'snapshot': '/private/backup',
                          'last_failure': {'trace': 'private traceback'}, 'worker_unit': 'private.service'}

    def publish(self, operation=None):
        if operation is not None:
            delivery.atomic(self.d.base / 'operation.json', operation)
        self.d.publish_upgrade_status()

    def public(self):
        return json.loads(self.path.read_bytes())

    def test_no_operation_has_no_active_update_or_inferred_health(self):
        self.publish()
        self.assertEqual(self.public(), {'active': False, 'ready': False, 'current_version': '0.4.4'})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o755)
        self.assertFalse((self.path.parent / 'active').exists())

    def test_only_allowlisted_operation_fields_are_published(self):
        self.publish(self.operation)
        value = self.public()
        self.assertTrue(value['active'])
        self.assertFalse(value['ready'])
        self.assertEqual(set(value['operation']), {'operation_id', 'kind', 'version', 'phase', 'started_at', 'recovery_mode'})
        self.assertNotIn('private', json.dumps(value))
        self.assertNotIn('secret', json.dumps(value))
        self.assertEqual((self.root / 'state/installation.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.path.parent / 'active').is_file())

    def test_phase_updates_survive_a_new_controller_instance(self):
        delivery.atomic(self.d.base / 'operation.json', self.operation)
        self.d.operation('snapshot', error='private-error-token', finished_at='not a timestamp')
        other = delivery.Delivery(self.parent)
        other.publish_upgrade_status()
        self.assertEqual(self.public()['operation']['phase'], 'snapshot')
        self.assertNotIn('error', self.public()['operation'])
        self.assertNotIn('finished_at', self.public()['operation'])

    def test_terminal_requires_restored_ready_installation_and_uses_fixed_error(self):
        for phase in ('complete', 'failed', 'rolled_back'):
            with self.subTest(phase=phase):
                operation = {**self.operation, 'phase': phase, 'error': 'private-exception-token'}
                state = {**self.state, 'phase': 'upgrading'}
                delivery.atomic(self.root / 'state/installation.json', state)
                self.publish(operation)
                self.assertFalse(self.public()['ready'])
                self.assertFalse(self.public()['active'])
                delivery.atomic(self.root / 'state/installation.json', self.state)
                self.publish(operation)
                self.assertTrue(self.public()['ready'])
                self.assertFalse((self.path.parent / 'active').exists())
                self.assertNotIn('private-exception-token', json.dumps(self.public()))

    def test_configuration_and_unknown_phase_do_not_fake_a_normal_upgrade(self):
        self.publish({**self.operation, 'kind': 'configuration'})
        self.assertEqual(self.public(), {'active': False, 'ready': False, 'current_version': '0.4.4'})
        self.assertTrue((self.path.parent / 'active').is_file())
        self.publish({**self.operation, 'phase': 'internal-secret'})
        self.assertEqual(self.public()['operation']['phase'], 'recovery_required')
        self.assertTrue(self.public()['active'])
        self.assertFalse(self.public()['ready'])

    def test_incomplete_legacy_journal_does_not_block_recovery_or_fake_activity(self):
        for value in ({'operation_id': 'invalid'}, {**self.operation, 'version': None},
                      {**self.operation, 'phase': []}, {**self.operation, 'phase': {}}):
            with self.subTest(value=value):
                self.publish(value)
                self.assertEqual(self.public(), {'active': False, 'ready': False, 'current_version': '0.4.4'})

    def test_delayed_progress_publisher_cannot_overwrite_completion(self):
        journal = self.d.base / 'operation.json'
        delivery.atomic(journal, {**self.operation, 'phase': 'snapshot'})
        entered, release, completed = threading.Event(), threading.Event(), threading.Event()
        original = delivery.atomic
        errors = []
        def atomic(path, value, **kwargs):
            if path == self.path and value.get('operation', {}).get('phase') == 'snapshot':
                entered.set()
                if not release.wait(3):
                    raise TimeoutError('test publisher not released')
            original(path, value, **kwargs)
            if path == journal and value.get('phase') == 'complete':
                completed.set()
        def run(function):
            try:
                function()
            except BaseException as error:
                errors.append(error)
        with patch.object(delivery, 'atomic', side_effect=atomic):
            first = threading.Thread(target=run, args=(self.d.publish_upgrade_status,))
            second = threading.Thread(target=run, args=(lambda: self.d.operation('complete'),))
            first.start()
            try:
                self.assertTrue(entered.wait(2))
                second.start()
                self.assertTrue(completed.wait(2))
            finally:
                release.set()
                first.join(3)
                if second.ident is not None:
                    second.join(3)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(delivery.read(journal)['phase'], 'complete')
        self.assertEqual(self.public()['operation']['phase'], 'complete')
        self.assertFalse(self.public()['active'])

    def test_reconciliation_reads_journal_after_worker_lock(self):
        journal = self.d.base / 'operation.json'
        delivery.atomic(journal, {**self.operation, 'phase': 'snapshot'})
        original = self.d.worker_lock
        from contextlib import contextmanager
        @contextmanager
        def complete_then_lock(*args, **kwargs):
            delivery.atomic(journal, {**self.operation, 'phase': 'complete'})
            with original(*args, **kwargs):
                yield
        self.d.worker_lock = complete_then_lock
        self.d.worker_active = Mock(return_value=False)
        self.d.reconcile_upgrade()
        self.assertEqual(delivery.read(journal)['phase'], 'complete')
        self.assertEqual(self.public()['operation']['phase'], 'complete')
        self.d.worker_active.assert_called_once()

    def test_background_orphan_detection_does_not_need_a_running_api(self):
        delivery.atomic(self.d.base / 'operation.json', {**self.operation, 'phase': 'snapshot'})
        self.d.worker_active = Mock(return_value=False)
        with self.d.status_monitor(interval=0.01):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if self.path.exists() and self.public()['operation']['phase'] == 'recovery_required':
                    break
                time.sleep(0.01)
            else:
                self.fail('orphan status was not published without API requests')
        self.assertTrue(self.public()['active'])
        self.assertFalse(self.public()['ready'])
        self.assertEqual(delivery.read(self.d.base / 'operation.json')['phase'], 'recovery_required')
        self.parent.docker.assert_not_called()

    def test_active_unit_status_probe_does_not_steal_starting_workers_os_lock(self):
        delivery.atomic(self.d.base / 'operation.json', self.operation)
        entered, release = threading.Event(), threading.Event()
        errors = []
        def unit_active(operation):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('status query did not finish')
            return True
        self.d.worker_active = unit_active
        def observe():
            try:
                self.d.reconcile_upgrade()
            except BaseException as error:
                errors.append(error)
        reader = threading.Thread(target=observe)
        reader.start()
        try:
            self.assertTrue(entered.wait(2))
            script = ('import fcntl,sys; f=open(sys.argv[1],"a"); '
                      'fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)')
            worker = subprocess.run([sys.executable, '-c', script, str(self.d.base / 'worker.lock')],
                                    capture_output=True, text=True, timeout=2)
            self.assertEqual(worker.returncode, 0, 'an active-unit status read blocked real worker startup: ' + worker.stderr)
        finally:
            release.set()
            reader.join(4)
        self.assertEqual(errors, [])
        self.assertEqual(delivery.read(self.d.base / 'operation.json')['phase'], 'queued')

    def test_unknown_unit_liveness_neither_takes_worker_lock_nor_declares_an_orphan(self):
        operation = {**self.operation, 'worker_unit': self.state['install_id'] + '-upgrade-' + uuid.uuid4().hex + '.service'}
        delivery.atomic(self.d.base / 'operation.json', operation)
        self.d.host = Mock(side_effect=OSError('service manager unavailable'))
        self.d.worker_lock = Mock(side_effect=AssertionError('unknown liveness must not take the startup lock'))
        self.d.reconcile_upgrade()
        self.assertEqual(delivery.read(self.d.base / 'operation.json')['phase'], 'queued')
        self.d.worker_lock.assert_not_called()

    def test_worker_liveness_requires_a_known_service_manager_state(self):
        operation = {**self.operation, 'worker_unit': self.state['install_id'] + '-upgrade-' + uuid.uuid4().hex + '.service'}
        for state, expected in ((b'active', True), (b'activating', True), (b'reloading', True),
                                (b'deactivating', True), (b'inactive', False), (b'failed', False),
                                (b'', None), (b'unknown-future-state', None)):
            with self.subTest(state=state):
                self.d.host = Mock(return_value=state + b'\n')
                self.assertIs(self.d.worker_active(operation), expected)

    def test_direct_worker_admission_waits_for_orphan_reader_and_releases_delivery_barrier(self):
        delivery.atomic(self.d.base / 'operation.json', {**self.operation, 'phase': 'snapshot'})
        entered, release = threading.Event(), threading.Event()
        probes = []
        errors = []
        def inactive(operation):
            probes.append(operation['phase'])
            if len(probes) == 2:
                entered.set()
                if not release.wait(3):
                    raise RuntimeError('orphan query did not finish')
            return False
        self.d.worker_active = inactive
        def observe():
            try:
                self.d.reconcile_upgrade()
            except BaseException as error:
                errors.append(error)
        reader = threading.Thread(target=observe)
        reader.start()
        child = None
        try:
            self.assertTrue(entered.wait(2))
            script = ('import importlib.util,sys,types; from pathlib import Path; '
                      's=importlib.util.spec_from_file_location("worker_fixture",sys.argv[1]); '
                      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
                      'd=m.Delivery(types.SimpleNamespace(root=Path(sys.argv[2]),installation=sys.argv[3])); '
                      '\nwith d.worker_admission():\n print("acquired",flush=True)\n sys.stdin.readline()\n')
            child = subprocess.Popen([sys.executable, '-c', script, str(BASE / 'delivery.py'),
                                      str(self.root), self.state['install_id']],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(0.1)
            self.assertIsNone(child.poll(), 'direct recovery must wait for the reader instead of failing startup')
            release.set()
            reader.join(4)
            import select
            self.assertTrue(select.select([child.stdout], [], [], 3)[0], 'direct worker did not acquire its startup lock')
            self.assertEqual(child.stdout.readline().strip(), 'acquired')
            with self.d.lock(exclusive=False, blocking=False):
                with self.assertRaises(BlockingIOError):
                    with self.d.worker_lock(blocking=False):
                        pass
            child.stdin.write('\n'); child.stdin.flush()
            self.assertEqual(child.wait(timeout=3), 0)
        finally:
            release.set()
            reader.join(4)
            if child is not None:
                if child.poll() is None:
                    child.kill(); child.wait(timeout=3)
                for stream in (child.stdin, child.stdout, child.stderr):
                    stream.close()
        self.assertEqual(errors, [])

    def test_killed_worker_is_detected_after_its_real_os_lock_is_released(self):
        delivery.atomic(self.d.base / 'operation.json', {**self.operation, 'phase': 'snapshot'})
        script = ('import fcntl,sys,time; f=open(sys.argv[1],"a"); '
                  'fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(10)')
        child = subprocess.Popen([sys.executable, '-c', script, str(self.d.base / 'worker.lock')],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.d.worker_active = Mock(return_value=False)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            with self.d.status_monitor(interval=0.01):
                deadline = time.monotonic() + 2
                while not self.path.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(self.public()['operation']['phase'], 'snapshot')
                self.d.worker_active.assert_called()
                child.kill(); child.wait(timeout=3)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if self.public()['operation']['phase'] == 'recovery_required':
                        break
                    time.sleep(0.01)
                else:
                    self.fail('killed worker was not marked for recovery')
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=3)
            child.stdout.close(); child.stderr.close()
        self.parent.docker.assert_not_called()

    def test_public_directory_cannot_redirect_writes_to_another_directory(self):
        (self.root / 'run').mkdir()
        (self.root / 'run/upgrade-status').symlink_to(self.root / 'private', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            self.publish(self.operation)
        self.assertFalse((self.root / 'private/status.json').exists())

    def test_quiesce_leaves_only_stateless_web_running(self):
        containers = [{'name': name, 'running': True, 'core': True, 'service': name} for name in ('web', 'api', 'db')]
        containers.append({'name': 'module-db', 'running': True, 'core': False, 'service': ''})
        inspected = json.dumps([{'State': {'Running': False}} for _ in range(3)]).encode()
        self.parent.docker.return_value = inspected
        self.d.stop(containers, keep_web=True)
        calls = self.parent.docker.call_args_list
        self.assertEqual(calls[0].args, ('container', 'stop', '--time', '30', 'api'))
        self.assertEqual(calls[1].args, ('container', 'stop', '--time', '30', 'db', 'module-db'))
        self.assertNotIn('web', calls[2].args)
        self.parent.docker.reset_mock()
        self.d.stop(containers)
        self.assertIn('web', self.parent.docker.call_args_list[0].args)

    def test_upgrade_adds_only_readonly_status_mount_and_preserves_config(self):
        original = {'services': {name: {'image': 'old', 'volumes': []} for name in ('api', 'web', 'db')}}
        original['services']['api']['environment'] = {'PORTAL_ALLOWED_CIDRS': '192.0.2.0/24'}
        original['services']['web']['ports'] = ['127.0.0.1:8443:8443']
        delivery.atomic(self.root / 'config/compose.json', original)
        manifest = {'images': {name: {'id': 'new-' + name} for name in ('api', 'web', 'db')},
                    'features': {'upgrade_status': True}}
        result = self.d.upgraded_model(self.root / 'releases', manifest, self.state)
        self.assertEqual(result['services']['api']['environment'], {**original['services']['api']['environment'], 'PORTAL_MAINTENANCE_DIR': '/run/pl-upgrade'})
        self.assertEqual(result['services']['web']['ports'], original['services']['web']['ports'])
        self.assertEqual(result['services']['web']['volumes'], [{
            'type': 'bind', 'source': str(self.root / 'run/upgrade-status'), 'target': '/run/pl-upgrade',
            'read_only': True, 'bind': {'create_host_path': False}}])
        self.assertEqual(delivery.read(self.root / 'config/compose.json'), original)

    def test_web_switch_waits_for_api_and_reloads_even_when_image_id_is_unchanged(self):
        delivery.atomic(self.d.base / 'operation.json', self.operation)
        self.d.compose = Mock()
        order = []
        self.d.compose.side_effect = lambda *args: order.append(args[-1])
        self.d.readiness = Mock(side_effect=lambda: order.append('api-ready'))
        self.d.restart([])
        calls = self.d.compose.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args[-2:], ('db', 'api'))
        self.assertIn('--wait', calls[0].args)
        self.assertEqual(calls[1].args[-1], 'web')
        self.assertIn('--force-recreate', calls[1].args)
        self.assertIn('--no-deps', calls[1].args)
        self.assertEqual(order, ['api', 'api-ready', 'web'])

    def test_api_running_is_not_treated_as_ready(self):
        self.d.readiness = Mock(side_effect=[OSError('starting'), ValueError('migrating'), None])
        with patch.object(delivery.time, 'sleep') as sleep:
            self.d.wait_readiness()
        self.assertEqual(self.d.readiness.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_fresh_model_mounts_only_public_directory_when_feature_is_enabled(self):
        manifest = {'features': {'upgrade_status': True}, 'images': {'api': {'id': 'a'}, 'web': {'id': 'w'}, 'db': {'ref': 'd'}}}
        cfg = bootstrap.configuration('https://pl.example.test', '127.0.0.1', 'admin')
        model = bootstrap.compose_model(self.root, manifest, cfg, self.state['install_id'])
        volumes = model['services']['web']['volumes']
        self.assertEqual(volumes[-1]['target'], '/run/pl-upgrade')
        self.assertTrue(volumes[-1]['read_only'])
        self.assertFalse(any(v['source'] == str(self.root / 'state') for v in volumes))
        legacy = bootstrap.compose_model(self.root, {**manifest, 'features': {}}, cfg, self.state['install_id'])
        self.assertNotIn('/run/pl-upgrade', [v['target'] for v in legacy['services']['web']['volumes']])


if __name__ == '__main__':
    unittest.main()
