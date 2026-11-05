import importlib.util
import base64
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


BASE = Path(__file__).resolve().parents[1]
SOURCE = (BASE / 'get-pl.sh').read_text().split("<<'PL_BOOTSTRAP_PY'\n", 1)[1].rsplit('\nPL_BOOTSTRAP_PY', 1)[0]
SOURCE = SOURCE[:SOURCE.rindex('\ntry:\n')]
bootstrap = types.ModuleType('pl_get_test')
exec(compile(SOURCE, 'get-pl.sh', 'exec'), bootstrap.__dict__)


class BootstrapDeliveryTests(unittest.TestCase):
    def test_trust_key_matches_installer(self):
        self.assertEqual(bootstrap.PUBLIC_KEY, (BASE / 'release-signing-public.pem').read_bytes())

    def test_only_trusted_https_assets_and_github_cdn(self):
        bootstrap.check_url(bootstrap.CATALOG)
        bootstrap.check_url('https://release-assets.githubusercontent.com/github-production-release-asset/1?token=example', True)
        for url in ('http://github.com/Sauke5/pl/releases/download/v1/a',
                    'https://github.com/other/pl/releases/download/v1/a',
                    'https://github.com@other.test/Sauke5/pl/releases/download/v1/a',
                    'https://github.com/Sauke5/pl/releases/download/v1/a#fragment',
                    'https://other.test/a'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                bootstrap.check_url(url)

    def test_signature_failure_prevents_payload_download_and_execution(self):
        signature = base64.b64encode(b'a' * 64).decode()
        payload = base64.b64encode(b'{"schema":1}').decode()
        calls = []
        def download(url, path, *args):
            calls.append(url)
            path.write_text(json.dumps({'payload': payload, 'signature': signature}))
        with patch('sys.argv', ['get-pl.sh']), patch.object(bootstrap.os, 'geteuid', return_value=0), \
             patch.object(bootstrap.platform, 'system', return_value='Linux'), \
             patch.object(bootstrap.platform, 'machine', return_value='x86_64'), \
             patch.object(bootstrap, 'download', side_effect=download), \
             patch.object(bootstrap.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaisesRegex(ValueError, 'Подпись'):
                bootstrap.main()
            self.assertEqual(calls, [bootstrap.CATALOG])
            self.assertEqual(run.call_count, 1)

    def test_installer_only_executed_after_whole_published_core_verified(self):
        self.run_verified_install(production=False)

    def test_production_mode_reaches_verified_installer_and_reports_private_seed_path(self):
        self.run_verified_install(production=True)

    def run_verified_install(self, *, production):
        artifact = {'url': 'https://github.com/Sauke5/pl/releases/download/v0.3.0/pl-core-amd64.tar.gz', 'size': 1234, 'sha256': 'a' * 64}
        payload = {'schema': 1, 'product': 'PL', 'core_api': 1, 'version': '0.3.0', 'core': {'amd64': artifact}, 'modules': {}}
        calls = []
        def download(url, path, *args):
            calls.append((url, args))
            if path.name == 'catalog.json':
                path.write_text(json.dumps({'payload': base64.b64encode(json.dumps(payload).encode()).decode(), 'signature': base64.b64encode(b'a' * 64).decode()}))
            else:
                with tarfile.open(path, 'w:gz') as archive:
                    member = tarfile.TarInfo('install.sh'); member.size = 12
                    archive.addfile(member, io.BytesIO(b'echo fixture'))
        root = '/opt/pl-production-test'
        arguments = ['get-pl.sh', '--root', root, '--public-url', 'https://pl.example.test']
        if production:
            arguments += ['--production']
        with patch('sys.argv', arguments), \
             patch.object(bootstrap.os, 'geteuid', return_value=0), \
             patch.object(bootstrap.platform, 'system', return_value='Linux'), \
             patch.object(bootstrap.platform, 'machine', return_value='x86_64'), \
             patch.object(bootstrap, 'download', side_effect=download), \
             patch.object(bootstrap.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(bootstrap.main(), 0)
            self.assertEqual(calls[1], (artifact['url'], (1234, 1234, 'a' * 64)))
            command = run.call_args_list[-1].args[0]
            self.assertEqual(command[0], '/bin/sh')
            self.assertEqual(command[command.index('--public-url') + 1], 'https://pl.example.test')
            self.assertIn('--self-signed', command)
            self.assertEqual('--production' in command, production)
            self.assertIn(root + '/private/initial-admin-password', output.getvalue())
            self.assertNotIn('admin / admin', output.getvalue())
            self.assertEqual(len(calls), 2, 'bootstrap fetched optional modules')


if __name__ == '__main__':
    unittest.main()
