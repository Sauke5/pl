"""Xray manifest extension preserves old packages and fails closed on drift."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('bootstrap_xray_bundle', Path(__file__).resolve().parents[1] / 'bootstrap.py')
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)
import test_bootstrap as baseline


class XrayBundleTests(unittest.TestCase):
    def bundled(self):
        # Reuse the accepted schema-2 baseline without requiring root or Docker.
        m = baseline.BootstrapTests.bundled(self)
        m['features']['xray_module'] = True
        m['images']['xray'] = {
            'id': 'sha256:' + '5' * 64, 'architecture': 'amd64',
            'ref': 'pl/core-xray:test', 'recipe': 'deploy/images/xray.Dockerfile',
            'labels': {'pl.source.sha256': m['source_sha256'], 'pl.module.id': 'xray',
                       'pl.module.config.version': '1', 'org.opencontainers.image.version': '26.3.27',
                       'pl.build.go': '1.27.2', 'pl.build.variant': 'source-build',
                       'org.opencontainers.image.revision': 'd' * 40,
                       'org.opencontainers.image.source': 'https://github.com/XTLS/Xray-core',
                       'org.opencontainers.image.licenses': 'MPL-2.0'}}
        return m

    def test_xray_version_is_metadata_and_image_is_required(self):
        m = self.bundled()
        pl.validate_bundled_images(m)
        m['images']['xray']['labels']['org.opencontainers.image.version'] = '27.1.1'
        pl.validate_bundled_images(m)
        del m['images']['xray']
        with self.assertRaises(ValueError):
            pl.validate_bundled_images(m)

    def test_rejects_unscoped_or_unbound_xray_image(self):
        for mutation in (
            lambda m: m['features'].pop('xray_module'),
            lambda m: m['images']['xray'].update(recipe='Dockerfile'),
            lambda m: m['images']['xray'].update(architecture='arm64'),
            lambda m: m['images']['xray']['labels'].update({'pl.source.sha256': 'b' * 64}),
            lambda m: m['images']['xray']['labels'].update({'org.opencontainers.image.version': 'latest'}),
            lambda m: m['images']['xray']['labels'].update({'pl.module.id': 'prometheus'}),
        ):
            m = self.bundled()
            mutation(m)
            with self.assertRaises(ValueError):
                pl.validate_bundled_images(m)

    def test_loads_xray_without_registry_pull(self):
        m = self.bundled()
        rt = pl.Runtime(Path('/tmp/pl-xray-test'), Path('/tmp/pl-xray-package'), m)
        calls = []
        import json
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ('image', 'load'):
                return b'loaded'
            image = next(v for v in m['images'].values() if v['id'] == args[2])
            return json.dumps([{'Id': image['id'], 'Architecture': image['architecture'],
                                'Os': 'linux', 'Config': {'Labels': image['labels']}}]).encode()
        rt.docker = docker
        rt.images()
        self.assertEqual(len(calls), 6)
        self.assertFalse(any(args[0] == 'pull' for args in calls))
