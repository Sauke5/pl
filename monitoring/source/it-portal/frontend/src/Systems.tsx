import { useHelpTopic } from "./Help";
import { SFTPGoSystemSummary } from "./SFTPGoSystemSummary";
import { useState } from "react";
import {
  ArrowRight,
  Layers,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
} from "lucide-react";
import { api, date, queryClient, useAPI } from "./api";
import type { Integration, Resource } from "./types";
import type { ResourceActions } from "./Catalog";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  Badge,
  Empty,
  ErrorBox,
  ExternalLink,
  Field,
} from "./components/common";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { JobResult } from "./Operations";
import { workspaceStateLabels } from "./workspaceTypes";
import type {
  SystemDefinition,
  SystemMetricBinding,
  SystemMetricResult,
  SystemProfiles,
  SystemSnapshot,
  WorkspacePreferences,
} from "./workspaceTypes";
import "./workspace.css";

const emptyWorkspace: WorkspacePreferences = {
  revision: 0,
  system_ids: [],
  groups: [],
};

export async function saveWorkspacePreferences(value: WorkspacePreferences) {
  const result = await api<WorkspacePreferences>(
    "/workspace-preferences",
    "PUT",
    value,
  );
  queryClient.setQueryData(["/workspace-preferences"], result);
  return result;
}

export function metricValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  const number = (n: number) =>
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
  if (unit === "timestamp")
    return value > 0
      ? date(new Date(value * 1000).toISOString())
      : "Успех не зарегистрирован";
  if (unit === "state")
    return value === 1 ? "Успешно" : value === 0 ? "Ошибка" : number(value);
  if (unit === "bytes") {
    const index = Math.max(
      0,
      Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10)),
    );
    return `${number(value / 1024 ** index)} ${["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"][index]}`;
  }
  if (unit === "seconds")
    return value < 1 ? `${number(value * 1000)} мс` : `${number(value)} с`;
  if (unit === "enum") return "";
  return `${number(value)}${unit === "%" ? "%" : ""}`;
}

function sampleLabel(labels: Record<string, string>, unit: string) {
  const preferred = [
    "job_name",
    "repository_name",
    "database",
    "name",
    "instance",
    "device",
    "site",
    "inbound",
    "volume",
    "mountpoint",
    "stage",
  ];
  const values = preferred.flatMap((key) => (labels[key] ? [labels[key]] : []));
  if (unit === "enum")
    values.push(labels.result || labels.status || "Состояние получено");
  return [...new Set(values)].join(" · ") || "Выбранный объект";
}

export function MetricResult({
  metric,
  compact = false,
}: {
  metric: SystemMetricResult;
  compact?: boolean;
}) {
  const available = metric.state === "fresh" || metric.state === "stale";
  const samples = compact ? metric.samples.slice(0, 1) : metric.samples;
  return (
    <section className="workspace-metric" data-state={metric.state}>
      <h4>{metric.title}</h4>
      {!available || !samples.length ? (
        <p className="muted">
          {metric.state === "unconfigured"
            ? "Показатель не подключён"
            : workspaceStateLabels[metric.state] || "Нет данных"}
        </p>
      ) : (
        samples.map((sample, index) => (
          <div
            className={compact ? undefined : "workspace-metric-row"}
            key={index}
          >
            <div>
              <strong>
                {metricValue(sample.value, metric.unit) ||
                  sample.labels.result ||
                  sample.labels.status ||
                  "Получено"}
              </strong>
              <small>{sampleLabel(sample.labels, metric.unit)}</small>
            </div>
            {!compact && <small>{date(sample.observed_at)}</small>}
          </div>
        ))
      )}
      {compact && metric.samples.length > 1 && (
        <small>Ещё объектов: {metric.samples.length - 1}</small>
      )}
      {metric.state === "stale" && (
        <small>Данные устарели · {date(metric.samples[0]?.observed_at)}</small>
      )}
      {metric.error && <p className="text-danger">{metric.error}</p>}
      {!compact && <small>{metric.source || "Источник не выбран"}</small>}
    </section>
  );
}

