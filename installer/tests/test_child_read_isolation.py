"""Real flock admission: foreign mutations cannot freeze ready child reads."""
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import Mock, patch

BASE = Path(__file__).resolve().parents[1]
KINDS = {'forms': 'FormsController', 'wayline': 'WaylineController', 'doska': 'DoskaController',
         'grafana': 'GrafanaController', 'netmap': 'NetMapController', 'bookstack': 'BookStackController',
         'xray': 'XrayController', 'alertmanager': 'AlertmanagerController'}


def load(kind):
    spec = importlib.util.spec_from_file_location('isolated_child_' + kind, BASE / (kind + '-controller.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULES = {kind: load(kind) for kind in KINDS}


class ChildReadIsolationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'modules').mkdir(mode=0o700)
        (self.root / 'state').mkdir(mode=0o700)
        MODULES['xray'].atomic(self.root / 'state/installation.json', {'config': {'public_url': 'https://lab.invalid'}})
        self.instance = str(uuid.uuid4())
        self.threads, self.errors, self.results = [], [], []
        self.addCleanup(self.join)

    def controller(self, kind):
        # Exercise public get/execute and actual filesystem locks. Docker and
        # ownership observations have their existing full fixture suites.
        module = MODULES[kind]
        controller = getattr(module, KINDS[kind]).__new__(getattr(module, KINDS[kind]))
        controller.root = self.root
        controller.operations = self.root / 'modules' / kind / 'operations'
        controller.operations.mkdir(mode=0o700, parents=True, exist_ok=True)
        controller._routes, controller._read_routes, controller._checked_runtimes = {}, {}, {}
        controller._route_lock = threading.RLock()
        controller.observe = Mock(side_effect=lambda instance: {'state': 'running', 'instance': instance})
        return controller

    def launch(self, call):
        done = threading.Event()
        def run():
            try:
                self.results.append(call())
            except BaseException as error:
                self.errors.append(error)
            finally:
                done.set()
        thread = threading.Thread(target=run, daemon=True)
        self.threads.append(thread); thread.start()
        return done

    def join(self):
        for thread in self.threads:
            thread.join(3)
            self.assertFalse(thread.is_alive(), 'child did not release its admission locks')

    @contextmanager
    def foreign_global_exclusive(self):
        path = self.root / 'modules/controller.lock'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def operation(self, kind, **extra):
        return {'instance_id': self.instance, 'operation_id': str(uuid.uuid4()),
                'module_id': kind, 'action': 'refresh', **extra}

    def test_get_and_refresh_complete_while_foreign_global_ex_is_held(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                controller = self.controller(kind)
                with self.foreign_global_exclusive():
                    get = self.launch(lambda: controller.get(self.instance))
                    refresh = self.launch(lambda: controller.execute(self.operation(kind)))
                    self.assertTrue(get.wait(1), 'get waited for a foreign lifecycle mutation')
                    self.assertTrue(refresh.wait(1), 'refresh waited for a foreign lifecycle mutation')
                self.assertFalse(self.errors)

    def test_get_and_refresh_still_wait_for_same_instance_ex(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                controller = self.controller(kind)
                with controller.instance_lock(self.instance, exclusive=True):
                    get = self.launch(lambda: controller.get(self.instance))
                    refresh = self.launch(lambda: controller.execute(self.operation(kind)))
                    self.assertFalse(get.wait(0.03))
                    self.assertFalse(refresh.wait(0.03))
                    controller.observe.assert_not_called()
                self.assertTrue(get.wait(1)); self.assertTrue(refresh.wait(1))
                self.assertFalse(self.errors)

    def test_refresh_is_a_shared_instance_reader_and_mutation_keeps_global_ex(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                controller = self.controller(kind)
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                def observe(instance):
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError('refresh was not released')
                    return {'state': 'running'}
                controller.observe.side_effect = observe
                refresh = self.launch(lambda: controller.execute(self.operation(kind)))
                self.assertTrue(entered.wait(1))
                try:
                    with (controller.operations / ('instance-' + self.instance + '.lock')).open('rb') as probe:
                        fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    with self.foreign_global_exclusive():
                        pass
                finally:
                    release.set()
                self.assertTrue(refresh.wait(1))
                # Mutation executes ensure only after the global lifecycle writer
                # is available; refresh did not erase allocator consistency.
                controller.ensure = Mock()
                with self.foreign_global_exclusive():
                    mutation = self.launch(lambda: controller.execute(self.operation(kind, action='enable')))
                    self.assertFalse(mutation.wait(0.03))
                    controller.ensure.assert_not_called()
                self.assertTrue(mutation.wait(1))
                controller.ensure.assert_called_once()
                self.assertFalse(self.errors)

    def test_operation_id_conflicts_still_serialize_across_instances(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                controller = self.controller(kind)
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                def observe(instance):
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError('observation was not released')
                    return {'state': 'running'}
                controller.observe.side_effect = observe
                body = self.operation(kind)
                one = self.launch(lambda: controller.execute(body))
                self.assertTrue(entered.wait(1))
                foreign = {**body, 'instance_id': str(uuid.uuid4())}
                two = self.launch(lambda: controller.execute(foreign))
                try:
                    self.assertFalse(two.wait(0.03))
                finally:
                    release.set()
                self.assertTrue(one.wait(1)); self.assertTrue(two.wait(1))
                self.assertEqual(len(self.errors), 1)
                self.assertIsInstance(self.errors.pop(), ValueError)
                self.assertEqual(controller.observe.call_count, 1)

    def test_operation_lock_stripes_are_bounded_and_reject_unsafe_files(self):
        controller = self.controller('xray')
        for _ in range(256):
            with MODULES['xray'].operation_lock(controller.operations, str(uuid.uuid4())):
                pass
        self.assertLessEqual(len(list(controller.operations.glob('operation-slot-*.lock'))), 64)
        operation = str(uuid.uuid4())
        slot = hashlib.sha256(operation.encode()).digest()[0] % 64
        path = controller.operations / ('operation-slot-' + format(slot, '02x') + '.lock')
        path.unlink(missing_ok=True)
        target = self.root / 'unsafe-target'; target.touch(mode=0o600)
        path.symlink_to(target)
        with self.assertRaises(OSError), MODULES['xray'].operation_lock(controller.operations, operation):
            pass

    def test_initial_login_isolated_but_same_instance_barrier_remains(self):
        for kind, service in (('grafana', 'grafana'), ('netmap', 'netbox'), ('bookstack', 'bookstack')):
            with self.subTest(kind=kind):
                controller = self.controller(kind)
                controller.state = Mock(return_value={'schema': 2, 'secrets': {'admin_password': 'fixture-human'}, 'admin_password': 'fixture-human'})
                controller.inspect = Mock(return_value={'State': {'Running': True}})
                controller.image = {'labels': {'pl.build.variant': 'upstream-pinned'}}
                body = {'instance_id': self.instance, 'module_id': kind, 'service': service}
                with self.foreign_global_exclusive():
                    login = self.launch(lambda: controller.initial_login(body))
                    self.assertTrue(login.wait(1))
                self.assertFalse(self.errors)
                controller.state.reset_mock()
                with controller.instance_lock(self.instance, exclusive=True):
                    login = self.launch(lambda: controller.initial_login(body))
                    self.assertFalse(login.wait(0.03))
                    controller.state.assert_not_called()
                self.assertTrue(login.wait(1))


class NativeRouteIsolationTests(unittest.TestCase):
    def fixture(self, kind):
        spec = importlib.util.spec_from_file_location('native_fixture_' + kind, Path(__file__).with_name('test_' + kind + '_controller.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        case = getattr(module, 'FormsTests' if kind == 'forms' else 'WaylineTests')()
        case.setUp(); self.addCleanup(case.doCleanups)
        case.install()
        return case

    def test_cold_and_warm_native_routes_ignore_foreign_global_ex(self):
        for kind in ('forms', 'wayline'):
            with self.subTest(kind=kind):
                case = self.fixture(kind)
                controller = case.controller
                body = case.body() if kind == 'forms' else case.route_body()
                fd = os.open(case.root / 'modules/controller.lock', os.O_CREAT | os.O_RDWR, 0o600)
                with os.fdopen(fd, 'a') as stream:
                    fcntl.flock(stream, fcntl.LOCK_EX)
                    for cold in (True, False):
                        if cold:
                            controller._routes.clear()
                        result, error, finished = [], [], threading.Event()
                        def request():
                            try:
                                result.append(controller.request(body))
                            except BaseException as failure:
                                error.append(failure)
                            finally:
                                finished.set()
                        thread = threading.Thread(target=request, daemon=True); thread.start()
                        try:
                            self.assertTrue(finished.wait(1), 'native route waited for foreign lifecycle EX')
                            self.assertFalse(error)
                            self.assertEqual(result[0]['status'], 200)
                        finally:
                            fcntl.flock(stream, fcntl.LOCK_UN)
                            thread.join(2)
                            fcntl.flock(stream, fcntl.LOCK_EX)

    def test_forms_cold_concurrent_requests_coalesce_full_validation(self):
        case = self.fixture('forms')
        controller, body = case.controller, case.body()
        controller._routes.clear()
        start = threading.Barrier(5)
        from concurrent.futures import ThreadPoolExecutor
        def request():
            start.wait(3)
            return controller.request(body)
        with patch.object(controller, 'ready', wraps=controller.ready) as ready, ThreadPoolExecutor(max_workers=4) as pool:
            requests = [pool.submit(request) for _ in range(4)]
            start.wait(3)
            self.assertTrue(all(request.result(timeout=3)['status'] == 200 for request in requests))
        self.assertEqual(ready.call_count, 1)

    def test_warm_route_does_not_wait_for_another_cold_route_validation(self):
        for kind in ('forms', 'wayline'):
            with self.subTest(kind=kind):
                case = self.fixture(kind)
                controller = case.controller
                body = case.body() if kind == 'forms' else case.route_body()
                finished, errors = threading.Event(), []
                def request():
                    try:
                        self.assertEqual(controller.request(body)['status'], 200)
                    except BaseException as error:
                        errors.append(error)
                    finally:
                        finished.set()
                with controller._route_lock:
                    thread = threading.Thread(target=request, daemon=True); thread.start()
                    self.assertTrue(finished.wait(1), 'warm route waited for the cold verification lock')
                thread.join(2)
                self.assertFalse(errors)
