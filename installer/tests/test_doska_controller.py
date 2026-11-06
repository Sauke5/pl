"""Portable Doska module trust/stream contracts; executed in laboratory CI."""
import contextlib
import hashlib
import hmac
import importlib.util
import io
from pathlib import Path
import types
import threading
import time
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('pl_doska_test', Path(__file__).resolve().parents[1] / 'doska-controller.py')
doska = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doska)
INSTANCE = '123e4567-e89b-42d3-a456-426614174000'
SIGNED = {'X-PL-Gateway-Assertion': 'assertion', 'X-PL-Gateway-Signature': 'signature'}


class RequestTests(unittest.TestCase):
    def test_no_arbitrary_target_native_auth_or_browser_identity(self):
        for role, path, headers in [('api', '/api/auth/sign-in', SIGNED), ('database', '/api/doska/context', SIGNED),
                ('api', '/api/doska/context', {**SIGNED, 'Cookie': 'browser-session'}),
                ('api', '/api/doska/context', {}), ('api', '/api/doska/%2e%2e/auth', SIGNED),
                ('web', '/doska/api/doska/context', SIGNED)]:
            with self.subTest(role=role, path=path), self.assertRaises(ValueError):
                doska.allowed_request(role, 'GET', path, '', '', b'', headers)
        doska.allowed_request('api', 'GET', '/api/doska/context', '', '', b'', SIGNED)
        doska.allowed_request('web', 'GET', '/doska/assets/app.js', '', '', b'', SIGNED)

    def test_gateway_and_directory_secrets_are_separate_and_instance_bound(self):
        controller = object.__new__(doska.DoskaController)
        controller.root = Path('/owned')
        master = bytes(range(32))
        state = {'database_password': 'a' * 64, 'auth_secret': 'b' * 64}
        with patch.object(doska, 'read_file', return_value=master) as read:
            credentials = controller.credentials(INSTANCE, state)
            other = controller.credentials('223e4567-e89b-42d3-a456-426614174000', state)
        self.assertEqual(credentials['gateway_key'], hmac.new(master, ('pl-module-key-v1\ndoska\n' + INSTANCE).encode(), hashlib.sha256).digest())
        self.assertNotEqual(credentials['gateway_key'], credentials['directory_token'])
        self.assertNotEqual(credentials['gateway_key'], other['gateway_key'])
        self.assertEqual(len(credentials['directory_token']), 64)
        self.assertEqual(credentials['database_password'], credentials['postgres_password'])
        read.assert_called_with(Path('/owned/private/module-controller-key'), mode=0o640)


