from __future__ import annotations

import logging
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from statistics import mean
from time import perf_counter
from typing import Any, Callable

from .clients import PrometheusClient
from .collectors.base import (
    CENTRAL_BRANCH_LABELS,
    MIN_REPORTED_DOWNTIME_MINUTES,
    PROXY_SITE_MATCHER,
    RAM_SQL_CRITICAL_GB,
    RAM_SQL_WARNING_GB,
    gb,
)
from .weekly import (
    WEEKLY_THRESHOLDS,
    WeeklyPeriod,
    WeeklySnapshot,
    comparison_delta,
    coverage_percent,
    daily_stat,
    delta_direction,
    duration_where,
    event_intervals,
    finite_samples,
    period_minutes,
    percentile,
    previous_week_period,
    sample_step_minutes,
    samples_for_period,
    stable_problem_key,
    work_minutes,
)

LOGGER = logging.getLogger(__name__)
SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "healthy": 3}


def _context(metric: dict[str, str]) -> dict[str, str]:
    return {
        key: metric.get(key, "")
        for key in ("role", "location", "job", "branch", "site", "vendor", "model", "check_type")
    }


def _series_key(metric: dict[str, str], *labels: str) -> tuple[str, ...]:
    return tuple(metric.get(label, "") for label in labels)


def _finite(values: list[float]) -> list[float]:
    return [value for value in values if 0 <= value < 100000]


def _longest(intervals: list[dict[str, Any]]) -> float:
    return max((item["duration_minutes"] for item in intervals), default=0.0)


def _days_with(samples: list[tuple[datetime, float]], predicate: Callable[[float], bool]) -> int:
    return len({moment.date() for moment, value in samples if predicate(value)})


def _merge_series(
    series_list: list[dict[str, Any]],
    labels: tuple[str, ...],
    reducer: Callable[[float, float], float] = max,
) -> list[dict[str, Any]]:
    """Merge label-changing duplicate series by stable object identity."""

    merged: dict[tuple[str, ...], dict[str, Any]] = {}
    for series in series_list:
        metric = series.get("metric", {})
        key = tuple(metric.get(label, "") for label in labels)
        target = merged.setdefault(key, {"metric": dict(metric), "values": {}})
        target["metric"].update({name: value for name, value in metric.items() if value})
        for moment, value in finite_samples(series):
            timestamp = moment.timestamp()
            if timestamp in target["values"]:
                target["values"][timestamp] = reducer(target["values"][timestamp], value)
            else:
                target["values"][timestamp] = value
    return [
        {
            "metric": item["metric"],
            "values": [[timestamp, str(value)] for timestamp, value in sorted(item["values"].items())],
        }
        for item in merged.values()
    ]


