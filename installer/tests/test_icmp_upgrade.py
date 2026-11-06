"""ICMP host transactions and the real legacy updater's pre-snapshot bridge."""
import copy
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import Mock, patch

BASE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


h = load('pl_icmp_transaction_test', BASE / 'icmp-install.py')
d = load('pl_icmp_delivery_test', BASE / 'delivery.py')
b = load('pl_icmp_bootstrap_test', BASE / 'bootstrap.py')


class HostTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pl-it-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root, self.host, self.package = base / 'root', base / 'host', base / 'package'
        for path in (self.root, self.host, self.package, self.root / 'run', self.root / 'state', self.root / 'private',
                     self.host / 'usr/sbin', self.host / 'etc/systemd/system'):
            path.mkdir(parents=True, exist_ok=True); path.chmod(0o755)
        (self.root / 'private').chmod(0o700)
        self.gid = os.getgid() or next(group.gr_gid for group in grp.getgrall() if group.gr_gid > 0)
        self.installation, self.operation = 'pl-123456abcdef', str(uuid.uuid4())
        d.atomic(self.root / '.pl-installation.json', {'product': 'PL', 'gid': self.gid})
        d.atomic(self.root / 'state/installation.json', {'product': 'PL', 'install_id': self.installation})
        (self.root / 'state/delivery').mkdir(mode=0o700)
        d.atomic(self.root / 'state/delivery/operation.json', {'operation_id': self.operation, 'phase': 'downloading'})
        (self.package / 'icmp-probe.py').write_bytes(b'# trusted fixed probe\n')
        binary = self.host / 'usr/sbin/hping3'; binary.write_bytes(b'fixture binary'); binary.chmod(0o755)
        self.commands = []
        self.units = {kind: {'active': False, 'enabled': False} for kind in ('socket', 'service')}
        self.paths = h._paths(self.root, self.installation, self.host)
        health = patch.object(h, '_health', return_value=None)
        self.health = health.start(); self.addCleanup(health.stop)

    def run_command(self, command, **kwargs):
        self.commands.append(command)
        if command[:2] == ['systemctl', 'show']:
            kind = command[-1].rsplit('.', 1)[1]
            state = self.units[kind]
            present = self.paths['socket_unit' if kind == 'socket' else 'service'].exists()
            return ('LoadState=' + ('loaded' if present else 'not-found') + '\nActiveState=' +
                    ('active' if state['active'] else 'inactive') + '\nUnitFileState=' +
                    ('enabled' if state['enabled'] else 'disabled' if present else '') + '\n').encode()
        if command[1] in ('enable', 'disable', 'start', 'stop'):
            kind = command[-1].rsplit('.', 1)[1]
            if command[1] in ('enable', 'disable'):
                self.units[kind]['enabled'] = command[1] == 'enable'
            if '--now' in command or command[1] in ('start', 'stop'):
                self.units[kind]['active'] = command[1] in ('enable', 'start')
        return b''

    def plan(self, policy):
        return h.transaction(self.root, self.package, self.installation, self.operation, policy, self.run_command, _host_prefix=self.host)

    def change(self, fingerprint, action):
        d.atomic(self.root / 'state/delivery/operation.json', {'operation_id': self.operation,
                                                            'phase': 'applying' if action == 'apply' else 'restoring'})
        h.transition(self.root, self.installation, self.operation, fingerprint, action, self.run_command, _host_prefix=self.host)

    def test_absent_helper_is_added_and_removed_without_replacing_runtime_inode(self):
        fingerprint = self.plan({'mode': 'interactive'})
        inode = self.paths['runtime'].stat().st_ino
        self.assertFalse(self.paths['service'].exists())
        self.change(fingerprint, 'apply')
        self.assertEqual(json.loads(self.paths['policy'].read_text()), {'mode': 'interactive'})
        self.assertIn('DynamicUser=yes', self.paths['service'].read_text())
        self.assertIn('SocketGroup=' + grp.getgrgid(self.gid).gr_name, self.paths['socket_unit'].read_text())
        self.change(fingerprint, 'restore')
        for key in ('payload_dir', 'policy_dir', 'service', 'socket_unit', 'marker'):
            self.assertFalse(self.paths[key].exists(), key)
        self.assertEqual(self.paths['runtime'].stat().st_ino, inode)
        self.assertTrue(self.paths['runtime_marker'].is_file())
        self.assertTrue(self.paths['binary'].is_file())
        before = list(self.commands)
        self.change(fingerprint, 'restore')
        self.assertEqual(self.commands, before)

    def test_existing_legacy_policy_and_unit_states_restore_byte_for_byte(self):
        h.prepare(self.root, self.package, self.installation, ['10.0.0.0/8'], self.gid, self.run_command, _host_prefix=self.host)
        self.units['service']['active'] = True
        previous = {key: self.paths[key].read_bytes() for key in ('payload', 'policy', 'socket_unit', 'service', 'marker')}
        self.assertEqual(json.loads(previous['policy']), {'cidrs': ['10.0.0.0/8']})
        (self.package / 'icmp-probe.py').write_bytes(b'# new trusted payload\n')
        fingerprint = self.plan({'mode': 'cidr', 'cidrs': []})
        self.change(fingerprint, 'apply')
        self.assertEqual(json.loads(self.paths['policy'].read_text()), {'mode': 'cidr', 'cidrs': []})
        self.change(fingerprint, 'restore')
        self.assertEqual({key: self.paths[key].read_bytes() for key in previous}, previous)
        self.assertTrue(self.units['socket']['active'])
        self.assertTrue(self.units['socket']['enabled'])
        self.assertTrue(self.units['service']['active'])

    def test_interrupted_atomic_file_sequence_is_recoverable(self):
        fingerprint = self.plan({'mode': 'interactive'})
        original = h._atomic
        def crash(path, data, mode=0o600):
            original(path, data, mode)
            if path == self.paths['policy']:
                raise InterruptedError('after atomic policy write')
        with patch.object(h, '_atomic', side_effect=crash), self.assertRaises(InterruptedError):
            self.change(fingerprint, 'apply')
        self.assertTrue(self.paths['payload'].exists())
        self.assertFalse(self.paths['socket_unit'].exists())
        self.change(fingerprint, 'restore')
        self.assertFalse(self.paths['payload_dir'].exists())
        self.assertFalse(self.paths['policy_dir'].exists())

    def test_foreign_files_tampered_records_and_replaced_runtime_fail_before_commands(self):
        fingerprint = self.plan({'mode': 'interactive'})
        self.change(fingerprint, 'apply')
        original = self.paths['policy'].read_bytes()
        self.paths['policy'].write_bytes(b'foreign policy')
        self.commands.clear()
        with self.assertRaisesRegex(ValueError, 'outside the transaction'):
            self.change(fingerprint, 'restore')
        self.assertEqual(self.commands, [])
        self.paths['policy'].write_bytes(original)
        for bad in ('0' * 64, 'not-a-hash'):
            with self.assertRaisesRegex(ValueError, 'integrity'):
                self.change(bad, 'restore')
        runtime = self.paths['runtime']; moved = runtime.with_name('old-inode')
        runtime.rename(moved); runtime.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, 'inode'):
            self.change(fingerprint, 'restore')
        self.assertEqual(self.commands, [])

    def test_foreign_helper_or_unit_override_is_not_adopted(self):
        self.paths['service'].write_text('foreign service')
        with self.assertRaisesRegex(ValueError, 'Foreign'):
            self.plan({'mode': 'interactive'})
        self.assertEqual(self.commands, [])
        self.paths['service'].unlink()
        override = self.paths['service'].with_name(self.paths['service'].name + '.d')
        override.mkdir()
        with self.assertRaisesRegex(ValueError, 'override'):
            self.plan({'mode': 'interactive'})

    def test_concurrent_apply_restore_and_late_apply_cannot_resurrect_a_rolled_back_helper(self):
        fingerprint = self.plan({'mode': 'interactive'})
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original = h._checked_file
        errors = []
        def pause(path, *args, **kwargs):
            if path == self.paths['binary']:
                entered.set()
                if not release.wait(3): raise TimeoutError('test coordination')
            return original(path, *args, **kwargs)
        def action(kind):
            try:
                h.transition(self.root, self.installation, self.operation, fingerprint, kind, self.run_command, _host_prefix=self.host)
            except BaseException as error:
                errors.append(error)
            finally:
                if kind == 'restore': finished.set()
        d.atomic(self.root / 'state/delivery/operation.json', {'operation_id': self.operation, 'phase': 'applying'})
        with patch.object(h, '_checked_file', side_effect=pause):
            apply = threading.Thread(target=action, args=('apply',)); apply.start()
            try:
                self.assertTrue(entered.wait(2))
                d.atomic(self.root / 'state/delivery/operation.json', {'operation_id': self.operation, 'phase': 'restoring'})
                restore = threading.Thread(target=action, args=('restore',)); restore.start()
                self.assertFalse(finished.wait(0.05), 'restore must wait for the in-flight external writer')
            finally:
                release.set(); apply.join(3)
            restore.join(3)
        self.assertEqual(errors, [])
        self.assertFalse(self.paths['marker'].exists())
        with self.assertRaisesRegex(ValueError, 'prepared transaction phase'):
            self.change(fingerprint, 'apply')
        d.atomic(self.root / 'state/delivery/operation.json', {'operation_id': str(uuid.uuid4()), 'phase': 'applying'})
        with self.assertRaisesRegex(ValueError, 'active operation'):
            h.transition(self.root, self.installation, self.operation, fingerprint, 'restore', self.run_command, _host_prefix=self.host)
        self.assertFalse(self.paths['marker'].exists())


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pl-wh-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('state', 'private', 'releases'):
            (self.root / name).mkdir(mode=0o700)
        self.installation, self.operation_id = 'pl-123456abcdef', str(uuid.uuid4())
        self.initial, self.old, self.target = [self.root / 'releases' / version for version in ('0.3.2', '0.4.0', '0.4.1')]
        for folder in (self.initial, self.old, self.target):
            folder.mkdir(mode=0o700)
            for name in b.FILES:
                source = BASE / name
                body = source.read_bytes() if source.is_file() else b'fixture payload'
                if name == 'delivery.py' and folder != self.target:
                    body = b'# legacy trusted worker without host feature capability\n'
                (folder / name).write_bytes(body)
            manifest = {'schema': 2, 'product': 'PL', 'core_api': 1, 'version': folder.name, 'architecture': 'amd64',
                        'database': {'major': 18}, 'images': {key: {'id': 'sha256:' + 'a' * 64} for key in ('api', 'web', 'db')},
                        'features': {'on_demand_modules': True, 'module_controller': True, 'icmp_probe': folder == self.target},
                        'files': {name: d.digest(folder / name) for name in b.FILES}}
            d.atomic(folder / 'manifest.json', manifest)
        d.atomic(self.root / 'state/controller-supervisor.json', {'schema': 1, 'version': self.initial.name})
        d.atomic(self.root / 'state/installation.json', {'product': 'PL', 'install_id': self.installation,
            'version': self.old.name, 'manifest_sha256': d.digest(self.old / 'manifest.json'), 'phase': 'ready',
            'config': {'public_url': 'https://pl.example.test', 'icmp_allowed_cidrs': []}})
        self.delivery = d.Delivery(types.SimpleNamespace(root=self.root, installation=self.installation))
        self.unit = self.installation + '-upgrade-' + self.operation_id.replace('-', '') + '.service'
        self.journal = {'operation_id': self.operation_id, 'version': self.target.name, 'from_version': self.old.name,
                        'phase': 'downloading', 'worker_unit': self.unit, 'worker_version': self.old.name,
                        'worker_manifest_sha256': d.digest(self.old / 'manifest.json'), 'artifact': {'sha256': 'b' * 64}}
        d.atomic(self.delivery.base / 'operation.json', self.journal)
        (self.target / '.package-sha256').write_text('b' * 64)
        self.bootstrap = load('pl_candidate_bootstrap', self.target / 'bootstrap.py')
        self.candidate = d.read(self.target / 'manifest.json')
        self.main = types.SimpleNamespace(__file__=str(self.old / 'delivery.py'))
        original = Path.read_text
        def proc(path, *args, **kwargs):
            if path == Path('/proc/self/cgroup'):
                return '0::/system.slice/' + self.unit + '\n'
            return original(path, *args, **kwargs)
        for context in (patch.dict(sys.modules, {'__main__': self.main}),
                        patch.object(sys, 'argv', [str(self.old / 'delivery.py'), 'worker', '--root', str(self.root), '--operation-id', self.operation_id]),
                        patch.dict(os.environ, {'PL_HOST_SUPERVISOR_PACKAGE': str(self.initial)}),
                        patch.object(Path, 'read_text', proc),
                        patch.object(self.bootstrap.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=str(os.getpid()).encode())),
                        patch.object(self.bootstrap.os, 'execve', side_effect=SystemExit('verified exec'))):
            mocked = context.start(); self.addCleanup(context.stop)
            if getattr(context, 'attribute', None) == 'execve':
                self.execve = mocked

    def handoff(self):
        self.bootstrap.legacy_worker_handoff(self.target, self.candidate)

    def test_handoff_promotes_exact_worker_before_snapshot_and_executes_same_unit(self):
        original_state = (self.root / 'state/installation.json').read_bytes()
        with self.assertRaisesRegex(SystemExit, 'verified exec'):
            self.handoff()
        journal = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(journal['worker_version'], '0.4.1')
        self.assertEqual(journal['worker_manifest_sha256'], d.digest(self.target / 'manifest.json'))
        self.assertEqual(journal['worker_handoff']['from_version'], '0.4.0')
        self.assertEqual(journal['worker_handoff']['capability'], 1)
        self.assertEqual(journal['worker_unit'], self.unit)
        self.assertEqual(journal['phase'], 'downloading')
        self.assertNotIn('containers', journal)
        self.assertEqual((self.root / 'state/installation.json').read_bytes(), original_state)
        argv = self.execve.call_args.args[1]
        self.assertEqual(argv, ['/usr/bin/python3', str(self.target / 'delivery.py'), 'worker', '--root', str(self.root), '--operation-id', self.operation_id])
        self.assertEqual(self.execve.call_args.args[2]['PL_HOST_SUPERVISOR_PACKAGE'], str(self.initial))
        validator = d.Delivery(types.SimpleNamespace(root=self.root, installation=self.installation), package=self.target)
        validator.supervisor = self.initial
        self.assertEqual(validator.validate_worker_entry(journal), self.target)
        damaged = copy.deepcopy(journal)
        del damaged['worker_handoff']['from_manifest_sha256']
        with self.assertRaisesRegex(ValueError, 'handoff ledger'):
            validator.validate_worker_entry(damaged)

    def test_manifest_validation_is_pure_outside_the_real_legacy_worker(self):
        for main_file, argv, capability in ((BASE / 'bootstrap.py', list(sys.argv), 0),
                                            (self.old / 'delivery.py', ['bootstrap.py', 'status'], 0),
                                            (self.old / 'delivery.py', list(sys.argv), 1)):
            with self.subTest(main=main_file, argv=argv, capability=capability), \
                    patch.object(self.main, '__file__', str(main_file)), patch.object(sys, 'argv', argv), \
                    patch.object(self.main, 'HOST_FEATURE_API', capability, create=True), \
                    patch.object(self.bootstrap.platform, 'machine', return_value='x86_64'), \
                    patch.object(self.bootstrap, 'validate_bundled_images'):
                before = (self.delivery.base / 'operation.json').read_bytes()
                self.assertEqual(self.bootstrap.manifest(self.target), self.candidate)
                self.assertEqual((self.delivery.base / 'operation.json').read_bytes(), before)
                self.execve.assert_not_called()

    def test_host_api_one_hands_off_upgrade_status_before_mutating_installation(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True)
        d.atomic(self.target / 'manifest.json', self.candidate)
        before = (self.root / 'state/installation.json').read_bytes()
        with patch.object(self.main, 'HOST_FEATURE_API', 1, create=True), \
                self.assertRaisesRegex(SystemExit, 'verified exec'):
            self.handoff()
        journal = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(journal['worker_handoff']['capability'], 2)
        self.assertEqual(journal['worker_version'], self.target.name)
        self.assertEqual(journal['phase'], 'downloading')
        self.assertNotIn('containers', journal)
        self.assertEqual((self.root / 'state/installation.json').read_bytes(), before)
        validator = d.Delivery(types.SimpleNamespace(root=self.root, installation=self.installation), package=self.target)
        validator.supervisor = self.initial
        self.assertEqual(validator.validate_worker_entry(journal), self.target)

    def test_host_api_two_keeps_current_worker_for_upgrade_status(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True)
        d.atomic(self.target / 'manifest.json', self.candidate)
        before = (self.delivery.base / 'operation.json').read_bytes()
        with patch.object(self.main, 'HOST_FEATURE_API', 2, create=True):
            self.handoff()
        self.assertEqual((self.delivery.base / 'operation.json').read_bytes(), before)
        self.execve.assert_not_called()

    def test_host_api_two_hands_off_verified_native_resume_and_validates_real_worker_entry(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True, verified_native_resume=True)
        d.atomic(self.target / 'manifest.json', self.candidate)
        state_before = (self.root / 'state/installation.json').read_bytes()
        with patch.object(self.main, 'HOST_FEATURE_API', 2, create=True), \
                self.assertRaisesRegex(SystemExit, 'verified exec'):
            self.handoff()
        journal = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(journal['worker_handoff']['capability'], 3)
        self.assertEqual(journal['worker_handoff']['from_version'], self.old.name)
        self.assertEqual(journal['worker_manifest_sha256'], d.digest(self.target / 'manifest.json'))
        self.assertEqual(journal['worker_version'], self.target.name)
        self.assertEqual(journal['worker_unit'], self.unit)
        self.assertEqual(journal['phase'], 'downloading')
        self.assertNotIn('containers', journal)
        self.assertNotIn('snapshot', journal)
        self.assertEqual((self.root / 'state/installation.json').read_bytes(), state_before)
        self.execve.assert_called_once()
        self.assertEqual(self.execve.call_args.args[1], ['/usr/bin/python3', str(self.target / 'delivery.py'),
            'worker', '--root', str(self.root), '--operation-id', self.operation_id])
        self.assertEqual(self.execve.call_args.args[2]['PL_HOST_SUPERVISOR_PACKAGE'], str(self.initial))
        validator = d.Delivery(types.SimpleNamespace(root=self.root, installation=self.installation), package=self.target)
        validator.supervisor = self.initial
        self.assertEqual(validator.validate_worker_entry(journal), self.target)

    def test_host_api_three_accepts_resume_manifest_without_handoff(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True, verified_native_resume=True)
        d.atomic(self.target / 'manifest.json', self.candidate)
        before = (self.delivery.base / 'operation.json').read_bytes()
        with patch.object(self.main, 'HOST_FEATURE_API', 3, create=True), \
                patch.object(self.bootstrap.platform, 'machine', return_value='x86_64'), \
                patch.object(self.bootstrap, 'validate_bundled_images'):
            self.assertEqual(self.bootstrap.manifest(self.target), self.candidate)
        self.assertEqual((self.delivery.base / 'operation.json').read_bytes(), before)
        self.execve.assert_not_called()

    def test_resume_manifest_validation_is_pure_outside_verified_worker_entry(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True, verified_native_resume=True)
        d.atomic(self.target / 'manifest.json', self.candidate)
        before = (self.delivery.base / 'operation.json').read_bytes()
        with patch.object(self.main, 'HOST_FEATURE_API', 2, create=True), \
                patch.object(sys, 'argv', ['bootstrap.py', 'status']), \
                patch.object(self.bootstrap.platform, 'machine', return_value='x86_64'), \
                patch.object(self.bootstrap, 'validate_bundled_images'):
            self.assertEqual(self.bootstrap.manifest(self.target), self.candidate)
        self.assertEqual((self.delivery.base / 'operation.json').read_bytes(), before)
        self.execve.assert_not_called()

    def test_false_resume_feature_preserves_capability_two_compatibility(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True, verified_native_resume=False)
        d.atomic(self.target / 'manifest.json', self.candidate)
        before = (self.delivery.base / 'operation.json').read_bytes()
        with patch.object(self.main, 'HOST_FEATURE_API', 2, create=True):
            self.handoff()
        self.assertEqual((self.delivery.base / 'operation.json').read_bytes(), before)
        self.execve.assert_not_called()

    def test_resume_manifest_requires_its_existing_finite_worker_features(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True, verified_native_resume=True)
        before = (self.delivery.base / 'operation.json').read_bytes()
        for missing in ('on_demand_modules', 'module_upgrades', 'upgrade_status', 'icmp_probe'):
            candidate = copy.deepcopy(self.candidate)
            del candidate['features'][missing]
            d.atomic(self.target / 'manifest.json', candidate)
            with self.subTest(missing=missing), \
                    patch.object(self.bootstrap.platform, 'machine', return_value='x86_64'), \
                    self.assertRaisesRegex(ValueError, 'Verified native resume requires'):
                self.bootstrap.manifest(self.target)
            self.assertEqual((self.delivery.base / 'operation.json').read_bytes(), before)
            self.execve.assert_not_called()

    def test_capability_three_still_refuses_post_snapshot_foreign_unit_and_tampered_candidate(self):
        self.candidate['features'].update(upgrade_status=True, module_upgrades=True, verified_native_resume=True)
        d.atomic(self.target / 'manifest.json', self.candidate)
        with patch.object(self.main, 'HOST_FEATURE_API', 2, create=True):
            for change in ({'phase': 'applying'}, {'containers': []}, {'snapshot': 'anything'},
                           {'worker_unit': 'foreign.service'}, {'artifact': {'sha256': 'c' * 64}}):
                with self.subTest(change=change):
                    d.atomic(self.delivery.base / 'operation.json', {**self.journal, **change})
                    with self.assertRaises(ValueError): self.handoff()
                    self.execve.assert_not_called()
            d.atomic(self.delivery.base / 'operation.json', self.journal)
            (self.target / 'icmp-probe.py').write_bytes(b'tampered candidate')
            with self.assertRaisesRegex(ValueError, 'integrity'):
                self.handoff()
        self.execve.assert_not_called()

    def test_phase_snapshot_handoff_and_unit_fences_fail_before_exec(self):
        for change in ({'phase': 'applying'}, {'containers': []}, {'snapshot': 'anything'}, {'worker_handoff': {}},
                       {'worker_unit': 'foreign.service'}, {'from_version': '0.3.2'}, {'worker_manifest_sha256': 'c' * 64},
                       {'artifact': {'sha256': 'c' * 64}}):
            with self.subTest(change=change):
                d.atomic(self.delivery.base / 'operation.json', {**self.journal, **change})
                with self.assertRaises(ValueError): self.handoff()
                self.execve.assert_not_called()
        d.atomic(self.delivery.base / 'operation.json', self.journal)
        (self.target / 'icmp-probe.py').write_bytes(b'tampered candidate')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.handoff()
        self.execve.assert_not_called()

    def test_legacy_operation_without_worker_fields_promotes_initial_worker_separately_from_current_core(self):
        journal = copy.deepcopy(self.journal)
        del journal['worker_version']; del journal['worker_manifest_sha256']
        d.atomic(self.delivery.base / 'operation.json', journal)
        with patch.object(self.main, '__file__', str(self.initial / 'delivery.py')), \
                patch.object(sys, 'argv', [str(self.initial / 'delivery.py'), 'worker', '--root', str(self.root), '--operation-id', self.operation_id]), \
                self.assertRaisesRegex(SystemExit, 'verified exec'):
            self.handoff()
        promoted = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(promoted['worker_handoff']['from_version'], self.initial.name)
        self.assertEqual(promoted['worker_handoff']['core_from_version'], self.old.name)
        self.assertEqual(promoted['worker_handoff']['from_manifest_sha256'], d.digest(self.initial / 'manifest.json'))
        validator = d.Delivery(types.SimpleNamespace(root=self.root, installation=self.installation), package=self.target)
        validator.supervisor = self.initial
        self.assertEqual(validator.validate_worker_entry(promoted), self.target)


