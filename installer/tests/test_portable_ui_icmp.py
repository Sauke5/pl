import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


bootstrap = load('pl_ui_icmp_bootstrap', 'bootstrap.py')
package = load('pl_ui_icmp_package', 'package.py')


class PortableUIICMPTests(unittest.TestCase):
    def test_icmp_networks_are_explicit_canonical_and_bounded(self):
        self.assertEqual(bootstrap.icmp_cidrs(None), [])
        self.assertEqual(bootstrap.icmp_cidrs(['192.0.2.0/24'] * 2), ['192.0.2.0/24'])
        self.assertEqual(len(bootstrap.icmp_cidrs([f'10.0.{n}.0/24' for n in range(64)])), 64)
        for values in (['192.0.2.1/24'], ['::/0'], [''], [' 192.0.2.0/24'], ['192.0.2.0/24'] * 65):
            with self.subTest(values=values[:2]), self.assertRaises(ValueError):
                bootstrap.icmp_cidrs(values)
        cfg = bootstrap.configuration('https://pl.example', '127.0.0.1', 'admin')
        self.assertNotIn('icmp_allowed_cidrs', cfg)

    def test_icmp_uses_read_only_unix_mount_and_no_api_capabilities(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / '.pl-installation.json').write_text(json.dumps({'product': 'Pl', 'gid': 987}))
            manifest = {'features': {'icmp_probe': True}, 'images': {
                'api': {'id': 'sha256:' + '1' * 64}, 'web': {'id': 'sha256:' + '2' * 64},
                'db': {'ref': 'postgres:18@sha256:' + '3' * 64}}}
            cfg = bootstrap.configuration('https://pl.example', '127.0.0.1', 'admin',
                                          allowed_icmp_cidrs=['192.0.2.0/24'])
            model = bootstrap.compose_model(root, manifest, cfg, 'pl-0123456789ab')
            api = model['services']['api']
            self.assertEqual(api['cap_drop'], ['ALL'])
            self.assertEqual(api['security_opt'], ['no-new-privileges:true'])
            self.assertNotIn('ports', api)
            self.assertEqual(api['group_add'], ['987'])
            self.assertEqual(api['environment']['PORTAL_ICMP_ALLOWED_CIDRS'], '192.0.2.0/24')
            self.assertEqual(api['environment']['PORTAL_ICMP_EXECUTOR_URL'], 'unix:///run/pl-icmp-probe/probe.sock')
            mount = next(m for m in api['volumes'] if isinstance(m, dict) and m['target'] == '/run/pl-icmp-probe')
            self.assertTrue(mount['read_only'])
            self.assertFalse(mount['bind']['create_host_path'])
            self.assertNotIn('docker.sock', json.dumps(model))

    def test_shared_ui_vendor_is_explicit_in_both_consumer_contexts(self):
        self.assertTrue(package.wayline_source_allowed('apps/wayline/web/vendor/pl-ui-1.0.2-pl.1.tgz'))
        self.assertTrue(package.application_source_allowed('doska', 'apps/doska/apps/web/vendor/pl-ui-1.0.2-pl.1.tgz'))
        for name in ('credentials.tgz', '.env', 'other-ui-1.tgz'):
            self.assertFalse(package.wayline_source_allowed('apps/wayline/web/vendor/' + name))
            self.assertFalse(package.application_source_allowed('doska', 'apps/doska/apps/web/vendor/' + name))

    def test_netmap_runtime_context_excludes_test_fixtures(self):
        for name in ('apps/netmap/tests_app.py', 'apps/netmap/web/test-office-view.cjs',
                     'apps/netmap/web/shared-shell.test.mjs', 'apps/netmap/tests/fixture.json'):
            self.assertFalse(package.application_source_allowed('netmap', name), name)
        for name in ('apps/netmap/app.py', 'apps/netmap/web/app.js',
                     'apps/netmap/web/vendor/elkjs/LICENSE.md'):
            self.assertTrue(package.application_source_allowed('netmap', name), name)

    def test_helper_removal_checks_installed_package_before_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / 'state').mkdir()
            release = root / 'releases/fixture'
            release.mkdir(parents=True)
            (release / 'manifest.json').write_text('{}')
            for version in ('../foreign', 'fixture'):
                (root / 'state/installation.json').write_text(json.dumps({
                    'version': version, 'manifest_sha256': '0' * 64}))
                with self.subTest(version=version), patch.object(bootstrap.sys, 'platform', 'linux'), \
                        patch.object(bootstrap.os, 'geteuid', return_value=0), \
                        patch.object(bootstrap, 'managed_root'), patch.object(bootstrap, 'icmp_installer') as loader:
                    with self.assertRaises(ValueError):
                        bootstrap.remove_icmp_helper(root)
                    loader.assert_not_called()

    def test_helper_removal_uses_matching_installation_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / 'state').mkdir()
            release = root / 'releases/fixture'
            release.mkdir(parents=True)
            (release / 'manifest.json').write_text('{}')
            identifier = 'pl-123456abcdef'
            (root / 'state/installation.json').write_text(json.dumps({'version': 'fixture',
                'manifest_sha256': bootstrap.digest(release / 'manifest.json'), 'install_id': identifier}))
            helper, runtime = Mock(), Mock()
            with patch.object(bootstrap.sys, 'platform', 'linux'), patch.object(bootstrap.os, 'geteuid', return_value=0), \
                    patch.object(bootstrap, 'managed_root'), \
                    patch.object(bootstrap, 'manifest', return_value={'features': {'icmp_probe': True}}), \
                    patch.object(bootstrap, 'Runtime', return_value=runtime), \
                    patch.object(bootstrap, 'icmp_installer', return_value=helper) as loader:
                bootstrap.remove_icmp_helper(root)
            loader.assert_called_once_with(release)
            helper.remove.assert_called_once_with(root, identifier, runtime.run)

    @staticmethod
    def vendor(body, *, name='package/core.js', kind=tarfile.REGTYPE):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(body) if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(body))
        return output.getvalue()

    def test_vendor_payload_cannot_hide_private_material(self):
        name = 'apps/wayline/web/vendor/pl-ui-1.0.2-pl.1.tgz'
        with self.assertRaisesRegex(ValueError, 'Private key'):
            package.audit_source_file(name, self.vendor(b'-----BEGIN PRIVATE KEY-----'))
        with self.assertRaises(ValueError):
            package.audit_source_file(name, self.vendor(b'', name='package/../../escape'))
        with self.assertRaises(ValueError):
            package.audit_source_file(name, self.vendor(b'', kind=tarfile.SYMTYPE))

    def test_neutral_source_audit_preserves_integrity_bytes(self):
        body = b'{"name":"@pl/ui","integrity":"sha512-gmPSkl5randomDigestValue"}'
        digest = hashlib.sha256(body).hexdigest()
        package.audit_source_file('frontend/package-lock.json', body)
        self.assertEqual(hashlib.sha256(body).hexdigest(), digest)
        package.audit_source_file('internal/crypto.go', b'const cipher = "TLS_PSK"')

    def test_neutral_source_audit_rejects_previous_organization_namespace(self):
        for body in (b'import "psk/portal/internal/model"', b'window.PSKTheme',
                     b'@psk/ui', b'X-PSK-Gateway-Assertion', b'psk-portal-backend',
                     'АО ПСК'.encode()):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, 'Organization-specific'):
                package.audit_source_file('frontend/src/example.ts', body)
        with self.assertRaisesRegex(ValueError, 'Organization-specific'):
            package.audit_source_file('vendor/pl-ui-1.tgz', self.vendor(b'window.PSKUI'))


if __name__ == '__main__':
    unittest.main()
