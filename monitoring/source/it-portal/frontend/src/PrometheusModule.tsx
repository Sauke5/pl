import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Info,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react";
import "./prometheus-monitor-layout.css";
import { api, date } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";

type Instance = {
  id: string;
  name: string;
  mode: string;
  desired_state: string;
  error?: string;
};
type RecordValue = Record<string, unknown>;
type ResultRow = { metric: string; time: string; value: string };
const ROW_LIMIT = 200;
const LABEL_LIMIT = 16;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown, limit = 500) =>
  typeof value === "string" ? value.slice(0, limit) : "—";
const targetOrder = new Intl.Collator("ru", { numeric: true });
function targetRows(values: unknown[]) {
  return values
    .map((value) => {
      const target = record(value);
      const targetLabels = record(target.labels);
      const job = text(targetLabels.job, 256);
      const address = text(targetLabels.instance, 256);
      const url = text(target.scrapeUrl, 2048);
      const identity = JSON.stringify([
        target.scrapePool,
        target.scrapeUrl,
        Object.keys(targetLabels)
          .sort()
          .map((name) => [name, targetLabels[name]]),
      ]);
      return { target, job, address, url, identity };
    })
    .sort(
      (a, b) =>
        targetOrder.compare(a.job, b.job) ||
        targetOrder.compare(a.address, b.address) ||
        targetOrder.compare(a.url, b.url) ||
        (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0),
    );
}
function timestamp(value: unknown) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && !String(value).startsWith("0001-")
    ? date(String(value))
    : "—";
}
function scrapeFailureReason(value: string) {
  if (/connection refused/i.test(value)) return "Соединение отклонено";
  if (/timeout|deadline exceeded|timed out/i.test(value))
    return "Превышено время ожидания";
  if (/no such host|name resolution|server misbehaving/i.test(value))
    return "Не удалось разрешить имя сервера";
  if (/x509|certificate|tls handshake/i.test(value)) return "Ошибка TLS";
  const http = /(?:HTTP status|status code)\s*(\d{3})/i.exec(value);
  if (http) return `Сервер вернул HTTP ${http[1]}`;
  if (/connection reset|unexpected EOF|broken pipe/i.test(value))
    return "Соединение прервано";
  return "Не удалось собрать метрики";
}
function scrapeHealth(value: unknown) {
  return value === "up"
    ? "Сбор успешен"
    : value === "down"
      ? "Ошибка сбора"
      : "Нет данных о сборе";
}
function labels(value: unknown) {
  const entries = Object.entries(record(value));
  if (!entries.length) return "{}";
  const visible = entries
    .slice(0, LABEL_LIMIT)
    .map(
      ([key, val]) => `${key.slice(0, 128)}=${JSON.stringify(text(val, 256))}`,
    );
  return `{${visible.join(", ")}${entries.length > LABEL_LIMIT ? ", …" : ""}}`;
}
function sample(metric: string, value: unknown): ResultRow {
  const pair = Array.isArray(value) ? value : [];
  const seconds = typeof pair[0] === "number" ? pair[0] : NaN;
  return {
    metric,
    time:
      Number.isFinite(seconds) && Math.abs(seconds) < 8.64e12
        ? date(new Date(seconds * 1000).toISOString())
        : "—",
    value: text(pair[1], 512),
  };
}
function queryRows(payload: RecordValue) {
  const data = record(payload.data);
  const type = text(data.resultType, 40);
  const result = data.result;
  const rows: ResultRow[] = [];
  let total = 0;
  if (type === "scalar" || type === "string") {
    if (!Array.isArray(result))
      throw new Error("Prometheus вернул некорректное значение запроса.");
    rows.push(sample("—", result));
    total = 1;
  } else if (type === "vector" || type === "matrix") {
    if (!Array.isArray(result))
      throw new Error("Prometheus вернул некорректный список результатов.");
    for (const item of result) {
      const series = record(item);
      const samples =
        type === "vector"
          ? [series.value]
          : Array.isArray(series.values)
            ? series.values
            : [];
      total += samples.length;
      if (rows.length >= ROW_LIMIT) continue;
      const metric = labels(series.metric);
      for (const value of samples.slice(0, ROW_LIMIT - rows.length))
        rows.push(sample(metric, value));
    }
  } else
    throw new Error(
      `Тип результата «${type}» пока не поддерживается. Доступны vector, matrix, scalar и string.`,
    );
  return { type, rows, total };
}
async function read(path: string, signal: AbortSignal): Promise<RecordValue> {
  const payload = record(
    await api<unknown>(
      path,
      "GET",
      undefined,
      {},
      AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ),
  );
  if (payload.status !== "success")
    throw new Error(
      text(payload.error, 1000) === "—"
        ? "Prometheus не подтвердил получение данных."
        : text(payload.error, 1000),
    );
  return payload;
}
function ReadError({ error }: { error: unknown }) {
  return (
    <ErrorBox
      error={
        error instanceof DOMException &&
        ["TimeoutError", "AbortError"].includes(error.name)
          ? new Error("Prometheus не ответил вовремя. Повторите запрос.")
          : error
      }
    />
  );
}
function Freshness({
  updated,
  fetching,
  failed,
}: {
  updated: number;
  fetching: boolean;
  failed: boolean;
}) {
  return (
    <p className="module-hint" role="status">
      {fetching
        ? "Получаем данные…"
        : updated
          ? `${failed ? "Сохранённые данные" : "Данные получены"}: ${date(new Date(updated).toISOString())}${Date.now() - updated > 150000 ? " · данные устарели" : ""}`
          : "Данные ещё не получены."}
    </p>
  );
}
export default function PrometheusModule({
  instance,
  embedded = false,
  active = true,
}: {
  instance: Instance;
  embedded?: boolean;
  active?: boolean;
}) {
  const enabled = instance.desired_state === "enabled";
  const base = `/modules/${instance.id}/prometheus/api/v1`;
  const targets = useQuery({
    queryKey: [`${base}/targets?state=active`],
    queryFn: ({ signal }) =>
      read(`${base}/targets?state=active`, signal).then((payload) => {
        const active = record(payload.data).activeTargets;
        if (!Array.isArray(active))
          throw new Error("Prometheus вернул некорректный список целей сбора.");
        return targetRows(active);
      }),
    enabled: enabled && active,
    retry: false,
    refetchInterval: enabled && active ? 30000 : false,
  });
  const [refreshingTargets, setRefreshingTargets] = useState(false);
  async function refreshTargets() {
    setRefreshingTargets(true);
    try {
      await targets.refetch({ cancelRefetch: false });
    } finally {
      setRefreshingTargets(false);
    }
  }
  const [expression, setExpression] = useState("up");
  const [submitted, setSubmitted] = useState<{
    expression: string;
    request: number;
  }>();
  const submittedRequest = useRef<number | undefined>(undefined);
  const query = useQuery({
    queryKey: [`${base}/query`, submitted],
    queryFn: ({ signal }) =>
      read(
        `${base}/query?${new URLSearchParams({ query: submitted!.expression, timeout: "10s", limit: String(ROW_LIMIT) })}`,
        signal,
      ).then((payload) => ({
        ...queryRows(payload),
        warnings: Array.isArray(payload.warnings)
          ? payload.warnings.slice(0, 8).map((warning) => text(warning, 500))
          : [],
      })),
    enabled: false,
    retry: false,
    refetchInterval: false,
  });
  // Disabled query observers ignore global catalog invalidation; each expression
  // executes only after explicit submission instead of rerunning on every job event.
  useEffect(() => {
    if (
      !active ||
      !enabled ||
      !submitted ||
      submittedRequest.current === submitted.request
    )
      return;
    submittedRequest.current = submitted.request;
    void query.refetch();
  }, [active, enabled, submitted, query.refetch]);
  const targetCount = targets.data?.length || 0;
  const upCount =
    targets.data?.filter(({ target }) => target.health === "up").length || 0;
  const downCount =
    targets.data?.filter(({ target }) => target.health === "down").length || 0;
  const unknownCount = targetCount - upCount - downCount;
  // Scrape intervals differ by job. Only the existing snapshot freshness policy
  // is applied here; an old lastScrape alone does not invent a target outage.
  const retainedTargets =
    !!targets.dataUpdatedAt &&
    (!enabled ||
      targets.isError ||
      Date.now() - targets.dataUpdatedAt > 150000);
  const targetAttempt = Math.max(targets.dataUpdatedAt, targets.errorUpdatedAt);
  return (
    <div className="modules-page prometheus-module-page prom-monitor-layout">
      {!embedded && (
        <div className="page-title">
          <div>
            <h1>Мониторинг Prometheus</h1>
            <p>
              {instance.name} ·{" "}
              {instance.mode === "local"
                ? "на хосте Платформы"
                : "внешний экземпляр"}
            </p>
          </div>
          <div className="actions">
            <a
              className="button button-secondary"
              href={`#modules?instance=${instance.id}&view=configuration`}
            >
              <Settings2 size={16} aria-hidden="true" /> Настройки сбора
            </a>
            <a
              className="button button-secondary"
              href={`#modules?instance=${instance.id}`}
            >
              <ArrowLeft size={16} /> К модулю
            </a>
          </div>
        </div>
      )}
      {!enabled && (
        <div className="notice">
          Модуль отключён или удаляется. Получение данных недоступно.
        </div>
      )}
      {instance.error && <ReadError error={new Error(instance.error)} />}
      <Panel
        title="Текущие цели сбора"
        className="prom-targets-card"
        icon={<Activity size={20} />}
        action={
          <Button
            size="sm"
            aria-busy={refreshingTargets}
            disabled={!enabled || refreshingTargets}
            onClick={() => void refreshTargets()}
          >
            <RefreshCw size={15} /> Обновить цели
          </Button>
        }
      >
        <div className="prom-targets-summary">
          {targets.data && (
            <div className="prom-target-counts" aria-label="Сводка целей сбора">
              <span className="prom-count">
                Всего <strong>{targetCount}</strong>
              </span>
              <span
                className="prom-count"
                data-state={retainedTargets ? "retained" : "up"}
              >
                <CheckCircle2 size={16} aria-hidden="true" />
                {retainedTargets ? "Последний успех" : "Сбор успешен"}{" "}
                <strong>{upCount}</strong>
              </span>
              <span
                className="prom-count"
                data-state={retainedTargets ? "retained" : "down"}
              >
                <CircleAlert size={16} aria-hidden="true" />
                {retainedTargets ? "Последняя ошибка" : "Ошибка сбора"}{" "}
                <strong>{downCount}</strong>
              </span>
              {unknownCount > 0 && (
                <span className="prom-count">
                  Нет данных <strong>{unknownCount}</strong>
                </span>
              )}
              {retainedTargets && (
                <span className="prom-count">
                  Требуют обновления <strong>{targetCount}</strong>
                </span>
              )}
            </div>
          )}
          <Freshness
            updated={targets.dataUpdatedAt}
            fetching={targets.isFetching}
            failed={targets.isError || !enabled}
          />
        </div>
        {targets.error && <ReadError error={targets.error} />}
        {targets.data?.length ? (
          <>
            <div className="table-wrap prometheus-table">
              <table>
                <thead>
                  <tr>
                    <th>Цель / job</th>
                    <th>Состояние сбора</th>
                    <th>Последняя попытка</th>
                    <th>Ошибка сбора</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.data.slice(0, ROW_LIMIT).map((row) => {
                    const { target, job, address, url, identity } = row;
                    const scrapeError = text(target.lastError, 1000);
                    const hasError =
                      typeof target.lastError === "string" &&
                      target.lastError.trim() !== "";
                    return (
                      <tr key={identity}>
                        <td>
                          <strong>{address}</strong>
                          <small>{job}</small>
                          <code>{url}</code>
                        </td>
                        <td>
                          <Badge
                            value={
                              retainedTargets
                                ? "unknown"
                                : target.health === "up"
                                  ? "ok"
                                  : target.health === "down"
                                    ? "error"
                                    : "unknown"
                            }
                          >
                            {retainedTargets
                              ? "Состояние требует обновления"
                              : scrapeHealth(target.health)}
                          </Badge>
                          {retainedTargets && (
                            <small className="prom-retained-health">
                              Последний статус: {scrapeHealth(target.health)}
                            </small>
                          )}
                        </td>
                        <td>{timestamp(target.lastScrape)}</td>
                        <td>
                          {hasError ? (
                            <div className="prom-scrape-error">
                              <strong>
                                {scrapeFailureReason(scrapeError)}
                              </strong>
                              <code>{scrapeError}</code>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {targets.data.length > ROW_LIMIT && (
              <p className="notice compact">
                Показаны первые {ROW_LIMIT} целей из {targets.data.length}.
              </p>
            )}
          </>
        ) : targets.isSuccess ? (
          <Empty title="Нет активных целей сбора" />
        ) : null}
        <p className="prom-attempt-note">
          <Info size={17} aria-hidden="true" />
          <span>
            Статус отражает результат последней попытки сбора метрик.
            {targetAttempt > 0 && (
              <>
                {" "}
                Последняя проверка списка:{" "}
                {date(new Date(targetAttempt).toISOString())}.
              </>
            )}
          </span>
        </p>
      </Panel>
      <Panel
        title="Запрос PromQL"
        className="prom-query-card"
        icon={<Search size={20} />}
        action={
          <span className="prom-query-limits">
            Мгновенный запрос · до {ROW_LIMIT} строк · тайм-аут PromQL 10 с
          </span>
        }
      >
        <form
          className="prometheus-query-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (enabled && expression.trim() && !query.isFetching)
              setSubmitted({
                expression: expression.trim(),
                request: Date.now(),
              });
          }}
        >
          <Field
            label="Выражение PromQL"
            hint="Запрос выполняется в выбранном экземпляре Prometheus."
          >
            <textarea
              maxLength={4096}
              rows={3}
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              placeholder="up"
              disabled={!enabled}
              spellCheck={false}
            />
          </Field>
          <Button
            type="submit"
            variant="default"
            disabled={!enabled || !expression.trim() || query.isFetching}
          >
            <Search size={15} />
            {query.isFetching ? "Выполняем…" : "Выполнить запрос"}
          </Button>
        </form>
        {submitted && (
          <Freshness
            updated={query.dataUpdatedAt}
            fetching={query.isFetching}
            failed={query.isError}
          />
        )}
        {query.error && <ReadError error={query.error} />}
        {query.data && (
          <>
            <p className="module-hint">
              Результат: {query.data.type} · строк: {query.data.total}. Метки
              ограничены {LABEL_LIMIT} на ряд.
            </p>
            {query.data.warnings.map((warning, i) => (
              <p className="notice compact" key={i}>
                {warning}
              </p>
            ))}
            {query.data.rows.length ? (
              <div className="table-wrap prometheus-table">
                <table>
                  <thead>
                    <tr>
                      <th>Метрика и метки</th>
                      <th>Время</th>
                      <th>Значение</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((row, i) => (
                      <tr key={i}>
                        <td>
                          <code>{row.metric}</code>
                        </td>
                        <td>{row.time}</td>
                        <td>
                          <code>{row.value}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Запрос выполнен, значений нет" />
            )}
            {query.data.total > ROW_LIMIT && (
              <p className="notice compact">
                Показаны первые {ROW_LIMIT} строк из {query.data.total}.
                Уточните выражение для меньшей выборки.
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
