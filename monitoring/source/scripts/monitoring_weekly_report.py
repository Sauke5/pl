#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import logging
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterator, TextIO

from monitoring_summary.clients import PrometheusClient
from monitoring_summary.collectors.base import MSK
from monitoring_summary.config import load_settings
from monitoring_summary.delivery import DeliveryDispatcher, DeliveryOutbox, weekly_caption
from monitoring_summary.logging_config import configure_logging
from monitoring_summary.storage import IncidentStore
from monitoring_summary.weekly import (
    WeeklyPeriod,
    parse_iso_week,
    previous_week_period,
    weekly_period_for_date,
)
from monitoring_summary.weekly_collector import WeeklyCollector
from monitoring_summary.weekly_html import write_weekly_report

LOGGER = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate and publish the weekly infrastructure report."
    )
    parser.add_argument("--base-dir", type=Path)
    parser.add_argument("--week", help="ISO week in YYYY-Www format; defaults to the latest completed report period.")
    parser.add_argument("--allow-incomplete", action="store_true", help="Allow an explicit week whose Friday 17:30 boundary has not passed.")
    parser.add_argument("--prometheus-url")
    parser.add_argument("--database", type=Path)
    parser.add_argument("--reports-dir", type=Path)
    parser.add_argument("--json", action="store_true", help="Print the collected snapshot as JSON.")
    return parser


def select_period(now: datetime, value: str | None) -> WeeklyPeriod:
    if value:
        return parse_iso_week(value)
    current = weekly_period_for_date(now.date())
    return current if now >= current.end else previous_week_period(current)


@contextmanager
def exclusive_lock(path: Path) -> Iterator[TextIO]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("weekly report generation is already running") from exc
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={__import__('os').getpid()} started={datetime.now(MSK).isoformat()}\n")
        handle.flush()
        yield handle
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.base_dir)
    log_path = configure_logging(settings.base_dir, None, report_type="weekly")
    now = datetime.now(MSK)
    period = select_period(now, args.week)
    if period.end > now and not args.allow_incomplete:
        raise RuntimeError(
            f"report period {period.key} ends at {period.end.isoformat()}; "
            "use --allow-incomplete only for an intentional test"
        )

    reports_dir = args.reports_dir or settings.reports_dir
    database_path = args.database or settings.database_path
    prometheus_url = args.prometheus_url or settings.prometheus_url
    lock_path = settings.data_dir / ".locks" / "weekly-report.lock"
    LOGGER.info(
        "weekly_report_start period=%s start=%s end=%s prometheus=%s reports_dir=%s log=%s",
        period.key,
        period.start.isoformat(),
        period.end.isoformat(),
        prometheus_url,
        reports_dir,
        log_path,
    )

    with exclusive_lock(lock_path):
        collector = WeeklyCollector(
            PrometheusClient(prometheus_url),
            settings.ram_exclude_instances,
        )
        snapshot = collector.collect(period, now)
        if "availability" not in snapshot.successful_collectors:
            raise RuntimeError("availability collector failed; weekly report was not published")
        if not snapshot.statistics.get("availability"):
            raise RuntimeError("availability data is empty; weekly report was not published")

        filename = f"infrastructure-weekly-{period.iso_year}-W{period.iso_week:02d}-run-1.html"
        store = IncidentStore(database_path)
        run_number = store.start_weekly_report(snapshot, filename)
        try:
            report_path = write_weekly_report(
                snapshot,
                run_number,
                reports_dir,
                settings.portal_url,
                settings.weekly_report_retention_weeks,
            )
        except Exception as exc:
            store.finish_weekly_report(period.iso_year, period.iso_week, "failed", f"{type(exc).__name__}: {exc}")
            raise
        store.finish_weekly_report(period.iso_year, period.iso_week, "completed")

    delivery = DeliveryOutbox(settings.base_dir).enqueue(
        report_type="weekly",
        scope="central",
        period_key=period.key,
        receiver_name="telegram-silent",
        report_path=report_path,
        caption_html=weekly_caption(
            period.key,
            period.start.date(),
            period.end.date(),
        ),
    )
    delivery_result = DeliveryDispatcher(settings.base_dir).dispatch(
        delivery_ids=(delivery.id,),
        force=True,
    )

    payload = {
        "ok": True,
        "report_type": "weekly",
        "period": period.key,
        "run": run_number,
        "path": str(report_path),
        "collector_errors": snapshot.collector_errors,
        "telegram_delivery": delivery_result,
    }
    if args.json:
        payload["snapshot"] = snapshot.to_dict()
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    LOGGER.info(
        "weekly_report_done period=%s run=%s path=%s collector_errors=%s telegram_delivery=%s",
        period.key,
        run_number,
        report_path,
        sorted(snapshot.collector_errors),
        delivery_result,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        logging.getLogger(__name__).critical("weekly_report_failed: %s", exc, exc_info=True)
        raise
