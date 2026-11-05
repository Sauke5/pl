from __future__ import annotations

from .base import *  # noqa: F403


class ProxyCollectorsMixin:
    def _proxy(
        self,
        start: datetime,
        end: datetime,
        target_day: date,
    ) -> tuple[list[Finding], list[dict[str, Any]]]:
        """Собирает состояние proxy-серверов, TCP endpoints, x-ui и трафик."""

        if self.branch:
            return [], []

        day_start, day_end = full_day_window(target_day)
        rows: dict[str, dict[str, Any]] = {}
        findings: list[Finding] = []

        def row_for(site: str) -> dict[str, Any]:
            return rows.setdefault(
                site,
                {
                    "site": site,
                    "instance": site,
                    "server_up": None,
                    "server_availability_percent": None,
                    "endpoints": [],
                    "cpu_average_percent": None,
                    "cpu_peak_percent": None,
                    "ram_peak_percent": None,
                    "root_free_percent": None,
                    "network_error_rate": None,
                    "xui_active": None,
                    "xui_client_traffic_up_bytes": None,
                    "xui_client_traffic_down_bytes": None,
                    "xui_client_traffic_total_bytes": None,
                    "xui_clients_enabled": None,
                    "xui_clients_total": None,
                    "xui_inbounds_enabled": None,
                    "xui_inbounds_total": None,
                    "severity": "healthy",
                },
            )

        def set_severity(row: dict[str, Any], severity: str) -> None:
            if row["severity"] == "healthy" or severity == "critical":
                row["severity"] = severity

        server_current = {
            item["metric"].get("site", ""): float(item["value"][1])
            for item in self.prometheus.query(
                f'up{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}'
            )
        }
        for site, value in server_current.items():
            row = row_for(site)
            row["server_up"] = value == 1
            if value != 1:
                set_severity(row, "critical")
                findings.append(
                    Finding(
                        "proxy_endpoint_down",
                        f"{site}:node_exporter",
                        "critical",
                        site,
                        "node_exporter proxy-сервера недоступен",
                        row,
                    )
                )

        for series in self.prometheus.query_range(
            f'up{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}',
            day_start,
            day_end,
            "1m",
        ):
            metric = series["metric"]
            site = metric.get("site", metric.get("instance", "unknown"))
            values = daily_values(series, {target_day}, working_hours=False).get(
                target_day, []
            )
            if values:
                row_for(site)["server_availability_percent"] = (
                    sum(values) / len(values) * 100
                )

        endpoint_current = {
            (
                item["metric"].get("site", ""),
                item["metric"].get("port", ""),
                item["metric"].get("role", ""),
                item["metric"].get("instance", ""),
            ): float(item["value"][1])
            for item in self.prometheus.query('probe_success{job="blackbox-tcp-proxy"}')
        }
        durations: dict[tuple[str, str, str, str], dict[str, float | None]] = {}
        for series in self.prometheus.query_range(
            'probe_duration_seconds{job="blackbox-tcp-proxy"}',
            day_start,
            day_end,
            "5m",
        ):
            metric = series["metric"]
            key = (
                metric.get("site", ""),
                metric.get("port", ""),
                metric.get("role", ""),
                metric.get("instance", ""),
            )
            values = values_from_range(series)
            durations[key] = {
                "average_seconds": mean(values) if values else None,
                "peak_seconds": max(values) if values else None,
            }

        for series in self.prometheus.query_range(
            'probe_success{job="blackbox-tcp-proxy"}',
            day_start,
            day_end,
            "1m",
        ):
            metric = series["metric"]
            site = metric.get("site", "unknown")
            port = metric.get("port", "?")
            role = metric.get("role", "?")
            instance = metric.get("instance", f"{site}:{port}")
            key = (site, port, role, instance)
            values = daily_values(series, {target_day}, working_hours=False).get(
                target_day, []
            )
            if not values:
                continue
            success_percent = sum(values) / len(values) * 100
            current_success = endpoint_current.get(key, values[-1]) == 1
            endpoint = {
                "instance": instance,
                "port": port,
                "role": role,
                "success_percent": success_percent,
                "failed_checks": sum(value == 0 for value in values),
                "current_success": current_success,
                **durations.get(key, {}),
            }
            row = row_for(site)
            row["endpoints"].append(endpoint)
            if not current_success:
                severity = "warning" if role == "panel" else "critical"
                set_severity(row, severity)
                findings.append(
                    Finding(
                        "proxy_panel_down" if role == "panel" else "proxy_endpoint_down",
                        f"{site}:{role}:{port}",
                        severity,
                        site,
                        f"TCP {port} недоступен",
                        endpoint,
                    )
                )
            elif success_percent < PROXY_SUCCESS_CRITICAL_PERCENT:
                set_severity(row, "critical")
                findings.append(
                    Finding(
                        "proxy_availability",
                        f"{site}:{role}:{port}:availability",
                        "critical",
                        site,
                        f"Доступность TCP {port}: {success_percent:.1f}%",
                        endpoint,
                    )
                )
            elif success_percent < PROXY_SUCCESS_WARNING_PERCENT:
                set_severity(row, "warning")
                findings.append(
                    Finding(
                        "proxy_availability",
                        f"{site}:{role}:{port}:availability",
                        "warning",
                        site,
                        f"Доступность TCP {port}: {success_percent:.1f}%",
                        endpoint,
                    )
                )
            if (
                current_success
                and endpoint.get("average_seconds") is not None
                and endpoint["average_seconds"] > PROXY_CONNECT_SLOW_SECONDS
            ):
                set_severity(row, "warning")
                findings.append(
                    Finding(
                        "proxy_latency",
                        f"{site}:{role}:{port}:latency",
                        "warning",
                        site,
                        f"TCP {port} connect {endpoint['average_seconds']:.2f}s",
                        endpoint,
                    )
                )

        range_queries = {
            "cpu": f'100 - (avg by(instance, site) (rate(node_cpu_seconds_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",mode="idle"}}[5m])) * 100)',
            "ram": f'(1 - node_memory_MemAvailable_bytes{{job="linux",site=~"{PROXY_SITE_MATCHER}"}} / node_memory_MemTotal_bytes{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}) * 100',
        }
        for kind, query in range_queries.items():
            for series in self.prometheus.query_range(query, start, end, "5m"):
                metric = series["metric"]
                values = values_from_range(series)
                if not values:
                    continue
                row = row_for(metric.get("site", metric.get("instance", "unknown")))
                if kind == "cpu":
                    row["cpu_average_percent"] = mean(values)
                    row["cpu_peak_percent"] = max(values)
                else:
                    row["ram_peak_percent"] = max(values)

        for item in self.prometheus.query(
            f'node_filesystem_avail_bytes{{job="linux",site=~"{PROXY_SITE_MATCHER}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs|devtmpfs"}} / node_filesystem_size_bytes{{job="linux",site=~"{PROXY_SITE_MATCHER}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs|devtmpfs"}} * 100'
        ):
            metric = item["metric"]
            row_for(metric.get("site", metric.get("instance", "unknown")))[
                "root_free_percent"
            ] = float(item["value"][1])

        network_rates: dict[str, dict[str, float]] = defaultdict(dict)
        network_queries = {
            "errors": f'sum by(instance, site) (rate(node_network_receive_errs_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",device!~"lo|docker.*|br-.*|veth.*"}}[5m]) + rate(node_network_transmit_errs_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",device!~"lo|docker.*|br-.*|veth.*"}}[5m]))',
            "drops": f'sum by(instance, site) (rate(node_network_receive_drop_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",device!~"lo|docker.*|br-.*|veth.*"}}[5m]) + rate(node_network_transmit_drop_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",device!~"lo|docker.*|br-.*|veth.*"}}[5m]))',
            "packets": f'sum by(instance, site) (rate(node_network_receive_packets_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",device!~"lo|docker.*|br-.*|veth.*"}}[5m]) + rate(node_network_transmit_packets_total{{job="linux",site=~"{PROXY_SITE_MATCHER}",device!~"lo|docker.*|br-.*|veth.*"}}[5m]))',
        }
        for rate_name, query in network_queries.items():
            for item in self.prometheus.query(query):
                metric = item["metric"]
                site = metric.get("site", metric.get("instance", "unknown"))
                network_rates[site][rate_name] = float(item["value"][1])

        for site, rates in network_rates.items():
            errors = rates.get("errors", 0.0)
            drops = rates.get("drops", 0.0)
            packets = max(rates.get("packets", 0.0), 1.0)
            drop_ratio = drops / packets
            row = row_for(site)
            row["network_error_rate"] = errors + drops
            if errors > 0 or (
                drops > PROXY_NETWORK_DROP_RATE_WARNING
                and drop_ratio > PROXY_NETWORK_DROP_RATIO_WARNING
            ):
                set_severity(row, "warning")
                findings.append(
                    Finding(
                        "proxy_network",
                        f"{row['site']}:network",
                        "warning",
                        row["site"],
                        "Есть interface errors или заметная доля packet drops",
                        row,
                    )
                )

        for item in self.prometheus.query(
            f'node_systemd_unit_state{{job="linux",site=~"{PROXY_SITE_MATCHER}",name="x-ui.service",state="active"}}'
        ):
            metric = item["metric"]
            value = float(item["value"][1])
            row = row_for(metric.get("site", metric.get("instance", "unknown")))
            row["xui_active"] = value == 1
            if value != 1:
                set_severity(row, "critical")
                findings.append(
                    Finding(
                        "proxy_systemd",
                        f"{row['site']}:x-ui",
                        "critical",
                        row["site"],
                        "x-ui.service не active",
                        row,
                    )
                )

        traffic_queries = {
            "xui_client_traffic_up_bytes": f'xui_client_traffic_up_bytes_total{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}',
            "xui_client_traffic_down_bytes": f'xui_client_traffic_down_bytes_total{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}',
        }
        for field, query in traffic_queries.items():
            for series in self.prometheus.query_range(query, day_start, day_end, "5m"):
                metric = series["metric"]
                values = values_from_range(series)
                row = row_for(metric.get("site", metric.get("instance", "unknown")))
                row[field] = counter_increase(values)
        for row in rows.values():
            if (
                row.get("xui_client_traffic_up_bytes") is not None
                or row.get("xui_client_traffic_down_bytes") is not None
            ):
                row["xui_client_traffic_total_bytes"] = (
                    row.get("xui_client_traffic_up_bytes") or 0
                ) + (row.get("xui_client_traffic_down_bytes") or 0)

        for item in self.prometheus.query(
            f'xui_clients{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}'
        ):
            metric = item["metric"]
            state = metric.get("state")
            row = row_for(metric.get("site", metric.get("instance", "unknown")))
            if state == "enabled":
                row["xui_clients_enabled"] = float(item["value"][1])
            elif state == "total":
                row["xui_clients_total"] = float(item["value"][1])

        for item in self.prometheus.query(
            f'xui_inbounds{{job="linux",site=~"{PROXY_SITE_MATCHER}"}}'
        ):
            metric = item["metric"]
            state = metric.get("state")
            row = row_for(metric.get("site", metric.get("instance", "unknown")))
            if state == "enabled":
                row["xui_inbounds_enabled"] = float(item["value"][1])
            elif state == "total":
                row["xui_inbounds_total"] = float(item["value"][1])

        result = list(rows.values())
        for row in result:
            row["endpoints"].sort(key=lambda item: (item["role"] != "proxy", item["port"]))
        result.sort(
            key=lambda row: (
                {"critical": 0, "warning": 1, "healthy": 2}[row["severity"]],
                row["site"],
            )
        )
        return findings, result
