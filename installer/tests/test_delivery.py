"""Release trust, selective delivery and full-installation recovery contracts."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('pl_delivery_test', Path(__file__).resolve().parents[1] / 'delivery.py')
d = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(d)


def checksum(body):
    return hashlib.sha256(body).hexdigest()


class TrustTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        cls.private, cls.public = cls.folder / 'private.pem', cls.folder / 'public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(cls.private)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(cls.private), '-pubout', '-out', str(cls.public)], check=True, capture_output=True)

    def payload(self):
        artifact = {'url': 'https://github.com/Sauke5/pl/releases/download/v0.3.0/core.tar.gz', 'sha256': 'a' * 64, 'size': 123}
        return {'schema': 1, 'product': 'PL', 'core_api': 1, 'sequence': 7, 'version': '0.3.0',
                'core': {'amd64': artifact}, 'modules': {'prometheus': {'core_api': 1, 'version': '3.15.0', 'artifacts': {'amd64': artifact}}}}

    def signed(self, payload):
        raw = d.json_bytes(payload)
        source = self.folder / 'payload.json'
        source.write_bytes(raw)
        sig = subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(self.private), '-rawin', '-in', str(source)], check=True, capture_output=True).stdout
        return {'payload': base64.b64encode(raw).decode(), 'signature': base64.b64encode(sig).decode()}

    def test_real_ed25519_signature_and_tamper_rejection(self):
        payload = self.payload()
        envelope = self.signed(payload)
        self.assertEqual(d.verify_catalog(envelope, self.public), payload)
        envelope['payload'] = base64.b64encode(d.json_bytes({**payload, 'version': '9.9.9'})).decode()
        with self.assertRaisesRegex(ValueError, 'signature'):
            d.verify_catalog(envelope, self.public)

    def test_signed_old_or_equivocating_sequence_is_rejected(self):
        payload = self.payload()
        for other in ({**payload, 'sequence': 6}, {**payload, 'version': '0.3.1'}):
            with self.subTest(other=other), self.assertRaisesRegex(ValueError, 'sequence'):
                d.verify_catalog(self.signed(other), self.public, payload)
        self.assertEqual(d.verify_catalog(self.signed(payload), self.public, payload), payload)

    def test_expiry_unknown_module_arch_and_protocol_fail_closed(self):
        for modify in (lambda p: p.update(expires_at=1), lambda p: p.update(core_api=2),
                       lambda p: p['modules'].update(shell=p['modules']['prometheus']),
                       lambda p: p['core'].update(mips=p['core']['amd64'])):
            value = self.payload()
            modify(value)
            with self.assertRaises(ValueError):
                d.verify_catalog(self.signed(value), self.public)

    def test_duplicate_json_keys_do_not_select_an_alternate_payload(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            d.load_json(b'{"schema":1,"schema":2}')

    def test_download_origin_and_redirect_are_finite(self):
        good = self.payload()['core']['amd64']['url']
        self.assertEqual(d.asset_url(good), good)
        for url in ('http://github.com/Sauke5/pl/releases/download/v1/a',
                    'https://github.com/another/pl/releases/download/v1/a',
                    'https://github.com/Sauke5/pl/releases/download/v1/a?token=secret',
                    'https://user:password@github.com/Sauke5/pl/releases/download/v1/a',
                    'https://169.254.169.254/a', 'https://release-assets.githubusercontent.com/a'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                d.asset_url(url)
        d.asset_url('https://release-assets.githubusercontent.com/assets/a?signature=x', redirect=True)

    def test_download_enforces_size_hash_and_removes_partial_output(self):
        url = self.payload()['core']['amd64']['url']
        target = self.folder / 'download'
        opener = types.SimpleNamespace(open=lambda *a, **kw: io.BytesIO(b'abc'))
        with patch.object(d.urllib.request, 'build_opener', return_value=opener):
            d.download(url, target, 3, checksum(b'abc'))
            self.assertEqual(target.read_bytes(), b'abc')
            target.unlink()
            with self.assertRaisesRegex(ValueError, 'integrity'):
                d.download(url, target, 3, '0' * 64)
            self.assertFalse(target.exists())
            with self.assertRaisesRegex(ValueError, 'exceeds'):
                d.download(url, target, 2, checksum(b'ab'))
            self.assertFalse(target.exists())

    def test_flat_archive_rejects_traversal_symlinks_and_duplicates(self):
        for names in (('../module.json',), ('module.json', 'module.json')):
            path = self.folder / 'bad.tar'
            with tarfile.open(path, 'w') as tar:
                for name in names:
                    info = tarfile.TarInfo(name)
                    tar.addfile(info)
            with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ValueError):
                d.extract_flat(path, Path(tmp), {'module.json'}, {'module.json'})


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('config', 'private', 'state', 'modules', 'releases'):
            (self.root / name).mkdir(mode=0o700)
        self.installation = 'pl-123456abcdef'
        d.atomic(self.root / '.pl-installation.json', {'product': 'PL', 'gid': os.getgid()})
        d.atomic(self.root / 'state/installation.json', {'product': 'PL', 'install_id': self.installation, 'version': '0.3.0', 'manifest_sha256': 'b' * 64,
                                                        'phase': 'ready', 'config': {'public_url': 'https://pl.example.test'}})
        d.atomic(self.root / 'private/module-images.json', {'schema': 1, 'installation': self.installation, 'manifest_sha256': 'b' * 64})
        self.parent = types.SimpleNamespace(root=self.root, installation=self.installation, docker=Mock(return_value=b'{}'))
        self.delivery = d.Delivery(self.parent)
        self.delivery.architecture = lambda: 'amd64'

    def module_archive(self):
        source, images = b'selected module source', b'selected Docker archive'
        image = {'id': 'sha256:' + 'a' * 64, 'architecture': 'amd64', 'ref': 'pl/core-prometheus:0.3.0',
                 'recipe': 'deploy/images/prometheus.Dockerfile', 'labels': {'pl.source.sha256': checksum(source),
                     'pl.module.id': 'prometheus', 'pl.module.config.version': '1', 'org.opencontainers.image.version': '3.15.0'}}
        meta = {'schema': 1, 'product': 'PL', 'kind': 'module', 'module_id': 'prometheus', 'core_api': 1,
                'version': '3.15.0', 'architecture': 'amd64', 'source_sha256': checksum(source), 'images': {'prometheus': image},
                'files': {'source.tar.gz': checksum(source), 'images.tar': checksum(images)}}
        path = self.root / 'fixture.tar'
        with tarfile.open(path, 'w') as tar:
            for name, body in {'module.json': d.json_bytes(meta), 'images.tar': images, 'source.tar.gz': source}.items():
                info = tarfile.TarInfo(name); info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
        return path, meta

    def test_install_downloads_only_requested_module_then_reuses_owned_descriptor(self):
        archive, meta = self.module_archive()
        url = 'https://github.com/Sauke5/pl/releases/download/v0.3.0/prometheus.tar.gz'
        self.delivery.catalog = lambda: {'modules': {'prometheus': {'core_api': 1, 'version': '3.15.0',
            'artifacts': {'amd64': {'url': url, 'size': archive.stat().st_size, 'sha256': d.digest(archive)}}}}}
        self.delivery.verify_images = Mock()
        def fetch(address, target, size, digest):
            self.assertEqual(address, url)
            shutil.copyfile(archive, target)
        with patch.object(d, 'download', side_effect=fetch) as downloaded:
            self.assertTrue(self.delivery.ensure_module('prometheus'))
            self.assertFalse(self.delivery.ensure_module('prometheus'))
        self.assertEqual(downloaded.call_count, 1)
        self.assertEqual(self.parent.docker.call_count, 1)
        self.assertEqual(self.parent.docker.call_args.args[:2], ('image', 'load'))
        registry = d.read(self.root / 'private/module-images.json')
        self.assertEqual(set(registry), {'schema', 'installation', 'manifest_sha256', 'prometheus'})
        self.assertEqual(registry['prometheus'], meta['images']['prometheus'])

    def test_missing_module_or_incompatible_manifest_never_loads_images(self):
        self.delivery.catalog = lambda: {'modules': {}}
        with self.assertRaisesRegex(ValueError, 'каталоге'):
            self.delivery.ensure_module('forms')
        self.parent.docker.assert_not_called()
        archive, meta = self.module_archive()
        meta['core_api'] = 2
        with self.assertRaisesRegex(ValueError, 'Incompatible'):
            self.delivery.validate_module(meta, 'prometheus', '3.15.0', self.root)
        self.parent.docker.assert_not_called()

    def test_upgrade_requires_trusted_newer_release_and_module_compatibility(self):
        op = {'operation_id': str(uuid.uuid4()), 'version': '0.2.0'}
        self.delivery.catalog = lambda: {'version': '0.2.0', 'core': {'amd64': {}}}
        with self.assertRaisesRegex(ValueError, 'обновлением'):
            self.delivery.upgrade(op)
        self.parent.docker.assert_not_called()

    def test_orphan_worker_becomes_recovery_required_and_blocks_module_changes(self):
        self.delivery.catalog = lambda: None
        self.delivery.start_check = Mock()
        d.atomic(self.delivery.base / 'operation.json', {'operation_id': str(uuid.uuid4()), 'version': '0.3.1', 'phase': 'applying'})
        result = self.delivery.status({})
        self.assertEqual(result['operation']['phase'], 'recovery_required')
        with self.assertRaisesRegex(ValueError, 'восстановления'):
            self.delivery.ensure_module('prometheus')

    def test_live_worker_is_not_misclassified_as_interrupted(self):
        self.delivery.catalog = lambda: None
        self.delivery.start_check = Mock()
        d.atomic(self.delivery.base / 'operation.json', {'phase': 'snapshot'})
        with self.delivery.worker_lock():
            self.assertEqual(self.delivery.status({})['operation']['phase'], 'snapshot')

    def test_worker_launch_is_an_independent_finite_systemd_service(self):
        initial = self.root / 'releases/0.3.0'; initial.mkdir()
        (initial / 'controller-supervisor.py').touch()
        self.delivery.supervisor = initial
        self.delivery.host = Mock(return_value=b'')
        operation = {'operation_id': str(uuid.uuid4()), 'version': '0.3.1', 'phase': 'queued'}
        self.delivery._launch(operation, recovering=False)
        args = self.delivery.host.call_args.args[0]
        self.assertEqual(args[0], 'systemd-run')
        self.assertIn('--property=ProtectSystem=strict', args)
        self.assertIn('--property=ReadWritePaths=' + str(self.root), args)
        self.assertEqual(args[-5:], ['worker', '--root', str(self.root), '--operation-id', operation['operation_id']])
        self.assertIn(str(initial / 'delivery.py'), args)
        saved = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(saved['worker_unit'], self.installation + '-upgrade-' + uuid.UUID(operation['operation_id']).hex + '.service')

    def test_authenticated_next_host_payload_is_allowed_without_trust_key_rotation(self):
        initial = self.root / 'releases/0.3.0'; candidate = self.root / 'releases/0.3.1'
        initial.mkdir(); candidate.mkdir()
        key = b'immutable public release key'
        (initial / 'release-signing-public.pem').write_bytes(key)
        self.delivery.supervisor = initial
        files = {'bootstrap.py': b'new release validator', 'module-controller.py': b'patched finite host controller',
                 'delivery.py': b'patched host API adapter', 'release-signing-public.pem': key, 'images.tar': b'new core images'}
        for name, body in files.items():
            (candidate / name).write_bytes(body)
        manifest = {'product': 'PL', 'schema': 2, 'version': '0.3.1', 'core_api': 1,
                    'files': {name: checksum(body) for name, body in files.items()}}
        d.atomic(candidate / 'manifest.json', manifest)
        self.delivery.validate_core_files(candidate, '0.3.1')
        (candidate / 'release-signing-public.pem').write_bytes(b'different release authority')
        manifest['files']['release-signing-public.pem'] = checksum(b'different release authority')
        d.atomic(candidate / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'trust key'):
            self.delivery.validate_core_files(candidate, '0.3.1')

    def test_recovery_inventory_admits_missing_api_and_web_but_initial_snapshot_does_not(self):
        database = {'Name': '/' + self.installation + '-db-1', 'Image': 'sha256:' + 'a' * 64, 'State': {'Running': True},
                    'Config': {'Labels': {'com.docker.compose.project': self.installation, 'com.docker.compose.service': 'db'}}}
        def inventory(*args, **kwargs):
            return d.json_bytes([database]) if args[:2] == ('container', 'inspect') else b'database-id\n'
        self.parent.docker = Mock(side_effect=inventory)
        with self.assertRaisesRegex(ValueError, 'core service'):
            self.delivery.inventory()
        actual = self.delivery.inventory(require_core=False)
        self.assertEqual([item['service'] for item in actual], ['db'])
        self.parent.docker.return_value = b''
        self.parent.docker.side_effect = None
        self.assertEqual(self.delivery.inventory(require_core=False), [])
        self.delivery.stop([])


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.xattrs_supported = hasattr(os, 'listxattr') and hasattr(os, 'setxattr')
        if not self.xattrs_supported:
            # Linux runtime exposes these APIs; this Mac's Python omits them.
            missing = patch.object(d.os, 'listxattr', return_value=[], create=True)
            missing.start(); self.addCleanup(missing.stop)

    def test_snapshot_restores_auth_module_data_modes_links_and_attributes(self):
        source, target = self.root / 'source', self.root / 'target'
        source.mkdir(); target.mkdir()
        (source / 'auth').mkdir(mode=0o700)
        (source / 'auth/password.hash').write_bytes(b'private-password-hash')
        (source / 'auth/password.hash').chmod(0o600)
        (source / 'module.db').write_bytes(b'persisted-module-data')
        os.link(source / 'module.db', source / 'module.link')
        (source / 'symlink').symlink_to('module.db')
        attr = 'user.pl-test' if platform_linux() else 'com.pl.test'
        if self.xattrs_supported:
            os.setxattr(source / 'module.db', attr, b'value')
        archive = self.root / 'snapshot.tar'
        with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
            d.add_tree(tar, source, '.')
        (target / 'foreign').write_text('new-schema-data')
        d.restore_tree(archive, target)
        self.assertFalse((target / 'foreign').exists())
        self.assertEqual((target / 'auth/password.hash').read_bytes(), b'private-password-hash')
        self.assertEqual((target / 'auth/password.hash').stat().st_mode & 0o777, 0o600)
        self.assertEqual((target / 'module.db').read_bytes(), b'persisted-module-data')
        self.assertEqual((target / 'module.link').stat().st_ino, (target / 'module.db').stat().st_ino)
        self.assertEqual(os.readlink(target / 'symlink'), 'module.db')
        if self.xattrs_supported:
            self.assertEqual(os.getxattr(target / 'module.db', attr), b'value')

    def test_snapshot_rejects_member_beneath_symlink_before_modifying_target(self):
        target = self.root / 'target'; target.mkdir()
        (target / 'keep').write_text('safe')
        archive = self.root / 'bad.tar'
        with tarfile.open(archive, 'w') as tar:
            info = tarfile.TarInfo('link'); info.type = tarfile.SYMTYPE; info.linkname = '/tmp'
            tar.addfile(info)
            tar.addfile(tarfile.TarInfo('link/escape'))
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            d.restore_tree(archive, target)
        self.assertEqual((target / 'keep').read_text(), 'safe')

    def test_restore_preserves_delivery_journal_and_backup_inodes(self):
        target = self.root / 'target'; target.mkdir()
        for folder in ('state', 'state/delivery', 'modules', 'private', 'private/upgrade-backups'):
            (target / folder).mkdir()
        (target / 'state/delivery/operation.json').write_text('live journal')
        (target / 'private/upgrade-backups/marker').write_text('snapshot retained')
        (target / 'modules/controller.lock').touch()
        inode = (target / 'modules/controller.lock').stat().st_ino
        archive = self.root / 'snapshot.tar'
        with tarfile.open(archive, 'w') as tar:
            for name in ('state', 'modules', 'private'):
                info = tarfile.TarInfo(name); info.type = tarfile.DIRTYPE; info.mode = 0o700
                info.uid, info.gid = os.getuid(), os.getgid(); tar.addfile(info)
            info = tarfile.TarInfo('state/installation.json'); body = b'previous version'; info.size = len(body)
            info.uid, info.gid = os.getuid(), os.getgid(); tar.addfile(info, io.BytesIO(body))
        d.restore_tree(archive, target, preserve={'state/delivery', 'private/upgrade-backups', 'modules/controller.lock'})
        self.assertEqual((target / 'state/delivery/operation.json').read_text(), 'live journal')
        self.assertEqual((target / 'private/upgrade-backups/marker').read_text(), 'snapshot retained')
        self.assertEqual((target / 'modules/controller.lock').stat().st_ino, inode)
        self.assertEqual((target / 'state/installation.json').read_text(), 'previous version')


class UpgradeTransactionTests(unittest.TestCase):
    def setUp(self):
        DeliveryTests.setUp(self)
        if not hasattr(os, 'listxattr'):
            missing = patch.object(d.os, 'listxattr', return_value=[], create=True)
            missing.start(); self.addCleanup(missing.stop)
        self.original = {'cards': ['card-1'], 'systems': ['system-1'], 'users': ['admin', 'engineer'],
                         'connections': ['external-prometheus'], 'modules': ['prometheus', 'forms'], 'schema': 15}
        self.volume_roots = []
        for name in ('db-volume', 'auth-volume', 'module-volume'):
            folder = self.root / name; folder.mkdir()
            self.volume_roots.append(folder)
        (self.volume_roots[0] / 'database').write_bytes(d.json_bytes(self.original))
        (self.volume_roots[1] / 'password.hash').write_text('changed-local-admin-password')
        (self.volume_roots[2] / 'history').write_text('existing-module-history')
        (self.root / 'private/integration-credential-key').write_bytes(bytes(range(32)))
        (self.root / 'modules/installed.json').write_text('two local modules')
        self.volumes = [{'name': 'owned-' + str(i), 'path': str(path)} for i, path in enumerate(self.volume_roots)]
        self.containers = [{'name': 'core-' + name, 'running': True, 'core': True, 'service': name} for name in ('web', 'api', 'db')]
        self.containers += [{'name': 'forms-native', 'running': True, 'core': False, 'service': ''}]
        self.old_manifest = {'images': {name: {'id': 'sha256:' + 'a' * 64} for name in ('api', 'web', 'db')}}
        self.new_manifest = {'version': '0.3.1', 'images': {name: {'id': 'sha256:' + 'c' * 64} for name in ('api', 'web', 'db')}}
        for version, manifest in (('0.3.0', self.old_manifest), ('0.3.1', self.new_manifest)):
            folder = self.root / 'releases' / version; folder.mkdir()
            d.atomic(folder / 'manifest.json', manifest)
        d.atomic(self.root / 'config/compose.json', {'services': {name: {'image': value['id']} for name, value in self.old_manifest['images'].items()}})
        self.delivery.stage_core = lambda request: (self.root / 'releases/0.3.1', self.new_manifest)
        self.delivery.inventory = lambda **kwargs: self.containers
        self.delivery.volumes = lambda: copy.deepcopy(self.volumes)
        self.delivery.stop = Mock()
        self.restarted = []
        def restart(containers):
            self.restarted.append(copy.deepcopy(containers))
            if self.delivery.state()['version'] == '0.3.1':
                value = d.load_json((self.volume_roots[0] / 'database').read_bytes())
                value['schema'] = 16
                (self.volume_roots[0] / 'database').write_bytes(d.json_bytes(value))
                (self.volume_roots[2] / 'new-file-after-upgrade').write_text('new runtime data')
        self.delivery.restart = restart
        self.delivery.readiness = Mock()
        self.delivery.activate_host = Mock()
        def engine(*args, **kwargs):
            if args[0] == 'run':
                self.assertIn('type=bind,source=/,target=/host,readonly', args)
                self.assertIn('--network', args)
                archive, target = Path(args[args.index('--restore-volume') + 1]), Path(args[args.index('--target') + 1])
                d.restore_tree(archive, target)
                return b''
            raise AssertionError('Unexpected engine command: ' + str(args[0]))
        self.parent.docker = Mock(side_effect=engine)
        self.operation_id = str(uuid.uuid4())
        d.atomic(self.delivery.base / 'operation.json', {'operation_id': self.operation_id, 'version': '0.3.1', 'from_version': '0.3.0', 'phase': 'queued'})

    def test_upgrade_preserves_used_installation_data_and_prepares_full_rollback(self):
        self.delivery.perform_upgrade()
        self.assertEqual(self.delivery.state()['version'], '0.3.1')
        current = d.load_json((self.volume_roots[0] / 'database').read_bytes())
        self.assertEqual(current, {**self.original, 'schema': 16})
        self.assertEqual((self.volume_roots[1] / 'password.hash').read_text(), 'changed-local-admin-password')
        self.assertEqual((self.volume_roots[2] / 'history').read_text(), 'existing-module-history')
        self.assertEqual(self.restarted[0], self.containers)
        op = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(op['phase'], 'complete')
        meta = d.read(Path(op['snapshot']) / 'snapshot.json')
        self.assertEqual(len(meta['volumes']), 3)
        self.assertEqual(set(meta['files']), {'installation.tar', 'volume-0.tar', 'volume-1.tar', 'volume-2.tar'})

    def test_failed_new_schema_restores_all_data_auth_and_prior_images(self):
        def readiness():
            if self.delivery.state()['version'] == '0.3.1':
                raise ValueError('Injected post-migration readiness failure')
        self.delivery.readiness = readiness
        self.delivery.perform_upgrade()
        self.assertEqual(self.delivery.state()['version'], '0.3.0')
        self.assertEqual(d.load_json((self.volume_roots[0] / 'database').read_bytes()), self.original)
        self.assertFalse((self.volume_roots[2] / 'new-file-after-upgrade').exists())
        self.assertEqual((self.volume_roots[1] / 'password.hash').read_text(), 'changed-local-admin-password')
        self.assertEqual((self.root / 'private/integration-credential-key').read_bytes(), bytes(range(32)))
        self.assertEqual((self.root / 'modules/installed.json').read_text(), 'two local modules')
        model = d.read(self.root / 'config/compose.json')
        self.assertEqual(model['services']['api']['image'], self.old_manifest['images']['api']['id'])
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')

    def test_partial_snapshot_never_restores_partial_data(self):
        folder = self.root / 'private/upgrade-backups'; folder.mkdir()
        partial = folder / self.operation_id; partial.mkdir()
        (partial / 'volume-0.tar').write_text('interrupted backup')
        op = d.read(self.delivery.base / 'operation.json'); op['containers'] = self.containers
        d.atomic(self.delivery.base / 'operation.json', op)
        self.delivery.rollback()
        self.parent.docker.assert_not_called()
        self.assertEqual(self.restarted[0], self.containers)
        self.assertEqual(d.load_json((self.volume_roots[0] / 'database').read_bytes()), self.original)

    def test_configuration_rollback_restores_data_before_rebuilding_native_containers(self):
        op = d.read(self.delivery.base / 'operation.json')
        plan = {'snapshot_operation_id': self.operation_id, 'schema': 1, 'instances': []}
        op.update(kind='configuration', module_origin_plan=plan)
        d.atomic(self.delivery.base / 'operation.json', op)
        rebuilt = []
        def rebuild(parent, actual):
            self.assertEqual(actual, plan)
            self.assertEqual(d.load_json((self.volume_roots[0] / 'database').read_bytes()), self.original)
            self.assertEqual(self.delivery.state()['version'], '0.3.0')
            rebuilt.append(True)
        helper = types.SimpleNamespace(rollback=rebuild)
        self.delivery.installation_settings = lambda: types.SimpleNamespace(origin_helper=lambda: helper)
        def readiness():
            if self.delivery.state()['version'] == '0.3.1':
                raise ValueError('Injected new-runtime failure')
        self.delivery.readiness = readiness
        self.delivery.perform_upgrade()
        self.assertEqual(rebuilt, [True])
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')


def platform_linux():
    import sys
    return sys.platform == 'linux'


if __name__ == '__main__':
    unittest.main()
