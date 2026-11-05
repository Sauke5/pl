from __future__ import annotations

import html
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean
from typing import Any

from .formatter import format_memory_gib, human_duration, short_instance, telegram_findings
from .models import Finding, MonitoringSnapshot

THEME_PATH = Path(__file__).with_name("report_theme.html")
REPORT_FILE_RE = re.compile(
    r"^infrastructure-(?P<date>\d{4}-\d{2}-\d{2})-run-(?P<run>\d+)\.html$"
)
WEEKLY_REPORT_FILE_RE = re.compile(
    r"^infrastructure-weekly-(?P<year>\d{4})-W(?P<week>\d{2})-run-(?P<run>\d+)\.html$"
)


def escape(value: Any) -> str:
    return html.escape(str(value))


def fmt(value: float | None, digits: int = 1, suffix: str = "") -> str:
    if value is None:
        return "—"
    rendered = f"{value:.{digits}f}".replace(".", ",")
    return f"{rendered}{suffix}"


def fmt_bytes(value: float | None) -> str:
    if value is None:
        return "—"
    units = ("B", "KB", "MB", "GB", "TB", "PB")
    size = float(value)
    unit = units[0]
    for unit in units:
        if abs(size) < 1024 or unit == units[-1]:
            break
        size /= 1024
    digits = 0 if unit == "B" else 1
    return fmt(size, digits, f" {unit}")


def fmt_datetime(value: str) -> str:
    return datetime.fromisoformat(value).strftime("%H:%M:%S")


def fmt_interval(interval: dict[str, Any]) -> str:
    return (
        f"{fmt_datetime(interval['start'])} - {fmt_datetime(interval['end'])}; "
        f"{interval['duration_minutes']} мин"
    )


def severity_label(severity: str) -> str:
    return {
        "critical": "Критично",
        "warning": "Внимание",
        "healthy": "Норма",
        "info": "Информация",
    }.get(severity, severity)


def theme_parts() -> tuple[str, str, str]:
    """Достает CSS и JS из report_theme.html без изменения старого источника темы."""

    source = THEME_PATH.read_text(encoding="utf-8")
    scripts = re.findall(r"<script>(.*?)</script>", source, re.S)
    style_match = re.search(r"<style>(.*?)</style>", source, re.S)
    if len(scripts) < 2 or not style_match:
        raise RuntimeError("report_theme.html has an invalid structure")
    return scripts[0], style_match.group(1), scripts[-1]


def status_badge(severity: str, text: str | None = None) -> str:
    return (
        f'<span class="status {escape(severity)}">'
        f"{escape(text or severity_label(severity))}</span>"
    )


def metric_cell(label: str, value: str, tone: str = "") -> str:
    tone_class = f" {tone}" if tone else ""
    return (
        '<span class="row-metric">'
        f'<span class="metric-label">{escape(label)}</span>'
        f'<span class="metric-value{tone_class}">{escape(value)}</span>'
        "</span>"
    )


def sparkline(
    values: list[float | None],
    warning: float | None = None,
    critical: float | None = None,
    lower_is_worse: bool = False,
    memory_units: bool = False,
) -> str:
    present = [value for value in values if value is not None]
    if not present:
        return "<p>Нет данных для тренда</p>"
    low = min(present)
    high = max(present)
    span = high - low or max(abs(high), 1)
    bars = []
    for value in values:
        if value is None:
            bars.append(
                '<span class="trend-bar empty" style="--value:8%" title="Нет данных">'
                "<i>—</i></span>"
            )
            continue
        height = 22 + ((value - low) / span * 78)
        css_class = ""
        if critical is not None and (
            value <= critical if lower_is_worse else value >= critical
        ):
            css_class = "critical"
        elif warning is not None and (
            value <= warning if lower_is_worse else value >= warning
        ):
            css_class = "warning"
        title = format_memory_gib(value) if memory_units else fmt(value, 1)
        bars.append(
            f'<span class="trend-bar {css_class}" style="--value:{height:.0f}%" '
            f'title="{title}"><i>{title}</i></span>'
        )
    return '<div class="sparkline">' + "".join(bars) + "</div>"


def trend_block(
    title: str,
    values: list[float | None],
    dates: list[str],
    warning: float | None = None,
    critical: float | None = None,
    lower_is_worse: bool = False,
    suffix: str = "",
) -> str:
    labels = []
    for index, date_text in enumerate(dates):
        day_label = datetime.fromisoformat(date_text).strftime("%d.%m")
        value = values[index] if index < len(values) else None
        value_label = (format_memory_gib(value) if suffix == " GiB" else fmt(value, 1, suffix)) if value is not None else "нет данных"
        labels.append(
            f'<span title="{escape(day_label + ": " + value_label)}">'
            f"{escape(day_label)}</span>"
        )
    return detail_block(
        title,
        [],
        sparkline(values, warning, critical, lower_is_worse, memory_units=suffix == " GiB")
        + f'<div class="trend-labels">{"".join(labels)}</div>',
    )


def tone_threshold(
    value: float | None,
    warning: float,
    critical: float,
    lower_is_worse: bool = False,
) -> str:
    if value is None:
        return ""
    if lower_is_worse:
        if value <= critical:
            return "bad"
        if value <= warning:
            return "warn"
        return ""
    if value >= critical:
        return "bad"
    if value >= warning:
        return "warn"
    return ""


def status_for_available_row(row: dict[str, Any]) -> tuple[str, str]:
    if not row["current_up"]:
        return "critical", "Недоступен сейчас"
    if row.get("downtime_minutes", 0):
        return "warning", "Были перерывы"
    return "healthy", "Доступен сейчас"


def ssl_tone(days_remaining: float | None) -> str:
    return tone_threshold(days_remaining, 30, 14, lower_is_worse=True)


def website_severity_label(row: dict[str, Any]) -> str:
    if row["severity"] == "critical":
        return "Критично"
    if row.get("success_percent") is not None and row["success_percent"] < 95:
        return "Доступность"
    if row.get("average_seconds") is not None and row["average_seconds"] >= 4:
        return "Медленно"
    if row.get("ssl_days_remaining") is not None and row["ssl_days_remaining"] < 30:
        return "SSL"
    return "Внимание"


