"""Real package admission through the public shell installer's Python boundary."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'install.sh'
SOURCE = SCRIPT.read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]


class NetworkStackInstallTests(unittest.TestCase):
    def setUp(self):
        self.wrapper = types.ModuleType('pl_stack_install_test')
        exec(compile(SOURCE, str(SCRIPT), 'exec'), self.wrapper.__dict__)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'package.tar'

    def package(self, modules=(), missing=None, schema=2, module_controller=True):
        files = {name: b'fixture' for name in ('bootstrap.py', 'images.tar', 'nginx.conf', 'LICENSES.txt')}
        features = {'local_users': True}
        if modules:
            features['module_controller'] = module_controller
            files.update({name: b'fixture' for name in ('module-controller.py', 'xray-controller.py', 'module-network.py')})
        for module in modules:
            features[module + '_module'] = True
            files[module + '-controller.py'] = b'fixture'
        files.pop(missing, None)
        manifest = {'schema': schema, 'product': 'Pl', 'version': 'fixture', 'architecture': 'amd64',
                    'features': features, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        files['manifest.json'] = json.dumps(manifest).encode()
        with tarfile.open(self.path, 'w') as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return self.path

    def test_core_and_optional_native_packages_are_admitted_without_host_changes(self):
        for modules in ((), ('netmap',), ('bookstack',), ('netmap', 'bookstack')):
            with self.subTest(modules=modules):
                value = self.wrapper.verify_package(self.package(modules), 'amd64')
                for module in modules:
                    self.assertTrue(value['features'][module + '_module'])
        self.wrapper.verify_package(self.package(schema=1), 'amd64')

    def test_declared_native_modules_require_complete_trusted_payload(self):
        for module in ('netmap', 'bookstack'):
            for missing in (module + '-controller.py', 'xray-controller.py', 'module-controller.py', 'module-network.py'):
                with self.subTest(module=module, missing=missing), self.assertRaises(self.wrapper.InstallError):
                    self.wrapper.verify_package(self.package((module,), missing=missing), 'amd64')
            for settings in ({'schema': 1}, {'module_controller': False}):
                with self.subTest(module=module, settings=settings), self.assertRaises(self.wrapper.InstallError):
                    self.wrapper.verify_package(self.package((module,), **settings), 'amd64')


if __name__ == '__main__':
    unittest.main()
