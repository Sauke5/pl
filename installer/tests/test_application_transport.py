"""Signed native transport framing. Run by laboratory CI, without Docker."""
import base64
import hashlib
import hmac
import http.client
import importlib.util
import io
import json
from email.message import Message
import os
import tempfile
import threading
import socket
from contextlib import ExitStack
from pathlib import Path
import time
import types
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('pl_transport_test', Path(__file__).resolve().parents[1] / 'module-controller.py')
pl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pl)
KEY = bytes(range(32))


class SignedTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        disk = patch.object(pl.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=8 * 1024**3))
        disk.start(); self.addCleanup(disk.stop)

    def forms_handler(self, raw, path='/v1/forms/request', length=None):
        handler = object.__new__(pl.Handler)
        handler.command, handler.path = 'POST', path
        stamp = str(int(time.time()))
        mac = hmac.new(KEY, (stamp + '\nPOST\n' + path + '\n').encode() + raw, hashlib.sha256).hexdigest()
        handler.headers = Message()
        for key, value in {'Content-Length': str(len(raw) if length is None else length),
                           'X-PL-Timestamp': stamp, 'X-PL-Signature': mac}.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(raw)
        handler.reply = Mock()
        handler.server = types.SimpleNamespace(key=KEY, controller=Mock())
        handler.server.controller.application.return_value.request.return_value = {'ok': True}
        return handler

    def test_forms_base64_envelope_accepts_three_mib_and_exact_five_mib_boundary(self):
        payload = {'body': base64.b64encode(b'a' * (3 * 1024**2)).decode(),
                   'instance_id': '123e4567-e89b-42d3-a456-426614174000'}
        raw = json.dumps(payload).encode()
        self.assertGreater(len(raw), 4 * 1024**2)
        for body in (raw, raw + b' ' * (5 * 1024**2 - len(raw))):
            with self.subTest(bytes=len(body)):
                handler = self.forms_handler(body)
                handler.handle_request()
                handler.reply.assert_called_once_with(200, {'ok': True})
                handler.server.controller.application.assert_called_once_with('forms')
                handler.server.controller.application.return_value.request.assert_called_once_with(payload)

    def test_installation_settings_use_signed_finite_routes_and_typed_safe_errors(self):
        path = '/v1/installation/configure'
        handler = self.forms_handler(b'{}', path=path)
        expected = {'core_api': 1, 'revision': 0, 'public_url': 'https://pl.example.test', 'operation': {'phase': 'queued'}}
        settings = handler.server.controller.delivery.return_value.installation_settings.return_value
        settings.configure.return_value = expected
        handler.handle_request()
        handler.reply.assert_called_once_with(200, expected)
        settings.configure.assert_called_once_with({})
        failure = ValueError('private path and key material')
        failure.public_code, failure.public_message, failure.status = 'installation_conflict', 'Настройки уже изменились.', 409
        handler = self.forms_handler(b'{}', path=path)
        handler.server.controller.delivery.return_value.installation_settings.return_value.configure.side_effect = failure
        handler.handle_request()
        handler.reply.assert_called_once_with(409, {'error': {'code': 'installation_conflict', 'message': 'Настройки уже изменились.'}})

    def test_installation_rpc_limit_and_auth_precede_settings_controller(self):
        handler = self.forms_handler(b' ' * (384 * 1024 + 1), path='/v1/installation/configure')
        handler.handle_request()
        handler.server.controller.delivery.assert_not_called()
        handler = self.forms_handler(b'{}', path='/v1/installation/status')
        handler.headers.replace_header('X-PL-Signature', '0' * 64)
        handler.handle_request()
        handler.reply.assert_called_once_with(403, {'error': 'Controller authentication refused'})
        handler.server.controller.delivery.assert_not_called()

    def test_forms_rpc_limit_does_not_expand_other_routes_or_allow_next_byte(self):
        for path, length in (('/v1/forms/request', 5 * 1024**2 + 1),
                             ('/v1/host/status', 1024**2 + 1)):
            handler = self.forms_handler(b'{}', path, length)
            handler.handle_request()
            self.assertEqual(handler.reply.call_args.args[0], 400)
            self.assertEqual(handler.rfile.tell(), 0)
            handler.server.controller.application.assert_not_called()
            handler.server.controller.host_status.assert_not_called()

    def test_large_forms_envelope_still_requires_valid_mac(self):
        handler = self.forms_handler(json.dumps({'body': 'x' * (2 * 1024**2)}).encode())
        handler.headers.replace_header('X-PL-Signature', '0' * 64)
        handler.handle_request()
        handler.reply.assert_called_once_with(403, {'error': 'Controller authentication refused'})
        handler.server.controller.application.assert_not_called()

    def handler(self, body=b'', **changes):
        metadata = {'instance_id': '123e4567-e89b-42d3-a456-426614174000', 'role': 'api',
                    'method': 'POST', 'path': '/api/doska/context', 'query': '',
                    'content_type': 'application/json', 'headers': {}, 'body_length': len(body),
                    'body_sha256': hashlib.sha256(body).hexdigest()}
        metadata.update(changes)
        raw = json.dumps(metadata, separators=(',', ':')).encode()
        timestamp = str(int(time.time()))
        signature = hmac.new(KEY, (timestamp + '\nPOST\n/v1/doska/transport\n').encode() + raw, hashlib.sha256).hexdigest()
        handler = object.__new__(pl.Handler)
        handler.path = '/v1/doska/transport'
        handler.command = 'POST'
        handler.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(len(body)),
                           'X-PL-Timestamp': timestamp, 'X-PL-Signature': signature,
                           'X-PL-Transport-Meta': base64.b64encode(raw).decode()}
        handler.rfile = io.BytesIO(body)
        handler.reply = Mock()
        handler.server = types.SimpleNamespace(key=KEY, controller=Mock())
        handler.server.controller.root = self.root
        handler.server.controller.docker.return_value = json.dumps(str(self.root)).encode()
        return handler, metadata

    def test_bad_mac_rejected_before_body_is_read(self):
        handler, _ = self.handler(b'private attachment')
        handler.headers['X-PL-Signature'] = '0' * 64
        handler.handle_doska_transport()
        self.assertEqual(handler.rfile.tell(), 0)
        handler.reply.assert_called_once_with(403, {'error': 'Controller authentication refused'})
        handler.server.controller.application.assert_not_called()

    def test_signed_metadata_does_not_allow_body_tampering(self):
        handler, _ = self.handler(b'original')
        handler.rfile = io.BytesIO(b'tampered')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            handler.handle_doska_transport()
        handler.server.controller.application.assert_not_called()

    def test_short_body_is_not_forwarded(self):
        handler, _ = self.handler(b'original')
        handler.rfile = io.BytesIO(b'short')
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            handler.handle_doska_transport()
        handler.server.controller.application.assert_not_called()

    def test_length_and_chunked_framing_rejected_before_read(self):
        for changes, headers in [({'body_length': True}, {}), ({'body_length': 26 * 1024 * 1024 + 1}, {}),
                                 ({}, {'Content-Length': '1'}), ({}, {'Transfer-Encoding': 'chunked'})]:
            with self.subTest(changes=changes, headers=headers):
                handler, _ = self.handler(**changes)
                handler.headers.update(headers)
                with self.assertRaises(ValueError):
                    handler.handle_doska_transport()
                self.assertEqual(handler.rfile.tell(), 0)
                handler.server.controller.application.assert_not_called()

    def test_verified_body_is_rewound_and_spool_closed(self):
        body = b'x' * (128 * 1024 + 17)
        handler, metadata = self.handler(body)
        captured = []
        def forward(actual, spool, response):
            self.assertEqual(actual, metadata)
            self.assertIs(response, handler)
            self.assertEqual(spool.tell(), 0)
            self.assertEqual(spool.read(), body)
            captured.append(spool)
        handler.server.controller.application.return_value.transport.side_effect = forward
        handler.handle_doska_transport()
        handler.server.controller.application.assert_called_once_with('doska')
        self.assertTrue(captured[0].closed)

    def test_stream_failure_does_not_append_an_error_document(self):
        handler, _ = self.handler()
        def forward(*args):
            handler._response_started = True
            raise OSError('client disconnected')
        handler.server.controller.application.return_value.transport.side_effect = forward
        handler.handle_request()
        self.assertTrue(handler.close_connection)
        handler.reply.assert_not_called()

    def sftpgo(self, body=b'', **changes):
        metadata = {'instance_id': '123e4567-e89b-42d3-a456-426614174000', 'action': 'file-upload',
                    'actor': {'subject': 'local:alice', 'admin': False, 'session_key': 'a' * 64},
                    'payload': {'path': '/data.txt'}, 'body_length': len(body), 'body_sha256': hashlib.sha256(body).hexdigest()}
        metadata.update(changes)
        handler, _ = self.handler(body)
        handler.path = '/v1/sftpgo/stream'
        raw = json.dumps(metadata, separators=(',', ':')).encode()
        timestamp = handler.headers['X-PL-Timestamp']
        handler.headers['X-PL-Signature'] = hmac.new(KEY, (timestamp + '\nPOST\n' + handler.path + '\n').encode() + raw, hashlib.sha256).hexdigest()
        handler.headers['X-PL-Transport-Meta'] = base64.b64encode(raw).decode()
        return handler, metadata

    def json_rpc(self, payload):
        raw = json.dumps(payload, separators=(',', ':')).encode()
        handler, _ = self.handler(raw)
        handler.path = '/v1/sftpgo/request'
        handler.headers.pop('X-PL-Transport-Meta')
        handler.headers['Content-Type'] = 'application/json'
        timestamp = handler.headers['X-PL-Timestamp']
        handler.headers['X-PL-Signature'] = hmac.new(KEY, (timestamp + '\nPOST\n' + handler.path + '\n').encode() + raw, hashlib.sha256).hexdigest()
        return handler

    def test_only_read_lock_contention_has_finite_busy503(self):
        payload = {'instance_id': '123e4567-e89b-42d3-a456-426614174000', 'path': '/api/v1/targets', 'query': ''}
        for error, status in ((pl.ControllerBusy('private diagnostic'), 503), (ValueError('private diagnostic'), 400)):
            with self.subTest(error=type(error).__name__):
                handler = self.json_rpc(payload)
                handler.path = '/v1/read'
                raw = json.dumps(payload, separators=(',', ':')).encode()
                timestamp = handler.headers['X-PL-Timestamp']
                handler.headers['X-PL-Signature'] = hmac.new(KEY, (timestamp + '\nPOST\n/v1/read\n').encode() + raw, hashlib.sha256).hexdigest()
                handler.server.controller.read.side_effect = error
                handler.handle_request()
                self.assertEqual(handler.reply.call_args.args[0], status)
                result = handler.reply.call_args.args[1]
                self.assertNotIn('private diagnostic', str(result))
                if status == 503:
                    self.assertEqual(result, {'error': {'code': 'controller_busy', 'message': 'Module controller busy; retry the read'}})
                else:
                    self.assertNotIn('controller_busy', str(result))

    def test_sftpgo_json_rpc_keeps_domain_status_inside_http200(self):
        payload = {'instance_id': '123e4567-e89b-42d3-a456-426614174000', 'action': 'files-list',
                   'actor': {'subject': 'local:alice', 'admin': False, 'session_key': 'a' * 64}, 'payload': {'path': '/'}}
        handler = self.json_rpc(payload)
        result = {'instance_id': payload['instance_id'], 'status': 401, 'body': {'error': {'code': 'authentication_required', 'message': 'Войдите заново'}}}
        handler.server.controller.application.return_value.request.return_value = result
        handler.handle_request()
        handler.server.controller.application.assert_called_once_with('sftpgo')
        handler.server.controller.application.return_value.request.assert_called_once_with(payload)
        handler.reply.assert_called_once_with(200, result)

    def test_sftpgo_json_rpc_tamper_cannot_invoke_child(self):
        handler = self.json_rpc({'action': 'status'})
        handler.rfile = io.BytesIO(b'{"action":"remove"}')
        handler.handle_request()
        handler.server.controller.application.assert_not_called()
        self.assertEqual(handler.reply.call_args.args[0], 403)

    def test_sftpgo_stream_verified_metadata_body_forwarded_and_spool_is_disk(self):
        body = b'private-file-content'
        handler, metadata = self.sftpgo(body)
        captured = []
        def forward(actual, spool, response):
            self.assertEqual(actual, metadata)
            self.assertEqual(spool.tell(), 0)
            self.assertEqual(spool.read(), body)
            self.assertIs(response, handler)
            captured.append(spool)
        handler.server.controller.application.return_value.stream.side_effect = forward
        with patch.object(pl.tempfile, 'TemporaryFile', wraps=tempfile.TemporaryFile) as temporary:
            handler.handle_request()
        self.assertEqual(Path(temporary.call_args.kwargs['dir']), self.root / 'modules/transfers')
        self.assertTrue(captured[0].closed)
        handler.server.controller.application.assert_called_once_with('sftpgo')

    def test_signature_is_bound_to_exact_stream_route(self):
        handler, _ = self.handler(b'sensitive')
        handler.path = '/v1/sftpgo/stream'
        handler.handle_request()
        self.assertEqual(handler.rfile.tell(), 0)
        self.assertEqual(handler.reply.call_args.args[0], 403)
        handler.server.controller.application.assert_not_called()

    def test_stream_native_errors_are_safe_finite_statuses(self):
        for status in (400, 401, 403, 404, 409, 429, 503):
            with self.subTest(status=status):
                handler, _ = self.sftpgo()
                error = ValueError('password=private native response')
                error.status = status
                handler.server.controller.application.return_value.stream.side_effect = error
                handler.handle_request()
                self.assertEqual(handler.reply.call_args.args[0], status)
                self.assertNotIn('private', str(handler.reply.call_args))
                self.assertTrue(handler.close_connection)

    def test_sftpgo_stream_error_after_headers_never_appends_json(self):
        handler, _ = self.sftpgo()
        def forward(*args):
            handler._response_started = True
            error = ValueError('native private error'); error.status = 403
            raise error
        handler.server.controller.application.return_value.stream.side_effect = forward
        handler.handle_request()
        handler.reply.assert_not_called()
        self.assertTrue(handler.close_connection)

    def test_duplicate_signed_framing_headers_are_rejected(self):
        for header in ('Content-Length', 'Content-Type', 'X-PL-Transport-Meta', 'X-PL-Timestamp', 'X-PL-Signature'):
            with self.subTest(header=header):
                handler, _ = self.sftpgo(b'private')
                original = handler.headers
                headers = Message()
                for key, value in original.items():
                    headers[key] = value
                headers[header] = original[header]
                handler.headers = headers
                handler.handle_request()
                self.assertEqual(handler.rfile.tell(), 0)
                handler.server.controller.application.assert_not_called()

    def test_one_gib_boundary_rejects_oversize_before_spool_admission(self):
        for length, accepted in ((1024**3, True), (1024**3 + 1, False)):
            with self.subTest(length=length):
                handler, _ = self.sftpgo(body_length=length)
                handler.headers['Content-Length'] = str(length)
                with patch.object(pl, 'application_spool', side_effect=ValueError('admitted fixture boundary')) as admission:
                    handler.handle_request()
                self.assertEqual(admission.called, accepted)
                self.assertEqual(handler.rfile.tell(), 0)
                handler.server.controller.application.assert_not_called()

    def test_insufficient_disk_rejects_before_read_or_spooling(self):
        handler, _ = self.sftpgo(b'private')
        with patch.object(pl.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=pl.TRANSFER_RESERVE)):
            handler.handle_request()
        self.assertEqual(handler.reply.call_args.args[0], 503)
        self.assertEqual(handler.rfile.tell(), 0)
        handler.server.controller.application.assert_not_called()

    def test_shared_filesystem_reserves_spool_and_native_destination(self):
        controller = types.SimpleNamespace(root=self.root, docker=Mock(return_value=json.dumps(str(self.root)).encode()))
        length = 1024 * 1024
        # Enough for one spool, insufficient for spool plus the native upload.
        with patch.object(pl.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=pl.TRANSFER_RESERVE + length)):
            with self.assertRaises(pl.TransferRefused) as caught:
                with pl.application_spool(controller, length, 'sftpgo', 'file-upload'):
                    self.fail('insufficient double-write headroom admitted')
        self.assertEqual(caught.exception.status, 503)

    def test_concurrent_stream_is_rejected_before_body_and_slot_is_released(self):
        controller = types.SimpleNamespace(root=self.root, docker=Mock(return_value=json.dumps(str(self.root)).encode()))
        with pl.application_spool(controller, 0, 'sftpgo', 'file-download'):
            handler, _ = self.sftpgo(b'pending file')
            handler.handle_request()
            self.assertEqual(handler.reply.call_args.args[0], 429)
            self.assertEqual(handler.rfile.tell(), 0)
            handler.server.controller.application.assert_not_called()
        # Failure/return must release admission and close the previous spool.
        with pl.application_spool(controller, 0, 'sftpgo', 'file-download') as spool:
            self.assertFalse(spool.closed)
        self.assertTrue(spool.closed)

    def test_file_lock_excludes_another_controller_admission(self):
        controller = types.SimpleNamespace(root=self.root)
        transfers = self.root / 'modules/transfers'
        transfers.mkdir(parents=True, mode=0o700)
        lock = transfers / 'admission.lock'
        with lock.open('w') as stream:
            lock.chmod(0o600)
            pl.fcntl.flock(stream, pl.fcntl.LOCK_EX | pl.fcntl.LOCK_NB)
            with self.assertRaises(pl.TransferRefused) as caught:
                with pl.application_spool(controller, 0, 'doska', ''):
                    self.fail('competing controller file lock accepted')
            self.assertEqual(caught.exception.status, 429)
        with pl.application_spool(controller, 0, 'doska', '') as spool:
            self.assertFalse(spool.closed)

    def test_authenticated_get_observation_does_not_require_content_length(self):
        handler, _ = self.handler()
        handler.command = 'GET'
        handler.path = '/v1/instances/123e4567-e89b-42d3-a456-426614174000'
        handler.headers.pop('Content-Length')
        timestamp = handler.headers['X-PL-Timestamp']
        handler.headers['X-PL-Signature'] = hmac.new(KEY, (timestamp + '\nGET\n' + handler.path + '\n').encode(), hashlib.sha256).hexdigest()
        handler.server.controller.get.return_value = {'state': 'running'}
        handler.handle_request()
        handler.server.controller.get.assert_called_once_with('123e4567-e89b-42d3-a456-426614174000')
        handler.reply.assert_called_once_with(200, {'state': 'running'})

    def test_existing_spool_permission_drift_is_rejected(self):
        controller = types.SimpleNamespace(root=self.root)
        transfers = self.root / 'modules/transfers'
        transfers.mkdir(parents=True, mode=0o700)
        transfers.chmod(0o755)
        with self.assertRaises(ValueError):
            with pl.application_spool(controller, 0, 'doska', ''):
                self.fail('nonprivate spool accepted')


    def test_empty_doska_uses_no_disk_and_rejects_bad_digest(self):
        handler, _ = self.handler(method='GET', content_type='', body_sha256='0' * 64)
        with patch.object(pl, 'application_spool') as disk:
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                handler.handle_doska_transport()
        disk.assert_not_called()
        handler.server.controller.application.assert_not_called()
        handler, _ = self.handler(method='GET', content_type='')
        captured = []
        handler.server.controller.application.return_value.transport.side_effect = lambda meta, body, _: captured.append(body)
        with patch.object(pl, 'application_spool') as disk:
            handler.handle_doska_transport()
        disk.assert_not_called()
        self.assertIsInstance(captured[0], io.BytesIO)
        self.assertTrue(captured[0].closed)

    def test_empty_lanes_are_bounded_independent_and_release_on_error(self):
        _, ordinary = self.handler(method='GET', content_type='')
        events = dict(ordinary, path='/api/doska/events', query='')
        for metadata, capacity in ((ordinary, 4), (events, 32)):
            with self.subTest(events=metadata is events):
                with ExitStack() as held:
                    for _ in range(capacity):
                        held.enter_context(pl.doska_empty_input(metadata))
                    with self.assertRaises(pl.TransferRefused) as caught:
                        with pl.doska_empty_input(metadata):
                            self.fail('over-capacity empty request admitted')
                    self.assertEqual(caught.exception.status, 429)
                    handler, _ = self.handler(method='GET', path=metadata['path'], content_type='')
                    handler.handle_request()
                    self.assertEqual(handler.reply.call_args.args[0], 400)
                    handler.server.controller.application.assert_not_called()
                    other = events if metadata is ordinary else ordinary
                    with pl.doska_empty_input(other):
                        pass
                with self.assertRaisesRegex(OSError, 'disconnect'):
                    with pl.doska_empty_input(metadata):
                        raise OSError('disconnect')
                with ExitStack() as reacquired:
                    for _ in range(capacity):
                        reacquired.enter_context(pl.doska_empty_input(metadata))

    def test_real_unix_http_sse_does_not_block_get_or_positive_post(self):
        ready, release = threading.Event(), threading.Event()
        captured = []
        def forward(meta, body, handler):
            if meta['path'] == '/api/doska/events':
                self.assertEqual(body.read(), b'')
                captured.append(body)
                handler.send_response(200)
                handler.send_header('Content-Type', 'text/event-stream')
                handler.send_header('Connection', 'close')
                handler.close_connection = True
                handler.end_headers()
                handler.wfile.write(b'event: ready\ndata: {}\n\n')
                handler.wfile.flush()
                ready.set()
                release.wait(5)
                return
            self.assertEqual(body.read(), b'payload' if meta['method'] == 'POST' else b'')
            handler.reply(200, {'ok': True})
        controller = Mock()
        controller.root = self.root
        controller.application.return_value.transport.side_effect = forward
        path = str(self.root / 'transport.sock')
        server = pl.Server(path, pl.Handler)
        server.controller, server.key = controller, KEY
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 3)
        self.addCleanup(server.shutdown)
        self.addCleanup(release.set)
        def call(body=b'', **changes):
            signed, _ = self.handler(body, **changes)
            connection = http.client.HTTPConnection('localhost', timeout=3)
            peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            peer.settimeout(3)
            peer.connect(path)
            connection.sock = peer
            self.addCleanup(connection.close)
            connection.request('POST', signed.path, body=body, headers=signed.headers)
            return connection.getresponse()
        stream = call(method='GET', path='/api/doska/events', content_type='')
        self.assertEqual(stream.status, 200)
        self.assertTrue(ready.wait(2))
        self.assertEqual(stream.readline(), b'event: ready\n')
        response = call(method='GET', content_type='')
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read()), {'ok': True})
        response = call(b'payload', method='POST')
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read()), {'ok': True})
        release.set()
        stream.read()
        self.assertTrue(captured[0].closed)
        # End-of-stream cleanup releases admission for the complete next cohort.
        _, metadata = self.handler(method='GET', path='/api/doska/events', content_type='')
        with ExitStack() as held:
            for _ in range(32):
                held.enter_context(pl.doska_empty_input(metadata))



if __name__ == '__main__':
    unittest.main()
