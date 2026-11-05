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
spec = importlib.util.spec_from_file_location("pl_package", BASE / "package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def test_bundle_compression_preserves_verified_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / 'images.tar'
            payload.write_bytes(b'owned release image payload\n' * 32768)
            manifest = {'files': {'images.tar': package.sha(payload)}}
            archives = []
            for name, level in (('fast', 1), ('small', 9), ('default', None)):
                target = root / (name + '.tar.gz')
                kwargs = {} if level is None else {'compression_level': level}
                package.write_package_archive(target, manifest, {'images.tar': payload}, **kwargs)
                with tarfile.open(target, 'r:gz') as archive:
                    self.assertEqual(archive.getnames(), ['manifest.json', 'images.tar'])
                    self.assertEqual(json.load(archive.extractfile('manifest.json')), manifest)
                    self.assertEqual(archive.extractfile('images.tar').read(), payload.read_bytes())
                # RFC 1952 XFL distinguishes the actual fastest/max compression.
                self.assertEqual(target.read_bytes()[8], 4 if level == 1 else 2)
                archives.append(target)
            self.assertGreater(archives[0].stat().st_size, archives[1].stat().st_size)

    def test_bundle_compression_rejects_invalid_values_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'bundle.tar.gz'
            for level in (0, 10, -1, True, None, '1'):
                with self.subTest(level=level), self.assertRaises(ValueError):
                    package.write_package_archive(target, {}, {}, compression_level=level)
                self.assertFalse(target.exists())
            target.write_bytes(b'preserve existing artifact')
            with self.assertRaises(FileExistsError):
                package.write_package_archive(target, {}, {}, compression_level=1)
            self.assertEqual(target.read_bytes(), b'preserve existing artifact')

    def test_build_cli_compression_default_and_explicit_validation(self):
        argv = ['package.py', 'build', '--source-archive', 'unused.tar', '--version', 'fixture', '--output', 'unused-out.tar.gz']
        for options, expected in (([], 9), (['--compression-level', '1'], 1), (['--compression-level', '9'], 9)):
            with patch('sys.argv', argv + options), patch.object(package, 'build') as build:
                self.assertEqual(package.main(), 0)
                self.assertEqual(build.call_args.args[0].compression_level, expected)
        for value in ('0', '10', '1.5', 'invalid'):
            with patch('sys.argv', argv + ['--compression-level', value]), patch('sys.stderr', new=io.StringIO()), patch.object(package, 'build') as build:
                with self.assertRaises(SystemExit) as failure:
                    package.main()
                self.assertEqual(failure.exception.code, 2)
                build.assert_not_called()

    def test_old_source_archive_cannot_claim_connector_credential_feature(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'old-source.tar'
            with tarfile.open(source, 'w') as archive:
                for name in package.CONNECTOR_SOURCES - {'db/migrations/014_integration_credentials.sql'}:
                    member = tarfile.TarInfo(name)
                    member.size = len(b'fixture')
                    archive.addfile(member, io.BytesIO(b'fixture'))
            args = types.SimpleNamespace(source_archive=source, output=root / 'candidate.tar', version='fixture')
            with patch.object(package, 'engine'), patch.object(package.subprocess, 'run') as build:
                with self.assertRaisesRegex(ValueError, 'complete source and schema'):
                    package.build(args)
                build.assert_not_called()
            self.assertFalse(args.output.exists())

    def test_source_selection_excludes_runtime_deployment_and_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            included = package.EXACT | {"cmd/portal/main.go", "internal/server/local_auth.go",
                                        "internal/connectorcredentials/codec.go", "internal/store/integration_credentials.go", "db/migrations/014_integration_credentials.sql",
                                        "frontend/package-lock.json", "frontend/src/App.tsx"}
            excluded = {"deploy/secrets/key", "credentials/password", ".env", "docs/private.md",
                        "frontend/.env", "frontend/node_modules/x/index.js", "frontend/dist/app.js", "private/integration-credential-key"}
            names = included | excluded
            for name in names:
                p = root / package.PREFIX / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("fixture")
            listed = "\0".join(package.PREFIX + name for name in names) + "\0"
            with patch.object(package, "ROOT", root), patch.object(package, "run", return_value=listed):
                package.source_context(root / "one.tar.gz")
                package.source_context(root / "two.tar.gz")
            self.assertEqual(package.sha(root / "one.tar.gz"), package.sha(root / "two.tar.gz"))
            with tarfile.open(root / "one.tar.gz") as archive:
                self.assertEqual(set(archive.getnames()), included)

    def test_remote_engine_rejected_without_build(self):
        with patch.dict(package.os.environ, {"DOCKER_HOST": "ssh://other-host"}), self.assertRaises(ValueError):
            package.engine()

    def test_runtime_files_and_private_keys_are_blocked_even_under_source_tree(self):
        for name in ("internal/server/state/data.db", "internal/server/backups/old.go", "frontend/src/debug.log", "internal/key.pem"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                package.audit_source_file(name, b"fixture")
        with self.assertRaises(ValueError):
            package.audit_source_file("internal/config.go", b"-----BEGIN PRIVATE KEY-----")
        package.audit_source_file("db/migrations/001_init.sql", b"CREATE TABLE documents(id text);")


if __name__ == "__main__":
    unittest.main()
