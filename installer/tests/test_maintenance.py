import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pl_maintenance", BASE / "maintenance.py")
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)
HASH = "$argon2id$v=19$m=65536,t=3,p=1$" + "A" * 22 + "$" + "B" * 43
AUTH = {"hash": HASH, "password_change_required": False}
FRESH_AUTH = {"hash": HASH.replace("B", "C"), "password_change_required": True}
SCHEMA = {"postgres_major": 17, "migrations": ["migrations/001_initial.sql", "migrations/002_local_auth.sql"],
          "columns": [{"table_name": name} for name in sorted(pl.TABLES)], "indexes": [], "constraints": []}


def fresh():
    return {"tables": sorted(pl.TABLES), "foreign_tables": 0, "foreign_schemas": 0, "large_objects": 0,
            "blocking": 0, "foreign_sessions": 0, "foreign_audit": 0,
            "documents": [{"kind": k, "id": "global", "revision": 1, "body": copy.deepcopy(v)} for k, v in pl.DEFAULTS.items()]}


class FakeRuntime:
    quiesced = pl.Runtime.quiesced
    start_original = pl.Runtime.start_original

    def __init__(self, root):
        self.root = root
        self.m = {}
        self.private = root / "private"
        self.private.mkdir(mode=0o700, exist_ok=True)
        self.install_id = "pl-123456abcdef"
        self.state = {"version": "0.1.0-core.test", "manifest_sha256": "a" * 64,
                      "config": {"admin_user": "admin", "public_url": "https://127.0.0.1:18443"}}
        self.image_ids = {"api": "sha256:" + "1" * 64, "web": "sha256:" + "2" * 64, "db": "sha256:" + "3" * 64}
        self.schema = copy.deepcopy(SCHEMA)
        self.services = {"db": True, "api": True, "web": True}
        self.auth = copy.deepcopy(FRESH_AUTH)
        self.calls = []
        self.fail_dump = False
        self.fail_restore = False
        self.fail_write_once = False
        self.fail_rollback = False
        self.fresh = fresh()

    def compose(self, *args, **kwargs):
        self.calls.append(("compose", args))
        return b""

    def fresh_contract(self):
        self.calls.append(("sql", pl.FRESH_SQL, "pl"))
        return copy.deepcopy(self.fresh)

    def read_auth(self):
        return copy.deepcopy(self.auth)

    def write_auth(self, value):
        self.calls.append(("auth", copy.deepcopy(value)))
        self.auth = copy.deepcopy(value)
        if self.fail_write_once:
            self.fail_write_once = False
            raise ValueError("Injected auth update failure")

    def dump(self, path):
        self.calls.append(("dump",))
        if self.fail_dump:
            raise ValueError("Injected pg_dump failure")
        path.write_bytes(b"PGDMPmock-data")
        path.chmod(0o600)

    def wait_original(self):
        pass

    def schema_contract(self, database="pl"):
        return copy.deepcopy(self.schema)

    def sql(self, query, database="pl"):
        self.calls.append(("sql", query, database))
        if self.fail_rollback and 'ALTER DATABASE "pl" RENAME TO "pl_stage_' in query:
            raise ValueError("Injected rollback rename failure")
        if query == pl.FRESH_SQL:
            return json.dumps(self.fresh).encode()
        if query.startswith("SELECT (SELECT count(*) FROM sessions)"):
            return b"0\n"
        return b""

    def restore_dump(self, path, database):
        self.calls.append(("restore_dump", database))
        if self.fail_restore:
            raise ValueError("Injected pg_restore failure")


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.rt = FakeRuntime(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def metadata(self):
        return {"schema": 1, "product": "PL-private-backup", "source_install_id": "pl-abcdef123456",
                "version": self.rt.state["version"], "manifest_sha256": self.rt.state["manifest_sha256"],
                "images": self.rt.image_ids, "postgres_major": 17, "database_schema": SCHEMA,
                "admin_user": "admin", "source_config": {"public_url": "https://192.0.2.5:8443"}}

    def archive(self, metadata=None, auth=None, dump=b"PGDMPtest-data"):
        p = self.root / "backup.tar"
        db = self.root / "db.dump"
        db.write_bytes(dump)
        meta = self.metadata() if metadata is None else metadata
        auth = AUTH if auth is None else auth
        auth_body = json.dumps(auth, sort_keys=True).encode()
        meta = copy.deepcopy(meta)
        meta["files"] = {"auth.json": {"sha256": hashlib.sha256(auth_body).hexdigest(), "bytes": len(auth_body)},
                         "database.dump": {"sha256": hashlib.sha256(dump).hexdigest(), "bytes": len(dump)}}
        pl.write_archive(p, meta, db, auth)
        return p, pl.bootstrap.digest(p)

    def test_maintenance_canonical_configuration_accepts_explicit_network_and_legacy(self):
        for name in ('state', 'config', 'releases'):
            (self.root / name).mkdir(mode=0o750, exist_ok=True)
        legacy = pl.bootstrap.configuration('https://127.0.0.1:18443', '127.0.0.1', 'admin')
        for cfg in (legacy, dict(legacy, network_cidr='10.90.1.0/24')):
            state = {'schema': 1, 'product': 'Pl', 'phase': 'ready', 'install_id': 'pl-123456abcdef',
                     'version': '0.1.0-test', 'config': cfg}
            # Reaching package validation proves the real canonical cfg guard
            # accepted both formats without invoking Docker or changing state.
            with patch.object(pl.bootstrap, 'managed_root'), patch.object(pl, 'safe_json', return_value=state), \
                    patch.object(pl.bootstrap, 'manifest', side_effect=ValueError('package-check-reached')):
                with self.assertRaisesRegex(ValueError, 'package-check-reached'):
                    pl.Runtime(self.root)
        state['config'] = dict(legacy, network_cidr='10.90.1.1/24')
        with patch.object(pl.bootstrap, 'managed_root'), patch.object(pl, 'safe_json', return_value=state), \
                patch.object(pl.bootstrap, 'manifest') as manifest:
            with self.assertRaisesRegex(ValueError, 'canonical'):
                pl.Runtime(self.root)
            manifest.assert_not_called()

    def test_foreign_root_not_mutated(self):
        p = self.root / "foreign"
        p.mkdir(mode=0o755)
        (p / "keep").write_text("preserve")
        before = p.stat().st_mode
        with self.assertRaisesRegex(ValueError, "install.sh"):
            pl.Runtime(p)
        self.assertEqual(p.stat().st_mode, before)
        self.assertEqual([x.name for x in p.iterdir()], ["keep"])

    def test_archive_roundtrip_with_private_modes(self):
        p, digest = self.archive()
        dest = self.root / "read"
        dest.mkdir()
        meta, db, auth = pl.load_archive(p, digest, dest)
        self.assertEqual(auth, AUTH)
        self.assertEqual(db.read_bytes(), b"PGDMPtest-data")
        self.assertEqual(meta["version"], self.rt.state["version"])
        self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        self.assertTrue(all(x.stat().st_mode & 0o777 == 0o600 for x in dest.iterdir()))

    def test_wrong_hash_rejected_before_extraction(self):
        p, _ = self.archive()
        dest = self.root / "read"
        dest.mkdir()
        with self.assertRaisesRegex(ValueError, "SHA256"):
            pl.load_archive(p, "0" * 64, dest)
        self.assertEqual(list(dest.iterdir()), [])

    def test_unprotected_or_symlink_backup_rejected(self):
        p, digest = self.archive()
        dest = self.root / "read"
        dest.mkdir()
        p.chmod(0o644)
        with self.assertRaises(ValueError):
            pl.load_archive(p, digest, dest)
        p.chmod(0o600)
        link = self.root / "linked.tar"
        link.symlink_to(p)
        with self.assertRaises((ValueError, OSError)):
            pl.load_archive(link, digest, dest)

    def malicious_archive(self, variant):
        p = self.root / "malicious.tar"
        with tarfile.open(p, "w") as archive:
            for name in ("metadata.json", "auth.json", "database.dump"):
                info = tarfile.TarInfo("../escape" if variant == "traversal" and name == "auth.json" else name)
                if variant == "symlink" and name == "auth.json":
                    info.type, info.linkname = tarfile.SYMTYPE, "/etc/shadow"
                if variant == "huge" and name == "database.dump":
                    info.size = pl.MAX_DUMP + 1
                    archive.addfile(info)  # Header only is enough; validation must reject before reading.
                else:
                    info.size = 0
                    archive.addfile(info, io.BytesIO())
                if variant == "duplicate" and name == "auth.json":
                    archive.addfile(info, io.BytesIO())
        p.chmod(0o600)
        return p

    def test_traversal_symlink_duplicate_rejected_before_extract(self):
        for variant in ("traversal", "symlink", "duplicate"):
            with self.subTest(variant=variant):
                p = self.malicious_archive(variant)
                dest = self.root / variant
                dest.mkdir()
                with self.assertRaisesRegex(ValueError, "archive"):
                    pl.load_archive(p, pl.bootstrap.digest(p), dest)
                self.assertEqual(list(dest.iterdir()), [])
        self.assertFalse((self.root / "escape").exists())

    def test_internal_hash_and_format_tamper_rejected(self):
        p, digest = self.archive(dump=b"not-a-pg-dump")
        dest = self.root / "read"
        dest.mkdir()
        with self.assertRaisesRegex(ValueError, "custom-format"):
            pl.load_archive(p, digest, dest)

    def test_fresh_check_refuses_user_records_and_modified_defaults(self):
        pl.validate_fresh(fresh())
        with_users_schema = fresh()
        with_users_schema["tables"].append("local_users")
        with_users_schema["local_users_count"] = 0
        pl.validate_fresh(with_users_schema)
        cases = []
        for key in ("blocking", "foreign_sessions", "foreign_audit", "foreign_tables", "foreign_schemas", "large_objects"):
            d = fresh()
            d[key] = 1
            cases.append(d)
        d = fresh()
        d["documents"].append({"kind": "local_user", "id": "u"})
        cases.append(d)
        d = fresh()
        d["tables"].append("local_users")
        d["local_users_count"] = 1
        cases.append(d)
        d = fresh()
        d["documents"][0]["body"]["board_title"] = "My board"
        cases.append(d)
        d = fresh()
        d["documents"][0]["revision"] = 2
        cases.append(d)
        for d in cases:
            with self.subTest(data=d), self.assertRaises(ValueError):
                pl.validate_fresh(d)

    def test_core_backup_refuses_installed_local_module_data(self):
        self.rt.m = {"features": {"module_controller": True}}
        modules = self.root / "modules"
        modules.mkdir()
        (modules / "12345678-1234-1234-1234-123456789abc").mkdir()
        with self.assertRaisesRegex(ValueError, "module-aware backup"):
            pl.backup(self.rt, self.root / "incomplete.tar")
        self.assertNotIn(("dump",), self.rt.calls)
        self.assertFalse((self.root / "incomplete.tar").exists())
        self.assertEqual(self.rt.calls, [])

    def test_core_backup_refuses_local_module_records_before_dump(self):
        self.rt.m = {"features": {"module_controller": True}}
        self.rt.sql = lambda query, database="pl": b"1\n"
        with self.assertRaisesRegex(ValueError, "module-aware backup"):
            pl.backup(self.rt, self.root / "incomplete.tar")
        self.assertNotIn(("dump",), self.rt.calls)

    def test_backup_uses_live_hash_and_resumes_after_dump_error(self):
        self.rt.auth = copy.deepcopy(AUTH)
        p = self.root / "new.tar"
        with redirect_stdout(io.StringIO()):
            pl.backup(self.rt, p)
        dest = self.root / "read"
        dest.mkdir()
        _, _, auth = pl.load_archive(p, pl.bootstrap.digest(p), dest)
        self.assertEqual(auth, AUTH)
        self.assertNotEqual(auth, FRESH_AUTH)
        self.assertEqual(self.rt.calls[-2:], [("compose", ("start", "api")), ("compose", ("start", "web"))])
        self.rt.calls = []
        self.rt.fail_dump = True
        with self.assertRaises(ValueError):
            pl.backup(self.rt, self.root / "failed.tar")
        self.assertEqual(self.rt.calls[-2:], [("compose", ("start", "api")), ("compose", ("start", "web"))])
        self.assertFalse((self.root / "failed.tar").exists())

    def test_failed_stop_also_resumes_original_running_services(self):
        calls = []
        def compose(*args):
            calls.append(args)
            if args[0] == "stop":
                raise ValueError("Injected stop failure")
        self.rt.compose = compose
        with self.assertRaises(ValueError):
            with self.rt.quiesced():
                self.fail("Must not dump after failed stop")
        self.assertEqual(calls[-2:], [("start", "api"), ("start", "web")])

    def test_previously_stopped_services_remain_stopped(self):
        self.rt.services["api"] = self.rt.services["web"] = False
        with self.rt.quiesced():
            pass
        self.assertEqual(self.rt.calls, [])

    def test_wrong_version_same_source_and_wrong_images_no_mutations(self):
        for changed in ("version", "source_install_id", "images"):
            meta = self.metadata()
            meta[changed] = {"api": "wrong"} if changed == "images" else self.rt.install_id if changed == "source_install_id" else "other"
            p, digest = self.archive(meta)
            with self.assertRaisesRegex(ValueError, "same package"):
                pl.restore(self.rt, p, digest)
            self.assertEqual(self.rt.calls, [])
            p.unlink()

    def test_nonempty_target_refused_before_stopping_or_mutation(self):
        p, digest = self.archive()
        self.rt.fresh["blocking"] = 1
        with self.assertRaisesRegex(ValueError, "fresh"):
            pl.restore(self.rt, p, digest)
        self.assertEqual(self.rt.calls, [("sql", pl.FRESH_SQL, "pl")])

    def test_successful_restore_revokes_sessions_and_keeps_target_config(self):
        p, digest = self.archive()
        before = copy.deepcopy(self.rt.state)
        with redirect_stdout(io.StringIO()):
            pl.restore(self.rt, p, digest)
        self.assertEqual(self.rt.auth, AUTH)
        self.assertEqual(self.rt.state, before)
        queries = [c[1] for c in self.rt.calls if c[0] == "sql"]
        self.assertTrue(any("DELETE FROM sessions; DELETE FROM oidc_states; DELETE FROM local_login_attempts" in q for q in queries))
        self.assertTrue(any(q.startswith('ALTER DATABASE "pl" RENAME TO "pl_before_') for q in queries))
        self.assertTrue(any(q.startswith('DROP DATABASE "pl_before_') for q in queries))
        self.assertEqual(self.rt.calls[-3:-1], [("compose", ("start", "api")), ("compose", ("start", "web"))])
        self.assertTrue(self.rt.calls[-1][1].startswith('DROP DATABASE "pl_before_'))
        self.assertFalse((self.rt.private / "restore-recovery.json").exists())

    def test_pg_restore_failure_preserves_fresh_target_and_stage(self):
        p, digest = self.archive()
        self.rt.fail_restore = True
        with self.assertRaisesRegex(ValueError, "pg_restore"):
            pl.restore(self.rt, p, digest)
        self.assertEqual(self.rt.auth, FRESH_AUTH)
        queries = [c[1] for c in self.rt.calls if c[0] == "sql"]
        self.assertFalse(any(q.startswith(("ALTER DATABASE", "DROP DATABASE")) for q in queries))
        self.assertTrue((self.rt.private / "restore-recovery.json").exists())
        self.assertEqual(self.rt.calls[-1], ("compose", ("start", "web")))

    def test_staging_constraint_change_preserves_target_without_swap(self):
        p, digest = self.archive()
        changed = copy.deepcopy(SCHEMA)
        changed['constraints'] = [{'tab': 'documents', 'name': 'body_check',
                                   'def': 'CHECK (body IS NOT NULL)'}]
        self.rt.schema_contract = lambda database='pl': copy.deepcopy(changed)
        with self.assertRaisesRegex(ValueError, 'staging schema differs'):
            pl.restore(self.rt, p, digest)
        self.assertEqual(self.rt.auth, FRESH_AUTH)
        queries = [c[1] for c in self.rt.calls if c[0] == 'sql']
        self.assertFalse(any(q.startswith(('ALTER DATABASE', 'DROP DATABASE')) for q in queries))
        self.assertTrue((self.rt.private / 'restore-recovery.json').exists())
        self.assertEqual(self.rt.calls[-1], ('compose', ('start', 'web')))

    def test_auth_failure_after_swap_rolls_back_database_and_hash(self):
        p, digest = self.archive()
        self.rt.fail_write_once = True
        with self.assertRaisesRegex(ValueError, "auth update"):
            pl.restore(self.rt, p, digest)
        self.assertEqual(self.rt.auth, FRESH_AUTH)
        queries = [c[1] for c in self.rt.calls if c[0] == "sql"]
        self.assertTrue(any(q.startswith('ALTER DATABASE "pl" RENAME TO "pl_stage_') for q in queries))
        self.assertTrue(any(q.startswith('ALTER DATABASE "pl_before_') and q.endswith('RENAME TO "pl";') for q in queries))
        self.assertFalse(any(q.startswith("DROP DATABASE") for q in queries))
        self.assertEqual(self.rt.calls[-1], ("compose", ("start", "web")))

    def test_readiness_failure_rolls_back_before_discarding_fresh_database(self):
        p, digest = self.archive()
        calls = []
        def wait():
            calls.append("wait")
            if len(calls) == 1:
                raise ValueError("Injected readiness failure")
        self.rt.wait_original = wait
        with self.assertRaisesRegex(ValueError, "readiness"):
            pl.restore(self.rt, p, digest)
        self.assertEqual(self.rt.auth, FRESH_AUTH)
        queries = [c[1] for c in self.rt.calls if c[0] == "sql"]
        self.assertTrue(any(q.startswith('ALTER DATABASE "pl" RENAME TO "pl_stage_') for q in queries))
        self.assertFalse(any(q.startswith("DROP DATABASE") for q in queries))
        self.assertEqual(len(calls), 2)

    def test_rollback_failure_leaves_api_web_stopped(self):
        p, digest = self.archive()
        self.rt.fail_write_once = self.rt.fail_rollback = True
        with self.assertRaisesRegex(ValueError, "rollback incomplete"):
            pl.restore(self.rt, p, digest)
        self.assertFalse(any(c[0] == "compose" and c[1][0] == "start" for c in self.rt.calls))
        self.assertIn("incomplete", json.loads((self.rt.private / "restore-recovery.json").read_text())["status"])

    def test_live_auth_reader_uses_owned_volume_and_not_host_seed(self):
        rt = object.__new__(pl.Runtime)
        calls = []
        rt.helper = lambda script: calls.append(script) or (HASH.encode() + b"\n\nchanged")
        self.assertEqual(rt.read_auth(), AUTH)
        self.assertNotIn("seed", calls[0])
        self.assertIn("/auth/local-admin.hash", calls[0])

    def test_command_failure_diagnostics_do_not_retain_secrets(self):
        rt = object.__new__(pl.Runtime)
        rt.root, rt.private, rt.env = self.root, self.rt.private, {}
        secret = b"private-db-password\n$argon2id$secret-hash"
        with patch.object(pl.subprocess, "run", return_value=subprocess.CompletedProcess(["docker"], 1, b"DB-values", secret)):
            with self.assertRaisesRegex(ValueError, "redacted"):
                rt.run(["docker", "info"], data=secret)
        log = (rt.private / "maintenance-error.json").read_bytes()
        self.assertNotIn(secret, log)
        self.assertNotIn(b"private-db-password", log)
        self.assertNotIn(b"DB-values", log)


class TransferSpoolRuntimeTests(unittest.TestCase):
    def fixture(self, enabled=True):
        rt = pl.Runtime.__new__(pl.Runtime)
        rt.install_id = 'pl-123456abcdef'
        rt.root = Path('/isolated/pl-fixture')
        rt.private = rt.root / 'private'
        rt.image_ids = {}
        rt.m = {'schema': 2, 'architecture': 'amd64', 'database': {'major': 18},
                'features': {'module_controller': True, 'sftpgo_module': enabled},
                'images': {name: {'id': 'sha256:' + str(i) * 64, 'labels': {}}
                           for i, name in enumerate(('api', 'web', 'db'), 1)}}
        volumes = {name: {'Name': name, 'Driver': 'local', 'Options': None,
                         'Labels': {'pl.installation': rt.install_id}}
                   for name in (rt.install_id + '_db', rt.install_id + '-auth', rt.install_id + '_module-transfers')}
        volumes[rt.install_id + '_module-transfers']['Labels']['pl.temporary'] = 'true'
        def bind(source, destination):
            return {'Type': 'bind', 'Source': str(source), 'Destination': destination, 'RW': False}
        mounts = {
            'db': [{'Type': 'volume', 'Name': rt.install_id + '_db', 'Destination': '/var/lib/postgresql', 'RW': True}],
            'api': [{'Type': 'volume', 'Name': rt.install_id + '-auth', 'Destination': '/run/pl-auth', 'RW': True},
                    bind(rt.root / 'run/module-controller', '/run/pl-module-controller'),
                    bind(rt.private / 'module-controller-key', '/run/secrets/module-controller-key')],
            'web': [bind(rt.root / 'config/nginx.conf', '/etc/nginx/nginx.conf'),
                    bind(rt.private / 'tls.crt', '/run/pl/tls.crt'), bind(rt.private / 'tls.key', '/run/pl/tls.key')]}
        if enabled:
            mounts['api'].append({'Type': 'volume', 'Name': rt.install_id + '_module-transfers',
                                  'Destination': '/var/lib/pl/transfers', 'RW': True})
        containers = {name: {'Image': image['id'], 'Config': {'Labels': {
            'com.docker.compose.project': rt.install_id, 'com.docker.compose.service': name}},
            'State': {'Running': True, 'Status': 'running'}, 'Mounts': mounts[name]}
            for name, image in rt.m['images'].items()}
        calls = []
        def docker(*args):
            calls.append(args)
            if args[:2] == ('volume', 'inspect'):
                return json.dumps([volumes[args[2]]]).encode()
            if args[:2] == ('image', 'inspect'):
                return json.dumps([{'Id': args[2], 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': {}}}]).encode()
            if args[:2] == ('container', 'inspect'):
                return json.dumps([containers[args[2]]]).encode()
            raise AssertionError('unexpected mutation or Docker operation: ' + str(args))
        rt.docker = docker
        rt.compose = lambda *args: args[-1].encode() if args[:3] == ('ps', '--all', '--quiet') else self.fail('unexpected compose mutation')
        rt.schema_contract = lambda: {'postgres_major': 18, 'columns': [{'table_name': name} for name in pl.TABLES]}
        return rt, mounts, volumes, calls

    def test_owned_disk_spool_admitted_without_runtime_mutations(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                rt, mounts, volumes, calls = self.fixture(enabled)
                rt.validate_runtime()
                self.assertTrue(rt.services['api'])
                inspected = [args[2] for args in calls if args[:2] == ('volume', 'inspect')]
                self.assertEqual(rt.install_id + '_module-transfers' in inspected, enabled)
                self.assertTrue(all(args[1] == 'inspect' for args in calls))

    def test_foreign_transfer_mounts_are_rejected(self):
        mutations = (
            lambda mounts: mounts[-1].update(Type='bind', Source='/foreign'),
            lambda mounts: mounts[-1].update(Name='foreign-volume'),
            lambda mounts: mounts[-1].update(RW=False),
            lambda mounts: mounts[-1].pop('RW'),
            lambda mounts: mounts.append(copy.deepcopy(mounts[-1])),
            lambda mounts: mounts.pop(),
        )
        for mutate in mutations:
            rt, mounts, volumes, calls = self.fixture()
            mutate(mounts['api'])
            with self.assertRaisesRegex(ValueError, 'transfer volume mount'):
                rt.validate_runtime()
        rt, mounts, volumes, calls = self.fixture(False)
        mounts['api'].append({'Type': 'volume', 'Name': rt.install_id + '_module-transfers',
                              'Destination': '/var/lib/pl/transfers', 'RW': True})
        with self.assertRaisesRegex(ValueError, 'without module feature'):
            rt.validate_runtime()

    def test_transfer_volume_labels_driver_and_options_are_enforced(self):
        mutations = (
            lambda volume: volume.update(Name='foreign-volume'),
            lambda volume: volume.update(Driver='nfs'),
            lambda volume: volume.update(Options={'device': '/foreign'}),
            lambda volume: volume.update(Options=[]),
            lambda volume: volume['Labels'].update({'pl.installation': 'pl-foreign'}),
            lambda volume: volume['Labels'].pop('pl.temporary'),
            lambda volume: volume['Labels'].update({'pl.temporary': 'false'}),
            lambda volume: volume.update(Labels=['foreign']),
        )
        for mutate in mutations:
            rt, mounts, volumes, calls = self.fixture()
            mutate(volumes[rt.install_id + '_module-transfers'])
            with self.assertRaisesRegex(ValueError, 'transfer volume ownership'):
                rt.validate_runtime()


if __name__ == "__main__":
    unittest.main()