def has_mass_availability_pattern(rows: list[dict[str, Any]], minimum_hosts: int = 5) -> bool:
    """Определяет массовые совпадающие интервалы недоступности."""

    affected_by_minute: dict[datetime, set[str]] = {}
    for row in rows:
        for interval in row.get("downtime_intervals", []):
            start = datetime.fromisoformat(interval["start"]).replace(second=0, microsecond=0)
            end = datetime.fromisoformat(interval["end"]).replace(second=0, microsecond=0)
            moment = start
            while moment < end:
                affected_by_minute.setdefault(moment, set()).add(row["instance"])
                moment += timedelta(minutes=1)
    return any(len(instances) >= minimum_hosts for instances in affected_by_minute.values())


def detail_block(title: str, lines: list[str], chart: str | None = None) -> str:
    body = "".join(f"<p>{line}</p>" for line in lines)
    return (
        '<div class="detail-block">'
        f"<h4>{escape(title)}</h4>{body}{chart or ''}</div>"
    )


def server_card(
    name: str,
    subtitle: str,
    severity: str,
    metrics: list[tuple[str, str, str]],
    blocks: list[str],
    badge: str | None = None,
    badge_severity: str | None = None,
    open_by_default: bool = False,
) -> str:
    open_attr = " open" if open_by_default else ""
    metrics_html = "".join(
        metric_cell(label, value, tone) for label, value, tone in metrics[:3]
    )
    return (
        f'<details class="server" data-health="{escape(severity)}"{open_attr}>'
        "<summary>"
        '<span class="chevron">›</span>'
        '<span class="server-name">'
        f"<strong>{escape(short_instance(name))}</strong>"
        f"<small>{escape(subtitle)}</small></span>"
        f"{metrics_html}"
        f"{status_badge(badge_severity or severity, badge)}"
        "</summary>"
        '<div class="server-details">'
        + "".join(blocks)
        + "</div></details>"
    )


def table(headers: list[str], rows: list[list[str]]) -> str:
    """Рендерит таблицу из HTML-фрагментов, подготовленных вызывающим кодом."""

    head = "".join(f"<th>{escape(header)}</th>" for header in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>"
        for row in rows
    )
    return (
        '<div class="compact-table-wrap"><table>'
        f"<thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>"
    )


