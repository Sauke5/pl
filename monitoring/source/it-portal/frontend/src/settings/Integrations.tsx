import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  History,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api, date, queryClient, useAPI } from "../api";
import type { Integration, Job } from "../types";
import {
  Badge,
  Empty,
  ErrorBox,
  ExternalLink,
  JSONView,
} from "../components/common";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { PrometheusOptions } from "../PrometheusOptions";
import {
  IntegrationConfigurationHistory,
  OxidizedBindings,
} from "../ConnectionDetails";
import { useHelpTopic } from "../Help";
import {
  ConflictReview,
  DraftFooter,
  FormField,
  inputProps,
  useDraftRegistration,
  useSettingsDraft,
} from "./Draft";
import { SettingsHistory } from "./History";
import {
  blankIntegration,
  displayValue,
  fieldLabels,
  integrationFields,
  integrationKinds,
  kindLabels,
  same,
  selectFields,
  validateIntegration,
  type ProbeResult,
} from "./model";

function connectionStatus(value: Integration) {
  return value.enabled ? value.status || "unknown" : "disabled";
}
export function Integrations({
  selected,
  focusField,
  onSelect,
  onSaved,
}: {
  selected?: string;
  focusField?: string;
  onSelect: (id?: string) => void;
  onSaved: (id: string) => void;
}) {
  const integrations = useAPI<Integration[]>("/integrations");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<unknown>();
  const [jobError, setJobError] = useState<unknown>();
  const [job, setJob] = useState<Job>();
  const [refreshing, setRefreshing] = useState(false);
  const current = integrations.data?.find((item) => item.id === selected);
  useEffect(() => {
    setEditing(false);
    setHistory(false);
    setRemoving(false);
    setError(undefined);
    setJobError(undefined);
    setJob(undefined);
  }, [selected]);
  const jobID = job?.id,
    jobStatus = job?.status;
  useEffect(() => {
    if (!jobID || !["queued", "running"].includes(jobStatus || "")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Job>(
        "/jobs/" + encodeURIComponent(jobID),
        "GET",
        undefined,
        {},
        controller.signal,
      )
        .then((updated) => {
          setJob(updated);
          if (!["queued", "running"].includes(updated.status)) {
            void queryClient.invalidateQueries({ queryKey: ["/integrations"] });
            void queryClient.invalidateQueries({
              predicate: (query) =>
                typeof query.queryKey[0] === "string" &&
                query.queryKey[0].endsWith("/configuration-history"),
            });
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setJobError(cause);
        });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [jobID, jobStatus, job]);
  async function poll() {
    if (!current || refreshing) return;
    setRefreshing(true);
    setError(undefined);
    setJobError(undefined);
    try {
      setJob(
        await api<Job>(
          "/integrations/" + encodeURIComponent(current.id) + "/refresh",
          "POST",
          {},
        ),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setRefreshing(false);
    }
  }
  async function remove() {
    if (!current || deleting || current.managed_module_id) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api(
        "/settings-workspace/integrations/" + encodeURIComponent(current.id),
        "DELETE",
        undefined,
        { "If-Match": String(current.revision) },
      );
      queryClient.setQueryData<Integration[]>(["/integrations"], (items) =>
        items?.filter((item) => item.id !== current.id),
      );
      void queryClient.invalidateQueries({ queryKey: ["/integrations"] });
      setRemoving(false);
      onSelect(undefined);
    } catch (cause) {
      setError(cause);
    } finally {
      setDeleting(false);
    }
  }
  const visible =
    integrations.data?.filter((item) => {
      if (filter === "enabled" && !item.enabled) return false;
      if (filter === "disabled" && item.enabled) return false;
      if (filter === "error" && (!item.enabled || !item.error)) return false;
      return (item.name + " " + item.kind + " " + item.url)
        .toLocaleLowerCase("ru")
        .includes(query.trim().toLocaleLowerCase("ru"));
    }) || [];
  const running =
    refreshing || (!!job && ["queued", "running"].includes(job.status));
  return (
    <section className="settings-integrations" aria-label="Настройки подключений">
      <header className="settings-section-heading">
        <PlugZap size={22} />
        <div>
          <h2>Подключения</h2>
          <p>Источники данных и состояние подключений</p>
        </div>
        <Button variant="default" onClick={() => onSelect("new")}>
          <Plus size={16} />
          Добавить подключение
        </Button>
      </header>
      <div className="settings-integration-workspace">
        <section className="settings-connections">
          <div className="settings-connections-filters">
            <input
              type="search"
              aria-label="Найти подключение"
              placeholder="Найти подключение"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Состояние подключений"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">Все состояния</option>
              <option value="error">С ошибкой</option>
              <option value="enabled">Включены</option>
              <option value="disabled">Выключены</option>
            </select>
            <span className="muted">
              Подключений: {integrations.data ? visible.length : "—"}
            </span>
          </div>
          <div
            className="settings-connections-scroll"
            role="region"
            aria-label="Подключения"
          >
            {integrations.error ? (
              <ErrorBox
                error={integrations.error}
                retry={() => void integrations.refetch()}
              />
            ) : integrations.isPending ? (
              <p role="status">Загрузка подключений…</p>
            ) : visible.length ? (
              visible.map((item) => (
                <button
                  type="button"
                  className={
                    "settings-connection" +
                    (selected === item.id ? " is-selected" : "")
                  }
                  key={item.id}
                  aria-pressed={selected === item.id}
                  onClick={() => onSelect(item.id)}
                >
                  <div className="settings-connection-title">
                    <strong>{item.name}</strong>
                    <ChevronRight size={15} />
                  </div>
                  <div className="settings-connection-meta">
                    <span>{kindLabels[item.kind] || item.kind}</span>
                    <Badge value={connectionStatus(item)} />
                  </div>
                  <span className="settings-connection-url">
                    {item.url || "Серверный исполнитель"}
                  </span>
                  {item.error && item.enabled && (
                    <span className="settings-connection-error">
                      Ошибка получения данных
                    </span>
                  )}
                </button>
              ))
            ) : (
              <Empty
                title={
                  query || filter !== "all"
                    ? "Подключения не найдены"
                    : "Нет подключённых источников"
                }
                detail={
                  query || filter !== "all"
                    ? "Измените поиск или фильтр."
                    : "Добавьте первый источник данных."
                }
              />
            )}
          </div>
        </section>
        <section
          className="settings-inspector"
          role="region"
          aria-label="Подключение"
          data-settings-inspector
        >
          {selected === "new" ? (
            <IntegrationEditor
              key="new"
              onSaved={(record) => {
                setEditing(false);
                onSaved(record.id);
              }}
              onCancel={() => onSelect(undefined)}
            />
          ) : current ? (
            editing ? (
              <IntegrationEditor
                key={current.id}
                value={current}
                onSaved={() => setEditing(false)}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <div className="settings-heading settings-inspector-heading">
                  <div>
                    <span
                      className="settings-eyebrow"
                      data-settings-field="kind"
                      tabIndex={-1}
                    >
                      {kindLabels[current.kind] || current.kind}
                    </span>
                    <h2 data-settings-field="name" tabIndex={-1}>
                      {current.name}
                    </h2>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onSelect(undefined)}
                    aria-label="Закрыть подключение"
                  >
                    <X size={18} />
                  </Button>
                </div>
                <div className="settings-inspector-body">
                  <div className="settings-heading">
                    <span data-settings-field="enabled" tabIndex={-1}>
                      <Badge value={connectionStatus(current)} />
                    </span>
                    <Button
                      variant="default"
                      disabled={!!current.managed_module_id}
                      onClick={() => setEditing(true)}
                    >
                      <Pencil size={15} />
                      Изменить
                    </Button>
                  </div>
                  {current.managed_module_id && (
                    <p className="notice compact">
                      Подключение управляется модулем.{" "}
                      <a href="#modules">Открыть модули</a> для настройки,
                      отключения или удаления.
                    </p>
                  )}
                  {current.error && (
                    <div className="error-box" role="alert">
                      {current.error}
                    </div>
                  )}
                  <dl className="settings-facts">
                    <div data-settings-field="url" tabIndex={-1}>
                      <dt>Адрес сервиса</dt>
                      <dd>{current.url || "Серверный исполнитель"}</dd>
                    </div>
                    <div>
                      <dt>Последняя успешная загрузка</dt>
                      <dd>{date(current.last_success)}</dd>
                    </div>
                    <div>
                      <dt>Последняя попытка</dt>
                      <dd>{date(current.last_attempt)}</dd>
                    </div>
                    <div data-settings-field="poll_seconds" tabIndex={-1}>
                      <dt>Обновление данных</dt>
                      <dd>{current.poll_seconds} с</dd>
                    </div>
                    <div data-settings-field="timeout_seconds" tabIndex={-1}>
                      <dt>Ожидание ответа</dt>
                      <dd>{current.timeout_seconds} с</dd>
                    </div>
                    <div data-settings-field="concurrency" tabIndex={-1}>
                      <dt>Одновременные запросы</dt>
                      <dd>{current.concurrency}</dd>
                    </div>
                  </dl>
                  {current.config?.public_url && (
                    <ExternalLink url={current.config.public_url}>
                      Открыть {kindLabels[current.kind] || current.kind}
                    </ExternalLink>
                  )}
                  <div className="actions settings-inspector-actions">
                    <Button
                      disabled={!current.enabled || running}
                      onClick={() => void poll()}
                    >
                      <RefreshCw
                        size={15}
                        className={running ? "settings-spinning" : ""}
                      />
                      {running ? "Получение данных…" : "Получить данные"}
                    </Button>
                    <Button onClick={() => setHistory((open) => !open)}>
                      <History size={15} />
                      История
                    </Button>
                  </div>
                  {job && (
                    <p
                      role="status"
                      className={
                        job.status === "failed"
                          ? "settings-field-error"
                          : "muted"
                      }
                    >
                      {job.status === "succeeded"
                        ? "Данные обновлены"
                        : job.status === "failed"
                          ? "Не удалось получить данные"
                          : job.status === "unknown"
                            ? "Результат обновления уточняется"
                            : "Задание выполняется"}
                    </p>
                  )}
                  {!!jobError && (
                    <ErrorBox
                      error={jobError}
                      retry={() => {
                        setJobError(undefined);
                        setJob((previous) =>
                          previous ? { ...previous } : previous,
                        );
                      }}
                    />
                  )}
                  {!!error && <ErrorBox error={error} />}
                  {current.kind === "oxidized" && (
                    <IntegrationConfigurationHistory
                      integrationID={current.id}
                    />
                  )}
                  <details
                    className="settings-technical"
                    open={
                      focusField?.startsWith("config.") ||
                      focusField === "secret_ref"
                    }
                  >
                    <summary>Технические подробности</summary>
                    <dl className="settings-facts">
                      <div data-settings-field="secret_ref" tabIndex={-1}>
                        <dt>Ссылка на учётные данные</dt>
                        <dd>{current.secret_ref || "Не задана"}</dd>
                      </div>
                      {Object.entries(current.config || {}).map(
                        ([key, entry]) => (
                          <div
                            key={key}
                            data-settings-field={"config." + key}
                            tabIndex={-1}
                          >
                            <dt>{fieldLabels["config." + key] || key}</dt>
                            <dd>{displayValue(entry)}</dd>
                          </div>
                        ),
                      )}
                    </dl>
                    <JSONView
                      value={{
                        id: current.id,
                        revision: current.revision,
                        capabilities: current.capabilities,
                      }}
                    />
                  </details>
                  {history && (
                    <SettingsHistory
                      key={current.id}
                      target={{ kind: "integration", id: current.id }}
                      onClose={() => setHistory(false)}
                    />
                  )}
                  <div
                    className="settings-danger-zone"
                    hidden={!!current.managed_module_id}
                  >
                    <Button variant="ghost" onClick={() => setRemoving(true)}>
                      <Trash2 size={15} />
                      Удалить подключение
                    </Button>
                  </div>
                </div>
              </>
            )
          ) : selected && integrations.data ? (
            <Empty
              title="Подключение недоступно"
              detail="Оно могло быть удалено другим администратором."
            />
          ) : (
            <Empty
              title="Выберите подключение"
              detail="Справа появятся состояние, действующие параметры и история."
            />
          )}
        </section>
      </div>
      {removing && current && (
        <Dialog
          title="Удалить подключение?"
          onClose={() => !deleting && setRemoving(false)}
        >
          <p>Новые данные из «{current.name}» перестанут поступать.</p>
          {!!error && <ErrorBox error={error} />}
          <div className="dialog-footer">
            <Button disabled={deleting} onClick={() => setRemoving(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void remove()}
            >
              Удалить подключение
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
function IntegrationEditor({
  value,
  onSaved,
  onCancel,
}: {
  value?: Integration;
  onSaved: (record: Integration) => void;
  onCancel: () => void;
}) {
  useHelpTopic("integration-editor", 2);
  const [initial] = useState(blankIntegration);
  const [history, setHistory] = useState(false);
  const [probe, setProbe] = useState<{
    result: ProbeResult;
    params: unknown;
  }>();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<unknown>();
  const savedRecord = useRef<Integration | undefined>(undefined);
  const probeController = useRef<AbortController | undefined>(undefined);
  const probeGeneration = useRef(0);
  useEffect(
    () => () => {
      probeController.current?.abort();
      probeGeneration.current++;
    },
    [],
  );
  const state = useSettingsDraft({
    value: value || initial,
    fields: integrationFields,
    validate: validateIntegration,
    mutate: async (draft) => {
      const path =
        "/settings-workspace/integrations" +
        (value ? "/" + encodeURIComponent(value.id) : "");
      const updated = await api<Integration>(
        path,
        value ? "PUT" : "POST",
        draft,
      );
      savedRecord.current = updated;
      queryClient.setQueryData<Integration[]>(["/integrations"], (items) => {
        const existing = items || [];
        return existing.some((item) => item.id === updated.id)
          ? existing.map((item) => (item.id === updated.id ? updated : item))
          : [...existing, updated];
      });
      void queryClient.invalidateQueries({ queryKey: ["/integrations"] });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].endsWith("/configuration-history"),
      });
      return updated;
    },
    load: async () => {
      const records = await api<Integration[]>("/integrations");
      queryClient.setQueryData(["/integrations"], records);
      const record = records.find((item) => item.id === value?.id);
      if (!record)
        throw new Error("Подключение удалено другим администратором.");
      return record;
    },
  });
  const draft = state.draft;
  function set<K extends keyof Integration>(key: K, entry: Integration[K]) {
    state.change({ ...draft, [key]: entry });
  }
  function config(key: string, entry: string) {
    const next = { ...draft.config };
    if (entry) next[key] = entry;
    else delete next[key];
    set("config", next);
  }
  async function saveAndClose() {
    const result = await state.save();
    if (result && savedRecord.current) onSaved(savedRecord.current);
    return result;
  }
  useDraftRegistration({ ...state, save: saveAndClose });
  async function check() {
    if (probing) return;
    if (!state.validateDraft()) return;
    probeController.current?.abort();
    const controller = new AbortController();
    probeController.current = controller;
    const generation = ++probeGeneration.current;
    const params = selectFields(draft, integrationFields);
    setProbing(true);
    setProbeError(undefined);
    try {
      const result = await api<ProbeResult>(
        "/settings-workspace/probe",
        "POST",
        draft,
        {},
        controller.signal,
      );
      if (probeGeneration.current === generation) setProbe({ result, params });
    } catch (cause) {
      if (!controller.signal.aborted) setProbeError(cause);
    } finally {
      if (probeGeneration.current === generation) setProbing(false);
    }
  }
  const outdated =
    probe && !same(probe.params, selectFields(draft, integrationFields));
  return (
    <>
      <div className="settings-heading settings-inspector-heading">
        <div>
          <span className="settings-eyebrow">
            {value ? "Редактирование" : "Новое подключение"}
          </span>
          <h2>{value?.name || "Источник данных"}</h2>
        </div>
      </div>
      <div className="settings-inspector-body">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void saveAndClose();
          }}
        >
          <fieldset disabled={state.busy}>
            <div className="settings-form-grid">
              <FormField name="name" label="Название" errors={state.errors}>
                <input
                  {...inputProps("name", state.errors)}
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  autoComplete="off"
                />
              </FormField>
              <FormField
                name="kind"
                label="Тип источника"
                errors={state.errors}
              >
                <select
                  {...inputProps("kind", state.errors)}
                  value={draft.kind}
                  onChange={(e) =>
                    state.change({ ...draft, kind: e.target.value, config: {} })
                  }
                >
                  {integrationKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kindLabels[kind]}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <FormField
              name="url"
              label="Адрес сервиса"
              errors={state.errors}
              hint={
                draft.kind === "fileauditor"
                  ? "Адрес signed gateway v2 с префиксом /audit или /audit-arch."
                  : "Адрес сервиса, из которого PL получает данные. Например, https://metrics.example.ru."
              }
            >
              <input
                {...inputProps("url", state.errors)}
                type="url"
                value={draft.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://source.example.ru"
              />
            </FormField>
            <FormField
              name="secret_ref"
              label="Сохранённые учётные данные"
              errors={state.errors}
              hint={
                draft.kind === "fileauditor"
                  ? "Ссылка на файл ключа signed gateway v2, согласованный при подключении."
                  : "Ссылка на секрет, настроенный на сервере PL: env:PORTAL_SECRET_* или file:имя. Оставьте пустым, если сервис доступен без учётных данных."
              }
            >
              <input
                {...inputProps("secret_ref", state.errors)}
                value={draft.secret_ref}
                onChange={(e) => set("secret_ref", e.target.value)}
                autoComplete="off"
              />
            </FormField>
            <div className="settings-form-grid three">
              {(
                ["poll_seconds", "timeout_seconds", "concurrency"] as const
              ).map((key) => (
                <FormField
                  key={key}
                  name={key}
                  label={fieldLabels[key]}
                  errors={state.errors}
                  hint={
                    key === "poll_seconds"
                      ? "Как часто PL получает свежие данные из этого сервиса."
                      : key === "timeout_seconds"
                        ? "Сколько секунд ждать ответ перед сообщением об ошибке сбора."
                        : "Сколько запросов PL может выполнять к сервису одновременно: от 1 до 4."
                  }
                >
                  <input
                    {...inputProps(key, state.errors)}
                    type="number"
                    min={key === "poll_seconds" ? 10 : 1}
                    max={
                      key === "poll_seconds"
                        ? 86400
                        : key === "timeout_seconds"
                          ? 300
                          : 4
                    }
                    step={1}
                    value={Number.isFinite(draft[key]) ? draft[key] : ""}
                    onChange={(e) =>
                      set(
                        key,
                        e.target.value === "" ? NaN : Number(e.target.value),
                      )
                    }
                  />
                </FormField>
              ))}
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              Подключение включено
            </label>
            {draft.kind === "prometheus" && (
              <section className="settings-form-section">
                <h3>Обнаружение ресурсов</h3>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={draft.config.discovery_enabled !== "false"}
                    onChange={(e) =>
                      config(
                        "discovery_enabled",
                        e.target.checked ? "true" : "false",
                      )
                    }
                  />
                  Предлагать обнаруженные ресурсы
                </label>
                <PrometheusOptions
                  integrationID={
                    value &&
                    value.url === draft.url &&
                    value.kind === draft.kind &&
                    value.secret_ref === draft.secret_ref
                      ? value.id
                      : undefined
                  }
                  config={draft.config}
                  onChange={(next) => set("config", next)}
                />
              </section>
            )}
            {draft.kind === "netbox" && (
              <section className="settings-form-section">
                <h3>Параметры NetBox</h3>
                <FormField
                  name="config.public_url"
                  label="Адрес NetBox для перехода"
                  errors={state.errors}
                >
                  <input
                    {...inputProps("config.public_url", state.errors)}
                    type="url"
                    value={draft.config.public_url || ""}
                    onChange={(e) => config("public_url", e.target.value)}
                  />
                </FormField>
                <details className="settings-technical">
                  <summary>Reverse proxy</summary>
                  <FormField
                    name="config.http_host"
                    label="HTTP Host"
                    hint="Имя виртуального сервера, если отличается от базового URL."
                  >
                    <input
                      id="settings-config.http_host"
                      value={draft.config.http_host || ""}
                      onChange={(e) => config("http_host", e.target.value)}
                    />
                  </FormField>
                </details>
              </section>
            )}
            {draft.kind === "oxidized" && (
              <section className="settings-form-section">
                <h3>История конфигураций</h3>
                <FormField
                  name="config.gitea_repository_url"
                  label="Репозиторий Gitea"
                  errors={state.errors}
                >
                  <input
                    {...inputProps("config.gitea_repository_url", state.errors)}
                    type="url"
                    value={draft.config.gitea_repository_url || ""}
                    placeholder="https://git.example.ru/network/configs"
                    onChange={(e) =>
                      config("gitea_repository_url", e.target.value)
                    }
                  />
                </FormField>
                <FormField
                  name="config.gitea_branch"
                  label="Ветка Gitea"
                  errors={state.errors}
                >
                  <input
                    {...inputProps("config.gitea_branch", state.errors)}
                    value={draft.config.gitea_branch || ""}
                    placeholder="main"
                    onChange={(e) => config("gitea_branch", e.target.value)}
                  />
                </FormField>
                <FormField
                  name="config.node_bindings"
                  label="Соответствия устройств"
                  errors={state.errors}
                >
                  <OxidizedBindings
                    integration={
                      value &&
                      value.kind === draft.kind &&
                      value.url === draft.url &&
                      value.secret_ref === draft.secret_ref
                        ? value
                        : undefined
                    }
                    config={draft.config}
                    onChange={config}
                  />
                </FormField>
              </section>
            )}
            {draft.kind === "wayline" && (
              <section className="settings-form-section">
                <h3>Параметры Wayline</h3>
                <FormField
                  name="config.public_url"
                  label="Публичный адрес Wayline"
                  errors={state.errors}
                >
                  <input
                    {...inputProps("config.public_url", state.errors)}
                    type="url"
                    value={draft.config.public_url || ""}
                    onChange={(e) => config("public_url", e.target.value)}
                  />
                </FormField>
                <FormField
                  name="config.basic_username"
                  label="Пользователь Basic Auth"
                  errors={state.errors}
                >
                  <input
                    {...inputProps("config.basic_username", state.errors)}
                    value={draft.config.basic_username || ""}
                    onChange={(e) => config("basic_username", e.target.value)}
                    autoComplete="off"
                  />
                </FormField>
                <FormField
                  name="config.stale_after_seconds"
                  label="Порог устаревания Wayline, с"
                  errors={state.errors}
                  hint="Если не задан: три интервала для доступности, не меньше 5 минут; сутки для скорости."
                >
                  <input
                    {...inputProps("config.stale_after_seconds", state.errors)}
                    type="number"
                    min={30}
                    max={86400}
                    value={draft.config.stale_after_seconds || ""}
                    onChange={(e) =>
                      config("stale_after_seconds", e.target.value)
                    }
                  />
                </FormField>
              </section>
            )}
            {draft.kind === "reports" && (
              <FormField
                name="config.reports_base_url"
                label="Публичный адрес отчётов"
                errors={state.errors}
              >
                <input
                  {...inputProps("config.reports_base_url", state.errors)}
                  type="url"
                  value={draft.config.reports_base_url || ""}
                  onChange={(e) => config("reports_base_url", e.target.value)}
                />
              </FormField>
            )}
          </fieldset>
          <section className="settings-probe" aria-label="Проверка подключения">
            <Button
              disabled={probing || state.busy}
              onClick={() => void check()}
            >
              <PlugZap size={15} />
              {probing ? "Проверка…" : "Проверить подключение"}
            </Button>
            {probe && (
              <div
                className={
                  "settings-probe-result" +
                  (outdated
                    ? " is-outdated"
                    : probe.result.status === "connected"
                      ? " is-success"
                      : "")
                }
                role="status"
              >
                {outdated ? (
                  <>
                    <span>Параметры изменены — проверку нужно повторить.</span>
                  </>
                ) : (
                  <>
                    {probe.result.status === "connected" && (
                      <CheckCircle2 size={17} />
                    )}
                    <span>
                      {probe.result.message}
                      <small>
                        {date(probe.result.checked_at)} ·{" "}
                        {probe.result.duration_ms} мс
                      </small>
                    </span>
                  </>
                )}
              </div>
            )}
            {!!probeError && <ErrorBox error={probeError} />}
          </section>
          {state.conflict && (
            <ConflictReview key={state.conflict.revision} state={state} />
          )}
          <DraftFooter
            {...state}
            save={() => void saveAndClose()}
            conflict={!!state.conflict}
            history={value ? () => setHistory((open) => !open) : undefined}
          >
            <Button onClick={onCancel} disabled={state.busy || state.dirty}>
              Закрыть форму
            </Button>
          </DraftFooter>
        </form>
        {history && value && (
          <SettingsHistory
            target={{ kind: "integration", id: value.id }}
            onClose={() => setHistory(false)}
          />
        )}
      </div>
    </>
  );
}
