import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "./api";
import { Badge, ErrorBox, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ProxyRouteDiagram } from "./ProxyRouteDiagram";
import { establishedTCP, formatBytes, trafficRoutes } from "./proxyTelemetry";
import {
  historyRows,
  historyActor,
  type Path,
  type Mode,
  type Switch,
  type ModeEvent,
} from "./proxyHistory";
import {
  ProxyAutomation,
  ProxyExternalPanel,
  type Automation,
} from "./ProxyObservability";
import "./proxy-control.css";

const labels: Record<Mode, string> = {
  auto: "Авто",
  relay: "Edge",
  final185: "185",
  final2: "2.26",
};
type Observation = {
  health: "healthy" | "unhealthy" | "unknown";
  last_checked: string | null;
  last_success: string | null;
  latency_ms: number | null;
  error_code: string | null;
};
type Status = {
  automation?: Automation | null;
  schema_version: 1;
  revision: number;
  mode: Mode;
  active_path: Path | null;
  paths: Record<Path, Observation>;
  observed_at: string | null;
  controller_error: string | null;
  stale_after_seconds: number;
  counters: {
    source: string;
    observed_at: string;
    values: Record<string, number>;
  } | null;
  sockets: { summary: string; source: string; observed_at: string } | null;
  last_switch: Switch | null;
};
const paths: Path[] = ["relay", "final185", "final2"];
const time = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? date(value) : "Нет данных";
const pathLabel = (value: Path | null) =>
  value ? labels[value] : "Не определён";

