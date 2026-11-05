"""Persistent connector keys and private restore boundaries; no host services."""
import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

import test_maintenance as baseline
import test_install_sh as wrapper_baseline
import test_bootstrap as bootstrap_baseline

maintenance = baseline.pl
bootstrap = maintenance.bootstrap


class ConnectorKeyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'private').mkdir(mode=0o700)
        self.gid = os.getegid() or 10001
        (self.root / '.pl-installation.json').write_text(json.dumps({'gid': self.gid}))
        self.key = self.root / 'private/integration-credential-key'

    def test_created_once_and_preserved_without_dependency_on_login_credentials(self):
        bootstrap.prepare_connector_key(self.root, existing=False)
        original = bootstrap.read_connector_key(self.root)
        info = self.key.stat()
        self.assertEqual(len(original), 32)
        self.assertEqual((info.st_uid, info.st_gid, info.st_mode & 0o777), (os.geteuid(), self.gid, 0o640))
        (self.root / 'private/local-admin.hash').write_text('changed-password-hash')
        (self.root / 'private/runtime.env').write_text('changed-db-password')
        with patch.object(bootstrap.secrets, 'token_bytes', side_effect=AssertionError('unexpected key generation')):
            bootstrap.prepare_connector_key(self.root, existing=True)
            bootstrap.prepare_connector_key(self.root, existing=False)
        self.assertEqual(bootstrap.read_connector_key(self.root), original)
        self.assertEqual((self.key.stat().st_ino, self.key.stat().st_mtime_ns), (info.st_ino, info.st_mtime_ns))

    def test_existing_missing_wrong_size_mode_symlink_and_gid_are_refused(self):
        with patch.object(bootstrap.secrets, 'token_bytes') as random:
            with self.assertRaisesRegex(ValueError, 'never regenerate'):
                bootstrap.prepare_connector_key(self.root, existing=True)
            random.assert_not_called()
        bootstrap.prepare_connector_key(self.root, existing=False)
        original = self.key.read_bytes()
        for body, mode in ((b'x' * 31, 0o640), (b'x' * 33, 0o640), (original, 0o644), (original, 0o600)):
            self.key.write_bytes(body)
            self.key.chmod(mode)
            with self.assertRaises(ValueError):
                bootstrap.prepare_connector_key(self.root, existing=True)
            self.assertEqual(self.key.read_bytes(), body)
            self.assertEqual(self.key.stat().st_mode & 0o777, mode)
        self.key.chmod(0o640)
        self.key.write_bytes(original)
        hardlink = self.root / 'hardlink'
        os.link(self.key, hardlink)
        with self.assertRaises(ValueError):
            bootstrap.read_connector_key(self.root)
        hardlink.unlink()
        with patch.object(bootstrap, 'connector_service_gid', return_value=self.gid + 1), self.assertRaises(ValueError):
            bootstrap.read_connector_key(self.root)
        outside = self.root / 'preserve'
        outside.write_bytes(original)
        self.key.unlink()
        self.key.symlink_to(outside)
        with self.assertRaises(ValueError):
            bootstrap.prepare_connector_key(self.root, existing=False)
        self.assertEqual(outside.read_bytes(), original)

    def test_explicit_restore_preserves_bound_inode_and_metadata(self):
        bootstrap.prepare_connector_key(self.root, existing=False)
        original = self.key.stat()
        replacement = b'\x00\xff\n' + b'r' * 29
        bootstrap.restore_connector_key(self.root, replacement)
        current = self.key.stat()
        self.assertEqual(bootstrap.read_connector_key(self.root), replacement)
        self.assertEqual((current.st_ino, current.st_uid, current.st_gid, current.st_mode),
                         (original.st_ino, original.st_uid, original.st_gid, original.st_mode))
        with self.assertRaises(ValueError):
            bootstrap.restore_connector_key(self.root, b'too-short')
        self.assertEqual(bootstrap.read_connector_key(self.root), replacement)

    def test_new_feature_has_private_api_bind_group_and_explicit_egress_only(self):
        cfg = bootstrap.configuration('https://pl.example.test', '127.0.0.1', 'admin', '10.93.1.0/24')
        manifest = {'schema': 2, 'features': {'connector_credentials': True}, 'database': {'pgdata': '/db/data'},
                    'images': {name: {'id': 'sha256:' + str(index) * 64} for index, name in enumerate(('api', 'web', 'db'), 1)}}
        model = bootstrap.compose_model(self.root, manifest, cfg, 'pl-123456abcdef')
        api = model['services']['api']
        self.assertEqual(api['environment']['PORTAL_CONNECTOR_KEY_FILE'], bootstrap.CONNECTOR_KEY_TARGET)
        self.assertEqual(api['environment']['PORTAL_ALLOWED_CIDRS'], '127.0.0.1/32')
        self.assertEqual(api['environment']['PORTAL_ALLOWED_PORTS'], '80,443')
        self.assertEqual(api['group_add'], [str(self.gid)])
        self.assertEqual(api['networks'], ['backend', 'egress'])
        self.assertEqual(model['networks']['egress']['ipam']['config'][0]['subnet'], '10.93.1.128/26')
        binds = [item for item in api['volumes'] if isinstance(item, dict)]
        self.assertEqual(binds, [{'type': 'bind', 'source': str(self.key), 'target': bootstrap.CONNECTOR_KEY_TARGET,
                                  'read_only': True, 'bind': {'create_host_path': False}}])
        self.assertTrue(model['networks']['backend']['internal'])
        self.assertFalse(any(bootstrap.CONNECTOR_KEY_TARGET in json.dumps(model['services'][name]) for name in ('web', 'db')))
        self.assertNotIn('ports', api)
        self.assertNotIn('PORTAL_SECRET_REFS', api['environment'])
        with self.assertRaisesRegex(ValueError, 'network-cidr'):
            bootstrap.compose_model(self.root, manifest, {k: v for k, v in cfg.items() if k != 'network_cidr'}, 'pl-123456abcdef')
        legacy = copy.deepcopy(manifest)
        legacy['features'] = {}
        api = bootstrap.compose_model(self.root, legacy, cfg, 'pl-123456abcdef')['services']['api']
        self.assertNotIn('PORTAL_CONNECTOR_KEY_FILE', api['environment'])
        self.assertNotIn('group_add', api)
        self.assertEqual(api['networks'], ['backend'])

    def test_inner_manifest_admits_new_feature_and_rejects_wrong_schema_or_type(self):
        manifest = bootstrap_baseline.BootstrapTests.bundled(self)
        manifest.update(product='PL', version='fixture')
        manifest['features']['connector_credentials'] = True
        files = bootstrap.REQUIRED | {'module-controller.py'}
        for name in files:
            (self.root / name).write_bytes(b'fixture')
        manifest['files'] = {name: hashlib.sha256(b'fixture').hexdigest() for name in files}
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(manifest))
        with patch.object(bootstrap.platform, 'machine', return_value='x86_64'):
            self.assertTrue(bootstrap.manifest(self.root)['features']['connector_credentials'])
            manifest['schema'] = 1
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'schema-2'):
                bootstrap.manifest(self.root)
            manifest['schema'] = 2
            manifest['features']['connector_credentials'] = 1
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'features'):
                bootstrap.manifest(self.root)


class ConnectorBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.rt = baseline.FakeRuntime(self.root)
        self.gid = os.getegid() or 10001
        (self.root / '.pl-installation.json').write_text(json.dumps({'gid': self.gid}))
        bootstrap.prepare_connector_key(self.root, existing=False)
        self.original_key = bootstrap.read_connector_key(self.root)
        self.rt.m = {'features': {'connector_credentials': True}}
        self.rt.schema['columns'] = [{'table_name': name} for name in sorted(maintenance.CURRENT_TABLES | {'integration_credentials'})]
        self.rt.fresh['tables'] = sorted(maintenance.CURRENT_TABLES | {'integration_credentials'})
        self.rt.fresh['integration_credentials_count'] = 0
        self.rt.fresh['scaffolding'] = {name: copy.deepcopy(maintenance.SCAFFOLDING_ROWS[name]) if name in maintenance.SCAFFOLDING_ROWS else 0
                                       for name in maintenance.CURRENT_TABLES - maintenance.TABLES - {'local_users'}}
        self.rt.fresh['documents'] = [{'kind': kind, 'id': 'global', 'revision': 1, 'body': copy.deepcopy(body)}
                                      for kind, body in maintenance.CURRENT_DEFAULTS.items()]
        self.fail_verification = False

        def verify(database='pl', key_file=None):
            self.rt.calls.append(('verify', database))
            if key_file is not None:
                self.assertEqual(key_file.read_bytes(), b's' * 32)
            if self.fail_verification:
                raise ValueError('integration credential verification failed')
        self.rt.verify_connector_credentials = verify

    def archive(self, *, key=b's' * 32, feature=True):
        dump = self.root / 'database.dump'
        dump.write_bytes(b'PGDMPfixture')
        auth = baseline.AUTH
        auth_body = json.dumps(auth, sort_keys=True).encode()
        metadata = {'schema': 1, 'product': 'PL-private-backup', 'source_install_id': 'pl-abcdef123456',
                    'version': self.rt.state['version'], 'manifest_sha256': self.rt.state['manifest_sha256'],
                    'images': self.rt.image_ids, 'postgres_major': 17, 'database_schema': self.rt.schema,
                    'admin_user': 'admin', 'source_config': {'public_url': 'https://source.example.test'},
                    'files': {'database.dump': {'sha256': bootstrap.digest(dump), 'bytes': dump.stat().st_size},
                              'auth.json': {'sha256': hashlib.sha256(auth_body).hexdigest(), 'bytes': len(auth_body)}}}
        if feature:
            metadata['features'] = {'connector_credentials': True}
            metadata['files'][maintenance.CONNECTOR_KEY_MEMBER] = {'sha256': hashlib.sha256(key).hexdigest(), 'bytes': len(key)}
        archive = self.root / 'backup.tar'
        maintenance.write_archive(archive, metadata, dump, auth, key if feature else None)
        return archive, bootstrap.digest(archive)

    def test_backup_includes_matching_key_after_real_verifier_and_keeps_input_key(self):
        output = self.root / 'created.tar'
        self.rt.auth = copy.deepcopy(baseline.AUTH)
        with redirect_stdout(io.StringIO()) as stdout:
            maintenance.backup(self.rt, output)
        self.assertLess(self.rt.calls.index(('verify', 'pl')), self.rt.calls.index(('dump',)))
        with tarfile.open(output) as archive:
            self.assertEqual(set(archive.getnames()), {'metadata.json', 'auth.json', 'database.dump', maintenance.CONNECTOR_KEY_MEMBER})
            self.assertEqual(archive.extractfile(maintenance.CONNECTOR_KEY_MEMBER).read(), self.original_key)
            metadata = json.load(archive.extractfile('metadata.json'))
            self.assertEqual(metadata['features'], {'connector_credentials': True})
            self.assertEqual(metadata['files'][maintenance.CONNECTOR_KEY_MEMBER]['sha256'], hashlib.sha256(self.original_key).hexdigest())
        self.assertEqual(bootstrap.read_connector_key(self.root), self.original_key)
        self.assertNotIn(self.original_key.hex(), stdout.getvalue())
        self.assertNotIn(str(self.root), stdout.getvalue())

    def test_verifier_failure_stops_backup_and_resumes_original_services(self):
        self.fail_verification = True
        output = self.root / 'created.tar'
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            maintenance.backup(self.rt, output)
        self.assertFalse(output.exists())
        self.assertNotIn(('dump',), self.rt.calls)
        self.assertEqual(self.rt.calls[-2:], [('compose', ('start', 'api')), ('compose', ('start', 'web'))])

    def test_restore_into_different_install_id_verifies_stage_before_key_and_db_swap(self):
        archive, digest = self.archive()
        before = copy.deepcopy(self.rt.state)
        inode = (self.rt.private / maintenance.CONNECTOR_KEY_MEMBER).stat().st_ino
        with patch.object(bootstrap, 'restore_connector_key', wraps=bootstrap.restore_connector_key) as restore_key, redirect_stdout(io.StringIO()):
            maintenance.restore(self.rt, archive, digest)
        restore_key.assert_called_once_with(self.root, b's' * 32)
        self.assertEqual(bootstrap.read_connector_key(self.root), b's' * 32)
        self.assertEqual((self.rt.private / maintenance.CONNECTOR_KEY_MEMBER).stat().st_ino, inode)
        self.assertEqual(self.rt.state, before)
        verify_index = next(index for index, call in enumerate(self.rt.calls) if call[0] == 'verify')
        swap_index = next(index for index, call in enumerate(self.rt.calls) if call[0] == 'sql' and call[1].startswith('ALTER DATABASE'))
        self.assertTrue(self.rt.calls[verify_index][1].startswith('pl_stage_'))
        self.assertLess(verify_index, swap_index)

    def test_wrong_key_staging_verification_keeps_target_key_and_database(self):
        archive, digest = self.archive()
        self.fail_verification = True
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            maintenance.restore(self.rt, archive, digest)
        self.assertEqual(bootstrap.read_connector_key(self.root), self.original_key)
        self.assertFalse(any(call[0] == 'sql' and call[1].startswith('ALTER DATABASE') for call in self.rt.calls))
        self.assertEqual(self.rt.auth, baseline.FRESH_AUTH)

    def test_auth_failure_rolls_back_key_with_database_before_service_resume(self):
        archive, digest = self.archive()
        self.rt.fail_write_once = True
        with patch.object(bootstrap, 'restore_connector_key', wraps=bootstrap.restore_connector_key) as restored:
            with self.assertRaisesRegex(ValueError, 'auth update'):
                maintenance.restore(self.rt, archive, digest)
        self.assertEqual([call.args[1] for call in restored.call_args_list], [b's' * 32, self.original_key])
        self.assertEqual(bootstrap.read_connector_key(self.root), self.original_key)
        self.assertEqual(self.rt.auth, baseline.FRESH_AUTH)
        self.assertTrue(any(call[0] == 'sql' and call[1].startswith('ALTER DATABASE "pl_before_') for call in self.rt.calls))

    def test_existing_credentials_are_not_a_fresh_target(self):
        archive, digest = self.archive()
        self.rt.fresh['integration_credentials_count'] = 1
        with self.assertRaisesRegex(ValueError, 'fresh'):
            maintenance.restore(self.rt, archive, digest)
        self.assertFalse(any(call[0] == 'compose' for call in self.rt.calls))
        self.assertEqual(bootstrap.read_connector_key(self.root), self.original_key)

    def test_archive_feature_and_member_are_strict_and_old_shape_still_loads(self):
        path, digest = self.archive()
        with tempfile.TemporaryDirectory(dir=self.rt.private) as destination:
            metadata, _, _ = maintenance.load_archive(path, digest, Path(destination))
            self.assertEqual(metadata['features'], {'connector_credentials': True})
        with tarfile.open(path) as archive:
            entries = {member.name: archive.extractfile(member).read() for member in archive.getmembers()}
        for variant in ('missing-key', 'undeclared-key', 'bad-size', 'bad-hash', 'nonboolean-feature'):
            candidate = dict(entries)
            metadata = json.loads(candidate['metadata.json'])
            if variant == 'missing-key':
                candidate.pop(maintenance.CONNECTOR_KEY_MEMBER)
            elif variant == 'undeclared-key':
                metadata.pop('features')
                metadata['files'].pop(maintenance.CONNECTOR_KEY_MEMBER)
            elif variant == 'bad-size':
                candidate[maintenance.CONNECTOR_KEY_MEMBER] = b'x' * 31
                metadata['files'][maintenance.CONNECTOR_KEY_MEMBER] = {'bytes': 31, 'sha256': hashlib.sha256(b'x' * 31).hexdigest()}
            elif variant == 'bad-hash':
                candidate[maintenance.CONNECTOR_KEY_MEMBER] = b'x' * 32
            else:
                metadata['features']['connector_credentials'] = 1
            candidate['metadata.json'] = json.dumps(metadata).encode()
            bad = self.root / (variant + '.tar')
            with tarfile.open(bad, 'w') as archive:
                for name, body in candidate.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(body)
                    archive.addfile(info, io.BytesIO(body))
            bad.chmod(0o600)
            with tempfile.TemporaryDirectory(dir=self.rt.private) as destination, self.subTest(variant=variant), self.assertRaises(ValueError):
                maintenance.load_archive(bad, bootstrap.digest(bad), Path(destination))
        path.unlink()
        legacy, digest = self.archive(feature=False)
        with tempfile.TemporaryDirectory(dir=self.rt.private) as destination:
            metadata, _, _ = maintenance.load_archive(legacy, digest, Path(destination))
            self.assertNotIn('features', metadata)
        with self.assertRaisesRegex(ValueError, 'same package'):
            maintenance.restore(self.rt, legacy, digest)

    def test_real_verifier_command_uses_pinned_image_backend_and_stdin_environment(self):
        rt = object.__new__(maintenance.Runtime)
        rt.root, rt.private, rt.m, rt.install_id, rt.image_ids = self.rt.root, self.rt.private, self.rt.m, self.rt.install_id, self.rt.image_ids
        (rt.private / 'runtime.env').write_text('PL_DB_PASSWORD=' + 'a' * 64 + '\n')
        (rt.private / 'runtime.env').chmod(0o600)
        calls = []
        rt.docker = lambda *args, **kwargs: calls.append((args, kwargs))
        rt.verify_connector_credentials('pl_stage_0123456789ab')
        args, kwargs = calls[0]
        self.assertEqual(args[-2:], (rt.image_ids['api'], 'verify-connector-credentials'))
        self.assertEqual(args[args.index('--network') + 1], rt.install_id + '_backend')
        self.assertEqual(args[args.index('--env-file') + 1], '/dev/stdin')
        self.assertIn('readonly', args[args.index('--mount') + 1])
        self.assertIn('PORTAL_DATABASE_URL=postgres://pl:' + 'a' * 64 + '@db:5432/pl_stage_0123456789ab?sslmode=disable\n', kwargs['data'].decode())
        self.assertNotIn('a' * 64, ' '.join(args))
        for invalid in ('other', 'pl;DROP', 'pl_before_0123456789ab'):
            with self.assertRaises(ValueError):
                rt.verify_connector_credentials(invalid)
        self.assertEqual(len(calls), 1)

    def test_maintenance_checks_exact_api_key_bind_environment_and_service_group(self):
        factory = baseline.TransferSpoolRuntimeTests()
        def runtime():
            rt, mounts, _, _ = factory.fixture(enabled=False)
            rt.m['features']['connector_credentials'] = True
            mounts['api'].append({'Type': 'bind', 'Source': str(rt.private / maintenance.CONNECTOR_KEY_MEMBER),
                                  'Destination': bootstrap.CONNECTOR_KEY_TARGET, 'RW': False})
            state = {'env': ['PORTAL_CONNECTOR_KEY_FILE=' + bootstrap.CONNECTOR_KEY_TARGET], 'groups': ['997']}
            original = rt.docker
            def docker(*args):
                result = original(*args)
                if args == ('container', 'inspect', 'api'):
                    container = json.loads(result)
                    container[0]['Config']['Env'] = state['env']
                    container[0]['HostConfig'] = {'GroupAdd': state['groups']}
                    return json.dumps(container).encode()
                return result
            rt.docker = docker
            rt.schema_contract = lambda: {'postgres_major': 18, 'columns': [{'table_name': name} for name in maintenance.CURRENT_TABLES | {'integration_credentials'}]}
            return rt, mounts, state
        with patch.object(bootstrap, 'read_connector_key', return_value=b'k' * 32), patch.object(bootstrap, 'connector_service_gid', return_value=997):
            rt, _, _ = runtime()
            rt.validate_runtime()
            for mutate in (lambda mounts, state: mounts['api'][-1].update(RW=True),
                           lambda mounts, state: mounts['api'][-1].update(Source='/foreign/key'),
                           lambda mounts, state: mounts['api'].append(copy.deepcopy(mounts['api'][-1])),
                           lambda mounts, state: mounts['api'].pop(),
                           lambda mounts, state: state.update(env=[]),
                           lambda mounts, state: state.update(env=['PORTAL_CONNECTOR_KEY_FILE=/different']),
                           lambda mounts, state: state.update(groups=[]),
                           lambda mounts, state: mounts['db'].append(copy.deepcopy(mounts['api'][-1])),
                           lambda mounts, state: mounts['web'].append(copy.deepcopy(mounts['api'][-1]))):
                rt, mounts, state = runtime()
                mutate(mounts, state)
                with self.assertRaises(ValueError):
                    rt.validate_runtime()
            rt, mounts, _ = runtime()
            rt.m['features'].pop('connector_credentials')
            with self.assertRaises(ValueError):
                rt.validate_runtime()


class ConnectorWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'installation'
        self.module = types.ModuleType('connector_install_wrapper')
        exec(compile(wrapper_baseline.SOURCE, str(wrapper_baseline.SCRIPT), 'exec'), self.module.__dict__)

    def test_feature_admission_and_missing_network_fail_before_host_changes(self):
        package, manifest = wrapper_baseline.InstallerTests.package(self, manifest_change=lambda value: value.update(schema=2, features={'connector_credentials': True}))
        self.assertEqual(self.module.verify_package(package, 'amd64'), manifest)
        with patch.object(self.module, 'preflight', return_value={'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64'}), \
                patch.object(self.module, 'prepare_root') as prepare, patch.object(self.module, 'install_docker') as docker:
            with self.assertRaisesRegex(self.module.InstallError, 'network-cidr'):
                self.module.main(['--root', str(self.root), '--package', str(package), '--public-url', 'https://pl.example.test', '--self-signed'])
            prepare.assert_not_called()
            docker.assert_not_called()
        package, _ = wrapper_baseline.InstallerTests.package(self, manifest_change=lambda value: value.update(features={'connector_credentials': True}))
        with self.assertRaisesRegex(self.module.InstallError, 'schema-2'):
            self.module.verify_package(package, 'amd64')
        package, manifest = wrapper_baseline.InstallerTests.package(self)
        self.assertEqual(self.module.verify_package(package, 'amd64'), manifest)


