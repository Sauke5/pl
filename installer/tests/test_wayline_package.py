"""Optional Wayline image admission and finite source export; no host mutations."""
import copy
import hashlib
import importlib.util
import io
import json
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

bootstrap = load('pl_wayline_bootstrap', BASE / 'bootstrap.py')
package = load('pl_wayline_package', BASE / 'package.py')
script = (BASE / 'install.sh').read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]
wrapper = types.ModuleType('pl_wayline_wrapper')
exec(compile(script, str(BASE / 'install.sh'), 'exec'), wrapper.__dict__)

class WaylinePackageTests(unittest.TestCase):
    def manifest(self, enabled=True):
        source = 'a' * 64
        labels = {'api': {}, 'web': {}, **package.IMAGE_SOURCES}
        images = {name: {'id': 'sha256:' + str(n) * 64, 'architecture': 'amd64',
                        'ref': 'pl/core-' + name + ':fixture', 'recipe': package.RECIPES.get(name, 'Dockerfile'),
                        'labels': {'pl.source.sha256': source, **label}}
                  for n, (name, label) in enumerate(labels.items(), 1)}
        result = {'schema': 2, 'product': 'Pl', 'version': 'fixture', 'architecture': 'amd64',
                  'source_sha256': source, 'features': {'local_users': True, 'module_controller': True},
                  'images': images, 'database': {'major': 18, 'version': '18.6',
                  'volume_target': '/var/lib/postgresql', 'pgdata': '/var/lib/postgresql/18/docker'}}
        if enabled:
            result['features']['wayline_module'] = True
            for n, role in enumerate(('api', 'gateway', 'runner'), 5):
                name = 'wayline-' + role
                images[name] = {'id': 'sha256:' + str(n) * 64, 'architecture': 'amd64',
                    'ref': 'pl/core-' + name + ':fixture', 'recipe': package.WAYLINE_RECIPE,
                    'labels': {'pl.source.sha256': source, 'pl.module.id': 'wayline',
                               'pl.module.config.version': '1', 'pl.module.role': role,
                               'pl.build.variant': 'source-build', 'org.opencontainers.image.version': '0.1.0'}}
        return result

    def test_legacy_four_images_and_optional_three_roles_are_admitted(self):
        bootstrap.validate_bundled_images(self.manifest(False))
        bootstrap.validate_bundled_images(self.manifest())

    def test_partial_roles_wrong_identity_and_mixed_versions_are_rejected(self):
        for mutate in (
            lambda m: m['features'].pop('wayline_module'),
            lambda m: m['images'].pop('wayline-runner'),
            lambda m: m['images']['wayline-api']['labels'].update({'pl.module.role': 'runner'}),
            lambda m: m['images']['wayline-api']['labels'].update({'org.opencontainers.image.version': '0.2.0'}),
            lambda m: m['images']['wayline-api']['labels'].update({'pl.source.sha256': 'b' * 64}),
            lambda m: m['images']['wayline-gateway'].update(architecture='arm64'),
            lambda m: m['images']['wayline-runner'].update(recipe='Dockerfile'),
        ):
            candidate = self.manifest()
            mutate(candidate)
            with self.assertRaises(ValueError):
                bootstrap.validate_bundled_images(candidate)

    def test_feature_requires_controller_helpers_and_schema2_in_both_admission_layers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            names = bootstrap.REQUIRED | {'module-controller.py', 'xray-controller.py', 'wayline-controller.py'}
            candidate = self.manifest()
            def write_manifest(value, selected):
                for name in selected:
                    (root / name).write_bytes(b'fixture')
                value['files'] = {name: hashlib.sha256(b'fixture').hexdigest() for name in selected}
                (root / 'manifest.json').write_text(json.dumps(value))
                archive_path = root / 'package.tar'
                with tarfile.open(archive_path, 'w') as output:
                    for name, body in [('manifest.json', json.dumps(value).encode()),
                                       *[(name, b'fixture') for name in selected]]:
                        member = tarfile.TarInfo(name)
                        member.size = len(body)
                        output.addfile(member, io.BytesIO(body))
                return archive_path
            archive = write_manifest(candidate, names)
            with patch.object(bootstrap.platform, 'machine', return_value='x86_64'):
                self.assertTrue(bootstrap.manifest(root)['features']['wayline_module'])
                self.assertTrue(wrapper.verify_package(archive, 'amd64')['features']['wayline_module'])
                for missing in ('wayline-controller.py', 'xray-controller.py', 'module-controller.py'):
                    value = self.manifest()
                    archive = write_manifest(value, names - {missing})
                    with self.assertRaises(ValueError):
                        bootstrap.manifest(root)
                    with self.assertRaises(wrapper.InstallError):
                        wrapper.verify_package(archive, 'amd64')
                value = self.manifest()
                value['schema'] = 1
                archive = write_manifest(value, names)
                with self.assertRaises(ValueError):
                    bootstrap.manifest(root)
                with self.assertRaises(wrapper.InstallError):
                    wrapper.verify_package(archive, 'amd64')

    def test_wayline_export_includes_referenced_typescript_project(self):
        self.assertIn('apps/wayline/web/tsconfig.app.json', package.WAYLINE_REQUIRED)
        self.assertTrue(package.wayline_source_allowed('apps/wayline/web/tsconfig.app.json'))

    def test_wayline_source_export_is_opt_in_finite_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            portal = package.EXACT | package.WAYLINE_EXACT | {'frontend/package-lock.json'}
            wayline = package.WAYLINE_REQUIRED | {'apps/wayline/backend/internal/probes/transport.go',
                                                'apps/wayline/web/src/App.tsx'}
            excluded = {'apps/wayline/.env', 'apps/wayline/private/token', 'apps/wayline/backend/data/wayline.db',
                        'apps/wayline/web/node_modules/lib/index.js', 'apps/wayline/web/dist/app.js',
                        'apps/wayline/compose.yaml', 'apps/wayline/README.md'}
            for name in {*(package.PREFIX + name for name in portal), *wayline, *excluded}:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            def tracked(args):
                names = wayline | excluded if args[-1] == 'apps/wayline/' else {package.PREFIX + name for name in portal}
                return '\0'.join(sorted(names)) + '\0'
            with patch.object(package, 'ROOT', root), patch.object(package, 'run', side_effect=tracked):
                package.source_context(root / 'base.tar.gz')
                package.source_context(root / 'one.tar.gz', with_wayline=True)
                package.source_context(root / 'two.tar.gz', with_wayline=True)
            with tarfile.open(root / 'base.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), portal - package.WAYLINE_EXACT)
            with tarfile.open(root / 'one.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), portal | wayline)
            self.assertEqual(package.sha(root / 'one.tar.gz'), package.sha(root / 'two.tar.gz'))

if __name__ == '__main__':
    unittest.main()
