from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from app.database import Base, create_database
from app.jobs import JobConflict, JobService, JobWorker
from app.models import Job


class FakeAgent:
    async def restart(self, service_id, request_id):
        return {"ok": True, "service_id": service_id, "request_id": request_id, "state": "running"}


@pytest.mark.asyncio
async def test_persisted_restart_job_idempotency_lock_and_audit(settings):
    engine, factory = create_database(settings.database_url); Base.metadata.create_all(engine)
    jobs = JobService(factory)
    first = jobs.enqueue_restart("prometheus", "admin", "127.0.0.1", "same-key")
    assert jobs.enqueue_restart("prometheus", "admin", "127.0.0.1", "same-key").id == first.id
    with pytest.raises(JobConflict): jobs.enqueue_restart("prometheus", "admin", "127.0.0.1", "other-key")
    worker = JobWorker(factory, FakeAgent(), 0.01, 2)
    claimed = worker._claim()
    assert claimed == first.id
    await worker._execute(claimed)
    assert jobs.get(first.id).status == "succeeded"
    events = jobs.list_audit(10)
    assert [event.outcome for event in events] == ["success", "queued"]
    engine.dispose()


def test_database_enforces_one_active_lock_per_service(settings):
    engine, factory = create_database(settings.database_url); Base.metadata.create_all(engine)
    with factory() as db:
        db.add(Job(id="00000000-0000-0000-0000-000000000001", idempotency_key="first", job_type="restart",
                   service_id="prometheus", lock_key="prometheus", status="queued", requested_by="a", source_ip="127.0.0.1"))
        db.commit()
    with factory() as db:
        db.add(Job(id="00000000-0000-0000-0000-000000000002", idempotency_key="second", job_type="restart",
                   service_id="prometheus", lock_key="prometheus", status="queued", requested_by="b", source_ip="127.0.0.2"))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    engine.dispose()
