import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined, Plus, RefreshCw, X } from "lucide-react";
import { api, APIError, date, queryClient, useAPI } from "./api";
import type { Integration } from "./types";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Empty, ErrorBox, Field, Panel } from "./components/common";
import { TimeSeriesChart, type ChartData } from "./TimeSeriesChart";
import { ru } from "./ru";
export type ChartRange = "1h" | "6h" | "24h" | "7d";
export type ChartSelection = {
  id: string;
  integration_id: string;
  dashboard_uid: string;
  panel_id: number;
  range: ChartRange;
};
type ChartSettings = { revision: number; charts: ChartSelection[] };
type Dashboards = {
  dashboards: { uid: string; title: string }[];
  truncated: boolean;
  observed_at: string;
};
type Panels = {
  dashboard_uid: string;
  title: string;
  panels: {
    id: number;
    title: string;
    type: string;
    supported: boolean;
    reason?: string;
    unit?: string;
  }[];
  observed_at: string;
};
const ranges: Record<ChartRange, { label: string; ms: number }> = {
  "1h": { label: ru.chart_hour, ms: 3600000 },
  "6h": { label: ru.chart_six_hours, ms: 21600000 },
  "24h": { label: ru.chart_day, ms: 86400000 },
  "7d": { label: ru.chart_week, ms: 604800000 },
};
export function GrafanaCharts({ timezone }: { timezone: string }) {
  const settings = useAPI<ChartSettings>("/chart-settings");
  const integrations = useAPI<Integration[]>("/integrations");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const sources =
    integrations.data?.filter(
      (source) => source.kind === "grafana" && source.enabled,
    ) || [];
  async function save(charts: ChartSelection[]) {
    if (!settings.data) throw new Error(ru.chart_settings_unavailable);
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api<ChartSettings>("/chart-settings", "PUT", {
        revision: settings.data.revision,
        charts,
      });
      queryClient.setQueryData(["/chart-settings"], updated);
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSaving(false);
    }
  }
  async function reloadSettings() {
    await settings.refetch();
    setError(undefined);
  }
  return (
    <section className="home-charts" aria-label={ru.charts_title}>
      <div className="section-heading">
        <h2>
          <ChartNoAxesCombined size={20} />
          {ru.charts_title}
        </h2>
        <Button
          size="sm"
          disabled={
            saving || !settings.data || (settings.data?.charts.length || 0) >= 6
          }
          onClick={() => setAdding(true)}
        >
          <Plus size={16} />
          {ru.chart_add}
        </Button>
      </div>
      {!!(settings.error || error) && (
        <ErrorBox
          error={error || settings.error}
          retry={() => void reloadSettings()}
        />
      )}
      {error instanceof APIError && error.status === 409 && (
        <p className="muted">{ru.chart_conflict}</p>
      )}
      {integrations.error && (
        <ErrorBox
          error={integrations.error}
          retry={() => void integrations.refetch()}
        />
      )}
      {settings.data && integrations.data && !settings.data.charts.length && (
        <p className="chart-empty-hint">
          {sources.length ? ru.chart_empty : ru.chart_no_sources}
        </p>
      )}
      <div className="chart-grid">
        {settings.data?.charts.map((selection) => (
          <GrafanaChart
            key={selection.id}
            selection={selection}
            timezone={timezone}
            saving={saving}
            sourceLoading={integrations.isPending}
            source={integrations.data?.find(
              (source) => source.id === selection.integration_id,
            )}
            onRange={(range) =>
              save(
                settings.data!.charts.map((chart) =>
                  chart.id === selection.id ? { ...chart, range } : chart,
                ),
              ).catch(() => {})
            }
            onRemove={() =>
              save(
                settings.data!.charts.filter(
                  (chart) => chart.id !== selection.id,
                ),
              ).catch(() => {})
            }
          />
        ))}
      </div>
      {adding && (
        <ChartPicker
          sources={sources}
          onClose={() => setAdding(false)}
          onAdd={async (selection) => {
            await save([...(settings.data?.charts || []), selection]);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}
function ChartPicker({
  sources,
  onAdd,
  onClose,
}: {
  sources: Integration[];
  onAdd: (selection: ChartSelection) => Promise<void>;
  onClose: () => void;
}) {
  const [source, setSource] = useState(sources[0]?.id || "");
  const [dashboard, setDashboard] = useState("");
  const [panel, setPanel] = useState("");
  const [range, setRange] = useState<ChartRange>("6h");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const dashboards = useAPI<Dashboards>(
    `/integrations/${source}/grafana/dashboards`,
    !!source,
  );
  const panels = useAPI<Panels>(
    `/integrations/${source}/grafana/dashboards/${encodeURIComponent(dashboard)}/panels`,
    !!source && !!dashboard,
  );
  const selected = panels.data?.panels.find(
    (item) => item.id === Number(panel),
  );
  async function add() {
    if (!selected?.supported || !panel) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd({
        id: crypto.randomUUID(),
        integration_id: source,
        dashboard_uid: dashboard,
        panel_id: selected.id,
        range,
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={ru.chart_add} onClose={onClose}>
      <p className="muted">{ru.chart_picker_hint}</p>
      {!sources.length ? (
        <Empty title={ru.chart_no_sources} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Field label={ru.chart_source}>
            <select
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setDashboard("");
                setPanel("");
              }}
              disabled={busy}
            >
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={ru.chart_dashboard}>
            <select
              value={dashboard}
              disabled={busy || dashboards.isPending || !!dashboards.error}
              onChange={(event) => {
                setDashboard(event.target.value);
                setPanel("");
              }}
            >
              <option value="">{ru.chart_choose_dashboard}</option>
              {dashboards.data?.dashboards.map((item) => (
                <option key={item.uid} value={item.uid}>
                  {item.title}
                </option>
              ))}
            </select>
          </Field>
          {dashboards.error && (
            <ErrorBox
              error={dashboards.error}
              retry={() => void dashboards.refetch()}
            />
          )}
          {dashboards.data?.truncated && (
            <p className="notice">{ru.chart_dashboard_truncated}</p>
          )}
          {!!dashboard && (
            <Field label={ru.chart_panel}>
              <select
                value={panel}
                disabled={busy || panels.isPending || !!panels.error}
                onChange={(event) => setPanel(event.target.value)}
              >
                <option value="">{ru.chart_choose_panel}</option>
                {panels.data?.panels.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={!item.supported}
                  >
                    {item.title}
                    {item.supported
                      ? ""
                      : ` — ${item.reason || ru.chart_unsupported}`}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {panels.error && (
            <ErrorBox
              error={panels.error}
              retry={() => void panels.refetch()}
            />
          )}
          {panels.data &&
            !panels.data.panels.some((item) => item.supported) && (
              <p className="notice">{ru.chart_no_supported_panels}</p>
            )}
          <Field label={ru.chart_period}>
            <select
              value={range}
              onChange={(event) => setRange(event.target.value as ChartRange)}
              disabled={busy}
            >
              {Object.entries(ranges).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          {!!error && <ErrorBox error={error} />}
          <div className="dialog-footer">
            <Button
              variant="default"
              type="submit"
              disabled={busy || !selected?.supported}
            >
              {ru.chart_add}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
function GrafanaChart({
  selection,
  timezone,
  source,
  sourceLoading,
  saving,
  onRange,
  onRemove,
}: {
  selection: ChartSelection;
  timezone: string;
  source?: Integration;
  sourceLoading: boolean;
  saving: boolean;
  onRange: (range: ChartRange) => void;
  onRemove: () => void;
}) {
  const data = useQuery<ChartData>({
    queryKey: [
      "grafana-chart",
      selection.integration_id,
      selection.dashboard_uid,
      selection.panel_id,
      selection.range,
    ],
    queryFn: () => {
      const to = new Date();
      return api(
        `/integrations/${selection.integration_id}/grafana/query`,
        "POST",
        {
          dashboard_uid: selection.dashboard_uid,
          panel_id: selection.panel_id,
          from: new Date(
            to.getTime() - ranges[selection.range].ms,
          ).toISOString(),
          to: to.toISOString(),
        },
        {},
        AbortSignal.timeout(20000),
      );
    },
    enabled: !!source?.enabled,
    staleTime: "static",
    retry: false,
    refetchInterval: 60000,
  });
  return (
    <Panel
      className="grafana-chart"
      title={data.data?.title || ru.chart_title}
      icon={<ChartNoAxesCombined size={18} />}
      action={
        <div className="chart-actions">
          <select
            aria-label={ru.chart_period}
            value={selection.range}
            disabled={saving}
            onChange={(event) => onRange(event.target.value as ChartRange)}
          >
            {Object.entries(ranges).map(([value, item]) => (
              <option key={value} value={value}>
                {item.label}
              </option>
            ))}
          </select>
          <Button
            size="icon"
            variant="ghost"
            aria-label={ru.chart_refresh}
            disabled={data.isFetching || !source?.enabled}
            onClick={() => void data.refetch()}
          >
            <RefreshCw size={15} className={data.isFetching ? "spin" : ""} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={ru.chart_remove}
            disabled={saving}
            onClick={onRemove}
          >
            <X size={16} />
          </Button>
        </div>
      }
    >
      {!sourceLoading && !source?.enabled && (
        <p className="notice">{ru.chart_source_disabled}</p>
      )}
      {data.error && <ErrorBox error={data.error} />}
      {data.error && data.data && (
        <p className="notice">
          {ru.chart_previous_data} {date(data.data.observed_at)}
        </p>
      )}
      {!data.data && data.isFetching && (
        <div className="chart-loading" role="status">
          {ru.chart_loading}
        </div>
      )}
      {data.data && <TimeSeriesChart data={data.data} timezone={timezone} />}
      {data.data && (
        <div className="chart-source-caption">
          <span>{source?.name || ru.chart_source}</span>
          <span>
            {ru.chart_observed}: {date(data.data.observed_at)}
          </span>
        </div>
      )}
    </Panel>
  );
}