def healthy_group(label: str, headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return ""
    return (
        '<details class="healthy-summary">'
        f"<summary>{escape(label)}</summary>"
        f"{table(headers, rows)}</details>"
    )


def section(
    title: str,
    subtitle: str,
    badges: list[str],
    content: str,
    open_by_default: bool = False,
) -> str:
    open_attr = " open" if open_by_default else ""
    return (
        f'<details class="report-section"{open_attr}>'
        "<summary>"
        '<span class="chevron">›</span>'
        '<span class="section-title">'
        f"<strong>{escape(title)}</strong><span>{escape(subtitle)}</span></span>"
        f'<span class="section-counts">{"".join(badges)}</span>'
        "</summary>"
        f'<div class="section-body">{content}</div>'
        "</details>"
    )


def render_priority(snapshot: MonitoringSnapshot) -> str:
    findings = [
        finding
        for finding in telegram_findings(snapshot)
        if finding.severity in {"critical", "warning"}
    ][:5]
    if not findings:
        return (
            '<section class="priority"><h2>Главное за день</h2>'
            '<p class="empty-state">Проблем, требующих внимания, не обнаружено</p>'
            "</section>"
        )
    items = []
    for finding in findings:
        details = finding.details
        context = ""
        if finding.category == "cpu":
            context = (
                f"Предыдущий день: "
                f"{fmt(details.get('previous_average_percent'), 0, '%')} · "
                f"среднее 7 дней: "
                f"{fmt(details.get('average_7d_percent'), 0, '%')}"
            )
        elif finding.category == "ram":
            context = (
                f"Предыдущий день: "
                f"{format_memory_gib(details.get('previous_minimum_gb'))} · "
                f"среднее 7 дней: "
                f"{format_memory_gib(details.get('average_7d_minimum_gb'))}"
            )
        elif finding.category in {"disk_space", "storage_latency"}:
            context = f"Категория: диски и I/O"
        elif finding.category == "sql":
            context = "Категория: SQL Server"
        elif finding.category.startswith("website"):
            context = "Категория: веб-ресурсы"
        elif finding.category in {"host_down", "availability_event"}:
            context = "Доступность за полные сутки"
        items.append(
            f'<article class="priority-item is-{escape(finding.severity)}">'
            f"{status_badge(finding.severity)}"
            "<div>"
            f"<strong>{escape(short_instance(finding.subject))}: "
            f"{escape(finding.summary)}</strong>"
            f"<span>{escape(context)}</span></div>"
            "</article>"
        )
    return (
        '<section class="priority"><h2>Главное за день</h2>'
        f'<div class="priority-list">{"".join(items)}</div></section>'
    )


def render_availability(rows: list[dict[str, Any]]) -> str:
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    cards = []
    for row in problem:
        severity = row["severity"]
        badge_severity, badge_text = status_for_available_row(row)
        intervals = row.get("downtime_intervals", [])
        interval_lines = (
            [fmt_interval(interval) for interval in intervals[:8]]
            if intervals
            else ["Интервалы недоступности не найдены"]
        )
        if len(intervals) > 8:
            interval_lines.append(f"Еще {len(intervals) - 8} интервал(ов)")
        cards.append(
            server_card(
                row["instance"],
                " · ".join(
                    part
                    for part in [row.get("os"), row.get("role"), row.get("location")]
                    if part
                ),
                severity,
                [
                    (
                        "Доступность",
                        fmt(row["availability_percent"], 2, "%"),
                        "bad" if severity == "critical" else "warn",
                    ),
                    (
                        "Простой",
                        f"{row['downtime_minutes']} мин",
                        "bad" if severity == "critical" else "warn",
                    ),
                    (
                        "Сейчас",
                        "Доступен" if row["current_up"] else "Недоступен",
                        "" if row["current_up"] else "bad",
                    ),
                ],
                [
                    detail_block(
                        "Состояние",
                        [
                            f"<strong>{badge_text}</strong>",
                            f"Доступность: {fmt(row['availability_percent'], 2, '%')}",
                        ],
                    ),
                    detail_block(
                        "Интервалы недоступности",
                        interval_lines,
                    ),
                    detail_block(
                        "Контекст",
                        [
                            f"Роль: {escape(row.get('role') or 'не указана')}",
                            f"Локация: {escape(row.get('location') or 'не указана')}",
                        ],
                    ),
                ],
                badge_text,
                badge_severity,
            )
        )
    healthy_rows = [
        [
            f"<code>{escape(short_instance(row['instance']))}</code>",
            escape(row.get("role") or "—"),
            escape(row.get("location") or "—"),
            fmt(row["availability_percent"], 2, "%"),
            "Доступен" if row["current_up"] else "Недоступен",
        ]
        for row in healthy
    ]
    content = '<div class="server-list">' + "".join(cards) + "</div>"
    if has_mass_availability_pattern(problem):
        content = (
            '<div class="notice info">'
            "<strong>Похоже на массовую недоступность с точки зрения мониторинга.</strong>"
            "<span>Если интервалы у многих объектов совпадают, вероятная причина может быть в VPN-канале между мониторингом и серверной. Инфраструктуру всё равно стоит проверять, но отчёт теперь отделяет этот сценарий от одиночных отказов серверов.</span>"
            "</div>"
            + content
        )
    content += healthy_group(
        f"Показать {len(healthy)} объектов без недоступности",
        ["Объект", "Роль", "Локация", "Доступность", "Сейчас"],
        healthy_rows,
    )
    badges = []
    if problem:
        badges.append(status_badge("warning", f"{len(problem)} события"))
    badges.append(status_badge("healthy", f"{len(healthy)} доступны"))
    return section(
        "Доступность инфраструктуры",
        "Полные сутки, 00:00–23:59 МСК",
        badges,
        content,
    )


def render_sql(rows: list[dict[str, Any]]) -> str:
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    cards = []
    for index, row in enumerate(problem):
        databases = row.get("databases", [])
        database_rows = [
            [
                f"<strong>{escape(database['name'])}</strong>",
                fmt(database.get("log_percent"), 0, "%"),
            ]
            for database in databases[:6]
        ]
        database_note = ""
        if len(databases) > 6:
            database_note = (
                f'<p class="muted-note">Еще {len(databases) - 6} баз '
                "с меньшим использованием log.</p>"
            )
        database_usage = (
            table(["База", "Log"], database_rows) + database_note
            if database_rows
            else "<p>Данные по пользовательским базам отсутствуют</p>"
        )
        cards.append(
            server_card(
                row["instance"],
                "SQL Server",
                row["severity"],
                [
                    (
                        "Transaction log",
                        fmt(row.get("max_log_percent"), 0, "%"),
                        "bad"
                        if (row.get("max_log_percent") or 0) >= 90
                        else "warn",
                    ),
                    (
                        "Минимальный PLE",
                        fmt(row.get("minimum_ple_seconds"), 0, " сек"),
                        "bad"
                        if (
                            row.get("minimum_ple_seconds") is not None
                            and row["minimum_ple_seconds"] < 300
                        )
                        else "warn",
                    ),
                    (
                        "7 дней log",
                        fmt(row.get("average_7d_log_percent"), 0, "%"),
                        "",
                    ),
                ],
                [
                    detail_block(
                        "Transaction log",
                        [
                            f"Отчетный день: <strong>{fmt(row.get('max_log_percent'), 0, '%')}</strong>",
                            f"Предыдущий рабочий день: {fmt(row.get('previous_log_percent'), 0, '%')}",
                            f"Среднее 7 дней: {fmt(row.get('average_7d_log_percent'), 0, '%')}",
                        ],
                    ),
                    detail_block(
                        "Page Life Expectancy",
                        [
                            f"Минимум: <strong>{fmt(row.get('minimum_ple_seconds'), 0, ' сек')}</strong>",
                            f"Предыдущий рабочий день: {fmt(row.get('previous_ple_seconds'), 0, ' сек')}",
                            f"Среднее 7 дней: {fmt(row.get('average_7d_ple_seconds'), 0, ' сек')}",
                        ],
                    ),
                    trend_block(
                        "Динамика transaction log",
                        row.get("log_trend", []),
                        row.get("trend_dates", []),
                        warning=70,
                        critical=90,
                        suffix="%",
                    ),
                    detail_block(
                        "Использование transaction log по базам",
                        [],
                        database_usage,
                    ),
                ],
            )
        )
    healthy_rows = [
        [
            f"<code>{escape(short_instance(row['instance']))}</code>",
            fmt(row.get("max_log_percent"), 0, "%"),
            fmt(row.get("minimum_ple_seconds"), 0, " сек"),
            fmt(row.get("previous_log_percent"), 0, "%"),
            fmt(row.get("average_7d_log_percent"), 0, "%"),
        ]
        for row in healthy
    ]
    content = '<div class="server-list">' + "".join(cards) + "</div>"
    content += healthy_group(
        f"Показать {len(healthy)} SQL-серверов без отклонений",
        ["Сервер", "Макс. log", "Мин. PLE", "Пред. день", "7 дней"],
        healthy_rows,
    )
    badges = []
    critical = sum(row["severity"] == "critical" for row in problem)
    warnings = sum(row["severity"] == "warning" for row in problem)
    if critical:
        badges.append(status_badge("critical", f"{critical} критично"))
    if warnings:
        badges.append(status_badge("warning", f"{warnings} внимание"))
    if healthy:
        badges.append(status_badge("healthy", f"{len(healthy)} норма"))
    return section(
        "SQL Server",
        "Состояние баз и памяти за рабочее время, 09:00–18:00 МСК",
        badges,
        content or '<p class="empty-state">SQL-метрики отсутствуют</p>',
    )


def render_resource_section(
    title: str,
    subtitle: str,
    rows: list[dict[str, Any]],
    kind: str,
) -> str:
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    cards = []
    for row in problem:
        if kind == "cpu":
            metrics = [
                ("Среднее", fmt(row["average_percent"], 0, "%"), "warn"),
                ("Пик", fmt(row["peak_percent"], 0, "%"), "bad" if row["peak_percent"] >= 90 else ""),
                ("7 дней", fmt(row["average_7d_percent"], 0, "%"), ""),
            ]
            blocks = [
                detail_block(
                    "Сравнение",
                    [
                        f"Отчетный день: <strong>{fmt(row['average_percent'], 0, '%')}</strong>",
                        f"Предыдущий рабочий день: {fmt(row.get('previous_average_percent'), 0, '%')}",
                        f"Среднее 7 дней: {fmt(row.get('average_7d_percent'), 0, '%')}",
                    ],
                ),
                detail_block("Пики", [f"Максимум: {fmt(row['peak_percent'], 0, '%')}"]),
                trend_block(
                    "Динамика среднего CPU",
                    row.get("trend", []),
                    row.get("trend_dates", []),
                    warning=60,
                    critical=90,
                    suffix="%",
                ),
                detail_block(
                    "Контекст",
                    [
                        f"ОС: {escape(row.get('os') or '—')}",
                        f"Роль: {escape(row.get('role') or '—')}",
                    ],
                ),
            ]
        else:
            metrics = [
                ("Минимум", format_memory_gib(row["minimum_gb"]), "warn"),
                ("Доля", fmt(row["minimum_percent"], 1, "%"), "warn"),
                ("Медиана", format_memory_gib(row.get("median_gb")), ""),
            ]
            blocks = [
                detail_block(
                    "Минимум за день",
                    [
                        f"<strong>{format_memory_gib(row['minimum_gb'])}</strong> "
                        f"из {format_memory_gib(row['total_gb'])}",
                        f"Медиана: {format_memory_gib(row.get('median_gb'))}",
                        "Минимум в " + escape(row.get("minimum_at") or "—"),
                    ],
                ),
                detail_block(
                    "Сравнение",
                    [
                        f"Предыдущий рабочий день: {format_memory_gib(row.get('previous_minimum_gb'))}",
                        f"Среднее 7 дней: {format_memory_gib(row.get('average_7d_minimum_gb'))}",
                    ],
                ),
                detail_block(
                    "Длительность низкой памяти, 09–18 МСК",
                    [
                        f"Ниже порога роли: ≈{fmt(row.get('low_minutes'), 0)} мин суммарно; самый длинный эпизод ≈{fmt(row.get('longest_low_minutes'), 0)} мин",
                        f"Критический порог: ≈{fmt(row.get('critical_minutes'), 0)} мин; самый длинный эпизод ≈{fmt(row.get('longest_critical_minutes'), 0)} мин",
                        "Оценка по точкам с шагом 1 мин. Красный статус: критический эпизод от 10 мин; короткие просадки — предупреждение.",
                    ] if row.get("sample_step_seconds") else ["Длительность не сохранена в этом отчёте"],
                ),
                *([detail_block("Windows cache в момент минимума", [
                    format_memory_gib(row['cache_at_minimum_gb']),
                    "Системный файловый кэш; значение само по себе не устанавливает причину дефицита RAM.",
                ])] if row.get("cache_at_minimum_gb") is not None else []),
                trend_block(
                    "Динамика минимумов доступной RAM",
                    row.get("trend", []),
                    row.get("trend_dates", []),
                    lower_is_worse=True,
                    suffix=" GiB",
                ),
                detail_block(
                    "Контекст",
                    [
                        f"ОС: {escape(row.get('os') or '—')}",
                        f"Роль: {escape(row.get('role') or '—')}",
                    ],
                ),
            ]
        cards.append(
            server_card(
                row["instance"],
                " · ".join(
                    part for part in [row.get("os"), row.get("role")] if part
                ),
                row["severity"],
                metrics,
                blocks,
            )
        )
    if kind == "cpu":
        headers = ["Сервер", "Среднее", "Пик", "Пред. день", "7 дней"]
        healthy_rows = [
            [
                f"<code>{escape(short_instance(row['instance']))}</code>",
                fmt(row["average_percent"], 0, "%"),
                fmt(row["peak_percent"], 0, "%"),
                fmt(row.get("previous_average_percent"), 0, "%"),
                fmt(row.get("average_7d_percent"), 0, "%"),
            ]
            for row in healthy
        ]
        healthy_label = f"Показать {len(healthy)} серверов с нормальной загрузкой CPU"
    else:
        headers = ["Сервер", "Минимум", "Медиана", "Доля", "Пред. день", "7 дней"]
        healthy_rows = [
            [
                f"<code>{escape(short_instance(row['instance']))}</code>",
                format_memory_gib(row["minimum_gb"]),
                format_memory_gib(row.get("median_gb")),
                fmt(row["minimum_percent"], 1, "%"),
                format_memory_gib(row.get("previous_minimum_gb")),
                format_memory_gib(row.get("average_7d_minimum_gb")),
            ]
            for row in healthy
        ]
        healthy_label = f"Показать {len(healthy)} серверов без дефицита RAM"
    content = '<div class="server-list">' + "".join(cards) + "</div>"
    content += healthy_group(healthy_label, headers, healthy_rows)
    badges = []
    if problem:
        badges.append(status_badge("warning", f"{len(problem)} внимание"))
    if healthy:
        badges.append(status_badge("healthy", f"{len(healthy)} норма"))
    return section(title, subtitle, badges, content, open_by_default=False)


def render_disks(rows: list[dict[str, Any]]) -> str:
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    cards = []
    for row in problem:
        cards.append(
            server_card(
                f"{row['instance']} · {row['device']}",
                f"{row.get('os') or ''} · диск/том",
                row["severity"],
                [
                    (
                        "Свободно",
                        fmt(row.get("minimum_free_percent"), 1, "%"),
                        tone_threshold(
                            row.get("minimum_free_percent"),
                            10,
                            3,
                            lower_is_worse=True,
                        ),
                    ),
                    (
                        "Read avg/peak",
                        (
                            f"{fmt(row.get('read_average_ms'), 0, ' ms')} / "
                            f"{fmt(row.get('read_peak_ms'), 0, ' ms')}"
                        ),
                        tone_threshold(row.get("read_peak_ms"), 50, 300),
                    ),
                    (
                        "Write avg/peak",
                        (
                            f"{fmt(row.get('write_average_ms'), 0, ' ms')} / "
                            f"{fmt(row.get('write_peak_ms'), 0, ' ms')}"
                        ),
                        tone_threshold(row.get("write_peak_ms"), 50, 300),
                    ),
                ],
                [
                    detail_block(
                        "Свободное место",
                        [
                            f"Минимум: {fmt(row.get('minimum_free_percent'), 1, '%')}",
                            f"Сейчас: {fmt(row.get('free_gb'), 1, ' GB')}",
                            f"Предыдущий рабочий день: {fmt(row.get('previous_minimum_free_percent'), 1, '%')}",
                        ],
                    ),
                    detail_block(
                        "Прогрессия",
                        [
                            f"Среднее 7 дней: "
                            f"{fmt(row.get('average_7d_minimum_free_percent'), 1, '%')}"
                        ],
                    ),
                    trend_block(
                        "Динамика свободного места",
                        row.get("trend", []),
                        row.get("trend_dates", []),
                        warning=10,
                        critical=3,
                        lower_is_worse=True,
                        suffix="%",
                    ),
                    detail_block(
                        "I/O",
                        [
                            f"Read avg: {fmt(row.get('read_average_ms'), 0, ' ms')}",
                            f"Read peak: {fmt(row.get('read_peak_ms'), 0, ' ms')}",
                            f"Write avg: {fmt(row.get('write_average_ms'), 0, ' ms')}",
                            f"Write peak: {fmt(row.get('write_peak_ms'), 0, ' ms')}",
                        ],
                    ),
                ],
            )
        )
    healthy_rows = [
        [
            f"<code>{escape(short_instance(row['instance']))} · {escape(row['device'])}</code>",
            fmt(row.get("minimum_free_percent"), 1, "%"),
            f"{fmt(row.get('read_average_ms'), 0, ' ms')} / {fmt(row.get('read_peak_ms'), 0, ' ms')}",
            f"{fmt(row.get('write_average_ms'), 0, ' ms')} / {fmt(row.get('write_peak_ms'), 0, ' ms')}",
            fmt(row.get("average_7d_minimum_free_percent"), 1, "%"),
        ]
        for row in healthy
    ]
    content = '<div class="server-list">' + "".join(cards) + "</div>"
    content += healthy_group(
        f"Показать {len(healthy)} томов без отклонений",
        ["Сервер / том", "Свободно", "Read avg/peak", "Write avg/peak", "7 дней"],
        healthy_rows,
    )
    badges = []
    if problem:
        badges.append(status_badge("warning", f"{len(problem)} внимание"))
    if healthy:
        badges.append(status_badge("healthy", f"{len(healthy)} томов норма"))
    return section(
        "Диски и I/O",
        "Свободное место и задержки за рабочее время",
        badges,
        content,
    )


def render_reboots(rows: list[dict[str, Any]]) -> str:
    body_rows = [
        [
            f"<code>{escape(short_instance(row['instance']))}</code>",
            escape(row["os"]),
            escape(datetime.fromisoformat(row["boot_at"]).strftime("%d.%m %H:%M МСК")),
            escape(human_duration(row["uptime_seconds"])),
            escape(row.get("role") or "—"),
        ]
        for row in rows
    ]
    content = (
        table(
            ["Сервер", "ОС", "Время запуска", "Текущий uptime", "Роль"],
            body_rows,
        )
        if rows
        else '<p class="empty-state">Перезагрузок за сутки не обнаружено</p>'
    )
    return section(
        "Перезагрузки",
        "События за полные сутки, время МСК",
        [status_badge("info", f"{len(rows)} события")],
        content,
    )


def render_websites(rows: list[dict[str, Any]]) -> str:
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    cards = []
    for row in problem:
        cards.append(
            server_card(
                row["instance"],
                "Веб-ресурс",
                row["severity"],
                [
                    (
                        "Успешность",
                        fmt(row.get("success_percent"), 1, "%"),
                        tone_threshold(row.get("success_percent"), 95, 90, lower_is_worse=True),
                    ),
                    (
                        "Среднее",
                        fmt(row.get("average_seconds"), 2, " сек"),
                        tone_threshold(row.get("average_seconds"), 4, 8),
                    ),
                    (
                        "SSL",
                        fmt(row.get("ssl_days_remaining"), 0, " дней"),
                        ssl_tone(row.get("ssl_days_remaining")),
                    ),
                ],
                [
                    detail_block(
                        "Успешность",
                        [
                            f"Успешно: {fmt(row.get('success_percent'), 1, '%')}",
                            f"Ошибок: {row.get('failed_checks') or 0}",
                            f"Среднее 7 дней: {fmt(row.get('average_7d_success_percent'), 1, '%')}",
                        ],
                    ),
                    detail_block(
                        "Время ответа",
                        [
                            f"Среднее: {fmt(row.get('average_seconds'), 2, ' сек')}",
                            f"Максимум: {fmt(row.get('peak_seconds'), 1, ' сек')}",
                        ],
                    ),
                    trend_block(
                        "Сравнение",
                        row.get("latency_trend", []),
                        row.get("trend_dates", []),
                        warning=4,
                        critical=8,
                        suffix=" сек",
                    ),
                    detail_block(
                        "SSL",
                        [
                            f"Действует еще "
                            f"{fmt(row.get('ssl_days_remaining'), 0, ' дней')}"
                        ],
                    ),
                ],
                website_severity_label(row),
            )
        )
    healthy_rows = [
        [
            f"<code>{escape(row['instance'])}</code>",
            fmt(row.get("success_percent"), 1, "%"),
            fmt(row.get("average_seconds"), 2, " сек"),
            fmt(row.get("ssl_days_remaining"), 0, " дней"),
        ]
        for row in healthy
    ]
    content = '<div class="server-list">' + "".join(cards) + "</div>"
    content += healthy_group(
        f"Показать {len(healthy)} веб-ресурсов без отклонений",
        ["Ресурс", "Успешность", "Среднее", "SSL"],
        healthy_rows,
    )
    badges = []
    if problem:
        badges.append(status_badge("warning", f"{len(problem)} внимание"))
    if healthy:
        badges.append(status_badge("healthy", f"{len(healthy)} норма"))
    return section(
        "Веб-ресурсы",
        "Успешность и время ответа за рабочее время, 09:00–18:00 МСК",
        badges,
        content,
    )


NETWORK_CHECK_LABELS = {
    "wan_icmp": "WAN ICMP",
    "mgmt_ssh": "Management SSH",
    "dsvpn_icmp": "DSVPN ICMP",
    "dsvpn_ssh": "DSVPN SSH",
    "device_icmp": "Device ICMP",
}

IF_OPER_STATUS_LABELS = {
    1: "up",
    2: "down",
    3: "testing",
    4: "unknown",
    5: "dormant",
    6: "notPresent",
    7: "lowerLayerDown",
}


def network_check_label(check_type: str | None) -> str:
    if not check_type:
        return "Probe"
    return NETWORK_CHECK_LABELS.get(check_type, check_type.replace("_", " ").upper())


def if_status_label(value: Any) -> str:
    try:
        status = int(float(value))
    except (TypeError, ValueError):
        return "unknown"
    return IF_OPER_STATUS_LABELS.get(status, f"status {status}")


def interface_status_badge(item: dict[str, Any]) -> str:
    label = item.get("status_label") or if_status_label(item.get("status"))
    severity = "healthy" if label == "up" else "warning"
    return status_badge(severity, label)


def render_network(rows: list[dict[str, Any]]) -> str:
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    cards = []
    for row in rows:
        checks = row.get("checks", [])
        check_lines = []
        for check in checks:
            daily = (
                f" · за сутки {fmt(check.get('success_percent'), 1, '%')}"
                if check.get("success_percent") is not None
                else ""
            )
            check_lines.append(
                f"<strong>{escape(network_check_label(check.get('check_type')))}</strong>: "
                f"{escape(check.get('instance') or '—')} · "
                f"{'OK' if check.get('current_success') else '<strong>DOWN</strong>'}"
                f"{daily}"
            )
        if not check_lines:
            check_lines = ["Blackbox-проверки не найдены"]
        interfaces = row.get("interfaces") or row.get("interfaces_down", [])
        interfaces_down = row.get("interfaces_down", [])
        interface_lines = [
            (
                f"<strong>{escape(item.get('name') or 'unknown')}</strong>: "
                f"{interface_status_badge(item)}"
            )
            for item in interfaces
        ] or ["Ключевые интерфейсы не найдены"]
        attention_lines = []
        if row.get("snmp_up") is False:
            attention_lines.append("SNMP exporter не получает данные")
        for item in interfaces_down:
            attention_lines.append(
                f"Интерфейс {escape(item.get('name') or 'unknown')}: "
                f"{escape(item.get('status_label') or if_status_label(item.get('status')))}"
            )
        for check in checks:
            if not check.get("current_success"):
                attention_lines.append(
                    f"{escape(network_check_label(check.get('check_type')))} "
                    f"{escape(check.get('instance') or '—')}: DOWN"
                )
            elif (
                check.get("success_percent") is not None
                and check["success_percent"] < 99.0
            ):
                attention_lines.append(
                    f"{escape(network_check_label(check.get('check_type')))} "
                    f"доступность за сутки {fmt(check.get('success_percent'), 1, '%')}"
                )
        if not attention_lines:
            if row["severity"] == "healthy":
                attention_lines.append("Отклонений по SNMP, checks и ключевым интерфейсам нет")
            else:
                attention_lines.append("Пороговые значения CPU/RAM/температуры требуют внимания")

        cards.append(
            server_card(
                row["device"],
                " · ".join(
                    part
                    for part in [row.get("model"), row.get("site"), row.get("branch")]
                    if part
                ),
                row["severity"],
                [
                    (
                        "CPU/RAM",
                        f"{fmt(row.get('cpu_percent'), 0, '%')} / {fmt(row.get('memory_percent'), 0, '%')}",
                        tone_threshold(
                            max(
                                row.get("cpu_percent") or 0,
                                row.get("memory_percent") or 0,
                            ),
                            80,
                            90,
                        ),
                    ),
                    (
                        "Температура",
                        fmt(row.get("temperature_celsius"), 0, "°C"),
                        tone_threshold(row.get("temperature_celsius"), 70, 80),
                    ),
                    (
                        "Uptime",
                        fmt(row.get("uptime_days"), 1, " дн"),
                        "",
                    ),
                ],
                [
                    detail_block("Требует внимания", attention_lines),
                    detail_block(
                        "Health",
                        [
                            f"SNMP: <strong>{'OK' if row.get('snmp_up') else 'DOWN'}</strong>",
                            f"Uptime: {fmt(row.get('uptime_days'), 1, ' дн')}",
                            f"CPU: {fmt(row.get('cpu_percent'), 0, '%')}",
                            f"RAM: {fmt(row.get('memory_percent'), 0, '%')}",
                            f"Температура: {fmt(row.get('temperature_celsius'), 0, '°C')}",
                        ],
                    ),
                    detail_block(
                        "ICMP/TCP проверки",
                        check_lines,
                    ),
                    detail_block("Ключевые интерфейсы", interface_lines),
                ],
                open_by_default=row["severity"] != "healthy" or len(rows) <= 3,
            )
        )

    content = '<div class="server-list">' + "".join(cards) + "</div>"
    badges = []
    if problem:
        badges.append(status_badge("warning", f"{len(problem)} требуют внимания"))
    if healthy:
        badges.append(status_badge("healthy", f"{len(healthy)} в норме"))
    return section(
        "Сетевое оборудование",
        "Huawei SNMP, ICMP и management TCP checks",
        badges,
        content,
    )


def render_proxy(rows: list[dict[str, Any]]) -> str:
    cards = []
    for row in rows:
        endpoints = row.get("endpoints", [])
        endpoint_rows = [
            [
                escape(endpoint.get("role") or "—"),
                escape(str(endpoint.get("port") or "—")),
                "Доступен" if endpoint.get("current_success") else "Недоступен",
                fmt(endpoint.get("success_percent"), 2, "%"),
                fmt(endpoint.get("average_seconds"), 3, " сек"),
            ]
            for endpoint in endpoints
        ]
        cards.append(
            server_card(
                row["site"],
                "proxy server",
                row["severity"],
                [
                    (
                        "Server",
                        "up" if row.get("server_up") else "down",
                        "" if row.get("server_up") else "bad",
                    ),
                    (
                        "Proxy TCP",
                        f"{sum(1 for item in endpoints if item.get('current_success') and item.get('role') == 'proxy')}/"
                        f"{sum(1 for item in endpoints if item.get('role') == 'proxy')}",
                        "",
                    ),
                    (
                        "x-ui",
                        (
                            "active"
                            if row.get("xui_active")
                            else "unknown" if row.get("xui_active") is None else "down"
                        ),
                        "" if row.get("xui_active") or row.get("xui_active") is None else "bad",
                    ),
                ],
                [
                    detail_block(
                        "Доступность",
                        [
                            f"Node exporter: {'up' if row.get('server_up') else 'down'}",
                            f"Server availability: {fmt(row.get('server_availability_percent'), 2, '%')}",
                        ],
                    ),
                    detail_block(
                        "Ресурсы",
                        [
                            f"CPU среднее/пик: {fmt(row.get('cpu_average_percent'), 1, '%')} / {fmt(row.get('cpu_peak_percent'), 1, '%')}",
                            f"RAM peak: {fmt(row.get('ram_peak_percent'), 1, '%')}",
                            f"Свободно на /: {fmt(row.get('root_free_percent'), 1, '%')}",
                            f"Network errors/drops rate: {fmt(row.get('network_error_rate'), 3, '/s')}",
                        ],
                    ),
                    detail_block(
                        "3x-ui traffic",
                        [
                            f"Upload за сутки: {fmt_bytes(row.get('xui_client_traffic_up_bytes'))}",
                            f"Download за сутки: {fmt_bytes(row.get('xui_client_traffic_down_bytes'))}",
                            f"Total за сутки: {fmt_bytes(row.get('xui_client_traffic_total_bytes'))}",
                            (
                                "Clients enabled/total: "
                                f"{fmt(row.get('xui_clients_enabled'), 0)} / "
                                f"{fmt(row.get('xui_clients_total'), 0)}"
                            ),
                            (
                                "Inbounds enabled/total: "
                                f"{fmt(row.get('xui_inbounds_enabled'), 0)} / "
                                f"{fmt(row.get('xui_inbounds_total'), 0)}"
                            ),
                        ],
                    ),
                    detail_block(
                        "TCP endpoints",
                        [],
                        table(
                            ["Роль", "Порт", "Сейчас", "Доступность", "Avg connect"],
                            endpoint_rows,
                        )
                        if endpoint_rows
                        else "<p>Нет данных по TCP endpoints</p>",
                    ),
                ],
            )
        )
    problem = [row for row in rows if row["severity"] != "healthy"]
    healthy = [row for row in rows if row["severity"] == "healthy"]
    badges = []
    critical = sum(row["severity"] == "critical" for row in problem)
    warnings = sum(row["severity"] == "warning" for row in problem)
    if critical:
        badges.append(status_badge("critical", f"{critical} критично"))
    if warnings:
        badges.append(status_badge("warning", f"{warnings} внимание"))
    if healthy:
        badges.append(status_badge("healthy", f"{len(healthy)} норма"))
    content = '<div class="server-list">' + "".join(cards) + "</div>"
    return section(
        "Proxy",
        "Доступность proxy-портов, node_exporter и базовые ресурсы",
        badges,
        content or '<p class="empty-state">Proxy-метрики отсутствуют</p>',
    )


def render_history(history: dict[str, list[dict[str, Any]]]) -> str:
    labels = (
        ("new", "Новые"),
        ("repeated", "Повторяются"),
        ("resolved", "Завершены"),
    )
    columns = []
    for key, title in labels:
        rows = history.get(key, [])
        items = (
            "".join(
                f"<li>{escape(short_instance(row['subject']))}: "
                f"{escape(row['summary'])}</li>"
                for row in rows[:10]
            )
            or "<li>Нет событий</li>"
        )
        columns.append(
            f'<article class="history-column"><h3>{title}</h3>'
            f"<ul>{items}</ul></article>"
        )
    return section(
        "История изменений",
        "Новые, повторяющиеся и завершенные события",
        [
            status_badge("critical", f"{len(history.get('new', []))} новых"),
            status_badge("info", f"{len(history.get('resolved', []))} завершено"),
        ],
        f'<div class="history-list">{"".join(columns)}</div>',
    )


def render_html(
    snapshot: MonitoringSnapshot,
    run_id: int,
    portal_url: str = "http://localhost",
) -> str:
    init_script, styles, interaction_script = theme_parts()
    findings = [
        finding
        for finding in telegram_findings(snapshot)
        if finding.severity in {"critical", "warning"}
    ]
    critical = sum(finding.severity == "critical" for finding in findings)
    warnings = sum(finding.severity == "warning" for finding in findings)
    availability = snapshot.statistics.get("availability", [])
    websites = snapshot.statistics.get("websites", [])
    network = snapshot.statistics.get("network", [])
    proxy = snapshot.statistics.get("proxy", [])
    total_objects = len(availability) + len(websites) + len(network)
    available_now = sum(row.get("current_up", False) for row in availability)
    availability_percent = (
        mean(row["availability_percent"] for row in availability)
        if availability
        else None
    )
    history_delta = len(snapshot.history.get("new", [])) - len(
        snapshot.history.get("resolved", [])
    )

    summary = f"""
    <section class="summary-grid" aria-label="Общая сводка">
      <div class="summary-item"><strong>{total_objects}</strong><span>объекта мониторинга</span></div>
      <div class="summary-item healthy"><strong>{available_now}</strong><span>доступны сейчас</span></div>
      <div class="summary-item critical"><strong>{critical}</strong><span>критические проблемы</span></div>
      <div class="summary-item warning"><strong>{warnings}</strong><span>требуют внимания</span></div>
      <div class="summary-item"><strong>{fmt(availability_percent, 2, "%")}</strong><span>доступность за 24 часа</span></div>
      <div class="summary-item"><strong>{history_delta:+d}</strong><span>изменение числа проблем</span></div>
    </section>
    """

    sections = [
        render_availability(availability),
        render_sql(snapshot.statistics.get("sql", [])),
        render_resource_section(
            "CPU",
            "Средняя и пиковая нагрузка за рабочее время, 09:00–18:00 МСК",
            snapshot.statistics.get("cpu", []),
            "cpu",
        ),
        render_resource_section(
            "RAM",
            "Минимум, медиана и длительность низкой памяти, 09:00–18:00 МСК",
            snapshot.statistics.get("ram", []),
            "ram",
        ),
        render_disks(snapshot.statistics.get("disks", [])),
        render_reboots(snapshot.statistics.get("reboots", [])),
        render_network(network),
        render_websites(websites),
        render_history(snapshot.history),
    ]
    if proxy:
        sections.insert(-2, render_proxy(proxy))

    incomplete = ""
    if snapshot.collector_errors:
        incomplete = (
            '<p class="empty-state">Часть данных за этот период недоступна. '
            "Остальные разделы сформированы из полученных показателей.</p>"
        )

    report_title = (
        f"Ежедневный отчет филиала {snapshot.branch}"
        if snapshot.branch
        else "Ежедневный отчет IT-инфраструктуры"
    )

    return f"""<!doctype html>
<html lang="ru" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(report_title)} #{run_id}</title>
  <script>{init_script}</script>
  <style>{styles}</style>
</head>
<body>
  <main class="page">
    <header class="report-header">
      <div>
        <h1>{escape(report_title)}</h1>
        <p class="report-meta">
          {snapshot.window_start:%d.%m.%Y} · рабочее время
          {snapshot.window_start:%H:%M}–{snapshot.window_end:%H:%M} МСК ·
          доступность и перезагрузки за полные сутки
        </p>
      </div>
      <div class="header-actions">
        <a class="header-link" href="{escape(portal_url)}"
           target="_blank" rel="noopener noreferrer">Открыть портал ↗</a>
        <button class="theme-toggle" id="theme-toggle" type="button"
                aria-label="Переключить тему" title="Переключить тему">
          <span id="theme-icon" aria-hidden="true">☾</span>
        </button>
      </div>
    </header>
    {summary}
    <nav class="toolbar" aria-label="Управление отчетом">
      <div class="toolbar-actions">
        <button type="button" id="expand-all">Развернуть все</button>
        <button type="button" id="collapse-all">Свернуть все</button>
      </div>
    </nav>
    {incomplete}
    {render_priority(snapshot)}
    {''.join(sections)}
    <footer>
      Отчет сформирован {snapshot.collected_at:%d.%m.%Y в %H:%M} МСК (UTC+3) ·
      снимок #{run_id} · HTML хранится 90 дней
    </footer>
  </main>
  <script>{interaction_script}</script>
</body>
</html>
"""


def cleanup_old_reports(
    reports_dir: Path,
    retention_days: int,
    now: datetime | None = None,
) -> list[Path]:
    if retention_days <= 0 or not reports_dir.exists():
        return []
    cutoff = (now or datetime.now()).timestamp() - retention_days * 86400
    removed = []
    for path in reports_dir.glob("infrastructure-*.html"):
        if not WEEKLY_REPORT_FILE_RE.match(path.name) and path.stat().st_mtime < cutoff:
            path.unlink()
            removed.append(path)
    return removed


def report_manifest_entries(reports_dir: Path) -> list[dict[str, Any]]:
    entries = []
    if not reports_dir.exists():
        return entries

    for path in reports_dir.iterdir():
        if not path.is_file():
            continue
        match = REPORT_FILE_RE.match(path.name)
        if match:
            entries.append(
                {
                    "report_type": "daily",
                    "file": path.name,
                    "date": match.group("date"),
                    "run": int(match.group("run")),
                }
            )
            continue
        weekly_match = WEEKLY_REPORT_FILE_RE.match(path.name)
        if weekly_match:
            iso_year = int(weekly_match.group("year"))
            iso_week = int(weekly_match.group("week"))
            monday = datetime.fromisocalendar(iso_year, iso_week, 1)
            friday = monday + timedelta(days=4)
            entries.append(
                {
                    "report_type": "weekly",
                    "file": path.name,
                    "iso_year": iso_year,
                    "iso_week": iso_week,
                    "period_start": monday.date().isoformat(),
                    "period_end": friday.date().isoformat(),
                    "timezone": "Europe/Moscow",
                    "run": int(weekly_match.group("run")),
                }
            )

    return sorted(
        entries,
        key=lambda item: (
            item["run"] if item.get("report_type") == "daily" else 0,
            item.get("period_end", item.get("date", "")),
        ),
        reverse=True,
    )


def write_reports_manifest(reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = reports_dir / "reports.json"
    temporary_path = reports_dir / "reports.json.tmp"
    temporary_path.write_text(
        json.dumps(
            report_manifest_entries(reports_dir),
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(manifest_path)
    return manifest_path


def write_html_report(
    snapshot: MonitoringSnapshot,
    run_id: int,
    reports_dir: Path,
    portal_url: str = "http://localhost",
    retention_days: int = 90,
) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    cleanup_old_reports(reports_dir, retention_days)
    name = (
        f"infrastructure-{snapshot.window_start:%Y-%m-%d}"
        f"-run-{run_id}.html"
    )
    path = reports_dir / name
    temporary_path = reports_dir / f".{name}.tmp"
    temporary_path.write_text(
        render_html(snapshot, run_id, portal_url),
        encoding="utf-8",
    )
    temporary_path.replace(path)
    write_reports_manifest(reports_dir)
    return path
