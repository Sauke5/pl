from __future__ import annotations

from ..formatter import format_memory_gib
from .base import *  # noqa: F403


class SystemCollectorsMixin:
    def _active_alerts(self) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Возвращает текущие firing alerts из Prometheus."""

        findings = []
        rows = []
        query = "ALERTS{" + self._selector('alertstate="firing"') + "}"
        for item in self.prometheus.query(query):
            metric = item["metric"]
            severity = metric.get("severity", "warning")
            alertname = metric.get("alertname", "unknown")
            instance = metric.get("instance", metric.get("job", "unknown"))
            findings.append(
                Finding(
                    "active_alert",
                    f"{alertname}:{instance}",
                    severity,
                    instance,
                    f"{alertname} на {instance}",
                    {"alertname": alertname, "labels": metric},
                )
            )
            rows.append(
                {
                    "instance": instance,
                    "alertname": alertname,
                    "severity": severity,
                    **metric_context(metric),
                }
            )
        return findings, rows

    def _availability(
        self, target_day: date
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Считает доступность Linux/Windows-хостов за полные сутки."""

        start, end = full_day_window(target_day)
        query = "up{" + self._selector('job=~"linux|windows"') + "}"
        current = {
            item["metric"].get("instance", "unknown"): float(item["value"][1])
            for item in self.prometheus.query(query)
        }
        rows = []
        findings = []
        for series in self.prometheus.query_range(query, start, end, "1m"):
            metric = series["metric"]
            instance = metric.get("instance", "unknown")
            values = daily_values(
                series,
                {target_day},
                working_hours=False,
            ).get(target_day, [])
            if not values:
                continue
            raw_intervals = downtime_intervals(series, target_day)
            intervals = reported_downtime_intervals(raw_intervals)
            failed = downtime_minutes(intervals)
            raw_failed = downtime_minutes(raw_intervals)
            availability = (len(values) - failed) / len(values) * 100
            is_up = current.get(instance, values[-1]) == 1
            severity = "healthy"
            if not is_up:
                severity = "critical"
            elif failed:
                severity = "warning"
            row = {
                "instance": instance,
                "os": "Windows" if metric.get("job") == "windows" else "Linux",
                "availability_percent": availability,
                "downtime_minutes": failed,
                "downtime_intervals": intervals,
                "raw_downtime_minutes": raw_failed,
                "ignored_short_downtime_intervals": len(raw_intervals) - len(intervals),
                "ignored_short_downtime_minutes": raw_failed - failed,
                "current_up": is_up,
                "severity": severity,
                **metric_context(metric),
            }
            rows.append(row)
            if not is_up:
                findings.append(
                    Finding(
                        "host_down",
                        instance,
                        "critical",
                        instance,
                        "Хост не отвечает",
                        row,
                    )
                )
            elif failed:
                findings.append(
                    Finding(
                        "availability_event",
                        f"{instance}:{target_day.isoformat()}",
                        "warning",
                        instance,
                        f"Недоступность за сутки: {failed} мин, {len(intervals)} интервал(ов)",
                        row,
                    )
                )
        rows.sort(key=lambda row: (row["severity"] == "healthy", row["availability_percent"]))
        return findings, rows

    def _reboots(
        self, target_day: date, collected_at: datetime
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Ищет перезагрузки Linux/Windows-хостов за выбранный день."""

        start, end = full_day_window(target_day)
        queries = (
            (
                "Linux",
                "node_boot_time_seconds{"
                + self._selector('job="linux"')
                + "}",
            ),
            (
                "Windows",
                "timestamp(windows_system_system_up_time{"
                + self._selector('job="windows"')
                + "}) - windows_system_system_up_time{"
                + self._selector('job="windows"')
                + "}",
            ),
        )
        rows = []
        findings = []
        for os_name, query in queries:
            for series in self.prometheus.query_range(query, start, end, "5m"):
                metric = series["metric"]
                instance = metric.get("instance", "unknown")
                boot_times = {
                    int(float(value))
                    for _, value in series.get("values", [])
                    if value not in ("NaN", "+Inf", "-Inf")
                }
                for boot_timestamp in sorted(boot_times):
                    boot_at = datetime.fromtimestamp(boot_timestamp, MSK)
                    if boot_at.date() != target_day:
                        continue
                    uptime = max(0.0, (collected_at - boot_at).total_seconds())
                    row = {
                        "instance": instance,
                        "os": os_name,
                        "boot_at": boot_at.isoformat(),
                        "uptime_seconds": uptime,
                        **metric_context(metric),
                    }
                    rows.append(row)
                    findings.append(
                        Finding(
                            "reboot",
                            f"{instance}:{boot_timestamp}",
                            "info",
                            instance,
                            f"Перезагрузка {boot_at:%d.%m %H:%M} МСК",
                            row,
                        )
                    )
        rows.sort(key=lambda row: row["boot_at"], reverse=True)
        return findings, rows

    def _cpu(
        self,
        start: datetime,
        end: datetime,
        days: list[date],
        target_day: date,
        previous_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Сравнивает CPU за рабочее время с предыдущим днем и недельным трендом."""

        queries = (
            (
                "Linux",
                "100 - (avg by(instance, role, location, branch) "
                "(rate(node_cpu_seconds_total{"
                + self._selector('job="linux"', 'mode="idle"')
                + "}[5m])) * 100)",
            ),
            (
                "Windows",
                "100 - (avg by(instance, role, location, branch) "
                "(rate(windows_cpu_time_total{"
                + self._selector('job="windows"', 'mode="idle"')
                + "}[5m])) * 100)",
            ),
        )
        rows = []
        findings = []
        allowed = set(days)
        for os_name, query in queries:
            for series in self.prometheus.query_range(query, start, end, "5m"):
                grouped = daily_values(series, allowed)
                trend = reduced_trend(grouped, days, mean)
                current_values = grouped.get(target_day, [])
                if not current_values:
                    continue
                average = mean(current_values)
                peak = max(current_values)
                severity = "warning" if average >= CPU_AVG_THRESHOLD else "healthy"
                metric = series["metric"]
                instance = metric.get("instance", "unknown")
                row = {
                    "instance": instance,
                    "os": os_name,
                    "average_percent": average,
                    "peak_percent": peak,
                    "previous_average_percent": (
                        mean(grouped[previous_day])
                        if grouped.get(previous_day)
                        else None
                    ),
                    "average_7d_percent": average_present(trend),
                    "trend": trend,
                    "trend_dates": [day.isoformat() for day in days],
                    "severity": severity,
                    **metric_context(metric),
                }
                rows.append(row)
                if severity != "healthy":
                    findings.append(
                        Finding(
                            "cpu",
                            instance,
                            "warning",
                            instance,
                            f"Средняя загрузка CPU {average:.0f}%",
                            row,
                        )
                    )
        rows.sort(key=lambda row: row["average_percent"], reverse=True)
        return findings, rows

    def _ram(
        self,
        start: datetime,
        end: datetime,
        days: list[date],
        target_day: date,
        previous_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Оценивает минимально доступную RAM с учетом роли и размера хоста."""

        platforms = (
            (
                "Linux",
                "node_memory_MemAvailable_bytes{"
                + self._selector('job="linux"')
                + "}",
                "node_memory_MemTotal_bytes{"
                + self._selector('job="linux"')
                + "}",
            ),
            (
                "Windows",
                "windows_memory_available_bytes{"
                + self._selector('job="windows"')
                + "}",
                "windows_cs_physical_memory_bytes{"
                + self._selector('job="windows"')
                + "}",
            ),
        )
        rows = []
        findings = []
        allowed = set(days)
        for os_name, available_query, total_query in platforms:
            totals = {
                item["metric"].get("instance"): float(item["value"][1])
                for item in self.prometheus.query(total_query)
            }
            # Seven business days may span eleven calendar days. Split ranges
            # to stay below Prometheus' 11,000 points per series at 1m.
            available_by_instance = {}
            cursor = start
            while cursor <= end:
                chunk_end = min(end, cursor + timedelta(days=7))
                for part in self.prometheus.query_range(available_query, cursor, chunk_end, "1m"):
                    key = part["metric"].get("instance", "unknown")
                    merged = available_by_instance.setdefault(key, {"metric": part["metric"], "values": []})
                    merged["values"].extend(part.get("values", []))
                cursor = chunk_end + timedelta(minutes=1)
            cache_by_instance = {}
            if os_name == "Windows":
                cache_query = "windows_memory_cache_bytes{" + self._selector('job="windows"') + "}"
                try:
                    for cache_series in self.prometheus.query_range(
                        cache_query,
                        datetime.combine(target_day, time(9), tzinfo=MSK),
                        datetime.combine(target_day, time(18), tzinfo=MSK),
                        "1m",
                    ):
                        cache_by_instance[cache_series["metric"].get("instance")] = {
                            float(ts): float(value) for ts, value in cache_series.get("values", [])
                            if value not in ("NaN", "+Inf", "-Inf")
                        }
                except Exception:
                    LOGGER.warning("Optional historical Windows cache query failed", exc_info=True)
            for series in available_by_instance.values():
                metric = series["metric"]
                instance = metric.get("instance", "unknown")
                if instance in self.ram_exclude_instances:
                    continue
                total = totals.get(instance)
                grouped = daily_values(series, allowed)
                current_values = grouped.get(target_day, [])
                if not total or not current_values:
                    continue
                trend_bytes = reduced_trend(grouped, days, min)
                trend_gb = [
                    gb(value) if value is not None else None
                    for value in trend_bytes
                ]
                minimum = min(current_values)
                minimum_gb = gb(minimum)
                minimum_percent = minimum / total * 100
                severity = ram_severity(
                    minimum_gb,
                    minimum_percent,
                    gb(total),
                    metric.get("role", ""),
                )
                minimum_severity = severity
                pressure = ram_pressure(series, target_day, total, metric.get("role", ""))
                if severity == "critical" and pressure["longest_critical_minutes"] < RAM_SUSTAINED_CRITICAL_MINUTES:
                    severity = "warning"
                minimum_at = next(
                    float(ts) for ts, value in series.get("values", [])
                    if value not in ("NaN", "+Inf", "-Inf")
                    and datetime.fromtimestamp(float(ts), MSK).date() == target_day
                    and time(9) <= datetime.fromtimestamp(float(ts), MSK).time() <= time(18)
                    and float(value) == minimum
                )
                cache_at_minimum = cache_by_instance.get(instance, {}).get(minimum_at)
                row = {
                    "instance": instance,
                    "os": os_name,
                    "total_gb": gb(total),
                    "minimum_severity": minimum_severity,
                    "median_gb": gb(median(current_values)),
                    "minimum_at": datetime.fromtimestamp(minimum_at, MSK).isoformat(),
                    "cache_at_minimum_gb": gb(cache_at_minimum) if cache_at_minimum is not None else None,
                    **pressure,
                    "minimum_gb": minimum_gb,
                    "minimum_percent": minimum_percent,
                    "previous_minimum_gb": (
                        gb(min(grouped[previous_day]))
                        if grouped.get(previous_day)
                        else None
                    ),
                    "average_7d_minimum_gb": average_present(trend_gb),
                    "trend": trend_gb,
                    "trend_dates": [day.isoformat() for day in days],
                    "severity": severity,
                    **metric_context(metric),
                }
                rows.append(row)
                if severity != "healthy":
                    findings.append(
                        Finding(
                            "ram",
                            instance,
                            severity,
                            instance,
                            f"Доступная RAM: минимум {format_memory_gib(minimum_gb)}, "
                            f"медиана {format_memory_gib(row['median_gb'])}; "
                            f"ниже порога роли ≈{pressure['low_minutes']:.0f} мин "
                            f"(макс. эпизод ≈{pressure['longest_low_minutes']:.0f} мин), 09–18 МСК"
                            + ("; краткая критическая просадка (<10 мин)" if severity == "warning"
                               and minimum_severity == "critical" else ""),
                            row,
                        )
                    )
        rows.sort(key=lambda row: row["minimum_percent"])
        return findings, rows

    def _disks(
        self,
        start: datetime,
        end: datetime,
        days: list[date],
        target_day: date,
        previous_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Собирает свободное место и задержки дисков Linux/Windows."""

        rows_by_key: dict[str, dict[str, Any]] = {}
        findings = []
        allowed = set(days)
        space_queries = (
            (
                "Windows",
                "volume",
                "windows_logical_disk_free_bytes{"
                + self._selector('job="windows"')
                + "} / windows_logical_disk_size_bytes{"
                + self._selector('job="windows"')
                + "} * 100",
                "windows_logical_disk_free_bytes{"
                + self._selector('job="windows"')
                + "}",
            ),
            (
                "Linux",
                "mountpoint",
                "node_filesystem_avail_bytes{"
                + self._selector('job="linux"', 'fstype!~"tmpfs|overlay|squashfs"')
                + "} / node_filesystem_size_bytes{"
                + self._selector('job="linux"', 'fstype!~"tmpfs|overlay|squashfs"')
                + "} * 100",
                "node_filesystem_avail_bytes{"
                + self._selector('job="linux"', 'fstype!~"tmpfs|overlay|squashfs"')
                + "}",
            ),
        )
        for os_name, device_label, ratio_query, free_query in space_queries:
            free_now = {
                (
                    item["metric"].get("instance", "unknown"),
                    item["metric"].get(device_label, "?"),
                ): gb(float(item["value"][1]))
                for item in self.prometheus.query(free_query)
            }
            for series in self.prometheus.query_range(
                ratio_query, start, end, "15m"
            ):
                metric = series["metric"]
                instance = metric.get("instance", "unknown")
                device = metric.get(device_label, "?")
                grouped = daily_values(series, allowed)
                current_values = grouped.get(target_day, [])
                if not current_values:
                    continue
                trend = reduced_trend(grouped, days, min)
                minimum_percent = min(current_values)
                severity = "healthy"
                if minimum_percent < DISK_FREE_CRITICAL_PERCENT:
                    severity = "critical"
                elif minimum_percent < DISK_FREE_WARNING_PERCENT:
                    severity = "warning"
                key = f"{instance}:{device}"
                row = {
                    "instance": instance,
                    "device": device,
                    "os": os_name,
                    "free_gb": free_now.get((instance, device)),
                    "minimum_free_percent": minimum_percent,
                    "previous_minimum_free_percent": (
                        min(grouped[previous_day])
                        if grouped.get(previous_day)
                        else None
                    ),
                    "average_7d_minimum_free_percent": average_present(trend),
                    "trend": trend,
                    "trend_dates": [day.isoformat() for day in days],
                    "read_peak_ms": None,
                    "write_peak_ms": None,
                    "read_average_ms": None,
                    "write_average_ms": None,
                    "severity": severity,
                    **metric_context(metric),
                }
                rows_by_key[key] = row
                if severity != "healthy":
                    findings.append(
                        Finding(
                            "disk_space",
                            key,
                            severity,
                            instance,
                            f"На диске {device} свободно {minimum_percent:.1f}%",
                            row,
                        )
                    )

        latency_queries = (
            (
                "read",
                "volume",
                "rate(windows_logical_disk_read_latency_seconds_total{"
                + self._selector('job="windows"')
                + "}[5m]) / rate(windows_logical_disk_reads_total{"
                + self._selector('job="windows"')
                + "}[5m]) * 1000",
            ),
            (
                "write",
                "volume",
                "rate(windows_logical_disk_write_latency_seconds_total{"
                + self._selector('job="windows"')
                + "}[5m]) / rate(windows_logical_disk_writes_total{"
                + self._selector('job="windows"')
                + "}[5m]) * 1000",
            ),
            (
                "read",
                "device",
                "rate(node_disk_read_time_seconds_total{"
                + self._selector('job="linux"')
                + "}[5m]) / rate(node_disk_reads_completed_total{"
                + self._selector('job="linux"')
                + "}[5m]) * 1000",
            ),
            (
                "write",
                "device",
                "rate(node_disk_write_time_seconds_total{"
                + self._selector('job="linux"')
                + "}[5m]) / rate(node_disk_writes_completed_total{"
                + self._selector('job="linux"')
                + "}[5m]) * 1000",
            ),
        )
        for direction, device_label, query in latency_queries:
            for series in self.prometheus.query_range(query, start, end, "5m"):
                metric = series["metric"]
                instance = metric.get("instance", "unknown")
                device = metric.get(device_label, "?")
                grouped = daily_values(series, allowed)
                current_values = [
                    value
                    for value in grouped.get(target_day, [])
                    if 0 <= value < 100000
                ]
                if not current_values:
                    continue
                peak = max(current_values)
                average = mean(current_values)
                key = f"{instance}:{device}"
                row = rows_by_key.setdefault(
                    key,
                    {
                        "instance": instance,
                        "device": device,
                        "os": (
                            "Windows"
                            if metric.get("job") == "windows"
                            else "Linux"
                        ),
                        "free_gb": None,
                        "minimum_free_percent": None,
                        "previous_minimum_free_percent": None,
                        "average_7d_minimum_free_percent": None,
                        "trend": [],
                        "trend_dates": [day.isoformat() for day in days],
                        "read_peak_ms": None,
                        "write_peak_ms": None,
                        "read_average_ms": None,
                        "write_average_ms": None,
                        "severity": "healthy",
                        **metric_context(metric),
                    },
                )
                row[f"{direction}_peak_ms"] = peak
                row[f"{direction}_average_ms"] = average
                if peak >= DISK_LATENCY_MS_THRESHOLD:
                    latency_severity = "critical" if peak >= 300 else "warning"
                    if row["severity"] == "healthy" or latency_severity == "critical":
                        row["severity"] = latency_severity
                    findings.append(
                        Finding(
                            "storage_latency",
                            f"{key}:{direction}",
                            latency_severity,
                            instance,
                            f"{device} {direction}: задержка до {peak:.0f} ms",
                            row,
                        )
                    )

        rows = list(rows_by_key.values())
        rows.sort(
            key=lambda row: (
                {"critical": 0, "warning": 1, "healthy": 2}[row["severity"]],
                row["instance"],
                row["device"],
            )
        )
        return findings, rows
