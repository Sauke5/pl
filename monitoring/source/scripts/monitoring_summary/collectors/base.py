from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from statistics import mean, median
from typing import Any, Callable
from zoneinfo import ZoneInfo

from ..clients import PrometheusClient
from ..models import Finding, MonitoringSnapshot

MSK = ZoneInfo("Europe/Moscow")
LOGGER = logging.getLogger(__name__)

# Пороги ниже относятся к ежедневному HTML/Telegram-отчету.
# Они не заменяют alert rules Prometheus и могут быть мягче, чтобы отчет
# показывал тенденции и деградации без лишнего шума в аварийных уведомлениях.
CPU_AVG_THRESHOLD = 60.0
RAM_SUSTAINED_CRITICAL_MINUTES = 10
RAM_STANDARD_WARNING_GB = 2.0
RAM_STANDARD_CRITICAL_GB = 1.0
RAM_STANDARD_WARNING_PERCENT = 10.0
RAM_STANDARD_CRITICAL_PERCENT = 3.0
RAM_SQL_WARNING_GB = 2.0
RAM_SQL_CRITICAL_GB = 1.0
RAM_SMALL_HOST_WARNING_PERCENT = 15.0
RAM_SMALL_HOST_CRITICAL_GB = 0.25
RAM_SMALL_HOST_WARNING_GB = 0.5
DISK_FREE_WARNING_PERCENT = 10.0
DISK_FREE_CRITICAL_PERCENT = 3.0
DISK_LATENCY_MS_THRESHOLD = 50.0
MIN_REPORTED_DOWNTIME_MINUTES = 3
SQL_LOG_WARNING_PERCENT = 70.0
SQL_LOG_CRITICAL_PERCENT = 90.0
SQL_PLE_WARNING_SECONDS = 600.0
SQL_PLE_CRITICAL_SECONDS = 300.0
WEBSITE_SUCCESS_WARNING_PERCENT = 95.0
WEBSITE_SUCCESS_CRITICAL_PERCENT = 90.0
WEBSITE_AVERAGE_LATENCY_WARNING_SECONDS = 4.0
WEBSITE_AVERAGE_LATENCY_CRITICAL_SECONDS = 8.0
WEBSITE_SSL_WARNING_DAYS = 30.0
WEBSITE_SSL_CRITICAL_DAYS = 14.0
PROXY_SUCCESS_WARNING_PERCENT = 99.0
PROXY_SUCCESS_CRITICAL_PERCENT = 95.0
PROXY_CONNECT_SLOW_SECONDS = 1.0
CENTRAL_BRANCH_LABELS = frozenset({"aprelevka"})
IF_OPER_STATUS = {
    1: "up",
    2: "down",
    3: "testing",
    4: "unknown",
    5: "dormant",
    6: "notPresent",
    7: "lowerLayerDown",
}
MSK_HUAWEI_USG_INTERFACES = frozenset(
    {"GigabitEthernet0/0/8", "Tunnel100"}
)
BRANCH_HUAWEI_AR720_INTERFACES = frozenset(
    {"GigabitEthernet0/0/8", "Tunnel0/0/1"}
)
HUAWEI_SWITCH_MODEL_PREFIXES = ("S5735",)
HUAWEI_SWITCH_INTERFACE_PREFIXES = (
    "GigabitEthernet",
    "XGigabitEthernet",
    "Eth-Trunk",
)
PROXY_SITE_MATCHER = "relay|final-212|final-185|final-2"
PROXY_NETWORK_DROP_RATE_WARNING = 10.0
PROXY_NETWORK_DROP_RATIO_WARNING = 0.01


def previous_workday(day: date) -> date:
    result = day - timedelta(days=1)
    while result.weekday() >= 5:
        result -= timedelta(days=1)
    return result


def workday_dates(target: date, count: int = 7) -> list[date]:
    days = [target]
    while len(days) < count:
        days.append(previous_workday(days[-1]))
    return list(reversed(days))


