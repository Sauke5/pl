"""Signed native initial-login RPC routing; no socket or Docker operations."""
from email.message import Message
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import time
import types
import unittest
import uuid
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location('pl_native_initial_login_test', Path(__file__).resolve().parents[1] / 'module-controller.py')
pl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pl)


class InitialLoginRPC(unittest.TestCase):
    def setUp(self):
        self.controller = Mock()
        self.body = {'instance_id': str(uuid.uuid4()), 'module_id': 'grafana', 'service': 'grafana'}

    def request(self, payload, authenticated=True):
        raw, timestamp = json.dumps(payload).encode(), str(int(time.time()))
        key, path = b'k' * 32, '/v1/native/initial-login'
        headers = Message()
        headers['Content-Length'] = str(len(raw))
        headers['X-PL-Timestamp'] = timestamp
        signed = timestamp.encode() + b'\nPOST\n' + path.encode() + b'\n' + raw
        headers['X-PL-Signature'] = hmac.new(key, signed, hashlib.sha256).hexdigest() if authenticated else '0' * 64
        handler = pl.Handler.__new__(pl.Handler)
        handler.command, handler.path, handler.headers = 'POST', path, headers
        handler.rfile = io.BytesIO(raw)
        handler.server = types.SimpleNamespace(key=key, controller=self.controller)
        handler.reply = Mock()
        handler.handle_request()
        return handler.reply.call_args.args

    def test_signed_grafana_request_uses_owned_grafana_controller(self):
        value = {**self.body, 'username': 'admin', 'password': 'admin', 'path': '/grafana/login'}
        self.controller.grafana.return_value.initial_login.return_value = value
        self.assertEqual(self.request(self.body), (200, value))
        self.controller.grafana.return_value.initial_login.assert_called_once_with(self.body)
        self.controller.application.assert_not_called()

    def test_unsigned_or_extra_field_request_never_reaches_grafana(self):
        self.assertEqual(self.request(self.body, authenticated=False)[0], 403)
        self.assertEqual(self.request({**self.body, 'password': 'replacement'})[0], 400)
        self.controller.grafana.assert_not_called()
        self.controller.application.assert_not_called()

    def test_other_native_modules_keep_existing_controller_route(self):
        for module, service in (('netmap', 'netbox'), ('netmap', 'gitea'), ('bookstack', 'bookstack')):
            self.controller.reset_mock()
            body = {**self.body, 'module_id': module, 'service': service}
            self.controller.application.return_value.initial_login.return_value = {'fixture': service}
            self.assertEqual(self.request(body), (200, {'fixture': service}))
            self.controller.application.assert_called_once_with(module)
            self.controller.grafana.assert_not_called()


if __name__ == '__main__':
    unittest.main()
