"""A valid native request cohort must reach admission before listen overflow."""
import importlib.util
from pathlib import Path
import socket
import socketserver
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('pl_controller_backlog', Path(__file__).resolve().parents[1] / 'module-controller.py')
pl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pl)


class ListenBacklogTests(unittest.TestCase):
    def test_independent_native_lanes_fit_before_accept_resumes(self):
        # Model one scheduler pause in the accept loop. These connections send
        # no request data; authentication and per-lane admission still happen in
        # the regular handler after acceptance. Real Unix sockets prove queue
        # capacity rather than asserting only a class attribute.
        cohort = 4 + 8 + 32  # Ordinary requests, static assets, SSE connections.
        # Older deployed Python uses five. Force that inherited default even on
        # newer Python releases whose standard library increased the default.
        with tempfile.TemporaryDirectory(prefix='pl-listen-') as temporary, \
                patch.object(socketserver.UnixStreamServer, 'request_queue_size', 5):
            path = str(Path(temporary).resolve() / 'control.sock')
            with pl.Server(path, socketserver.BaseRequestHandler) as server:
                clients, errors = [], []
                try:
                    for _ in range(cohort):
                        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        client.setblocking(False)
                        clients.append(client)
                        error = client.connect_ex(path)
                        if error:
                            errors.append(error)
                    self.assertEqual(errors, [], 'native cohort overflowed the controller listen queue before admission')
                    self.assertLessEqual(server.request_queue_size, 128, 'listen queue must remain bounded')
                finally:
                    for client in clients:
                        client.close()


if __name__ == '__main__':
    unittest.main()