class ModelTests(unittest.TestCase):
    def test_defaults_and_legacy_empty_policy_stay_distinct(self):
        self.assertEqual(b.icmp_policy({}), {'mode': 'interactive', 'cidrs': []})
        self.assertEqual(b.icmp_policy({'icmp_allowed_cidrs': []}), {'mode': 'cidr', 'cidrs': []})
        self.assertEqual(b.icmp_policy({'icmp_allowed_cidrs': ['10.0.0.0/8']}), {'mode': 'cidr', 'cidrs': ['10.0.0.0/8']})
        with self.assertRaises(ValueError): b.icmp_policy({'icmp_policy_mode': 'interactive', 'icmp_allowed_cidrs': ['10.0.0.0/8']})

    def test_icmp_recipe_patch_preserves_all_unrelated_runtime_values(self):
        original = {'services': {'api': {'image': 'old', 'environment': {'PORTAL_DATABASE_URL': 'preserved-secret-ref',
            'PORTAL_ALLOWED_CIDRS': '192.0.2.0/24', 'PORTAL_OUTBOUND_CA_FILE': '/custom/roots.pem'},
            'volumes': ['local-auth:/run/pl-auth', {'source': '/custom/roots.pem', 'target': '/custom/roots.pem', 'read_only': True}],
            'group_add': ['123'], 'cap_drop': ['ALL']}, 'web': {'ports': ['192.0.2.25:443:8443']},
            'db': {'image': 'old-db'}}}
        mount = {'type': 'bind', 'source': '/opt/pl/run/icmp-probe', 'target': '/run/pl-icmp-probe', 'read_only': True}
        generated = {'services': {'api': {'environment': {'PORTAL_DATABASE_URL': 'must-not-overwrite',
            'PORTAL_ICMP_EXECUTOR_URL': 'unix:///run/pl-icmp-probe/probe.sock', 'PORTAL_ICMP_POLICY': 'interactive'},
            'volumes': [mount], 'group_add': ['456']}}}
        actual = copy.deepcopy(original)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            d.atomic(root / '.pl-installation.json', {'gid': 456})
            b.apply_icmp_model(root, actual, generated)
        expected = copy.deepcopy(original)
        expected['services']['api']['environment'].update({key: val for key, val in generated['services']['api']['environment'].items() if key.startswith('PORTAL_ICMP_')})
        expected['services']['api']['volumes'].append(mount)
        expected['services']['api']['group_add'] = ['123', '456']
        self.assertEqual(actual, expected)


