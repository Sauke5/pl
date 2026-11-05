from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.repositories.config import ConfigRepository


@dataclass(frozen=True, slots=True)
class Snapshot:
    name: str
    path: Path
    metadata: dict[str, Any]


class BackupManager:
    def __init__(self, directory: Path, repository: ConfigRepository, keep: int = 10):
        self.directory = directory
        self.repository = repository
        self.keep = max(2, keep)

    @staticmethod
    def checksum(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
        temporary = path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def create(
        self,
        operation_id: str,
        operation: str,
        url: str | None,
        reason: str,
        forced: bool,
        source_ip: str,
    ) -> Snapshot:
        self.directory.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc)
        name = f"{timestamp.strftime('%Y%m%dT%H%M%S.%fZ')}-{operation_id[:8]}"
        final_path = self.directory / name
        temporary_path = self.directory / f".{name}.tmp"
        temporary_path.mkdir(mode=0o750)
        checksums: dict[str, str] = {}
        try:
            for filename, source in self.repository.paths.items():
                data = source.read_bytes()
                destination = temporary_path / filename
                with destination.open("wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                checksums[filename] = self.checksum(data)
            metadata: dict[str, Any] = {
                "timestamp": timestamp.isoformat(),
                "operation_id": operation_id,
                "operation": operation,
                "url": url,
                "reason": reason,
                "forced": forced,
                "result": "created",
                "source_ip": source_ip,
                "checksums": checksums,
            }
            self._atomic_json(temporary_path / "metadata.json", metadata)
            os.replace(temporary_path, final_path)
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except Exception:
            shutil.rmtree(temporary_path, ignore_errors=True)
            raise
        self.rotate()
        return Snapshot(name=name, path=final_path, metadata=metadata)

    def update_result(self, snapshot: Snapshot, result: str, **extra: Any) -> Snapshot:
        metadata = dict(snapshot.metadata)
        metadata["result"] = result
        metadata.update(extra)
        self._atomic_json(snapshot.path / "metadata.json", metadata)
        return Snapshot(snapshot.name, snapshot.path, metadata)

    def list(self) -> list[Snapshot]:
        if not self.directory.exists():
            return []
        snapshots: list[Snapshot] = []
        for path in sorted((item for item in self.directory.iterdir() if item.is_dir() and not item.name.startswith(".")), reverse=True):
            metadata_file = path / "metadata.json"
            try:
                metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if all((path / name).is_file() for name in ("blackbox.yml", "websites.yml", "content.yml")):
                snapshots.append(Snapshot(path.name, path, metadata))
        return snapshots

    def rotate(self) -> None:
        snapshots = self.list()
        if len(snapshots) <= self.keep:
            return
        for snapshot in snapshots[self.keep :]:
            shutil.rmtree(snapshot.path)

    def read(self, snapshot: Snapshot) -> dict[str, bytes]:
        rendered = {name: (snapshot.path / name).read_bytes() for name in ("websites.yml", "content.yml", "blackbox.yml")}
        expected = snapshot.metadata.get("checksums", {})
        for name, data in rendered.items():
            if expected.get(name) and expected[name] != self.checksum(data):
                raise RuntimeError(f"Контрольная сумма snapshot {snapshot.name}/{name} не совпадает.")
        return rendered

    def latest_previous(self) -> Snapshot | None:
        current_hashes = {name: self.checksum(path.read_bytes()) for name, path in self.repository.paths.items()}
        for snapshot in self.list():
            if snapshot.metadata.get("checksums") != current_hashes:
                return snapshot
        return None

    def restore(self, snapshot: Snapshot) -> None:
        rendered = self.read(snapshot)
        atomic_replace(self.repository.paths, rendered)


def atomic_replace(paths: dict[str, Path], rendered: dict[str, bytes]) -> None:
    temporary_files: dict[str, Path] = {}
    try:
        for name, destination in paths.items():
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.parent / f".{destination.name}.websites-admin.tmp"
            mode = destination.stat().st_mode & 0o777 if destination.exists() else 0o644
            with temporary.open("wb") as stream:
                stream.write(rendered[name])
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, mode)
            temporary_files[name] = temporary
        for name in ("websites.yml", "content.yml", "blackbox.yml"):
            os.replace(temporary_files[name], paths[name])
            directory_fd = os.open(paths[name].parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        for path in temporary_files.values():
            path.unlink(missing_ok=True)
