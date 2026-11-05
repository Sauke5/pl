from __future__ import annotations

import argparse
import json
import logging
import re
from datetime import date
from pathlib import Path

from .clients import PrometheusClient, TelegramClient
from .collector import MonitoringCollector
from .config import branch_telegram_settings, load_settings
from .delivery import DeliveryDispatcher, DeliveryOutbox, daily_caption
from .formatter import format_summary
from .html_report import write_html_report
from .logging_config import configure_logging
from .storage import IncidentStore

BRANCH_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,48}$")
LOGGER = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect, store and send the daily monitoring summary."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Collect and store data, but do not send Telegram message.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the structured snapshot as JSON.",
    )
    parser.add_argument(
        "--base-dir",
        type=Path,
        help="Monitoring repository root. Defaults to the script repository.",
    )
    parser.add_argument("--prometheus-url")
    parser.add_argument("--database", type=Path)
    parser.add_argument(
        "--reports-dir",
        type=Path,
        help="Directory for generated HTML reports.",
    )
    parser.add_argument(
        "--no-html",
        action="store_true",
        help="Do not generate the detailed HTML report.",
    )
    parser.add_argument(
        "--target-date",
        type=date.fromisoformat,
        help=(
            "Report date in YYYY-MM-DD format. Defaults to the previous "
            "business day."
        ),
    )
    parser.add_argument(
        "--branch",
        help=(
            "Build a report for a branch label, for example "
            "krasnodar. Branch reports use separate storage by default."
        ),
    )
    parser.add_argument(
        "--send-telegram",
        action="store_true",
        help=(
            "Allow Telegram delivery for a branch report. Central reports "
            "send Telegram by default unless --dry-run is used."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.base_dir)
    branch = args.branch.strip().lower() if args.branch else None
    log_path = configure_logging(settings.base_dir, branch)
    LOGGER.info(
        "report_start branch=%s dry_run=%s target_date=%s log=%s",
        branch or "central",
        args.dry_run,
        args.target_date,
        log_path,
    )
    if branch and not BRANCH_RE.match(branch):
        raise RuntimeError(
            "Branch must match ^[a-z0-9][a-z0-9_-]{0,48}$"
        )
    if branch and not args.dry_run and not args.send_telegram:
        raise RuntimeError(
            "Branch Telegram delivery requires --send-telegram"
        )
    prometheus_url = args.prometheus_url or settings.prometheus_url
    branch_root = settings.data_dir / "branch-reports" / branch if branch else None
    database_path = (
        args.database
        or (
            branch_root / "monitoring_history.sqlite3"
            if branch_root
            else settings.database_path
        )
    )
    reports_dir = (
        args.reports_dir
        or (branch_root / "reports" if branch_root else settings.reports_dir)
    )

    collector = MonitoringCollector(
        PrometheusClient(prometheus_url),
        settings.ram_exclude_instances,
        branch=branch,
    )
    LOGGER.info("collect_start prometheus=%s", prometheus_url)
    snapshot = collector.collect(target_date=args.target_date)
    LOGGER.info(
        "collect_done findings=%s collector_errors=%s",
        len(snapshot.findings),
        sorted(snapshot.collector_errors),
    )
    store = IncidentStore(database_path)
    LOGGER.info("storage_save_start database=%s", database_path)
    run_id = store.save_snapshot(snapshot)
    snapshot.history = store.changes_for_run(run_id)
    store.update_run_snapshot(run_id, snapshot)
    LOGGER.info("storage_save_done run_id=%s", run_id)
    report_path = None
    if not args.no_html:
        LOGGER.info("html_report_start reports_dir=%s", reports_dir)
        report_path = write_html_report(
            snapshot,
            run_id,
            reports_dir,
            settings.portal_url,
            settings.report_retention_days,
        )
        LOGGER.info("html_report_done path=%s", report_path)
    message = format_summary(
        snapshot,
        run_id,
        report_path.name if report_path else None,
    )

    if args.json:
        print(json.dumps(snapshot.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(message)

    if args.dry_run:
        LOGGER.info("report_done run_id=%s dry_run=true", run_id)
        return 0

    delivery_result: dict[str, object] | None = None
    if report_path:
        delivery = DeliveryOutbox(settings.base_dir).enqueue(
            report_type="daily",
            scope=branch or "central",
            period_key=snapshot.window_start.date().isoformat(),
            receiver_name=(
                f"telegram-branch-{branch}-silent"
                if branch
                else "telegram-silent"
            ),
            report_path=report_path,
            caption_html=daily_caption(
                snapshot.window_start.date(),
                run_id,
                branch,
            ),
        )
        LOGGER.info(
            "telegram_document_queued key=%s path=%s",
            delivery.delivery_key,
            delivery.spool_path,
        )
        delivery_result = DeliveryDispatcher(settings.base_dir).dispatch(
            delivery_ids=(delivery.id,),
            force=True,
        )

    telegram_token = settings.telegram_bot_token
    telegram_chat_id = settings.telegram_chat_id
    telegram_proxy_url = settings.telegram_proxy_url
    if branch:
        branch_settings = branch_telegram_settings(settings.base_dir, branch)
        telegram_token = branch_settings.bot_token
        telegram_chat_id = branch_settings.chat_id
        telegram_proxy_url = branch_settings.proxy_url

    if not telegram_token or not telegram_chat_id:
        target = (
            f"receiver telegram-branch-{branch}-silent"
            if branch
            else "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
        )
        raise RuntimeError(
            f"{target} are required unless --dry-run is used; "
            "the HTML report remains queued"
        )

    telegram = TelegramClient(
        telegram_token,
        telegram_chat_id,
        telegram_proxy_url,
    )
    LOGGER.info("telegram_message_send_start branch=%s", branch or "central")
    message_error: Exception | None = None
    try:
        telegram.send(message)
    except Exception as exc:
        message_error = exc
        LOGGER.error(
            "telegram_message_send_failed branch=%s error=%s: %s",
            branch or "central",
            type(exc).__name__,
            exc,
        )

    document_pending = bool(
        delivery_result
        and (delivery_result.get("failed") or delivery_result.get("skipped_locked"))
    )
    if message_error:
        raise RuntimeError(
            "daily HTML was queued for durable delivery, but Telegram summary "
            f"failed: {type(message_error).__name__}: {message_error}"
        ) from message_error
    LOGGER.info(
        "report_done run_id=%s telegram_message_sent=true document_pending=%s",
        run_id,
        document_pending,
    )
    return 0
