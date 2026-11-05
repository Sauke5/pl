from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import tempfile
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import AuditEvent, BackupIndex, OperationDetail
from app.repositories.config import ConfigDocuments, ConfigRepository, WebsiteTarget
from app.services.backup import BackupManager, Snapshot, atomic_replace
from app.services.blackbox import BlackboxValidationError, BlackboxValidator
from app.services.notifier import TelegramNotifier

logger = logging.getLogger(__name__)


class ApplyError(RuntimeError):
    def __init__(self, message: str, *, force_required: bool = False, operation_id: str | None = None):
        super().__init__(message)
        self.force_required = force_required
        self.operation_id = operation_id


@dataclass(frozen=True, slots=True)
class ApplyResult:
    operation_id: str
    audit_id: int
    notification_warning: str | None = None


class FileLock:
    def __init__(self, path: Path, timeout: float = 15):
        self.path = path
        self.timeout = timeout
        self.stream = None

    def __enter__(self) -> FileLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+")
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    self.stream.close()
                    self.stream = None
                    raise ApplyError("Другая операция ещё выполняется. Повторите через несколько секунд.")
                time.sleep(0.1)

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        if self.stream:
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            self.stream.close()
            self.stream = None


class RuntimeReloader:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def reload(self) -> None:
        if not self.settings.enable_real_reload:
            return
        async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
            for name, url in (
                ("Blackbox Exporter", f"{self.settings.blackbox_url}/-/reload"),
                ("Prometheus", f"{self.settings.prometheus_url}/-/reload"),
            ):
                try:
                    response = await client.post(url)
                    response.raise_for_status()
                except httpx.HTTPError as exc:
                    raise ApplyError(f"{name} не принял reload.") from exc

    async def readiness(self) -> None:
        if not self.settings.enable_real_reload:
            return
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            for name, url in (
                ("Blackbox Exporter", f"{self.settings.blackbox_url}/-/ready"),
                ("Prometheus", f"{self.settings.prometheus_url}/-/ready"),
            ):
                try:
                    response = await client.get(url)
                    if response.status_code != 200:
                        raise ApplyError(f"{name} не перешёл в ready после reload.")
                except httpx.HTTPError as exc:
                    raise ApplyError(f"{name} недоступен после reload.") from exc

    @staticmethod
    def _prom_string(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")

    async def verify(
        self,
        url: str | None,
        kind: Literal["http", "content", "deleted", "all", "none"],
        forced: bool,
        applied_after: float,
        expected_http_urls: set[str] | None = None,
        expected_content_urls: set[str] | None = None,
    ) -> None:
        if not self.settings.enable_real_reload or kind == "none":
            return
        if kind != "all" and not url:
            return
        job = "blackbox-content" if kind == "content" else "blackbox-http"
        deadline = time.monotonic() + self.settings.verify_timeout_seconds
        escaped = self._prom_string(url) if url else ""
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            while time.monotonic() < deadline:
                if kind == "all":
                    try:
                        response = await client.get(f"{self.settings.prometheus_url}/api/v1/targets", params={"state": "active"})
                        response.raise_for_status()
                        targets = response.json().get("data", {}).get("activeTargets", [])
                        actual_http = {
                            item.get("labels", {}).get("instance")
                            for item in targets
                            if item.get("labels", {}).get("job") == "blackbox-http"
                        }
                        actual_content = {
                            item.get("labels", {}).get("instance")
                            for item in targets
                            if item.get("labels", {}).get("job") == "blackbox-content"
                        }
                        if actual_http == (expected_http_urls or set()) and actual_content == (expected_content_urls or set()):
                            return
                    except (httpx.HTTPError, ValueError):
                        pass
                    await asyncio.sleep(2)
                    continue
                if kind == "deleted":
                    try:
                        response = await client.get(f"{self.settings.prometheus_url}/api/v1/targets", params={"state": "active"})
                        response.raise_for_status()
                        targets = response.json().get("data", {}).get("activeTargets", [])
                        present = any(
                            item.get("labels", {}).get("instance") == url
                            and item.get("labels", {}).get("job") in {"blackbox-http", "blackbox-content"}
                            for item in targets
                        )
                        if not present:
                            return
                    except (httpx.HTTPError, ValueError):
                        pass
                else:
                    selector = f'probe_success{{job="{job}",instance="{escaped}"}}'
                    try:
                        success_response, timestamp_response = await asyncio.gather(
                            client.get(f"{self.settings.prometheus_url}/api/v1/query", params={"query": selector}),
                            client.get(
                                f"{self.settings.prometheus_url}/api/v1/query",
                                params={"query": f"timestamp({selector})"},
                            ),
                        )
                        success_result = success_response.json().get("data", {}).get("result", [])
                        timestamp_result = timestamp_response.json().get("data", {}).get("result", [])
                        if success_result and timestamp_result:
                            success = float(success_result[0]["value"][1])
                            sample_timestamp = float(timestamp_result[0]["value"][1])
                            if sample_timestamp >= applied_after - 2 and (forced or success == 1):
                                return
                    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
                        pass
                await asyncio.sleep(2)
        if kind == "deleted":
            raise ApplyError("Prometheus продолжает видеть удалённую цель после reload.")
        if kind == "all":
            raise ApplyError("Prometheus не подтвердил полный набор целей после rollback.")
        if forced:
            raise ApplyError("Prometheus не подтвердил появление новой конфигурации цели.")
        raise ApplyError(f"Цель не стала успешной в Prometheus за {self.settings.verify_timeout_seconds} секунд.")


class ConfigApplyService:
    def __init__(
        self,
        settings: Settings,
        repository: ConfigRepository,
        backups: BackupManager,
        validator: BlackboxValidator,
        notifier: TelegramNotifier,
    ):
        self.settings = settings
        self.repository = repository
        self.backups = backups
        self.validator = validator
        self.notifier = notifier
        self.runtime = RuntimeReloader(settings)

    @staticmethod
    def _target(state, url: str | None) -> WebsiteTarget | None:  # type: ignore[no-untyped-def]
        if not url:
            return None
        try:
            return state.by_url(url)
        except Exception:
            return None

    @staticmethod
    def _detail(db: Session, audit: AuditEvent, stage: str, status: str, started: float, details: dict[str, Any] | None = None) -> None:
        audit.details.append(
            OperationDetail(
                stage=stage,
                status=status,
                duration_ms=int((time.monotonic() - started) * 1000),
                details=details,
            )
        )
        db.commit()

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        text = str(exc).replace("\x00", " ")
        return text[:1600]

    async def apply(
        self,
        db: Session,
        *,
        operation: str,
        url: str | None,
        reason: str,
        forced: bool,
        expected_revision: str,
        username: str,
        source_ip: str,
        mutate: Callable[[ConfigDocuments], ConfigDocuments],
        probe_kind: Literal["http", "content", "none"],
        verify_kind: Literal["http", "content", "deleted", "all", "none"],
    ) -> ApplyResult:
        reason = reason.strip()
        if len(reason) < 3:
            raise ApplyError("Укажите причину изменения.")
        operation_id = str(uuid.uuid4())
        audit = AuditEvent(
            operation_id=operation_id,
            username=username,
            operation=operation,
            url=url,
            reason=reason,
            forced=forced,
            source_ip=source_ip,
            validation_status="started",
            reload_status="not_started",
            verification_status="not_started",
            notification_status="not_started",
            success=False,
        )
        db.add(audit)
        db.commit()
        db.refresh(audit)

        snapshot: Snapshot | None = None
        replaced = False
        old_values: dict[str, Any] | None = None
        new_values: dict[str, Any] | None = None
        failure: Exception | None = None
        try:
            with FileLock(self.settings.lock_file):
                started = time.monotonic()
                documents = self.repository.assert_revision(expected_revision)
                old_state = self.repository.build_state(documents)
                old_target = self._target(old_state, url)
                old_values = old_target.audit_dict() if old_target else None
                self._detail(db, audit, "concurrency", "success", started)

                started = time.monotonic()
                snapshot = self.backups.create(operation_id, operation, url, reason, forced, source_ip)
                db.add(
                    BackupIndex(
                        snapshot_name=snapshot.name,
                        operation=operation,
                        url=url,
                        result="created",
                        metadata_json=snapshot.metadata,
                    )
                )
                db.commit()
                self._detail(db, audit, "backup", "success", started, {"snapshot": snapshot.name})

                started = time.monotonic()
                changed = mutate(documents)
                new_state = self.repository.build_state(changed)
                new_target = self._target(new_state, url)
                new_values = new_target.audit_dict() if new_target else None
                audit.old_values = old_values
                audit.new_values = new_values
                rendered = self.repository.render(changed)
                self.repository.validate_rendered(rendered)
                self._detail(db, audit, "yaml_validation", "success", started)

                self.settings.data_dir.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(prefix=f"staging-{operation_id[:8]}-", dir=self.settings.data_dir) as stage_name:
                    stage = Path(stage_name)
                    for name, data in rendered.items():
                        (stage / name).write_bytes(data)
                    started = time.monotonic()
                    await self.validator.check_config(stage / "blackbox.yml")
                    audit.validation_status = "success"
                    self._detail(db, audit, "blackbox_config", "success", started)

                    if probe_kind != "none" and url and new_target:
                        module = new_target.content_module if probe_kind == "content" else new_target.http_module
                        if not module:
                            raise ApplyError("Не удалось определить модуль для предварительной проверки.")
                        started = time.monotonic()
                        probe = await self.validator.probe(stage / "blackbox.yml", url, module)
                        self._detail(
                            db,
                            audit,
                            "preflight_probe",
                            "success" if probe.success else "failed",
                            started,
                            {"http_status": probe.status_code},
                        )
                        if not probe.success and not forced:
                            raise ApplyError(
                                "Предварительная проверка цели неуспешна. Принудительное сохранение возможно только после отдельного подтверждения.",
                                force_required=True,
                                operation_id=operation_id,
                            )

                started = time.monotonic()
                atomic_replace(self.repository.paths, rendered)
                replaced = True
                applied_after = time.time()
                self._detail(db, audit, "atomic_replace", "success", started)

                started = time.monotonic()
                await self.runtime.reload()
                await self.runtime.readiness()
                audit.reload_status = "success"
                self._detail(db, audit, "reload", "success", started)

                started = time.monotonic()
                await self.runtime.verify(
                    url,
                    verify_kind,
                    forced,
                    applied_after,
                    expected_http_urls={target.url for target in new_state.targets},
                    expected_content_urls={target.url for target in new_state.targets if target.content_enabled},
                )
                audit.verification_status = "success" if not forced else "forced"
                self._detail(db, audit, "prometheus_verification", "success", started)

                audit.success = True
                snapshot = self.backups.update_result(snapshot, "success")
                backup_row = db.query(BackupIndex).filter(BackupIndex.snapshot_name == snapshot.name).one()
                backup_row.result = "success"
                backup_row.metadata_json = snapshot.metadata
                db.commit()
        except Exception as exc:
            failure = exc
            audit.technical_error = self._safe_error(exc)
            audit.validation_status = "failed" if audit.validation_status == "started" else audit.validation_status
            if replaced and snapshot:
                try:
                    started = time.monotonic()
                    self.backups.restore(snapshot)
                    await self.validator.check_config(self.repository.paths["blackbox.yml"])
                    await self.runtime.reload()
                    await self.runtime.readiness()
                    audit.rollback = True
                    audit.reload_status = "rolled_back"
                    audit.verification_status = "rolled_back"
                    snapshot = self.backups.update_result(snapshot, "rolled_back", error=self._safe_error(exc))
                    self._detail(db, audit, "automatic_rollback", "success", started)
                except Exception as rollback_exc:
                    audit.rollback = True
                    audit.reload_status = "rollback_failed"
                    audit.technical_error = f"{audit.technical_error}; rollback: {self._safe_error(rollback_exc)}"
                    if snapshot:
                        snapshot = self.backups.update_result(snapshot, "rollback_failed", error=audit.technical_error)
                    logger.critical(
                        "automatic_rollback_failed",
                        extra={"operation_id": operation_id, "url": url, "error_type": type(rollback_exc).__name__},
                    )
            elif snapshot:
                snapshot = self.backups.update_result(snapshot, "failed_before_replace", error=self._safe_error(exc))
            if snapshot:
                backup_row = db.query(BackupIndex).filter(BackupIndex.snapshot_name == snapshot.name).one_or_none()
                if backup_row:
                    backup_row.result = snapshot.metadata.get("result", backup_row.result)
                    backup_row.metadata_json = snapshot.metadata
            audit.success = False
            db.commit()

        notification = await self.notifier.send(
            success=failure is None,
            url=url,
            operation=operation,
            reason=reason,
            old_values=old_values,
            new_values=new_values,
            forced=forced,
            error=self._safe_error(failure) if failure else None,
            restored=audit.rollback and audit.reload_status == "rolled_back",
        )
        audit.notification_status = "success" if notification.success else "notification_failed"
        db.commit()

        logger.info(
            "config_operation_finished",
            extra={
                "operation_id": operation_id,
                "url": url,
                "operation": operation,
                "result": "success" if failure is None else "failed",
                "rollback": audit.rollback,
                "notification_failure": not notification.success,
            },
        )
        if failure:
            if isinstance(failure, ApplyError):
                failure.operation_id = operation_id
                raise failure
            raise ApplyError("Изменение не применено. Предыдущая конфигурация восстановлена.", operation_id=operation_id) from failure
        warning = None if notification.success else "Изменения применены, но уведомление в Telegram отправить не удалось."
        return ApplyResult(operation_id, audit.id, warning)
