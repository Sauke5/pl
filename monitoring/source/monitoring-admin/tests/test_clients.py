from __future__ import annotations

import pytest

from app.clients import AgentClient


def test_agent_client_enforces_distinct_allowlists(tmp_path):
    client = AgentClient(tmp_path / "socket", 1, ("prometheus", "monitoring-admin"), ("prometheus",))
    client.require_service("monitoring-admin")
    with pytest.raises(ValueError): client.require_service("monitoring-admin", restart=True)
    with pytest.raises(ValueError): client.require_service("../docker", restart=True)
    with pytest.raises(ValueError): client.require_service("unknown")
