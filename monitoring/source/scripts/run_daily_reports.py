#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

from monitoring_summary.collector import CENTRAL_BRANCH_LABELS
from monitoring_summary.config import alertmanager_branch_receivers, load_settings
from monitoring_summary.logging_config import (
    RUN_MARKER,
    rotate_by_runs,
    run_rotation_settings,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run central and enabled branch monitoring reports."
    )
    parser.add_argument(
        "--base-dir",
        type=Path,
        help="Monitoring repository root. Defaults to the script repository.",
    )
    parser.add_argument(
        "--target-date",
        type=date.fromisoformat,
        help="Report date in YYYY-MM-DD format. Defaults to normal report logic.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate reports without Telegram delivery.",
    )
    return parser


def append_log(log_path: Path, command: list[str], cwd: Path) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    rotate_by_runs(log_path, *run_rotation_settings())
    started_at = datetime.now().isoformat(timespec="seconds")
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n{RUN_MARKER}{started_at} command={' '.join(command)} =====\n")
        log.flush()
        result = subprocess.run(
            command,
            cwd=cwd,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
        log.write(f"===== exit_code={result.returncode} =====\n")
        return result.returncode


def report_command(
    script_path: Path,
    target_date: date | None,
    dry_run: bool,
    branch: str | None = None,
) -> list[str]:
    command = [sys.executable, str(script_path)]
    if dry_run:
        command.append("--dry-run")
    if target_date:
        command.extend(["--target-date", target_date.isoformat()])
    if branch:
        command.extend(["--branch", branch])
        if not dry_run:
            command.append("--send-telegram")
    return command


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.base_dir)
    script_path = settings.base_dir / "scripts" / "monitoring_daily_summary.py"
    logs_dir = Path(os.environ.get("MONITORING_LOG_DIR", settings.base_dir / "logs"))
    config_path = settings.base_dir / "alertmanager/config/alertmanager.yml"
    branches = [
        branch
        for branch in alertmanager_branch_receivers(config_path)
        if branch not in CENTRAL_BRANCH_LABELS
    ]

    failures: list[str] = []
    central_code = append_log(
        logs_dir / "monitoring_daily_summary_central.log",
        report_command(script_path, args.target_date, args.dry_run),
        settings.base_dir,
    )
    if central_code:
        failures.append(f"central:{central_code}")

    for branch in branches:
        code = append_log(
            logs_dir / f"monitoring_daily_summary_{branch}.log",
            report_command(script_path, args.target_date, args.dry_run, branch),
            settings.base_dir,
        )
        if code:
            failures.append(f"{branch}:{code}")

    if failures:
        print("Daily report failures: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