def previous_workday_window(now: datetime | None = None) -> tuple[datetime, datetime]:
    current = now or datetime.now(MSK)
    day = previous_workday(current.date())
    return (
        datetime.combine(day, time(9, 0), tzinfo=MSK),
        datetime.combine(day, time(18, 0), tzinfo=MSK),
    )


def full_day_window(day: date) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time.min, tzinfo=MSK)
    return start, start + timedelta(days=1)


def values_from_range(series: dict[str, Any]) -> list[float]:
    return [
        float(value)
        for _, value in series.get("values", [])
        if value not in ("NaN", "+Inf", "-Inf")
    ]


def daily_values(
    series: dict[str, Any],
    allowed_days: set[date],
    working_hours: bool = True,
) -> dict[date, list[float]]:
    result: dict[date, list[float]] = defaultdict(list)
    for raw_timestamp, raw_value in series.get("values", []):
        if raw_value in ("NaN", "+Inf", "-Inf"):
            continue
        moment = datetime.fromtimestamp(float(raw_timestamp), MSK)
        if moment.date() not in allowed_days:
            continue
        if working_hours and not time(9, 0) <= moment.time() <= time(18, 0):
            continue
        result[moment.date()].append(float(raw_value))
    return result


def reduced_trend(
    grouped: dict[date, list[float]],
    days: list[date],
    reducer: Callable[[list[float]], float],
) -> list[float | None]:
    return [reducer(grouped[day]) if grouped.get(day) else None for day in days]


def average_present(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return mean(present) if present else None


def gb(value: float) -> float:
    return value / 1024 / 1024 / 1024


def downtime_intervals(
    series: dict[str, Any],
    target_day: date,
    step: timedelta = timedelta(minutes=1),
) -> list[dict[str, Any]]:
    intervals = []
    start_at: datetime | None = None
    last_down_at: datetime | None = None
    for raw_timestamp, raw_value in series.get("values", []):
        if raw_value in ("NaN", "+Inf", "-Inf"):
            continue
        moment = datetime.fromtimestamp(float(raw_timestamp), MSK)
        if moment.date() != target_day:
            continue
        if float(raw_value) == 0:
            if start_at is None:
                start_at = moment
            last_down_at = moment
            continue
        if start_at is not None and last_down_at is not None:
            end_at = last_down_at + step
            intervals.append(
                {
                    "start": start_at.isoformat(),
                    "end": end_at.isoformat(),
                    "duration_minutes": max(
                        1, round((end_at - start_at).total_seconds() / 60)
                    ),
                }
            )
        start_at = None
        last_down_at = None
    if start_at is not None and last_down_at is not None:
        end_at = min(
            last_down_at + step,
            datetime.combine(target_day + timedelta(days=1), time.min, tzinfo=MSK),
        )
        intervals.append(
            {
                "start": start_at.isoformat(),
                "end": end_at.isoformat(),
                "duration_minutes": max(
                    1, round((end_at - start_at).total_seconds() / 60)
                ),
            }
        )
    return intervals


def reported_downtime_intervals(
    intervals: list[dict[str, Any]],
    minimum_minutes: int = MIN_REPORTED_DOWNTIME_MINUTES,
) -> list[dict[str, Any]]:
    return [
        interval
        for interval in intervals
        if interval["duration_minutes"] >= minimum_minutes
    ]


def downtime_minutes(intervals: list[dict[str, Any]]) -> int:
    return sum(interval["duration_minutes"] for interval in intervals)


def counter_increase(values: list[float]) -> float:
    if not values:
        return 0.0
    total = 0.0
    previous = values[0]
    for value in values[1:]:
        if value >= previous:
            total += value - previous
        else:
            total += value
        previous = value
    return total


def metric_context(metric: dict[str, str]) -> dict[str, str]:
    return {
        "role": metric.get("role", ""),
        "location": metric.get("location", ""),
        "job": metric.get("job", ""),
        "branch": metric.get("branch", ""),
        "site": metric.get("site", ""),
        "device": metric.get("device", ""),
        "vendor": metric.get("vendor", ""),
        "model": metric.get("model", ""),
        "check_type": metric.get("check_type", ""),
    }


def natural_name_key(value: str) -> list[int | str]:
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", value)
    ]


