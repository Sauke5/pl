"""Exercise the real file locks against separate Python processes; Docker is never invoked."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import test_maintenance as baseline

pl = baseline.pl

PROBE = r'''
import fcntl,json,os,sys
results={}
for name,path in json.loads(sys.argv[1]).items():
    fd=os.open(path,os.O_RDWR)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);results[name]=False
        except BlockingIOError:results[name]=True
    finally:os.close(fd)
print(json.dumps(results),flush=True)
'''

HOLD = r'''
import fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('ready',flush=True)
sys.stdin.readline()
os.close(fd)
'''


class MaintenanceConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        for name in ('state', 'state/delivery', 'modules'):
            (self.root / name).mkdir(mode=0o700, exist_ok=True)
        self.paths = {'install': self.root / 'state/install.lock',
                      'delivery': self.root / 'state/delivery/delivery.lock',
                      'worker': self.root / 'state/delivery/worker.lock',
                      'lifecycle': self.root / 'modules/controller.lock'}
        for path in self.paths.values():
            path.touch(mode=0o600)
        self.calls = []
        self.factory_calls = 0
        self.revalidation_locks = None
        self.rt = types.SimpleNamespace(root=self.root, install_id='pl-123456abcdef',
            m={'features': {'on_demand_modules': True, 'module_controller': True}},
            state={'version': '0.4.4', 'manifest_sha256': 'a' * 64, 'config': {}},
            validate_runtime=lambda: self.calls.append('validate_runtime'))

    def probe(self):
        result = subprocess.run([sys.executable, '-c', PROBE,
                                 json.dumps({name: str(path) for name, path in self.paths.items()})],
                                capture_output=True, text=True, check=True, timeout=10)
        return json.loads(result.stdout)

    @contextmanager
    def maintenance(self):
        # The production entry gate remains root/Linux-only. Once the isolated
        # fake Runtime has passed that gate, retain the test user's real UID for
        # the actual file ownership checks and kernel flock operations.
        uid = os.geteuid()
        constructed = False
        def runtime(root):
            nonlocal constructed
            constructed = True
            self.factory_calls += 1
            if self.factory_calls == 2 and self.rt.m.get('features', {}).get('on_demand_modules'):
                self.revalidation_locks = self.probe()
            return self.rt
        with patch.object(pl.sys, 'platform', 'linux'), \
                patch.object(pl.os, 'geteuid', side_effect=lambda: uid if constructed else 0), \
                patch.object(pl, 'Runtime', side_effect=runtime):
            with pl.installation(self.root) as value:
                yield value

    @contextmanager
    def hold(self, name):
        child = subprocess.Popen([sys.executable, '-c', HOLD, str(self.paths[name])],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            if not select.select([child.stdout], [], [], 5)[0]:
                self.fail('Competing lock holder did not become ready')
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            yield
        finally:
            if child.poll() is None:
                try:
                    child.communicate('release\n', timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate(timeout=5)
            else:
                child.communicate(timeout=5)

    def test_all_barriers_are_held_against_a_real_competing_process(self):
        with self.maintenance():
            self.assertEqual(self.probe(), {name: True for name in self.paths})
            self.assertEqual(self.factory_calls, 2)
            self.assertEqual(self.revalidation_locks, {name: True for name in self.paths})
            self.assertEqual(self.calls, ['validate_runtime'])
        self.assertEqual(self.probe(), {name: False for name in self.paths})

    def test_each_competing_barrier_refuses_before_runtime_validation(self):
        for name in self.paths:
            with self.subTest(lock=name):
                self.calls.clear()
                with self.hold(name):
                    with self.assertRaises((ValueError, BlockingIOError)):
                        with self.maintenance():
                            self.fail('Maintenance overlapped an active installation operation')
                self.assertEqual(self.calls, [])

    def test_nonterminal_operations_refuse_even_while_installation_is_ready(self):
        operation = self.root / 'state/delivery/operation.json'
        for phase in ('queued', 'downloading', 'snapshot', 'applying_configuration', 'recovery_required', 'unknown'):
            with self.subTest(phase=phase):
                operation.write_text(json.dumps({'operation_id': '00000000-0000-4000-8000-000000000001', 'phase': phase}))
                operation.chmod(0o600)
                self.calls.clear()
                with self.assertRaises(ValueError):
                    with self.maintenance():
                        self.fail('A pending or interrupted delivery operation was ignored')
                self.assertEqual(self.calls, [])

    def test_terminal_operations_and_exception_exit_release_all_locks(self):
        operation = self.root / 'state/delivery/operation.json'
        for phase in ('complete', 'failed', 'rolled_back'):
            with self.subTest(phase=phase):
                operation.write_text(json.dumps({'phase': phase}))
                operation.chmod(0o600)
                with self.assertRaisesRegex(ValueError, 'test-body-failure'):
                    with self.maintenance():
                        raise ValueError('test-body-failure')
                self.assertEqual(self.probe(), {name: False for name in self.paths})

    def test_unsafe_delivery_lock_is_rejected_before_runtime_validation(self):
        self.paths['delivery'].chmod(0o666)
        with self.assertRaises(ValueError):
            with self.maintenance():
                self.fail('Writable shared lock was accepted')
        self.assertEqual(self.calls, [])

    def test_legacy_core_keeps_install_lock_without_creating_delivery_directories(self):
        self.rt.m = {}
        for name in ('delivery', 'worker', 'lifecycle'):
            self.paths[name].unlink()
        (self.root / 'state/delivery').rmdir()
        (self.root / 'modules').rmdir()
        with self.maintenance():
            self.assertFalse((self.root / 'state/delivery').exists())
            self.assertFalse((self.root / 'modules').exists())


if __name__ == '__main__':
    unittest.main()