class WeeklyCollector:
    """Collects weekly aggregations directly from Prometheus range data."""

    def __init__(
        self,
        prometheus: PrometheusClient,
        ram_exclude_instances: frozenset[str] | None = None,
    ) -> None:
        self.prometheus = prometheus
        self.ram_exclude_instances = ram_exclude_instances or frozenset()

    def _selector(self, *matchers: str) -> str:
        branches = "|".join(sorted(CENTRAL_BRANCH_LABELS))
        return ",".join((*matchers, f'branch=~"^$|^({branches})$"'))

    def _range(
        self,
        query: str,
        previous: WeeklyPeriod,
        current: WeeklyPeriod,
        step: str,
    ) -> list[dict[str, Any]]:
        return self.prometheus.query_range(query, previous.start, current.end, step)

    def collect(self, period: WeeklyPeriod, now: datetime) -> WeeklySnapshot:
        previous = previous_week_period(period)
        snapshot = WeeklySnapshot(now, period, previous)
        collectors: dict[str, Callable[[], list[dict[str, Any]]]] = {
            "availability": lambda: self._availability(previous, period),
            "events": lambda: self._events(previous, period),
            "sql": lambda: self._sql(previous, period),
            "cpu": lambda: self._cpu(previous, period),
            "ram": lambda: self._ram(previous, period),
            "disks": lambda: self._disks(previous, period),
            "reboots": lambda: self._reboots(previous, period, now),
            "network": lambda: self._network(previous, period),
            "proxy": lambda: self._proxy(previous, period),
            "websites": lambda: self._websites(previous, period, now),
        }
        results: dict[str, list[dict[str, Any]]] = {}
        workers = min(4, len(collectors))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="weekly-report") as executor:
            futures = {executor.submit(collector): name for name, collector in collectors.items()}
            for future in as_completed(futures):
                name = futures[future]
                started = perf_counter()
                try:
                    results[name] = future.result()
                    snapshot.successful_collectors.add(name)
                    LOGGER.info("weekly_collector_done name=%s rows=%s", name, len(results[name]))
                except Exception as exc:
                    LOGGER.exception("Weekly collector failed: %s", name)
                    snapshot.collector_errors[name] = f"{type(exc).__name__}: {exc}"
                LOGGER.debug("weekly_collector_join name=%s seconds=%.3f", name, perf_counter() - started)

        snapshot.statistics = {name: results.get(name, []) for name in collectors if name != "events"}
        snapshot.problems = self._classify_problems(results.get("events", []), results, period)
        snapshot.highlights = self._highlights(snapshot)
        snapshot.quality = self._quality(snapshot)
        snapshot.summary = self._summary(snapshot)
        return snapshot

    def _availability(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        query = "up{" + self._selector('job=~"linux|windows"') + "}"
        rows = []
        # Two weeks at 1m exceed Prometheus' default 11k points-per-series limit.
        # A 2m step still detects operationally relevant outages and stays bounded.
        for series in _merge_series(
            self._range(query, previous, current, "2m"),
            ("job", "instance"),
        ):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            current_samples = samples_for_period(series, current, False)
            previous_samples = samples_for_period(series, previous, False)
            if not current_samples:
                continue
            intervals = [
                interval
                for interval in event_intervals(current_samples, lambda value: value == 0)
                if interval["duration_minutes"] >= MIN_REPORTED_DOWNTIME_MINUTES
            ]
            downtime = sum(item["duration_minutes"] for item in intervals)
            sampled_minutes = len(current_samples) * sample_step_minutes(current_samples)
            availability = max(0.0, (sampled_minutes - downtime) / sampled_minutes * 100)
            previous_intervals = [
                interval
                for interval in event_intervals(previous_samples, lambda value: value == 0)
                if interval["duration_minutes"] >= MIN_REPORTED_DOWNTIME_MINUTES
            ]
            previous_availability = None
            if previous_samples:
                previous_minutes = len(previous_samples) * sample_step_minutes(previous_samples)
                previous_downtime = sum(item["duration_minutes"] for item in previous_intervals)
                previous_availability = max(0.0, (previous_minutes - previous_downtime) / previous_minutes * 100)
            coverage = coverage_percent(current_samples, period_minutes(current))
            current_up = current_samples[-1][1] > 0
            severity = "healthy"
            if not current_up:
                severity = "critical"
            elif downtime > 0:
                severity = "warning"
            rows.append(
                {
                    "object_id": f"{metric.get('job', '')}:{instance}",
                    "instance": instance,
                    "os": "Windows" if metric.get("job") == "windows" else "Linux",
                    "availability_percent": availability,
                    "previous_availability_percent": previous_availability,
                    "availability_delta_pp": comparison_delta(availability, previous_availability),
                    "downtime_minutes": downtime,
                    "events": len(intervals),
                    "longest_downtime_minutes": _longest(intervals),
                    "affected_days": len({datetime.fromisoformat(item["start"]).date() for item in intervals}),
                    "current_up": current_up,
                    "coverage_percent": coverage,
                    "partial_coverage": coverage < WEEKLY_THRESHOLDS.minimum_coverage_percent,
                    "intervals": intervals,
                    "daily": daily_stat(current_samples, current.days, lambda values: sum(value > 0 for value in values) / len(values) * 100),
                    "severity": severity,
                    **_context(metric),
                }
            )
        rows.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["availability_percent"], row["instance"]))
        return rows

    def _events(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        query = "ALERTS{" + self._selector('alertstate="firing"') + "}"
        rows = []
        for series in self._range(query, previous, current, "5m"):
            metric = series["metric"]
            current_samples = samples_for_period(series, current, False)
            previous_samples = samples_for_period(series, previous, False)
            if not current_samples and not previous_samples:
                continue
            alertname = metric.get("alertname", "unknown")
            instance = metric.get("instance") or metric.get("device") or metric.get("job", "unknown")
            intervals = event_intervals(current_samples, lambda _value: True)
            rows.append(
                {
                    "key": stable_problem_key(alertname, metric),
                    "alertname": alertname,
                    "subject": instance,
                    "severity": metric.get("severity", "warning"),
                    "labels": metric,
                    "first_seen": current_samples[0][0].isoformat() if current_samples else None,
                    "last_seen": current_samples[-1][0].isoformat() if current_samples else None,
                    "days": len({moment.date() for moment, _ in current_samples}),
                    "events": len(intervals),
                    "duration_minutes": sum(item["duration_minutes"] for item in intervals),
                    "active_at_end": bool(current_samples and current.end - current_samples[-1][0] <= timedelta(minutes=10)),
                    "seen_previous_week": bool(previous_samples),
                    "previous_duration_minutes": duration_where(previous_samples, lambda _value: True),
                    "intervals": intervals,
                }
            )
        rows.sort(key=lambda row: (SEVERITY_ORDER.get(row["severity"], 2), -row["duration_minutes"], row["subject"]))
        return rows

    def _cpu(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        queries = (
            ("Linux", "100 - (avg by(instance, role, location, branch) (rate(node_cpu_seconds_total{" + self._selector('job="linux"', 'mode="idle"') + "}[5m])) * 100)"),
            ("Windows", "100 - (avg by(instance, role, location, branch) (rate(windows_cpu_time_total{" + self._selector('job="windows"', 'mode="idle"') + "}[5m])) * 100)"),
        )
        rows = []
        for os_name, query in queries:
            for series in _merge_series(
                self._range(query, previous, current, "5m"),
                ("instance",),
            ):
                metric = series["metric"]
                current_samples = samples_for_period(series, current, True)
                previous_samples = samples_for_period(series, previous, True)
                values = _finite([value for _, value in current_samples])
                if not values:
                    continue
                p95 = percentile(values, 95)
                previous_p95 = percentile([value for _, value in previous_samples], 95)
                warning_minutes = duration_where(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.cpu_warning_percent)
                critical_minutes = duration_where(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.cpu_critical_percent)
                critical_intervals = event_intervals(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.cpu_critical_percent)
                warning_intervals = event_intervals(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.cpu_warning_percent)
                severity = "healthy"
                if critical_minutes >= WEEKLY_THRESHOLDS.cpu_min_critical_minutes:
                    severity = "critical"
                elif warning_minutes >= WEEKLY_THRESHOLDS.cpu_min_warning_minutes:
                    severity = "warning"
                rows.append(
                    {
                        "instance": metric.get("instance", "unknown"), "os": os_name,
                        "average_percent": mean(values), "p95_percent": p95, "maximum_percent": max(values),
                        "previous_p95_percent": previous_p95, "p95_delta_pp": comparison_delta(p95, previous_p95),
                        "warning_minutes": warning_minutes, "critical_minutes": critical_minutes,
                        "longest_high_minutes": max(_longest(warning_intervals), _longest(critical_intervals)),
                        "affected_days": _days_with(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.cpu_warning_percent),
                        "daily": daily_stat(current_samples, current.days, lambda values: percentile(values, 95) or 0),
                        "coverage_percent": coverage_percent(current_samples, work_minutes(current)), "severity": severity,
                        **_context(metric),
                    }
                )
        rows.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], -(row["p95_percent"] or 0), row["instance"]))
        return rows

    def _ram(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        platforms = (
            ("Linux", "node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes", 'job="linux"'),
            ("Windows", "windows_memory_available_bytes", "windows_cs_physical_memory_bytes", 'job="windows"'),
        )
        rows = []
        for os_name, available_metric, total_metric, job in platforms:
            ratio_query = f"{available_metric}{{{self._selector(job)}}} / {total_metric}{{{self._selector(job)}}} * 100"
            available_query = f"{available_metric}{{{self._selector(job)}}}"
            available_by_instance = {
                series["metric"].get("instance", "unknown"): series
                for series in _merge_series(
                    self._range(available_query, previous, current, "5m"),
                    ("instance",),
                    min,
                )
            }
            for series in _merge_series(
                self._range(ratio_query, previous, current, "5m"),
                ("instance",),
                min,
            ):
                metric = series["metric"]
                instance = metric.get("instance", "unknown")
                if instance in self.ram_exclude_instances:
                    continue
                current_samples = samples_for_period(series, current, True)
                previous_samples = samples_for_period(series, previous, True)
                values = [value for _, value in current_samples if 0 <= value <= 100]
                if not values:
                    continue
                byte_samples = samples_for_period(available_by_instance.get(instance, {}), current, True)
                minimum_gb = min((gb(value) for _, value in byte_samples), default=None)
                p5 = percentile(values, 5)
                previous_p5 = percentile([value for _, value in previous_samples], 5)
                is_sql = "sql" in metric.get("role", "").lower()
                if is_sql:
                    # SQL Server intentionally consumes free RAM for the buffer pool.
                    # Percent-free is therefore not a pressure signal; only a depleted
                    # absolute reserve is actionable.
                    warning_predicate = lambda value: gb(value) < RAM_SQL_WARNING_GB
                    critical_predicate = lambda value: gb(value) < RAM_SQL_CRITICAL_GB
                    pressure_samples = byte_samples
                else:
                    warning_predicate = lambda value: value <= WEEKLY_THRESHOLDS.ram_warning_percent
                    critical_predicate = lambda value: value <= WEEKLY_THRESHOLDS.ram_critical_percent
                    pressure_samples = current_samples
                warning_minutes = duration_where(pressure_samples, warning_predicate)
                critical_minutes = duration_where(pressure_samples, critical_predicate)
                warning_intervals = event_intervals(pressure_samples, warning_predicate)
                severity = "healthy"
                if critical_minutes >= WEEKLY_THRESHOLDS.ram_min_critical_minutes:
                    severity = "critical"
                elif warning_minutes >= WEEKLY_THRESHOLDS.ram_min_warning_minutes:
                    severity = "warning"
                rows.append(
                    {
                        "instance": instance, "os": os_name, "minimum_gb": minimum_gb,
                        "minimum_percent": min(values), "p5_percent": p5,
                        "previous_p5_percent": previous_p5, "p5_delta_pp": comparison_delta(p5, previous_p5),
                        "warning_minutes": warning_minutes, "critical_minutes": critical_minutes,
                        "longest_low_minutes": _longest(warning_intervals),
                        "affected_days": _days_with(pressure_samples, warning_predicate),
                        "daily": daily_stat(current_samples, current.days, lambda day_values: percentile(day_values, 5) or 0),
                        "coverage_percent": coverage_percent(current_samples, work_minutes(current)), "severity": severity,
                        "pressure_policy": "absolute-reserve" if is_sql else "free-percent",
                        **_context(metric),
                    }
                )
        rows.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["p5_percent"] or 101, row["instance"]))
        return rows

    def _disks(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        rows: dict[tuple[str, str], dict[str, Any]] = {}
        platforms = (
            ("Windows", "volume", "windows_logical_disk_free_bytes", "windows_logical_disk_size_bytes", 'job="windows"'),
            ("Linux", "mountpoint", "node_filesystem_avail_bytes", "node_filesystem_size_bytes", 'job="linux",fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs|devtmpfs|rootfs"'),
        )
        for os_name, device_label, free_metric, size_metric, selector in platforms:
            ratio_query = f"{free_metric}{{{self._selector(selector)}}} / {size_metric}{{{self._selector(selector)}}} * 100"
            free_query = f"{free_metric}{{{self._selector(selector)}}}"
            free_series = {
                _series_key(item["metric"], "instance", device_label): item
                for item in self._range(free_query, previous, current, "15m")
            }
            for series in self._range(ratio_query, previous, current, "15m"):
                metric = series["metric"]
                key = _series_key(metric, "instance", device_label)
                current_samples = samples_for_period(series, current, True)
                previous_samples = samples_for_period(series, previous, True)
                if not current_samples:
                    continue
                free_samples = samples_for_period(free_series.get(key, {}), current, True)
                values = [value for _, value in current_samples]
                previous_values = [value for _, value in previous_samples]
                start_percent, end_percent = values[0], values[-1]
                start_gb = gb(free_samples[0][1]) if free_samples else None
                end_gb = gb(free_samples[-1][1]) if free_samples else None
                minimum = min(values)
                severity = "critical" if minimum < WEEKLY_THRESHOLDS.disk_free_critical_percent else "warning" if minimum < WEEKLY_THRESHOLDS.disk_free_warning_percent else "healthy"
                rows[key] = {
                    "instance": key[0], "device": key[1], "os": os_name,
                    "minimum_free_percent": minimum, "start_free_percent": start_percent, "end_free_percent": end_percent,
                    "start_free_gb": start_gb, "end_free_gb": end_gb,
                    "change_gb": comparison_delta(end_gb, start_gb), "change_pp": end_percent - start_percent,
                    "daily_fill_gb": ((start_gb - end_gb) / 4 if start_gb is not None and end_gb is not None else None),
                    "previous_minimum_free_percent": min(previous_values) if previous_values else None,
                    "read_p95_ms": None, "read_max_ms": None, "read_warning_minutes": 0.0,
                    "write_p95_ms": None, "write_max_ms": None, "write_warning_minutes": 0.0,
                    "daily": daily_stat(current_samples, current.days, min), "coverage_percent": coverage_percent(current_samples, work_minutes(current)),
                    "severity": severity, **_context(metric),
                }

        latency_queries = (
            ("read", "volume", "rate(windows_logical_disk_read_latency_seconds_total{" + self._selector('job="windows"') + "}[5m]) / rate(windows_logical_disk_reads_total{" + self._selector('job="windows"') + "}[5m]) * 1000"),
            ("write", "volume", "rate(windows_logical_disk_write_latency_seconds_total{" + self._selector('job="windows"') + "}[5m]) / rate(windows_logical_disk_writes_total{" + self._selector('job="windows"') + "}[5m]) * 1000"),
            ("read", "device", "rate(node_disk_read_time_seconds_total{" + self._selector('job="linux"') + "}[5m]) / rate(node_disk_reads_completed_total{" + self._selector('job="linux"') + "}[5m]) * 1000"),
            ("write", "device", "rate(node_disk_write_time_seconds_total{" + self._selector('job="linux"') + "}[5m]) / rate(node_disk_writes_completed_total{" + self._selector('job="linux"') + "}[5m]) * 1000"),
        )
        for direction, device_label, query in latency_queries:
            for series in self._range(query, previous, current, "5m"):
                metric = series["metric"]
                key = _series_key(metric, "instance", device_label)
                current_samples = [(moment, value) for moment, value in samples_for_period(series, current, True) if 0 <= value < 100000]
                previous_samples = [(moment, value) for moment, value in samples_for_period(series, previous, True) if 0 <= value < 100000]
                if not current_samples:
                    continue
                row = rows.setdefault(
                    key,
                    {"instance": key[0], "device": key[1], "os": "Windows" if metric.get("job") == "windows" else "Linux", "minimum_free_percent": None, "start_free_percent": None, "end_free_percent": None, "start_free_gb": None, "end_free_gb": None, "change_gb": None, "change_pp": None, "daily_fill_gb": None, "previous_minimum_free_percent": None, "read_p95_ms": None, "read_max_ms": None, "read_warning_minutes": 0.0, "write_p95_ms": None, "write_max_ms": None, "write_warning_minutes": 0.0, "daily": [], "coverage_percent": coverage_percent(current_samples, work_minutes(current)), "severity": "healthy", **_context(metric)},
                )
                values = [value for _, value in current_samples]
                p95 = percentile(values, 95)
                row[f"{direction}_p95_ms"] = p95
                row[f"{direction}_max_ms"] = max(values)
                row[f"{direction}_warning_minutes"] = duration_where(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.disk_latency_warning_ms)
                previous_p95 = percentile([value for _, value in previous_samples], 95)
                row[f"previous_{direction}_p95_ms"] = previous_p95
                row[f"{direction}_p95_delta_ms"] = comparison_delta(p95, previous_p95)
                if row[f"{direction}_warning_minutes"] >= 15:
                    latency_severity = "critical" if (p95 or 0) >= WEEKLY_THRESHOLDS.disk_latency_critical_ms else "warning"
                    if SEVERITY_ORDER[latency_severity] < SEVERITY_ORDER[row["severity"]]:
                        row["severity"] = latency_severity
        result = list(rows.values())
        result.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["instance"], row["device"]))
        return result

    def _sql(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        servers: dict[str, dict[str, Any]] = {}
        excluded = {"master", "model", "msdb", "tempdb"}
        log_query = "windows_mssql_databases_log_used_percent{" + self._selector('job="windows"') + "}"
        for series in self._range(log_query, previous, current, "5m"):
            metric = series["metric"]
            database = metric.get("database", metric.get("db", "unknown"))
            if database.lower() in excluded:
                continue
            current_samples = samples_for_period(series, current, True)
            previous_samples = samples_for_period(series, previous, True)
            if not current_samples:
                continue
            values = [value for _, value in current_samples]
            p95 = percentile(values, 95)
            entry = {
                "name": database, "maximum_percent": max(values), "p95_percent": p95,
                "warning_minutes": duration_where(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.sql_log_warning_percent),
                "critical_minutes": duration_where(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.sql_log_critical_percent),
                "affected_days": _days_with(current_samples, lambda value: value >= WEEKLY_THRESHOLDS.sql_log_warning_percent),
                "previous_p95_percent": percentile([value for _, value in previous_samples], 95),
                "daily": daily_stat(current_samples, current.days, max),
            }
            instance = metric.get("instance", "unknown")
            server = servers.setdefault(instance, {"instance": instance, "databases": [], "ple": None, "severity": "healthy", **_context(metric)})
            server["databases"].append(entry)
            severity = "critical" if entry["critical_minutes"] >= 15 else "warning" if entry["warning_minutes"] >= 15 else "healthy"
            if SEVERITY_ORDER[severity] < SEVERITY_ORDER[server["severity"]]:
                server["severity"] = severity

        ple_query = "windows_mssql_bufman_page_life_expectancy_seconds{" + self._selector('job="windows"') + "}"
        for series in self._range(ple_query, previous, current, "5m"):
            metric = series["metric"]
            current_samples = samples_for_period(series, current, True)
            previous_samples = samples_for_period(series, previous, True)
            if not current_samples:
                continue
            values = [value for _, value in current_samples]
            p5 = percentile(values, 5)
            ple = {
                "minimum_seconds": min(values), "p5_seconds": p5,
                "warning_minutes": duration_where(current_samples, lambda value: value <= WEEKLY_THRESHOLDS.sql_ple_warning_seconds),
                "critical_minutes": duration_where(current_samples, lambda value: value <= WEEKLY_THRESHOLDS.sql_ple_critical_seconds),
                "affected_days": _days_with(current_samples, lambda value: value <= WEEKLY_THRESHOLDS.sql_ple_warning_seconds),
                "previous_p5_seconds": percentile([value for _, value in previous_samples], 5),
                "daily": daily_stat(current_samples, current.days, min),
            }
            instance = metric.get("instance", "unknown")
            server = servers.setdefault(instance, {"instance": instance, "databases": [], "ple": None, "severity": "healthy", **_context(metric)})
            server["ple"] = ple
            severity = "critical" if ple["critical_minutes"] >= 15 else "warning" if ple["warning_minutes"] >= 15 else "healthy"
            if SEVERITY_ORDER[severity] < SEVERITY_ORDER[server["severity"]]:
                server["severity"] = severity
        rows = list(servers.values())
        for row in rows:
            row["databases"].sort(key=lambda item: item["p95_percent"] or 0, reverse=True)
        rows.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["instance"]))
        return rows

    def _reboots(self, previous: WeeklyPeriod, current: WeeklyPeriod, now: datetime) -> list[dict[str, Any]]:
        queries = (
            ("Linux", "node_boot_time_seconds{" + self._selector('job="linux"') + "}"),
            ("Windows", "timestamp(windows_system_system_up_time{" + self._selector('job="windows"') + "}) - windows_system_system_up_time{" + self._selector('job="windows"') + "}"),
        )
        rows = []
        for os_name, query in queries:
            for series in self._range(query, previous, current, "5m"):
                metric = series["metric"]
                boot_times = sorted({int(value) for moment, value in samples_for_period(series, current, False) if current.contains(datetime.fromtimestamp(value, current.start.tzinfo))})
                previous_count = len({int(value) for _, value in samples_for_period(series, previous, False) if previous.contains(datetime.fromtimestamp(value, previous.start.tzinfo))})
                if not boot_times:
                    continue
                instance = metric.get("instance", "unknown")
                for boot_timestamp in boot_times:
                    boot_at = datetime.fromtimestamp(boot_timestamp, current.start.tzinfo)
                    rows.append({"instance": instance, "os": os_name, "boot_at": boot_at.isoformat(), "weekday": boot_at.strftime("%A"), "uptime_seconds": max(0, (now - boot_at).total_seconds()), "weekly_count": len(boot_times), "previous_count": previous_count, "severity": "info", **_context(metric)})
        rows.sort(key=lambda row: row["boot_at"], reverse=True)
        return rows

    def _network(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        rows: dict[str, dict[str, Any]] = {}
        probe_query = "probe_success{" + self._selector('job=~"blackbox-(icmp|tcp)-network"', 'vendor="huawei"') + "}"
        for series in self._range(probe_query, previous, current, "5m"):
            metric = series["metric"]
            device = metric.get("device") or metric.get("instance", "unknown")
            samples = samples_for_period(series, current, False)
            previous_samples = samples_for_period(series, previous, False)
            if not samples:
                continue
            intervals = event_intervals(samples, lambda value: value == 0)
            check = {"instance": metric.get("instance", ""), "check_type": metric.get("check_type", "probe"), "success_percent": sum(value > 0 for _, value in samples) / len(samples) * 100, "previous_success_percent": (sum(value > 0 for _, value in previous_samples) / len(previous_samples) * 100 if previous_samples else None), "events": len(intervals), "downtime_minutes": sum(item["duration_minutes"] for item in intervals), "longest_downtime_minutes": _longest(intervals), "daily": daily_stat(samples, current.days, lambda values: sum(value > 0 for value in values) / len(values) * 100)}
            row = rows.setdefault(device, {"device": device, "checks": [], "snmp_availability_percent": None, "cpu_p95_percent": None, "cpu_max_percent": None, "ram_p95_percent": None, "ram_max_percent": None, "temperature_max_celsius": None, "uptime_days": None, "severity": "healthy", **_context(metric)})
            row["checks"].append(check)
            if check["success_percent"] < 100:
                row["severity"] = "critical" if check["success_percent"] < 95 else "warning"

        snmp_query = "up{" + self._selector('job=~"huawei-snmp-(if|health)"') + "}"
        for series in self._range(snmp_query, previous, current, "5m"):
            metric = series["metric"]
            device = metric.get("device") or metric.get("instance", "unknown")
            samples = samples_for_period(series, current, False)
            if not samples:
                continue
            row = rows.setdefault(device, {"device": device, "checks": [], "snmp_availability_percent": None, "cpu_p95_percent": None, "cpu_max_percent": None, "ram_p95_percent": None, "ram_max_percent": None, "temperature_max_celsius": None, "uptime_days": None, "severity": "healthy", **_context(metric)})
            availability = sum(value > 0 for _, value in samples) / len(samples) * 100
            row["snmp_availability_percent"] = min(row["snmp_availability_percent"] or 100, availability)
            if availability < 100 and row["severity"] == "healthy":
                row["severity"] = "warning"

        health = (("cpu", "huaweiEntityCpuUsage"), ("ram", "huaweiEntityMemoryUsage"), ("temperature", "huaweiEntityTemperatureCelsius"))
        for kind, metric_name in health:
            query = metric_name + "{" + self._selector('job="huawei-snmp-health"') + "}"
            grouped: dict[str, list[float]] = defaultdict(list)
            contexts: dict[str, dict[str, str]] = {}
            for series in self._range(query, previous, current, "5m"):
                metric = series["metric"]
                device = metric.get("device") or metric.get("instance", "unknown")
                grouped[device].extend(value for _, value in samples_for_period(series, current, False))
                contexts[device] = metric
            for device, values in grouped.items():
                if not values:
                    continue
                row = rows.setdefault(device, {"device": device, "checks": [], "snmp_availability_percent": None, "cpu_p95_percent": None, "cpu_max_percent": None, "ram_p95_percent": None, "ram_max_percent": None, "temperature_max_celsius": None, "uptime_days": None, "severity": "healthy", **_context(contexts[device])})
                if kind == "temperature":
                    row["temperature_max_celsius"] = max(values)
                else:
                    row[f"{kind}_p95_percent"] = percentile(values, 95)
                    row[f"{kind}_max_percent"] = max(values)
        result = list(rows.values())
        result.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["device"]))
        return result

    def _proxy(self, previous: WeeklyPeriod, current: WeeklyPeriod) -> list[dict[str, Any]]:
        rows: dict[str, dict[str, Any]] = {}
        query = 'probe_success{job="blackbox-tcp-proxy"}'
        duration_query = 'probe_duration_seconds{job="blackbox-tcp-proxy"}'
        durations = {
            _series_key(series["metric"], "site", "instance", "port", "role"): series
            for series in self._range(duration_query, previous, current, "5m")
        }
        for series in self._range(query, previous, current, "2m"):
            metric = series["metric"]
            site = metric.get("site", "unknown")
            samples = samples_for_period(series, current, False)
            previous_samples = samples_for_period(series, previous, False)
            if not samples:
                continue
            key = _series_key(metric, "site", "instance", "port", "role")
            latency_samples = samples_for_period(durations.get(key, {}), current, False)
            previous_latency = samples_for_period(durations.get(key, {}), previous, False)
            intervals = event_intervals(samples, lambda value: value == 0)
            endpoint = {"instance": metric.get("instance", ""), "port": metric.get("port", ""), "role": metric.get("role", ""), "success_percent": sum(value > 0 for _, value in samples) / len(samples) * 100, "previous_success_percent": (sum(value > 0 for _, value in previous_samples) / len(previous_samples) * 100 if previous_samples else None), "failed_checks": sum(value == 0 for _, value in samples), "events": len(intervals), "downtime_minutes": sum(item["duration_minutes"] for item in intervals), "average_connect_seconds": mean([value for _, value in latency_samples]) if latency_samples else None, "p95_connect_seconds": percentile([value for _, value in latency_samples], 95), "previous_p95_connect_seconds": percentile([value for _, value in previous_latency], 95)}
            row = rows.setdefault(site, {"site": site, "endpoints": [], "node_availability_percent": None, "xui_active_percent": None, "cpu_p95_percent": None, "ram_p95_percent": None, "severity": "healthy"})
            row["endpoints"].append(endpoint)
            if endpoint["success_percent"] < 100:
                severity = "critical" if endpoint["success_percent"] < 95 else "warning"
                if SEVERITY_ORDER[severity] < SEVERITY_ORDER[row["severity"]]:
                    row["severity"] = severity

        auxiliary = (
            ("node_availability_percent", f'up{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}'),
            ("xui_active_percent", f'node_systemd_unit_state{{job="linux",site=~"{PROXY_SITE_MATCHER}",name="x-ui.service",state="active"}}'),
        )
        for field, query in auxiliary:
            for series in self._range(query, previous, current, "5m"):
                metric = series["metric"]
                site = metric.get("site", metric.get("instance", "unknown"))
                samples = samples_for_period(series, current, False)
                if not samples:
                    continue
                row = rows.setdefault(site, {"site": site, "endpoints": [], "node_availability_percent": None, "xui_active_percent": None, "cpu_p95_percent": None, "ram_p95_percent": None, "severity": "healthy"})
                row[field] = sum(value > 0 for _, value in samples) / len(samples) * 100
                if row[field] < 100 and row["severity"] == "healthy":
                    row["severity"] = "warning"
        result = list(rows.values())
        for row in result:
            row["endpoints"].sort(key=lambda item: (item["role"] != "proxy", item["port"]))
        result.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["site"]))
        return result

    def _websites(self, previous: WeeklyPeriod, current: WeeklyPeriod, now: datetime) -> list[dict[str, Any]]:
        rows: dict[str, dict[str, Any]] = {}
        success_query = "probe_success{" + self._selector('job="blackbox-http"') + "}"
        for series in self._range(success_query, previous, current, "5m"):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            samples = samples_for_period(series, current, True)
            previous_samples = samples_for_period(series, previous, True)
            if not samples:
                continue
            intervals = event_intervals(samples, lambda value: value == 0)
            success = sum(value > 0 for _, value in samples) / len(samples) * 100
            previous_success = sum(value > 0 for _, value in previous_samples) / len(previous_samples) * 100 if previous_samples else None
            severity = "critical" if success < WEEKLY_THRESHOLDS.website_success_critical_percent else "warning" if success < WEEKLY_THRESHOLDS.website_success_warning_percent else "healthy"
            rows[instance] = {"instance": instance, "success_percent": success, "previous_success_percent": previous_success, "success_delta_pp": comparison_delta(success, previous_success), "successful_checks": sum(value > 0 for _, value in samples), "failed_checks": sum(value == 0 for _, value in samples), "events": len(intervals), "downtime_minutes": sum(item["duration_minutes"] for item in intervals), "longest_downtime_minutes": _longest(intervals), "average_seconds": None, "p95_seconds": None, "maximum_seconds": None, "previous_p95_seconds": None, "ssl_days_remaining": None, "daily": daily_stat(samples, current.days, lambda values: sum(value > 0 for value in values) / len(values) * 100), "coverage_percent": coverage_percent(samples, work_minutes(current)), "severity": severity, **_context(metric)}

        duration_query = "probe_duration_seconds{" + self._selector('job="blackbox-http"') + "}"
        for series in self._range(duration_query, previous, current, "5m"):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            samples = samples_for_period(series, current, True)
            previous_samples = samples_for_period(series, previous, True)
            if not samples or instance not in rows:
                continue
            values = [value for _, value in samples]
            row = rows[instance]
            row["average_seconds"] = mean(values)
            row["p95_seconds"] = percentile(values, 95)
            row["maximum_seconds"] = max(values)
            row["previous_p95_seconds"] = percentile([value for _, value in previous_samples], 95)
            row["p95_delta_seconds"] = comparison_delta(row["p95_seconds"], row["previous_p95_seconds"])
            latency_severity = "critical" if (row["p95_seconds"] or 0) >= WEEKLY_THRESHOLDS.website_latency_critical_seconds else "warning" if (row["p95_seconds"] or 0) >= WEEKLY_THRESHOLDS.website_latency_warning_seconds else "healthy"
            if SEVERITY_ORDER[latency_severity] < SEVERITY_ORDER[row["severity"]]:
                row["severity"] = latency_severity

        ssl_query = "probe_ssl_earliest_cert_expiry{" + self._selector('job="blackbox-http"') + "}"
        for item in self.prometheus.query(ssl_query):
            instance = item["metric"].get("instance", "unknown")
            if instance in rows and instance.lower().startswith("https://"):
                rows[instance]["ssl_days_remaining"] = (float(item["value"][1]) - now.timestamp()) / 86400
        result = list(rows.values())
        result.sort(key=lambda row: (SEVERITY_ORDER[row["severity"]], row["success_percent"], row["instance"]))
        return result

    def _classify_problems(self, events: list[dict[str, Any]], results: dict[str, list[dict[str, Any]]], period: WeeklyPeriod) -> dict[str, list[dict[str, Any]]]:
        groups = {"new": [], "repeated": [], "carried": [], "resolved": [], "active": []}
        for event in events:
            if not event["days"]:
                continue
            if event["seen_previous_week"]:
                groups["carried"].append(event)
            elif event["days"] >= WEEKLY_THRESHOLDS.recurring_days or event["events"] >= 2:
                groups["repeated"].append(event)
            else:
                groups["new"].append(event)
            if event["active_at_end"]:
                groups["active"].append(event)
            else:
                groups["resolved"].append(event)
        return groups

    def _highlights(self, snapshot: WeeklySnapshot) -> list[dict[str, Any]]:
        candidates = []
        for category, rows in snapshot.statistics.items():
            if category == "reboots":
                continue
            for row in rows:
                severity = row.get("severity", "healthy")
                if severity == "healthy":
                    continue
                subject = row.get("instance") or row.get("device") or row.get("site", "unknown")
                duration = max(row.get("warning_minutes", 0) or 0, row.get("downtime_minutes", 0) or 0, row.get("critical_minutes", 0) or 0)
                days = row.get("affected_days", 0) or 0
                if category == "availability":
                    summary = f"доступность {row['availability_percent']:.2f}%, простой {row['downtime_minutes']:.0f} мин"
                    delta = row.get("availability_delta_pp")
                    direction = delta_direction(delta, True)
                    delta_unit = " п.п."
                elif category == "cpu":
                    summary = f"CPU p95 {row['p95_percent']:.1f}%, выше порога {row['warning_minutes']:.0f} мин"
                    delta = row.get("p95_delta_pp")
                    direction = delta_direction(delta, False)
                    delta_unit = " п.п."
                elif category == "ram":
                    summary = f"RAM p5 {row['p5_percent']:.1f}%, дефицит {row['warning_minutes']:.0f} мин"
                    delta = row.get("p5_delta_pp")
                    direction = delta_direction(delta, True)
                    delta_unit = " п.п."
                elif category == "websites":
                    summary = f"успешность {row['success_percent']:.1f}%, p95 ответа {row.get('p95_seconds') or 0:.2f} сек"
                    delta = row.get("success_delta_pp")
                    direction = delta_direction(delta, True)
                    delta_unit = " п.п."
                elif category == "disks":
                    summary = f"{row.get('device', '')}: свободно минимум {row.get('minimum_free_percent') if row.get('minimum_free_percent') is not None else 0:.1f}%, I/O read p95 {row.get('read_p95_ms') or 0:.0f} мс"
                    delta = row.get("change_pp")
                    direction = delta_direction(delta, True)
                    delta_unit = " п.п."
                elif category == "sql":
                    ple = row.get("ple") or {}
                    worst = row.get("databases", [{}])[0] if row.get("databases") else {}
                    summary = f"SQL: log p95 {worst.get('p95_percent') or 0:.1f}%, PLE p5 {ple.get('p5_seconds') or 0:.0f} сек"
                    delta = None
                    direction = "neutral"
                    delta_unit = ""
                    duration = max(worst.get("warning_minutes", 0) or 0, ple.get("warning_minutes", 0) or 0)
                    days = max(worst.get("affected_days", 0) or 0, ple.get("affected_days", 0) or 0)
                else:
                    summary = f"{category}: обнаружены отклонения"
                    delta = None
                    direction = "neutral"
                    delta_unit = ""
                score = (1000 if severity == "critical" else 500) + duration + days * 60 + (100 if direction == "worsened" else 0)
                candidates.append({"severity": severity, "subject": subject, "category": category, "summary": summary, "duration_minutes": duration, "affected_days": days, "delta": delta, "delta_unit": delta_unit, "direction": direction, "score": score})
        candidates.sort(key=lambda item: (-item["score"], item["subject"]))
        return candidates[:10]

    def _quality(self, snapshot: WeeklySnapshot) -> dict[str, Any]:
        rows = [row for section in snapshot.statistics.values() for row in section]
        partial = [row for row in rows if row.get("coverage_percent") is not None and row["coverage_percent"] < WEEKLY_THRESHOLDS.minimum_coverage_percent]
        missing_sections = [name for name in ("availability", "cpu", "ram", "disks", "sql", "network", "proxy", "websites") if name not in snapshot.successful_collectors]
        processed = len(rows)
        return {"processed_objects": processed, "partial_objects": len(partial), "partial_object_names": sorted({row.get("instance") or row.get("device") or row.get("site", "unknown") for row in partial}), "query_errors": snapshot.collector_errors, "missing_sections": missing_sections, "success_percent": ((processed - len(partial)) / processed * 100 if processed else 0.0), "limitations": ["Interface flaps, errors/discards and utilization are omitted where the corresponding time-series are not collected.", "Planned maintenance is not excluded because no maintenance source is configured.", "Причина перезагрузки не определяется без подтверждающего события ОС."]}

    def _summary(self, snapshot: WeeklySnapshot) -> dict[str, Any]:
        availability = snapshot.statistics.get("availability", [])
        total_samples_weight = sum(max(row.get("coverage_percent", 0), 0) for row in availability)
        overall = (sum(row["availability_percent"] * max(row.get("coverage_percent", 0), 0) for row in availability) / total_samples_weight if total_samples_weight else None)
        downtime = sum(row.get("downtime_minutes", 0) for row in availability)
        unique_objects = len({row.get("object_id") for row in availability})
        base_problems = [
            event
            for key in ("new", "repeated", "carried")
            for event in snapshot.problems.get(key, [])
        ]
        critical = len(
            {
                event["key"]
                for event in base_problems
                if event.get("severity") == "critical"
            }
        )
        current_problem_count = len(base_problems)
        previous_problem_count = sum(1 for event in snapshot.problems.get("carried", []) if event.get("seen_previous_week"))
        eligible = [
            row for row in availability
            if row.get("coverage_percent", 0) >= WEEKLY_THRESHOLDS.minimum_coverage_percent
        ]
        sla_met = sum(
            row.get("availability_percent", 0) >= WEEKLY_THRESHOLDS.business_sla_percent
            for row in eligible
        )
        previous_eligible = [
            row for row in eligible
            if row.get("previous_availability_percent") is not None
        ]
        previous_sla_met = sum(
            row["previous_availability_percent"] >= WEEKLY_THRESHOLDS.business_sla_percent
            for row in previous_eligible
        )
        comparable_current_sla_met = sum(
            row.get("coverage_percent", 0) >= WEEKLY_THRESHOLDS.minimum_coverage_percent
            and row.get("availability_percent", 0) >= WEEKLY_THRESHOLDS.business_sla_percent
            for row in previous_eligible
        )
        sla_percent = sla_met / len(availability) * 100 if availability else None
        comparable_current_sla_percent = (
            comparable_current_sla_met / len(previous_eligible) * 100
            if previous_eligible else None
        )
        previous_sla_percent = (
            previous_sla_met / len(previous_eligible) * 100
            if previous_eligible else None
        )
        affected = [row for row in eligible if row.get("downtime_minutes", 0) > 0]
        longest = max(
            eligible,
            key=lambda row: row.get("longest_downtime_minutes", 0),
            default=None,
        )

        websites = snapshot.statistics.get("websites", [])
        websites_sla_met = sum(
            row.get("success_percent", 0) >= WEEKLY_THRESHOLDS.business_website_sla_percent
            for row in websites
        )
        worst_website = min(
            websites,
            key=lambda row: row.get("success_percent", 101),
            default=None,
        )

        risk_categories = ("cpu", "ram", "disks", "sql")
        risk_rows = [
            row
            for category in risk_categories
            for row in snapshot.statistics.get(category, [])
            if row.get("severity") in {"warning", "critical"}
        ]
        risk_objects = sorted(
            {
                row.get("instance") or row.get("device") or "unknown"
                for row in risk_rows
            }
        )
        active_problems = snapshot.problems.get("active", [])
        business = {
            "sla_target_percent": WEEKLY_THRESHOLDS.business_sla_percent,
            "sla_met": sla_met,
            "sla_total": len(availability),
            "sla_eligible": len(eligible),
            "sla_percent": sla_percent,
            "sla_previous_percent": previous_sla_percent,
            "sla_delta_pp": comparison_delta(comparable_current_sla_percent, previous_sla_percent),
            "without_downtime": sum(row.get("downtime_minutes", 0) == 0 for row in eligible),
            "affected_objects": len(affected),
            "incomplete_objects": len(availability) - len(eligible),
            "website_sla_target_percent": WEEKLY_THRESHOLDS.business_website_sla_percent,
            "website_sla_met": websites_sla_met,
            "websites_total": len(websites),
            "website_failed_checks": sum(row.get("failed_checks", 0) for row in websites),
            "worst_website": worst_website.get("instance") if worst_website else None,
            "worst_website_success_percent": worst_website.get("success_percent") if worst_website else None,
            "resource_risk_objects": len(risk_objects),
            "resource_risk_names": risk_objects,
            "active_problems": len(active_problems),
            "active_critical_problems": sum(row.get("severity") == "critical" for row in active_problems),
            "longest_downtime_minutes": longest.get("longest_downtime_minutes", 0) if longest else 0,
            "longest_downtime_object": longest.get("instance") if longest else None,
        }
        return {
            "objects": unique_objects,
            "availability_percent": overall,
            "downtime_minutes": downtime,
            "critical_events": critical,
            "recurring_problems": len(snapshot.problems.get("repeated", [])) + len(snapshot.problems.get("carried", [])),
            "problem_delta": current_problem_count - previous_problem_count,
            "business": business,
        }
