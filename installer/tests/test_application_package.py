"""Forms/Doska finite exports and admission, without Docker or host mutations."""
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


package = load('pl_application_package', BASE / 'package.py')
bootstrap = load('pl_application_bootstrap', BASE / 'bootstrap.py')
wrapper = types.ModuleType('pl_application_wrapper')
script = (BASE / 'install.sh').read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]
exec(compile(script, str(BASE / 'install.sh'), 'exec'), wrapper.__dict__)
PORTAL = BASE.parent / package.PREFIX


class ApplicationPackageTests(unittest.TestCase):
    def manifest(self, applications=('forms', 'doska')):
        labels = {'api': {}, 'web': {}, **copy.deepcopy(package.IMAGE_SOURCES)}
        recipes = dict(package.RECIPES)
        features = {'local_users': True, 'module_controller': True, 'xray_module': True, 'alertmanager_module': True}
        for module in ('xray', 'alertmanager'):
            labels[module] = json.loads((PORTAL / ('deploy/images/' + module + '.sources.json')).read_text())['labels']
        for module in applications:
            metadata = package.application_metadata(PORTAL, module)
            features[module + '_module'] = True
            for name, image in metadata['images'].items():
                labels[name] = image['labels']
                recipes[name] = package.APPLICATION_RECIPES[module]
        source = 'a' * 64
        images = {name: {'id': 'sha256:' + hashlib.sha256(name.encode()).hexdigest(),
                        'architecture': 'amd64', 'ref': 'pl/core-' + name + ':fixture',
                        'recipe': recipes.get(name, 'Dockerfile'), 'labels': {'pl.source.sha256': source, **label}}
                  for name, label in labels.items()}
        return {'schema': 2, 'product': 'Pl', 'version': 'fixture', 'architecture': 'amd64',
                'source_sha256': source, 'features': features, 'images': images,
                'database': {'major': 18, 'version': '18.6', 'volume_target': '/var/lib/postgresql', 'pgdata': '/var/lib/postgresql/18/docker'}}

    def test_optional_roles_and_metadata_versions_are_admitted(self):
        for modules, count in (((), 6), (('forms',), 10), (('doska',), 8), (('forms', 'doska'), 12)):
            with self.subTest(modules=modules):
                value = self.manifest(modules)
                self.assertEqual(len(value['images']), count)
                bootstrap.validate_bundled_images(value)
        value = self.manifest()
        for name in ('forms-adapter', 'forms-engine', 'forms-mongo', 'forms-keydb'):
            value['images'][name]['labels']['org.opencontainers.image.version'] = '10.20.30'
        bootstrap.validate_bundled_images(value)

    def test_combined_optional_image_set_and_runtime_descriptors(self):
        value = self.manifest()
        for module in ("wayline", "grafana"):
            metadata = json.loads((PORTAL / ("deploy/images/" + module + ".sources.json")).read_text())
            images = metadata["images"] if module == "wayline" else {module: {"labels": metadata["labels"]}}
            value["features"][module + "_module"] = True
            for name, image in images.items():
                value["images"][name] = {"id": "sha256:" + hashlib.sha256(name.encode()).hexdigest(),
                    "architecture": "amd64", "ref": "pl/core-" + name + ":fixture",
                    "recipe": "deploy/images/" + module + ".Dockerfile",
                    "labels": {"pl.source.sha256": value["source_sha256"], **image["labels"]}}
        self.assertEqual(len(value["images"]), 16)
        bootstrap.validate_bundled_images(value)
        descriptor = bootstrap.module_image_descriptor(value, "pl-fixture", "f" * 64)
        self.assertEqual(set(descriptor["forms"]), {"adapter", "engine", "mongo", "keydb"})
        self.assertEqual(set(descriptor["doska"]), {"api", "web", "database"})
        self.assertEqual(descriptor["doska"]["database"], value["images"]["db"])
        self.assertEqual(descriptor["forms"]["adapter"], value["images"]["forms-adapter"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".pl-installation.json").write_text(json.dumps({"gid": 10001}))
            model = bootstrap.compose_model(root, value, {"public_url": "https://platform.example.test", "admin_user": "admin", "bind_address": "127.0.0.1", "port": 8443}, "pl-fixture")
        versions = json.loads(model["services"]["api"]["environment"]["PORTAL_MODULE_VERSIONS"])
        for module, role in (("forms", "adapter"), ("doska", "api")):
            self.assertEqual(versions[module], value["images"][module + "-" + role]["labels"]["org.opencontainers.image.version"])

    def test_incomplete_roles_mixed_versions_or_foreign_provenance_are_rejected(self):
        mutations = (
            lambda m: m['images'].pop('forms-keydb'),
            lambda m: m['images'].pop('doska-web'),
            lambda m: m['features'].pop('forms_module'),
            lambda m: m['features'].pop('doska_module'),
            lambda m: m['images']['doska-api'].update(architecture='arm64'),
            lambda m: m['images']['forms-engine'].update(recipe='Dockerfile'),
            lambda m: m['images']['forms-mongo']['labels'].update({'pl.source.sha256': 'b' * 64}),
            lambda m: m['images']['doska-api']['labels'].update({'pl.module.role': 'web'}),
            lambda m: m['images']['doska-api']['labels'].update({'org.opencontainers.image.version': 'latest'}),
            lambda m: m['images']['forms-engine']['labels'].update({'org.opencontainers.image.version': '0.2.0'}),
            lambda m: m['images']['forms-keydb']['labels'].pop('pl.upstream.version'),
        )
        for mutate in mutations:
            value = self.manifest()
            mutate(value)
            with self.assertRaises(ValueError):
                bootstrap.validate_bundled_images(value)

    def test_both_installers_require_controllers_and_file_primitives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            names = bootstrap.REQUIRED | {'module-controller.py', 'xray-controller.py', 'alertmanager-controller.py', 'forms-controller.py', 'doska-controller.py'}
            def write(value, selected):
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
                archive = write(self.manifest(), names)
                bootstrap.manifest(root)
                wrapper.verify_package(archive, 'amd64')
                for missing in ('forms-controller.py', 'doska-controller.py', 'xray-controller.py', 'module-controller.py'):
                    archive = write(self.manifest(), names - {missing})
                    with self.assertRaises(ValueError):
                        bootstrap.manifest(root)
                    with self.assertRaises(wrapper.InstallError):
                        wrapper.verify_package(archive, 'amd64')

    def test_source_export_is_tracked_opt_in_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            portal = package.EXACT | {'frontend/package-lock.json'} | {package.APPLICATION_RECIPES[name] for name in ("forms", "doska")} | {package.APPLICATION_METADATA[name] for name in ("forms", "doska")}
            included = package.FORMS_REQUIRED | package.DOSKA_REQUIRED | {
                'apps/doska/apps/api/src/config/index.ts', 'apps/doska/apps/api/drizzle/0000_init.sql',
                'apps/doska/apps/api/drizzle/meta/_journal.json', 'apps/doska/packages/permissions/src/index.ts',
                'apps/doska/apps/web/public/doska-theme-init.js', 'apps/doska/apps/web/public/site.webmanifest'}
            excluded = {'apps/forms/.env', 'apps/forms/state/forms.sqlite3', 'apps/forms/backups/old.py',
                        'apps/forms/private/credentials.json', 'apps/forms/unrelated.py',
                        'apps/doska/config/runtime.json', 'apps/doska/apps/api/src/private/key.ts',
                        'apps/doska/apps/api/src/credentials/token.json', 'apps/doska/apps/api/src/history/old.ts',
                        'apps/doska/node_modules/pkg/index.js', 'apps/doska/apps/web/dist/index.html',
                        'apps/doska/.git/config', 'apps/doska/compose.yaml'}
            for name in {*(package.PREFIX + name for name in portal), *included, *excluded}:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            untracked = root / 'apps/doska/apps/api/src/untracked.ts'
            untracked.write_text('untracked')
            def tracked(args):
                prefix = args[-1]
                names = {package.PREFIX + name for name in portal} if prefix == package.PREFIX else {name for name in included | excluded if name.startswith(prefix)}
                return '\0'.join(sorted(names)) + '\0'
            with patch.object(package, 'ROOT', root), patch.object(package, 'run', side_effect=tracked):
                package.source_context(root / 'base.tar.gz')
                package.source_context(root / 'one.tar.gz', with_forms=True, with_doska=True)
                package.source_context(root / 'two.tar.gz', with_forms=True, with_doska=True)
            with tarfile.open(root / 'base.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), package.EXACT | {'frontend/package-lock.json'})
            with tarfile.open(root / 'one.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), portal | included)
            self.assertEqual(package.sha(root / 'one.tar.gz'), package.sha(root / 'two.tar.gz'))


if __name__ == '__main__':
    unittest.main()
