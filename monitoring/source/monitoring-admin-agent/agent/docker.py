from __future__ import annotations

import json
import re
import subprocess
import time
from datetime import datetime, timezone
from typing import Callable, Sequence

from .registry import Service
from .sanitize import sanitize_log_lines


class DockerError(RuntimeError):
    pass


Runner = Callable[..., subprocess.CompletedProcess[str]]


class DockerClient:
    def __init__(
        self,
        runner: Runner = subprocess.run,
        timeout_seconds: int = 15,
        restart_wait_seconds: int = 45,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self._runner = runner
        self._timeout_seconds = timeout_seconds
        self._restart_wait_seconds = restart_wait_seconds
        self._sleeper = sleeper

    def _run(self, argv: Sequence[str], *, merge_stderr: bool = False) -> str:
        try:
            completed = self._runner(
                list(argv),
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
                text=True,
                timeout=self._timeout_seconds,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise DockerError("docker operation unavailable") from exc
        if completed.returncode != 0:
            raise DockerError("docker operation failed")
        return completed.stdout

    def inspect(self, service: Service) -> dict[str, object]:
        raw = self._run(("/usr/bin/docker", "inspect", service.container_name))
        try:
            data = json.loads(raw)[0]
            state = data["State"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise DockerError("invalid docker inspect response") from exc

        status = str(state.get("Status", "unknown"))
        running = bool(state.get("Running", False))
        docker_health = state.get("Health") or {}
        health = str(docker_health.get("Status", "not_configured"))
        started_at = str(state.get("StartedAt", ""))
        uptime_seconds = _uptime_seconds(started_at) if running else 0
        readiness = health if health != "not_configured" else ("running" if running else status)
        return {
            "service_id": service.service_id,
            "display_name": service.display_name,
            "container_name": service.container_name,
            "status": status,
            "running": running,
            "health": health,
            "readiness": readiness,
            "started_at": started_at or None,
            "uptime_seconds": uptime_seconds,
            "restartable": service.restartable,
            "restart_count": int(data.get("RestartCount", 0)),
        }

    def logs(self, service: Service) -> list[str]:
        raw = self._run(
            ("/usr/bin/docker", "logs", "--tail", "50", "--timestamps", service.container_name),
            merge_stderr=True,
        )
        return sanitize_log_lines(raw, limit=50)

    def restart(self, service: Service) -> dict[str, object]:
        if not service.restartable:
            raise PermissionError("restart is not allowed for this service")
        self._run(("/usr/bin/docker", "restart", "--time", "10", service.container_name))
        deadline = time.monotonic() + self._restart_wait_seconds
        last_state: dict[str, object] | None = None
        while True:
            try:
                last_state = self.inspect(service)
            except DockerError:
                # A container can be briefly absent from inspect while Docker
                # completes the restart. Treat that as readiness pending.
                pass
            else:
                running = last_state["running"] is True
                health = last_state["health"]
                if running and health == "healthy":
                    return {"ok": True, "health_result": "healthy", "service": last_state}
                if running and health == "not_configured":
                    return {
                        "ok": True,
                        "health_result": "running_without_healthcheck",
                        "service": last_state,
                    }
            if time.monotonic() >= deadline:
                result = "timeout" if last_state is not None else "unavailable"
                return {"ok": False, "health_result": result, "service": last_state}
            self._sleeper(1.0)


def _uptime_seconds(started_at: str) -> int:
    if not started_at or started_at.startswith("0001-"):
        return 0
    try:
        normalized = started_at.replace("Z", "+00:00")
        # Docker emits RFC3339Nano. Python 3.10 accepts no more than six
        # fractional digits in datetime.fromisoformat().
        normalized = re.sub(r"(\.\d{6})\d+(?=[+-]\d{2}:\d{2}$)", r"\1", normalized)
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
