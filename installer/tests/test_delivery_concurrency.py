"""Delivery staging must not freeze existing modules or lose concurrent commits."""
import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location('pl_delivery_concurrency', Path(__file__).resolve().parents[1] / 'delivery.py')
d = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(d)


class DeliveryFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        for name in ('config', 'private', 'state', 'modules', 'releases'):
            (self.root / name).mkdir(mode=0o700)
        self.parent = types.SimpleNamespace(root=self.root, installation='pl-concurrency', docker=Mock(return_value=b'{}'))
        d.atomic(self.root / 'state/installation.json', {'product': 'PL', 'install_id': self.parent.installation,
                 'version': '0.3.0', 'manifest_sha256': 'b' * 64})
        d.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.parent.installation,
                 'manifest_sha256': 'b' * 64})
        self.catalog = {'version': '0.3.1', 'sequence': 7, 'core': {'amd64': {}}, 'modules': {}}
        self.archives, self.metadata = {}, {}
        for kind in ('prometheus', 'alertmanager'):
            self.module(kind)
        self.delivery = self.instance()
        self.threads, self.results, self.errors = [], [], []
        self.addCleanup(self.join_threads)

    def instance(self):
        delivery = d.Delivery(self.parent)
        delivery.architecture = lambda: 'amd64'
        delivery.catalog = lambda **kw: self.catalog
        delivery.verify_images = Mock()
        delivery.download = self.fetch
        return delivery

    def module(self, kind):
        source, images = (kind + ' source').encode(), (kind + ' images').encode()
        sha = lambda value: hashlib.sha256(value).hexdigest()
        image = {'id': 'sha256:' + sha(images), 'architecture': 'amd64', 'ref': 'pl/' + kind + ':0.3.0',
                 'recipe': 'deploy/images/' + kind + '.Dockerfile',
                 'labels': {'pl.source.sha256': sha(source), 'pl.module.id': kind,
                            'pl.module.config.version': '1', 'org.opencontainers.image.version': '0.3.0'}}
        meta = {'schema': 1, 'product': 'PL', 'kind': 'module', 'module_id': kind, 'core_api': 1,
                'version': '0.3.0', 'architecture': 'amd64', 'source_sha256': sha(source),
                'images': {kind: image}, 'files': {'source.tar.gz': sha(source), 'images.tar': sha(images)}}
        path = self.root / (kind + '.tar')
        with tarfile.open(path, 'w') as tar:
            for name, body in {'module.json': d.json_bytes(meta), 'images.tar': images, 'source.tar.gz': source}.items():
                member = tarfile.TarInfo(name); member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
        url = 'https://github.com/Sauke5/pl/releases/download/v0.3.0/' + kind + '.tar.gz'
        self.archives[url], self.metadata[kind] = path, meta
        self.catalog['modules'][kind] = {'core_api': 1, 'version': meta['version'], 'artifacts': {'amd64': {
            'url': url, 'size': path.stat().st_size, 'sha256': d.digest(path)}}}

    def fetch(self, url, target, size, expected=None):
        shutil.copyfile(self.archives[url], target)
        if expected is not None and d.digest(target) != expected:
            raise ValueError('Fixture integrity mismatch')

    def launch(self, call):
        finished = threading.Event()
        def run():
            try:
                self.results.append(call())
            except BaseException as error:
                self.errors.append(error)
            finally:
                finished.set()
        thread = threading.Thread(target=run, daemon=True)
        self.threads.append(thread)
        thread.start()
        return finished

    def join_threads(self):
        for thread in self.threads:
            thread.join(4)
            self.assertFalse(thread.is_alive(), 'delivery thread did not release its locks')

    def block(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def wait():
            started.set()
            if not release.wait(4):
                raise TimeoutError('test did not release blocked operation')
        return started, release, wait

    def assert_rpc_available(self):
        # A separate open/Delivery instance exercises the actual flock, not a
        # thread-local mock. A failed assertion releases the staged operation.
        peer = self.instance()
        with peer.lock(exclusive=False, blocking=False), peer.lifecycle_lock(exclusive=False, blocking=False):
            peer.require_idle()
        # Stop/remove still use lifecycle EX; staging cannot hold its SH side
        # either. Their own instance/operation semantics belong to controllers.
        with peer.lifecycle_lock(blocking=False):
            pass
        def read_existing():
            with peer.rpc_guard():
                return peer.state()['version']
        done = self.launch(read_existing)
        self.assertTrue(done.wait(1), 'existing-module RPC waited for delivery')


class DeliveryConcurrencyTests(DeliveryFixture):
    def test_slow_download_keeps_rpc_and_delivered_module_fast(self):
        registry = self.delivery.module_registry()
        registry['alertmanager'] = self.metadata['alertmanager']['images']['alertmanager']
        d.atomic(self.root / 'private/module-images.json', registry)
        started, release, wait = self.block()
        def fetch(*args):
            wait()
            self.fetch(*args)
        self.delivery.download = fetch
        done = self.launch(lambda: self.delivery.ensure_module('prometheus'))
        self.assertTrue(started.wait(1))
        try:
            self.assert_rpc_available()
            with self.instance().lifecycle_lock():
                fast = self.launch(lambda: self.instance().ensure_module('alertmanager'))
                self.assertTrue(fast.wait(1), 'delivered descriptor waited for lifecycle EX')
                self.assertIn(False, self.results)
        finally:
            release.set()
        self.assertTrue(done.wait(2))
        self.assertFalse(self.errors)

    def test_docker_load_does_not_hold_rpc_or_lifecycle_exclusive(self):
        started, release, wait = self.block()
        self.parent.docker.side_effect = lambda *args, **kw: wait()
        done = self.launch(lambda: self.delivery.ensure_module('prometheus'))
        self.assertTrue(started.wait(1))
        try:
            self.assert_rpc_available()
        finally:
            release.set()
        self.assertTrue(done.wait(2))
        self.assertFalse(self.errors)

    def test_different_modules_download_in_parallel_and_merge_registry(self):
        rendezvous = threading.Barrier(2)
        def fetch(*args):
            rendezvous.wait(timeout=2)
            self.fetch(*args)
        for kind in ('prometheus', 'alertmanager'):
            peer = self.instance()
            peer.download = fetch
            self.launch(lambda peer=peer, kind=kind: peer.ensure_module(kind))
        self.join_threads()
        self.assertFalse(self.errors)
        self.assertEqual(self.results, [True, True])
        registry = self.delivery.module_registry()
        for kind in ('prometheus', 'alertmanager'):
            self.assertEqual(registry[kind], self.metadata[kind]['images'][kind])
            self.assertEqual(d.read(self.delivery.base / ('module-' + kind + '.json'))['core_api'], 1)

    def test_same_module_singleflight_across_controller_instances(self):
        started, release, wait = self.block()
        downloaded = Mock(side_effect=lambda *args: (wait(), self.fetch(*args)))
        first, second = self.instance(), self.instance()
        first.download = second.download = downloaded
        one = self.launch(lambda: first.ensure_module('prometheus'))
        self.assertTrue(started.wait(1))
        two = self.launch(lambda: second.ensure_module('prometheus'))
        try:
            self.assertFalse(two.wait(0.1))
            self.assert_rpc_available()
        finally:
            release.set()
        self.assertTrue(one.wait(2)); self.assertTrue(two.wait(2))
        self.assertFalse(self.errors)
        self.assertEqual(sorted(result for result in self.results if type(result) is bool), [False, True])
        self.assertEqual(downloaded.call_count, 1)
        self.assertEqual(self.parent.docker.call_count, 1)

    def test_failure_or_interruption_cleans_staging_and_unlocks_retry(self):
        for failure in (ValueError('download failed'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                def fail(url, target, *args):
                    target.write_bytes(b'incomplete archive')
                    raise failure
                self.delivery.download = fail
                with self.assertRaises(type(failure)):
                    self.delivery.ensure_module('prometheus')
                self.assertEqual(list((self.root / 'releases').glob('.module-*')), [])
                self.assertNotIn('prometheus', self.delivery.module_registry())
                with self.instance().lock(blocking=False), self.instance().lifecycle_lock(blocking=False):
                    pass
                peer = self.instance()
                self.assertTrue(peer.ensure_module('prometheus'))
                registry = peer.module_registry(); registry.pop('prometheus')
                d.atomic(self.root / 'private/module-images.json', registry)

    def test_image_verification_failure_keeps_registry_unpublished_and_allows_retry(self):
        self.delivery.verify_images.side_effect = ValueError('Loaded release image differs from signed artifact')
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.delivery.ensure_module('prometheus')
        self.assertNotIn('prometheus', self.delivery.module_registry())
        self.assertFalse((self.delivery.base / 'module-prometheus.json').exists())
        self.assertEqual(list((self.root / 'releases').glob('.module-*')), [])
        self.assertTrue(self.instance().ensure_module('prometheus'))

    def test_registry_identity_is_rechecked_before_commit(self):
        def replace_registry(*args, **kw):
            registry = self.delivery.module_registry()
            registry['manifest_sha256'] = 'c' * 64
            d.atomic(self.root / 'private/module-images.json', registry)
        self.parent.docker.side_effect = replace_registry
        with self.assertRaisesRegex(ValueError, 'registry does not match'):
            self.delivery.ensure_module('prometheus')
        self.assertNotIn('prometheus', d.read(self.root / 'private/module-images.json'))
        self.assertFalse((self.delivery.base / 'module-prometheus.json').exists())

    def test_upgrade_waits_for_delivery_and_queued_upgrade_blocks_new_staging(self):
        started, release, wait = self.block()
        self.delivery.download = lambda *args: (wait(), self.fetch(*args))
        staging = self.launch(lambda: self.delivery.ensure_module('prometheus'))
        self.assertTrue(started.wait(1))
        upgrader = self.instance()
        launched = threading.Event()
        def launch(operation, recovering):
            d.atomic(upgrader.base / 'operation.json', operation)
            launched.set()
        upgrader._launch = launch
        upgrader.status = lambda *args, **kw: {}
        upgrade = self.launch(lambda: upgrader.upgrade({'version': '0.3.1', 'operation_id': str(uuid.uuid4())}))
        try:
            self.assertFalse(launched.wait(0.1), 'upgrade crossed an active artifact delivery')
            with self.assertRaises(BlockingIOError), self.instance().lock(blocking=False):
                pass
        finally:
            release.set()
        self.assertTrue(staging.wait(2)); self.assertTrue(upgrade.wait(2))
        self.assertTrue(launched.is_set())
        self.assertFalse(self.errors)
        blocked = self.instance()
        blocked.download = Mock()
        with self.assertRaisesRegex(ValueError, 'восстановления'):
            blocked.ensure_module('alertmanager')
        blocked.download.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'восстановления'), blocked.rpc_guard():
            pass

    def test_exclusive_installation_change_blocks_staging_before_download(self):
        peer = self.instance()
        peer.download = Mock(side_effect=self.fetch)
        with self.delivery.lock():
            finished = self.launch(lambda: peer.ensure_module('prometheus'))
            self.assertFalse(finished.wait(0.1))
            peer.download.assert_not_called()
        self.assertTrue(finished.wait(2))
        self.assertFalse(self.errors)


class CatalogConcurrencyTests(DeliveryFixture):
    def setUp(self):
        super().setUp()
        self.private, self.public = self.root / 'signing.pem', self.root / 'public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(self.private)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(self.private), '-pubout', '-out', str(self.public)], check=True, capture_output=True)
        self.private.chmod(0o600)
        self.envelopes = []
        for sequence, version in ((8, '0.3.2'), (7, '0.3.1'), (8, '0.3.3')):
            payload = {'schema': 1, 'product': 'PL', 'core_api': 1, 'version': version, 'sequence': sequence,
                       'modules': {}, 'core': {'amd64': {'url': d.CATALOG_URL, 'size': 123, 'sha256': 'a' * 64}}}
            source = self.root / 'payload.json'; source.write_bytes(d.json_bytes(payload))
            signature = subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(self.private), '-rawin', '-in', str(source)], check=True, capture_output=True).stdout
            self.envelopes.append({'payload': base64.b64encode(source.read_bytes()).decode(), 'signature': base64.b64encode(signature).decode()})

    def checker(self):
        checker = d.Delivery(self.parent)
        checker.key = self.public
        checker.architecture = lambda: 'amd64'
        return checker

    def test_slow_catalog_check_keeps_rpcs_available_and_serializes_replay_writers(self):
        for rejected in self.envelopes[1:]:
            with self.subTest(candidate=rejected['payload']):
                (self.delivery.base / 'catalog.json').unlink(missing_ok=True)
                started, release, wait = self.block()
                first, second = self.checker(), self.checker()
                first.download = lambda *args: (wait(), d.json_bytes(self.envelopes[0]))[1]
                second.download = Mock(return_value=d.json_bytes(rejected))
                one = self.launch(lambda: first.check({}))
                self.assertTrue(started.wait(1))
                two = self.launch(lambda: second.check({}))
                try:
                    self.assert_rpc_available()
                    self.assertFalse(two.wait(0.1))
                    second.download.assert_not_called()
                    with self.assertRaises(BlockingIOError), self.instance().lock(blocking=False):
                        pass
                finally:
                    release.set()
                self.assertTrue(one.wait(2)); self.assertTrue(two.wait(2))
                self.assertFalse(self.errors)
                self.assertEqual(first.catalog()['version'], '0.3.2')
                self.assertTrue(d.read(first.base / 'cache.json')['error'])


if __name__ == '__main__':
    unittest.main()
