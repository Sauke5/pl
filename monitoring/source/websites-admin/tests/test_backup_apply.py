from __future__ import annotations

from dataclasses import replace

import httpx
import pytest
import respx
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.database import Base
from app.models import AuditEvent, BackupIndex
from app.services.apply import ApplyError, ConfigApplyService, RuntimeReloader
from app.services.backup import BackupManager
from app.services.blackbox import BlackboxValidationError, BlackboxValidator, ProbeResult
from app.services.notifier import NotificationResult


class Validator:
    def __init__(self, fail: bool = False):
        self.fail = fail

    async def check_config(self, _path):
        if self.fail:
            raise BlackboxValidationError("invalid config")

    async def probe(self, _path, _url, _module):
        return ProbeResult(True, 200, "ok")


class FailedProbeValidator(Validator):
    async def probe(self, _path, _url, _module):
        return ProbeResult(False, 503, "failed")


class Notifier:
    def __init__(self, success: bool):
        self.success = success

    async def send(self, **_kwargs):
        return NotificationResult(self.success, None if self.success else "timeout")


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'apply.sqlite3'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session


def build_service(settings, repository, *, validator=None, notifier=None):
    backups = BackupManager(settings.backups_dir, repository, keep=settings.backup_keep)
    return ConfigApplyService(
        settings,
        repository,
        backups,
        validator or Validator(),
        notifier or Notifier(True),
    )


@pytest.mark.asyncio
async def test_successful_apply_writes_audit_backup_and_notification_warning(settings, repository, db):
    service = build_service(settings, repository, notifier=Notifier(False))
    state = repository.build_state()
    result = await service.apply(
        db,
        operation="content_update",
        url="https://example.org/",
        reason="redesign completed",
        forced=False,
        expected_revision=state.revision,
        username="operator",
        source_ip="192.0.2.10",
        mutate=lambda docs: repository.update_fragments(docs, "https://example.org/", ["Новый стабильный фрагмент"]),
        probe_kind="content",
        verify_kind="content",
    )
    assert result.notification_warning
    assert repository.build_state().by_url("https://example.org/").fragments == ["Новый стабильный фрагмент"]
    audit = db.scalar(select(AuditEvent))
    assert audit.success and audit.old_values and audit.new_values
    assert audit.notification_status == "notification_failed"
    backup = db.scalar(select(BackupIndex))
    assert backup.result == "success"


@pytest.mark.asyncio
async def test_validation_failure_leaves_live_files_unchanged(settings, repository, db):
    before = {name: path.read_bytes() for name, path in repository.paths.items()}
    service = build_service(settings, repository, validator=Validator(fail=True))
    with pytest.raises(ApplyError):
        await service.apply(
            db,
            operation="content_update",
            url="https://example.org/",
            reason="test validation rollback",
            forced=False,
            expected_revision=repository.build_state().revision,
            username="operator",
            source_ip="192.0.2.10",
            mutate=lambda docs: repository.update_fragments(docs, "https://example.org/", ["Изменённый фрагмент"]),
            probe_kind="none",
            verify_kind="none",
        )
    assert {name: path.read_bytes() for name, path in repository.paths.items()} == before
    assert db.scalar(select(AuditEvent)).success is False
    assert db.scalar(select(BackupIndex)).result == "failed_before_replace"


@pytest.mark.asyncio
async def test_reload_failure_restores_snapshot(settings, repository, db):
    before = {name: path.read_bytes() for name, path in repository.paths.items()}
    service = build_service(settings, repository)

    class FailOnceRuntime:
        def __init__(self):
            self.calls = 0

        async def reload(self):
            self.calls += 1
            if self.calls == 1:
                raise ApplyError("reload failed")

        async def readiness(self):
            return None

        async def verify(self, *_args, **_kwargs):
            return None

    service.runtime = FailOnceRuntime()
    with pytest.raises(ApplyError):
        await service.apply(
            db,
            operation="content_update",
            url="https://example.org/",
            reason="exercise automatic rollback",
            forced=False,
            expected_revision=repository.build_state().revision,
            username="operator",
            source_ip="192.0.2.10",
            mutate=lambda docs: repository.update_fragments(docs, "https://example.org/", ["Изменённый фрагмент"]),
            probe_kind="none",
            verify_kind="none",
        )
    assert {name: path.read_bytes() for name, path in repository.paths.items()} == before
    audit = db.scalar(select(AuditEvent))
    assert audit.rollback and audit.reload_status == "rolled_back"
    assert db.scalar(select(BackupIndex)).result == "rolled_back"


