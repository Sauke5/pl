from __future__ import annotations

import html
from collections.abc import Iterable

from .models import Finding, MonitoringSnapshot


SECTION_ORDER = (
    ("🚨", "Недоступность", {"host_down"}),
    (
        "🛰",
        "Proxy",
        {
            "proxy_availability",
            "proxy_endpoint_down",
            "proxy_panel_down",
            "proxy_latency",
            "proxy_systemd",
            "proxy_network",
        },
    ),
    ("🛢", "SQL Server", {"sql"}),
    ("⚙️", "CPU и RAM", {"cpu", "ram"}),
    ("💾", "Диски и I/O", {"disk_space", "storage_latency"}),
    ("🌍", "Веб-ресурсы", {"website_availability", "website_latency"}),
    (
        "🌐",
        "Сетевое оборудование",
        {
            "network_snmp_down",
            "network_probe_down",
            "network_health",
            "network_interface_down",
        },
    ),
)


def format_memory_gib(value: float | None) -> str:
    """Format legacy GiB-valued fields without rounding small values to zero."""
    if value is None:
        return "—"
    if value < 1:
        return f"{value * 1024:.0f} MiB"
    return f"{value:.1f} GiB"


def short_instance(instance: str) -> str:
    return instance.replace(":9182", "").replace(":9100", "")


def normalized_subject(instance: str) -> str:
    return short_instance(instance).lower()


def human_duration(seconds: float) -> str:
    total = int(seconds)
    days = total // 86400
    hours = (total % 86400) // 3600
    minutes = (total % 3600) // 60
    if days:
        return f"{days}д {hours}ч"
    if hours:
        return f"{hours}ч {minutes}м"
    return f"{minutes}м"


def icon(severity: str) -> str:
    return {"critical": "🔴", "warning": "🟠", "info": "🔵"}.get(
        severity, "•"
    )


def by_categories(
    findings: Iterable[Finding], categories: set[str]
) -> list[Finding]:
    return [item for item in findings if item.category in categories]


def telegram_findings(snapshot: MonitoringSnapshot) -> list[Finding]:
    specific = [
        finding
        for finding in snapshot.findings
        if finding.category != "active_alert"
    ]
    specific_subjects = {
        normalized_subject(finding.subject)
        for finding in specific
        if finding.severity in {"critical", "warning"}
    }
    generic_alerts = [
        finding
        for finding in snapshot.findings
        if finding.category == "active_alert"
        and normalized_subject(finding.subject) not in specific_subjects
    ]
    return specific + generic_alerts


def format_finding(finding: Finding) -> str:
    return (
        f"{icon(finding.severity)} "
        f"<code>{html.escape(short_instance(finding.subject))}</code>"
        f" — {html.escape(finding.summary)}"
    )


def format_summary(
    snapshot: MonitoringSnapshot,
    run_id: int | None = None,
    report_name: str | None = None,
) -> str:
    findings = telegram_findings(snapshot)
    critical = sum(item.severity == "critical" for item in findings)
    warnings = sum(item.severity == "warning" for item in findings)
    title = (
        f"📊 <b>Daily Branch Infrastructure Summary · {html.escape(snapshot.branch)}</b>"
        if snapshot.branch
        else "📊 <b>Daily Infrastructure Summary</b>"
    )
    lines = [
        title,
        (
            f"<code>{snapshot.window_start:%d.%m.%Y %H:%M}"
            f"–{snapshot.window_end:%H:%M} МСК</code>"
        ),
        "",
        (
            f"🔴 <b>Критические:</b> <code>{critical}</code>   "
            f"🟠 <b>Предупреждения:</b> <code>{warnings}</code>"
        ),
    ]
    if run_id is not None:
        lines.append(f"🗂 <b>Снимок:</b> <code>#{run_id}</code>")

    actionable = [
        item
        for item in findings
        if item.severity in {"critical", "warning"}
    ]
    if not actionable:
        lines.append("")
        if not snapshot.successful_categories:
            lines.append(
                "⚠️ <b>Состояние неизвестно:</b> источники данных недоступны"
            )
        else:
            lines.append("✅ <b>Проблем, требующих внимания, не обнаружено</b>")
    else:
        displayed: set[str] = set()
        for section_icon, title, categories in SECTION_ORDER:
            section = by_categories(actionable, categories)
            if not section:
                continue
            lines.extend(["", f"{section_icon} <b>{title}</b>"])
            for finding in section[:6]:
                lines.append(format_finding(finding))
                displayed.add(finding.fingerprint)

        other = [
            item
            for item in actionable
            if item.fingerprint not in displayed
        ]
        if other:
            lines.extend(["", "📌 <b>Прочие активные алерты</b>"])
            for finding in other[:6]:
                lines.append(format_finding(finding))

    reboots = by_categories(findings, {"reboot"})
    if reboots:
        lines.extend(["", "🔄 <b>Недавние перезагрузки</b>"])
        for finding in reboots[:6]:
            details = finding.details
            lines.append(
                f"• {html.escape(str(details['os']))} "
                f"<code>{html.escape(short_instance(finding.subject))}</code>"
                f" — uptime {human_duration(details['uptime_seconds'])}"
            )

    if snapshot.collector_errors:
        lines.extend(
            [
                "",
                f"⚠️ <b>Неполные данные:</b> "
                f"<code>{len(snapshot.collector_errors)}</code>"
                " коллектор(а)",
            ]
        )

    if report_name:
        lines.extend(
            ["", f"📎 Подробный отчёт: <code>{html.escape(report_name)}</code>"]
        )

    return "\n".join(lines)
