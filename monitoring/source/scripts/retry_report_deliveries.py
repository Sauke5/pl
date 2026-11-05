#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from monitoring_summary.config import load_settings
from monitoring_summary.delivery import (
    DeliveryDispatcher,
    daily_caption,
    weekly_caption,
)
from monitoring_summary.html_report import report_manifest_entries
from monitoring_summary.logging_config import configure_logging

LOGGER = logging.getLogger(__name__)
WEEK_RE = re.compile(r"^(?P<year>\d{4})-W(?P<week>\d{2})$")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Retry queued Telegram HTML report deliveries."
    )
    parser.add_argument("--base-dir", type=Path)
    parser.add_argument("--limit", type=int, default=4)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore next_attempt_at and retry pending reports immediately.",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Print queue status without sending anything.",
    )
    parser.add_argument(
        "--enqueue-daily",
        type=date.fromisoformat,
        metavar="YYYY-MM-DD",
        help="Queue the latest already-published daily report for this date.",
    )
    parser.add_argument(
        "--enqueue-weekly",
        metavar="YYYY-Www",
        help="Queue an already-published weekly report.",
    )
    return parser


def enqueue_published_report(
    dispatcher: DeliveryDispatcher,
    reports_dir: Path,
    *,
    daily: date | None,
    weekly: str | None,
) -> int | None:
    entries = report_manifest_entries(reports_dir)
    if daily:
        matches = [
            item
            for item in entries
            if item.get("report_type") == "daily"
            and item.get("date") == daily.isoformat()
        ]
        if not matches:
            raise RuntimeError(f"published daily report {daily} was not found")
        selected = max(matches, key=lambda item: int(item["run"]))
        delivery = dispatcher.outbox.enqueue(
            report_type="daily",
            scope="central",
            period_key=daily.isoformat(),
            receiver_name="telegram-silent",
            report_path=reports_dir / str(selected["file"]),
            caption_html=daily_caption(daily, int(selected["run"])),
        )
        return delivery.id
    if weekly:
        match = WEEK_RE.fullmatch(weekly)
        if not match:
            raise RuntimeError("--enqueue-weekly must match YYYY-Www")
        iso_year = int(match.group("year"))
        iso_week = int(match.group("week"))
        matches = [
            item
            for item in entries
            if item.get("report_type") == "weekly"
            and item.get("iso_year") == iso_year
            and item.get("iso_week") == iso_week
        ]
        if not matches:
            raise RuntimeError(f"published weekly report {weekly} was not found")
        selected = max(matches, key=lambda item: int(item["run"]))
        start = datetime.fromisocalendar(iso_year, iso_week, 1).date()
        end = start + timedelta(days=4)
        delivery = dispatcher.outbox.enqueue(
            report_type="weekly",
            scope="central",
            period_key=weekly,
            receiver_name="telegram-silent",
            report_path=reports_dir / str(selected["file"]),
            caption_html=weekly_caption(weekly, start, end),
        )
        return delivery.id
    return None


def reconcile_latest_published(
    dispatcher: DeliveryDispatcher,
    reports_dir: Path,
) -> list[int]:
    """Heal publish-before-enqueue crashes without replaying historical reports.

    An explicit backfill seeds each report type on initial deployment. After
    that, only a strictly newer published daily date or ISO week is enqueued.
    """
    entries = report_manifest_entries(reports_dir)
    enqueued: list[int] = []
    for report_type in ("daily", "weekly"):
        known_period = dispatcher.outbox.latest_period(report_type)
        if known_period is None:
            continue
        candidates = [
            item for item in entries if item.get("report_type") == report_type
        ]
        if not candidates:
            continue
        if report_type == "daily":
            missing_periods = sorted(
                {
                    str(item["date"])
                    for item in candidates
                    if str(item["date"]) > known_period
                }
            )
            for period in missing_periods:
                delivery_id = enqueue_published_report(
                    dispatcher,
                    reports_dir,
                    daily=date.fromisoformat(period),
                    weekly=None,
                )
                if delivery_id is not None:
                    enqueued.append(delivery_id)
        else:
            missing_periods = sorted(
                {
                    f"{int(item['iso_year']):04d}-W{int(item['iso_week']):02d}"
                    for item in candidates
                    if (
                        f"{int(item['iso_year']):04d}-W{int(item['iso_week']):02d}"
                        > known_period
                    )
                }
            )
            for period in missing_periods:
                delivery_id = enqueue_published_report(
                    dispatcher,
                    reports_dir,
                    daily=None,
                    weekly=period,
                )
                if delivery_id is not None:
                    enqueued.append(delivery_id)
    return enqueued


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.base_dir)
    configure_logging(settings.base_dir, None, report_type="delivery")
    dispatcher = DeliveryDispatcher(settings.base_dir)
    if args.status:
        payload = dispatcher.outbox.status()
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    delivery_id = enqueue_published_report(
        dispatcher,
        settings.reports_dir,
        daily=args.enqueue_daily,
        weekly=args.enqueue_weekly,
    )
    reconciled_ids = reconcile_latest_published(dispatcher, settings.reports_dir)
    selected_ids = ([delivery_id] if delivery_id is not None else []) + reconciled_ids
    result = dispatcher.dispatch(
        limit=max(1, args.limit),
        delivery_ids=tuple(selected_ids),
        force=args.force or delivery_id is not None,
    )
    payload = {
        **result,
        "reconciled": len(reconciled_ids),
        "queue": dispatcher.outbox.status(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    LOGGER.info("telegram_delivery_run_done result=%s", payload)
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
