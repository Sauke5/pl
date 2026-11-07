"""Real signed v2 descriptor path; no inventory, credentials, poll or network IO."""
import base64
import hashlib
import hmac
import json
import time
import unittest
from unittest.mock import Mock

import test_netmap_gitea_routing as routing

service = routing.service


class NetMapDescriptor(unittest.TestCase):
    def setUp(self):
        self.key = b'7' * 32
        self.app = service.Application.__new__(service.Application)
        self.app.config = {'origin': 'https://pl.example', 'platform_origin': 'https://pl.example',
                           'token': 'private-api-token', 'source_password': 'private-collector-password'}
        self.app.verifier = service.GatewayVerifier(self.key)
        self.app.netbox, self.app.store = Mock(), Mock()
        self.app.bootstrap, self.app.start_poll, self.app.mutation = Mock(), Mock(), Mock()
        self.handler_type = service.make_handler(self.app, routing.MemoryHandler)

    def request(self, *, key=None, method='GET', query=''):
        path = '/netmap/api/instance' + ('?' + query if query else '')
        handler = self.handler_type(path)
        handler.command = method
        encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')
        now = int(time.time())
        claims = {'v': 2, 'aud': 'netmap', 'iat': now, 'exp': now + 30, 'nonce': encode(b'n' * 24),
                  'sub': 'service:netmap-probe', 'name': 'PL readiness', 'admin': False,
                  'scopes': ['netmap:read'], 'method': method, 'uri': path, 'content_type': '',
                  'body_sha256': hashlib.sha256(b'').hexdigest(), 'idempotency_key': '',
                  'source_ip': '127.0.0.1', 'csrf_token': encode(b'c' * 32), 'csrf_verified': False}
        assertion = encode(json.dumps(claims, separators=(',', ':')).encode())
        handler.headers['X-PL-Gateway-Assertion'] = assertion
        handler.headers['X-PL-Gateway-Signature'] = encode(hmac.digest(key or self.key, b'pl-gateway-v2\n' + assertion.encode(), 'sha256'))
        handler.dispatch()
        return handler

    def test_signed_descriptor_is_exact_and_has_no_bootstrap_or_collection_side_effect(self):
        response = self.request()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.wfile.getvalue()), {
            'module': 'netmap', 'protocol': 'pl-gateway-v2', 'version': service.NETMAP_VERSION, 'platform_origin': 'https://pl.example'})
        for dependency in (self.app.netbox, self.app.store, self.app.bootstrap, self.app.start_poll, self.app.mutation):
            self.assertEqual(dependency.mock_calls, [])
        head = self.request(method='HEAD')
        self.assertEqual((head.status, head.wfile.getvalue()), (200, b''))

    def test_legacy_origin_fallback_does_not_mutate_configuration(self):
        self.app.config.pop('platform_origin')
        original = self.app.config.copy()
        self.assertEqual(json.loads(self.request().wfile.getvalue())['platform_origin'], original['origin'])
        self.assertEqual(self.app.config, original)

    def test_wrong_key_unsigned_query_and_write_never_disclose_descriptor(self):
        unsigned = self.handler_type('/netmap/api/instance')
        unsigned.dispatch()
        self.assertEqual(unsigned.status, 401)
        self.assertEqual(self.request(key=b'x' * 32).status, 401)
        self.assertEqual(self.request(query='origin=foreign').status, 400)
        self.assertEqual(self.request(method='POST').status, 403)
        self.app.mutation.assert_not_called()
        self.app.config['platform_origin'] = 'https://old.example'
        self.assertEqual(self.request().status, 400)


if __name__ == '__main__':
    unittest.main()
