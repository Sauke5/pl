"""Signed adapter admission for finite device reads and explicit collection writes."""
import base64
import hashlib
import hmac
import io
import json
import secrets
import time
import unittest
from unittest.mock import Mock

import test_netmap_gitea_routing as routing

service = routing.service


class DeviceGateway(unittest.TestCase):
    def setUp(self):
        self.key = b'8' * 32
        self.app = service.Application.__new__(service.Application)
        self.app.verifier = service.GatewayVerifier(self.key)
        self.app.devices = Mock(return_value={'items': []})
        self.app.device_details = Mock(return_value={'version': 'actual-version'})
        self.app.mutation = Mock(return_value={'state': 'queued'})
        self.handler = service.make_handler(self.app, routing.MemoryHandler)

    def request(self, path, method='GET', body=None, admin=True, csrf=True, tamper=False):
        payload = json.dumps(body).encode() if body is not None else b''
        handler = self.handler(path)
        handler.command = method
        handler.rfile = io.BytesIO(payload)
        if payload:
            handler.headers['Content-Length'] = str(len(payload))
            handler.headers['Content-Type'] = 'application/json'
        encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')
        now = int(time.time())
        claims = {'v': 2, 'aud': 'netmap', 'iat': now, 'exp': now + 30, 'nonce': encode(secrets.token_bytes(24)),
                  'sub': 'fixture-admin', 'name': 'Fixture', 'admin': admin,
                  'scopes': ['netmap:admin' if admin else 'netmap:read'], 'method': method, 'uri': path,
                  'content_type': 'application/json' if payload else '',
                  'body_sha256': hashlib.sha256(payload if not tamper else b'other').hexdigest(),
                  'idempotency_key': 'explicit-fixture-operation' if method == 'POST' else '',
                  'source_ip': '127.0.0.1', 'csrf_token': encode(b'c' * 32), 'csrf_verified': csrf if method == 'POST' else False}
        if method == 'POST':
            handler.headers['Idempotency-Key'] = claims['idempotency_key']
            handler.headers['X-CSRF-Token'] = claims['csrf_token']
        assertion = encode(json.dumps(claims, separators=(',', ':')).encode())
        handler.headers['X-PL-Gateway-Assertion'] = assertion
        handler.headers['X-PL-Gateway-Signature'] = encode(hmac.digest(self.key, b'pl-gateway-v2\n' + assertion.encode(), 'sha256'))
        handler.dispatch()
        return handler

    def test_only_authenticated_admin_reads_finite_source_network_or_exact_device(self):
        for path in ('/netmap/api/devices?network=' + 'a' * 16, '/netmap/api/devices/1'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path, admin=False).status, 403)
                self.assertEqual(self.request(path).status, 200)
        self.app.devices.assert_called_once_with('a' * 16)
        self.app.device_details.assert_called_once_with(1)
        for query in ('', '?network=foreign', '?network=' + 'a' * 16 + '&network=' + 'b' * 16, '?network=' + 'a' * 16 + '&all=1'):
            with self.subTest(query=query):
                self.assertEqual(self.request('/netmap/api/devices' + query).status, 400)
        self.assertEqual(self.request('/netmap/api/devices/1?force=1').status, 400)
        self.assertEqual(self.app.devices.call_count, 1)

    def test_explicit_post_requires_matching_signed_body_csrf_admin_and_no_query(self):
        path = '/netmap/api/devices/1/collect'
        body = {'version': 'W/"2026-11-06T00:00:00+00:00"'}
        for kwargs in ({'admin': False}, {'csrf': False}, {'tamper': True}):
            with self.subTest(kwargs=kwargs):
                self.assertIn(self.request(path, 'POST', body, **kwargs).status, (401, 403))
        self.assertEqual(self.request(path + '?force=1', 'POST', body).status, 400)
        self.app.mutation.assert_not_called()
        self.assertEqual(self.request(path, 'POST', body).status, 200)
        self.assertEqual(self.app.mutation.call_args.args[:2], ('/api/devices/1/collect', body))


if __name__ == '__main__':
    unittest.main()
