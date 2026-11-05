"""Native SSE cancellation uses real sockets, including a blocked HTTP read1."""
import http.client
import importlib.util
import io
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('doska_stream_fixture', Path(__file__).with_name('test_doska_controller.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)
doska = fixture.doska


class StreamCancellationTests(unittest.TestCase):
    def stream(self, upstream_timeout=None):
        controller = fixture.TransportTests().controller()
        upstream, native = socket.socketpair()
        client, gateway = socket.socketpair()
        for sock in (upstream, native, client, gateway):
            self.addCleanup(sock.close)
        upstream.settimeout(upstream_timeout)
        native.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n')
        response = http.client.HTTPResponse(upstream)
        response.begin()
        self.addCleanup(response.close)
        blocked = threading.Event()
        original_read = response.read1
        def read1(size):
            blocked.set()
            return original_read(size)
        response.read1 = read1
        class Connection:
            sock = upstream
            def request(self, *args, **kwargs):
                pass
            def getresponse(self):
                # Match HTTPConnection's EOF-framed response behavior: the
                # buffered response still owns the socket after this reference
                # is cleared.
                self.sock = None
                return response
            def close(self):
                response.close()
                upstream.close()
        connection = Connection()
        output = client.makefile('wb', buffering=0)
        self.addCleanup(output.close)
        handler = Mock(connection=client, wfile=output)
        finished, errors = threading.Event(), []
        def run():
            try:
                with patch.object(doska.http.client, 'HTTPConnection', return_value=connection):
                    controller.transport(fixture.TransportTests().meta(path='/api/doska/events'), io.BytesIO(), handler)
            except BaseException as error:
                errors.append(error)
            finally:
                finished.set()
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        def release():
            try:
                native.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            thread.join(2)
            self.assertFalse(thread.is_alive(), 'SSE worker did not terminate')
        self.addCleanup(release)
        self.assertTrue(blocked.wait(1), 'HTTPResponse never entered native read1')
        return controller, native, gateway, finished, errors

    def test_client_disconnect_interrupts_blocked_native_read_promptly(self):
        controller, native, gateway, finished, errors = self.stream()
        gateway.close()
        self.assertTrue(finished.wait(0.75), 'client disconnect retained SSE admission until upstream heartbeat/timeout')
        self.assertFalse(errors)
        # Client cancellation is normal; it does not revoke an otherwise valid
        # signed/owned route or affect other readers of the same instance.
        self.assertIn(fixture.INSTANCE, controller._routes)
        native.settimeout(1)
        self.assertEqual(native.recv(1), b'')

    def test_connected_idle_client_keeps_stream_and_receives_next_event(self):
        controller, native, gateway, finished, errors = self.stream()
        self.assertFalse(finished.wait(0.2))
        native.sendall(b': heartbeat\n\n')
        gateway.settimeout(1)
        self.assertEqual(gateway.recv(4096), b': heartbeat\n\n')
        native.shutdown(socket.SHUT_WR)
        self.assertTrue(finished.wait(1))
        self.assertFalse(errors)
        self.assertIn(fixture.INSTANCE, controller._routes)

    def test_native_timeout_still_revokes_route_and_stops_disconnect_watcher(self):
        controller, native, gateway, finished, errors = self.stream(upstream_timeout=0.15)
        self.assertTrue(finished.wait(1))
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], OSError)
        self.assertNotIn(fixture.INSTANCE, controller._routes)
        self.assertFalse(any(thread.name == 'pl-doska-sse-disconnect' for thread in threading.enumerate()))

    def test_extra_input_cannot_hide_client_eof_behind_peeked_bytes(self):
        controller, native, gateway, finished, errors = self.stream()
        gateway.sendall(b'invalid pipelined input')
        gateway.close()
        self.assertTrue(finished.wait(0.75))
        self.assertFalse(errors)
