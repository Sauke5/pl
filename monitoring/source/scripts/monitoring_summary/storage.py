from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

from .models import MonitoringSnapshot
from .weekly import WeeklySnapshot


class IncidentStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def initialize(self, connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS report_runs (
                id INTEGER PRIMARY KEY,
                collected_at TEXT NOT NULL,
                window_start TEXT NOT NULL,
                window_end TEXT NOT NULL,
                collector_errors_json TEXT NOT NULL,
                snapshot_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS incidents (
                id INTEGER PRIMARY KEY,
                fingerprint TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                severity TEXT NOT NULL,
                subject TEXT NOT NULL,
                summary TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                occurrences INTEGER NOT NULL DEFAULT 1,
                last_details_json TEXT NOT NULL,
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS incident_observations (
                run_id INTEGER NOT NULL REFERENCES report_runs(id),
                incident_id INTEGER NOT NULL REFERENCES incidents(id),
                observed_at TEXT NOT NULL,
                PRIMARY KEY (run_id, incident_id)
            );

            CREATE INDEX IF NOT EXISTS incidents_status_category_idx
                ON incidents(status, category);
            CREATE INDEX IF NOT EXISTS incidents_subject_idx
                ON incidents(subject);
            """
        )

        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS weekly_reports (
                id INTEGER PRIMARY KEY,
                iso_year INTEGER NOT NULL,
                iso_week INTEGER NOT NULL,
                period_start TEXT NOT NULL,
                period_end TEXT NOT NULL,
                generated_at TEXT NOT NULL,
                timezone TEXT NOT NULL,
                run_number INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL CHECK (status IN ('generating', 'completed', 'failed')),
                filename TEXT NOT NULL,
                error TEXT,
                snapshot_json TEXT NOT NULL,
                UNIQUE (iso_year, iso_week)
            );
            CREATE INDEX IF NOT EXISTS weekly_reports_status_idx
                ON weekly_reports(status, period_end);
            """
        )

    def save_snapshot(self, snapshot: MonitoringSnapshot) -> int:
        timestamp = snapshot.collected_at.isoformat()
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            cursor = connection.execute(
                """
                INSERT INTO report_runs (
                    collected_at,
                    window_start,
                    window_end,
                    collector_errors_json,
                    snapshot_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    timestamp,
                    snapshot.window_start.isoformat(),
                    snapshot.window_end.isoformat(),
                    json.dumps(snapshot.collector_errors, ensure_ascii=False),
                    json.dumps(snapshot.to_dict(), ensure_ascii=False),
                ),
            )
            run_id = int(cursor.lastrowid)

            observed_by_category: dict[str, list[str]] = {}
            seen_fingerprints: set[str] = set()
            for finding in snapshot.findings:
                if finding.fingerprint in seen_fingerprints:
                    continue
                seen_fingerprints.add(finding.fingerprint)
                observed_by_category.setdefault(finding.category, []).append(
                    finding.fingerprint
                )
                connection.execute(
                    """
                    INSERT INTO incidents (
                        fingerprint,
                        category,
                        severity,
                        subject,
                        summary,
                        status,
                        first_seen,
                        last_seen,
                        occurrences,
                        last_details_json,
                        resolved_at
                    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, NULL)
                    ON CONFLICT(fingerprint) DO UPDATE SET
                        severity = excluded.severity,
                        subject = excluded.subject,
                        summary = excluded.summary,
                        status = 'open',
                        last_seen = excluded.last_seen,
                        occurrences = incidents.occurrences + 1,
                        last_details_json = excluded.last_details_json,
                        resolved_at = NULL
                    """,
                    (
                        finding.fingerprint,
                        finding.category,
                        finding.severity,
                        finding.subject,
                        finding.summary,
                        timestamp,
                        timestamp,
                        json.dumps(finding.details, ensure_ascii=False),
                    ),
                )
                incident_id = connection.execute(
                    "SELECT id FROM incidents WHERE fingerprint = ?",
                    (finding.fingerprint,),
                ).fetchone()["id"]
                connection.execute(
                    """
                    INSERT INTO incident_observations (
                        run_id, incident_id, observed_at
                    ) VALUES (?, ?, ?)
                    """,
                    (run_id, incident_id, timestamp),
                )

            for category in snapshot.successful_categories:
                active = observed_by_category.get(category, [])
                if active:
                    placeholders = ",".join("?" for _ in active)
                    connection.execute(
                        f"""
                        UPDATE incidents
                        SET status = 'resolved', resolved_at = ?
                        WHERE status = 'open'
                          AND category = ?
                          AND fingerprint NOT IN ({placeholders})
                        """,
                        (timestamp, category, *active),
                    )
                else:
                    connection.execute(
                        """
                        UPDATE incidents
                        SET status = 'resolved', resolved_at = ?
                        WHERE status = 'open' AND category = ?
                        """,
                        (timestamp, category),
                    )
            return run_id

    def open_incidents(self) -> list[dict]:
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            rows = connection.execute(
                """
                SELECT *
                FROM incidents
                WHERE status = 'open'
                ORDER BY
                    CASE severity
                        WHEN 'critical' THEN 0
                        WHEN 'warning' THEN 1
                        ELSE 2
                    END,
                    last_seen DESC
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def changes_for_run(self, run_id: int) -> dict[str, list[dict]]:
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            run = connection.execute(
                "SELECT collected_at FROM report_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
            if not run:
                return {"new": [], "repeated": [], "resolved": []}

            timestamp = run["collected_at"]
            observed = connection.execute(
                """
                SELECT incidents.*
                FROM incidents
                JOIN incident_observations
                  ON incident_observations.incident_id = incidents.id
                WHERE incident_observations.run_id = ?
                ORDER BY
                    CASE severity
                        WHEN 'critical' THEN 0
                        WHEN 'warning' THEN 1
                        ELSE 2
                    END,
                    subject
                """,
                (run_id,),
            ).fetchall()
            resolved = connection.execute(
                """
                SELECT *
                FROM incidents
                WHERE resolved_at = ?
                ORDER BY subject
                """,
                (timestamp,),
            ).fetchall()

            new = [dict(row) for row in observed if row["first_seen"] == timestamp]
            repeated = [
                dict(row)
                for row in observed
                if row["first_seen"] != timestamp and row["occurrences"] > 1
            ]
            return {
                "new": new,
                "repeated": repeated,
                "resolved": [dict(row) for row in resolved],
            }

    def update_run_snapshot(
        self,
        run_id: int,
        snapshot: MonitoringSnapshot,
    ) -> None:
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            connection.execute(
                "UPDATE report_runs SET snapshot_json = ? WHERE id = ?",
                (
                    json.dumps(snapshot.to_dict(), ensure_ascii=False),
                    run_id,
                ),
            )

    def start_weekly_report(
        self,
        snapshot: WeeklySnapshot,
        filename: str,
    ) -> int:
        """Reserve one stable run per ISO week; reruns replace run #1."""

        payload = json.dumps(snapshot.to_dict(), ensure_ascii=False)
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            connection.execute(
                """
                INSERT INTO weekly_reports (
                    iso_year, iso_week, period_start, period_end,
                    generated_at, timezone, run_number, status,
                    filename, error, snapshot_json
                ) VALUES (?, ?, ?, ?, ?, 'Europe/Moscow', 1, 'generating', ?, NULL, ?)
                ON CONFLICT(iso_year, iso_week) DO UPDATE SET
                    period_start = excluded.period_start,
                    period_end = excluded.period_end,
                    generated_at = excluded.generated_at,
                    timezone = excluded.timezone,
                    status = 'generating',
                    filename = excluded.filename,
                    error = NULL,
                    snapshot_json = excluded.snapshot_json
                """,
                (
                    snapshot.period.iso_year,
                    snapshot.period.iso_week,
                    snapshot.period.start.isoformat(),
                    snapshot.period.end.isoformat(),
                    snapshot.generated_at.isoformat(),
                    filename,
                    payload,
                ),
            )
            row = connection.execute(
                "SELECT run_number FROM weekly_reports WHERE iso_year = ? AND iso_week = ?",
                (snapshot.period.iso_year, snapshot.period.iso_week),
            ).fetchone()
            return int(row["run_number"])

    def finish_weekly_report(
        self,
        iso_year: int,
        iso_week: int,
        status: str,
        error: str | None = None,
    ) -> None:
        if status not in {"completed", "failed"}:
            raise ValueError("weekly report final status must be completed or failed")
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            connection.execute(
                """
                UPDATE weekly_reports
                SET status = ?, error = ?
                WHERE iso_year = ? AND iso_week = ?
                """,
                (status, error, iso_year, iso_week),
            )
