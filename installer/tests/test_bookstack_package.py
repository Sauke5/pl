"""Wiki image/source/package admission regressions; run only in authorized CI."""
import copy
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tarfile
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load('pl_bookstack_package', BASE / 'package.py')
bootstrap = load('pl_bookstack_bootstrap', BASE / 'bootstrap.py')
PORTAL = BASE.parent / package.PREFIX
RECIPE = 'deploy/images/bookstack.Dockerfile'
METADATA = 'deploy/images/bookstack.sources.json'
ADMIN_BOOTSTRAP = 'apps/wiki/bootstrap-admin.php'


class BookStackPackageTests(unittest.TestCase):
    def test_browser_decimal_limit_matches_php_binary_100_mib(self):
        recipe = (PORTAL / RECIPE).read_text()
        limit = re.search(r'^ENV FILE_UPLOAD_SIZE_LIMIT=([0-9.]+)\s', recipe, re.M)
        self.assertIsNotNone(limit)
        browser_bytes = Decimal(limit.group(1)) * 1_000_000
        self.assertEqual(browser_bytes, 100 * 1024 * 1024)
        self.assertIn('upload_max_filesize=100M', recipe)
        self.assertIn('post_max_size=101M', recipe)

    def manifest(self, include=True):
        labels = {'api': {}, 'web': {}, **copy.deepcopy(package.IMAGE_SOURCES)}
        recipes = dict(package.RECIPES)
        features = {'local_users': True, 'module_controller': True, 'xray_module': True, 'alertmanager_module': True}
        for module in ('xray', 'alertmanager'):
            labels[module] = json.loads((PORTAL / ('deploy/images/' + module + '.sources.json')).read_text())['labels']
        if include:
            metadata = package.application_metadata(PORTAL, 'bookstack')
            features['bookstack_module'] = True
            for name, image in metadata['images'].items():
                labels[name] = image['labels']
                recipes[name] = RECIPE
        source = 'a' * 64
        images = {name: {'id': 'sha256:' + hashlib.sha256(name.encode()).hexdigest(), 'architecture': 'amd64',
                        'ref': 'pl/core-' + name + ':fixture', 'recipe': recipes.get(name, 'Dockerfile'),
                        'labels': {'pl.source.sha256': source, **value}} for name, value in labels.items()}
        return {'schema': 2, 'product': 'Pl', 'version': 'fixture', 'architecture': 'amd64', 'source_sha256': source,
                'features': features, 'images': images, 'database': {'major': 18, 'version': '18.6',
                    'volume_target': '/var/lib/postgresql', 'pgdata': '/var/lib/postgresql/18/docker'}}

    def metadata_fixture(self, root, value):
        path = root / METADATA
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def test_both_native_roles_are_pinned_and_dockerfile_matches_provenance(self):
        self.assertEqual(package.APPLICATION_ROLES['bookstack'], ('web', 'database'))
        self.assertEqual(set(package.APPLICATION_UPSTREAM_ROLES['bookstack']), {'web', 'database'})
        value = package.application_metadata(PORTAL, 'bookstack')
        self.assertEqual(set(value['images']), {'bookstack-web', 'bookstack-database'})
        recipe = (PORTAL / RECIPE).read_text()
        stages = dict((role, image) for image, role in re.findall(r'^FROM ([^\s]+) AS (web|database)$', recipe, re.M))
        self.assertEqual(set(stages), {'web', 'database'})
        for role, native in (('web', '26.09.2'), ('database', '13.0.2')):
            labels = value['images']['bookstack-' + role]['labels']
            self.assertEqual(labels['pl.build.variant'], 'upstream-pinned')
            self.assertEqual(labels['org.opencontainers.image.version'], '26.09.2')
            self.assertEqual(labels['pl.upstream.version'], native)
            self.assertEqual(value['images']['bookstack-' + role]['target'], role)
            self.assertRegex(stages[role], r'@sha256:[0-9a-f]{64}$')
            self.assertEqual(stages[role], value['containers'][role]['image'])
        self.assertIn('COPY ' + ADMIN_BOOTSTRAP, recipe)
        self.assertNotIn('docker pull', recipe)

    def test_metadata_rejects_missing_role_wrong_target_and_missing_upstream_versions(self):
        original = json.loads((PORTAL / METADATA).read_text())
        mutations = [
            lambda value: value['images'].pop('bookstack-web'),
            lambda value: value['images'].pop('bookstack-database'),
            lambda value: value['images']['bookstack-web'].update(target='database'),
            lambda value: value['images']['bookstack-database']['labels'].update({'pl.module.role': 'web'}),
            lambda value: value['images']['bookstack-web']['labels'].pop('pl.upstream.version'),
            lambda value: value['images']['bookstack-database']['labels'].pop('pl.upstream.version'),
            lambda value: value['images']['bookstack-web']['labels'].update({'pl.build.variant': 'source-build'}),
            lambda value: value['images']['bookstack-database']['labels'].update({'pl.upstream.version': 'latest'}),
            lambda value: value['images']['bookstack-database']['labels'].update({'org.opencontainers.image.version': '13.0.2'}),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises((ValueError, FileNotFoundError)):
                package.application_metadata(root, 'bookstack')
            for index, mutate in enumerate(mutations):
                with self.subTest(mutation=index):
                    value = copy.deepcopy(original)
                    mutate(value)
                    self.metadata_fixture(root, value)
                    with self.assertRaises(ValueError):
                        package.application_metadata(root, 'bookstack')

    def test_optional_bundle_is_admitted_and_registry_keeps_its_own_database(self):
        base = self.manifest(include=False)
        bootstrap.validate_bundled_images(base)
        value = self.manifest()
        bootstrap.validate_bundled_images(value)
        self.assertEqual(set(value['images']) - set(base['images']), {'bookstack-web', 'bookstack-database'})
        descriptor = bootstrap.module_image_descriptor(value, 'pl-fixture', 'f' * 64)
        self.assertEqual(set(descriptor['bookstack']), {'web', 'database'})
        for role in ('web', 'database'):
            self.assertEqual(descriptor['bookstack'][role], value['images']['bookstack-' + role])
        self.assertNotEqual(descriptor['bookstack']['database'], value['images']['db'])

    def test_manifest_rejects_incomplete_roles_foreign_source_or_unpinned_native_identity(self):
        mutations = [
            lambda value: value['images'].pop('bookstack-web'),
            lambda value: value['images'].pop('bookstack-database'),
            lambda value: value['features'].pop('bookstack_module'),
            lambda value: value['images']['bookstack-web'].update(architecture='arm64'),
            lambda value: value['images']['bookstack-database'].update(recipe='deploy/images/postgres.Dockerfile'),
            lambda value: value['images']['bookstack-web']['labels'].update({'pl.source.sha256': 'b' * 64}),
            lambda value: value['images']['bookstack-database']['labels'].update({'pl.module.role': 'web'}),
            lambda value: value['images']['bookstack-web']['labels'].pop('pl.upstream.version'),
            lambda value: value['images']['bookstack-database']['labels'].pop('pl.upstream.version'),
            lambda value: value['images']['bookstack-database']['labels'].update({'pl.upstream.version': 'latest'}),
            lambda value: value['images']['bookstack-web']['labels'].update({'org.opencontainers.image.version': '0.0.1'}),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                value = self.manifest()
                mutate(value)
                with self.assertRaises(ValueError):
                    bootstrap.validate_bundled_images(value)

    def test_wiki_source_allowlist_has_one_bootstrap_file_and_rejects_private_neighbors(self):
        self.assertTrue(package.application_source_allowed('bookstack', ADMIN_BOOTSTRAP))
        for name in ('apps/wiki/.env', 'apps/wiki/state/state.json', 'apps/wiki/data/mysql.db',
                     'apps/wiki/private/password', 'apps/wiki/uploads/image.php', 'apps/wiki/bootstrap-admin.php.bak',
                     'apps/wiki/unrelated.php', 'apps/bookstack/bootstrap-admin.php', 'apps/wiki/../private/admin.php'):
            with self.subTest(name=name):
                self.assertFalse(package.application_source_allowed('bookstack', name))

    def test_source_snapshot_is_opt_in_tracked_finite_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            portal = package.EXACT | {'frontend/package-lock.json', RECIPE, METADATA}
            excluded = {'apps/wiki/.env', 'apps/wiki/private/password', 'apps/wiki/uploads/image.php', 'apps/wiki/unrelated.php'}
            for name in {*(package.PREFIX + name for name in portal), ADMIN_BOOTSTRAP, *excluded}:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                if name == package.PREFIX + METADATA:
                    path.write_bytes((PORTAL / METADATA).read_bytes())
                elif name == package.PREFIX + RECIPE:
                    path.write_bytes((PORTAL / RECIPE).read_bytes())
                else:
                    path.write_text('fixture')

            def tracked(args):
                prefix = args[-1]
                names = {package.PREFIX + name for name in portal} if prefix == package.PREFIX else {
                    name for name in {ADMIN_BOOTSTRAP, *excluded} if name.startswith(prefix)}
                return '\0'.join(sorted(names)) + '\0'

            with patch.object(package, 'ROOT', root), patch.object(package, 'run', side_effect=tracked):
                package.source_context(root / 'base.tar.gz')
                package.source_context(root / 'one.tar.gz', with_bookstack=True)
                package.source_context(root / 'two.tar.gz', with_bookstack=True)
            with tarfile.open(root / 'base.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), package.EXACT | {'frontend/package-lock.json'})
            with tarfile.open(root / 'one.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), portal | {ADMIN_BOOTSTRAP})
            self.assertEqual(package.sha(root / 'one.tar.gz'), package.sha(root / 'two.tar.gz'))

    def test_missing_tracked_bootstrap_prevents_wiki_source_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            portal = package.EXACT | {'frontend/package-lock.json', RECIPE, METADATA}
            for name in portal:
                path = root / package.PREFIX / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((PORTAL / name).read_bytes() if name in (RECIPE, METADATA) else b'fixture')
            # A local untracked copy must not silently enter a redistributable snapshot.
            untracked = root / ADMIN_BOOTSTRAP
            untracked.parent.mkdir(parents=True)
            untracked.write_text('untracked fixture')

            def tracked(args):
                return '\0'.join(sorted(package.PREFIX + name for name in portal)) + '\0' if args[-1] == package.PREFIX else ''

            with patch.object(package, 'ROOT', root), patch.object(package, 'run', side_effect=tracked):
                with self.assertRaises(ValueError):
                    package.source_context(root / 'missing.tar.gz', with_bookstack=True)


if __name__ == '__main__':
    unittest.main()