class TransportTests(unittest.TestCase):
    def controller(self):
        controller = object.__new__(doska.DoskaController)
        controller.instance_lock = lambda instance: contextlib.nullcontext()
        controller.inspect = Mock(return_value={'State': {'Running': True}})
        controller.endpoint = Mock(return_value='http://127.0.0.1:33201')
        objects = {role: {'State': {'Running': True}} for role in doska.ROLES}
        origins = {role: 'http://127.0.0.1:33201' for role in ('api', 'web')}
        controller._routes = {INSTANCE: (time.monotonic(), objects, origins)}
        controller._route_lock = threading.RLock()
        return controller

    def meta(self, raw=b'', **changes):
        value = {'instance_id': INSTANCE, 'role': 'api', 'method': 'GET', 'path': '/api/doska/context',
                 'query': '', 'content_type': '', 'headers': SIGNED, 'body_length': len(raw),
                 'body_sha256': hashlib.sha256(raw).hexdigest()}
        value.update(changes)
        return value

    def test_warm_api_asset_and_sse_do_not_inspect_or_probe_health(self):
        controller = self.controller()
        controller.http = Mock(side_effect=AssertionError('warm request must not probe health'))
        for meta in (self.meta(), self.meta(role='web', path='/doska/assets/app.css', headers={}),
                     self.meta(path='/api/doska/events')):
            response = Mock(status=200)
            mime = 'text/event-stream' if meta['path'].endswith('/events') else 'application/json'
            response.getheader.side_effect = lambda name, default=None: mime if name == 'Content-Type' else default
            response.getheaders.return_value = [('Content-Type', mime)]
            response.read1.side_effect = [b'payload', b'']
            connection = Mock(); connection.getresponse.return_value = response
            handler = Mock(wfile=io.BytesIO())
            with patch.object(doska.http.client, 'HTTPConnection', return_value=connection):
                controller.transport(meta, io.BytesIO(), handler)
            self.assertEqual(handler.wfile.getvalue(), b'payload')
        controller.inspect.assert_not_called()
        controller.http.assert_not_called()

    def test_cold_and_expired_route_verify_once_without_cross_instance_reuse(self):
        controller = self.controller()
        controller._routes.clear()
        controller.http = Mock(return_value=(200, 'application/json', b'{}'))
        first = controller.route(INSTANCE, 'api')
        self.assertEqual(controller.inspect.call_count, len(doska.ROLES))
        self.assertEqual(controller.http.call_count, 2)
        self.assertEqual(controller.route(INSTANCE, 'web')[1], first[1])
        self.assertEqual(controller.inspect.call_count, 3)
        verified = controller._routes[INSTANCE][0]
        with patch.object(doska.time, 'monotonic', return_value=verified + doska.ROUTE_MAX_AGE):
            controller.route(INSTANCE, 'api')
            controller.route(INSTANCE, 'web')
        self.assertEqual(controller.inspect.call_count, 6)
        other = '223e4567-e89b-42d3-a456-426614174000'
        controller.inspect.side_effect = ValueError('foreign container')
        with self.assertRaises(ValueError):
            controller.route(other, 'api')
        self.assertNotIn(other, controller._routes)
        self.assertIn(INSTANCE, controller._routes)

    def test_failed_health_or_connection_revokes_warm_route(self):
        controller = self.controller()
        controller.http = Mock(return_value=(503, 'application/json', b'{}'))
        with self.assertRaises(ValueError):
            controller.ready(INSTANCE)
        self.assertNotIn(INSTANCE, controller._routes)
        controller = self.controller()
        connection = Mock(); connection.request.side_effect = ConnectionRefusedError('native stopped')
        with patch.object(doska.http.client, 'HTTPConnection', return_value=connection), self.assertRaises(ConnectionRefusedError):
            controller.transport(self.meta(), io.BytesIO(), Mock())
        self.assertNotIn(INSTANCE, controller._routes)
        connection.close.assert_called_once()

    def test_stream_invalidation_during_verification_keeps_current_route(self):
        for expired in (False, True):
            with self.subTest(expired=expired):
                controller = self.controller()
                controller.http = Mock(return_value=(200, 'application/json', b'{}'))
                published, invalidated = threading.Event(), threading.Event()

                class InvalidatedRouteCache(dict):
                    def __setitem__(self, key, value):
                        super().__setitem__(key, value)
                        published.set()
                        if not invalidated.wait(2):
                            raise AssertionError('Concurrent stream did not invalidate its route')

                old = controller._routes[INSTANCE]
                controller._routes = InvalidatedRouteCache(
                    {INSTANCE: (time.monotonic() - doska.ROUTE_MAX_AGE, old[1], old[2])}
                    if expired else {})

                def stream_finished():
                    if published.wait(2):
                        controller._routes.pop(INSTANCE, None)
                        invalidated.set()

                thread = threading.Thread(target=stream_finished, daemon=True)
                thread.start()
                try:
                    self.assertEqual(controller.route(INSTANCE, 'api')[1], 'http://127.0.0.1:33201')
                finally:
                    thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertTrue(invalidated.is_set())
                self.assertNotIn(INSTANCE, controller._routes)
                # Invalidation still applies to later requests: they perform
                # fresh ownership and application checks, never reuse a fallback.
                controller._routes = {}
                controller.route(INSTANCE, 'api')
                self.assertEqual(controller.inspect.call_count, 2 * len(doska.ROLES))
                self.assertEqual(controller.http.call_count, 4)

    def test_lifecycle_revokes_route_before_disable_and_failed_refresh(self):
        import tempfile
        import json
        controller = self.controller()
        with tempfile.TemporaryDirectory() as temporary:
            controller.root = Path(temporary)
            controller.operations = controller.root / 'operations'; controller.operations.mkdir()
            (controller.root / 'state').mkdir()
            doska.atomic(controller.root / 'state/installation.json', {'config': {'public_url': 'https://lab.invalid'}})
            controller.instance_lock = lambda *args, **kwargs: contextlib.nullcontext()
            controller.locked = lambda: contextlib.nullcontext()
            controller.inspect = Mock(return_value={'Id': 'f' * 64, 'State': {'Running': True}})
            def stop(*args, **kwargs):
                self.assertNotIn(INSTANCE, controller._routes)
            controller.docker = Mock(side_effect=stop)
            controller.observe = Mock(return_value={'state': 'disabled'})
            operation = {'instance_id': INSTANCE, 'operation_id': '323e4567-e89b-42d3-a456-426614174000', 'module_id': 'doska', 'action': 'disable'}
            self.assertEqual(controller.execute(operation)['state'], 'disabled')
            self.assertEqual(controller.docker.call_count, 3)
            controller._routes[INSTANCE] = (time.monotonic(), {}, {})
            operation.update(action='refresh', operation_id='423e4567-e89b-42d3-a456-426614174000')
            controller.observe.side_effect = ValueError('ownership drift')
            self.assertEqual(controller.execute(operation)['state'], 'error')
            self.assertNotIn(INSTANCE, controller._routes)

    def test_digest_or_length_mismatch_never_contacts_container(self):
        controller = self.controller()
        for meta, raw in [(self.meta(), b'extra'), (self.meta(b'body', method='POST'), b'bad!'),
                          (self.meta(body_length=doska.MAX_BODY + 1), b''), (self.meta(body_length=True), b'')]:
            with self.subTest(meta=meta), patch.object(doska.http.client, 'HTTPConnection') as connect:
                with self.assertRaises(ValueError):
                    controller.transport(meta, io.BytesIO(raw), Mock())
                connect.assert_not_called()

    def test_stream_preserves_native_error_status_without_cookie_headers(self):
        controller = self.controller()
        response = Mock(status=403)
        response.getheader.side_effect = lambda name, default=None: {'Content-Type': 'application/json', 'Content-Length': '18'}.get(name, default)
        response.getheaders.return_value = [('Content-Type', 'application/json'), ('Content-Length', '18'), ('Set-Cookie', 'not-forwarded')]
        response.read1.side_effect = [b'{"error":"denied"}', b'']
        connection = Mock()
        connection.getresponse.return_value = response
        handler = Mock(wfile=io.BytesIO())
        with patch.object(doska.http.client, 'HTTPConnection', return_value=connection):
            controller.transport(self.meta(), io.BytesIO(), handler)
        handler.send_response.assert_called_once_with(403)
        self.assertEqual(handler.wfile.getvalue(), b'{"error":"denied"}')
        self.assertFalse(any(call.args[0].lower() == 'set-cookie' for call in handler.send_header.call_args_list))
        connection.close.assert_called_once()

    def test_sse_releases_instance_lock_before_reading_events(self):
        controller = self.controller()
        locked = []
        @contextlib.contextmanager
        def lock(instance):
            locked.append(True)
            try:
                yield
            finally:
                locked.pop()
        controller.instance_lock = lock
        response = Mock(status=200)
        response.getheader.side_effect = lambda name, default=None: 'text/event-stream' if name == 'Content-Type' else default
        response.getheaders.return_value = [('Content-Type', 'text/event-stream')]
        chunks = iter([b': heartbeat\n\n', b''])
        def read(size):
            self.assertEqual(locked, [])
            return next(chunks)
        response.read1.side_effect = read
        connection = Mock()
        connection.getresponse.return_value = response
        handler = Mock(wfile=io.BytesIO())
        with patch.object(doska.http.client, 'HTTPConnection', return_value=connection):
            controller.transport(self.meta(path='/api/doska/events'), io.BytesIO(), handler)
        self.assertEqual(handler.wfile.getvalue(), b': heartbeat\n\n')

    def test_conditional_304_preserves_cache_headers_without_payload(self):
        controller = self.controller()
        response = Mock(status=304)
        response.getheader.side_effect = lambda name, default=None: {'Content-Type': 'text/css', 'Content-Length': '12345'}.get(name, default)
        response.getheaders.return_value = [('Content-Type', 'text/css'), ('Content-Length', '12345'),
            ('ETag', '"asset-v2"'), ('Cache-Control', 'public, max-age=31536000, immutable'),
            ('Last-Modified', 'Wed, 21 Oct 2026 07:28:00 GMT'), ('Set-Cookie', 'forbidden')]
        response.read1.side_effect = AssertionError('304 body must not be consumed or forwarded')
        connection = Mock()
        connection.getresponse.return_value = response
        handler = Mock(wfile=io.BytesIO())
        with patch.object(doska.http.client, 'HTTPConnection', return_value=connection):
            controller.transport(self.meta(role='web', path='/doska/assets/app.css',
                headers={'If-None-Match': '"asset-v2"'}), io.BytesIO(), handler)
        handler.send_response.assert_called_once_with(304)
        handler.send_header.assert_any_call('ETag', '"asset-v2"')
        handler.send_header.assert_any_call('Cache-Control', 'public, max-age=31536000, immutable')
        self.assertEqual(handler.wfile.getvalue(), b'')
        self.assertFalse(any(call.args[0].lower() in ('content-length', 'set-cookie') for call in handler.send_header.call_args_list))
        connection.close.assert_called_once()

    def test_conditional_status_does_not_allow_redirect_or_mutation_304(self):
        controller = self.controller()
        for status, method in ((302, 'GET'), (304, 'POST')):
            controller = self.controller()
            response = Mock(status=status)
            connection = Mock()
            connection.getresponse.return_value = response
            handler = Mock(wfile=io.BytesIO())
            with self.subTest(status=status, method=method), patch.object(doska.http.client, 'HTTPConnection', return_value=connection):
                with self.assertRaises(ValueError):
                    controller.transport(self.meta(method=method), io.BytesIO(), handler)
            handler.send_response.assert_not_called()
            connection.close.assert_called_once()


