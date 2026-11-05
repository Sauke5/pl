from __future__ import annotations

import asyncio
import os
import resource
import socket
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import Settings


class BlackboxValidationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProbeResult:
    success: bool
    status_code: int | None
    output: str


def _limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


class BlackboxValidator:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def check_config(self, config_path: Path) -> None:
        if not self.settings.enable_real_blackbox_validation:
            return
        if not self.settings.blackbox_binary.is_file():
            raise BlackboxValidationError("Бинарник Blackbox Exporter для валидации не найден.")
        process = await asyncio.create_subprocess_exec(
            str(self.settings.blackbox_binary),
            "--config.check",
            f"--config.file={config_path}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            preexec_fn=_limits if os.name == "posix" else None,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout=20)
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise BlackboxValidationError("Проверка Blackbox-конфигурации превысила timeout.") from exc
        if process.returncode != 0:
            detail = output.decode("utf-8", errors="replace")[-1200:]
            raise BlackboxValidationError(f"Blackbox Exporter не принял конфигурацию: {detail}")

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    async def probe(self, config_path: Path, url: str, module: str) -> ProbeResult:
        if not self.settings.enable_real_blackbox_validation:
            return ProbeResult(True, 200, "validation disabled")
        port = self._free_port()
        process = await asyncio.create_subprocess_exec(
            str(self.settings.blackbox_binary),
            f"--config.file={config_path}",
            f"--web.listen-address=127.0.0.1:{port}",
            "--log.level=warn",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            preexec_fn=_limits if os.name == "posix" else None,
        )
        output = b""
        try:
            async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
                for _ in range(40):
                    if process.returncode is not None:
                        break
                    try:
                        ready = await client.get(f"http://127.0.0.1:{port}/-/ready")
                        if ready.status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.1)
                else:
                    raise BlackboxValidationError("Временный Blackbox Exporter не перешёл в ready.")
                if process.returncode is not None:
                    output, _ = await process.communicate()
                    raise BlackboxValidationError(
                        f"Временный Blackbox Exporter завершился: {output.decode(errors='replace')[-1200:]}"
                    )
                response = await client.get(
                    f"http://127.0.0.1:{port}/probe",
                    params={"target": url, "module": module},
                    timeout=max(15.0, self.settings.fetch_read_timeout + 5),
                )
                text = response.text
                status_code = None
                success = False
                for line in text.splitlines():
                    if line.startswith("probe_success "):
                        success = line.rsplit(" ", 1)[-1] == "1"
                    elif line.startswith("probe_http_status_code "):
                        try:
                            status_code = int(float(line.rsplit(" ", 1)[-1]))
                        except ValueError:
                            pass
                if response.status_code != 200:
                    raise BlackboxValidationError(f"Временный probe вернул HTTP {response.status_code}.")
                return ProbeResult(success, status_code, text[-2000:])
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except TimeoutError:
                    process.kill()
                    await process.wait()
