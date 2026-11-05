#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo


BASE_DIR = Path(os.environ.get("MONITORING_BASE_DIR", "/app")).resolve()
SCRIPT_PATH = BASE_DIR / "scripts" / "monitoring_daily_summary.py"
REPORTS_DIR = Path(
    os.environ.get("MONITORING_REPORTS_DIR", BASE_DIR / "data" / "reports")
)
DELIVERY_DB_PATH = Path(
    os.environ.get(
        "MONITORING_TELEGRAM_DELIVERY_DB_PATH",
        BASE_DIR / "data" / "telegram_delivery.sqlite3",
    )
)
HOST = os.environ.get("REPORT_API_HOST", "0.0.0.0")
PORT = int(os.environ.get("REPORT_API_PORT", "8080"))
TIMEOUT_SECONDS = int(os.environ.get("REPORT_API_TIMEOUT_SECONDS", "900"))
MAX_BODY_BYTES = 4096
MSK = ZoneInfo("Europe/Moscow")
TOKEN_RE = re.compile(r"bot\d+:[A-Za-z0-9_-]+", re.I)
AUTH_RE = re.compile(r"(?i)(authorization|bearer|password|cookie)(\s*[:=]\s*)[^\s,;]+")

run_lock = threading.Lock()


def current_msk_date() -> date:
    return datetime.now(MSK).date()


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def load_manifest() -> list[dict[str, Any]]:
    manifest_path = REPORTS_DIR / "reports.json"
    if not manifest_path.exists():
        return []
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, list) else []


def sanitized_error(value: str | None) -> str | None:
    if not value:
        return None
    redacted = TOKEN_RE.sub("bot<redacted>", value)
    redacted = AUTH_RE.sub(r"\1\2<redacted>", redacted)
    return redacted[:1000]


def _delivery_connection() -> sqlite3.Connection:
    uri = f"file:{DELIVERY_DB_PATH.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def load_delivery_history(limit: int = 50) -> list[dict[str, Any]]:
    if not DELIVERY_DB_PATH.exists():
        return []
    with _delivery_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, report_type, scope, period_key, receiver_name,
                   original_filename, status, attempt_count, next_attempt_at,
                   created_at, last_attempt_at, sent_at, last_error
              FROM telegram_deliveries
          ORDER BY created_at DESC, id DESC
             LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "report_type": row["report_type"],
            "scope": row["scope"],
            "period_key": row["period_key"],
            "receiver_name": row["receiver_name"],
            "filename": row["original_filename"],
            "status": row["status"],
            "attempt_count": row["attempt_count"],
            "next_attempt_at": row["next_attempt_at"],
            "created_at": row["created_at"],
            "last_attempt_at": row["last_attempt_at"],
            "sent_at": row["sent_at"],
            "last_error": sanitized_error(row["last_error"]),
        }
        for row in rows
    ]


def delivery_diagnostics() -> dict[str, Any]:
    manifest = load_manifest()
    daily = [entry for entry in manifest if entry.get("report_type", "daily") == "daily"]
    weekly = [entry for entry in manifest if entry.get("report_type") == "weekly"]
    database_exists = DELIVERY_DB_PATH.exists()
    pending_count = 0
    oldest_pending = None
    latest_sent = None
    database_error = None
    if database_exists:
        try:
            with _delivery_connection() as connection:
                row = connection.execute(
                    """
                    SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                           MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending,
                           MAX(sent_at) AS latest_sent
                      FROM telegram_deliveries
                    """
                ).fetchone()
                pending_count = int(row["pending_count"] or 0)
                oldest_pending = row["oldest_pending"]
                latest_sent = row["latest_sent"]
        except sqlite3.Error as exc:
            database_error = sanitized_error(f"{type(exc).__name__}: {exc}")
    return {
        "ok": database_error is None,
        "delivery_database": {
            "available": database_exists and database_error is None,
            "pending_count": pending_count,
            "oldest_pending": oldest_pending,
            "latest_sent": latest_sent,
            "error": database_error,
        },
        "reports": {
            "manifest_available": (REPORTS_DIR / "reports.json").exists(),
            "total": len(manifest),
            "daily_count": len(daily),
            "weekly_count": len(weekly),
            "latest_daily": daily[0] if daily else None,
            "latest_weekly": weekly[0] if weekly else None,
        },
    }


