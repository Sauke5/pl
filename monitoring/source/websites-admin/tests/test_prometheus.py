from __future__ import annotations

import pytest

from app.repositories.config import WebsiteTarget
from app.services.prometheus import PrometheusClient, PrometheusUnavailable


def target(url: str, content: bool = True, error: str | None = None) -> WebsiteTarget:
    return WebsiteTarget("id", url, None, {}, "http_2xx", content, "content" if content else None, [], [], error)


@pytest.mark.asyncio
async def test_status_mapping_for_ok_content_changed_http_error_and_disabled(settings, monkeypatch):
    values = {
        PrometheusClient.QUERIES["http_success"]: {"https://ok/": 1, "https://changed/": 1, "https://down/": 0, "https://disabled/": 1},
        PrometheusClient.QUERIES["content_success"]: {"https://ok/": 1, "https://changed/": 0},
        PrometheusClient.QUERIES["http_status"]: {"https://ok/": 200, "https://changed/": 200, "https://down/": 503, "https://disabled/": 200},
        PrometheusClient.QUERIES["latency"]: {},
        PrometheusClient.QUERIES["ssl_expiry"]: {},
        PrometheusClient.QUERIES["body_length"]: {},
        PrometheusClient.QUERIES["checked_at"]: {},
        'max_over_time(probe_success{job="blackbox-http"}[120s])': {"https://ok/": 1, "https://changed/": 1, "https://down/": 0, "https://disabled/": 1},
        'max_over_time(probe_success{job="blackbox-content"}[600s])': {"https://ok/": 1, "https://changed/": 0},
    }
    client = PrometheusClient(settings)

    async def query(expression):
        return values[expression]

    monkeypatch.setattr(client, "query", query)
    statuses = await client.status_for(
        [target("https://ok/"), target("https://changed/"), target("https://down/"), target("https://disabled/", False)]
    )
    assert statuses["https://ok/"].state == "Исправен"
    assert statuses["https://changed/"].state == "Изменилось содержимое"
    assert statuses["https://down/"].state == "Ошибка доступности"
    assert statuses["https://disabled/"].state == "Проверка содержимого выключена"


@pytest.mark.asyncio
async def test_single_failed_scrape_is_unstable_and_not_a_problem(settings, monkeypatch):
    values = {expression: {} for expression in PrometheusClient(settings).queries.values()}
    values[PrometheusClient.QUERIES["http_success"]] = {"https://access/": 0, "https://content/": 1}
    values[PrometheusClient.QUERIES["content_success"]] = {"https://content/": 0}
    values['max_over_time(probe_success{job="blackbox-http"}[120s])'] = {"https://access/": 1, "https://content/": 1}
    values['max_over_time(probe_success{job="blackbox-content"}[600s])'] = {"https://content/": 1}
    client = PrometheusClient(settings)

    async def query(expression):
        return values[expression]

    monkeypatch.setattr(client, "query", query)
    statuses = await client.status_for([target("https://access/", False), target("https://content/")])
    assert statuses["https://access/"].state_class == "unstable"
    assert statuses["https://content/"].state_class == "unstable"


@pytest.mark.asyncio
async def test_prometheus_outage_becomes_unknown_not_false_down(settings, monkeypatch):
    client = PrometheusClient(settings)

    async def unavailable(_expression):
        raise PrometheusUnavailable("offline")

    monkeypatch.setattr(client, "query", unavailable)
    result = await client.status_for([target("https://example.org/")])
    assert result["https://example.org/"].state_class == "unknown"
