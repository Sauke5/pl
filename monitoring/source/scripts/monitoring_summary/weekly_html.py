from __future__ import annotations

import html
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .formatter import human_duration, short_instance
from .html_report import escape, fmt, fmt_bytes, status_badge, theme_parts, write_reports_manifest
from .weekly import WEEKLY_RETENTION_WEEKS_DEFAULT, WeeklySnapshot

DAY_LABELS = ("Пн", "Вт", "Ср", "Чт", "Пт")
CATEGORY_LABELS = {
    "availability": "Доступность",
    "sql": "SQL Server",
    "cpu": "CPU",
    "ram": "RAM",
    "disks": "Диски и I/O",
    "network": "Сеть",
    "proxy": "Proxy",
    "websites": "Веб-ресурсы",
}


def fmt_minutes(value: float | int | None) -> str:
    if value is None:
        return "—"
    seconds = float(value) * 60
    return human_duration(seconds)


def fmt_delta(value: float | None, suffix: str = "") -> str:
    if value is None:
        return "нет данных"
    sign = "+" if value > 0 else ""
    return f"{sign}{fmt(value, 1, suffix)}"


def metric(label: str, value: str, tone: str = "") -> str:
    class_name = f"metric-value {tone}".strip()
    return (
        '<span class="row-metric">'
        f'<span class="metric-label">{escape(label)}</span>'
        f'<span class="{class_name}">{escape(value)}</span>'
        "</span>"
    )


def detail(title: str, lines: list[str], extra: str = "") -> str:
    body = "".join(f"<p>{line}</p>" for line in lines)
    return f'<div class="detail-block"><h4>{escape(title)}</h4>{body}{extra}</div>'


def weekly_trend(
    values: list[float | None],
    dates: tuple[Any, ...],
    suffix: str = "",
    lower_is_worse: bool = False,
) -> str:
    present = [value for value in values if value is not None]
    if not present:
        return "<p>Нет данных по дням</p>"
    low, high = min(present), max(present)
    span = high - low or max(abs(high), 1)
    bars = []
    labels = []
    for index in range(5):
        value = values[index] if index < len(values) else None
        day = dates[index]
        if value is None:
            bars.append('<span class="trend-bar empty" style="--value:8%" title="Нет данных"><i>—</i></span>')
            title = f"{day:%d.%m.%Y}: нет данных"
        else:
            height = 22 + (value - low) / span * 78
            title = f"{day:%d.%m.%Y}: {fmt(value, 1, suffix)}"
            bars.append(f'<span class="trend-bar" style="--value:{height:.0f}%" title="{escape(title)}"><i>{fmt(value, 1)}</i></span>')
        labels.append(f'<span title="{escape(title)}">{DAY_LABELS[index]}</span>')
    return f'<div class="sparkline">{"".join(bars)}</div><div class="trend-labels">{"".join(labels)}</div>'


def card(
    name: str,
    subtitle: str,
    severity: str,
    metrics: list[str],
    blocks: list[str],
    compact_metrics: bool = False,
) -> str:
    card_class = "server compact-metrics" if compact_metrics else "server"
    metrics_html = (
        f'<span class="server-metrics">{"".join(metrics)}</span>'
        if compact_metrics
        else "".join(metrics)
    )
    return (
        f'<details class="{card_class}" data-health="{escape(severity)}">'
        '<summary><span class="chevron">›</span>'
        f'<span class="server-name"><strong>{escape(short_instance(name))}</strong><small>{escape(subtitle)}</small></span>'
        f'{metrics_html}{status_badge(severity)}</summary>'
        f'<div class="server-details">{"".join(blocks)}</div></details>'
    )


def table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return '<p class="empty-state">Нет данных</p>'
    head = "".join(f"<th>{escape(value)}</th>" for value in headers)
    body = "".join("<tr>" + "".join(f"<td>{value}</td>" for value in row) + "</tr>" for row in rows)
    return f'<div class="compact-table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def healthy_group(label: str, headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return ""
    return f'<details class="healthy-summary"><summary>Показать {len(rows)} {escape(label)} без отклонений</summary>{table(headers, rows)}</details>'


