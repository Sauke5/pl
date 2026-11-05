from __future__ import annotations

from .base import *  # noqa: F403


class SqlWebCollectorsMixin:
    def _sql(
        self,
        start: datetime,
        end: datetime,
        days: list[date],
        target_day: date,
        previous_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Собирает SQL Server-метрики: log usage и page life expectancy."""

        allowed = set(days)
        excluded = {"master", "model", "msdb", "tempdb"}
        servers: dict[str, dict[str, Any]] = {}
        findings = []

        for series in self.prometheus.query_range(
            "windows_mssql_databases_log_used_percent{"
            + self._selector('job="windows"')
            + "}",
            start,
            end,
            "5m",
        ):
            metric = series["metric"]
            database = metric.get("database", metric.get("db", "unknown"))
            if database.lower() in excluded:
                continue
            instance = metric.get("instance", "unknown")
            grouped = daily_values(series, allowed)
            current_values = grouped.get(target_day, [])
            if not current_values:
                continue
            trend = reduced_trend(grouped, days, max)
            value = max(current_values)
            server = servers.setdefault(
                instance,
                {
                    "instance": instance,
                    "databases": [],
                    "max_log_percent": None,
                    "previous_log_percent": None,
                    "average_7d_log_percent": None,
                    "log_trend": [],
                    "minimum_ple_seconds": None,
                    "previous_ple_seconds": None,
                    "average_7d_ple_seconds": None,
                    "ple_trend": [],
                    "trend_dates": [day.isoformat() for day in days],
                    "severity": "healthy",
                    **metric_context(metric),
                },
            )
            server["databases"].append(
                {
                    "name": database,
                    "log_percent": value,
                    "previous_log_percent": (
                        max(grouped[previous_day])
                        if grouped.get(previous_day)
                        else None
                    ),
                    "average_7d_log_percent": average_present(trend),
                }
            )
            if server["max_log_percent"] is None or value > server["max_log_percent"]:
                server["max_log_percent"] = value
                server["previous_log_percent"] = (
                    max(grouped[previous_day])
                    if grouped.get(previous_day)
                    else None
                )
                server["average_7d_log_percent"] = average_present(trend)
                server["log_trend"] = trend
            if value >= SQL_LOG_CRITICAL_PERCENT:
                server["severity"] = "critical"
                findings.append(
                    Finding(
                        "sql",
                        f"{instance}:{database}:log",
                        "critical",
                        instance,
                        f"SQL log {database} заполнен на {value:.0f}%",
                        server["databases"][-1],
                    )
                )
            elif value >= SQL_LOG_WARNING_PERCENT:
                if server["severity"] == "healthy":
                    server["severity"] = "warning"
                findings.append(
                    Finding(
                        "sql",
                        f"{instance}:{database}:log",
                        "warning",
                        instance,
                        f"SQL log {database} заполнен на {value:.0f}%",
                        server["databases"][-1],
                    )
                )

        for series in self.prometheus.query_range(
            "windows_mssql_bufman_page_life_expectancy_seconds{"
            + self._selector('job="windows"')
            + "}",
            start,
            end,
            "5m",
        ):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            grouped = daily_values(series, allowed)
            current_values = grouped.get(target_day, [])
            if not current_values:
                continue
            trend = reduced_trend(grouped, days, min)
            value = min(current_values)
            server = servers.setdefault(
                instance,
                {
                    "instance": instance,
                    "databases": [],
                    "max_log_percent": None,
                    "previous_log_percent": None,
                    "average_7d_log_percent": None,
                    "log_trend": [],
                    "minimum_ple_seconds": None,
                    "previous_ple_seconds": None,
                    "average_7d_ple_seconds": None,
                    "ple_trend": [],
                    "trend_dates": [day.isoformat() for day in days],
                    "severity": "healthy",
                    **metric_context(metric),
                },
            )
            server["minimum_ple_seconds"] = value
            server["previous_ple_seconds"] = (
                min(grouped[previous_day]) if grouped.get(previous_day) else None
            )
            server["average_7d_ple_seconds"] = average_present(trend)
            server["ple_trend"] = trend
            if value < SQL_PLE_CRITICAL_SECONDS:
                server["severity"] = "critical"
                findings.append(
                    Finding(
                        "sql",
                        f"{instance}:ple",
                        "critical",
                        instance,
                        f"SQL Page Life Expectancy {value:.0f}s",
                        {"kind": "ple", "value": value},
                    )
                )
            elif value < SQL_PLE_WARNING_SECONDS:
                if server["severity"] == "healthy":
                    server["severity"] = "warning"
                findings.append(
                    Finding(
                        "sql",
                        f"{instance}:ple",
                        "warning",
                        instance,
                        f"SQL Page Life Expectancy {value:.0f}s",
                        {"kind": "ple", "value": value},
                    )
                )

        rows = list(servers.values())
        for row in rows:
            row["databases"].sort(key=lambda database: database["log_percent"], reverse=True)
        rows.sort(
            key=lambda row: (
                {"critical": 0, "warning": 1, "healthy": 2}[row["severity"]],
                row["instance"],
            )
        )
        return findings, rows

    def _websites(
        self,
        start: datetime,
        end: datetime,
        days: list[date],
        target_day: date,
        previous_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Собирает доступность, задержку и срок SSL для HTTP-проверок."""

        allowed = set(days)
        rows: dict[str, dict[str, Any]] = {}
        findings = []
        for series in self.prometheus.query_range(
            "probe_success{" + self._selector('job="blackbox-http"') + "}",
            start,
            end,
            "5m",
        ):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            grouped = daily_values(series, allowed)
            current_values = grouped.get(target_day, [])
            if not current_values:
                continue
            availability_trend = [
                (
                    sum(grouped[day]) / len(grouped[day]) * 100
                    if grouped.get(day)
                    else None
                )
                for day in days
            ]
            success_percent = sum(current_values) / len(current_values) * 100
            severity = "healthy"
            if success_percent < WEBSITE_SUCCESS_CRITICAL_PERCENT:
                severity = "critical"
            elif success_percent < WEBSITE_SUCCESS_WARNING_PERCENT:
                severity = "warning"
            row = {
                "instance": instance,
                "success_percent": success_percent,
                "failed_checks": sum(value == 0 for value in current_values),
                "previous_success_percent": (
                    sum(grouped[previous_day]) / len(grouped[previous_day]) * 100
                    if grouped.get(previous_day)
                    else None
                ),
                "average_7d_success_percent": average_present(availability_trend),
                "success_trend": availability_trend,
                "average_seconds": None,
                "peak_seconds": None,
                "previous_average_seconds": None,
                "average_7d_seconds": None,
                "latency_trend": [],
                "ssl_days_remaining": None,
                "trend_dates": [day.isoformat() for day in days],
                "severity": severity,
                **metric_context(metric),
            }
            rows[instance] = row
            if severity != "healthy":
                findings.append(
                    Finding(
                        "website_availability",
                        instance,
                        severity,
                        instance,
                        f"Успешность проверок {success_percent:.1f}%",
                        row,
                    )
                )

        for series in self.prometheus.query_range(
            "probe_duration_seconds{"
            + self._selector('job="blackbox-http"')
            + "}",
            start,
            end,
            "5m",
        ):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            grouped = daily_values(series, allowed)
            current_values = grouped.get(target_day, [])
            if not current_values:
                continue
            trend = reduced_trend(grouped, days, mean)
            row = rows.setdefault(
                instance,
                {
                    "instance": instance,
                    "success_percent": None,
                    "failed_checks": None,
                    "previous_success_percent": None,
                    "average_7d_success_percent": None,
                    "success_trend": [],
                    "ssl_days_remaining": None,
                    "trend_dates": [day.isoformat() for day in days],
                    "severity": "healthy",
                    **metric_context(metric),
                },
            )
            row["average_seconds"] = mean(current_values)
            row["peak_seconds"] = max(current_values)
            row["previous_average_seconds"] = (
                mean(grouped[previous_day]) if grouped.get(previous_day) else None
            )
            row["average_7d_seconds"] = average_present(trend)
            row["latency_trend"] = trend
            latency_severity = "healthy"
            if row["average_seconds"] >= WEBSITE_AVERAGE_LATENCY_CRITICAL_SECONDS:
                latency_severity = "critical"
            elif row["average_seconds"] >= WEBSITE_AVERAGE_LATENCY_WARNING_SECONDS:
                latency_severity = "warning"
            if latency_severity != "healthy":
                if row["severity"] == "healthy" or latency_severity == "critical":
                    row["severity"] = latency_severity
                findings.append(
                    Finding(
                        "website_latency",
                        f"{instance}:latency",
                        latency_severity,
                        instance,
                        f"Среднее время ответа {row['average_seconds']:.2f}s",
                        row,
                    )
                )

        for item in self.prometheus.query(
            "probe_ssl_earliest_cert_expiry{"
            + self._selector('job="blackbox-http"')
            + "}"
        ):
            instance = item["metric"].get("instance", "unknown")
            if instance in rows:
                rows[instance]["ssl_days_remaining"] = (
                    float(item["value"][1]) - datetime.now(MSK).timestamp()
                ) / 86400
                days_remaining = rows[instance]["ssl_days_remaining"]
                ssl_severity = "healthy"
                if days_remaining < WEBSITE_SSL_CRITICAL_DAYS:
                    ssl_severity = "critical"
                elif days_remaining < WEBSITE_SSL_WARNING_DAYS:
                    ssl_severity = "warning"
                if ssl_severity != "healthy":
                    if rows[instance]["severity"] == "healthy" or ssl_severity == "critical":
                        rows[instance]["severity"] = ssl_severity
                    findings.append(
                        Finding(
                            "website_ssl",
                            f"{instance}:ssl",
                            ssl_severity,
                            instance,
                            f"SSL истекает через {days_remaining:.0f} дней",
                            rows[instance],
                        )
                    )

        result = list(rows.values())
        result.sort(
            key=lambda row: (
                {"critical": 0, "warning": 1, "healthy": 2}[row["severity"]],
                row["instance"],
            )
        )
        return findings, result