export default function ProxyControl() {
  const client = useQueryClient();
  const [choice, setChoice] = useState<{
    mode: Mode;
    revision: number;
    key: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const status = useQuery({
    queryKey: ["/proxy-control/status"],
    queryFn: ({ signal }) =>
      api<Status>(
        "/proxy-control/status",
        "GET",
        undefined,
        {},
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      ),
    refetchInterval: 15000,
    retry: false,
  });
  const history = useQuery({
    queryKey: ["/proxy-control/history"],
    queryFn: ({ signal }) =>
      api<{ schema_version: 1; history: (Switch | ModeEvent)[] }>(
        "/proxy-control/history?limit=50",
        "GET",
        undefined,
        {},
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      ),
    refetchInterval: 15000,
    retry: false,
  });
  const change = useMutation({
    mutationFn: (selected: NonNullable<typeof choice>) =>
      api<Status>(
        "/proxy-control/mode",
        "POST",
        {
          mode: selected.mode,
          expected_revision: selected.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
        { "Idempotency-Key": selected.key },
        AbortSignal.timeout(10000),
      ),
    onSuccess: async () => {
      setChoice(null);
      setReason("");
      await client.invalidateQueries({ queryKey: ["/proxy-control/status"] });
      await client.invalidateQueries({ queryKey: ["/proxy-control/history"] });
    },
    onError: () => {
      void status.refetch();
    },
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const data = status.data;
  const events = historyRows(history.data?.history ?? []);
  const selectedMode = history.data?.history.find(
    (item) =>
      "event" in item &&
      item.revision === data?.revision &&
      item.mode === data?.mode,
  );
  const age = data?.observed_at
    ? (now - Date.parse(data.observed_at)) / 1000
    : Infinity;
  const stale = !Number.isFinite(age) || age > (data?.stale_after_seconds ?? 0);
  const usable = data && !stale && !status.isError && !data.controller_error;
  const traffic = trafficRoutes(data?.counters?.values ?? {});
  const established = data?.sockets
    ? establishedTCP(data.sockets.summary)
    : null;
  return (
    <div className="proxy-control">
      <div className="page-heading">
        <div>
          <h1>Прокси офиса</h1>
        </div>
        <Button
          variant="secondary"
          disabled={status.isFetching}
          onClick={() => {
            void status.refetch();
            void history.refetch();
            void client.invalidateQueries({
              queryKey: ["/proxy-control/observability"],
            });
          }}
        >
          Обновить
        </Button>
      </div>
      {status.error && (
        <ErrorBox error={status.error} retry={() => void status.refetch()} />
      )}
      {!data && status.isPending && (
        <Panel title="Состояние контроллера">
          <p className="muted">Загрузка…</p>
        </Panel>
      )}
      {data?.controller_error && (
        <ErrorBox
          error={new Error(`Ошибка контроллера: ${data.controller_error}`)}
        />
      )}
      {data && (
        <>
          <div className="proxy-control-overview">
            <Panel
              title="Управление маршрутом"
              className="proxy-control-panel"
              action={
                <Badge
                  value={status.isError ? "error" : stale ? "stale" : "info"}
                >
                  {status.isError
                    ? "Ошибка обновления"
                    : stale
                      ? "Данные устарели"
                      : "Свежие данные"}
                </Badge>
              }
            >
              <div className="proxy-summary">
                <div>
                  <small>Режим</small>
                  <strong>{labels[data.mode]}</strong>
                </div>
                <div>
                  <small>Активный маршрут</small>
                  <strong>{pathLabel(data.active_path)}</strong>
                </div>
                <div>
                  <small>Наблюдение контроллера</small>
                  <strong>{time(data.observed_at)}</strong>
                </div>
              </div>
              <div
                className="proxy-modes"
                role="group"
                aria-label="Режим маршрутизации"
              >
                {(["auto", ...paths] as Mode[]).map((mode) => (
                  <Button
                    key={mode}
                    aria-pressed={data.mode === mode}
                    variant={data.mode === mode ? "default" : "secondary"}
                    disabled={!usable || change.isPending || data.mode === mode}
                    onClick={() => {
                      change.reset();
                      setReason("");
                      setChoice({
                        mode,
                        revision: data.revision,
                        key: crypto.randomUUID(),
                      });
                    }}
                  >
                    {labels[mode]}
                  </Button>
                ))}
              </div>
              <ProxyAutomation
                current={!!usable}
                mode={data.mode}
                automation={data.automation}
                now={now}
                staleAfter={data.stale_after_seconds}
                selectedBy={
                  selectedMode
                    ? `${historyActor(selectedMode)} · ${time(selectedMode.at)}`
                    : undefined
                }
              />
            </Panel>
            <Panel
              title="Маршрут новых интернет-соединений"
              className="proxy-route-panel"
            >
              <ProxyRouteDiagram
                activePath={data.active_path}
                current={!stale && !status.isError && !data.controller_error}
              />
            </Panel>
          </div>
          <div className="proxy-observation-heading">
            <h2>Офис → интернет</h2>
            <span className="muted">
              HTTPS-проверки контроллера через каждый офисный выход
            </span>
          </div>
          <div className="proxy-paths">
            {paths.map((path) => {
              const p = data.paths[path];
              const pathStale =
                stale ||
                (!!p.last_checked &&
                  now - Date.parse(p.last_checked) >
                    data.stale_after_seconds * 1000);
              const pathUnknown =
                !p.last_checked || status.isError || !!data.controller_error;
              return (
                <Panel
                  key={path}
                  title={labels[path]}
                  action={
                    <Badge
                      value={
                        pathUnknown
                          ? "unknown"
                          : pathStale
                            ? "stale"
                            : p.health === "healthy"
                              ? "healthy"
                              : p.health === "unhealthy"
                                ? "error"
                                : "unknown"
                      }
                    >
                      {pathUnknown
                        ? "Нет данных"
                        : pathStale
                          ? "Данные устарели"
                          : p.health === "healthy"
                            ? "Проверка пройдена"
                            : p.health === "unhealthy"
                              ? "Проверка не пройдена"
                              : "Нет данных"}
                    </Badge>
                  }
                >
                  <dl>
                    <dt>Задержка проверки</dt>
                    <dd>
                      {p.latency_ms == null
                        ? "Нет данных"
                        : `${p.latency_ms} мс`}
                    </dd>
                    <dt>Последняя проверка</dt>
                    <dd>{time(p.last_checked)}</dd>
                    <dt>Последний успех</dt>
                    <dd>{time(p.last_success)}</dd>
                    <dt>Ошибка</dt>
                    <dd>{p.error_code || "—"}</dd>
                  </dl>
                  {data.active_path === path && (
                    <Badge value="info">Активный маршрут</Badge>
                  )}
                </Panel>
              );
            })}
          </div>
          <Panel title="Трафик и подключения" className="proxy-telemetry">
            <div className="proxy-telemetry-layout">
              <div className="proxy-traffic">
                <div className="proxy-traffic-head">
                  <strong>Трафик по маршрутам</strong>
                  <span>Получено</span>
                  <span>Отправлено</span>
                </div>
                {data.counters ? (
                  traffic.map((route) => (
                    <div className="proxy-traffic-row" key={route.tag}>
                      <strong>{route.label}</strong>
                      <span>{formatBytes(route.received)}</span>
                      <span>{formatBytes(route.sent)}</span>
                    </div>
                  ))
                ) : (
                  <p className="muted proxy-telemetry-empty">Нет данных</p>
                )}
              </div>
              <div className="proxy-connection-facts">
                <div>
                  <small>Установленные TCP-соединения</small>
                  <strong>
                    {established == null
                      ? "Нет данных"
                      : established.toLocaleString("ru-RU")}
                  </strong>
                  <small>Весь сервер, не только Xray</small>
                </div>
                <div>
                  <small>Последнее переключение</small>
                  <strong>
                    {data.last_switch
                      ? `${pathLabel(data.last_switch.from)} → ${pathLabel(data.last_switch.to)}`
                      : "Нет данных"}
                  </strong>
                  <small>{time(data.last_switch?.at)}</small>
                </div>
              </div>
            </div>
            <details className="proxy-telemetry-details">
              <summary>Технические подробности</summary>
              <div className="proxy-telemetry-raw">
                <section>
                  <h3>Счётчики Xray</h3>
                  <p className="muted">
                    {data.counters
                      ? `${data.counters.source} · ${time(data.counters.observed_at)}`
                      : "Источник не передал данные"}
                  </p>
                  {data.counters && (
                    <dl className="proxy-counters">
                      {Object.entries(data.counters.values).map(
                        ([name, value]) => (
                          <div key={name}>
                            <dt>{name}</dt>
                            <dd>{value.toLocaleString("ru-RU")} Б</dd>
                          </div>
                        ),
                      )}
                    </dl>
                  )}
                </section>
                <section>
                  <h3>Сводка сокетов хоста</h3>
                  <p className="muted">
                    {data.sockets
                      ? `${data.sockets.source} · ${time(data.sockets.observed_at)}`
                      : "Источник не передал данные"}
                  </p>
                  {data.sockets && (
                    <pre className="proxy-sockets">{data.sockets.summary}</pre>
                  )}
                </section>
              </div>
            </details>
          </Panel>
        </>
      )}
      <ProxyExternalPanel now={now} />
      <Panel title="История переключений">
        {history.error && (
          <ErrorBox
            error={history.error}
            retry={() => void history.refetch()}
          />
        )}
        {history.isPending ? (
          <p className="muted">Загрузка…</p>
        ) : (
          history.data && (
            <>
              {events.length === 0 ? (
                <p className="muted">Переключений пока нет</p>
              ) : (
                <div
                  className="proxy-history"
                  tabIndex={0}
                  role="region"
                  aria-label="История переключений"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Время</th>
                        <th>Маршрут</th>
                        <th>Причина</th>
                        <th>Автор</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((item, index) => (
                        <tr key={`${item.at}-${index}`}>
                          <td>{time(item.at)}</td>
                          <td>
                            {item.path
                              ? `${pathLabel(item.path.from)} → ${pathLabel(item.path.to)}`
                              : `Режим: ${labels[item.mode!]}`}
                            {item.path && item.mode && (
                              <small>Режим: {labels[item.mode]}</small>
                            )}
                          </td>
                          <td>
                            <span
                              className="proxy-history-text"
                              title={item.reason}
                            >
                              {item.reason || "—"}
                            </span>
                          </td>
                          <td>
                            <span
                              className="proxy-history-text"
                              title={item.actor}
                            >
                              {historyActor(item)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )
        )}
      </Panel>
      {choice && (
        <Dialog
          title={`Режим «${labels[choice.mode]}»`}
          description="Новые соединения пойдут по выбранному режиму. Уже установленные соединения сохранят свой маршрут."
          onClose={() => {
            if (!change.isPending) setChoice(null);
          }}
        >
          <p>
            {choice.mode === "auto"
              ? "Контроллер будет выбирать маршрут автоматически по результатам проверок."
              : "Маршрут останется принудительным до ручной смены режима."}
          </p>
          <label className="proxy-reason">
            Причина (необязательно)
            <input
              value={reason}
              maxLength={256}
              disabled={change.isPending || change.isError}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {change.error && (
            <>
              <ErrorBox error={change.error} />
              <p className="muted">
                Закройте подтверждение и проверьте текущее состояние перед новой
                операцией.
              </p>
            </>
          )}
          <div className="dialog-footer">
            <Button
              variant="secondary"
              disabled={change.isPending}
              onClick={() => setChoice(null)}
            >
              Отмена
            </Button>
            <Button
              disabled={
                change.isPending ||
                change.isError ||
                !usable ||
                choice.revision !== data?.revision
              }
              onClick={() => change.mutate(choice)}
            >
              {change.isPending ? "Применение…" : "Подтвердить"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
