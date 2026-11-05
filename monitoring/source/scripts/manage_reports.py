#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from monitoring_summary.config import load_settings
    from monitoring_summary.html_report import REPORT_FILE_RE, write_reports_manifest
except ModuleNotFoundError:
    from scripts.monitoring_summary.config import load_settings
    from scripts.monitoring_summary.html_report import (
        REPORT_FILE_RE,
        write_reports_manifest,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="List and remove generated monitoring HTML reports."
    )
    parser.add_argument(
        "--base-dir",
        type=Path,
        help="Monitoring repository root. Defaults to the script repository.",
    )
    parser.add_argument(
        "--reports-dir",
        type=Path,
        help="Directory with infrastructure-YYYY-MM-DD-run-N.html reports.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List reports sorted by run number descending.",
    )
    parser.add_argument(
        "--delete-file",
        action="append",
        default=[],
        metavar="FILE",
        help="Delete an exact report filename. Can be used multiple times.",
    )
    parser.add_argument(
        "--delete-run",
        action="append",
        type=int,
        default=[],
        metavar="N",
        help="Delete reports with run number N. Can be used multiple times.",
    )
    parser.add_argument(
        "--delete-date",
        action="append",
        default=[],
        metavar="YYYY-MM-DD",
        help="Delete all reports for a date. Can be used multiple times.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without removing files.",
    )
    return parser


def report_files(reports_dir: Path) -> list[Path]:
    if not reports_dir.exists():
        return []
    return sorted(
        (
            path
            for path in reports_dir.iterdir()
            if path.is_file() and REPORT_FILE_RE.match(path.name)
        ),
        key=lambda path: (
            int(REPORT_FILE_RE.match(path.name).group("run")),
            REPORT_FILE_RE.match(path.name).group("date"),
        ),
        reverse=True,
    )


def select_reports(
    reports_dir: Path,
    files: list[str],
    runs: list[int],
    dates: list[str],
) -> list[Path]:
    selected: dict[str, Path] = {}
    wanted_files = set(files)
    wanted_runs = set(runs)
    wanted_dates = set(dates)

    for path in report_files(reports_dir):
        match = REPORT_FILE_RE.match(path.name)
        if not match:
            continue
        if path.name in wanted_files:
            selected[path.name] = path
            continue
        if int(match.group("run")) in wanted_runs:
            selected[path.name] = path
            continue
        if match.group("date") in wanted_dates:
            selected[path.name] = path

    missing = wanted_files - set(selected)
    if missing:
        raise FileNotFoundError(
            "Report file not found or has invalid name: " + ", ".join(sorted(missing))
        )

    return list(selected.values())


def print_reports(reports_dir: Path) -> None:
    for path in report_files(reports_dir):
        match = REPORT_FILE_RE.match(path.name)
        print(f"run #{match.group('run')} {match.group('date')} {path.name}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.base_dir)
    reports_dir = args.reports_dir or settings.reports_dir

    if args.list:
        print_reports(reports_dir)

    selected = select_reports(
        reports_dir,
        args.delete_file,
        args.delete_run,
        args.delete_date,
    )

    if selected:
        action = "Would delete" if args.dry_run else "Deleted"
        for path in selected:
            print(f"{action}: {path}")
            if not args.dry_run:
                path.unlink()

        if not args.dry_run:
            manifest_path = write_reports_manifest(reports_dir)
            print(f"Updated manifest: {manifest_path}")
    elif not args.list:
        print("No reports selected.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
