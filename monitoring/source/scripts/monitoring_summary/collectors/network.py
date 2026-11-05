from __future__ import annotations

from .base import *  # noqa: F403


class NetworkCollectorsMixin:
    def _network(
        self,
        start: datetime,
        end: datetime,
        target_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Собирает базовое состояние Huawei SNMP и network blackbox checks."""

        day_start, day_end = full_day_window(target_day)
        rows: dict[str, dict[str, Any]] = {}
        findings: list[Finding] = []

        def row_for(metric: dict[str, str]) -> dict[str, Any]:
            device = metric.get("device") or metric.get("instance", "unknown")
            row = rows.setdefault(
                device,
                {
                    "device": device,
                    "instance": metric.get("instance", ""),
                    "site": metric.get("site", ""),
                    "branch": metric.get("branch", ""),
                    "role": metric.get("role", ""),
                    "model": metric.get("model", ""),
                    "vendor": metric.get("vendor", ""),
                    "snmp_up": None,
                    "uptime_days": None,
                    "cpu_percent": None,
                    "memory_percent": None,
                    "temperature_celsius": None,
                    "checks": [],
                    "interfaces": [],
                    "interfaces_down": [],
                    "severity": "healthy",
                },
            )
            for key in ("site", "branch", "role", "model", "vendor"):
                if not row.get(key) and metric.get(key):
                    row[key] = metric[key]
            return row

        def mark(row: dict[str, Any], severity: str) -> None:
            if severity == "critical":
                row["severity"] = "critical"
            elif severity == "warning" and row["severity"] == "healthy":
                row["severity"] = "warning"

        snmp_selector = self._selector('job=~"huawei-snmp-(if|health)"')
        for item in self.prometheus.query("up{" + snmp_selector + "}"):
            metric = item["metric"]
            row = row_for(metric)
            up = float(item["value"][1]) == 1
            row["snmp_up"] = up if row["snmp_up"] is None else row["snmp_up"] and up
            if not up:
                mark(row, "critical")
                findings.append(
                    Finding(
                        "network_snmp_down",
                        f"{row['device']}:{metric.get('job', 'snmp')}",
                        "critical",
                        row["device"],
                        "SNMP exporter не получает данные",
                        {**row, "job": metric.get("job", "")},
                    )
                )

        for item in self.prometheus.query(
            "sysUpTime{" + self._selector('job="huawei-snmp-health"') + "}"
        ):
            row = row_for(item["metric"])
            row["uptime_days"] = float(item["value"][1]) / 8640000

        health_queries = (
            (
                "cpu_percent",
                "huaweiEntityCpuUsage{"
                + self._selector('job="huawei-snmp-health"')
                + "}",
                80.0,
                "CPU",
            ),
            (
                "memory_percent",
                "huaweiEntityMemoryUsage{"
                + self._selector('job="huawei-snmp-health"')
                + "}",
                85.0,
                "RAM",
            ),
            (
                "temperature_celsius",
                "huaweiEntityTemperatureCelsius{"
                + self._selector('job="huawei-snmp-health"')
                + "}",
                70.0,
                "Температура",
            ),
        )
        for field, query, threshold, label in health_queries:
            best_by_device: dict[str, tuple[dict[str, str], float]] = {}
            for item in self.prometheus.query(query):
                metric = item["metric"]
                device = metric.get("device") or metric.get("instance", "unknown")
                value = float(item["value"][1])
                current = best_by_device.get(device)
                if current is None or value > current[1]:
                    best_by_device[device] = (metric, value)
            for metric, value in best_by_device.values():
                row = row_for(metric)
                row[field] = value
                if value >= threshold:
                    mark(row, "warning")
                    findings.append(
                        Finding(
                            "network_health",
                            f"{row['device']}:{field}",
                            "warning",
                            row["device"],
                            f"{label} Huawei {value:.0f}",
                            {**row, "metric": field, "value": value},
                        )
                    )

        probe_query = (
            "probe_success{"
            + self._selector('job=~"blackbox-(icmp|tcp)-network"', 'vendor="huawei"')
            + "}"
        )
        current_probe = {
            (
                item["metric"].get("device") or item["metric"].get("instance", "unknown"),
                item["metric"].get("check_type", "probe"),
                item["metric"].get("instance", "unknown"),
            ): (item["metric"], float(item["value"][1]) == 1)
            for item in self.prometheus.query(probe_query)
        }
        probe_stats: dict[tuple[str, str, str], dict[str, Any]] = {}
        for series in self.prometheus.query_range(probe_query, day_start, day_end, "5m"):
            metric = series["metric"]
            key = (
                metric.get("device") or metric.get("instance", "unknown"),
                metric.get("check_type", "probe"),
                metric.get("instance", "unknown"),
            )
            values = values_from_range(series)
            if not values:
                continue
            probe_stats[key] = {
                "metric": metric,
                "success_percent": sum(values) / len(values) * 100,
            }

        for key, current_item in current_probe.items():
            metric, current_success = current_item
            row = row_for(metric)
            stat = probe_stats.get(key, {"success_percent": None})
            check = {
                "instance": key[2],
                "check_type": key[1],
                "current_success": current_success,
                "success_percent": stat["success_percent"],
            }
            row["checks"].append(check)
            severity = "healthy"
            if not current_success:
                severity = "critical"
            elif (
                stat["success_percent"] is not None
                and stat["success_percent"] < PROXY_SUCCESS_WARNING_PERCENT
            ):
                severity = "warning"
            if severity != "healthy":
                mark(row, severity)
                findings.append(
                    Finding(
                        "network_probe_down",
                        f"{row['device']}:{key[1]}:{key[2]}",
                        severity,
                        row["device"],
                        (
                            f"{key[1]} недоступен"
                            if severity == "critical"
                            else f"{key[1]} доступность {stat['success_percent']:.1f}%"
                        ),
                        {**row, "check": check},
                    )
                )

        interface_query = (
            "ifOperStatus{"
            + self._selector(
                'job="huawei-snmp-if"',
                'ifName=~"^(GigabitEthernet|XGigabitEthernet|Eth-Trunk|Tunnel).*"',
            )
            + "}"
        )
        for item in self.prometheus.query(interface_query):
            metric = item["metric"]
            row = row_for(metric)
            interface = metric.get("ifName", metric.get("ifDescr", "unknown"))
            status = float(item["value"][1])
            expected_interface = is_expected_huawei_interface(
                row["device"],
                row.get("model"),
                interface,
            )
            active_switch_interface = is_active_huawei_switch_interface(
                row.get("model"),
                interface,
                status,
            )
            if not expected_interface and not active_switch_interface:
                continue
            status_label = IF_OPER_STATUS.get(int(status), f"status {status:g}")
            interface_row = {
                "name": interface,
                "status": status,
                "status_label": status_label,
                "description": metric.get("ifDescr", ""),
            }
            row["interfaces"].append(interface_row)
            if expected_interface and status != 1:
                row["interfaces_down"].append(interface_row)
                mark(row, "warning")
                findings.append(
                    Finding(
                        "network_interface_down",
                        f"{row['device']}:{interface}",
                        "warning",
                        row["device"],
                        f"Интерфейс {interface}: {status_label}",
                        {**row, "interface": interface, "status": status},
                    )
                )

        result = list(rows.values())
        for row in result:
            row["checks"].sort(key=lambda item: (item["check_type"], item["instance"]))
            row["interfaces"].sort(key=lambda item: natural_name_key(item["name"]))
            row["interfaces_down"].sort(key=lambda item: natural_name_key(item["name"]))
        result.sort(
            key=lambda row: (
                {"critical": 0, "warning": 1, "healthy": 2}[row["severity"]],
                row["device"],
            )
        )
        return findings, result
