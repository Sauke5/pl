import { useEffect, useRef, useState } from "react";
import { api, date } from "./api";
import type { Session } from "./types";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Badge, Empty, ErrorBox, Field, JSONView } from "./components/common";
import "./branch-check.css";

type Target = {
  id: number;
  enabled: boolean;
  name: string;
  host: string;
  execution_type: string;
  probe_mode: string;
};
type Hop = {
  hop_number: number;
  host: string;
  ip: string;
  loss_percent?: number;
  avg_ms?: number;
  worst_ms?: number;
};
type Run = {
  id: number;
  target_id: number;
  kind: string;
  status: string;
  finished_at: string;
  loss_percent?: number;
  avg_latency_ms?: number;
  jitter_ms?: number;
  error_message?: string;
  hops: Hop[];
};

async function wayline<T>(
  path: string,
  signal: AbortSignal,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/wayline/api/v1${path}`, {
    method: csrf ? "POST" : "GET",
    credentials: "same-origin",
    signal,
    headers: csrf
      ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
      : {},
    body: csrf ? JSON.stringify({ kind: "path" }) : undefined,
  });
  if (!response.ok) {
    let message =
      response.status === 401
        ? "Сессия завершилась. Войдите в Платформу."
        : response.status === 403
          ? "Нет доступа к проверкам Wayline."
          : "Wayline не ответил. Проверьте состояние сервиса.";
    try {
      const body = await response.json();
      const detail =
        body.message ||
        (typeof body.error === "object" ? body.error?.message : undefined);
      if (typeof detail === "string") message = detail;
    } catch {
      /* preserve safe fallback */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

const number = (value: number | undefined, unit: string) =>
  value == null || !Number.isFinite(value)
    ? "Нет данных"
    : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} ${unit}`;

export function BranchCheckDialog({ onClose }: { onClose: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [uncertain, setUncertain] = useState(false);
  const [run, setRun] = useState<Run>();
  const [history, setHistory] = useState<Run[]>();
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const executing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    void wayline<{ targets: Target[] }>("/targets", controller.signal)
      .then((data) => {
        if (disposed) return;
        const available = (data.targets || []).filter(
          (target) =>
            target.enabled && Number.isSafeInteger(target.id) && target.id > 0,
        );
        setTargets(available);
        setSelected(available[0] ? String(available[0].id) : "");
      })
      .catch((err) => {
        if (!disposed)
          setError(
            controller.signal.aborted
              ? new Error(
                  "Не удалось получить список направлений за 15 секунд.",
                )
              : err,
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      mounted.current = false;
      clearTimeout(timeout);
      controller.abort();
      request.current?.abort();
    };
  }, []);
  const target = targets.find((item) => String(item.id) === selected);
  async function execute() {
    if (!target || executing.current || uncertain) return;
    executing.current = true;
    setBusy(true);
    setError(undefined);
    setRun(undefined);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 210000);
    let submitted = false;
    try {
      const session = await api<Session>(
        "/session",
        "GET",
        undefined,
        {},
        controller.signal,
      );
      if (!session.csrf_token)
        throw new Error("Сессия завершилась. Войдите в Платформу.");
      submitted = true;
      const result = await wayline<Run>(
        `/targets/${target.id}/checks`,
        controller.signal,
        session.csrf_token,
      );
      if (mounted.current) setRun(result);
    } catch (err) {
      if (!mounted.current) return;
      setError(
        controller.signal.aborted
          ? new Error(
              "Ожидание ответа завершилось. Результат запуска неизвестен.",
            )
          : err,
      );
      if (submitted) setUncertain(true);
    } finally {
      clearTimeout(timeout);
      executing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadHistory() {
    if (!target || executing.current) return;
    executing.current = true;
    setBusy(true);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const data = await wayline<{ checks: Run[] }>(
        `/checks?target_id=${target.id}&limit=5`,
        controller.signal,
      );
      if (mounted.current)
        setHistory((data.checks || []).filter((item) => item.kind === "path"));
    } catch (err) {
      if (mounted.current) setError(err);
    } finally {
      clearTimeout(timeout);
      executing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title="Маршрут и потери (MTR)"
      wide
      onClose={onClose}
      description="Маршрут, потери и задержка через Wayline."
    >
      {loading ? (
        <p className="loading">Загружаем направления…</p>
      ) : (
        <>
          {targets.length > 0 ? (
            <Field label="Направление">
              <select
                value={selected}
                disabled={busy || uncertain}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setRun(undefined);
                  setError(undefined);
                }}
              >
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.host}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            !error && (
              <Empty
                title="Нет доступных направлений"
                detail="Добавьте и включите направления проверки в Wayline."
              />
            )
          )}
          {target && target.probe_mode !== "mtr" && (
            <p className="notice">
              Для этого направления в Wayline настроен режим{" "}
              {target.probe_mode.toUpperCase()}. Будут проверены доступность и
              задержка; маршрут по узлам доступен для направлений с режимом MTR.
            </p>
          )}
          <p className="branch-origin">
            Проверка выполняется из точки наблюдения, настроенной для выбранного
            направления в Wayline. Скорость передачи данных не измеряется.
          </p>
          {!!error && <ErrorBox error={error} />}
          {uncertain && (
            <p className="notice">
              Перед новым запуском посмотрите историю проверок в{" "}
              <a href="/wayline/" target="_blank" rel="noreferrer">
                Wayline
              </a>
              : запрос мог выполниться, даже если ответ не дошёл.
            </p>
          )}
          {uncertain && (
            <div className="branch-history">
              <Button disabled={busy} onClick={() => void loadHistory()}>
                Посмотреть последние проверки
              </Button>
              {history &&
                (history.length ? (
                  <ul>
                    {history.map((item) => (
                      <li key={item.id}>
                        <Button variant="ghost" onClick={() => setRun(item)}>
                          Проверка №{item.id} · {date(item.finished_at)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">
                    Сохранённых проверок маршрута пока нет.
                  </p>
                ))}
            </div>
          )}
          {busy && (
            <p className="notice" role="status">
              {uncertain
                ? "Получаем историю проверок…"
                : "Проверяем маршрут и собираем ответы узлов. Это может занять до трёх минут. Закрытие окна прервёт ожидание; перед повторным запуском проверьте историю Wayline."}
            </p>
          )}
          {run && <BranchResult run={run} />}
          <div className="dialog-footer">
            <Button onClick={onClose}>Закрыть</Button>
            <Button
              disabled={busy || !target || uncertain}
              onClick={() => void execute()}
            >
              {busy
                ? "Проверяем…"
                : run
                  ? "Проверить ещё раз"
                  : "Запустить MTR"}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function BranchResult({ run }: { run: Run }) {
  const states: Record<string, string> = {
    success: "Проверка завершена",
    degraded: "Обнаружены потери",
    failed: "Проверка неуспешна",
  };
  return (
    <section className="branch-result" aria-label="Результат проверки маршрута">
      <div className="simple-row">
        <strong>{states[run.status] || "Состояние неизвестно"}</strong>
        <Badge
          value={
            run.status === "success"
              ? "healthy"
              : run.status === "degraded"
                ? "warning"
                : "failed"
          }
        />
        <small>{date(run.finished_at)}</small>
      </div>
      <dl className="branch-metrics">
        <div>
          <dt>Потери до цели</dt>
          <dd>{number(run.loss_percent, "%")}</dd>
        </div>
        <div>
          <dt>Средняя задержка</dt>
          <dd>{number(run.avg_latency_ms, "мс")}</dd>
        </div>
        <div>
          <dt>Колебание задержки</dt>
          <dd>{number(run.jitter_ms, "мс")}</dd>
        </div>
      </dl>
      {run.error_message && <ErrorBox error={new Error(run.error_message)} />}
      {run.hops?.length ? (
        <>
          <h3>Маршрут до цели</h3>
          <div className="table-wrap">
            <table className="branch-hops">
              <thead>
                <tr>
                  <th>Шаг</th>
                  <th>Узел</th>
                  <th>Потери</th>
                  <th>Средняя задержка</th>
                </tr>
              </thead>
              <tbody>
                {run.hops.map((hop, index) => (
                  <tr key={`${hop.hop_number}-${index}`}>
                    <td>{hop.hop_number}</td>
                    <td>
                      <strong>
                        {hop.host && hop.host !== "???"
                          ? hop.host
                          : hop.ip || "Узел не ответил"}
                      </strong>
                      {hop.ip && hop.ip !== hop.host && <small>{hop.ip}</small>}
                    </td>
                    <td>{number(hop.loss_percent, "%")}</td>
                    <td>{number(hop.avg_ms, "мс")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="branch-origin">
            Отдельный узел может не отвечать на диагностические пакеты. Потери
            на промежуточном шаге сами по себе не означают потери канала —
            сравнивайте с ответом конечной цели.
          </p>
        </>
      ) : (
        <p className="muted">Маршрут не получен.</p>
      )}
      <details className="branch-raw">
        <summary>Технические подробности</summary>
        <JSONView value={run} />
      </details>
    </section>
  );
}
