from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.clients import AgentClient, UpstreamError
from app.models import AuditEvent, Job, utcnow
from app.health import ServiceHealthClient

logger = logging.getLogger(__name__)
ACTIVE_STATUSES = ("queued", "running")


def _serialize(job: Job) -> dict[str, object]:
    return {
        "id": job.id, "type": job.job_type, "service_id": job.service_id, "status": job.status,
        "requested_by": job.requested_by, "created_at": job.created_at, "started_at": job.started_at,
        "finished_at": job.finished_at, "result": job.result, "error_code": job.error_code,
        "error_message": job.error_message,
    }


class JobConflict(RuntimeError):
    pass


class JobService:
    def __init__(self, factory: sessionmaker[Session]):
        self.factory = factory

    def enqueue_restart(self, service_id: str, username: str, source_ip: str, idempotency_key: str) -> Job:
        key = idempotency_key.strip()
        if not key or len(key) > 128:
            raise ValueError("invalid_idempotency_key")
        with self.factory() as db:
            existing = db.scalar(select(Job).where(Job.idempotency_key == key))
            if existing:
                if existing.service_id != service_id or existing.job_type != "restart":
                    raise JobConflict("idempotency_key_reused")
                return existing
            active = db.scalar(select(Job).where(Job.service_id == service_id, Job.status.in_(ACTIVE_STATUSES)))
            if active:
                raise JobConflict("service_operation_in_progress")
            job = Job(id=str(uuid.uuid4()), idempotency_key=key, job_type="restart", service_id=service_id,
                      lock_key=service_id, status="queued", requested_by=username, source_ip=source_ip)
            db.add(job)
            db.flush()
            db.add(AuditEvent(event_type="container_restart", username=username, source_ip=source_ip,
                              target=service_id, outcome="queued", job_id=job.id))
            try:
                db.commit()
            except IntegrityError as exc:
                db.rollback()
                raise JobConflict("operation_conflict") from exc
            db.refresh(job)
            return job

    def get(self, job_id: str) -> Job | None:
        with self.factory() as db:
            return db.get(Job, job_id)

    def list_audit(self, limit: int) -> list[AuditEvent]:
        with self.factory() as db:
            return list(db.scalars(select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)))


class JobWorker:
    def __init__(self, factory: sessionmaker[Session], agent: AgentClient, poll_seconds: float, timeout_seconds: int,
                 health: ServiceHealthClient | None = None):
        self.factory = factory
        self.agent = agent
        self.poll_seconds = poll_seconds
        self.timeout_seconds = timeout_seconds
        self.health = health
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._service_locks: dict[str, asyncio.Lock] = {}

    def start(self) -> None:
        if self._task is None:
            self._recover()
            self._task = asyncio.create_task(self._run(), name="monitoring-admin-job-worker")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task
            self._task = None

    def _recover(self) -> None:
        with self.factory() as db:
            now = utcnow()
            interrupted = list(db.scalars(select(Job).where(Job.status == "running")))
            for job in interrupted:
                job.status = "failed"; job.finished_at = now; job.error_code = "worker_interrupted"
                job.lock_key = None
                job.error_message = "Операция прервана перезапуском worker"
                db.add(AuditEvent(event_type="container_restart", username=job.requested_by, source_ip=job.source_ip,
                                  target=job.service_id, outcome="failed", job_id=job.id,
                                  details={"error_code": job.error_code}))
            db.commit()

    def _claim(self) -> str | None:
        with self.factory() as db:
            job = db.scalar(select(Job).where(Job.status == "queued").order_by(Job.created_at).limit(1))
            if not job:
                return None
            result = db.execute(update(Job).where(Job.id == job.id, Job.status == "queued").values(status="running", started_at=utcnow()))
            db.commit()
            return job.id if result.rowcount == 1 else None

    async def _run(self) -> None:
        while not self._stop.is_set():
            job_id = await asyncio.to_thread(self._claim)
            if job_id:
                await self._execute(job_id)
                continue
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
            except TimeoutError:
                pass

    async def _execute(self, job_id: str) -> None:
        with self.factory() as db:
            job = db.get(Job, job_id)
            if not job:
                return
            service_id, username, ip = job.service_id, job.requested_by, job.source_ip
        lock = self._service_locks.setdefault(service_id, asyncio.Lock())
        outcome, result, error_code, error_message = "success", None, None, None
        async with lock:
            try:
                result = await asyncio.wait_for(self.agent.restart(service_id, job_id), timeout=self.timeout_seconds)
                if result.get("ok") is False:
                    raise UpstreamError(str(result.get("error_code", "restart_failed")), "Контейнер не перезапущен")
                if self.health is not None:
                    application_health = await self.health.wait_ready(service_id, self.timeout_seconds)
                    result = {**result, "application_health": application_health.as_dict()}
                    if application_health.status == "unhealthy":
                        raise UpstreamError("application_health_failed", "Контейнер запущен, но сервис не прошёл health-check")
            except TimeoutError:
                outcome, error_code, error_message = "failed", "restart_timeout", "Истекло время ожидания перезапуска"
            except (UpstreamError, ValueError) as exc:
                outcome = "failed"; error_code = getattr(exc, "code", str(exc)); error_message = str(exc)
            except Exception:
                logger.exception("restart_job_failed", extra={"job_id": job_id, "service_id": service_id})
                outcome, error_code, error_message = "failed", "internal_error", "Внутренняя ошибка выполнения"
        with self.factory() as db:
            job = db.get(Job, job_id)
            if not job:
                return
            job.status = "succeeded" if outcome == "success" else "failed"
            job.lock_key = None
            job.finished_at = utcnow(); job.result = result; job.error_code = error_code; job.error_message = error_message
            db.add(AuditEvent(event_type="container_restart", username=username, source_ip=ip, target=service_id,
                              outcome=outcome, job_id=job_id,
                              details={"error_code": error_code} if error_code else {"health": (result or {}).get("health")}))
            db.commit()


serialize_job = _serialize
