"""Host installer guards; all host calls are mocked, no root operations are run."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'install.sh'
SOURCE = SCRIPT.read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.module = types.ModuleType('pl_install_under_test')
        exec(compile(SOURCE, str(SCRIPT), 'exec'), self.module.__dict__)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / 'installation'

    def package(self, extra=None, manifest_change=None):
        files = {'bootstrap.py': b'print("bootstrap")\n', 'images.tar': b'images',
                 'nginx.conf': b'config', 'LICENSES.txt': b'licenses'}
        manifest = {'schema': 1, 'product': 'Pl', 'version': '0.1.0-core.1', 'architecture': 'amd64',
                    'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        if manifest_change:
            manifest_change(manifest)
        files['manifest.json'] = json.dumps(manifest).encode()
        package = self.base / 'package.tar'
        with tarfile.open(package, 'w') as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                member = extra() if callable(extra) else tarfile.TarInfo(extra)
                archive.addfile(member, io.BytesIO(b''))
        return package, manifest

    def host(self, docker=True, endpoint='unix:///var/run/docker.sock', engine='29.8.2', compose='5.5.1',
             memory=8 * 1024**2, free=40 * 1024**3, distro='ubuntu', codename='resolute'):
        os_release = self.base / 'os-release'
        os_release.write_text(f'ID={distro}\nVERSION_CODENAME={codename}\n')
        meminfo = self.base / 'meminfo'
        meminfo.write_text(f'MemTotal: {memory} kB\n')
        self.calls = []

        def run(args, **kwargs):
            self.calls.append(args)
            if args[:2] == ['dpkg', '--print-architecture']:
                return 'amd64'
            if args[:3] == ['docker', 'context', 'inspect']:
                return json.dumps(endpoint)
            if args[:2] == ['docker', 'version']:
                return json.dumps({'Version': engine, 'Os': 'linux', 'Arch': 'amd64'})
            if args[:3] == ['docker', 'compose', 'version']:
                return compose
            raise AssertionError(f'Unexpected host mutation: {args}')

        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(self.module, 'OS_RELEASE', os_release))
        stack.enter_context(patch.object(self.module, 'MEMINFO', meminfo))
        stack.enter_context(patch.object(self.module.os, 'geteuid', return_value=0))
        stack.enter_context(patch.object(self.module.platform, 'system', return_value='Linux'))
        stack.enter_context(patch.object(self.module.shutil, 'which', return_value='/usr/bin/docker' if docker else None))
        stack.enter_context(patch.object(self.module.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=free)))
        stack.enter_context(patch.object(self.module, 'run', side_effect=run))
        stack.enter_context(patch.dict(self.module.os.environ, {}, clear=True))
        return stack

    def test_shell_help_is_available_without_root(self):
        result = subprocess.run(['sh', str(SCRIPT), '--help'], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--check', result.stdout)

    def test_valid_package_and_idempotent_release_staging(self):
        package, manifest = self.package()
        self.assertEqual(self.module.verify_package(package, 'amd64'), manifest)
        (self.root / 'releases').mkdir(parents=True)
        sha = self.module.digest(package)
        first = self.module.stage_release(package, self.root, manifest, sha)
        second = self.module.stage_release(package, self.root, manifest, sha)
        self.assertEqual(first, second)
        self.assertEqual((first / 'images.tar').read_bytes(), b'images')

    def test_supported_package_schemas_pass_outer_archive_verification(self):
        # Runtime image contracts are checked by bootstrap before host install.
        # The outer wrapper must admit both supported package formats.
        for schema in (1, 2):
            with self.subTest(schema=schema):
                package, manifest = self.package(manifest_change=lambda m: m.update(schema=schema))
                self.assertEqual(self.module.verify_package(package, 'amd64'), manifest)

    def test_release_reuse_rejects_modified_payload(self):
        package, manifest = self.package()
        (self.root / 'releases').mkdir(parents=True)
        sha = self.module.digest(package)
        release = self.module.stage_release(package, self.root, manifest, sha)
        (release / 'bootstrap.py').write_text('tampered')
        with self.assertRaisesRegex(self.module.InstallError, 'differ'):
            self.module.stage_release(package, self.root, manifest, sha)

    def test_existing_version_cannot_be_replaced(self):
        package, manifest = self.package()
        (self.root / 'releases').mkdir(parents=True)
        self.module.stage_release(package, self.root, manifest, self.module.digest(package))
        with self.assertRaisesRegex(self.module.InstallError, 'different package'):
            self.module.stage_release(package, self.root, manifest, 'f' * 64)

    def test_unsafe_archive_members(self):
        for name in ('../bootstrap.py', '/tmp/escape', './bootstrap.py', 'a/b', 'unexpected', 'bootstrap.py'):
            with self.subTest(name=name):
                package, _ = self.package(extra=name)
                with self.assertRaises(self.module.InstallError):
                    self.module.verify_package(package, 'amd64')

    def test_nonregular_archive_members(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE):
            def member():
                value = tarfile.TarInfo('README.md')
                value.type = kind
                value.linkname = 'bootstrap.py'
                return value
            with self.subTest(kind=kind):
                package, _ = self.package(extra=member)
                with self.assertRaises(self.module.InstallError):
                    self.module.verify_package(package, 'amd64')

    def test_manifest_guards(self):
        changes = [lambda m: m.update(version='../escape'), lambda m: m.update(architecture='arm64'),
                   lambda m: m.update(product='other'), lambda m: m.update(schema=3),
                   lambda m: m.update(features=['local_users']),
                   lambda m: m.update(features={'local_users': 'true'}),
                   lambda m: m.update(features={'unknown': True}),
                   lambda m: m['files'].update({'bootstrap.py': 'f' * 64}),
                   lambda m: m['files'].pop('images.tar')]
        for change in changes:
            with self.subTest(change=change):
                package, _ = self.package(manifest_change=change)
                with self.assertRaises(self.module.InstallError):
                    self.module.verify_package(package, 'amd64')

    def test_expansion_limit(self):
        package, _ = self.package()
        with patch.object(self.module, 'MAX_PACKAGE', 1):
            with self.assertRaisesRegex(self.module.InstallError, 'size limit'):
                self.module.verify_package(package, 'amd64')

    def test_network_requires_https_and_checksum_before_preflight(self):
        for arguments in (['--package-url', 'https://example.org/package'],
                          ['--package-url', 'http://example.org/package', '--package-sha256', 'f' * 64],
                          ['--package-url', 'https://user:secret@example.org/package', '--package-sha256', 'f' * 64]):
            with self.subTest(arguments=arguments), patch.object(self.module, 'preflight') as preflight:
                with self.assertRaises(self.module.InstallError):
                    self.module.main([*arguments, '--public-url', 'https://pl.example'])
                preflight.assert_not_called()

    def test_http_redirect_rejected(self):
        redirect = self.module.HTTPSRedirect()
        with self.assertRaises(self.module.InstallError):
            redirect.redirect_request(None, None, 302, '', {}, 'http://example.org/package')

    def test_wrong_package_hash_prevents_any_host_mutation(self):
        package, _ = self.package()
        with self.host(), patch.object(self.module, 'prepare_root') as prepare:
            with self.assertRaisesRegex(self.module.InstallError, 'SHA-256 mismatch'):
                self.module.main(['--root', str(self.root), '--package', str(package),
                                  '--package-sha256', 'f' * 64, '--public-url', 'https://pl.example', '--self-signed'])
            prepare.assert_not_called()
        self.assertFalse(self.root.exists())

    def test_check_is_read_only(self):
        with self.host():
            self.module.main(['--root', str(self.root), '--check'])
        self.assertFalse(self.root.exists())
        self.assertTrue(all(call[0] in {'dpkg', 'docker'} for call in self.calls))

    def test_check_reports_missing_openssl_without_mutations(self):
        with self.host(), patch.object(self.module.shutil, 'which', side_effect=lambda name: '/usr/bin/docker' if name == 'docker' else None):
            with self.assertRaisesRegex(self.module.InstallError, 'OpenSSL CLI is missing'):
                self.module.main(['--root', str(self.root), '--check'])
        self.assertFalse(self.root.exists())
        self.assertTrue(all(call[0] in {'dpkg', 'docker'} for call in self.calls))

    def test_install_requires_tls_mode_before_host_changes(self):
        package, _ = self.package()
        for tls_options in ([], ['--tls-cert', 'cert.pem'], ['--self-signed', '--tls-cert', 'cert.pem', '--tls-key', 'key.pem']):
            with self.subTest(tls_options=tls_options), patch.object(self.module, 'preflight') as preflight, \
                    patch.object(self.module, 'prepare_root') as prepare:
                with self.assertRaises(self.module.InstallError):
                    self.module.main(['--package', str(package), '--public-url', 'https://pl.example', *tls_options])
                preflight.assert_not_called()
                prepare.assert_not_called()

    def test_install_repairs_missing_openssl_and_preserves_package_record(self):
        self.root.mkdir()
        self.module.record_packages(self.root, ['docker-ce=5:29.8.2'])
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return 'Candidate: 3.5.1-1' if args[0] == 'apt-cache' else ''
        with patch.object(self.module.shutil, 'which', side_effect=[None, '/usr/bin/openssl']), \
                patch.object(self.module, 'run', side_effect=run):
            self.module.ensure_openssl(self.root)
        self.assertEqual(calls, [['apt-get', 'update'], ['apt-cache', 'policy', 'openssl'],
                                 ['apt-get', 'install', '-y', '--no-install-recommends', 'openssl=3.5.1-1']])
        self.assertEqual(json.loads((self.root / 'host-packages.json').read_text())['packages'],
                         ['docker-ce=5:29.8.2', 'openssl=3.5.1-1'])

    def test_present_openssl_is_left_unchanged(self):
        with patch.object(self.module.shutil, 'which', return_value='/usr/bin/openssl'), \
                patch.object(self.module, 'run') as run:
            self.module.ensure_openssl(self.root)
            run.assert_not_called()
        self.assertFalse(self.root.exists())

    def test_remote_context_rejected(self):
        with self.host(endpoint='ssh://remote'):
            with self.assertRaisesRegex(self.module.InstallError, 'context'):
                self.module.preflight(self.root)

    def test_remote_environment_rejected(self):
        with self.host(), patch.dict(self.module.os.environ, {'DOCKER_HOST': 'tcp://remote:2375'}):
            with self.assertRaisesRegex(self.module.InstallError, 'Unset'):
                self.module.preflight(self.root)

    def test_existing_engine_is_never_silently_upgraded(self):
        with self.host(engine='28.5.0'):
            with self.assertRaisesRegex(self.module.InstallError, 'upgrade it explicitly'):
                self.module.preflight(self.root)

    def test_resource_and_os_preflight(self):
        for arguments in ({'memory': 1024}, {'free': 1024}, {'distro': 'mint'}, {'compose': '2.23.0'}):
            with self.subTest(arguments=arguments), self.host(**arguments):
                with self.assertRaises(self.module.InstallError):
                    self.module.preflight(self.root)

    def test_refuse_unrelated_root_and_symlink(self):
        self.root.mkdir()
        (self.root / 'user-data').write_text('preserve')
        with self.host():
            with self.assertRaisesRegex(self.module.InstallError, 'not managed'):
                self.module.preflight(self.root)
        self.assertEqual((self.root / 'user-data').read_text(), 'preserve')
        other = self.base / 'link'
        other.symlink_to(self.root, target_is_directory=True)
        with self.host():
            with self.assertRaisesRegex(self.module.InstallError, 'symlink'):
                self.module.preflight(other)

    def test_password_only_forwarded_as_path(self):
        package, _ = self.package()
        secret = self.base / 'private-password'
        secret.write_text('SENSITIVE_VALUE_NEVER_OUTPUT')
        calls = []
        with self.host(), patch.object(self.module, 'prepare_root', side_effect=lambda root: (root / 'releases').mkdir(parents=True)), \
                patch.object(self.module, 'preflight', return_value={'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64', 'docker_present': True}), \
                patch.object(self.module, 'install_docker'), patch.object(self.module, 'run', side_effect=lambda cmd, **kw: calls.append(cmd)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.module.main(['--root', str(self.root), '--package', str(package), '--public-url', 'https://pl.example',
                              '--self-signed', '--password-file', str(secret)])
        self.assertIn('--password-file', calls[-1])
        self.assertIn(str(secret), calls[-1])
        self.assertNotIn(secret.read_text(), repr(calls) + output.getvalue())

    def test_production_mode_is_forwarded_with_explicit_password_path_only(self):
        package, _ = self.package()
        secret = self.base / 'private-password'
        secret.write_text('EXPLICIT_PRIVATE_PRODUCTION_PASSWORD')
        secret.chmod(0o600)
        calls = []
        with self.host(), patch.object(self.module, 'prepare_root', side_effect=lambda root: (root / 'releases').mkdir(parents=True)), \
                patch.object(self.module, 'preflight', return_value={'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64', 'docker_present': True}), \
                patch.object(self.module, 'install_docker'), patch.object(self.module, 'run', side_effect=lambda cmd, **kw: calls.append(cmd)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.module.main(['--root', str(self.root), '--package', str(package), '--public-url', 'https://pl.example',
                              '--self-signed', '--production', '--password-file', str(secret)])
        self.assertIn('--production', calls[-1])
        self.assertIn('--password-file', calls[-1])
        self.assertIn(str(secret), calls[-1])
        self.assertNotIn(secret.read_text(), repr(calls) + output.getvalue())

    def test_network_cidr_is_validated_before_host_preflight_or_mutations(self):
        for value in ("10.20.30.1/24", "192.168.1.0/25", "8.8.8.0/24", "100.64.1.0/24", "10.20.30.0/255.255.255.0", "fc00::/24"):
            with self.subTest(value=value), patch.object(self.module, 'preflight') as preflight, patch.object(self.module, 'prepare_root') as prepare:
                with self.assertRaisesRegex(self.module.InstallError, 'network-cidr'):
                    self.module.main(['--network-cidr', value, '--check'])
                preflight.assert_not_called()
                prepare.assert_not_called()

    def test_explicit_network_cidr_is_forwarded_to_bootstrap(self):
        package, manifest = self.package()
        calls = []
        with self.host(), patch.object(self.module, 'prepare_root', side_effect=lambda root: (root / 'releases').mkdir(parents=True)), \
                patch.object(self.module, 'preflight', return_value={'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64', 'docker_present': True}), \
                patch.object(self.module, 'install_docker'), patch.object(self.module, 'ensure_openssl'), \
                patch.object(self.module, 'run', side_effect=lambda cmd, **kw: calls.append(cmd)), contextlib.redirect_stdout(io.StringIO()):
            self.module.main(['--root', str(self.root), '--package', str(package), '--public-url', 'https://pl.example',
                              '--self-signed', '--network-cidr', '10.90.1.0/24'])
        self.assertEqual(calls[-1][calls[-1].index('--network-cidr') + 1], '10.90.1.0/24')

    def test_package_pin_uses_exact_versions(self):
        with patch.object(self.module, 'run', return_value='  Candidate: 5:29.8.2-1~ubuntu.26.04~resolute'):
            self.assertEqual(self.module.pin_packages(['docker-ce']), ['docker-ce=5:29.8.2-1~ubuntu.26.04~resolute'])

    def test_service_account_conflict_does_not_touch_directory(self):
        with patch.object(self.module.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=999)), \
                patch.object(self.module, 'run') as run:
            with self.assertRaisesRegex(self.module.InstallError, 'already exists'):
                self.module.prepare_root(self.root)
            run.assert_not_called()
        self.assertFalse(self.root.exists())

    def test_existing_service_account_privileges_are_rejected(self):
        self.root.mkdir()
        (self.root / '.pl-installation.json').write_text(json.dumps({'product': 'Pl', 'uid': 999, 'gid': 999}))
        account = types.SimpleNamespace(pw_uid=999, pw_gid=999, pw_shell='/usr/sbin/nologin')
        group = types.SimpleNamespace(gr_name='docker', gr_mem=['pl'], gr_gid=998)
        with patch.object(self.module.pwd, 'getpwnam', return_value=account), \
                patch.object(self.module.grp, 'getgrall', return_value=[group]), patch.object(self.module, 'run') as run:
            with self.assertRaisesRegex(self.module.InstallError, 'privileges'):
                self.module.prepare_root(self.root)
            run.assert_not_called()

    def test_second_installation_reuses_only_verified_unprivileged_account(self):
        source = self.base / 'source'
        (source / 'state').mkdir(parents=True)
        (source / '.pl-installation.json').write_text(json.dumps({'product': 'Pl', 'uid': 999, 'gid': 999}))
        (source / 'state/installation.json').write_text(json.dumps({'product': 'Pl', 'phase': 'ready', 'install_id': 'pl-0123456789ab'}))
        account = types.SimpleNamespace(pw_uid=999, pw_gid=999, pw_shell='/usr/sbin/nologin')
        with patch.object(self.module.pwd, 'getpwnam', return_value=account), \
                patch.object(self.module.grp, 'getgrall', return_value=[]), patch.object(self.module, 'run') as run:
            self.module.prepare_root(self.root, source)
            run.assert_not_called()
        self.assertEqual(json.loads((self.root / '.pl-installation.json').read_text())['uid'], 999)
        self.assertTrue((self.root / 'releases').is_dir())

    def test_account_reuse_refuses_foreign_source_before_creating_target(self):
        source = self.base / 'foreign'
        (source / 'state').mkdir(parents=True)
        (source / '.pl-installation.json').write_text('{}')
        (source / 'state/installation.json').write_text(json.dumps({'product': 'Other', 'phase': 'ready'}))
        with self.assertRaisesRegex(self.module.InstallError, 'not a ready'):
            self.module.prepare_root(self.root, source)
        self.assertFalse(self.root.exists())

    def test_new_docker_install_pins_packages_and_checks_signing_key(self):
        self.root.mkdir()
        source = self.base / 'docker.sources'
        key = self.base / 'docker.asc'
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[:2] == ['apt-cache', 'policy']:
                return '  Candidate: 5:29.8.2-1'
            if args[0] == 'gpg':
                return 'fpr:::::::::' + self.module.DOCKER_FINGERPRINT + ':'
            return ''

        info = {'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64', 'docker_present': False}
        with patch.object(self.module, 'APT_SOURCES', source), patch.object(self.module, 'APT_KEY', key), \
                patch.object(self.module, 'run', side_effect=run), \
                patch.object(self.module, 'download', side_effect=lambda url, path, limit: path.write_text('PUBLIC KEY')), \
                patch.object(self.module, 'preflight', return_value=dict(info, docker_present=True)):
            self.module.install_docker(info, self.root)
        self.assertIn('Signed-By: ' + str(key), source.read_text())
        apt_installs = [cmd for cmd in calls if cmd[:2] == ['apt-get', 'install']]
        self.assertEqual(len(apt_installs), 2)
        self.assertTrue(all('=' in spec for cmd in apt_installs for spec in cmd[4:]))
        self.assertIn(['systemctl', 'enable', '--now', 'docker'], calls)
        self.assertEqual(len(json.loads((self.root / 'host-packages.json').read_text())['packages']), 8)
        self.assertTrue(info['docker_present'])

    def test_wrong_docker_key_prevents_repository_install(self):
        self.root.mkdir()
        source = self.base / 'docker.sources'
        key = self.base / 'docker.asc'
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[0] == 'apt-cache':
                return 'Candidate: 1.0'
            if args[0] == 'gpg':
                return 'fpr:::::::::BAD:'
            return ''

        info = {'distribution': 'ubuntu', 'codename': 'resolute', 'architecture': 'amd64', 'docker_present': False}
        with patch.object(self.module, 'APT_SOURCES', source), patch.object(self.module, 'APT_KEY', key), \
                patch.object(self.module, 'run', side_effect=run), \
                patch.object(self.module, 'download', side_effect=lambda url, path, limit: path.write_text('WRONG KEY')):
            with self.assertRaisesRegex(self.module.InstallError, 'fingerprint'):
                self.module.install_docker(info, self.root)
        self.assertFalse(source.exists())
        self.assertFalse(key.exists())
        self.assertFalse(any('docker-ce' in ' '.join(cmd) for cmd in calls))


if __name__ == '__main__':
    unittest.main()