export function SystemCard({
  system,
  starred,
  onStar,
  onOpen,
  live = true,
}: {
  live?: boolean;
  system: SystemDefinition;
  starred?: boolean;
  onStar?: () => void;
  onOpen: () => void;
}) {
  const snapshot = useAPI<SystemSnapshot>(
    `/systems/${system.id}/snapshot`,
    live,
  );
  const state =
    snapshot.data?.state ||
    (system.planned ? "planned" : live ? "no_data" : "definition");
  return (
    <article className="workspace-system-card">
      <div className="workspace-system-title">
        <button className="workspace-system-open" onClick={onOpen}>
          <h3>{system.name}</h3>
          <small>{system.resource_ids.length} ресурсов</small>
        </button>
        {onStar && (
          <Button
            size="icon"
            variant="ghost"
            disabled={starred === undefined}
            aria-label={`${starred ? "Убрать с главной" : "Добавить на главную"}: ${system.name}`}
            onClick={onStar}
          >
            <Star size={18} className={starred ? "starred" : ""} />
          </Button>
        )}
      </div>
      <div className="workspace-system-state" data-state={state}>
        <Layers size={14} />
        {snapshot.isPending && live
          ? "Получаем состояние…"
          : workspaceStateLabels[state]}
      </div>
      {snapshot.error && (
        <ErrorBox
          error={snapshot.error}
          retry={() => void snapshot.refetch()}
        />
      )}
      {!!snapshot.data?.metrics.length && (
        <div className="workspace-system-metrics">
          {snapshot.data.metrics.slice(0, 2).map((metric) => (
            <MetricResult key={metric.id} metric={metric} compact />
          ))}
        </div>
      )}
      {system.description && (
        <p className="workspace-system-event">{system.description}</p>
      )}
      {snapshot.data?.events[0] && (
        <p className="workspace-system-event">
          {date(snapshot.data.events[0].created_at)} ·{" "}
          {snapshot.data.events[0].title}
        </p>
      )}
      <footer className="workspace-system-footer">
        <small>
          {snapshot.data?.coverage?.length
            ? `${snapshot.data.coverage.filter((item) => item.state === "observed" || item.state === "attention").length}/${snapshot.data.coverage.length} ресурсов с данными · `
            : ""}
          {snapshot.data?.metrics.some(
            (metric) => metric.state === "stale" || metric.state === "error",
          )
            ? "Есть устаревшие или недоступные источники"
            : snapshot.data?.metrics.some(
                  (metric) => metric.state === "unconfigured",
                )
              ? "Есть неподключённые показатели"
              : system.planned
                ? "Подключается после развёртывания"
                : !live
                  ? `Показателей: ${system.metrics.length}`
                  : snapshot.data?.metrics[0]?.source ||
                    "Источники не подключены"}
        </small>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Подробнее <ArrowRight size={14} />
        </Button>
      </footer>
    </article>
  );
}