class SchemaScaffoldingTests(unittest.TestCase):
    def current(self, credentials=False):
        data = baseline.fresh()
        data['tables'] = sorted(maintenance.CURRENT_TABLES | ({'integration_credentials'} if credentials else set()))
        data['local_users_count'] = 0
        data['integration_credentials_count'] = 0
        data['scaffolding'] = {name: copy.deepcopy(maintenance.SCAFFOLDING_ROWS[name]) if name in maintenance.SCAFFOLDING_ROWS else 0
                               for name in maintenance.CURRENT_TABLES - maintenance.TABLES - {'local_users'}}
        data['documents'] = [{'kind': kind, 'id': 'global', 'revision': 1, 'body': copy.deepcopy(body)}
                             for kind, body in maintenance.CURRENT_DEFAULTS.items()]
        return data

    def test_current_migration_schema_is_admitted_and_legacy_gate_is_preserved(self):
        maintenance.validate_fresh(baseline.fresh())
        legacy_users = baseline.fresh()
        legacy_users['tables'].append('local_users')
        maintenance.validate_fresh(legacy_users)
        for feature in (False, True):
            data = self.current(feature)
            maintenance.validate_fresh(data, connector_credentials=feature)
            self.assertTrue(maintenance.supported_tables(set(data['tables']), connector_credentials=feature))
        for stage in maintenance.TABLE_PROFILES[2:-1]:
            data = baseline.fresh()
            data['tables'] = sorted(stage)
            if 'pl_local_directory_accounts' in stage:
                data['documents'] = [{'kind': kind, 'id': 'global', 'revision': 1, 'body': copy.deepcopy(body)}
                                     for kind, body in maintenance.CURRENT_DEFAULTS.items()]
            data['scaffolding'] = {name: copy.deepcopy(maintenance.SCAFFOLDING_ROWS[name]) if name in maintenance.SCAFFOLDING_ROWS else 0
                                   for name in stage - maintenance.TABLES - {'local_users'}}
            maintenance.validate_fresh(data)

    def test_current_table_profile_matches_the_actual_shipped_migrations(self):
        migrations = Path(__file__).resolve().parents[2] / 'monitoring/source/it-portal/db/migrations'
        declared = {'schema_migrations'}
        for path in sorted(migrations.glob('*.sql')):
            source = path.read_text()
            declared.update(re.findall(r'(?mi)^CREATE TABLE ([a-z_]+)\s*\(', source))
            declared.difference_update(re.findall(r'(?mi)^DROP TABLE (?:IF EXISTS )?([a-z_]+)', source))
        self.assertEqual(declared, maintenance.CURRENT_TABLES | {'integration_credentials'})

    def test_every_nonempty_user_table_and_changed_singleton_is_nonfresh(self):
        original = self.current(True)
        for name in original['scaffolding']:
            data = copy.deepcopy(original)
            data['scaffolding'][name] = [] if name in maintenance.SCAFFOLDING_ROWS else 1
            with self.subTest(table=name), self.assertRaises(ValueError):
                maintenance.validate_fresh(data, connector_credentials=True)
        for name, field, value in (('sftp_provider_state', 'cursor_timestamp', 1),
                                   ('sftp_provider_state', 'last_attempt_at', '2026-01-01T00:00:00Z'),
                                   ('sftp_provider_state', 'error', 'previous operation'),
                                   ('org_cursor_state', 'retained_after', 1),
                                   ('org_cursor_state', 'singleton', 1)):
            data = copy.deepcopy(original)
            data['scaffolding'][name][0][field] = value
            with self.subTest(table=name, field=field), self.assertRaises(ValueError):
                maintenance.validate_fresh(data, connector_credentials=True)
        for field in ('local_users_count', 'integration_credentials_count'):
            data = copy.deepcopy(original)
            data[field] = 1
            with self.subTest(field=field), self.assertRaises(ValueError):
                maintenance.validate_fresh(data, connector_credentials=True)

    def test_unknown_partial_tables_missing_counts_and_modified_defaults_fail(self):
        original = self.current(True)
        mutations = [lambda data: data['tables'].append('unregistered_private'),
                     lambda data: data['tables'].remove('org_employees'),
                     lambda data: data['scaffolding'].pop('pl_local_directory_accounts'),
                     lambda data: data['scaffolding'].update(extra=0),
                     lambda data: data['documents'][0]['body'].update(board_title='edited'),
                     lambda data: data['documents'][1]['body'].update(relation_types=[]),
                     lambda data: data['documents'][0].update(revision=2)]
        for index, mutate in enumerate(mutations):
            data = copy.deepcopy(original)
            mutate(data)
            with self.subTest(case=index), self.assertRaises(ValueError):
                maintenance.validate_fresh(data, connector_credentials=True)
        with self.assertRaises(ValueError):
            maintenance.validate_fresh(original)
        with self.assertRaises(ValueError):
            maintenance.validate_fresh(self.current(False), connector_credentials=True)

    def test_actual_fresh_reader_checks_every_scaffolding_table(self):
        rt = object.__new__(maintenance.Runtime)
        rt.m = {'features': {'connector_credentials': True}}
        data = self.current(True)
        queries = []
        def sql(query, database='pl'):
            queries.append(query)
            if query == maintenance.FRESH_SQL:
                return json.dumps({key: value for key, value in data.items() if key not in {'local_users_count', 'scaffolding', 'integration_credentials_count'}}).encode()
            if query == 'SELECT count(*) FROM public.local_users;':
                return b'0'
            if query == 'SELECT count(*) FROM public.integration_credentials;':
                return b'0'
            for name, value in data['scaffolding'].items():
                if query == 'SELECT count(*) FROM public.' + name + ';':
                    return str(value).encode()
                if query == "SELECT COALESCE(json_agg(to_jsonb(t)), '[]'::json) FROM public." + name + ' t;':
                    return json.dumps(value).encode()
            raise AssertionError('Unexpected schema query')
        rt.sql = sql
        captured = rt.fresh_contract()
        maintenance.validate_fresh(captured, connector_credentials=True)
        self.assertEqual(captured['scaffolding'], data['scaffolding'])
        self.assertEqual(len(queries), 3 + len(data['scaffolding']))


if __name__ == '__main__':
    unittest.main()
