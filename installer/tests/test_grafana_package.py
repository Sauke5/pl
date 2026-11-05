"""Optional Grafana packaging preserves older package admission."""
import copy
import importlib.util
import json
import tempfile
import tarfile
import types
from unittest.mock import patch
from pathlib import Path
import unittest

BASE = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

bootstrap = load('pl_grafana_bootstrap', BASE / 'bootstrap.py')
package = load('pl_grafana_package', BASE / 'package.py')


def legacy_custom_metadata():
    # Explicit public historical contract; it never reads today's official default.
    revision = 'af4a33e3786594ad72f72d97e6744010330c2977'
    return {
        'schema': 1, 'version': '13.2.4', 'go_version': '1.27.2',
        'upstream_image': 'grafana/grafana:13.2.4@sha256:dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f',
        'source': {'revision': revision, 'url': 'https://codeload.github.com/grafana/grafana/tar.gz/' + revision,
                   'sha256': '60eed311bdf954198742a2a73f86d305c10a71f7a932b3e4f94ceaf566989ee3'},
        'labels': {'pl.module.id': 'grafana', 'pl.module.config.version': '1', 'pl.build.variant': 'source-build-pl-signed',
                   'pl.build.go': '1.27.2', 'org.opencontainers.image.version': '13.2.4',
                   'org.opencontainers.image.revision': revision, 'org.opencontainers.image.source': 'https://github.com/grafana/grafana',
                   'org.opencontainers.image.licenses': 'AGPL-3.0-only'},
    }