def pick_report(entries: list[dict[str, Any]], target_date: str | None) -> dict[str, Any] | None:
    candidates = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("file"), str)
        and isinstance(entry.get("date"), str)
        and isinstance(entry.get("run"), int)
    ]
    if target_date:
        candidates = [entry for entry in candidates if entry["date"] == target_date]
    if not candidates:
        return None
    candidates.sort(key=lambda entry: (entry["run"], entry["date"]), reverse=True)
    report = dict(candidates[0])
    report["url"] = f"/reports/{report['file']}"
    return report


def parse_payload(handler: BaseHTTPRequestHandler) -> tuple[str | None, str | None]:
    raw_length = handler.headers.get("Content-Length", "0")
    try:
        content_length = int(raw_length)
    except ValueError:
        return None, "Invalid Content-Length."
    if content_length > MAX_BODY_BYTES:
        return None, "Request body is too large."
    if content_length == 0:
        return None, None

    try:
        payload = json.loads(handler.rfile.read(content_length).decode("utf-8"))
    except json.JSONDecodeError:
        return None, "Request body must be valid JSON."
    if not isinstance(payload, dict):
        return None, "Request body must be a JSON object."

    target_date = payload.get("target_date")
    if target_date in (None, ""):
        return None, None
    if not isinstance(target_date, str):
        return None, "target_date must be a string in YYYY-MM-DD format."

    try:
        parsed_date = date.fromisoformat(target_date)
    except ValueError:
        return None, "target_date must be a valid YYYY-MM-DD date."
    if parsed_date > current_msk_date():
        return None, "target_date cannot be in the future."
    return parsed_date.isoformat(), None


def build_report_command(target_date: str | None) -> list[str]:
    command = [sys.executable, str(SCRIPT_PATH), "--dry-run"]
    if target_date:
        command.extend(["--target-date", target_date])
    return command


def run_report(target_date: str | None) -> tuple[int, dict[str, Any]]:
    command = build_report_command(target_date)
    before = load_manifest()
    try:
        completed = subprocess.run(
            command,
            cwd=BASE_DIR,
            capture_output=True,
            check=False,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return 504, {"ok": False, "error": "Report generation timed out."}

    after = load_manifest()
    report = pick_report(after, target_date) or pick_report(after, None)
    created = len(after) > len(before)
    payload: dict[str, Any] = {
        "ok": completed.returncode == 0,
        "created": created,
        "report": report,
        "telegram_sent": False,
    }

    if completed.returncode != 0:
        payload["error"] = "Report generation failed."
        payload["stderr"] = completed.stderr[-4000:]
        payload["stdout"] = completed.stdout[-4000:]
        return 500, payload

    return 200, payload


class Handler(BaseHTTPRequestHandler):
    server_version = "MonitoringReportAPI/1.0"

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/health":
            json_response(self, 200, {"ok": True})
            return
        if parsed.path == "/internal/reports/manifest" and not parsed.query:
            json_response(self, 200, load_manifest())
            return
        if parsed.path == "/internal/admin/deliveries":
            values = parse_qs(parsed.query).get("limit", ["50"])
            try:
                limit = int(values[0])
            except (TypeError, ValueError):
                json_response(self, 400, {"ok": False, "error": "limit must be an integer"})
                return
            if not 1 <= limit <= 100:
                json_response(self, 400, {"ok": False, "error": "limit must be between 1 and 100"})
                return
            try:
                json_response(self, 200, {"ok": True, "deliveries": load_delivery_history(limit)})
            except sqlite3.Error:
                json_response(self, 503, {"ok": False, "error": "delivery history unavailable"})
            return
        if parsed.path == "/internal/admin/diagnostics":
            payload = delivery_diagnostics()
            json_response(self, 200 if payload["ok"] else 503, payload)
            return
        json_response(self, 404, {"ok": False, "error": "Not found."})

    def do_POST(self) -> None:
        if self.path != "/api/reports/run":
            json_response(self, 404, {"ok": False, "error": "Not found."})
            return

        lock_acquired = False
        try:
            target_date, error = parse_payload(self)
            if error:
                json_response(self, 400, {"ok": False, "error": error})
                return

            if not run_lock.acquire(blocking=False):
                json_response(
                    self,
                    409,
                    {"ok": False, "error": "Report generation is already running."},
                )
                return

            lock_acquired = True
            status, payload = run_report(target_date)
            json_response(self, status, payload)
        except Exception as exc:
            json_response(
                self,
                500,
                {"ok": False, "error": f"Report runner failed: {exc}"},
            )
        finally:
            if lock_acquired:
                run_lock.release()

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", file=sys.stderr)


def main() -> int:
    if not SCRIPT_PATH.exists():
        raise RuntimeError(f"Report script not found: {SCRIPT_PATH}")
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Monitoring report API listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
