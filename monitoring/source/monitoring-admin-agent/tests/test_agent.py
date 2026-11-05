from __future__ import annotations

import json
import socket
import subprocess
import tempfile
import threading
import unittest

from agent.docker import DockerClient, _uptime_seconds
from agent.http import AgentHTTPServer
from agent.registry import SERVICES, UnknownServiceError, get_service
from agent.sanitize import MAX_LINE_CHARS, sanitize_log_lines


class RecordingRunner:
    def __init__(self, outputs: list[subprocess.CompletedProcess[str]]) -> None:
        self.outputs = outputs
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        self.calls.append(argv)
        return self.outputs.pop(0)


def completed(stdout: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], returncode, stdout, "")


def inspect_json(name: str = "prometheus") -> str:
    return json.dumps(
        [
            {
                "Name": f"/{name}",
                "RestartCount": 1,
                "State": {
                    "Status": "running",
                    "Running": True,
                    "StartedAt": "2026-07-17T10:00:00Z",
                    "Health": {"Status": "healthy"},
                },
            }
        ]
    )


class AgentTests(unittest.TestCase):
    def test_docker_rfc3339_nanoseconds_are_parsed_for_uptime(self) -> None:
        self.assertGreater(_uptime_seconds("2020-01-02T03:04:05.123456789Z"), 1)
        self.assertEqual(_uptime_seconds("not-a-timestamp"), 0)

    def test_logs_always_use_fixed_tail_and_registered_container(self) -> None:
        runner = RecordingRunner([completed("\n".join(f"line {i}" for i in range(70)))])
        client = DockerClient(runner=runner)
        lines = client.logs(get_service("prometheus"))
        self.assertEqual(
            runner.calls,
            [["/usr/bin/docker", "logs", "--tail", "50", "--timestamps", "prometheus"]],
        )
        self.assertEqual(len(lines), 50)
        self.assertEqual(lines[0], "line 20")
        self.assertEqual(lines[-1], "line 69")

    def test_restart_uses_fixed_argv_without_shell(self) -> None:
        runner = RecordingRunner([completed("prometheus\n"), completed(inspect_json())])
        result = DockerClient(runner=runner).restart(get_service("prometheus"))
        self.assertEqual(
            runner.calls[0],
            ["/usr/bin/docker", "restart", "--time", "10", "prometheus"],
        )
        self.assertEqual(runner.calls[1], ["/usr/bin/docker", "inspect", "prometheus"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["health_result"], "healthy")
        self.assertEqual(result["service"]["service_id"], "prometheus")

    def test_restart_is_denied_for_control_plane(self) -> None:
        for service_id in ("nginx", "monitoring-admin", "monitoring-admin-worker"):
            with self.subTest(service_id=service_id):
                runner = RecordingRunner([])
                with self.assertRaises(PermissionError):
                    DockerClient(runner=runner).restart(get_service(service_id))
                self.assertEqual(runner.calls, [])

    def test_restart_reports_unavailable_when_post_check_fails(self) -> None:
        runner = RecordingRunner([completed("prometheus\n"), completed("", returncode=1)])
        result = DockerClient(runner=runner, restart_wait_seconds=0).restart(
            get_service("prometheus")
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["health_result"], "unavailable")
        self.assertIsNone(result["service"])

    def test_registry_rejects_injection_targets(self) -> None:
        targets = (
            "prometheus;id",
            "../prometheus",
            "prometheus$(id)",
            "prometheus --help",
            "nginx\nalertmanager",
            "",
        )
        for service_id in targets:
            with self.subTest(service_id=service_id):
                with self.assertRaises(UnknownServiceError):
                    get_service(service_id)

    def test_registry_container_names_are_unique_and_literal(self) -> None:
        names = [service.container_name for service in SERVICES.values()]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(
            all(name.replace("-", "").replace("_", "").isalnum() for name in names)
        )

    def test_log_sanitization_redacts_and_caps_output(self) -> None:
        raw = (
            "\x1b[31mpassword=secret-value\x1b[0m\n"
            "bot token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd\n"
            "Authorization: Bearer super-secret\n"
            "https://user:pass@example.invalid/path\n"
            + "x" * (MAX_LINE_CHARS + 100)
        )
        lines = sanitize_log_lines(raw)
        joined = "\n".join(lines)
        self.assertNotIn("secret-value", joined)
        self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ", joined)
        self.assertNotIn("super-secret", joined)
        self.assertNotIn("user:pass@", joined)
        self.assertNotIn("\x1b", joined)
        self.assertEqual(len(lines[-1]), MAX_LINE_CHARS)

    def test_http_contract_rejects_tail_other_than_50(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/agent.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(path)
            listener.listen(4)
            server = AgentHTTPServer(listener, DockerClient(runner=RecordingRunner([])))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                response = _http_unix(path, b"GET /v1/services/prometheus/logs?tail=51 HTTP/1.1\r\nHost: agent\r\n\r\n")
                self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
                self.assertIn(b"invalid_tail", response)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_http_restart_body_rejects_extra_command_field(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/agent.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(path)
            listener.listen(4)
            runner = RecordingRunner([])
            server = AgentHTTPServer(listener, DockerClient(runner=runner))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            body = b'{"request_id":"safe-id","command":"id"}'
            request = (
                b"POST /v1/services/prometheus/restart HTTP/1.1\r\n"
                b"Host: agent\r\nContent-Type: application/json\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode()
                + body
            )
            try:
                response = _http_unix(path, request)
                self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
                self.assertEqual(runner.calls, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


def _http_unix(path: str, request: bytes) -> bytes:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2)
    client.connect(path)
    client.sendall(request)
    chunks: list[bytes] = []
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
    client.close()
    return b"".join(chunks)


if __name__ == "__main__":
    unittest.main()