export function SystemDetail({
  system,
  actions,
  onEdit,
  onClose,
}: {
  system: SystemDefinition;
  actions: ResourceActions;
  onEdit: () => void;
  onClose: () => void;
}) {
  const data = useAPI<SystemSnapshot>(`/systems/${system.id}/snapshot`);
  const [operation, setOperation] = useState<string>();
  const selectedOperation = data.data?.operations.find(
    (item) => item.id === operation,
  );
  return (
    <WorkspaceDrawer
      helpTopic="system-details"
      title={system.name}
      subtitle={system.planned ? "Запланированная система" : "Система каталога"}
      onClose={onClose}
    >
      <div className="actions">
        <Badge
          value={
            data.data?.state === "attention"
              ? "warning"
              : data.data?.state === "observed"
                ? "info"
                : "unknown"
          }
        >
          {workspaceStateLabels[data.data?.state || "no_data"]}
        </Badge>
        <Button size="sm" onClick={onEdit}>
          <SlidersHorizontal size={15} />
          Настроить систему
        </Button>
        <Button
          size="sm"
          disabled={data.isFetching}
          onClick={() => void data.refetch()}
        >
          <RefreshCw size={15} />
          Обновить
        </Button>
      </div>
      <p>{system.description}</p>
      {system.profile === "sftp" && !system.planned && (
        <SFTPGoSystemSummary
          hasExternalServiceMetric={system.metrics.some(
            (metric) => metric.metric === "sftp.service",
          )}
        />
      )}
      {data.error && (
        <ErrorBox error={data.error} retry={() => void data.refetch()} />
      )}
      {!!data.data?.missing_resource_ids.length && (
        <p className="notice">
          В составе есть удалённые или архивные ресурсы. Проверь список.
        </p>
      )}
      <section className="workspace-section">
        <h3>Показатели системы</h3>
        <div className="workspace-metric-list">
          {data.data?.metrics.map((metric) => (
            <MetricResult key={metric.id} metric={metric} />
          ))}
        </div>
        {!data.isPending && !data.data?.metrics.length && (
          <p className="muted">
            {system.planned
              ? "Источники подключаются после развёртывания сервиса."
              : "Добавь нужные показатели через «Настроить»."}
          </p>
        )}
      </section>
      <section className="workspace-section">
        <h3>Ресурсы и проверки</h3>
        {data.data?.resources.map((resource) => (
          <div className="simple-row" key={resource.id}>
            <div>
              <strong>{resource.name}</strong>
              <small>{resource.description || resource.hostname}</small>
              <small>
                {
                  workspaceStateLabels[
                    data.data?.coverage?.find(
                      (item) => item.resource_id === resource.id,
                    )?.state || "unconfigured"
                  ]
                }
              </small>
            </div>
            <div className="actions">
              <Button size="sm" onClick={() => actions.onDetails(resource)}>
                Карточка
              </Button>
              <Button
                size="sm"
                onClick={() => actions.onOperation("check", resource)}
              >
                Проверить
              </Button>
              {resource.url && (
                <ExternalLink url={resource.url} className="button button-sm">
                  Открыть
                </ExternalLink>
              )}
            </div>
          </div>
        ))}
        {!system.resource_ids.length && (
          <p className="muted">Ресурсы ещё не выбраны.</p>
        )}
      </section>
      <section className="workspace-section">
        <h3>Связанные неисправности</h3>
        {data.data?.problems
          .filter((problem) => problem.status === "firing")
          .map((problem) => (
            <div className="simple-row" key={problem.id}>
              <div>
                <strong>{problem.title}</strong>
                <small>{problem.description}</small>
              </div>
              <Badge value={problem.stale ? "stale" : problem.severity} />
            </div>
          ))}
        {data.data &&
          !data.data.problems.some(
            (problem) => problem.status === "firing",
          ) && (
            <p className="muted">
              В сохранённых данных нет связанных активных неисправностей.
            </p>
          )}
      </section>
      <section className="workspace-section">
        <h3>Последние изменения</h3>
        {data.data?.events.map((event) => (
          <div className="simple-row" key={event.id}>
            <span>{event.title}</span>
            <small>{date(event.created_at)}</small>
          </div>
        ))}
        {data.data && !data.data.events.length && (
          <p className="muted">Связанных записей в последних событиях нет.</p>
        )}
      </section>
      <section className="workspace-section">
        <h3>Операции команды</h3>
        {data.data?.operations.map((item) => (
          <button
            className="workspace-operation-row"
            key={item.id}
            onClick={() => setOperation(item.id)}
          >
            <ArrowRight size={16} />
            <span>
              {item.kind}
              <small>
                {item.actor_name} · {date(item.created_at)}
              </small>
            </span>
            <Badge value={item.status} />
          </button>
        ))}
        {selectedOperation && <JobResult job={selectedOperation} />}
        {data.data && !data.data.operations.length && (
          <p className="muted">Связанных операций в последних запусках нет.</p>
        )}
      </section>
    </WorkspaceDrawer>
  );
}

