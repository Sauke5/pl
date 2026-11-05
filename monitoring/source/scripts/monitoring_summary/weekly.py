from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

from .collectors.base import (
    DISK_FREE_CRITICAL_PERCENT,
    DISK_FREE_WARNING_PERCENT,
    DISK_LATENCY_MS_THRESHOLD,
    MSK,
    SQL_LOG_CRITICAL_PERCENT,
    SQL_LOG_WARNING_PERCENT,
    SQL_PLE_CRITICAL_SECONDS,
    SQL_PLE_WARNING_SECONDS,
    WEBSITE_AVERAGE_LATENCY_CRITICAL_SECONDS,
    WEBSITE_AVERAGE_LATENCY_WARNING_SECONDS,
    WEBSITE_SUCCESS_CRITICAL_PERCENT,
    WEBSITE_SUCCESS_WARNING_PERCENT,
)

WEEKLY_REPORT_TYPE = "weekly"
WEEKLY_RETENTION_WEEKS_DEFAULT = 104


@dataclass(frozen=True)
class WeeklyThresholds:
    """Weekly classification thresholds kept outside HTML rendering."""

    cpu_warning_percent: float = 80.0
    cpu_critical_percent: float = 95.0
    cpu_min_warning_minutes: int = 30
    cpu_min_critical_minutes: int = 15
    ram_warning_percent: float = 10.0
    ram_critical_percent: float = 3.0
    ram_min_warning_minutes: int = 30
    ram_min_critical_minutes: int = 15
    disk_free_warning_percent: float = DISK_FREE_WARNING_PERCENT
    disk_free_critical_percent: float = DISK_FREE_CRITICAL_PERCENT
    disk_latency_warning_ms: float = DISK_LATENCY_MS_THRESHOLD
    disk_latency_critical_ms: float = 300.0
    sql_log_warning_percent: float = SQL_LOG_WARNING_PERCENT
    sql_log_critical_percent: float = SQL_LOG_CRITICAL_PERCENT
    sql_ple_warning_seconds: float = SQL_PLE_WARNING_SECONDS
    sql_ple_critical_seconds: float = SQL_PLE_CRITICAL_SECONDS
    website_success_warning_percent: float = WEBSITE_SUCCESS_WARNING_PERCENT
    website_success_critical_percent: float = WEBSITE_SUCCESS_CRITICAL_PERCENT
    website_latency_warning_seconds: float = WEBSITE_AVERAGE_LATENCY_WARNING_SECONDS
    website_latency_critical_seconds: float = WEBSITE_AVERAGE_LATENCY_CRITICAL_SECONDS
    recurring_days: int = 2
    minimum_coverage_percent: float = 95.0
    business_sla_percent: float = 99.9
    business_website_sla_percent: float = 99.0


WEEKLY_THRESHOLDS = WeeklyThresholds()


@dataclass(frozen=True)
class WeeklyPeriod:
    iso_year: int
    iso_week: int
    start: datetime
    end: datetime
    work_windows: tuple[tuple[datetime, datetime], ...]

    @property
    def key(self) -> str:
        return f"{self.iso_year}-W{self.iso_week:02d}"

    @property
    def days(self) -> tuple[date, ...]:
        return tuple(self.start.date() + timedelta(days=index) for index in range(5))

    def contains(self, moment: datetime) -> bool:
        return self.start <= moment <= self.end

    def contains_work_time(self, moment: datetime) -> bool:
        return any(start <= moment <= end for start, end in self.work_windows)


def weekly_period(iso_year: int, iso_week: int) -> WeeklyPeriod:
    monday = date.fromisocalendar(iso_year, iso_week, 1)
    start = datetime.combine(monday, time.min, tzinfo=MSK)
    end = datetime.combine(monday + timedelta(days=4), time(17, 30), tzinfo=MSK)
    windows = []
    for offset in range(5):
        day = monday + timedelta(days=offset)
        window_end = time(17, 30) if offset == 4 else time(18, 0)
        windows.append(
            (
                datetime.combine(day, time(9, 0), tzinfo=MSK),
                datetime.combine(day, window_end, tzinfo=MSK),
            )
        )
    return WeeklyPeriod(iso_year, iso_week, start, end, tuple(windows))


def weekly_period_for_date(day: date) -> WeeklyPeriod:
    iso = day.isocalendar()
    return weekly_period(iso.year, iso.week)


def previous_week_period(period: WeeklyPeriod) -> WeeklyPeriod:
    return weekly_period_for_date(period.start.date() - timedelta(days=7))


def parse_iso_week(value: str) -> WeeklyPeriod:
    try:
        year_text, week_text = value.upper().split("-W", 1)
        return weekly_period(int(year_text), int(week_text))
    except (TypeError, ValueError) as exc:
        raise ValueError("week must use YYYY-Www format, for example 2026-W28") from exc


def finite_samples(series: dict[str, Any]) -> list[tuple[datetime, float]]:
    result = []
    for raw_timestamp, raw_value in series.get("values", []):
        try:
            value = float(raw_value)
            timestamp = float(raw_timestamp)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(value):
            continue
        result.append((datetime.fromtimestamp(timestamp, MSK), value))
    return result


