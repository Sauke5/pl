import { useEffect, useMemo, useRef, useState } from "react";
import { Empty } from "./components/common";
import { ru } from "./ru";
export type ChartSeries = {
  name: string;
  labels: Record<string, string>;
  points: [number, number | null][];
};
export type ChartData = {
  dashboard_uid: string;
  panel_id: number;
  title: string;
  unit?: string;
  from: string;
  to: string;
  series: ChartSeries[];
  observed_at: string;
};
const colors = [
  "var(--chart-series-1, #83c8ff)",
  "var(--chart-series-2, #7fd6b2)",
  "var(--chart-series-3, #e8c27b)",
  "var(--chart-series-4, #c5adf7)",
  "var(--chart-series-5, #f1a3ab)",
  "var(--chart-series-6, #7bdddf)",
  "var(--chart-series-7, #e1a1d4)",
  "var(--chart-series-8, #b6cf84)",
];
export function formatChartValue(value: number, unit = "") {
  if (!Number.isFinite(value)) return "—";
  const format = (n: number) =>
    new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 4 }).format(n);
  if (unit === "percentunit") return `${format(value * 100)}%`;
  if (unit === "percent") return `${format(value)}%`;
  if (["bytes", "decbytes", "Bps"].includes(unit)) {
    const base = unit === "decbytes" ? 1000 : 1024;
    const rank = Math.min(
      4,
      Math.max(0, Math.floor(Math.log(Math.abs(value) || 1) / Math.log(base))),
    );
    return `${format(value / base ** rank)} ${["Б", "КБ", "МБ", "ГБ", "ТБ"][rank]}${unit === "Bps" ? "/с" : ""}`;
  }
  const suffix: Record<string, string> = {
    ms: "мс",
    s: "с",
    seconds: "с",
    bps: "бит/с",
    hertz: "Гц",
    short: "",
    none: "",
  };
  return `${format(value)}${unit && (suffix[unit] ?? unit) ? ` ${suffix[unit] ?? unit}` : ""}`;
}
function closestPoint(points: [number, number | null][], time: number) {
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle][0] < time) low = middle + 1;
    else high = middle;
  }
  if (!points.length) return undefined;
  if (!low) return points[0];
  if (low >= points.length) return points[points.length - 1];
  return time - points[low - 1][0] <= points[low][0] - time
    ? points[low - 1]
    : points[low];
}
export function TimeSeriesChart({
  data,
  timezone,
}: {
  data: ChartData;
  timezone: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [data.series.length > 0]);
  const plotLeft = 64,
    plotRight = width - 14;
  const tickCount = width < 420 ? 3 : 5;
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [cursor, setCursor] = useState<number>();
  const geometry = useMemo(() => {
    const from = Date.parse(data.from),
      to = Date.parse(data.to);
    const series = data.series.slice(0, 60).map((item) => ({
      ...item,
      points: item.points
        .slice(0, 1000)
        .filter(([time]) => Number.isFinite(time) && time >= from && time <= to)
        .sort((a, b) => a[0] - b[0]),
    }));
    const values = series.flatMap((item, index) =>
      hidden.has(index)
        ? []
        : item.points
            .map((point) => point[1])
            .filter(
              (value): value is number =>
                value !== null && Number.isFinite(value),
            ),
    );
    let min = 0,
      max = 1;
    if (values.length) {
      min = values.reduce((a, b) => Math.min(a, b));
      max = values.reduce((a, b) => Math.max(a, b));
    }
    if (min === max) {
      const padding = Math.max(Math.abs(min) * 0.05, 1);
      min -= padding;
      max += padding;
    }
    const x = (time: number) =>
      plotLeft +
      ((time - from) / Math.max(1, to - from)) * (plotRight - plotLeft);
    const y = (value: number) => 218 - ((value - min) / (max - min)) * 194;
    const paths = series.map((item, index) => {
      if (hidden.has(index)) return "";
      let pen = false;
      return item.points
        .map(([time, value]) => {
          if (value === null || !Number.isFinite(value)) {
            pen = false;
            return "";
          }
          const part = `${pen ? "L" : "M"}${x(time).toFixed(1)},${y(value).toFixed(1)}`;
          pen = true;
          return part;
        })
        .join(" ");
    });
    return {
      series,
      paths,
      from,
      to,
      min,
      max,
      x,
      y,
      hasValues: values.length > 0,
      times: [
        ...new Set(series.flatMap((item) => item.points.map(([time]) => time))),
      ].sort((a, b) => a - b),
    };
  }, [data, hidden, plotLeft, plotRight]);
  const time = (value: number, full = false) =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      ...(full || geometry.to - geometry.from > 86400000
        ? ({ day: "2-digit", month: "2-digit" } as const)
        : {}),
    }).format(value);
  if (!data.series.length) return <Empty title={ru.chart_no_data} />;
  return (
    <div className="time-series">
      <div
        ref={plotRef}
        className="chart-plot"
        tabIndex={0}
        role="group"
        aria-label={`${data.title}. ${ru.chart_keyboard}`}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          if (event.key === "Escape") {
            setCursor(undefined);
            return;
          }
          const times = geometry.times;
          if (!times.length) return;
          const index =
            cursor === undefined
              ? times.length - 1
              : Math.max(
                  0,
                  times.findIndex((value) => value >= cursor),
                );
          setCursor(
            times[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? times.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        times.length - 1,
                        index + (event.key === "ArrowLeft" ? -1 : 1),
                      ),
                    )
            ],
          );
        }}
      >
        <svg
          viewBox={`0 0 ${width} 252`}
          role="img"
          aria-label={data.title}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * width;
            setCursor(
              geometry.from +
                Math.max(
                  0,
                  Math.min(1, (x - plotLeft) / (plotRight - plotLeft)),
                ) *
                  (geometry.to - geometry.from),
            );
          }}
          onPointerLeave={() => setCursor(undefined)}
        >
          {Array.from({ length: 5 }, (_, index) => {
            const value =
              geometry.min + ((geometry.max - geometry.min) * index) / 4;
            return (
              <g key={index}>
                <line
                  x1={plotLeft}
                  x2={plotRight}
                  y1={geometry.y(value)}
                  y2={geometry.y(value)}
                  stroke="var(--chart-grid, #b2d0ec18)"
                />
                <text
                  x={plotLeft - 9}
                  y={geometry.y(value) + 4}
                  textAnchor="end"
                >
                  {formatChartValue(value, data.unit)}
                </text>
              </g>
            );
          })}
          {Array.from({ length: tickCount }, (_, index) => {
            const value =
              geometry.from +
              ((geometry.to - geometry.from) * index) / (tickCount - 1);
            return (
              <text
                key={index}
                x={geometry.x(value)}
                y={245}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === tickCount - 1
                      ? "end"
                      : "middle"
                }
              >
                {time(value)}
              </text>
            );
          })}
          {geometry.paths.map(
            (path, index) =>
              path && (
                <path
                  key={index}
                  d={path}
                  fill="none"
                  stroke={colors[index % colors.length]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeDasharray={index >= colors.length ? "6 3" : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              ),
          )}
          {geometry.series.map((series, index) => {
            if (hidden.has(index)) return null;
            return series.points.map(([stamp, value], pointIndex) =>
              value !== null &&
              Number.isFinite(value) &&
              (pointIndex === 0 || series.points[pointIndex - 1][1] === null) &&
              (pointIndex === series.points.length - 1 ||
                series.points[pointIndex + 1][1] === null) ? (
                <circle
                  key={`${index}-${pointIndex}`}
                  cx={geometry.x(stamp)}
                  cy={geometry.y(value)}
                  r={2.5}
                  fill={colors[index % colors.length]}
                />
              ) : null,
            );
          })}
          {cursor !== undefined && (
            <line
              x1={geometry.x(cursor)}
              x2={geometry.x(cursor)}
              y1={20}
              y2={220}
              stroke="var(--chart-cursor, #dceaf87a)"
              strokeDasharray="3 3"
            />
          )}
        </svg>
        {!geometry.hasValues && (
          <span className="chart-no-points">
            {hidden.size ? ru.chart_show_series : ru.chart_no_data}
          </span>
        )}
      </div>
      {cursor !== undefined && (
        <div className="chart-tooltip" aria-live="polite">
          <strong>{time(cursor, true)}</strong>
          <div>
            {geometry.series.map((series, index) => {
              if (hidden.has(index)) return null;
              const point = closestPoint(series.points, cursor);
              return (
                <span key={index}>
                  <i style={{ background: colors[index % colors.length] }} />
                  {series.name || `${ru.chart_series} ${index + 1}`}
                  <b>
                    {point?.[1] == null
                      ? "—"
                      : formatChartValue(point[1], data.unit)}
                  </b>
                </span>
              );
            })}
          </div>
        </div>
      )}
      <div className="chart-legend" aria-label={ru.chart_legend}>
        {geometry.series.map((series, index) => (
          <button
            type="button"
            key={index}
            aria-pressed={!hidden.has(index)}
            title={series.name}
            onClick={() =>
              setHidden((previous) => {
                const next = new Set(previous);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })
            }
          >
            <i style={{ background: colors[index % colors.length] }} />
            <span>{series.name || `${ru.chart_series} ${index + 1}`}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
