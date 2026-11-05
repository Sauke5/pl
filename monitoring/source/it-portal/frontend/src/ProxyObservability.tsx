import { useQuery } from "@tanstack/react-query";
import { api, date } from "./api";
import { Badge, Panel } from "./components/common";

export type Automation = {
  gating_path: string;
  observed_at: string;
  failed_cycles: Record<string, { current: number; threshold: number }>;
  edge_return: {
    enabled: boolean;
    healthy_since: string | null;
    elapsed_seconds: number | null;
    required_seconds: number;
    remaining_seconds: number | null;
  };
  last_decision: {
    at: string;
    reason: string;
    selected_path: string | null;
  } | null;
};
const reasons: Record<string, string> = {
  primary_healthy: "Основной путь доступен",
  waiting_failure_threshold: "Ожидание порога отказов",
  emergency_selected: "Выбран резервный путь",
  emergency_retained: "Сохранён резервный путь",
  waiting_edge_hold_down: "Ожидание непрерывной готовности Edge",
  edge_restored: "Возврат на Edge",
  no_healthy_path: "Нет доступного пути",
};
export function ProxyAutomation({
  mode,
  automation,
  now,
  staleAfter,
  selectedBy,
  current,
}: {
  mode: string;
  current: boolean;
  automation?: Automation | null;
  now: number;
  staleAfter: number;
  selectedBy?: string;
}) {
  const age = automation ? now - Date.parse(automation.observed_at) : Infinity;
  const fresh =
    current &&
    Number.isFinite(age) &&
    age >= -30000 &&
    age <= staleAfter * 1000;
  const snapshot = fresh ? automation : null;
  const returned = snapshot?.edge_return;
  return (
    <details className="proxy-automation">
      <summary>
        Автовозврат на Edge ·{" "}
        {!current
          ? "состояние неизвестно"
          : mode === "auto"
            ? "включён"
            : "выключен вручную"}
      </summary>
      <p className="muted">
        {selectedBy
          ? `Режим выбрал ${selectedBy}`
          : "Кем и когда выбран режим: нет данных"}
      </p>
      <dl>
        <dt>Отказы активного пути</dt>
        <dd>
          {snapshot
            ? `${({ relay: "Edge", final185: "185", final2: "2.26" } as Record<string, string>)[snapshot.gating_path]}: ${snapshot.failed_cycles[snapshot.gating_path].current}/${snapshot.failed_cycles[snapshot.gating_path].threshold}`
            : "Нет данных контроллера"}
        </dd>
        <dt>Непрерывная готовность Edge</dt>
        <dd>
          {mode !== "auto"
            ? "Автовозврат выключен"
            : returned?.enabled && returned.elapsed_seconds != null
              ? `${Math.floor(returned.elapsed_seconds)} из ${Math.ceil(returned.required_seconds)} с${returned.remaining_seconds != null ? ` · осталось ≈ ${Math.ceil(returned.remaining_seconds)} с` : ""}`
              : "Нет данных контроллера"}
        </dd>
        <dt>Последнее решение автоматики</dt>
        <dd>
          {mode === "auto" && snapshot?.last_decision
            ? `${reasons[snapshot.last_decision.reason] ?? snapshot.last_decision.reason} · ${date(snapshot.last_decision.at)}`
            : "Нет данных контроллера"}
        </dd>
      </dl>
      {automation && !fresh && <small>Наблюдение автоматики устарело</small>}
    </details>
  );
}

