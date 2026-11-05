import importlib.util
import json
import os
import socket
import threading
import http.client
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).resolve().parents[1] / 'icmp-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.owner = patch.object(probe, 'POLICY_OWNER', os.getuid())
        self.owner.start()
        self.addCleanup(self.owner.stop)

    def fake(self, directory, body):
        path = Path(directory) / 'fake-hping'
        path.write_text(f'#!{sys.executable}\n' + body)
        path.chmod(0o700)
        return str(path)

    def test_fixed_arguments_and_all_2000_responses_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = self.fake(directory, '''import json
import socket
import threading
import http.client,sys
print('ARGV=' + json.dumps(sys.argv[1:]))
for i in range(2000): print(f'len=46 ip=10.1.2.3 icmp_seq={i} rtt=0.4 ms')
print('2000 packets transmitted, 2000 packets received, 0% packet loss')
print('round-trip min/avg/max = 0.1/0.4/1.2 ms')
''')
            status, result = probe.run_probe('10.1.2.3', binary)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(result['raw_output'].splitlines()[0][5:]),
                             ['-1', '-n', '-i', 'u2000', '-c', '2000', '10.1.2.3'])
            self.assertEqual(result['raw_output'].count('icmp_seq='), 2000)
            self.assertIn('icmp_seq=1999 ', result['raw_output'])
            self.assertEqual(result['received'], 2000)
            self.assertEqual(result['rtt_avg_ms'], 0.4)

    def test_loss_and_missing_statistics_are_distinct(self):
        output = '2000 packets transmitted, 0 packets received, 100% packet loss\nround-trip min/avg/max = 0.0/0.0/0.0 ms'
        result = probe.summary(output)
        self.assertEqual(result['loss_percent'], 100)
        self.assertIsNone(result['rtt_avg_ms'])
        for output in ['permission denied', '1000 packets transmitted, 990 packets received, 1% packet loss']:
            with self.assertRaises(ValueError): probe.summary(output)

    def test_deadline_and_output_overflow_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = self.fake(directory, "import time\nprint('partial output', flush=True)\ntime.sleep(3)\n")
            with patch.object(probe, 'DEADLINE', 1.0):
                status, result = probe.run_probe('10.1.2.3', binary)
            self.assertEqual(status, 502)
            self.assertEqual(result['error'], 'timeout')
            self.assertIn('partial output', result['raw_output'])
            binary = self.fake(directory, "print('x'*10000)\n")
            with patch.object(probe, 'OUTPUT_LIMIT', 256):
                status, result = probe.run_probe('10.1.2.3', binary)
            self.assertEqual(status, 502)
            self.assertEqual(result['error'], 'output_limit')

    def test_socket_endpoint_accepts_only_target_and_is_single_flight(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'cidrs.json'
            policy.write_text(json.dumps({'cidrs': ['10.1.2.0/24']}))
            path = str(Path(directory) / 'probe.sock')
            server = probe.Server(path, probe.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(body):
                data = json.dumps(body).encode()
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.connect(path)
                    connection.sendall(b'POST /v1/icmp HTTP/1.1\r\nHost: probe\r\nContent-Length: ' + str(len(data)).encode() + b'\r\n\r\n' + data)
                    response = http.client.HTTPResponse(connection)
                    response.begin()
                    result = (response.status, json.loads(response.read()))
                    response.close()
                    return result
            try:
                with patch.object(probe, 'POLICY', str(policy)), patch.object(probe, 'run_probe', return_value=(200, {'received': 2000})) as run:
                    self.assertEqual(request({'target': '10.1.2.3', 'count': 100})[0], 400)
                    self.assertEqual(request({'target': '--flood'})[0], 400)
                    self.assertEqual(request({'target': '8.8.8.8'})[0], 403)
                    run.assert_not_called()
                    self.assertEqual(request({'target': '10.1.2.3'})[0], 200)
                    run.assert_called_once_with('10.1.2.3')
                    probe.ACTIVE.acquire()
                    try: self.assertEqual(request({'target': '10.1.2.3'})[0], 429)
                    finally: probe.ACTIVE.release()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_policy_cannot_be_replaced_by_host_flags_or_broadcast(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'cidrs.json'
            policy.write_text(json.dumps({'cidrs': ['10.1.2.0/24', '203.0.113.10/32']}))
            self.assertTrue(probe.allowed('10.1.2.3', policy))
            self.assertTrue(probe.allowed('203.0.113.10', policy))
            for target in ['8.8.8.8', '10.1.2.255', '10.1.2.0', '127.0.0.1', '169.254.169.254', '224.0.0.1']:
                self.assertFalse(probe.allowed(target, policy))
            for target in ['--flood', 'host.example', '10.1.2.3; id', '10.1.2.3/24', '::1']:
                with self.assertRaises(ValueError): probe.allowed(target, policy)

    def test_policy_requires_safe_file_and_empty_list_denies(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'cidrs.json'
            policy.write_text('{"cidrs": []}')
            self.assertFalse(probe.allowed('10.1.2.3', policy))
            policy.chmod(0o666)
            with self.assertRaises(ValueError): probe.allowed('10.1.2.3', policy)
            policy.chmod(0o644)
            link = Path(directory) / 'link.json'
            link.symlink_to(policy)
            with self.assertRaises(OSError): probe.allowed('10.1.2.3', link)

    def test_closed_stdout_still_obeys_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = self.fake(directory, "import os,time\nos.close(1)\nos.close(2)\ntime.sleep(3)\n")
            with patch.object(probe, 'DEADLINE', 0.2):
                status, result = probe.run_probe('10.1.2.3', binary)
            self.assertEqual((status, result['error']), (502, 'timeout'))


if __name__ == '__main__': unittest.main()