def samples_for_period(
    series: dict[str, Any],
    period: WeeklyPeriod,
    working_time: bool,
) -> list[tuple[datetime, float]]:
    predicate = period.contains_work_time if working_time else period.contains
    return [(moment, value) for moment, value in finite_samples(series) if predicate(moment)]


def percentile(values: Iterable[float], percentile_value: float) -> float | None:
    ordered = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * percentile_value / 100
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def sample_step_minutes(samples: list[tuple[datetime, float]], default: int = 5) -> float:
    gaps = [
        (right[0] - left[0]).total_seconds() / 60
        for left, right in zip(samples, samples[1:])
        if 0 < (right[0] - left[0]).total_seconds() <= 3600
    ]
    value = percentile(gaps, 50) if gaps else None
    return value or float(default)


def duration_where(
    samples: list[tuple[datetime, float]], predicate: Callable[[float], bool]
) -> float:
    step = sample_step_minutes(samples)
    return sum(step for _, value in samples if predicate(value))


def event_intervals(
    samples: list[tuple[datetime, float]],
    predicate: Callable[[float], bool],
) -> list[dict[str, Any]]:
    if not samples:
        return []
    step = sample_step_minutes(samples)
    maximum_gap = timedelta(minutes=step * 1.6)
    result: list[dict[str, Any]] = []
    start: datetime | None = None
    last: datetime | None = None
    for moment, value in samples:
        active = predicate(value)
        if active and (start is None or (last is not None and moment - last > maximum_gap)):
            if start is not None and last is not None:
                result.append(_interval(start, last, step))
            start = moment
        elif not active and start is not None and last is not None:
            result.append(_interval(start, last, step))
            start = None
        last = moment
    if start is not None and last is not None:
        result.append(_interval(start, last, step))
    return result


def _interval(start: datetime, last: datetime, step_minutes: float) -> dict[str, Any]:
    end = last + timedelta(minutes=step_minutes)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "duration_minutes": round((end - start).total_seconds() / 60, 1),
    }


def daily_stat(
    samples: list[tuple[datetime, float]],
    days: Iterable[date],
    reducer: Callable[[list[float]], float],
) -> list[float | None]:
    by_day: dict[date, list[float]] = {day: [] for day in days}
    for moment, value in samples:
        if moment.date() in by_day:
            by_day[moment.date()].append(value)
    return [reducer(by_day[day]) if by_day[day] else None for day in days]


def coverage_percent(samples: list[tuple[datetime, float]], expected_minutes: float) -> float:
    if not samples or expected_minutes <= 0:
        return 0.0
    covered = len(samples) * sample_step_minutes(samples)
    return min(100.0, covered / expected_minutes * 100)


def work_minutes(period: WeeklyPeriod) -> float:
    return sum((end - start).total_seconds() / 60 for start, end in period.work_windows)


def period_minutes(period: WeeklyPeriod) -> float:
    return (period.end - period.start).total_seconds() / 60


STABLE_IDENTITY_LABELS = (
    "instance",
    "device",
    "volume",
    "mountpoint",
    "database",
    "mssql_instance",
    "site",
    "port",
    "check_type",
    "interface",
    "ifName",
    "job",
    "branch",
)


def stable_problem_key(category: str, labels: dict[str, Any]) -> str:
    identity = "|".join(
        f"{label}={labels[label]}"
        for label in STABLE_IDENTITY_LABELS
        if labels.get(label) not in (None, "")
    )
    return hashlib.sha256(f"{category}|{identity}".encode("utf-8")).hexdigest()


def comparison_delta(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None:
        return None
    return current - previous


def delta_direction(delta: float | None, higher_is_better: bool) -> str:
    if delta is None or abs(delta) < 1e-9:
        return "neutral"
    improved = delta > 0 if higher_is_better else delta < 0
    return "improved" if improved else "worsened"


@dataclass
class WeeklySnapshot:
    generated_at: datetime
    period: WeeklyPeriod
    previous_period: WeeklyPeriod
    statistics: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    problems: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    highlights: list[dict[str, Any]] = field(default_factory=list)
    collector_errors: dict[str, str] = field(default_factory=dict)
    successful_collectors: set[str] = field(default_factory=set)
    quality: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_type": WEEKLY_REPORT_TYPE,
            "generated_at": self.generated_at.isoformat(),
            "timezone": str(self.generated_at.tzinfo),
            "period": {
                **asdict(self.period),
                "start": self.period.start.isoformat(),
                "end": self.period.end.isoformat(),
                "work_windows": [
                    [start.isoformat(), end.isoformat()]
                    for start, end in self.period.work_windows
                ],
            },
            "previous_period": {
                **asdict(self.previous_period),
                "start": self.previous_period.start.isoformat(),
                "end": self.previous_period.end.isoformat(),
                "work_windows": [
                    [start.isoformat(), end.isoformat()]
                    for start, end in self.previous_period.work_windows
                ],
            },
            "statistics": self.statistics,
            "problems": self.problems,
            "highlights": self.highlights,
            "collector_errors": self.collector_errors,
            "successful_collectors": sorted(self.successful_collectors),
            "quality": self.quality,
            "summary": self.summary,
        }
