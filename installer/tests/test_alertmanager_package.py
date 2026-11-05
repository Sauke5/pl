"""Optional Alertmanager package feature admission; no engine or host changes."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import platform
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
bootstrap = load('pl_am_package_bootstrap', BASE / 'bootstrap.py')
package = load('pl_am_package_export', BASE / 'package.py')
script = (BASE / 'install.sh').read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]
wrapper = types.ModuleType('pl_am_package_wrapper'); exec(compile(script, str(BASE / 'install.sh'), 'exec'), wrapper.__dict__)


class AlertmanagerPackageTests(unittest.TestCase):
    def manifest(self):
        source = 'a' * 64
        labels = {'api': {}, 'web': {}, **package.IMAGE_SOURCES}
        images = {name: {'id': 'sha256:' + str(n) * 64, 'architecture': 'amd64', 'ref': 'pl/core-' + name + ':fixture',
                        'recipe': package.RECIPES.get(name, 'Dockerfile'), 'labels': {'pl.source.sha256': source, **label}}
                  for n, (name, label) in enumerate(labels.items(), 1)}
        return {'schema': 2, 'product': 'Pl', 'version': 'fixture', 'architecture': 'amd64', 'source_sha256': source,
                'features': {'local_users': True, 'module_controller': True}, 'images': images,
                'database': {'major': 18, 'version': '18.6', 'volume_target': '/var/lib/postgresql', 'pgdata': '/var/lib/postgresql/18/docker'}}

    def alertmanager(self, manifest):
        source = json.loads((BASE.parent / package.PREFIX / 'deploy/images/alertmanager.sources.json').read_text())
        manifest['features']['alertmanager_module'] = True
        manifest['images']['alertmanager'] = {'id': 'sha256:' + '6' * 64, 'architecture': 'amd64',
            'ref': 'pl/core-alertmanager:fixture', 'recipe': 'deploy/images/alertmanager.Dockerfile',
            'labels': {'pl.source.sha256': manifest['source_sha256'], **source['labels']}}

    def test_optional_bundled_image_requires_feature_and_exact_provenance(self):
        base = self.manifest()
        bootstrap.validate_bundled_images(base)
        self.alertmanager(base)
        bootstrap.validate_bundled_images(base)
        for mutate in (lambda m: m['features'].pop('alertmanager_module'),
                       lambda m: m['images'].pop('alertmanager'),
                       lambda m: m['images']['alertmanager']['labels'].update({'pl.module.id': 'prometheus'}),
                       lambda m: m['images']['alertmanager'].update(architecture='arm64'),
                       lambda m: m['images']['alertmanager']['labels'].update({'pl.source.sha256': 'f' * 64})):
            value = copy.deepcopy(base); mutate(value)
            with self.assertRaises(ValueError):
                bootstrap.validate_bundled_images(value)

    def test_feature_requires_both_controller_and_shared_file_primitives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.manifest(); self.alertmanager(manifest)
            names = bootstrap.REQUIRED | {'module-controller.py', 'xray-controller.py', 'alertmanager-controller.py'}
            for name in names:
                (root / name).write_bytes(b'fixture')
            manifest['files'] = {name: hashlib.sha256(b'fixture').hexdigest() for name in names}
            (root / 'manifest.json').write_text(json.dumps(manifest))
            with patch.object(bootstrap.platform, 'machine', return_value='x86_64'):
                self.assertEqual(bootstrap.manifest(root)['images']['alertmanager']['id'], manifest['images']['alertmanager']['id'])
                for missing in ('alertmanager-controller.py', 'xray-controller.py'):
                    candidate = copy.deepcopy(manifest); candidate['files'].pop(missing)
                    (root / 'manifest.json').write_text(json.dumps(candidate))
                    with self.assertRaises(ValueError):
                        bootstrap.manifest(root)

    def test_outer_wrapper_accepts_optional_payload_and_rejects_missing_helper(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'package.tar'
            names = bootstrap.REQUIRED | {'module-controller.py', 'xray-controller.py', 'alertmanager-controller.py'}
            manifest = self.manifest(); self.alertmanager(manifest)
            manifest['files'] = {name: hashlib.sha256(b'fixture').hexdigest() for name in names}
            def archive(value, selected):
                with tarfile.open(path, 'w') as output:
                    for name, body in [('manifest.json', json.dumps(value).encode()), *[(name, b'fixture') for name in selected]]:
                        member = tarfile.TarInfo(name); member.size = len(body); output.addfile(member, io.BytesIO(body))
            archive(manifest, names)
            self.assertTrue(wrapper.verify_package(path, 'amd64')['features']['alertmanager_module'])
            manifest['files'].pop('xray-controller.py'); archive(manifest, names - {'xray-controller.py'})
            with self.assertRaises(wrapper.InstallError):
                wrapper.verify_package(path, 'amd64')

    def test_source_context_has_only_finite_alertmanager_recipe_inputs(self):
        self.assertIn('deploy/images/alertmanager.Dockerfile', package.EXACT)
        self.assertIn('deploy/images/alertmanager.sources.json', package.EXACT)
        self.assertNotIn('deploy/images/alertmanager.private.json', package.EXACT)


if __name__ == '__main__':
    unittest.main()