const labelNames: Record<string, string> = {
  instance: "Цель (instance)",
  device: "Устройство",
  host: "Хост",
  service: "Сервис",
  site: "Площадка",
  branch: "Филиал",
  source: "Источник проверки",
  inbound: "Вход Proxy",
  volume: "Том",
  mountpoint: "Точка монтирования",
  database: "База",
  repository_name: "Репозиторий",
  job_name: "Задание",
  job: "Группа сбора",
  env: "Среда",
  location: "Локация",
};

function MetricBindingEditor({
  binding,
  sources,
  definitions,
  onChange,
  onRemove,
  resources,
}: {
  binding: SystemMetricBinding;
  resources: Resource[];
  sources: Integration[];
  definitions: SystemProfiles["metrics"];
  onChange: (value: SystemMetricBinding) => void;
  onRemove: () => void;
}) {
  const definition = definitions.find(
    (metric) => metric.key === binding.metric,
  );
  const [lookupLabel, setLookupLabel] = useState(
    Object.keys(binding.labels)[0] || "instance",
  );
  const options = useAPI<{ values: string[] }>(
    `/integrations/${binding.integration_id}/prometheus/options?label=${encodeURIComponent(lookupLabel)}`,
    !!binding.integration_id,
  );
  const listID = `metric-values-${binding.id}`;
  return (
    <section className="workspace-binding">
      <div className="workspace-binding-heading">
        <strong>{definition?.title || binding.metric}</strong>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Убрать показатель: ${definition?.title || binding.metric}`}
          onClick={onRemove}
        >
          <Trash2 size={16} />
        </Button>
      </div>
      <p className="muted">{definition?.description}</p>
      {(!binding.integration_id ||
        !Object.keys(binding.labels).length ||
        Object.values(binding.labels).some((item) => !item.trim())) && (
        <small>
          Не подключён: выберите источник и цель. Можно сохранить и настроить
          позже.
        </small>
      )}
      <Field label="Подпись">
        <input
          value={binding.title}
          maxLength={160}
          placeholder={definition?.title}
          onChange={(event) =>
            onChange({ ...binding, title: event.target.value })
          }
        />
      </Field>
      <Field label="Источник Prometheus">
        <select
          value={binding.integration_id}
          onChange={(event) =>
            onChange({
              ...binding,
              integration_id: event.target.value,
              resource_id:
                binding.resource_id ||
                (resources.length === 1 ? resources[0].id : ""),
            })
          }
        >
          <option value="">Подключить позже</option>
          {sources.map((source) => (
            <option value={source.id} key={source.id}>
              {source.name}
              {source.enabled ? "" : " · выключен"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ресурс, к которому относится показатель">
        <select
          value={binding.resource_id || ""}
          onChange={(event) =>
            onChange({ ...binding, resource_id: event.target.value })
          }
        >
          <option value="">Сводка по системе</option>
          {resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.name}
            </option>
          ))}
        </select>
      </Field>
      {Object.entries(binding.labels).map(([key, value]) => (
        <div className="workspace-label-row" key={key}>
          <select
            aria-label="Условие объекта"
            value={key}
            onFocus={() => setLookupLabel(key)}
            onChange={(event) => {
              const labels = { ...binding.labels };
              delete labels[key];
              labels[event.target.value] = value;
              setLookupLabel(event.target.value);
              onChange({ ...binding, labels });
            }}
          >
            <option value={key}>{labelNames[key] || key}</option>
            {Object.entries(labelNames)
              .filter(([name]) => !(name in binding.labels))
              .map(([name, title]) => (
                <option value={name} key={name}>
                  {title}
                </option>
              ))}
          </select>
          <input
            aria-label={`Значение условия ${key}`}
            value={value}
            list={key === lookupLabel ? listID : undefined}
            placeholder={
              key === "instance" ? "server:9182" : "Значение из источника"
            }
            onFocus={() => setLookupLabel(key)}
            onChange={(event) =>
              onChange({
                ...binding,
                labels: { ...binding.labels, [key]: event.target.value },
              })
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Убрать условие ${key}`}
            onClick={() => {
              const labels = { ...binding.labels };
              delete labels[key];
              onChange({ ...binding, labels });
            }}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <datalist id={listID}>
        {options.data?.values.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <Button
        size="sm"
        disabled={Object.keys(binding.labels).length >= 12}
        onClick={() => {
          const key = Object.keys(labelNames).find(
            (key) => !(key in binding.labels),
          );
          if (key)
            onChange({ ...binding, labels: { ...binding.labels, [key]: "" } });
        }}
      >
        Добавить условие
      </Button>
      {options.error && (
        <p className="muted">
          Не получилось загрузить варианты из источника. Впиши значение вручную
          и нажми «Проверить показатели».
        </p>
      )}
    </section>
  );
}

