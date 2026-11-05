"""Finite management errors through the actual handler; no probes/native IO."""
import io
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

import test_netmap_gitea_routing as routing

service = routing.service


class NetMapRequestErrors(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.app = service.Application.__new__(service.Application)
        self.app.store = service.Store(Path(self.temporary.name) / 'netmap.sqlite3')
        self.app.poll_lock, self.app.mutation_lock = threading.Lock(), threading.Lock()
        self.key = 0
        self.app.verifier = types.SimpleNamespace(verify=Mock())
        self.handler_type = service.make_handler(self.app, routing.MemoryHandler)

    def post(self, path, payload, *, key=None):
        self.key += 1
        self.app.verifier.verify.return_value = {'sub': 'fixture-admin', 'idempotency_key': key or 'request-' + str(self.key)}
        handler = self.handler_type('/netmap' + path)
        handler.command = 'POST'
        raw = json.dumps(payload).encode()
        handler.headers['Content-Type'] = 'application/json'
        handler.headers['Content-Length'] = str(len(raw))
        handler.rfile = io.BytesIO(raw)
        handler.dispatch()
        return handler.status, json.loads(handler.wfile.getvalue())

    def network(self, profile='fixture'):
        status, result = self.post('/api/networks', {'cidr': '192.0.2.0/30', 'name': 'Fixture', 'profile': profile})
        self.assertEqual(status, 200)
        return result['id']

    def test_missing_snmp_starts_basic_poll_without_exposing_credentials(self):
        self.post('/api/profiles', {'id': 'fixture', 'username': 'private-user', 'password': 'private-password'})
        network = self.network()
        worker = Mock()
        with patch.object(service.threading, 'Thread', return_value=worker) as thread:
            status, body = self.post('/api/networks/' + network + '/poll', {})
        self.assertEqual(status, 200)
        self.assertEqual(body['state'], 'running')
        self.assertNotIn('private', json.dumps(body))
        with self.app.store.connect() as db:
            self.assertEqual(tuple(db.execute('SELECT state,network FROM polls WHERE id=?', (body['id'],)).fetchone()), ('running', network))
        thread.assert_called_once()
        worker.start.assert_called_once_with()
        self.assertFalse(self.app.poll_lock.acquire(blocking=False))
        self.app.poll_lock.release()

    def test_missing_network_profile_and_busy_poll_have_distinct_statuses(self):
        self.assertEqual(self.post('/api/networks/0000000000000000/poll', {}), (400, {'error': 'netmap_network_missing'}))
        network = self.network('missing')
        self.assertEqual(self.post('/api/networks/' + network + '/poll', {}), (400, {'error': 'netmap_profile_missing'}))
        self.app.poll_lock.acquire()
        try:
            self.assertEqual(self.post('/api/networks/' + network + '/poll', {}), (409, {'error': 'netmap_poll_running'}))
        finally:
            self.app.poll_lock.release()

    def test_idempotency_conflict_stays_a_conflict_without_exception_text(self):
        self.assertEqual(self.post('/api/profiles', {'id': 'fixture', 'password': 'private-first'}, key='same')[0], 200)
        self.assertEqual(self.post('/api/profiles', {'id': 'fixture', 'password': 'private-other'}, key='same'),
                         (409, {'error': 'netmap_idempotency_conflict'}))
        self.assertEqual(self.app.store.profile('fixture')['password'], 'private-first')

    def test_known_validation_and_unknown_exceptions_never_export_values(self):
        cases = (
            ('/api/networks', {'cidr': 'private-input', 'name': 'Fixture', 'profile': 'fixture'}, 'netmap_invalid_network'),
            ('/api/profiles', {'id': 'invalid/private'}, 'netmap_invalid_profile'),
            ('/api/profiles', {'id': 'fixture', 'ssh_known_hosts': 'private-key-input'}, 'netmap_invalid_ssh_trust'),
            ('/api/profiles', {'id': 'fixture', 'ssh_known_hosts': 'bad-private-ip ssh-ed25519 ' + 'a' * 44}, 'netmap_invalid_ssh_trust'),
            ('/api/profiles', {'id': 'fixture', 'oxidized_model': 'private/model'}, 'netmap_invalid_model'),
            ('/api/profiles', {'id': 'fixture', 'snmp_community': 'private community'}, 'netmap_invalid_snmp_community'),
        )
        for path, payload, code in cases:
            with self.subTest(code=code):
                self.assertEqual(self.post(path, payload), (400, {'error': code}))
        for exception, expected in ((ValueError('private-password'), (400, {'error': 'invalid NetMap request'})),
                                    (RuntimeError('private-password'), (502, {'error': 'NetMap operation unconfirmed'}))):
            with patch.object(self.app, 'mutation', side_effect=exception):
                self.assertEqual(self.post('/api/profiles', {'id': 'fixture'}), expected)


if __name__ == '__main__':
    unittest.main()
