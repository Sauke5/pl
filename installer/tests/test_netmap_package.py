"""Build-context regression for the complete owned network-stack startup files."""
import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pl_netmap_package', BASE / 'package.py')
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)
PORTAL = BASE.parent / package.PREFIX


class NetMapPackageTests(unittest.TestCase):
    def test_runtime_scripts_are_exactly_allowlisted(self):
        expected = {'apps/netmap-stack/' + name for name in (
            'cache-start.sh', 'gateway.py', 'gitea-start.sh', 'known-hosts-source.rb', 'netbox-bootstrap.py',
            'netbox-extra.py', 'netbox-start.sh', 'oxidized-start.rb', 'service.py')}
        self.assertEqual(package.NETMAP_STACK_REQUIRED, expected)
        for name in expected:
            self.assertTrue(package.application_source_allowed('netmap', name), name)
        for name in ('apps/netmap-stack/unrelated.sh', 'apps/netmap-stack/private.rb', 'apps/netmap-stack/runtime/service.py',
                     'apps/netmap-stack/.env', 'apps/netmap-stack/service.py.bak', 'apps/netmap-stack/../netmap/app.py'):
            self.assertFalse(package.application_source_allowed('netmap', name), name)

    def test_export_contains_every_required_native_startup_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            portal = package.EXACT | {'frontend/package-lock.json', package.APPLICATION_RECIPES['netmap'], package.APPLICATION_METADATA['netmap']}
            app = package.APPLICATION_REQUIRED['netmap']
            excluded = {'apps/netmap-stack/unrelated.sh', 'apps/netmap-stack/private.rb'}
            for name in {*(package.PREFIX + name for name in portal), *app, *excluded}:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((PORTAL / name.removeprefix(package.PREFIX)).read_bytes()
                                 if name in {package.PREFIX + package.APPLICATION_RECIPES['netmap'], package.PREFIX + package.APPLICATION_METADATA['netmap']}
                                 else b'fixture')

            def tracked(args):
                prefixes = args[3:]
                names = {*(package.PREFIX + name for name in portal), *app, *excluded}
                return '\0'.join(sorted(name for name in names if name.startswith(tuple(prefixes)))) + '\0'

            with patch.object(package, 'ROOT', root), patch.object(package, 'run', side_effect=tracked):
                target = root / 'context.tar.gz'
                package.source_context(target, with_netmap=True)
                with tarfile.open(target) as archive:
                    self.assertEqual(set(archive.getnames()), portal | app)
                (root / 'apps/netmap-stack/cache-start.sh').unlink()
                with self.assertRaises(ValueError):
                    package.source_context(root / 'missing.tar.gz', with_netmap=True)


if __name__ == '__main__':
    unittest.main()