def section(title: str, subtitle: str, rows: list[dict[str, Any]], content: str) -> str:
    counts = []
    for severity, label in (("critical", "критично"), ("warning", "внимание"), ("healthy", "норма"), ("info", "события")):
        count = sum(row.get("severity") == severity for row in rows)
        if count:
            counts.append(status_badge(severity, f"{count} {label}"))
    return (
        '<details class="report-section">'
        '<summary><span class="chevron">›</span>'
        f'<span class="section-title"><strong>{escape(title)}</strong><span>{escape(subtitle)}</span></span>'
        f'<span class="section-counts">{"".join(counts)}</span></summary>'
        f'<div class="section-body">{content}</div></details>'
    )


def render_highlights(snapshot: WeeklySnapshot) -> str:
    items = []
    for item in snapshot.highlights:
        delta = ""
        if item.get("delta") is not None:
            css = item.get("direction", "neutral")
            delta = f'<span class="weekly-delta {escape(css)}">к прошлой неделе: {escape(fmt_delta(item["delta"], item.get("delta_unit", "")))}</span>'
        items.append(
            '<article class="weekly-highlight">'
            f'{status_badge(item["severity"])}'
            f'<div><strong>{escape(short_instance(item["subject"]))}</strong><p>{escape(item["summary"])}</p>'
            f'<small>{escape(CATEGORY_LABELS.get(item["category"], item["category"]))} · {escape(fmt_minutes(item.get("duration_minutes")))} · {item.get("affected_days", 0)} дн.</small></div>{delta}</article>'
        )
    content = "".join(items) or '<p class="empty-state">Значимых отклонений за неделю не обнаружено.</p>'
    return section("Главное за неделю", "Наиболее значимые отклонения по severity, длительности и повторяемости", snapshot.highlights, f'<div class="weekly-highlights">{content}</div>')