export function SystemEditor({
  value,
  onClose,
  onSaved,
}: {
  value?: SystemDefinition;
  onClose: () => void;
  onSaved: (value: SystemDefinition) => void;
}) {
  const profiles = useAPI<SystemProfiles>("/system-profiles");
  const resources = useAPI<Resource[]>("/resources?lifecycle=active");
  const integrations = useAPI<Integration[]>("/integrations");
  const [draft, setDraft] = useState<SystemDefinition>(
    () =>
      value || {
        id: "",
        revision: 0,
        name: "",
        description: "",
        profile: "custom",
        planned: false,
        resource_ids: [],
        metrics: [],
      },
  );
  const [query, setQuery] = useState("");
  const [metricToAdd, setMetricToAdd] = useState("");
  const [metricQuery, setMetricQuery] = useState("");
  const [newSource, setNewSource] = useState("");
  const [newInstance, setNewInstance] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SystemMetricResult[]>();
  const sources =
    integrations.data?.filter((source) => source.kind === "prometheus") || [];
  const availableMetrics = profiles.data?.metrics || [];
  const newTargets = useAPI<{ values: string[] }>(
    `/integrations/${newSource}/prometheus/options?label=instance`,
    !!newSource,
  );
  const unconfiguredCount = draft.metrics.filter(
    (metric) =>
      !metric.integration_id ||
      !Object.keys(metric.labels).length ||
      Object.values(metric.labels).some((item) => !item.trim()),
  ).length;
  function addMetrics(keys: string[], allowDuplicate = false) {
    setPreview(undefined);
    setDraft((previous) => ({
      ...previous,
      metrics: [
        ...previous.metrics,
        ...keys
          .filter(
            (key) =>
              allowDuplicate ||
              !previous.metrics.some((metric) => metric.metric === key),
          )
          .map((key): SystemMetricBinding => ({
            id: crypto.randomUUID(),
            metric: key,
            title: "",
            integration_id: newSource,
            labels: newInstance.trim() ? { instance: newInstance.trim() } : {},
          })),
      ].slice(0, 32),
    }));
  }
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<SystemDefinition>(
        value ? `/systems/${value.id}` : "/systems",
        value ? "PUT" : "POST",
        draft,
      );
      await queryClient.invalidateQueries({ queryKey: ["/systems"] });
      await queryClient.invalidateQueries({
        queryKey: [`/systems/${result.id}/snapshot`],
      });
      onSaved(result);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function loadPreview() {
    setBusy(true);
    setError(undefined);
    try {
      setPreview(
        await api<SystemMetricResult[]>("/systems/preview", "POST", draft),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      helpTopic="system-editor"
      title={value ? "Настройка системы" : "Добавить систему"}
      description="Объедините любые приложения и инфраструктуру. Показатели можно добавить сейчас или позже."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Название">
          <input
            required
            maxLength={160}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </Field>
        <Field label="Описание">
          <textarea
            maxLength={4000}
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
          />
        </Field>
        <Field label="Необязательный шаблон">
          <select
            value={draft.profile}
            onChange={(event) =>
              setDraft({ ...draft, profile: event.target.value })
            }
          >
            <option value="custom">Пользовательская система</option>
            {profiles.data?.profiles
              .filter((profile) => profile.key !== "custom")
              .map((profile) => (
                <option key={profile.key} value={profile.key}>
                  {profile.title}
                </option>
              ))}
          </select>
        </Field>
        {draft.profile !== "custom" && (
          <Button
            size="sm"
            disabled={busy || !profiles.data}
            onClick={() =>
              addMetrics(
                profiles.data?.profiles.find(
                  (profile) => profile.key === draft.profile,
                )?.metrics || [],
              )
            }
          >
            Добавить показатели шаблона
          </Button>
        )}
        <p className="muted">
          {draft.profile === "custom"
            ? "Выберите состав системы и нужные показатели из общей библиотеки. Шаблон не требуется."
            : profiles.data?.profiles.find(
                (profile) => profile.key === draft.profile,
              )?.description}
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.planned}
            onChange={(event) =>
              setDraft({ ...draft, planned: event.target.checked })
            }
          />
          Система запланирована; источники подключим после развёртывания
        </label>
        <section className="workspace-section">
          <h3>Состав системы</h3>
          <Field label="Найти ресурс">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Название, адрес или назначение"
            />
          </Field>
          {resources.error && (
            <ErrorBox
              error={resources.error}
              retry={() => void resources.refetch()}
            />
          )}
          <div className="workspace-chooser">
            {resources.data
              ?.filter((resource) =>
                `${resource.name} ${resource.hostname} ${resource.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((resource) => (
                <label key={resource.id}>
                  <input
                    type="checkbox"
                    checked={draft.resource_ids.includes(resource.id)}
                    onChange={(event) => {
                      setPreview(undefined);
                      const checked = event.target.checked;
                      setDraft({
                        ...draft,
                        resource_ids: checked
                          ? [...draft.resource_ids, resource.id]
                          : draft.resource_ids.filter(
                              (id) => id !== resource.id,
                            ),
                        metrics: checked
                          ? draft.metrics
                          : draft.metrics.map((metric) =>
                              metric.resource_id === resource.id
                                ? { ...metric, resource_id: "" }
                                : metric,
                            ),
                      });
                    }}
                  />
                  <span>
                    {resource.name}
                    <small>{resource.description || resource.hostname}</small>
                  </span>
                </label>
              ))}
          </div>
          <p className="muted">Выбрано ресурсов: {draft.resource_ids.length}</p>
        </section>
        <section className="workspace-section">
          <h3>Показатели системы</h3>
          <p className="muted">
            Показатели необязательны. Для сбора выберите источник и цель:
            например, instance сервера или имя базы. У каждого показателя могут
            быть свои условия.
          </p>
          <div className="form-grid">
            <Field label="Источник для новых показателей">
              <select
                value={newSource}
                onChange={(event) => {
                  setNewSource(event.target.value);
                  setNewInstance("");
                }}
              >
                <option value="">Подключить позже</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                    {source.enabled ? "" : " · выключен"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Цель для новых показателей (instance)">
              <input
                value={newInstance}
                list="system-new-metric-targets"
                placeholder="Выберите цель или введите вручную"
                onChange={(event) => setNewInstance(event.target.value)}
              />
              <datalist id="system-new-metric-targets">
                {newTargets.data?.values.map((target) => (
                  <option key={target} value={target} />
                ))}
              </datalist>
            </Field>
          </div>
          {draft.metrics.map((binding) => (
            <MetricBindingEditor
              key={binding.id}
              binding={binding}
              resources={
                resources.data?.filter((resource) =>
                  draft.resource_ids.includes(resource.id),
                ) || []
              }
              sources={sources}
              definitions={availableMetrics}
              onChange={(updated) => {
                setPreview(undefined);
                setDraft({
                  ...draft,
                  metrics: draft.metrics.map((item) =>
                    item.id === binding.id ? updated : item,
                  ),
                });
              }}
              onRemove={() => {
                setPreview(undefined);
                setDraft({
                  ...draft,
                  metrics: draft.metrics.filter(
                    (item) => item.id !== binding.id,
                  ),
                });
              }}
            />
          ))}
          <Field label="Найти показатель">
            <input
              value={metricQuery}
              onChange={(event) => {
                setMetricQuery(event.target.value);
                setMetricToAdd("");
              }}
              placeholder="CPU, память, диск, приложение…"
            />
          </Field>
          <div className="actions">
            <select
              aria-label="Добавить показатель"
              value={metricToAdd}
              onChange={(event) => setMetricToAdd(event.target.value)}
            >
              <option value="">Выбери показатель</option>
              {availableMetrics
                .filter((metric) =>
                  `${metric.title} ${metric.description} ${metric.key}`
                    .toLowerCase()
                    .includes(metricQuery.toLowerCase()),
                )
                .map((metric) => (
                  <option value={metric.key} key={metric.key}>
                    {metric.title}
                  </option>
                ))}
            </select>
            <Button
              disabled={!metricToAdd || draft.metrics.length >= 32}
              onClick={() => {
                addMetrics([metricToAdd], true);
                setMetricToAdd("");
              }}
            >
              <Plus size={15} />
              Добавить
            </Button>
          </div>
          {!draft.metrics.length && (
            <p className="muted">
              Система сохранится с выбранными ресурсами. Показатели можно
              подключить позже.
            </p>
          )}
          {unconfiguredCount > 0 && (
            <p className="muted">
              Не подключено показателей: {unconfiguredCount}. Они сохранятся без
              запуска запросов.
            </p>
          )}
          {newTargets.error && (
            <p className="muted">
              Цели источника недоступны. Можно ввести instance вручную или
              подключить показатель позже.
            </p>
          )}
          {profiles.error && <ErrorBox error={profiles.error} />}
          {integrations.error && <ErrorBox error={integrations.error} />}
        </section>
        <section className="workspace-editor-preview">
          <h3>{draft.name || "Предварительный вид системы"}</h3>
          <p className="muted">
            {draft.resource_ids.length} ресурсов · {draft.metrics.length}{" "}
            показателей
          </p>
          <Button
            disabled={busy || !draft.name.trim()}
            onClick={() => void loadPreview()}
          >
            Проверить показатели
          </Button>
          {preview?.map((metric) => (
            <MetricResult key={metric.id} metric={metric} />
          ))}
        </section>
        {!!error && <ErrorBox error={error} />}
        <div className="dialog-footer">
          <Button onClick={onClose}>Отмена</Button>
          <Button
            type="submit"
            variant="default"
            disabled={busy || !draft.name.trim()}
          >
            {busy ? "Сохраняем…" : "Сохранить систему"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SystemsCatalog({
  actions,
  onView,
}: {
  actions: ResourceActions;
  onView: (view: "applications" | "infrastructure") => void;
}) {
  useHelpTopic("systems", 2);
  const systems = useAPI<SystemDefinition[]>("/systems");
  const preferences = useAPI<WorkspacePreferences>("/workspace-preferences");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SystemDefinition | "new">();
  const [selected, setSelected] = useState<SystemDefinition>();
  const [error, setError] = useState<unknown>();
  const [savingStar, setSavingStar] = useState(false);
  async function star(system: SystemDefinition) {
    if (!preferences.data || savingStar) return;
    setSavingStar(true);
    setError(undefined);
    try {
      const previous = preferences.data;
      await saveWorkspacePreferences({
        ...previous,
        system_ids: previous.system_ids.includes(system.id)
          ? previous.system_ids.filter((id) => id !== system.id)
          : [...previous.system_ids, system.id],
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setSavingStar(false);
    }
  }
  const visible =
    systems.data?.filter((system) =>
      `${system.name} ${system.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  return (
    <>
      <div className="page-title">
        <div>
          <h1>Каталог</h1>
          <p>Общие системы команды · личный выбор для главной</p>
        </div>
        <Button variant="default" onClick={() => setEditing("new")}>
          <Plus size={17} />
          Добавить систему
        </Button>
      </div>
      <div
        className="catalog-view-switch"
        role="group"
        aria-label="Представление каталога"
      >
        <Button variant="ghost" onClick={() => onView("applications")}>
          Приложения
        </Button>
        <Button variant="ghost" onClick={() => onView("infrastructure")}>
          Инфраструктура
        </Button>
        <Button aria-pressed variant="default">
          Системы
        </Button>
      </div>
      <div className="filter-bar">
        <div className="input-icon">
          <Search size={16} />
          <input
            aria-label="Поиск систем"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти систему"
          />
        </div>
      </div>
      {!!(systems.error || preferences.error || error) && (
        <ErrorBox
          error={error || systems.error || preferences.error}
          retry={() => {
            void systems.refetch();
            void preferences.refetch();
          }}
        />
      )}
      {systems.isPending ? (
        <p className="loading">Загружаем системы…</p>
      ) : visible.length ? (
        <div className="workspace-system-grid">
          {visible.map((system) => (
            <SystemCard
              key={system.id}
              system={system}
              live={false}
              starred={
                preferences.data
                  ? preferences.data.system_ids.includes(system.id)
                  : undefined
              }
              onStar={savingStar ? undefined : () => void star(system)}
              onOpen={() => setSelected(system)}
            />
          ))}
        </div>
      ) : (
        <Empty
          title={
            query ? "Систем по этому запросу нет" : "Системы ещё не добавлены"
          }
          detail="Выбери ресурсы и показатели для системы. Звёздочка добавит её на твою главную."
          action={
            <Button onClick={() => setEditing("new")}>Добавить систему</Button>
          }
        />
      )}
      {selected && (
        <SystemDetail
          system={
            systems.data?.find((system) => system.id === selected.id) ||
            selected
          }
          actions={actions}
          onEdit={() => setEditing(selected)}
          onClose={() => setSelected(undefined)}
        />
      )}
      {editing && (
        <SystemEditor
          value={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(system) => {
            setEditing(undefined);
            if (selected) setSelected(system);
          }}
        />
      )}
    </>
  );
}

export function SelectedSystems({
  actions,
  onCatalog,
}: {
  actions: ResourceActions;
  onCatalog: () => void;
}) {
  const systems = useAPI<SystemDefinition[]>("/systems");
  const preferences = useAPI<WorkspacePreferences>("/workspace-preferences");
  const [selected, setSelected] = useState<SystemDefinition>();
  const [editing, setEditing] = useState<SystemDefinition>();
  const chosen = new Set((preferences.data || emptyWorkspace).system_ids);
  return (
    <section aria-label="Контроль выбранных систем">
      <div className="section-heading">
        <h2>
          <Layers size={20} />
          Мои системы
        </h2>
        <Button size="sm" variant="ghost" onClick={onCatalog}>
          <Plus size={15} />
          Выбрать системы
        </Button>
      </div>
      {(systems.error || preferences.error) && (
        <ErrorBox error={systems.error || preferences.error} />
      )}
      <div className="workspace-system-grid">
        {systems.data
          ?.filter((system) => chosen.has(system.id))
          .map((system) => (
            <SystemCard
              key={system.id}
              system={system}
              onOpen={() => setSelected(system)}
            />
          ))}
      </div>
      {preferences.data &&
        systems.data &&
        !systems.data.some((system) => chosen.has(system.id)) && (
          <Empty
            title="Выбери системы для контроля"
            detail="Нажми на звёздочку у системы в каталоге — она появится здесь."
            action={<Button onClick={onCatalog}>Открыть системы</Button>}
          />
        )}
      {selected && (
        <SystemDetail
          system={
            systems.data?.find((system) => system.id === selected.id) ||
            selected
          }
          actions={actions}
          onEdit={() => setEditing(selected)}
          onClose={() => setSelected(undefined)}
        />
      )}
      {editing && (
        <SystemEditor
          value={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(system) => {
            setEditing(undefined);
            setSelected(system);
          }}
        />
      )}
    </section>
  );
}
