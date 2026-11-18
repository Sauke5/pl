import importlib.util
import http.server
import ipaddress
import os
import socket
import ssl
import subprocess
import tempfile
import threading
from pathlib import Path
from unittest import TestCase, mock

spec = importlib.util.spec_from_file_location("discover_vpn", Path(__file__).resolve().parents[1] / "ocserv-discovery.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class AddressDiscovery(TestCase):
    def detect(self, addresses, bind, observer="", used=()):
        with (mock.patch.object(discovery, "local_inventory", return_value=(addresses, list(map(ipaddress.IPv4Network, used)), bind)),
              mock.patch.object(discovery, "observed_ip", return_value=observer) as probe):
            result = discovery.discover()
        return result, probe

    def test_direct_interface_skips_observer_and_occupied_pool(self):
        result, probe = self.detect(["10.2.3.4", "8.8.8.8"], "10.2.3.4", used=["10.77.0.0/24"])
        self.assertEqual((result["public_ip"], result["source"], result["bind_address"], result["pool"]),
                         ("8.8.8.8", "interface", "10.2.3.4", "10.77.1.0/24"))
        probe.assert_not_called()

    def test_nat_and_disconnected(self):
        for remote, source in (("1.1.1.1", "external"), ("", "unavailable")):
            result, probe = self.detect(["100.64.0.2"], "100.64.0.2", remote)
            self.assertEqual((result["public_ip"], result["bind_address"], result["source"]), (remote, "100.64.0.2", source))
            probe.assert_called_once_with()

    def test_reflector_rejects_nonpublic_and_redirects(self):
        for payload, status in ((b"127.0.0.1", 200), (b"100.64.1.1", 200), (b"224.1.2.3", 200),
                                (b"192.0.2.5", 200), (b"1.1.1.1\n2.2.2.2", 200), (b"8.8.8.8", 302)):
            with self.subTest(payload=payload), mock.patch.object(discovery.http.client, "HTTPSConnection") as create:
                response = create.return_value.getresponse.return_value
                response.status, response.read.return_value = status, payload
                self.assertEqual(discovery.observed_ip(), "")
                self.assertEqual(create.call_args.args, ("api.ipify.org",))
                self.assertEqual(create.return_value.request.call_count, 1)
                create.return_value.close.assert_called_once_with()

    def test_nat_observer_over_verified_https(self):
        """A private host queries the fixed observer through a real TLS connection."""
        class Observer(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"93.184.216.34\n")

            def log_message(self, *_):
                pass

        with tempfile.TemporaryDirectory() as tmp:
            cert, key = (Path(tmp) / name for name in ("observer.crt", "observer.key"))
            subprocess.run(["openssl", "req", "-newkey", "rsa:2048", "-x509", "-nodes", "-days", "1",
                            "-subj", "/CN=api.ipify.org", "-addext", "subjectAltName=DNS:api.ipify.org",
                            "-out", str(cert), "-keyout", str(key)], capture_output=True, check=True)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            with http.server.HTTPServer(("127.0.0.1", 0), Observer) as server:
                server.socket = tls.wrap_socket(server.socket, server_side=True)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                connect = socket.create_connection
                def route(address, *args, **kwargs):
                    self.assertEqual(address, ("api.ipify.org", 443))
                    return connect(server.server_address, *args, **kwargs)
                try:
                    with (mock.patch.dict(os.environ, {"SSL_CERT_FILE": str(cert)}),
                          mock.patch.object(socket, "create_connection", side_effect=route),
                          mock.patch.object(discovery, "local_inventory", return_value=(["10.2.3.4"], [], "10.2.3.4"))):
                        result = discovery.discover()
                    self.assertEqual((result["public_ip"], result["source"], result["bind_address"]),
                                     ("93.184.216.34", "external", "10.2.3.4"))
                finally:
                    server.shutdown()
                    thread.join()