class ManifestTests(unittest.TestCase):
    def test_manifest_never_accepts_foreign_version_or_public_internal_endpoint(self):
        import json
        controller = object.__new__(doska.DoskaController)
        controller.version = '2.46.2'
        controller.instance_lock = lambda instance: contextlib.nullcontext()
        controller.inspect = Mock(side_effect=AssertionError('warm manifest must not inspect Docker'))
        objects = {role: {'State': {'Running': True}} for role in doska.ROLES}
        controller._routes = {INSTANCE: (time.monotonic(), objects, {'api': 'http://127.0.0.1:33201', 'web': 'http://127.0.0.1:33202'})}
        controller._route_lock = threading.RLock()
        class Response(io.BytesIO):
            status = 200
            headers = types.SimpleNamespace(get_content_type=lambda: 'application/json')
        valid = {'version': 'pl-doska-2.46.2', 'routes': [{'method': 'GET', 'path': '/doska/assets/app.js', 'kind': 'asset'}]}
        controller.http = Mock(return_value=Response(json.dumps(valid).encode()))
        self.assertEqual(controller.manifest({'instance_id': INSTANCE}), valid)
        controller.inspect.assert_not_called()
        for manifest in [
            {'version': 'foreign', 'routes': [{'method': 'GET', 'path': '/doska/', 'kind': 'page'}]},
            {'version': 'pl-doska-2.46.2', 'routes': [{'method': 'GET', 'path': '/doska/__pl_manifest.json', 'kind': 'asset'}]},
            {'version': 'pl-doska-2.46.2', 'routes': [{'method': 'GET', 'path': '/doska/../secret', 'kind': 'asset'}]},
        ]:
            controller._routes[INSTANCE] = (time.monotonic(), objects, {'api': 'http://127.0.0.1:33201', 'web': 'http://127.0.0.1:33202'})
            controller.http = Mock(return_value=Response(json.dumps(manifest).encode()))
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                controller.manifest({'instance_id': INSTANCE})
            self.assertNotIn(INSTANCE, controller._routes)

    def test_header_normalization_preserves_finite_native_contract(self):
        normalized = doska.allowed_request('api', 'GET', '/api/doska/context', '', '', b'',
            {'X-PL-Gateway-Assertion': 'a', 'X-PL-Gateway-Signature': 'b'})
        self.assertEqual(normalized, {'X-PL-Gateway-Assertion': 'a', 'X-PL-Gateway-Signature': 'b'})
        with self.assertRaises(ValueError):
            doska.allowed_request('api', 'GET', '/api/doska/context', '', '', b'',
                {**SIGNED, 'x-pl-gateway-assertion': 'duplicate'})


if __name__ == '__main__':
    unittest.main()