def is_expected_huawei_interface(
    device: str,
    model: str | None,
    interface: str,
) -> bool:
    if device == "msk-huawei-usg6615e":
        return interface in MSK_HUAWEI_USG_INTERFACES
    if device.endswith("-huawei-ar720") or (model or "").upper() == "AR720":
        return interface in BRANCH_HUAWEI_AR720_INTERFACES
    return False


def is_huawei_switch_model(model: str | None) -> bool:
    normalized = (model or "").upper()
    return normalized.startswith(HUAWEI_SWITCH_MODEL_PREFIXES)


def is_active_huawei_switch_interface(
    model: str | None,
    interface: str,
    status: float,
) -> bool:
    return (
        is_huawei_switch_model(model)
        and status == 1
        and interface.startswith(HUAWEI_SWITCH_INTERFACE_PREFIXES)
    )


def ram_severity(
    minimum_gb: float,
    minimum_percent: float,
    total_gb: float,
    role: str,
) -> str:
    normalized_role = role.lower()
    if normalized_role == "domain-controller":
        if minimum_gb < 250 / 1024 and minimum_percent < 5:
            return "critical"
        if minimum_gb < 500 / 1024 and minimum_percent < 15:
            return "warning"
        return "healthy"
    if "sql" in normalized_role:
        if minimum_gb < RAM_SQL_CRITICAL_GB:
            return "critical"
        if minimum_gb < RAM_SQL_WARNING_GB:
            return "warning"
        return "healthy"
    if total_gb <= 4:
        if minimum_gb < RAM_SMALL_HOST_CRITICAL_GB:
            return "critical"
        if (
            minimum_gb < RAM_SMALL_HOST_WARNING_GB
            and minimum_percent < RAM_SMALL_HOST_WARNING_PERCENT
        ):
            return "warning"
        return "healthy"
    if (
        minimum_gb < RAM_STANDARD_CRITICAL_GB
        or minimum_percent < RAM_STANDARD_CRITICAL_PERCENT
    ):
        return "critical"
    if (
        minimum_gb < RAM_STANDARD_WARNING_GB
        and minimum_percent < RAM_STANDARD_WARNING_PERCENT
    ):
        return "warning"
    return "healthy"


def ram_pressure(series: dict[str, Any], target_day: date, total: float, role: str) -> dict[str, Any]:
    """Estimate observed low-memory intervals at 1m resolution; gaps break episodes."""
    window_start = datetime.combine(target_day, time(9), tzinfo=MSK).timestamp()
    window_end = datetime.combine(target_day, time(18), tzinfo=MSK).timestamp()
    samples = sorted(
        (float(ts), float(value)) for ts, value in series.get("values", [])
        if value not in ("NaN", "+Inf", "-Inf") and window_start <= float(ts) <= window_end
    )
    totals = {"low": 0.0, "critical": 0.0}
    longest = {"low": 0.0, "critical": 0.0}
    runs = {"low": 0.0, "critical": 0.0}
    previous = None
    for timestamp, value in samples:
        if previous is not None and timestamp - previous > 60:
            runs = {"low": 0.0, "critical": 0.0}
        level = ram_severity(gb(value), value / total * 100, gb(total), role)
        duration = min(60, max(0, window_end - timestamp)) / 60
        for kind, active in (("low", level != "healthy"), ("critical", level == "critical")):
            runs[kind] = runs[kind] + duration if active else 0.0
            if active:
                totals[kind] += duration
            longest[kind] = max(longest[kind], runs[kind])
        previous = timestamp
    return {
        "low_minutes": totals["low"],
        "longest_low_minutes": longest["low"],
        "critical_minutes": totals["critical"],
        "longest_critical_minutes": longest["critical"],
        "sample_step_seconds": 60,
    }
