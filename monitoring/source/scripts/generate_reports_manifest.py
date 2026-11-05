#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from monitoring_summary.config import load_settings
from monitoring_summary.html_report import write_reports_manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate reports.json for published monitoring HTML reports."
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.base_dir)
    reports_dir = args.reports_dir or settings.reports_dir
    manifest_path = write_reports_manifest(reports_dir)
    print(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
