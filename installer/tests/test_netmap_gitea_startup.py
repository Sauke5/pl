"""Shell startup regressions. Native-image confirmation belongs to lab CI."""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'apps/netmap-stack/gitea-start.sh'
HUMAN_PASSWORD = 'H' * 8
BOT_TOKEN = 'c' * 40

FAKE_GITEA = r'''#!/usr/bin/env python3
import json, os
from pathlib import Path
import stat, sys
args = sys.argv[1:]
work = Path(args[args.index('--work-path') + 1])
config = Path(args[args.index('--config') + 1])
command = args[4:]
with (work / 'calls.jsonl').open('a') as stream:
    stream.write(json.dumps(command) + '\n')
if command == ['migrate']:
    if not (work / 'data').is_dir() or stat.S_IMODE(config.stat().st_mode) != 0o600:
        print('configuration is not writable or data directory is missing')
        sys.exit(13)
    value = config.read_text()
    if 'INTERNAL_TOKEN =' not in value:
        config.write_text(value + '\nINTERNAL_TOKEN = native-generated-fixture\n')
    if os.environ.get('GITEA_FAKE_FAILURE') == 'migrate':
        sys.stdout.write('private-migration-detail-' * 10000)
        sys.stdout.flush()
        sys.stderr.write('private-migration-error')
        sys.exit(7)
elif command[:3] == ['admin', 'user', 'create']:
    username = command[command.index('--username') + 1]
    if username == 'pl-admin':
        if '--password' in command or command[command.index('--random-password-length') + 1] != '8':
            sys.exit(11)
        print("generated random password is '" + 'H' * 8 + "'")
        if os.environ.get('GITEA_FAKE_FAILURE') == 'admin':
            sys.exit(9)
        (work / 'native-account-fixture').write_text('H' * 8)
        print("New user 'pl-admin' has been successfully created!")
    elif username == 'pl-collector':
        print("New user 'pl-collector' has been successfully created!")
        print('Access token was successfully created... ' + 'c' * 40)
        if os.environ.get('GITEA_FAKE_FAILURE') == 'collector':
            sys.exit(10)
    else:
        sys.exit(2)
elif command == ['web']:
    print('web started')
else:
    sys.exit(2)
'''


class GiteaStartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.work = self.root / 'data'
        self.seed = self.root / 'gitea.ini'
        self.seed.write_text('[security]\nINSTALL_LOCK = true\nSECRET_KEY = fixture\n')
        self.seed.chmod(0o444)
        self.binary = self.root / 'gitea'
        self.binary.write_text(FAKE_GITEA)
        self.binary.chmod(0o755)
        self.script = self.root / 'start.sh'
        self.script.write_text(SCRIPT.read_text().replace('/var/lib/gitea', str(self.work))
                               .replace('/run/secrets/gitea.ini', str(self.seed))
                               .replace('/usr/local/bin/gitea', str(self.binary)))

    def start(self, failure=''):
        return subprocess.run(['/bin/sh', str(self.script)], capture_output=True, text=True, timeout=15,
                              env={**os.environ, 'GITEA_FAKE_FAILURE': failure})

    def calls(self):
        return [json.loads(line) for line in (self.work / 'calls.jsonl').read_text().splitlines()]

    def test_owned_config_is_writable_and_native_settings_and_users_survive_restart(self):
        first = self.start()
        self.assertEqual(first.returncode, 0, first.stderr)
        config = self.work / 'custom/conf/app.ini'
        self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
        self.assertIn('INTERNAL_TOKEN = native-generated-fixture', config.read_text())
        receipts = {name: (self.work / 'pl-bootstrap' / name).read_bytes() for name in ('admin', 'collector')}
        self.assertIn(HUMAN_PASSWORD.encode(), receipts['admin'])
        account = self.work / 'native-account-fixture'
        self.assertEqual(account.read_text(), HUMAN_PASSWORD)
        account.write_text('user-changed-native-password')
        config.write_text(config.read_text() + 'NATIVE_SETTING = retained\n')
        config.chmod(0o400)  # The earlier cp/umask produced this mode.
        (self.work / 'pl-bootstrap/migrate.log').chmod(0o644)
        self.seed.chmod(0o600)
        self.seed.write_text('[security]\nSECRET_KEY = replacement-seed-must-not-win\n')
        second = self.start()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('NATIVE_SETTING = retained', config.read_text())
        self.assertNotIn('replacement-seed', config.read_text())
        self.assertEqual(account.read_text(), 'user-changed-native-password')
        self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.work / 'pl-bootstrap/migrate.log').stat().st_mode), 0o600)
        for name, expected in receipts.items():
            self.assertEqual((self.work / 'pl-bootstrap' / name).read_bytes(), expected)
            self.assertEqual(stat.S_IMODE((self.work / 'pl-bootstrap' / name).stat().st_mode), 0o444)
        self.assertEqual(len([row for row in self.calls() if row[:3] == ['admin', 'user', 'create']]), 2)
        self.assertNotIn(HUMAN_PASSWORD, first.stdout + first.stderr + second.stdout + second.stderr)
        self.assertNotIn(BOT_TOKEN, first.stdout + first.stderr + second.stdout + second.stderr)

    def test_existing_legacy_receipts_and_user_changed_password_are_not_reissued(self):
        bootstrap = self.work / 'pl-bootstrap'
        bootstrap.mkdir(parents=True, mode=0o755)
        receipt = bootstrap / 'admin'
        legacy = "generated random password is '" + 'L' * 40 + "'\nNew user 'pl-admin' has been successfully created!\n"
        receipt.write_text(legacy)
        receipt.chmod(0o444)
        collector = bootstrap / 'collector'
        collector.write_text('Access token was successfully created... ' + BOT_TOKEN + '\n')
        collector.chmod(0o444)
        account = self.work / 'native-account-fixture'
        account.write_text('user-changed-password-retained')
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [['migrate'], ['web']])
        self.assertEqual(receipt.read_text(), legacy)
        self.assertEqual(account.read_text(), 'user-changed-password-retained')
        self.assertIn(BOT_TOKEN, collector.read_text())
        self.assertNotIn('L' * 40, result.stdout + result.stderr)

    def test_migration_failure_retains_bounded_private_details_and_original_exit_code(self):
        result = self.start('migrate')
        self.assertEqual(result.returncode, 7)
        self.assertIn('database-migration', result.stderr)
        self.assertNotIn('private-migration', result.stdout + result.stderr)
        log = self.work / 'pl-bootstrap/migrate.log'
        self.assertEqual(log.stat().st_size, 65536)
        self.assertTrue(log.read_text().endswith('private-migration-error'))
        self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
        self.assertEqual(self.calls(), [['migrate']])
        self.assertFalse((self.work / 'pl-bootstrap/migrate.status').exists())
        self.assertFalse((self.work / 'pl-bootstrap/admin').exists())

    def test_failed_admin_creation_does_not_publish_partial_receipt_or_leak_password(self):
        result = self.start('admin')
        self.assertEqual(result.returncode, 9)
        self.assertIn('administrator-bootstrap', result.stderr)
        self.assertNotIn(HUMAN_PASSWORD, result.stdout + result.stderr)
        bootstrap = self.work / 'pl-bootstrap'
        self.assertFalse((bootstrap / 'admin').exists())
        self.assertFalse((bootstrap / 'collector').exists())
        self.assertEqual(stat.S_IMODE((bootstrap / 'admin.pending').stat().st_mode), 0o600)

    def test_failed_collector_creation_reports_stage_without_leaking_token(self):
        result = self.start('collector')
        self.assertEqual(result.returncode, 10)
        self.assertIn('collector-bootstrap', result.stderr)
        self.assertNotIn(BOT_TOKEN, result.stdout + result.stderr)
        bootstrap = self.work / 'pl-bootstrap'
        self.assertTrue((bootstrap / 'admin').is_file())
        self.assertFalse((bootstrap / 'collector').exists())
        self.assertEqual(stat.S_IMODE((bootstrap / 'collector.pending').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
