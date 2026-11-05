from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from pathlib import Path

RUN_MARKER = "===== monitoring-summary-run "


def _env_int(name: str, default: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError:
        return default
    return max(1, value)


def _run_count(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        return sum(
            1
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.startswith(RUN_MARKER)
        )
    except OSError:
        return 0


def rotate_by_runs(path: Path, runs_per_file: int, backups: int) -> None:
    if _run_count(path) < runs_per_file:
        return

    for index in range(backups - 1, 0, -1):
        current = path.with_name(f"{path.name}.{index}")
        next_path = path.with_name(f"{path.name}.{index + 1}")
        if current.exists():
            if index + 1 > backups:
                current.unlink()
            else:
                current.replace(next_path)

    if path.exists():
        path.replace(path.with_name(f"{path.name}.1"))


def run_rotation_settings() -> tuple[int, int]:
    return (
        _env_int("MONITORING_LOG_RUNS_PER_FILE", 5),
        _env_int("MONITORING_LOG_BACKUPS", 6),
    )


def configure_logging(
    base_dir: Path,
    branch: str | None,
    report_type: str = "daily",
) -> Path:
    level = os.environ.get("MONITORING_LOG_LEVEL", "INFO").upper()
    logs_dir = Path(os.environ.get("MONITORING_LOG_DIR", base_dir / "logs"))
    logs_dir.mkdir(parents=True, exist_ok=True)

    scope = branch or "central"
    if report_type == "weekly":
        log_path = logs_dir / "monitoring_weekly_report.run.log"
    elif report_type == "delivery":
        log_path = logs_dir / "monitoring_report_delivery.run.log"
    else:
        log_path = logs_dir / f"monitoring_daily_summary_{scope}.run.log"
    rotate_by_runs(log_path, *run_rotation_settings())

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)

    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(formatter)
    root.addHandler(console)

    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    logging.getLogger(__name__).info(
        "%s%s report_type=%s branch=%s pid=%s",
        RUN_MARKER,
        datetime.now().isoformat(timespec="seconds"),
        report_type,
        branch or "central",
        os.getpid(),
    )

    def log_unhandled_exception(
        exc_type: type[BaseException],
        exc: BaseException,
        traceback: object,
    ) -> None:
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc, traceback)
            return
        logging.getLogger(__name__).critical(
            "unhandled_exception",
            exc_info=(exc_type, exc, traceback),
        )
        sys.__excepthook__(exc_type, exc, traceback)

    sys.excepthook = log_unhandled_exception
    return log_path
