"""Production first-seed and repeat-install contracts; no host mutations."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from test_bootstrap import pl


HASH = b"$argon2id$v=19$m=65536,t=3,p=1$YXNkZmFzZGZhc2RmYXNkZg$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY\n"


class ProductionBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / "private").mkdir(mode=0o700)
        (self.root / "config").mkdir()
        self.cfg = pl.configuration("https://pl.example.test:8443", "127.0.0.1", "admin")
        self.manifest = {"schema": 1, "version": "test-production", "features": {"local_users": True},
                         "images": {"api": {"id": "sha256:" + "1" * 64}}}

    def runtime(self, root=None):
        root = root or self.root
        runtime = pl.Runtime(root, root, self.manifest)
        runtime.docker = Mock(return_value=HASH)
        return runtime

    def snapshot(self):
        return {p.name: (p.read_bytes(), p.stat().st_ino, p.stat().st_mode & 0o777)
                for p in (self.root / "private").iterdir()}

    def test_fresh_production_seeds_are_unique_private_and_stdin_only(self):
        runtimes = [self.runtime()]
        other = self.root / "other"
        (other / "private").mkdir(mode=0o700, parents=True)
        (other / "config").mkdir()
        runtimes.append(self.runtime(other))
        with patch.object(pl.secrets, "token_urlsafe", wraps=pl.secrets.token_urlsafe) as generate, \
                contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            for runtime in runtimes:
                runtime.credentials(self.cfg, None, production=True)
        self.assertEqual([call.args for call in generate.call_args_list], [(32,), (32,)])
        passwords = [(runtime.private / "initial-admin-password").read_bytes() for runtime in runtimes]
        self.assertNotEqual(*passwords)
        for runtime, password in zip(runtimes, passwords):
            self.assertRegex(password, rb"^[A-Za-z0-9_-]{43}$")
            self.assertEqual(runtime.docker.call_args.kwargs["data"], password)
            self.assertNotIn(password.decode(), repr(runtime.docker.call_args.args) + json.dumps(runtime.env)
                             + output.getvalue() + errors.getvalue())
            self.assertEqual(runtime.private.stat().st_mode & 0o777, 0o700)
            self.assertEqual((runtime.private / "initial-admin-password").stat().st_mode & 0o777, 0o600)
            self.assertEqual((runtime.private / "local-admin.hash").stat().st_mode & 0o777, 0o444)

    def test_explicit_password_file_overrides_random_generation(self):
        password = b"chosen-test-password-override"
        path = self.root / "password-input"
        path.write_bytes(password + b"\r\n")
        path.chmod(0o600)
        runtime = self.runtime()
        with patch.object(pl.secrets, "token_urlsafe") as generate:
            runtime.credentials(self.cfg, path, production=True)
        generate.assert_not_called()
        self.assertEqual((runtime.private / "initial-admin-password").read_bytes(), password)
        self.assertEqual(runtime.docker.call_args.kwargs["data"], password)
        self.assertNotIn(password.decode(), repr(runtime.docker.call_args.args) + json.dumps(runtime.env))

    def test_production_explicit_input_keeps_private_file_and_length_guards(self):
        runtime = self.runtime()
        path = self.root / "password-input"
        for data, mode in ((b"short", 0o600), (b"long-enough-password", 0o644),
                           (b"line-one\nline-two", 0o600)):
            with self.subTest(mode=mode, length=len(data)):
                path.write_bytes(data)
                path.chmod(mode)
                with self.assertRaises(ValueError):
                    runtime.credentials(self.cfg, path, production=True)
                self.assertEqual(self.snapshot(), {})
        runtime.docker.assert_not_called()

    def test_production_repeat_never_rotates_existing_seed_hash_or_db_secret(self):
        runtime = self.runtime()
        runtime.credentials(self.cfg, None, production=True)
        before = self.snapshot()
        replacement = self.root / "replacement"
        replacement.write_bytes(b"another-explicit-password")
        replacement.chmod(0o600)
        with patch.object(pl.secrets, "token_urlsafe") as generate:
            runtime.credentials(self.cfg, replacement, production=True)
            runtime.credentials(self.cfg, None)
        generate.assert_not_called()
        self.assertEqual(runtime.docker.call_count, 1)
        self.assertEqual(self.snapshot(), before)

    def test_interrupted_hash_generation_resumes_from_saved_strong_seed(self):
        runtime = self.runtime()
        runtime.docker.side_effect = ValueError("controlled hash failure")
        with self.assertRaisesRegex(ValueError, "controlled"):
            runtime.credentials(self.cfg, None, production=True)
        initial = runtime.private / "initial-admin-password"
        password, inode = initial.read_bytes(), initial.stat().st_ino
        self.assertFalse((runtime.private / "local-admin.hash").exists())
        runtime.docker.side_effect = None
        with patch.object(pl.secrets, "token_urlsafe") as generate:
            runtime.credentials(self.cfg, None, production=True)
        generate.assert_not_called()
        self.assertEqual((initial.read_bytes(), initial.stat().st_ino), (password, inode))
        self.assertEqual(runtime.docker.call_args.kwargs["data"], password)

    def test_legacy_seed_is_refused_without_overwriting_even_with_explicit_override(self):
        runtime = self.runtime()
        runtime.credentials(self.cfg, None)
        before = self.snapshot()
        replacement = self.root / "replacement"
        replacement.write_bytes(b"another-explicit-password")
        replacement.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "existing.*preserved"), \
                patch.object(pl.secrets, "token_urlsafe") as generate:
            runtime.credentials(self.cfg, replacement, production=True)
        generate.assert_not_called()
        self.assertEqual(runtime.docker.call_count, 1)
        self.assertEqual(self.snapshot(), before)

    def test_legacy_interrupted_seed_is_not_silently_replaced(self):
        initial = self.root / "private/initial-admin-password"
        pl.write_file(initial, b"admin")
        before = self.snapshot()
        runtime = self.runtime()
        with self.assertRaisesRegex(ValueError, "existing.*preserved"):
            runtime.credentials(self.cfg, None, production=True)
        self.assertEqual(self.snapshot(), before)
        runtime.docker.assert_not_called()

    def test_existing_hash_without_initial_password_is_not_reseeded(self):
        runtime = self.runtime()
        pl.write_file(runtime.private / "local-admin.hash", HASH, 0o444)
        pl.write_file(runtime.private / "runtime.env", "PL_DB_PASSWORD=test-existing\n")
        before = self.snapshot()
        with patch.object(pl.secrets, "token_urlsafe") as generate:
            runtime.credentials(self.cfg, None, production=True)
        generate.assert_not_called()
        runtime.docker.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_cli_accepts_explicit_production_mode(self):
        with patch.object(pl.sys, "argv", ["bootstrap.py", "install", "--root", str(self.root),
                          "--package-dir", str(self.root), "--public-url", self.cfg["public_url"],
                          "--self-signed", "--production"]), patch.object(pl, "install") as install:
            self.assertEqual(pl.main(), 0)
        self.assertTrue(install.call_args.args[0].production)

    def install_args(self):
        return types.SimpleNamespace(root=self.root, package_dir=self.root, public_url=self.cfg["public_url"],
            bind_address=self.cfg["bind_address"], admin_user="admin", network_cidr=None,
            module_network_cidr=None, password_file=None, tls_cert=None, tls_key=None,
            self_signed=True, production=True)

    def test_install_forwards_mode_and_reports_seed_path_without_secret(self):
        (self.root / "nginx.conf").write_text("fixture config")
        runtime = self.runtime()
        runtime.network_preflight = Mock()
        runtime.images = Mock()
        runtime.auth_volume = Mock(return_value=True)
        runtime.tls = Mock()
        runtime.compose = Mock()
        original = runtime.credentials
        runtime.credentials = Mock(side_effect=original)
        with patch.object(pl.sys, "platform", "linux"), patch.object(pl.os, "geteuid", return_value=0), \
                patch.object(pl, "manifest", return_value=self.manifest), patch.object(pl, "managed_root"), \
                patch.object(pl, "digest", return_value="a" * 64), patch.object(pl, "Runtime", return_value=runtime), \
                patch.object(pl, "directory", side_effect=lambda path, mode: path.mkdir(mode=mode, exist_ok=True)), \
                patch.object(pl.socket, "socket"), patch.object(pl, "compose_model", return_value={}), \
                patch.object(pl, "check_auth", return_value={}), contextlib.redirect_stdout(io.StringIO()) as output:
            pl.install(self.install_args())
        runtime.credentials.assert_called_once_with(self.cfg, None, production=True)
        password = (self.root / "private/initial-admin-password").read_text()
        self.assertNotIn(password, output.getvalue())
        self.assertIn(str(self.root / "private/initial-admin-password"), output.getvalue())

    def test_production_rejects_legacy_repeat_before_host_actions_or_state_changes(self):
        runtime = self.runtime()
        runtime.credentials(self.cfg, None)
        (self.root / "state").mkdir()
        state = {"config": self.cfg, "version": self.manifest["version"], "manifest_sha256": "a" * 64,
                 "install_id": "pl-existing", "phase": "ready"}
        pl.write_json(self.root / "state/installation.json", state)
        before = self.snapshot()
        with patch.object(pl.sys, "platform", "linux"), patch.object(pl.os, "geteuid", return_value=0), \
                patch.object(pl, "manifest", return_value=self.manifest), patch.object(pl, "managed_root"), \
                patch.object(pl, "digest", return_value="a" * 64), patch.object(pl, "Runtime") as factory:
            with self.assertRaisesRegex(ValueError, "existing.*preserved"):
                pl.install(self.install_args())
        factory.assert_not_called()
        self.assertEqual(pl.read_json(self.root / "state/installation.json"), state)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