def render_availability(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("availability", [])
    cards, healthy = [], []
    for row in rows:
        if row["severity"] == "healthy" and not row.get("partial_coverage"):
            healthy.append([f'<code>{escape(short_instance(row["instance"]))}</code>', fmt(row["availability_percent"], 2, "%"), fmt_minutes(row["downtime_minutes"]), fmt(row["coverage_percent"], 0, "%")])
            continue
        intervals = [f"{datetime.fromisoformat(item['start']):%d.%m %H:%M}–{datetime.fromisoformat(item['end']):%H:%M}: {fmt_minutes(item['duration_minutes'])}" for item in row["intervals"][:20]] or ["Подтверждённых интервалов простоя нет"]
        cards.append(card(row["instance"], f"{row['os']} · {row.get('role') or 'роль не задана'}", row["severity"], [metric("Доступность", fmt(row["availability_percent"], 2, "%")), metric("Простой", fmt_minutes(row["downtime_minutes"])), metric("События", str(row["events"]))], [detail("Интервалы", intervals), detail("Неделя", [f"Максимальный простой: {fmt_minutes(row['longest_downtime_minutes'])}", f"Дней с разрывами: {row['affected_days']}", f"Покрытие: {fmt(row['coverage_percent'], 1, '%')}"]), detail("Сравнение", [f"Предыдущая неделя: {fmt(row.get('previous_availability_percent'), 2, '%')}", f"Изменение: {fmt_delta(row.get('availability_delta_pp'), ' п.п.')}"]), detail("Пн–Пт", [], weekly_trend(row["daily"], snapshot.period.days, "%", True))]))
    return section("Доступность инфраструктуры", "Весь период Пн 00:00 — Пт 17:30 МСК; отсутствие данных не считается доступностью", rows, f'<div class="server-list">{"".join(cards)}</div>' + healthy_group("объектов", ["Объект", "Доступность", "Простой", "Покрытие"], healthy))


def render_problems(snapshot: WeeklySnapshot) -> str:
    labels = (("new", "Новые"), ("repeated", "Повторяющиеся"), ("carried", "Перенесённые"), ("resolved", "Завершённые"), ("active", "Активны к концу периода"))
    columns = []
    all_rows = []
    for key, title in labels:
        rows = snapshot.problems.get(key, [])
        all_rows.extend(rows)
        items = "".join(f'<li><strong>{escape(short_instance(row["subject"]))}</strong>: {escape(row["alertname"])}<small>{row["days"]} дн. · {row["events"]} событий · {escape(fmt_minutes(row["duration_minutes"]))}</small></li>' for row in rows[:25]) or "<li>Нет событий</li>"
        columns.append(f'<article class="history-column"><h3>{escape(title)}</h3><ul>{items}</ul></article>')
    count_rows = [
        row
        for key in ("new", "repeated", "carried")
        for row in snapshot.problems.get(key, [])
    ]
    return section("События и проблемы недели", "Устойчивый ключ строится по alertname и идентифицирующим labels", count_rows, f'<div class="weekly-problem-grid">{"".join(columns)}</div>')


def render_resources(snapshot: WeeklySnapshot, kind: str) -> str:
    rows = snapshot.statistics.get(kind, [])
    cards, healthy, sql_memory = [], [], []
    headers = (
        ["Сервер", "p95", "Среднее", "Выше порога"]
        if kind == "cpu"
        else ["Сервер", "p5", "Минимум", "Ниже порога"]
    )
    for row in rows:
        if kind == "cpu":
            values = [fmt(row["p95_percent"], 1, "%"), fmt(row["average_percent"], 1, "%"), fmt_minutes(row["warning_minutes"])]
            blocks = [detail("Недельные показатели", [f"Среднее: {fmt(row['average_percent'], 1, '%')}", f"p95: {fmt(row['p95_percent'], 1, '%')}", f"Максимум: {fmt(row['maximum_percent'], 1, '%')}"]), detail("Превышения", [f"Выше warning: {fmt_minutes(row['warning_minutes'])}", f"Выше critical: {fmt_minutes(row['critical_minutes'])}", f"Максимальный интервал: {fmt_minutes(row['longest_high_minutes'])}", f"Затронуто дней: {row['affected_days']}"]), detail("Сравнение", [f"p95 прошлой недели: {fmt(row.get('previous_p95_percent'), 1, '%')}", f"Изменение: {fmt_delta(row.get('p95_delta_pp'), ' п.п.')}"]), detail("Пн–Пт · p95", [], weekly_trend(row["daily"], snapshot.period.days, "%"))]
        else:
            values = [fmt(row["p5_percent"], 1, "%"), fmt(row.get("minimum_gb"), 1, " GB"), fmt_minutes(row["warning_minutes"])]
            blocks = [detail("Недельные показатели", [f"Минимум: {fmt(row.get('minimum_gb'), 1, ' GB')}", f"Минимальная доля: {fmt(row['minimum_percent'], 1, '%')}", f"p5: {fmt(row['p5_percent'], 1, '%')}"]), detail("Дефицит", [f"Ниже warning: {fmt_minutes(row['warning_minutes'])}", f"Ниже critical: {fmt_minutes(row['critical_minutes'])}", f"Максимальный интервал: {fmt_minutes(row['longest_low_minutes'])}", f"Затронуто дней: {row['affected_days']}"]), detail("Сравнение", [f"p5 прошлой недели: {fmt(row.get('previous_p5_percent'), 1, '%')}", f"Изменение: {fmt_delta(row.get('p5_delta_pp'), ' п.п.')}"]), detail("Пн–Пт · p5", [], weekly_trend(row["daily"], snapshot.period.days, "%", True))]
        summary_metrics = [metric("p95" if kind == "cpu" else "p5", values[0]), metric("Среднее" if kind == "cpu" else "Минимум", values[1]), metric("Отклонение", values[2])]
        if row.get("pressure_policy") == "absolute-reserve" and row["severity"] == "healthy":
            sql_memory.append([
                f'<code>{escape(short_instance(row["instance"]))}</code>',
                fmt(row.get("minimum_gb"), 1, " GB"),
                fmt(row.get("p5_percent"), 1, "%"),
                "Норма: SQL buffer pool",
            ])
        elif row["severity"] == "healthy":
            healthy.append([f'<code>{escape(short_instance(row["instance"]))}</code>', values[0], values[1], values[2]])
        else:
            subtitle = (
                f"{row['os']} · SQL Server · порог по абсолютному резерву"
                if row.get("pressure_policy") == "absolute-reserve"
                else f"{row['os']} · рабочие окна"
            )
            cards.append(card(row["instance"], subtitle, row["severity"], summary_metrics, blocks))
    title = "CPU" if kind == "cpu" else "RAM"
    subtitle = "p95 и длительность высокой нагрузки" if kind == "cpu" else "p5 доступной памяти и длительность дефицита"
    sql_note = ""
    if kind == "ram" and sql_memory:
        sql_note = (
            '<details class="healthy-summary sql-memory-summary"><summary>'
            f'Показать {len(sql_memory)} SQL Server: свободный процент RAM не считается проблемой'
            '</summary>'
            + table(["SQL Server", "Мин. резерв", "p5 свободно", "Оценка"], sql_memory)
            + "</details>"
        )
    return section(title, subtitle, rows, f'<div class="server-list">{"".join(cards)}</div>' + sql_note + healthy_group("серверов", headers, healthy))


def render_sql(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("sql", [])
    cards, healthy = [], []
    for row in rows:
        worst = row["databases"][0] if row["databases"] else None
        ple = row.get("ple")
        database_rows = [[f'<code>{escape(item["name"])}</code>', fmt(item["maximum_percent"], 1, "%"), fmt(item["p95_percent"], 1, "%"), fmt_minutes(item["warning_minutes"]), str(item["affected_days"])] for item in row["databases"][:30]]
        blocks = [detail("Transaction log", [f"Худшая база: {escape(worst['name']) if worst else '—'}", f"Максимум: {fmt(worst.get('maximum_percent') if worst else None, 1, '%')}", f"p95: {fmt(worst.get('p95_percent') if worst else None, 1, '%')}", f"Выше warning: {fmt_minutes(worst.get('warning_minutes') if worst else None)}"]), detail("Page Life Expectancy", [f"Минимум: {fmt(ple.get('minimum_seconds') if ple else None, 0, ' сек')}", f"p5: {fmt(ple.get('p5_seconds') if ple else None, 0, ' сек')}", f"Ниже warning: {fmt_minutes(ple.get('warning_minutes') if ple else None)}", f"Дней с проблемой: {ple.get('affected_days', 0) if ple else 0}"]), detail("Базы", [], table(["База", "Макс.", "p95", "Выше порога", "Дни"], database_rows)), detail("Пн–Пт · PLE", [], weekly_trend(ple.get("daily", []) if ple else [], snapshot.period.days, " сек", True))]
        metrics = [metric("Log p95", fmt(worst.get("p95_percent") if worst else None, 1, "%")), metric("PLE p5", fmt(ple.get("p5_seconds") if ple else None, 0, " сек")), metric("Базы", str(len(row["databases"])))]
        if row["severity"] == "healthy":
            healthy.append([f'<code>{escape(short_instance(row["instance"]))}</code>', fmt(worst.get("p95_percent") if worst else None, 1, "%"), fmt(ple.get("p5_seconds") if ple else None, 0, " сек")])
        else:
            cards.append(card(row["instance"], "SQL Server · рабочие окна", row["severity"], metrics, blocks))
    return section("SQL Server", "Transaction log и Page Life Expectancy по рабочим окнам", rows, f'<div class="server-list">{"".join(cards)}</div>' + healthy_group("SQL Server", ["Сервер", "Log p95", "PLE p5"], healthy))


def render_disks(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("disks", [])
    cards, healthy = [], []
    for row in rows:
        blocks = [detail("Свободное место", [f"Начало: {fmt(row.get('start_free_gb'), 1, ' GB')} · {fmt(row.get('start_free_percent'), 1, '%')}", f"Конец: {fmt(row.get('end_free_gb'), 1, ' GB')} · {fmt(row.get('end_free_percent'), 1, '%')}", f"Изменение: {fmt_delta(row.get('change_gb'), ' GB')} · {fmt_delta(row.get('change_pp'), ' п.п.')}", f"Среднесуточное заполнение: {fmt(row.get('daily_fill_gb'), 1, ' GB/дн')}"]), detail("Дисковый I/O", [f"Read p95 / max: {fmt(row.get('read_p95_ms'), 1, ' мс')} / {fmt(row.get('read_max_ms'), 1, ' мс')}", f"Write p95 / max: {fmt(row.get('write_p95_ms'), 1, ' мс')} / {fmt(row.get('write_max_ms'), 1, ' мс')}", f"Read выше порога: {fmt_minutes(row.get('read_warning_minutes'))}", f"Write выше порога: {fmt_minutes(row.get('write_warning_minutes'))}"]), detail("Сравнение", [f"Минимум прошлой недели: {fmt(row.get('previous_minimum_free_percent'), 1, '%')}", "Прогноз не строится без устойчивого ряда достаточной длины"]), detail("Пн–Пт · минимум свободного места", [], weekly_trend(row.get("daily", []), snapshot.period.days, "%", True))]
        metrics = [metric("Свободно", fmt(row.get("minimum_free_percent"), 1, "%")), metric("Read p95", fmt(row.get("read_p95_ms"), 1, " мс")), metric("Изменение", fmt_delta(row.get("change_gb"), " GB"))]
        if row["severity"] == "healthy":
            healthy.append([f'<code>{escape(short_instance(row["instance"]))} {escape(row["device"])}</code>', fmt(row.get("minimum_free_percent"), 1, "%"), fmt(row.get("read_p95_ms"), 1, " мс"), fmt(row.get("write_p95_ms"), 1, " мс")])
        else:
            cards.append(card(f"{row['instance']} {row['device']}", f"{row['os']} · рабочие окна", row["severity"], metrics, blocks))
    return section("Диски и I/O", "Свободное место, динамика заполнения и устойчивые задержки", rows, f'<div class="server-list">{"".join(cards)}</div>' + healthy_group("томов", ["Том", "Свободно", "Read p95", "Write p95"], healthy))


def render_reboots(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("reboots", [])
    data = [[f'<code>{escape(short_instance(row["instance"]))}</code>', escape(row["os"]), datetime.fromisoformat(row["boot_at"]).strftime("%d.%m.%Y %H:%M"), escape(row.get("role") or "—"), str(row["weekly_count"]), str(row["previous_count"])] for row in rows]
    return section("Перезагрузки", "Все обнаруженные изменения boot time; причина без подтверждения не предполагается", rows, table(["Сервер", "ОС", "Время запуска", "Роль", "За неделю", "Прошлая"], data))


def render_network(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("network", [])
    cards = []
    for row in rows:
        checks = [[escape(item["check_type"]), f'<code>{escape(item["instance"])}</code>', fmt(item["success_percent"], 2, "%"), str(item["events"]), fmt_minutes(item["downtime_minutes"]), fmt(item.get("previous_success_percent"), 2, "%")] for item in row["checks"]]
        cards.append(card(row["device"], f"{row.get('vendor') or 'Network'} {row.get('model') or ''}", row["severity"], [metric("SNMP", fmt(row.get("snmp_availability_percent"), 2, "%")), metric("CPU p95", fmt(row.get("cpu_p95_percent"), 1, "%")), metric("Температура", fmt(row.get("temperature_max_celsius"), 1, " °C"))], [detail("Проверки доступности", [], table(["Тип", "Источник", "Доступность", "Разрывы", "Простой", "Прошлая"], checks)), detail("Ресурсы", [f"CPU p95 / max: {fmt(row.get('cpu_p95_percent'), 1, '%')} / {fmt(row.get('cpu_max_percent'), 1, '%')}", f"RAM p95 / max: {fmt(row.get('ram_p95_percent'), 1, '%')} / {fmt(row.get('ram_max_percent'), 1, '%')}", f"Температура max: {fmt(row.get('temperature_max_celsius'), 1, ' °C')}"])], compact_metrics=True))
    return section("Сетевое оборудование", "SNMP, management, WAN/DSVPN и доступные health-метрики", rows, f'<div class="server-list">{"".join(cards)}</div>' or '<p class="empty-state">Сетевые метрики отсутствуют</p>')


def render_proxy(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("proxy", [])
    cards = []
    for row in rows:
        endpoints = [[f'<code>{escape(item["instance"])}</code>', escape(item["role"]), fmt(item["success_percent"], 2, "%"), str(item["failed_checks"]), fmt_minutes(item["downtime_minutes"]), fmt(item.get("p95_connect_seconds"), 3, " сек")] for item in row["endpoints"]]
        cards.append(card(row["site"], "Relay/final proxy", row["severity"], [metric("Node", fmt(row.get("node_availability_percent"), 2, "%")), metric("x-ui", fmt(row.get("xui_active_percent"), 2, "%")), metric("Порты", str(len(row["endpoints"])))], [detail("Proxy-порты", [], table(["Endpoint", "Роль", "Доступность", "Ошибки", "Простой", "Connect p95"], endpoints)), detail("Узел", [f"node_exporter: {fmt(row.get('node_availability_percent'), 2, '%')}", f"x-ui active: {fmt(row.get('xui_active_percent'), 2, '%')}"])], compact_metrics=True))
    return section("Proxy", "Доступность узлов, портов, connect time и x-ui", rows, f'<div class="server-list">{"".join(cards)}</div>' or '<p class="empty-state">Proxy-метрики отсутствуют</p>')


def render_websites(snapshot: WeeklySnapshot) -> str:
    rows = snapshot.statistics.get("websites", [])
    cards, healthy = [], []
    for row in rows:
        blocks = [detail("Проверки", [f"Успешно: {row['successful_checks']}", f"Неуспешно: {row['failed_checks']}", f"Интервалов недоступности: {row['events']}", f"Суммарный простой: {fmt_minutes(row['downtime_minutes'])}", f"Максимальный простой: {fmt_minutes(row['longest_downtime_minutes'])}"]), detail("Производительность", [f"Среднее: {fmt(row.get('average_seconds'), 2, ' сек')}", f"p95: {fmt(row.get('p95_seconds'), 2, ' сек')}", f"Максимум: {fmt(row.get('maximum_seconds'), 2, ' сек')}", f"p95 прошлой недели: {fmt(row.get('previous_p95_seconds'), 2, ' сек')}"]), detail("Сравнение и TLS", [f"Успешность прошлой недели: {fmt(row.get('previous_success_percent'), 2, '%')}", f"Изменение: {fmt_delta(row.get('success_delta_pp'), ' п.п.')}", f"TLS: {fmt(row.get('ssl_days_remaining'), 0, ' дн.') if row['instance'].lower().startswith('https://') else 'не применяется (HTTP)'}"]), detail("Пн–Пт · успешность", [], weekly_trend(row["daily"], snapshot.period.days, "%", True))]
        tls_value = fmt(row.get("ssl_days_remaining"), 0, " дн.") if row["instance"].lower().startswith("https://") else "HTTP"
        metrics = [metric("Успешность", fmt(row["success_percent"], 2, "%")), metric("p95", fmt(row.get("p95_seconds"), 2, " сек")), metric("TLS", tls_value)]
        if row["severity"] == "healthy":
            healthy.append([f'<code>{escape(row["instance"])}</code>', fmt(row["success_percent"], 2, "%"), fmt(row.get("p95_seconds"), 2, " сек"), escape(tls_value)])
        else:
            cards.append(card(row["instance"], "Веб-ресурс · рабочие окна", row["severity"], metrics, blocks))
    return section("Веб-ресурсы", "Успешность, интервалы недоступности, p95 ответа и TLS", rows, f'<div class="server-list">{"".join(cards)}</div>' + healthy_group("ресурсов", ["Ресурс", "Успешность", "p95", "TLS"], healthy))


def render_quality(snapshot: WeeklySnapshot) -> str:
    quality = snapshot.quality
    partial = "".join(f"<li>{escape(value)}</li>" for value in quality.get("partial_object_names", [])) or "<li>Нет</li>"
    errors = "".join(f"<li><strong>{escape(name)}</strong>: {escape(message)}</li>" for name, message in snapshot.collector_errors.items()) or "<li>Нет</li>"
    limits = "".join(f"<li>{escape(value)}</li>" for value in quality.get("limitations", []))
    content = '<div class="server-details">' + detail("Покрытие", [f"Обработано строк: {quality.get('processed_objects', 0)}", f"Неполное покрытие: {quality.get('partial_objects', 0)}", f"Доля полно обработанных: {fmt(quality.get('success_percent'), 1, '%')}"]) + detail("Объекты с неполным покрытием", [], f"<ul>{partial}</ul>") + detail("Ошибки источников", [], f"<ul>{errors}</ul>") + detail("Ограничения", [], f"<ul>{limits}</ul>") + "</div>"
    severity = "warning" if snapshot.collector_errors or quality.get("partial_objects") else "healthy"
    return section("Качество данных мониторинга", "Пропуски и ошибки показаны явно и не превращаются в нормальное состояние", [{"severity": severity}], content)


def render_business_summary(snapshot: WeeklySnapshot) -> str:
    summary = snapshot.summary
    business = summary.get("business", {})
    sla_total = business.get("sla_total", 0)
    sla_met = business.get("sla_met", 0)
    sla_target = business.get("sla_target_percent", 99.9)
    sla_delta = business.get("sla_delta_pp")
    affected = business.get("affected_objects", 0)
    without_downtime = business.get("without_downtime", 0)
    web_total = business.get("websites_total", 0)
    web_ok = business.get("website_sla_met", 0)
    web_sla_target = business.get("website_sla_target_percent", 99.0)
    active = business.get("active_problems", 0)
    active_critical = business.get("active_critical_problems", 0)
    risk_count = business.get("resource_risk_objects", 0)
    risk_names = business.get("resource_risk_names", [])
    longest = business.get("longest_downtime_minutes", 0)
    longest_object = business.get("longest_downtime_object") or "—"

    def business_card(title: str, value: str, note: str, tone: str) -> str:
        return (
            f'<article class="business-card {escape(tone)}">'
            f'<span>{escape(title)}</span><strong>{escape(value)}</strong>'
            f'<small>{escape(note)}</small></article>'
        )

    cards = [
        business_card(
            f"Выполнили SLA ≥ {fmt(sla_target, 1, '%')}",
            f"{sla_met} из {sla_total}",
            f"Доля {fmt(business.get('sla_percent'), 1, '%')} · сопоставимые объекты к прошлой неделе {fmt_delta(sla_delta, ' п.п.')}",
            "healthy" if sla_total and sla_met == sla_total else "warning",
        ),
        business_card(
            "Без подтверждённого простоя",
            f"{without_downtime} из {sla_total}",
            f"Затронуто: {affected} · неполные данные: {business.get('incomplete_objects', 0)}",
            "healthy" if affected == 0 and not business.get("incomplete_objects", 0) else "warning",
        ),
        business_card(
            f"Веб-SLA ≥ {fmt(web_sla_target, 0, '%')}",
            f"{web_ok} из {web_total}",
            f"Худший: {short_instance(business.get('worst_website') or '—')} · {fmt(business.get('worst_website_success_percent'), 1, '%')}",
            "healthy" if web_total and web_ok == web_total else "critical" if web_total and web_ok / web_total < .9 else "warning",
        ),
        business_card(
            "Проблемы активны к пятнице",
            str(active),
            f"Из них критичных: {active_critical}",
            "healthy" if active == 0 else "critical" if active_critical else "warning",
        ),
        business_card(
            "Узлы с ресурсным риском",
            str(risk_count),
            ", ".join(short_instance(name) for name in risk_names[:3]) + (" и ещё" if len(risk_names) > 3 else "") or "Устойчивых отклонений нет",
            "healthy" if risk_count == 0 else "warning",
        ),
        business_card(
            "Максимальный единичный простой",
            fmt_minutes(longest),
            f"Объект: {short_instance(longest_object)}",
            "healthy" if not longest else "warning",
        ),
    ]
    technical = (
        f"Технический охват: {summary.get('objects', 0)} объектов · "
        f"взвешенная доступность {fmt(summary.get('availability_percent'), 3, '%')} · "
        f"суммарно {fmt_minutes(summary.get('downtime_minutes'))} объект-простоя · "
        f"критических событий {summary.get('critical_events', 0)}"
    )
    return (
        '<section class="business-summary" aria-label="Управленческий итог">'
        '<div class="business-heading"><div><h2>Управленческий итог</h2>'
        '<p>Результат недели по SLA, влиянию на сервисы и незакрытым рискам — без подмены средними значениями.</p>'
        f'</div><span>{snapshot.period.key}</span></div>'
        f'<div class="business-grid">{"".join(cards)}</div>'
        f'<p class="technical-context">{escape(technical)}</p></section>'
    )


def render_html(snapshot: WeeklySnapshot, run_number: int, portal_url: str, retention_weeks: int) -> str:
    init_script, styles, interaction_script = theme_parts()
    supplemental = """
    .weekly-highlights { display: grid; gap: 10px; }
    .weekly-highlight { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: start; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); }
    .weekly-highlight p { margin: 4px 0; }
    .weekly-highlight small { color: var(--muted); }
    .weekly-delta { white-space: nowrap; font-size: .78rem; font-weight: 700; }
    .weekly-delta.improved { color: var(--healthy); } .weekly-delta.worsened { color: var(--critical); } .weekly-delta.neutral { color: var(--muted); }
    .weekly-problem-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 12px; }
    .weekly-problem-grid li small { display: block; margin-top: 3px; color: var(--muted); }
    .business-summary { margin: 14px 0; }
    .business-heading { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 10px; }
    .business-heading h2 { margin: 0; font-size: 18px; }
    .business-heading p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .business-heading > span { color: var(--muted); font-weight: 750; white-space: nowrap; }
    .business-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .business-card { min-width: 0; padding: 14px; border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 1px 3px var(--shadow); }
    .business-card.healthy { border-left-color: var(--healthy); } .business-card.warning { border-left-color: var(--warning); } .business-card.critical { border-left-color: var(--critical); }
    .business-card > span, .business-card small { display: block; color: var(--muted); font-size: 11px; }
    .business-card strong { display: block; margin: 5px 0; font-size: 24px; line-height: 1.15; overflow-wrap: anywhere; }
    .technical-context { margin: 10px 0 0; padding: 9px 12px; color: var(--muted); font-size: 11px; background: var(--surface-soft); border-radius: 6px; }
    .compact-metrics > summary { grid-template-columns: 20px minmax(180px, 1fr) minmax(330px, 1.4fr) minmax(92px, max-content); }
    .server-metrics { display: grid; grid-template-columns: repeat(3, minmax(90px, 1fr)); gap: 14px; min-width: 0; }
    .compact-metrics > .server-details { grid-template-columns: minmax(0, 1fr); }
    .compact-metrics > .server-details > .detail-block { min-width: 0; }
    .compact-metrics .compact-table-wrap table { min-width: 680px; }
    .sql-memory-summary summary { color: var(--text); }
    @media (max-width: 980px) {
      .business-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .compact-metrics > summary { grid-template-columns: 20px minmax(0, 1fr) minmax(92px, max-content); }
      .compact-metrics > summary .server-metrics { grid-column: 2 / -1; width: 100%; }
      .compact-metrics > summary > .status { grid-column: 3; grid-row: 1; justify-self: end; }
      .compact-metrics > summary .row-metric { display: block; }
    }
    @media (max-width: 720px) { .weekly-highlight { grid-template-columns: auto 1fr; } .weekly-delta { grid-column: 2; white-space: normal; } }
    @media (max-width: 680px) {
      .business-heading { align-items: start; }
      .business-grid { grid-template-columns: 1fr; }
      .compact-metrics > summary .server-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .compact-metrics > summary .row-metric { display: block; }
    }
    """
    summary_html = render_business_summary(snapshot)
    sections = [render_highlights(snapshot), render_availability(snapshot), render_problems(snapshot), render_sql(snapshot), render_resources(snapshot, "cpu"), render_resources(snapshot, "ram"), render_disks(snapshot), render_reboots(snapshot), render_network(snapshot), render_proxy(snapshot), render_websites(snapshot), render_quality(snapshot)]
    return f"""<!doctype html>
<html lang="ru" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Еженедельный отчёт IT-инфраструктуры · {snapshot.period.key}</title>
  <script>{init_script}</script>
  <style>{styles}\n{supplemental}</style>
</head>
<body>
  <main class="page">
    <header class="report-header">
      <div><h1>Еженедельный отчёт IT-инфраструктуры</h1><p class="report-meta">{snapshot.period.start:%d.%m.%Y}–{snapshot.period.end:%d.%m.%Y} · рабочее время Пн–Чт 09:00–18:00, Пт 09:00–17:30 МСК · доступность за весь отчётный период</p></div>
      <div class="header-actions"><a class="header-link" href="{escape(portal_url)}" target="_blank" rel="noopener noreferrer">Открыть портал ↗</a><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему" title="Переключить тему"><span id="theme-icon" aria-hidden="true">☾</span></button></div>
    </header>
    {summary_html}
    <nav class="toolbar" aria-label="Управление отчётом"><div class="toolbar-actions"><button type="button" id="expand-all">Развернуть все</button><button type="button" id="collapse-all">Свернуть все</button></div></nav>
    {''.join(sections)}
    <footer>Отчёт сформирован {snapshot.generated_at:%d.%m.%Y в %H:%M} МСК (UTC+3) · запуск #{run_number} · неделя {snapshot.period.key} · хранение {retention_weeks} недель</footer>
  </main>
  <script>{interaction_script}</script>
</body>
</html>
"""


def cleanup_old_weekly_reports(reports_dir: Path, retention_weeks: int, now: datetime | None = None) -> list[Path]:
    if retention_weeks <= 0 or not reports_dir.exists():
        return []
    cutoff = (now or datetime.now()).timestamp() - retention_weeks * 7 * 86400
    removed = []
    for path in reports_dir.glob("infrastructure-weekly-*-run-*.html"):
        if path.stat().st_mtime < cutoff:
            path.unlink()
            removed.append(path)
    return removed


def write_weekly_report(snapshot: WeeklySnapshot, run_number: int, reports_dir: Path, portal_url: str, retention_weeks: int = WEEKLY_RETENTION_WEEKS_DEFAULT) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    cleanup_old_weekly_reports(reports_dir, retention_weeks, snapshot.generated_at)
    name = f"infrastructure-weekly-{snapshot.period.iso_year}-W{snapshot.period.iso_week:02d}-run-{run_number}.html"
    path = reports_dir / name
    temporary = reports_dir / f".{name}.tmp"
    temporary.write_text(render_html(snapshot, run_number, portal_url, retention_weeks), encoding="utf-8")
    temporary.replace(path)
    write_reports_manifest(reports_dir)
    return path
