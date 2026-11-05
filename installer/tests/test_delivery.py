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
import sys
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


def release_notes(version='0.3.0'):
    return {'version': version, 'title': 'Что нового в PL', 'summary': 'Изменения для администратора.',
            'sections': [{'kind': 'new', 'items': [{'title': 'Настройки через PL',
                                                   'description': 'Параметры установки доступны в настройках.'}]}]}


class TrustTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        cls.private, cls.public = cls.folder / 'private.pem', cls.folder / 'public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(cls.private)], check=True, capture_output=True)
        cls.private.chmod(0o600)
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

    def signer_cli(self, notes=None, raw_notes=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installer = root / 'installer'; installer.mkdir()
            for name in ('delivery.py', 'release-catalog.py'):
                shutil.copyfile(Path(__file__).resolve().parents[1] / name, installer / name)
            shutil.copyfile(self.public, installer / 'release-signing-public.pem')
            manifest = d.json_bytes({'product': 'PL', 'version': '0.4.0', 'architecture': 'amd64',
                                     'features': {'on_demand_modules': True}, 'images': {'api': {}, 'web': {}, 'db': {}}})
            archive = root / 'core.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                member = tarfile.TarInfo('manifest.json'); member.size = len(manifest)
                tar.addfile(member, io.BytesIO(manifest))
            output = root / 'catalog.json'
            command = [sys.executable, str(installer / 'release-catalog.py'), '--version', '0.4.0', '--sequence', '11',
                       '--core', str(archive), '--signing-key-file', str(self.private), '--output', str(output)]
            if notes is not None or raw_notes is not None:
                path = root / 'notes.json'
                path.write_bytes(raw_notes if raw_notes is not None else d.json_bytes(notes))
                command.extend(['--notes-file', str(path)])
            result = subprocess.run(command, capture_output=True, text=True)
            return result, d.load_json(output.read_bytes()) if output.exists() else None

    def test_real_ed25519_signature_and_tamper_rejection(self):
        payload = self.payload()
        envelope = self.signed(payload)
        self.assertEqual(d.verify_catalog(envelope, self.public), payload)
        envelope['payload'] = base64.b64encode(d.json_bytes({**payload, 'version': '9.9.9'})).decode()
        with self.assertRaisesRegex(ValueError, 'signature'):
            d.verify_catalog(envelope, self.public)

    def test_release_notes_are_covered_by_the_real_catalog_signature_and_stay_plain_text(self):
        payload = {**self.payload(), 'release_notes': release_notes()}
        payload['release_notes']['sections'][0]['items'][0]['description'] = '<b>Настройки</b> & обычный текст.'
        envelope = self.signed(payload)
        self.assertEqual(d.verify_catalog(envelope, self.public)['release_notes'], payload['release_notes'])
        payload['release_notes']['title'] = 'Подменённые заметки'
        envelope['payload'] = base64.b64encode(d.json_bytes(payload)).decode()
        with self.assertRaisesRegex(ValueError, 'signature'):
            d.verify_catalog(envelope, self.public)

    def test_release_notes_character_and_item_limits_are_inclusive_and_encoded_size_is_bounded(self):
        notes = release_notes()
        notes.update(title='t' * 120, summary='s' * 800, sections=[])
        for kind, count in (('new', 3), ('improved', 3), ('fixed', 2)):
            notes['sections'].append({'kind': kind, 'items': [{'title': 'i' * 120, 'description': 'd' * 800} for _ in range(count)]})
        payload = {**self.payload(), 'release_notes': notes}
        self.assertEqual(d.verify_catalog(self.signed(payload), self.public)['release_notes'], notes)
        for section in notes['sections']:
            for item in section['items']:
                item['description'] = 'я' * 800
        with self.assertRaisesRegex(ValueError, 'notes size'):
            d.verify_catalog(self.signed(payload), self.public)

    def test_signed_release_notes_reject_wrong_version_shape_types_and_limits(self):
        invalid = []
        def changed(change):
            notes = release_notes(); change(notes); invalid.append(notes)
        invalid.extend([None, [], {}, {**release_notes(), 'url': 'https://example.test/notes'}])
        changed(lambda n: n.update(version='0.4.0'))
        changed(lambda n: n.update(version=True))
        for field, value in (('title', ''), ('title', ' leading'), ('title', 'trailing '), ('title', 1),
                             ('title', 't' * 121), ('summary', 's' * 801), ('summary', '\n')):
            changed(lambda n, f=field, v=value: n.update({f: v}))
        changed(lambda n: n.update(sections={}))
        changed(lambda n: n.update(sections=[n['sections'][0]] * 4))
        changed(lambda n: n['sections'].append(copy.deepcopy(n['sections'][0])))
        changed(lambda n: n['sections'][0].update(kind='other'))
        changed(lambda n: n['sections'][0].update(kind=[]))
        changed(lambda n: n['sections'][0].update(extra=True))
        changed(lambda n: n['sections'][0].update(items={}))
        changed(lambda n: n['sections'][0].update(items=['raw item']))
        changed(lambda n: n['sections'][0].update(items=n['sections'][0]['items'] * 9))
        changed(lambda n: n['sections'][0]['items'][0].update(title='t' * 121))
        changed(lambda n: n['sections'][0]['items'][0].update(description='d' * 801))
        changed(lambda n: n['sections'][0]['items'][0].update(description=False))
        changed(lambda n: n['sections'][0]['items'][0].update(description=' trailing '))
        changed(lambda n: n['sections'][0]['items'][0].update(html='<b>unsupported field</b>'))
        for notes in invalid:
            with self.subTest(notes=notes), self.assertRaises(ValueError):
                d.verify_catalog(self.signed({**self.payload(), 'release_notes': notes}), self.public)

    def test_catalogs_without_notes_and_unknown_top_level_metadata_remain_compatible(self):
        payload = {**self.payload(), 'future_metadata': {'value': 'compatible extension'}}
        self.assertEqual(d.verify_catalog(self.signed(payload), self.public), payload)

    def test_status_projects_notes_only_from_a_verified_cached_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'state').mkdir(mode=0o700)
            (root / 'private').mkdir(mode=0o700)
            d.atomic(root / 'state/installation.json', {'product': 'PL', 'install_id': 'pl-notes', 'version': '0.2.0',
                                                       'manifest_sha256': 'b' * 64,
                                                       'release_notes': {'title': 'untrusted installation state'}})
            d.atomic(root / 'private/module-images.json', {'schema': 1, 'installation': 'pl-notes', 'manifest_sha256': 'b' * 64})
            delivery = d.Delivery(types.SimpleNamespace(root=root, installation='pl-notes'))
            delivery.key = self.public
            delivery.architecture = lambda: 'amd64'
            d.atomic(delivery.base / 'cache.json', {'release_notes': {'title': 'untrusted check cache'}})
            self.assertNotIn('release_notes', delivery.status({}, refresh=False))
            payload = {**self.payload(), 'release_notes': release_notes()}
            envelope = self.signed(payload)
            d.atomic(delivery.base / 'catalog.json', envelope)
            self.assertEqual(delivery.status({}, refresh=False)['release_notes'], payload['release_notes'])
            payload['release_notes']['title'] = 'Подмена после подписи'
            envelope['payload'] = base64.b64encode(d.json_bytes(payload)).decode()
            d.atomic(delivery.base / 'catalog.json', envelope)
            result = delivery.status({}, refresh=False)
            self.assertNotIn('release_notes', result)
            self.assertEqual(result['latest_version'], '')
            self.assertTrue(result['error'])

    def test_signer_cli_signs_inline_notes_and_supports_omission(self):
        for notes in (None, release_notes('0.4.0')):
            with self.subTest(notes=notes):
                result, envelope = self.signer_cli(notes)
                self.assertEqual(result.returncode, 0, result.stderr)
                payload = d.verify_catalog(envelope, self.public)
                self.assertEqual(payload['version'], '0.4.0')
                if notes is None:
                    self.assertNotIn('release_notes', payload)
                else:
                    self.assertEqual(payload['release_notes'], notes)

    def test_signer_cli_rejects_invalid_notes_without_writing_a_catalog(self):
        for raw in (d.json_bytes(release_notes('0.3.0')), b'{"version":"0.4.0","version":"0.4.1"}', b' ' * (512 * 1024 + 1)):
            with self.subTest(size=len(raw)):
                result, envelope = self.signer_cli(raw_notes=raw)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(envelope)

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

    def worker_releases(self):
        initial, active = self.root / 'releases/0.3.0', self.root / 'releases/0.3.1'
        initial.mkdir(mode=0o700); active.mkdir(mode=0o700)
        supervisor = (Path(__file__).resolve().parents[1] / 'controller-supervisor.py').read_bytes()
        for folder in (initial, active):
            payload = {'controller-supervisor.py': supervisor, 'bootstrap.py': b'fixture bootstrap',
                       'delivery.py': b'fixture worker', 'module-controller.py': b'fixture controller',
                       'images.tar': b'fixture images', 'release-signing-public.pem': b'immutable trust key'}
            for name, body in payload.items(): (folder / name).write_bytes(body)
            d.atomic(folder / 'manifest.json', {'schema': 2, 'product': 'PL', 'version': folder.name, 'core_api': 1,
                                               'features': {'on_demand_modules': True},
                                               'files': {name: checksum(body) for name, body in payload.items()}})
        d.atomic(self.root / 'state/controller-supervisor.json', {'schema': 1, 'version': initial.name})
        d.atomic(self.root / 'state/controller-active.json', {'schema': 1, 'version': active.name})
        state = self.delivery.state(); state.update(version=active.name, manifest_sha256=d.digest(active / 'manifest.json'))
        d.atomic(self.root / 'state/installation.json', state)
        self.delivery.supervisor, self.delivery.package = initial, active
        self.delivery.host = Mock(return_value=b'')
        if os.geteuid() != 0:
            original_stat, original_lstat, original_fstat = Path.stat, Path.lstat, os.fstat
            def as_root(result):
                values = list(result); values[4] = 0
                return os.stat_result(values)
            patches = (patch.object(Path, 'stat', lambda path, *a, **k: as_root(original_stat(path, *a, **k))),
                       patch.object(Path, 'lstat', lambda path, *a, **k: as_root(original_lstat(path, *a, **k))),
                       patch.object(d.os, 'fstat', lambda fd: as_root(original_fstat(fd))),
                       patch.object(d.os, 'geteuid', return_value=0))
            for change in patches: change.start(); self.addCleanup(change.stop)
        return initial, active

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
        initial, active = self.worker_releases()
        operation = {'operation_id': str(uuid.uuid4()), 'version': '0.3.2', 'phase': 'queued'}
        self.delivery._launch(operation, recovering=False)
        args = self.delivery.host.call_args.args[0]
        self.assertEqual(args[0], 'systemd-run')
        self.assertIn('--property=ProtectSystem=strict', args)
        self.assertIn('--property=ReadWritePaths=' + str(self.root), args)
        self.assertEqual(args[-5:], ['worker', '--root', str(self.root), '--operation-id', operation['operation_id']])
        self.assertIn(str(active / 'delivery.py'), args)
        self.assertIn('--setenv=PL_HOST_SUPERVISOR_PACKAGE=' + str(initial), args)
        saved = d.read(self.delivery.base / 'operation.json')
        self.assertEqual(saved['worker_version'], active.name)
        self.assertEqual(saved['worker_manifest_sha256'], d.digest(active / 'manifest.json'))
        self.assertEqual(saved['worker_unit'], self.installation + '-upgrade-' + uuid.UUID(operation['operation_id']).hex + '.service')

    def test_recovery_uses_the_recorded_worker_even_when_active_version_changed(self):
        initial, active = self.worker_releases()
        operation = {'operation_id': str(uuid.uuid4()), 'worker_version': active.name,
                     'worker_manifest_sha256': d.digest(active / 'manifest.json'), 'phase': 'recovery_required'}
        d.atomic(self.root / 'state/controller-active.json', {'schema': 1, 'version': initial.name})
        self.delivery._launch(operation, recovering=True)
        args = self.delivery.host.call_args.args[0]
        self.assertIn(str(active / 'delivery.py'), args)
        self.assertEqual(args[-1], '--recover')
        self.assertEqual(self.delivery.validate_worker_entry(operation), active)
        self.delivery.package = initial
        with self.assertRaisesRegex(ValueError, 'exact verified worker'):
            self.delivery.validate_worker_entry(operation)

    def test_legacy_recovery_pins_the_initial_worker_and_never_the_active_release(self):
        initial, active = self.worker_releases()
        operation = {'operation_id': str(uuid.uuid4()), 'phase': 'recovery_required'}
        self.delivery._launch(operation, recovering=True)
        self.assertIn(str(initial / 'delivery.py'), self.delivery.host.call_args.args[0])
        self.assertNotIn('worker_version', operation)
        self.delivery.package = initial
        self.assertEqual(self.delivery.validate_worker_entry(operation), initial)

    def test_worker_tamper_manifest_mismatch_and_replaced_authority_fail_before_exec(self):
        initial, active = self.worker_releases()
        operation = {'operation_id': str(uuid.uuid4()), 'phase': 'queued'}
        (active / 'delivery.py').write_bytes(b'tampered worker')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.delivery._launch(operation, recovering=False)
        self.delivery.host.assert_not_called()
        pinned = {'worker_version': active.name, 'worker_manifest_sha256': '0' * 64}
        manifest = d.read(active / 'manifest.json')
        manifest['files']['delivery.py'] = d.digest(active / 'delivery.py')
        d.atomic(active / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'manifest differs'):
            self.delivery.worker_package(pinned, recovering=True)
        (active / 'release-signing-public.pem').write_bytes(b'replaced trust authority')
        manifest['files']['release-signing-public.pem'] = d.digest(active / 'release-signing-public.pem')
        d.atomic(active / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'trust key'):
            self.delivery.worker_package(pinned, recovering=True)

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
        self.delivery.restart_core = lambda: restart(self.containers)
        self.delivery.resume_native = Mock()
        self.delivery.synchronize_modules = Mock()
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

    def test_icmp_upgrade_patches_only_its_recipe_and_restores_external_state_before_old_tree(self):
        state = self.delivery.state()
        state['config'].update(admin_user='admin', bind_address='0.0.0.0', port=443, hostname='pl.example.test')
        d.atomic(self.root / 'state/installation.json', state)
        original = d.read(self.root / 'config/compose.json')
        original['services']['api'].update(environment={'PORTAL_DATABASE_URL': 'preserved-credential-ref',
            'PORTAL_CHECK_ALLOWED_CIDRS': '198.51.100.0/24', 'PORTAL_OUTBOUND_CA_FILE': '/existing/roots.pem'},
            volumes=['local-auth:/run/pl-auth', {'source': '/existing/roots.pem', 'target': '/existing/roots.pem', 'read_only': True}],
            cap_drop=['ALL'])
        original['services']['web']['ports'] = ['192.0.2.10:443:8443']
        d.atomic(self.root / 'config/compose.json', original)
        self.new_manifest['features'] = {'icmp_probe': True}
        self.new_manifest.update(schema=2, database={'pgdata': '/var/lib/postgresql/18/docker'})
        destination = self.root / 'releases/0.3.1'
        d.atomic(destination / 'manifest.json', self.new_manifest)
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'bootstrap.py', destination / 'bootstrap.py')
        self.delivery.prepare_icmp = Mock(return_value=True)
        external = {'version': 'old'}
        def icmp(action):
            if action == 'apply':
                self.assertTrue((self.root / 'private/upgrade-backups' / self.operation_id / 'snapshot.json').exists())
                external['version'] = 'new'
            elif action == 'restore':
                self.assertEqual(self.delivery.state()['version'], '0.3.1', 'external restore precedes old root tree restoration')
                external['version'] = 'old'
        self.delivery.icmp_host = icmp
        def readiness():
            if self.delivery.state()['version'] == '0.3.1':
                actual = d.read(self.root / 'config/compose.json')
                api = actual['services']['api']
                self.assertEqual(api['environment']['PORTAL_DATABASE_URL'], 'preserved-credential-ref')
                self.assertEqual(api['environment']['PORTAL_CHECK_ALLOWED_CIDRS'], '198.51.100.0/24')
                self.assertEqual(api['environment']['PORTAL_OUTBOUND_CA_FILE'], '/existing/roots.pem')
                self.assertEqual(actual['services']['web']['ports'], original['services']['web']['ports'])
                self.assertEqual(api['cap_drop'], ['ALL'])
                self.assertEqual(api['environment']['PORTAL_ICMP_POLICY'], 'interactive')
                self.assertNotIn('PORTAL_ICMP_ALLOWED_CIDRS', api['environment'])
                self.assertTrue(api['volumes'][-1]['read_only'])
                raise ValueError('Injected post-upgrade ICMP/core failure')
        self.delivery.readiness = readiness
        self.delivery.perform_upgrade()
        self.assertEqual(external['version'], 'old')
        self.assertEqual(d.read(self.root / 'config/compose.json'), original)
        self.assertEqual(self.delivery.state()['version'], '0.3.0')
        self.assertEqual(d.load_json((self.volume_roots[0] / 'database').read_bytes()), self.original)
        self.assertEqual(d.read(self.delivery.base / 'operation.json')['phase'], 'rolled_back')

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
