from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import perf_counter

from .base import *  # noqa: F403
from .network import NetworkCollectorsMixin
from .proxy import ProxyCollectorsMixin
from .sql_web import SqlWebCollectorsMixin
from .system import SystemCollectorsMixin

LOGGER = logging.getLogger(__name__)


class MonitoringCollector(
    SystemCollectorsMixin,
    SqlWebCollectorsMixin,
    NetworkCollectorsMixin,
    ProxyCollectorsMixin,
):
    """Собирает независимые разделы ежедневного отчета из Prometheus."""

    CATEGORY_GROUPS = {
        "active_alerts": {"active_alert"},
        "availability": {"host_down", "availability_event"},
        "reboots": {"reboot"},
        "cpu": {"cpu"},
        "ram": {"ram"},
        "disks": {"disk_space", "storage_latency"},
        "sql": {"sql"},
        "websites": {"website_availability", "website_latency", "website_ssl"},
        "network": {
            "network_snmp_down",
            "network_probe_down",
            "network_health",
            "network_interface_down",
        },
        "proxy": {
            "proxy_availability",
            "proxy_endpoint_down",
            "proxy_panel_down",
            "proxy_latency",
            "proxy_systemd",
            "proxy_network",
        },
    }

    def __init__(
        self,
        prometheus: PrometheusClient,
        ram_exclude_instances: frozenset[str] | None = None,
        branch: str | None = None,
    ):
        self.prometheus = prometheus
        self.ram_exclude_instances = ram_exclude_instances or frozenset()
        self.branch = branch

    @property
    def scope(self) -> str:
        return "branch" if self.branch else "central"

    def _scope_matcher(self) -> str:
        if self.branch:
            return f'branch="{self.branch}"'
        central_branches = "|".join(sorted(CENTRAL_BRANCH_LABELS))
        return f'branch=~"^$|^({central_branches})$"'

    def _selector(self, *matchers: str) -> str:
        return ",".join((*matchers, self._scope_matcher()))

    def _collector_workers(self, collector_count: int) -> int:
        raw_value = os.environ.get("MONITORING_COLLECTOR_WORKERS", "4")
        try:
            workers = int(raw_value)
        except ValueError:
            workers = 4
        return max(1, min(collector_count, workers))

    def collect(
        self,
        now: datetime | None = None,
        target_date: date | None = None,
    ) -> MonitoringSnapshot:
        collected_at = now or datetime.now(MSK)
        if target_date is None:
            work_start, work_end = previous_workday_window(collected_at)
        else:
            work_start = datetime.combine(target_date, time(9, 0), tzinfo=MSK)
            work_end = datetime.combine(target_date, time(18, 0), tzinfo=MSK)
        target_day = work_start.date()
        days = workday_dates(target_day)
        previous_day = days[-2]
        history_start = datetime.combine(days[0], time(9, 0), tzinfo=MSK)
        snapshot = MonitoringSnapshot(
            collected_at,
            work_start,
            work_end,
            scope=self.scope,
            branch=self.branch,
        )

        # Каждый раздел собирается независимо: сбой одного запроса не должен
        # ломать весь отчет и скрывать остальные доступные данные.
        collectors = {
            "active_alerts": lambda: self._active_alerts(),
            "availability": lambda: self._availability(target_day),
            "reboots": lambda: self._reboots(target_day, collected_at),
            "cpu": lambda: self._cpu(
                history_start, work_end, days, target_day, previous_day
            ),
            "ram": lambda: self._ram(
                history_start, work_end, days, target_day, previous_day
            ),
            "disks": lambda: self._disks(
                history_start, work_end, days, target_day, previous_day
            ),
            "sql": lambda: self._sql(
                history_start, work_end, days, target_day, previous_day
            ),
            "websites": lambda: self._websites(
                history_start, work_end, days, target_day, previous_day
            ),
            "network": lambda: self._network(history_start, work_end, target_day),
            "proxy": lambda: self._proxy(history_start, work_end, target_day),
        }

        results: dict[str, tuple[list[Finding], dict[str, Any], float]] = {}
        errors: dict[str, str] = {}

        def run_collector(
            name: str,
            collect: Callable[[], tuple[list[Finding], dict[str, Any]]],
        ) -> tuple[list[Finding], dict[str, Any], float]:
            started_at = perf_counter()
            findings, statistics = collect()
            return findings, statistics, perf_counter() - started_at

        workers = self._collector_workers(len(collectors))
        if workers == 1:
            for name, collect in collectors.items():
                try:
                    results[name] = run_collector(name, collect)
                except Exception as exc:
                    LOGGER.exception("Monitoring collector failed: %s", name)
                    errors[name] = f"{type(exc).__name__}: {exc}"
        else:
            LOGGER.info("collector_parallel_start workers=%s", workers)
            with ThreadPoolExecutor(
                max_workers=workers,
                thread_name_prefix="monitoring-collector",
            ) as executor:
                future_by_name = {
                    executor.submit(run_collector, name, collect): name
                    for name, collect in collectors.items()
                }
                for future in as_completed(future_by_name):
                    name = future_by_name[future]
                    try:
                        results[name] = future.result()
                    except Exception as exc:
                        LOGGER.exception("Monitoring collector failed: %s", name)
                        errors[name] = f"{type(exc).__name__}: {exc}"

        for name in collectors:
            if name in errors:
                snapshot.collector_errors[name] = errors[name]
                continue
            findings, statistics, elapsed_seconds = results[name]
            LOGGER.info(
                "collector_done name=%s seconds=%.3f findings=%s",
                name,
                elapsed_seconds,
                len(findings),
            )
            try:
                snapshot.findings.extend(findings)
                snapshot.statistics[name] = statistics
                snapshot.successful_categories.update(self.CATEGORY_GROUPS[name])
                snapshot.successful_collectors.add(name)
            except Exception as exc:
                LOGGER.exception("Monitoring collector failed: %s", name)
                snapshot.collector_errors[name] = f"{type(exc).__name__}: {exc}"

        snapshot.findings.sort(
            key=lambda item: (
                {"critical": 0, "warning": 1, "info": 2}.get(item.severity, 3),
                item.category,
                item.subject,
            )
        )
        return snapshot