class GrafanaPackageTests(unittest.TestCase):
    def manifest(self, enabled=True):
        source = 'a' * 64
        labels = {'api': {}, 'web': {}, **package.IMAGE_SOURCES}
        images = {name: {'id': 'sha256:' + str(n) * 64, 'architecture': 'amd64',
                         'ref': 'pl/core-' + name + ':fixture', 'recipe': package.RECIPES.get(name, 'Dockerfile'),
                         'labels': {'pl.source.sha256': source, **label}}
                  for n, (name, label) in enumerate(labels.items(), 1)}
        result = {'schema': 2, 'product': 'Pl', 'version': 'fixture', 'architecture': 'amd64', 'source_sha256': source,
                  'features': {'local_users': True, 'module_controller': True}, 'images': images,
                  'database': {'major': 18, 'version': '18.6', 'volume_target': '/var/lib/postgresql', 'pgdata': '/var/lib/postgresql/18/docker'}}
        if enabled:
            metadata = json.loads((BASE.parent / 'monitoring/source/it-portal/deploy/images/grafana.sources.json').read_text())
            result['features']['grafana_module'] = True
            images['grafana'] = {'id': 'sha256:' + '8' * 64, 'architecture': 'amd64', 'ref': 'pl/core-grafana:fixture',
                                 'recipe': 'deploy/images/grafana.Dockerfile', 'labels': {'pl.source.sha256': source, **metadata['labels']}}
        return result

    def test_old_four_images_and_optional_grafana_are_admitted(self):
        bootstrap.validate_bundled_images(self.manifest(False))
        bootstrap.validate_bundled_images(self.manifest())

    def test_feature_image_role_and_identity_must_match(self):
        for mutate in (lambda m: m['features'].pop('grafana_module'), lambda m: m['images'].pop('grafana'),
                       lambda m: m['images']['grafana'].update(recipe='Dockerfile'),
                       lambda m: m['images']['grafana']['labels'].update({'org.opencontainers.image.source': 'https://other.invalid'}),
                       lambda m: m['images']['grafana']['labels'].update({'pl.source.sha256': 'b' * 64}),
                       lambda m: m['images']['grafana']['labels'].update({'pl.build.variant': 'floating'})):
            value = copy.deepcopy(self.manifest())
            mutate(value)
            with self.assertRaises(ValueError):
                bootstrap.validate_bundled_images(value)

    def test_recipe_pins_official_oss_and_metadata_matches(self):
        directory = BASE.parent / 'monitoring/source/it-portal/deploy/images'
        metadata = json.loads((directory / 'grafana.sources.json').read_text())
        recipe = (directory / 'grafana.Dockerfile').read_text()
        self.assertRegex(metadata['upstream_image'], r'^grafana/grafana:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$')
        self.assertIn('FROM ' + metadata['upstream_image'], recipe)
        self.assertNotIn(':latest', recipe)
        self.assertEqual(metadata['source']['revision'], metadata['labels']['org.opencontainers.image.revision'])
        self.assertNotIn('deploy/images/grafana.Dockerfile', package.EXACT)
        self.assertEqual(package.GRAFANA_EXACT, {'deploy/images/grafana.Dockerfile', 'deploy/images/grafana.sources.json'})
        self.assertIn('installer/grafana-signing/main.go', package.GRAFANA_BUILD_FILES)
        self.assertIn('installer/grafana-plugins.json', package.GRAFANA_BUILD_FILES)
        self.assertEqual(metadata['labels']['pl.build.variant'], 'upstream-pinned')
        self.assertNotIn('pl.build.go', metadata['labels'])
        self.assertNotIn('signing', metadata)
        self.assertNotIn('url', metadata['source'])
        self.assertNotIn('sha256', metadata['source'])
        self.assertEqual(metadata['verification']['native_version'], metadata['version'])
        self.assertEqual(metadata['verification']['native_commit'], metadata['source']['revision'])
        for forbidden in ('RUN ', 'COPY ', 'ADD ', 'pl-grafana-signing-key', 'PL_SIGNING_FINGERPRINT', 'grafana-trust.patch', 'allow_loading_unsigned_plugins'):
            self.assertNotIn(forbidden, recipe)
        self.assertIn('USER 472:0', recipe)

    def test_official_source_context_excludes_all_custom_build_and_signing_tools(self):
        directory = BASE.parent / 'monitoring/source/it-portal/deploy/images'
        metadata = (directory / 'grafana.sources.json').read_bytes()
        recipe = (directory / 'grafana.Dockerfile').read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            included = package.EXACT | package.GRAFANA_EXACT | {'frontend/package-lock.json', 'cmd/portal/main.go'}
            for name in included:
                path = root / package.PREFIX / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(metadata if name.endswith('grafana.sources.json') else recipe if name.endswith('grafana.Dockerfile') else b'fixture')
            for name in package.GRAFANA_BUILD_FILES:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('historical tooling must stay outside the official context')
            listed = '\0'.join([package.PREFIX + name for name in sorted(included)] + sorted(package.GRAFANA_BUILD_FILES)) + '\0'
            with patch.object(package, 'ROOT', root), patch.object(package, 'run', return_value=listed):
                package.source_context(root / 'source.tar.gz', with_grafana=True)
            with tarfile.open(root / 'source.tar.gz') as archive:
                self.assertEqual(set(archive.getnames()), included)
                self.assertFalse(set(archive.getnames()) & package.GRAFANA_BUILD_FILES)

    def test_official_build_does_not_require_or_forward_a_signing_secret(self):
        metadata = package.grafana_metadata(BASE.parent / package.PREFIX)
        args = types.SimpleNamespace(grafana_signing_key_file=Path('/not-a-key'), grafana_signing_fingerprint='ignored')
        self.assertEqual(package.grafana_build_arguments(metadata, args, BASE), [])
        self.assertEqual(package.grafana_build_arguments(metadata, types.SimpleNamespace(), BASE), [])

    def test_official_metadata_requires_version_digest_and_source_identity(self):
        original = package.grafana_metadata(BASE.parent / package.PREFIX)
        for change in (lambda m: m.update(upstream_image='grafana/grafana:latest'),
                       lambda m: m.update(upstream_image=m['upstream_image'].replace(m['version'], '0.0.0')),
                       lambda m: m['labels'].update({'pl.build.variant': 'floating'}),
                       lambda m: m['labels'].update({'pl.build.go': '1.27.2'}),
                       lambda m: m['source'].update(revision='0' * 40),
                       lambda m: m['labels'].update({'org.opencontainers.image.source': 'https://other.invalid'})):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                path = root / 'deploy/images/grafana.sources.json'
                path.parent.mkdir(parents=True)
                metadata = copy.deepcopy(original)
                change(metadata)
                path.write_text(json.dumps(metadata))
                with self.assertRaises(ValueError):
                    package.grafana_metadata(root)

    def test_historical_custom_metadata_still_requires_explicit_signing_key(self):
        metadata = legacy_custom_metadata()
        with self.assertRaises(ValueError):
            package.grafana_build_arguments(metadata, types.SimpleNamespace(), BASE)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            key = root / 'key'
            key.write_bytes(b'private-test-fixture')
            key.chmod(0o600)
            fingerprint = 'a' * 40
            args = types.SimpleNamespace(grafana_signing_key_file=key, grafana_signing_fingerprint=fingerprint)
            self.assertEqual(package.grafana_build_arguments(metadata, args, root / 'context'), [
                '--secret', 'id=pl-grafana-signing-key,src=' + str(key), '--build-arg', 'PL_SIGNING_FINGERPRINT=' + fingerprint])

    def test_custom_archive_and_toolchain_constraints_use_an_explicit_legacy_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            context = Path(temp)
            path = context / 'deploy/images/grafana.sources.json'
            path.parent.mkdir(parents=True)
            original = legacy_custom_metadata()
            path.write_text(json.dumps(original))
            self.assertEqual(package.grafana_metadata(context), original)
            for change in (lambda m: m.pop('go_version'), lambda m: m['source'].pop('sha256'),
                           lambda m: m['source'].update(url='https://codeload.github.com/grafana/grafana/tar.gz/main')):
                metadata = copy.deepcopy(original)
                change(metadata)
                path.write_text(json.dumps(metadata))
                with self.assertRaises(ValueError):
                    package.grafana_metadata(context)

    def test_private_pgp_key_material_is_rejected_by_source_audit(self):
        with self.assertRaises(ValueError):
            package.audit_source_file('public.txt', b'-----BEGIN ' + b'PGP PRIVATE KEY BLOCK-----\nfixture')


if __name__ == '__main__':
    unittest.main()