class ProvisionerTests(unittest.TestCase):
    def test_hping_dependency_is_finite_pinned_and_does_not_inherit_delivery_proxy_environment(self):
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command == ['apt-cache', 'policy', 'hping3']:
                return b'hping3:\n  Candidate: 3.a2.ds2-10.1build1\n'
            if command[:2] == ['dpkg-query', '-W']:
                return b'3.a2.ds2-10.1build1'
            return b''
        original = Path.exists
        with patch.object(Path, 'exists', lambda path: False if path == Path('/usr/sbin/hping3') else original(path)), \
                patch.object(Path, 'is_symlink', return_value=False), patch.object(h, '_checked_file'):
            self.assertEqual(h.ensure_dependency(run), '3.a2.ds2-10.1build1')
        self.assertEqual(commands, [['apt-get', 'update'], ['apt-cache', 'policy', 'hping3'],
                                   ['apt-get', 'install', '-y', '--no-install-recommends', 'hping3=3.a2.ds2-10.1build1'],
                                   ['dpkg-query', '-W', '-f=${Version}', 'hping3']])
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://private-proxy.invalid', 'http_proxy': 'http://private-proxy.invalid'}), \
                patch.object(h.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=b'ok')) as process:
            h._run(['apt-cache', 'policy', 'hping3'])
        self.assertNotIn('HTTPS_PROXY', process.call_args.kwargs['env'])
        self.assertNotIn('http_proxy', process.call_args.kwargs['env'])
        self.assertIs(process.call_args.kwargs['stdin'], h.subprocess.DEVNULL)

    def test_transient_provisioner_is_separate_and_recovery_refuses_an_active_external_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); (root / 'state').mkdir(mode=0o700)
            delivery = d.Delivery(types.SimpleNamespace(root=root, installation='pl-123456abcdef'))
            operation = {'operation_id': str(uuid.uuid4()), 'phase': 'applying', 'icmp_package': '0.4.1',
                         'icmp_package_manifest_sha256': 'b' * 64, 'icmp_host_plan_sha256': 'c' * 64}
            d.atomic(delivery.base / 'operation.json', operation)
            delivery.verified_worker_release = Mock(return_value=root / 'releases/0.4.1')
            delivery.host = Mock(return_value=b'')
            delivery.icmp_host('apply')
            command = delivery.host.call_args.args[0]
            self.assertEqual(command[0], 'systemd-run')
            self.assertIn('--property=ProtectSystem=strict', command)
            self.assertIn('--property=ReadWritePaths=' + str(root) + ' /usr/local/lib/pl/icmp /etc/pl/icmp /etc/systemd/system', command)
            self.assertIn('--property=InaccessiblePaths=-/run/docker.sock', command)
            self.assertIn('--property=RuntimeMaxSec=1000', command)
            self.assertIn(str(root / 'releases/0.4.1/icmp-install.py'), command)
            self.assertNotIn('sh', command)
            delivery.verified_worker_release.assert_called_with('0.4.1', 'b' * 64)
            delivery.host.reset_mock(); delivery.host.return_value = b'active\n'
            with self.assertRaisesRegex(ValueError, 'still running'):
                delivery.icmp_host('restore')
            self.assertTrue(all(call.args[0][0] == 'systemctl' for call in delivery.host.call_args_list))
            delivery.host.reset_mock(); delivery.verified_worker_release.side_effect = ValueError('tampered worker')
            with self.assertRaisesRegex(ValueError, 'tampered'):
                delivery.icmp_host('dependency')
            delivery.host.assert_not_called()


if __name__ == '__main__':
    unittest.main()
