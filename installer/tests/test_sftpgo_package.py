"""Optional generic SFTPGo package admission. No Docker or host mutations."""
import hashlib
import importlib.util
import io
import json
import re
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load('pl_sftpgo_package', BASE / 'package.py')
bootstrap = load('pl_sftpgo_bootstrap', BASE / 'bootstrap.py')
applications = load('pl_sftpgo_application_fixtures', BASE / 'tests/test_application_package.py')
wrapper = types.ModuleType('pl_sftpgo_wrapper')
script = (BASE / 'install.sh').read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]
exec(compile(script, str(BASE / 'install.sh'), 'exec'), wrapper.__dict__)
PORTAL = BASE.parent / package.PREFIX


class SFTPGoPackageTests(unittest.TestCase):
    def manifest(self):
        return applications.ApplicationPackageTests().manifest(('forms', 'doska', 'sftpgo'))

    def test_one_role_and_descriptor_are_independent_of_specialized_exchange(self):
        value = self.manifest()
        bootstrap.validate_bundled_images(value)
        self.assertEqual(len(value['images']), 13)
        descriptor = bootstrap.module_image_descriptor(value, 'pl-fixture', 'f' * 64)
        self.assertEqual(set(descriptor['sftpgo']), {'server'})
        self.assertEqual(descriptor['sftpgo']['server'], value['images']['sftpgo-server'])
        self.assertNotIn('sftp', descriptor)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.pl-installation.json').write_text(json.dumps({'gid': 10001}))
            model = bootstrap.compose_model(root, value, {'public_url': 'https://platform.example.test',
                'admin_user': 'admin', 'bind_address': '127.0.0.1', 'port': 8443}, 'pl-fixture')
        env = model['services']['api']['environment']
        versions = json.loads(env['PORTAL_MODULE_VERSIONS'])
        self.assertEqual(versions['sftpgo'], value['images']['sftpgo-server']['labels']['org.opencontainers.image.version'])
        self.assertFalse(any(name.startswith('PORTAL_SFTP_') for name in env))

    def test_portable_fence_and_disk_transfer_spool_are_feature_scoped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.pl-installation.json').write_text(json.dumps({'gid': 10001}))
            cfg = {'public_url': 'https://platform.example.test', 'admin_user': 'admin',
                   'bind_address': '127.0.0.1', 'port': 8443}
            enabled = bootstrap.compose_model(root, self.manifest(), cfg, 'pl-fixture')
            without = applications.ApplicationPackageTests().manifest(('forms', 'doska'))
            disabled = bootstrap.compose_model(root, without, cfg, 'pl-fixture')
        api = enabled['services']['api']
        self.assertEqual(api['environment']['PORTAL_PORTABLE_RELEASE'], 'true')
        self.assertEqual(disabled['services']['api']['environment']['PORTAL_PORTABLE_RELEASE'], 'true')
        self.assertTrue(api['read_only'])
        destination = '/var/lib/pl/transfers'
        mounts = [mount for mount in api['volumes'] if
                  (isinstance(mount, str) and mount.split(':')[1] == destination) or
                  (isinstance(mount, dict) and mount.get('target') == destination)]
        self.assertEqual(mounts, ['module-transfers:' + destination])
        self.assertEqual(enabled['volumes']['module-transfers'],
                         {'labels': {'pl.installation': 'pl-fixture', 'pl.temporary': 'true'}})
        self.assertFalse(any(destination in entry for entry in api['tmpfs']))
        self.assertNotIn('module-transfers', disabled['volumes'])
        self.assertFalse(any(destination in str(entry) for entry in disabled['services']['api']['volumes']))
        # The temporary spool neither replaces durable DB/auth nor enters a
        # second service's mounts, and disabling it preserves those contracts.
        self.assertEqual(enabled['services']['db'], disabled['services']['db'])
        self.assertEqual(enabled['volumes']['db'], disabled['volumes']['db'])
        self.assertEqual(enabled['volumes']['local-auth'], disabled['volumes']['local-auth'])
        self.assertIn('local-auth:/run/pl-auth', api['volumes'])
        for name, service in enabled['services'].items():
            if name != 'api':
                self.assertFalse(any('module-transfers' in str(entry) for entry in service.get('volumes', [])))

    def test_nginx_streaming_limit_applies_only_to_raw_module_file_route(self):
        config = (BASE / 'nginx.conf').read_text()
        locations = [(re.compile(match.group(1)), match.group(2))
                     for match in re.finditer(r'location\s+~\s+(\S+)\s*\{([^{}]*)\}', config)]
        default_size = re.search(r'client_max_body_size\s+(\S+);', config).group(1)
        def directives(uri):
            # Nginx's first matching regex wins. Query args do not participate
            # in location selection; generic API must retain its smaller limit.
            path = uri.split('?', 1)[0]
            for pattern, body in locations:
                if pattern.search(path):
                    return dict(re.findall(r'(\w+)\s+([^;]+);', body))
            self.fail('API route not proxied: ' + path)
        raw = '/api/v1/modules/01234567-89ab-4def-8123-456789abcdef/sftpgo/files/content'
        for uri in (raw, raw + '?path=%2Flarge.bin'):
            selected = directives(uri)
            self.assertEqual(selected['client_max_body_size'], '1g')
            self.assertEqual(selected['proxy_request_buffering'], 'off')
            self.assertEqual(selected['proxy_buffering'], 'off')
            self.assertEqual(selected['proxy_http_version'], '1.1')
            self.assertEqual(selected['proxy_pass'], 'http://$api')
            for directive in ('client_body_timeout', 'proxy_read_timeout', 'proxy_send_timeout'):
                value = selected[directive]
                self.assertRegex(value, r'^\d+m$')
                self.assertGreaterEqual(int(value[:-1]), 30)
        self.assertEqual(default_size, '5m')
        for uri in ('/api/v1/modules/a/sftpgo/users', raw + '/extra',
                    '/api/v1/modules/a/forms/files/content', '/api/v1/settings'):
            selected = directives(uri)
            self.assertNotIn('client_max_body_size', selected)
            self.assertNotIn('proxy_request_buffering', selected)
            self.assertEqual(selected['proxy_read_timeout'], '60s')

    def test_complete_candidate_without_grafana_contains_sixteen_images(self):
        value = self.manifest()
        metadata = json.loads((PORTAL / package.WAYLINE_METADATA).read_text())
        value['features']['wayline_module'] = True
        for name, image in metadata['images'].items():
            value['images'][name] = {'id': 'sha256:' + hashlib.sha256(name.encode()).hexdigest(),
                'architecture': 'amd64', 'ref': 'pl/core-' + name + ':fixture',
                'recipe': package.WAYLINE_RECIPE,
                'labels': {'pl.source.sha256': value['source_sha256'], **image['labels']}}
        self.assertEqual(len(value['images']), 16)
        self.assertNotIn('grafana', value['images'])
        bootstrap.validate_bundled_images(value)

    def test_exact_role_version_recipe_and_provenance_fail_closed(self):
        mutations = (
            lambda m: m['images'].pop('sftpgo-server'),
            lambda m: m['features'].pop('sftpgo_module'),
            lambda m: m['images']['sftpgo-server'].update(architecture='arm64'),
            lambda m: m['images']['sftpgo-server'].update(recipe='Dockerfile'),
            lambda m: m['images']['sftpgo-server']['labels'].update({'pl.module.role': 'api'}),
            lambda m: m['images']['sftpgo-server']['labels'].update({'org.opencontainers.image.version': 'latest'}),
            lambda m: m['images']['sftpgo-server']['labels'].update({'pl.source.sha256': 'b' * 64}),
            lambda m: m['images']['sftpgo-server']['labels'].update({'pl.module.id': 'sftp'}),
            lambda m: m['images']['sftpgo-server']['labels'].update({'pl.build.variant': 'source-build'}),
            lambda m: m['images']['sftpgo-server'].update(id='drakkan/sftpgo:latest'),
        )
        for mutate in mutations:
            value = self.manifest()
            mutate(value)
            with self.assertRaises(ValueError):
                bootstrap.validate_bundled_images(value)
        value = self.manifest()
        value['images']['sftpgo-server']['labels']['org.opencontainers.image.version'] = '10.20.30'
        bootstrap.validate_bundled_images(value)

    def test_metadata_target_is_server_and_cannot_select_other_stage(self):
        metadata = package.application_metadata(PORTAL, 'sftpgo')
        self.assertEqual(set(metadata['images']), {'sftpgo-server'})
        self.assertEqual(metadata['images']['sftpgo-server']['target'], 'server')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / package.APPLICATION_METADATA['sftpgo']
            path.parent.mkdir(parents=True)
            metadata['images']['sftpgo-server']['target'] = 'foreign'
            path.write_text(json.dumps(metadata))
            with self.assertRaises(ValueError):
                package.application_metadata(root, 'sftpgo')

    def test_controllers_required_by_both_installers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            names = bootstrap.REQUIRED | {'module-controller.py', 'xray-controller.py',
                'alertmanager-controller.py', 'forms-controller.py', 'doska-controller.py', 'sftpgo-controller.py'}
            def write(selected):
                value = self.manifest()
                value['files'] = {name: hashlib.sha256(b'fixture').hexdigest() for name in selected}
                (root / 'manifest.json').write_text(json.dumps(value))
                for name in selected:
                    (root / name).write_bytes(b'fixture')
                output = root / 'candidate.tar'
                with tarfile.open(output, 'w') as archive:
                    for name, body in [('manifest.json', json.dumps(value).encode()), *[(name, b'fixture') for name in selected]]:
                        member = tarfile.TarInfo(name)
                        member.size = len(body)
                        archive.addfile(member, io.BytesIO(body))
                return output
            with patch.object(bootstrap.platform, 'machine', return_value='x86_64'):
                archive = write(names)
                bootstrap.manifest(root)
                wrapper.verify_package(archive, 'amd64')
                self.assertIn('sftpgo-controller.py', bootstrap.FILES)
                self.assertIn('sftpgo-controller.py', wrapper.ALLOWED)
                # Re-admission of the same release remains possible, while a
                # changed trusted controller cannot reuse the recorded digest.
                bootstrap.manifest(root)
                (root / 'sftpgo-controller.py').write_bytes(b'changed controller')
                with self.assertRaises(ValueError):
                    bootstrap.manifest(root)
                with tarfile.open(archive, 'r') as source:
                    members = [(entry.name, source.extractfile(entry).read()) for entry in source]
                with tarfile.open(archive, 'w') as target:
                    for name, body in members:
                        if name == 'sftpgo-controller.py':
                            body = b'changed controller'
                        entry = tarfile.TarInfo(name)
                        entry.size = len(body)
                        target.addfile(entry, io.BytesIO(body))
                with self.assertRaises(wrapper.InstallError):
                    wrapper.verify_package(archive, 'amd64')
                for missing in ('sftpgo-controller.py', 'xray-controller.py', 'module-controller.py'):
                    archive = write(names - {missing})
                    with self.assertRaises(ValueError):
                        bootstrap.manifest(root)
                    with self.assertRaises(wrapper.InstallError):
                        wrapper.verify_package(archive, 'amd64')

    def test_source_export_adds_only_tracked_recipe_and_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            portal = package.EXACT | {'frontend/package-lock.json', package.APPLICATION_RECIPES['sftpgo'], package.APPLICATION_METADATA['sftpgo']}
            excluded = {'apps/sftpgo/.env', 'apps/sftpgo/state/sftpgo.db', 'apps/sftpgo/credentials.json',
                        'deploy/sftpgo/private.json', 'deploy/images/sftpgo.credentials.json'}
            for name in portal | excluded:
                path = root / package.PREFIX / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            def tracked(args):
                return '\0'.join(package.PREFIX + name for name in portal | excluded) + '\0' if args[-1] == package.PREFIX else '\0'.join(excluded) + '\0'
            with patch.object(package, 'ROOT', root), patch.object(package, 'run', side_effect=tracked):
                package.source_context(root / 'base.tar.gz')
                package.source_context(root / 'one.tar.gz', with_sftpgo=True)
                package.source_context(root / 'two.tar.gz', with_sftpgo=True)
            with tarfile.open(root / 'base.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), package.EXACT | {'frontend/package-lock.json'})
            with tarfile.open(root / 'one.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), portal)
            self.assertEqual(package.sha(root / 'one.tar.gz'), package.sha(root / 'two.tar.gz'))


if __name__ == '__main__':
    unittest.main()