type Probe = {
  source: string;
  inbound: string;
  state: "healthy" | "unhealthy" | "stale" | "unknown";
  observed_at: string | null;
  last_success: string | null;
  success_ratio: number | null;
  successful_cycles: number;
  observed_cycles: number;
  history_cycles: number;
  failed_stages: string[];
  acceptance_test: boolean;
};
type External = {
  observed_at: string;
  window_seconds: number;
  history_seconds: number;
  stale_after_seconds: number;
  error?: string;
  probes: Probe[];
};
const ports = ["443", "31241", "46926", "17180", "8443", "8081"];
const stageLabels: Record<string, string> = {
  dns: "DNS",
  tcp: "TCP",
  tunnel: "Туннель / TLS",
  https: "HTTPS",
};
export function ProxyExternalPanel({ now }: { now: number }) {
  const query = useQuery({
    queryKey: ["/proxy-control/observability"],
    queryFn: ({ signal }) =>
      api<External>(
        "/proxy-control/observability",
        "GET",
        undefined,
        {},
        AbortSignal.any([signal, AbortSignal.timeout(18000)]),
      ),
    refetchInterval: 30000,
    retry: false,
  });
  const cached = query.data;
  const snapshotAge = cached?.observed_at
    ? (now - Date.parse(cached.observed_at)) / 1000
    : Infinity;
  const sourceError = query.isError || !!cached?.error;
  const retained =
    !!cached &&
    sourceError &&
    snapshotAge >= -30 &&
    snapshotAge <= 180 &&
    cached.probes?.some((probe) => probe.observed_at != null);
  const data = sourceError && !retained ? undefined : cached;
  const render = (source: string, port: string) => {
    const probe = data?.probes?.find(
      (p) => p.source === source && p.inbound === port,
    );
    const resultAge = probe?.observed_at
      ? (now - Date.parse(probe.observed_at)) / 1000
      : null;
    const fetchedAge = data?.observed_at
      ? (now - Date.parse(data.observed_at)) / 1000
      : Infinity;
    const state =
      probe?.state === "unknown" || !probe
        ? "unknown"
        : sourceError ||
            fetchedAge > 90 ||
            resultAge == null ||
            !Number.isFinite(resultAge) ||
            resultAge < -30 ||
            resultAge > (data?.stale_after_seconds ?? 180)
          ? "stale"
          : probe.state;
    const statsVisible = (!sourceError && fetchedAge <= 90) || retained;
    const label = {
      healthy: "Доступен",
      unhealthy: "Недоступен",
      stale: "Данные устарели",
      unknown: "Нет данных",
    }[state];
    return (
      <td key={source}>
        <div className="proxy-external-result">
          <Badge value={state === "unhealthy" ? "error" : state}>{label}</Badge>
          <span title="Уникальные завершённые циклы за 5 минут">
            {statsVisible && probe?.success_ratio != null
              ? `${Math.round(probe.success_ratio * 100)}% · ${probe.successful_cycles}/${probe.observed_cycles}${sourceError ? " · снимок" : ""}`
              : "Нет данных за 5 мин"}
          </span>
          {probe?.acceptance_test && <span className="muted">Приёмка</span>}
        </div>
        <small>
          Последний успех:{" "}
          {probe?.last_success
            ? date(probe.last_success)
            : probe?.history_cycles
              ? "нет за 30 мин"
              : "неизвестен"}{" "}
          · данные{" "}
          {resultAge != null && Number.isFinite(resultAge) && resultAge >= -30
            ? `${Math.max(0, Math.floor(resultAge))} с назад`
            : "неизвестны"}
        </small>
        {state === "unhealthy" && (
          <small className="proxy-probe-failure">
            Этап:{" "}
            {probe?.failed_stages.length
              ? probe.failed_stages.map((s) => stageLabels[s] ?? s).join(" / ")
              : "нет данных"}
          </small>
        )}
      </td>
    );
  };
  return (
    <Panel
      title="Внешние клиенты → VLESS Edge"
      className="proxy-external-panel"
    >
      <p className="muted proxy-observation-caption">
        Xray → VLESS/REALITY → HTTPS. Доля успешных циклов — за 5 минут;
        последний успех — за 30 минут.
      </p>
      {sourceError && (
        <p className="muted" role="status">
          {retained
            ? `Обновление внешних наблюдений недоступно. Показан последний снимок, ${Math.max(0, Math.floor(snapshotAge))} с назад.`
            : "Источник внешних наблюдений недоступен. Доступность входов неизвестна."}
        </p>
      )}
      <div className="proxy-external-table">
        <table>
          <thead>
            <tr>
              <th>Вход</th>
              <th>Внешняя точка 185 · NL</th>
              <th>Внешняя точка 2.26 · FI</th>
            </tr>
          </thead>
          <tbody>
            {ports.map((port) => (
              <tr key={port}>
                <th scope="row">{port}</th>
                {render("external185", port)}
                {render("external2", port)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="muted">
        Проверки с двух действующих Final. Туннель / TLS не отделяет отказ
        REALITY от downstream TLS.
      </small>
    </Panel>
  );
}