def test_backup_rotation_retains_configured_number(settings, repository):
    manager = BackupManager(settings.backups_dir, repository, keep=3)
    for index in range(5):
        manager.create(f"00000000-0000-0000-0000-{index:012d}", "test", None, "rotation", False, "192.0.2.10")
    assert len(manager.list()) == 3


@pytest.mark.asyncio
async def test_real_blackbox_binary_accepts_rendered_config(settings, repository, tmp_path):
    changed = repository.add_target(
        repository.load_documents(),
        "https://blackbox.example.net/",
        None,
        ["Достаточно длинный стабильный контрольный фрагмент"],
    )
    rendered = repository.render(changed)
    config = tmp_path / "rendered-blackbox.yml"
    config.write_bytes(rendered["blackbox.yml"])
    validator = BlackboxValidator(replace(settings, enable_real_blackbox_validation=True))
    await validator.check_config(config)


@pytest.mark.asyncio
async def test_reason_is_mandatory_before_any_backup(settings, repository, db):
    service = build_service(settings, repository)
    with pytest.raises(ApplyError, match="причину"):
        await service.apply(
            db,
            operation="content_update",
            url="https://example.org/",
            reason="",
            forced=False,
            expected_revision=repository.build_state().revision,
            username="operator",
            source_ip="192.0.2.10",
            mutate=lambda docs: docs,
            probe_kind="none",
            verify_kind="none",
        )
    assert not settings.backups_dir.exists()


@pytest.mark.asyncio
async def test_failed_preflight_requires_explicit_forced_confirmation(settings, repository, db):
    service = build_service(settings, repository, validator=FailedProbeValidator())
    state = repository.build_state()
    mutation = lambda docs: repository.add_target(docs, "https://forced.example.net/", None, None)
    with pytest.raises(ApplyError) as captured:
        await service.apply(
            db,
            operation="add",
            url="https://forced.example.net/",
            reason="forced-path test",
            forced=False,
            expected_revision=state.revision,
            username="operator",
            source_ip="192.0.2.10",
            mutate=mutation,
            probe_kind="http",
            verify_kind="http",
        )
    assert captured.value.force_required
    result = await service.apply(
        db,
        operation="add",
        url="https://forced.example.net/",
        reason="explicit forced confirmation",
        forced=True,
        expected_revision=repository.build_state().revision,
        username="operator",
        source_ip="192.0.2.10",
        mutate=mutation,
        probe_kind="http",
        verify_kind="http",
    )
    assert result.audit_id
    assert db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()[-1].forced


@pytest.mark.asyncio
@respx.mock
async def test_blackbox_reload_failure_is_distinct(settings):
    live = replace(settings, enable_real_reload=True)
    respx.post("http://blackbox:9115/-/reload").mock(return_value=httpx.Response(500))
    with pytest.raises(ApplyError, match="Blackbox"):
        await RuntimeReloader(live).reload()


@pytest.mark.asyncio
@respx.mock
async def test_prometheus_reload_failure_is_distinct(settings):
    live = replace(settings, enable_real_reload=True)
    respx.post("http://blackbox:9115/-/reload").mock(return_value=httpx.Response(200))
    respx.post("http://prometheus:9090/-/reload").mock(return_value=httpx.Response(500))
    with pytest.raises(ApplyError, match="Prometheus"):
        await RuntimeReloader(live).reload()


def test_latest_previous_supports_one_step_rollback(settings, repository):
    manager = BackupManager(settings.backups_dir, repository, keep=10)
    snapshot = manager.create("11111111-1111-1111-1111-111111111111", "before", None, "before", False, "192.0.2.10")
    changed = repository.update_fragments(repository.load_documents(), "https://example.org/", ["Новая версия страницы"])
    from app.services.backup import atomic_replace

    atomic_replace(repository.paths, repository.render(changed))
    assert manager.latest_previous().name == snapshot.name
    manager.restore(snapshot)
    assert repository.build_state().by_url("https://example.org/").fragments == ["Existing fragment"]
