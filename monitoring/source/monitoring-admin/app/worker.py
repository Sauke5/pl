from __future__ import annotations

import asyncio
import logging

from app.clients import AgentClient
from app.config import get_settings
from app.database import create_database
from app.jobs import JobWorker
from app.health import ServiceHealthClient


async def run() -> None:
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine, factory = create_database(settings.database_url)
    agent = AgentClient(settings.agent_socket, settings.agent_timeout_seconds,
                        settings.service_allowlist, settings.restart_allowlist, settings.agent_restart_timeout_seconds)
    health = ServiceHealthClient(settings.health_timeout_seconds, settings.health_poll_seconds)
    worker = JobWorker(factory, agent, settings.worker_poll_seconds, settings.job_timeout_seconds, health)
    worker.start()
    try:
        await asyncio.Event().wait()
    finally:
        await worker.stop()
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=get_settings().log_level)
    asyncio.run(run())
