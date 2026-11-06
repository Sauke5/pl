"""Real SQLite transaction and connection lifetimes; no native services."""
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/netmap-stack'))
spec = importlib.util.spec_from_file_location('pl_netmap_store_test', ROOT / 'apps/netmap-stack/service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class StoreLifetimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'netmap.sqlite3'
        self.connections = []
        connect = sqlite3.connect

        def tracked_connect(*args, **kwargs):
            connection = connect(*args, **kwargs)
            self.connections.append(connection)
            return connection

        connection_patch = patch.object(service.sqlite3, 'connect', side_effect=tracked_connect)
        connection_patch.start()
        self.addCleanup(connection_patch.stop)
        # Also clean up connections when running these regressions on old code.
        self.addCleanup(lambda: [connection.close() for connection in self.connections])
        self.store = service.Store(self.path)

    def assert_closed(self, connection):
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute('SELECT 1')

    def test_direct_connection_api_commits_then_closes_at_context_exit(self):
        connection = self.store.connect()
        self.assertIsInstance(connection, sqlite3.Connection)
        self.assertIs(connection.row_factory, sqlite3.Row)
        connection.set_trace_callback(lambda statement: None)
        with connection as db:
            self.assertIs(db, connection)
            db.execute('INSERT INTO profiles VALUES(?,?)', ('fixture', '{"username":"collector"}'))
        self.assert_closed(connection)
        self.assertEqual(self.store.profile('fixture'), {'username': 'collector'})

    def test_body_error_rolls_back_closes_and_preserves_exception(self):
        failure = RuntimeError('fixture failure')
        with self.assertRaises(RuntimeError) as caught:
            with self.store.connect() as db:
                db.execute('INSERT INTO profiles VALUES(?,?)', ('fixture', '{}'))
                raise failure
        self.assertIs(caught.exception, failure)
        self.assert_closed(db)
        self.assertIsNone(self.store.profile('fixture'))

    def test_deferred_constraint_commit_failure_rolls_back_and_closes(self):
        statements = []
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.connect() as db:
                db.set_trace_callback(statements.append)
                db.execute('PRAGMA foreign_keys=ON')
                db.execute('CREATE TABLE parent(id INTEGER PRIMARY KEY)')
                db.execute('CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
                db.execute('INSERT INTO child VALUES(42)')
        self.assert_closed(db)
        self.assertIn('ROLLBACK', statements)
        with self.store.connect() as check:
            self.assertEqual(check.execute('SELECT count(*) FROM child').fetchone()[0], 0)

    def test_initialization_readers_and_validation_error_close_connections(self):
        self.assert_closed(self.connections[0])
        self.assertEqual(self.store.networks(), [])
        self.assertIsNone(self.store.profile('missing'))
        self.assertEqual(self.store.observations(), [])
        self.assertEqual(self.store.reports(), [])
        for reader in (self.store.observations, self.store.reports):
            with self.assertRaises(ValueError):
                reader(limit=0)
        for connection in self.connections:
            self.assert_closed(connection)

    def test_partial_observation_update_rolls_back_without_stale_or_inserted_rows(self):
        with self.store.connect() as db:
            db.execute('INSERT INTO networks VALUES(?,?,?,?)', ('fixture', '192.0.2.0/30', 'Fixture', 'profile'))
        self.store.record_observations('fixture', [{'ip': '192.0.2.1', 'methods': ['icmp']}], 'before')
        with self.assertRaises(KeyError):
            self.store.record_observations('fixture', [{'ip': '192.0.2.2', 'methods': ['icmp']}, {}], 'after')
        self.assert_closed(self.connections[-1])
        self.assertEqual(self.store.observations(), [{'network': 'fixture', 'ip': '192.0.2.1',
            'last_seen': 'before', 'methods': '["icmp"]', 'state': 'observed'}])


if __name__ == '__main__':
    unittest.main()
