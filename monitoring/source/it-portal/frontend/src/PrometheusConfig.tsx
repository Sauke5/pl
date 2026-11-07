import { ActionFeedback } from "./ActionNotifications";
import { registerSettingsGuard } from "./settings/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  FileCode,
  LockKeyhole,
  Pencil,
  Plus,
  Save,
  Settings,
  Trash2,
} from "lucide-react";
import { api, APIError, date } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import type { Job } from "./types";
import "./prometheus-config-layout.css";

type Target = { address: string; labels: Record<string, string> };
type ScrapeJob = {
  name: string;
  enabled: boolean;
  scrape_interval: string;
  scrape_timeout: string;
  metrics_path: string;
  scheme: "http" | "https";
  targets: Target[];
};
type Configuration = {
  revision: number;
  global: { scrape_interval: string; scrape_timeout: string };
  jobs: ScrapeJob[];
};
type ConfigurationState = {
  editable: boolean;
  reason: string;
  draft: Configuration | null;
  applied: Configuration | null;
  last_job_id: string;
  last_error: string;
  rolled_back: boolean;
};
type Validation = { valid: boolean; yaml: string; hash: string };
type Instance = {
  id: string;
  name: string;
  mode: string;
  desired_state: string;
};
const content = (value: Configuration) =>
  JSON.stringify({ ...value, revision: 0 });
const inProgress = (job?: Job) =>
  !!job && ["queued", "running"].includes(job.status);
function jobRevision(job: Job) {
  const configuration = job.parameters?.configuration;
  return configuration &&
    typeof configuration === "object" &&
    "revision" in configuration &&
    typeof configuration.revision === "number"
    ? configuration.revision
    : undefined;
}
const jobStatus: Record<string, string> = {
  queued: "В очереди",
  running: "Применяется",
  succeeded: "Применено",
  failed: "Ошибка",
  canceled: "Отменено",
};

export default function PrometheusConfig({
  instance,
  embedded = false,
}: {
  instance: Instance;
  embedded?: boolean;
}) {
  const base = `/modules/${instance.id}/configuration`;
  const state = useQuery({
    queryKey: [base],
    queryFn: ({ signal }) =>
      api<ConfigurationState>(base, "GET", undefined, {}, signal),
    retry: false,
    refetchInterval: false,
  });
  const [draft, setDraft] = useState<Configuration>();
  const [editor, setEditor] = useState<number | "global">();
  const draftEditor = useRef<HTMLDivElement>(null);
  const [savedContent, setSavedContent] = useState("");
  const [validation, setValidation] = useState<{
    result: Validation;
    content: string;
  }>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"success" | "info">("success");
  const [jobID, setJobID] = useState("");
  const [awaitingRevision, setAwaitingRevision] = useState<number>();
  const [confirmApply, setConfirmApply] = useState(false);
  const [leave, setLeave] = useState("");
  const deferredLeave = useRef<(() => void) | undefined>(undefined);
  const [invalidLabels, setInvalidLabels] = useState<Record<string, boolean>>(
    {},
  );
  const [editorEpoch, setEditorEpoch] = useState(0);
  const requestKey = useRef<{ revision: number; key: string } | undefined>(
    undefined,
  );
  const handledJob = useRef("");
  const trackedJob = useRef<{ id: string; revision?: number } | undefined>(
    undefined,
  );
  const rowKeys = useRef(new WeakMap<object, string>());
  const applied = state.data?.applied;
  const appliedNames = new Set(applied?.jobs.map((item) => item.name));
  const draftJobIndices = new Map(
    draft?.jobs.map((item, index) => [item.name, index]),
  );
  const draftOnlyJobs = (draft?.jobs || [])
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        !appliedNames.has(item.name) ||
        draftJobIndices.get(item.name) !== index,
    );
  const labelsInvalid = Object.values(invalidLabels).some(Boolean);
  const dirty = labelsInvalid || (!!draft && content(draft) !== savedContent);
  const editable =
    state.data?.editable === true &&
    instance.mode === "local" &&
    instance.desired_state !== "removed";
  const job = useQuery({
    queryKey: [`/jobs/${jobID}`],
    queryFn: ({ signal }) =>
      api<Job>(`/jobs/${jobID}`, "GET", undefined, {}, signal),
    enabled: !!jobID,
    retry: false,
    refetchInterval: (query) =>
      !query.state.data || inProgress(query.state.data) ? 2000 : false,
  });
  const applying = inProgress(job.data);
  const locked = !!busy || applying || (!!jobID && !job.data);
  const writable = editable && !locked;
  const unapplied = !!draft && draft.revision !== applied?.revision;
  const showDraft =
    editor !== undefined ||
    dirty ||
    unapplied ||
    !!busy ||
    applying ||
    !!job.error ||
    job.data?.status === "failed" ||
    !!state.data?.last_error ||
    state.data?.rolled_back;
  const valid =
    !labelsInvalid &&
    !!draft &&
    validation?.result.valid === true &&
    validation.content === content(draft);

  useEffect(() => {
    if (state.data?.draft && !draft) {
      setDraft(structuredClone(state.data.draft));
      setSavedContent(content(state.data.draft));
      setJobID(state.data.last_job_id || "");
    }
  }, [state.data, draft]);
  useEffect(() => {
    if (editor !== undefined) draftEditor.current?.focus();
  }, [editor]);
  useEffect(() => {
    if (!job.data || inProgress(job.data) || handledJob.current === job.data.id)
      return;
    handledJob.current = job.data.id;
    if (trackedJob.current?.id === job.data.id) {
      if (job.data.status === "succeeded") {
        setAwaitingRevision(
          jobRevision(job.data) ?? trackedJob.current.revision,
        );
        trackedJob.current = undefined;
        setError(undefined);
        setNoticeKind("success");
        setNotice("Конфигурация Prometheus применена.");
      } else if (job.data.status === "failed") {
        setNotice("");
        setError(
          new Error(
            job.data.error ||
              "Не удалось применить конфигурацию Prometheus. Подробности — в состоянии задания.",
          ),
        );
      } else if (job.data.status === "canceled") {
        trackedJob.current = undefined;
        setNoticeKind("info");
        setNotice(
          "Применение конфигурации Prometheus отменено. Успешное применение не подтверждено.",
        );
      }
    }
    if (["failed", "canceled"].includes(job.data.status))
      requestKey.current = undefined;
    void state.refetch();
  }, [job.data, state.refetch]);
  useEffect(() => {
    if (
      awaitingRevision === undefined ||
      !state.isSuccess ||
      applied?.revision !== awaitingRevision
    )
      return;
    setAwaitingRevision(undefined);
    if (!dirty && draft?.revision === awaitingRevision) {
      setEditor(undefined);
      setValidation(undefined);
    }
  }, [
    awaitingRevision,
    state.isSuccess,
    applied?.revision,
    dirty,
    draft?.revision,
  ]);
  useEffect(() => {
    if (!dirty) return;
    function unload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    function navigate(event: MouseEvent) {
      const anchor = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        anchor.target === "_blank" ||
        anchor.href === location.href
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeave(anchor.href);
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty]);

  useEffect(() => {
    if (!embedded || !dirty) return;
    return registerSettingsGuard((proceed) => {
      deferredLeave.current = proceed;
      setLeave("#pending-shell-navigation");
    });
  }, [embedded, dirty]);

  function change(next: Configuration) {
    setDraft(next);
    setNotice("");
    setError(undefined);
  }
  function addJob() {
    if (!draft) return;
    change({
      ...draft,
      jobs: [
        ...draft.jobs,
        {
          name: "",
          enabled: true,
          scrape_interval: draft.global.scrape_interval,
          scrape_timeout: draft.global.scrape_timeout,
          metrics_path: "/metrics",
          scheme: "http",
          targets: [{ address: "", labels: {} }],
        },
      ],
    });
    setEditor(draft.jobs.length);
  }
  function changeJob(index: number, update: Partial<ScrapeJob>) {
    if (!draft) return;
    change({
      ...draft,
      jobs: draft.jobs.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...update };
        rowKeys.current.set(next, rowKey(item));
        return next;
      }),
    });
  }
  function rowKey(value: object) {
    let key = rowKeys.current.get(value);
    if (!key) {
      key = crypto.randomUUID();
      rowKeys.current.set(value, key);
    }
    return key;
  }
  function changeTarget(
    jobIndex: number,
    targetIndex: number,
    update: Partial<Target>,
  ) {
    if (!draft) return;
    changeJob(jobIndex, {
      targets: draft.jobs[jobIndex].targets.map((target, i) => {
        if (i !== targetIndex) return target;
        const next = { ...target, ...update };
        rowKeys.current.set(next, rowKey(target));
        return next;
      }),
    });
  }
  async function validate() {
    if (!draft) return;
    setBusy("validate");
    setNoticeKind("success");
    setError(undefined);
    setNotice("");
    try {
      const result = await api<Validation>(`${base}/validate`, "POST", {
        configuration: draft,
      });
      setValidation({ result, content: content(draft) });
      setNotice(
        "Конфигурация прошла проверку promtool. Работающий Prometheus не изменён.",
      );
    } catch (failure) {
      setValidation(undefined);
      setError(failure);
    } finally {
      setBusy("");
    }
  }
  async function save() {
    if (!draft) return;
    setBusy("save");
    setNoticeKind("success");
    setError(undefined);
    setNotice("");
    try {
      const result = await api<ConfigurationState>(base, "PUT", {
        configuration: draft,
      });
      if (!result.draft)
        throw new Error("Сервер не вернул сохранённый черновик.");
      setDraft(structuredClone(result.draft));
      setSavedContent(content(result.draft));
      requestKey.current = undefined;
      await state.refetch();
      setNotice("Черновик сохранён. Для изменения сбора нажмите «Применить».");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }
  async function apply() {
    if (!draft) return;
    setConfirmApply(false);
    setBusy("apply");
    setNoticeKind("success");
    setError(undefined);
    setNotice("");
    const key =
      requestKey.current?.revision === draft.revision
        ? requestKey.current.key
        : crypto.randomUUID();
    requestKey.current = { revision: draft.revision, key };
    try {
      const result = await api<{ job: Job }>(`${base}/apply`, "POST", {
        revision: draft.revision,
        idempotency_key: key,
      });
      handledJob.current = "";
      trackedJob.current = { id: result.job.id, revision: draft.revision };
      setAwaitingRevision(undefined);
      setJobID(result.job.id);
    } catch (failure) {
      if (failure instanceof APIError && failure.status < 500)
        requestKey.current = undefined;
      setError(failure);
    } finally {
      setBusy("");
    }
  }
  async function retryApply() {
    if (!job.data || job.data.status !== "failed" || state.data?.rolled_back)
      return;
    setBusy("retry");
    setNoticeKind("success");
    setError(undefined);
    const previousRevision =
      jobRevision(job.data) ??
      (trackedJob.current?.id === job.data.id
        ? trackedJob.current.revision
        : undefined);
    try {
      const result = await api<{ job: Job }>(`${base}/retry`, "POST", {
        job_id: job.data.id,
      });
      handledJob.current = "";
      trackedJob.current = {
        id: result.job.id,
        revision: jobRevision(result.job) ?? previousRevision,
      };
      setAwaitingRevision(undefined);
      await job.refetch();
      await state.refetch();
    } catch (failure) {
      setError(failure);
      void job.refetch();
    } finally {
      setBusy("");
    }
  }
  function reloadDraft() {
    if (!state.data?.draft) return;
    setDraft(structuredClone(state.data.draft));
    setJobID(state.data.last_job_id || "");
    setSavedContent(content(state.data.draft));
    setValidation(undefined);
    setNotice("");
    setError(undefined);
    setInvalidLabels({});
    setEditorEpoch((value) => value + 1);
    setEditor(undefined);
  }

  return (
    <div className="modules-page prometheus-module-page prometheus-config-page">
      {!embedded && (
        <div className="page-title">
          <div>
            <h1>Настройки Prometheus</h1>
            <p>{instance.name} · конфигурация сбора Prometheus</p>
          </div>
          <div className="actions">
            <a
              className="button button-secondary"
              href={`#modules?instance=${instance.id}&view=monitoring`}
            >
              Мониторинг
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
      {state.error && (
        <ErrorBox error={state.error} retry={() => void state.refetch()} />
      )}
      {state.isPending && (
        <p className="muted" role="status">
          Загружаем конфигурацию…
        </p>
      )}
      {state.data && !editable && (
        <div className="notice">
          {state.data.reason || "Конфигурация доступна только для чтения."}{" "}
          {instance.mode === "external" &&
            "HTTP API Prometheus позволяет читать данные, но не записывать его конфигурационный файл. Изменения выполняются на хосте внешнего сервиса."}
        </div>
      )}
      {instance.desired_state !== "enabled" && editable && (
        <div className="notice">
          Модуль отключён. Черновик можно сохранить; для проверки и применения
          включите Prometheus.
        </div>
      )}
      <ActionFeedback notice={notice} error={error} noticeKind={noticeKind} />
      {draft && state.data && instance.mode === "local" && (
        <>
          <Panel
            className="prom-configuration-card"
            title="Действующая конфигурация"
            icon={<Settings size={20} />}
            action={
              applied && (
                <Badge value="ok">Применена версия {applied.revision}</Badge>
              )
            }
          >
            <div className="prom-config-columns">
              <div className="prom-config-sidebar">
                <section className="prom-config-common">
                  <h3>Общие параметры</h3>
                  {applied && (
                    <dl className="prom-applied-settings">
                      <div>
                        <dt>Интервал сбора</dt>
                        <dd>{applied.global.scrape_interval}</dd>
                      </div>
                      <div>
                        <dt>Timeout</dt>
                        <dd>{applied.global.scrape_timeout}</dd>
                      </div>
                    </dl>
                  )}
                  {editable && (
                    <Button
                      size="sm"
                      disabled={!writable}
                      onClick={() => setEditor("global")}
                    >
                      <Pencil size={15} aria-hidden="true" /> Редактировать
                      общие параметры
                    </Button>
                  )}
                </section>
                <section
                  className="prom-config-protected"
                  aria-label="Собственные метрики Prometheus"
                >
                  <div className="prom-protected-heading">
                    <h3>
                      <LockKeyhole size={20} aria-hidden="true" />
                      Метрики Prometheus
                    </h3>
                    <span>Системный job</span>
                  </div>
                  <Field label="Системный job">
                    <input readOnly value="prometheus" />
                  </Field>
                  <Field label="Системный target">
                    <input readOnly value="127.0.0.1:9090" />
                  </Field>
                  <p className="module-hint">
                    Защищённый job собирает метрики самого Prometheus.
                  </p>
                </section>
              </div>
              <section
                className="prom-config-jobs-column"
                aria-label="Применённые задания"
              >
                <div className="prom-config-section-heading">
                  <h3>Задания сбора · {applied?.jobs.length ?? 0}</h3>
                  {editable && (
                    <Button
                      variant="default"
                      disabled={!writable || draft.jobs.length >= 64}
                      onClick={addJob}
                    >
                      <Plus size={16} aria-hidden="true" /> Добавить задание
                    </Button>
                  )}
                </div>
                {applied?.jobs.length ? (
                  <ul className="prom-applied-jobs">
                    {applied.jobs.map((item) => {
                      const index = draftJobIndices.get(item.name);
                      return (
                        <li key={item.name}>
                          <div className="prom-config-section-heading">
                            <div>
                              <strong>{item.name}</strong>{" "}
                              <Badge value={item.enabled ? "ok" : "unknown"}>
                                {item.enabled ? "Включено" : "Отключено"}
                              </Badge>
                            </div>
                            {editable && index !== undefined && (
                              <Button
                                size="sm"
                                disabled={!writable}
                                aria-label={`Редактировать задание ${item.name}`}
                                onClick={() => setEditor(index)}
                              >
                                <Pencil size={15} aria-hidden="true" />{" "}
                                Редактировать
                              </Button>
                            )}
                          </div>
                          <p className="module-hint">
                            {item.scheme.toUpperCase()} {item.metrics_path} ·
                            интервал {item.scrape_interval} · timeout{" "}
                            {item.scrape_timeout}
                          </p>
                          <p className="prom-applied-addresses">
                            {item.targets
                              .map((target) => target.address)
                              .join(", ")}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <Empty title="Дополнительных заданий пока нет" />
                )}
              </section>
            </div>
          </Panel>
          {showDraft && (
            <Panel
              className="prom-configuration-card"
              title={
                editor === "global"
                  ? "Общие параметры черновика"
                  : typeof editor === "number"
                    ? "Настройки задания"
                    : "Черновик конфигурации"
              }
              icon={<Settings size={20} />}
              action={
                <div className="prom-config-status">
                  <Badge value={dirty ? "warning" : "unknown"}>
                    Черновик · версия {draft.revision}
                    {dirty ? " · Есть изменения" : " · Без изменений"}
                  </Badge>
                  {valid && <Badge value="ok">Проверка пройдена</Badge>}
                  {editor !== undefined && (
                    <Button onClick={() => setEditor(undefined)}>
                      К действующей конфигурации
                    </Button>
                  )}
                </div>
              }
            >
              {draftOnlyJobs.length > 0 && (
                <section
                  className="prom-draft-jobs"
                  aria-label="Задания в черновике"
                >
                  <h3>Задания в черновике</h3>
                  <div className="actions">
                    {draftOnlyJobs.map(({ item, index }) => (
                      <Button
                        key={rowKey(item)}
                        size="sm"
                        disabled={!writable}
                        onClick={() => setEditor(index)}
                      >
                        <Pencil size={15} aria-hidden="true" />{" "}
                        {item.name || `Новое задание ${index + 1}`}
                      </Button>
                    ))}
                  </div>
                </section>
              )}
              <div
                ref={draftEditor}
                tabIndex={-1}
                hidden={editor === undefined}
              >
                <section
                  className="prom-config-common"
                  hidden={editor !== "global"}
                >
                  <h3>Общие параметры</h3>
                  <p className="module-hint">Параметры сбора по умолчанию</p>
                  <fieldset className="module-fields" disabled={!writable}>
                    <div className="prom-config-grid">
                      <Field
                        label="Общий интервал сбора"
                        hint="Например: 15s, 1m. От 1s до 24h."
                      >
                        <input
                          value={draft.global.scrape_interval}
                          maxLength={16}
                          onChange={(event) =>
                            change({
                              ...draft,
                              global: {
                                ...draft.global,
                                scrape_interval: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                      <Field
                        label="Общий timeout"
                        hint="Не больше интервала сбора."
                      >
                        <input
                          value={draft.global.scrape_timeout}
                          maxLength={16}
                          onChange={(event) =>
                            change({
                              ...draft,
                              global: {
                                ...draft.global,
                                scrape_timeout: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                    </div>
                  </fieldset>
                </section>
                {draft.jobs.map((item, index) => (
                  <section
                    className="prom-config-job"
                    key={`${editorEpoch}:${rowKey(item)}`}
                    aria-label={`Job ${index + 1}`}
                    hidden={editor !== index}
                  >
                    <div className="module-instance-heading">
                      <h3>{item.name || `Новый job ${index + 1}`}</h3>
                      {editable && (
                        <Button
                          size="sm"
                          disabled={!writable}
                          onClick={() => {
                            change({
                              ...draft,
                              jobs: draft.jobs.filter((_, i) => i !== index),
                            });
                            setEditor(undefined);
                          }}
                        >
                          <Trash2 size={15} /> Удалить job
                        </Button>
                      )}
                    </div>
                    <fieldset className="module-fields" disabled={!writable}>
                      <div className="prom-config-grid">
                        <Field label="Имя job">
                          <input
                            value={item.name}
                            maxLength={128}
                            placeholder="node_exporter"
                            onChange={(event) =>
                              changeJob(index, { name: event.target.value })
                            }
                          />
                        </Field>
                        <Field label="Сбор">
                          <select
                            value={item.enabled ? "enabled" : "disabled"}
                            onChange={(event) =>
                              changeJob(index, {
                                enabled: event.target.value === "enabled",
                              })
                            }
                          >
                            <option value="enabled">Включён</option>
                            <option value="disabled">Отключён</option>
                          </select>
                        </Field>
                        <Field label="Интервал сбора">
                          <input
                            value={item.scrape_interval}
                            maxLength={16}
                            onChange={(event) =>
                              changeJob(index, {
                                scrape_interval: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="Timeout">
                          <input
                            value={item.scrape_timeout}
                            maxLength={16}
                            onChange={(event) =>
                              changeJob(index, {
                                scrape_timeout: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="Протокол">
                          <select
                            value={item.scheme}
                            onChange={(event) =>
                              changeJob(index, {
                                scheme: event.target.value as "http" | "https",
                              })
                            }
                          >
                            <option value="http">HTTP</option>
                            <option value="https">HTTPS</option>
                          </select>
                        </Field>
                        <Field label="Путь метрик">
                          <input
                            value={item.metrics_path}
                            maxLength={256}
                            placeholder="/metrics"
                            onChange={(event) =>
                              changeJob(index, {
                                metrics_path: event.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                      <div className="prom-targets-heading">
                        <h4>Targets · {item.targets.length}</h4>{" "}
                        {editable && (
                          <Button
                            size="sm"
                            disabled={
                              draft.jobs.reduce(
                                (sum, value) => sum + value.targets.length,
                                0,
                              ) >= 512
                            }
                            onClick={() =>
                              changeJob(index, {
                                targets: [
                                  ...item.targets,
                                  { address: "", labels: {} },
                                ],
                              })
                            }
                          >
                            <Plus size={15} /> Добавить target
                          </Button>
                        )}
                      </div>
                      {item.targets.map((target, targetIndex) => (
                        <div
                          className="prom-config-target"
                          key={rowKey(target)}
                        >
                          <div className="prom-config-target-address">
                            <Field
                              label={`Адрес target ${targetIndex + 1}`}
                              hint="Имя хоста или IP и порт; без http:// и пути."
                            >
                              <input
                                value={target.address}
                                maxLength={300}
                                placeholder="server.example:9100"
                                onChange={(event) =>
                                  changeTarget(index, targetIndex, {
                                    address: event.target.value,
                                  })
                                }
                              />
                            </Field>
                            {editable && (
                              <Button
                                size="sm"
                                aria-label={`Удалить target ${targetIndex + 1}`}
                                onClick={() =>
                                  changeJob(index, {
                                    targets: item.targets.filter(
                                      (_, i) => i !== targetIndex,
                                    ),
                                  })
                                }
                              >
                                <Trash2 size={15} />
                              </Button>
                            )}
                          </div>
                          <TargetLabels
                            labels={target.labels}
                            editable={editable}
                            onValidity={(key, invalid) =>
                              setInvalidLabels((current) => ({
                                ...current,
                                [key]: invalid,
                              }))
                            }
                            onChange={(labels) =>
                              changeTarget(index, targetIndex, { labels })
                            }
                          />
                        </div>
                      ))}
                    </fieldset>
                  </section>
                ))}
              </div>
              <div className="prom-config-footer">
                <div className="prom-config-footer-state">
                  {unapplied && (
                    <strong>Сохранённый черновик ожидает применения</strong>
                  )}
                  <span className="module-hint">
                    {dirty
                      ? "Есть несохранённые изменения"
                      : "Нет несохранённых изменений"}
                  </span>
                </div>

                <div className="actions prom-config-toolbar">
                  <Button
                    disabled={locked}
                    onClick={() => {
                      void state.refetch().then((result) => {
                        if (result.data?.draft) {
                          setDraft(structuredClone(result.data.draft));
                          setJobID(result.data.last_job_id || "");
                          setSavedContent(content(result.data.draft));
                          setValidation(undefined);
                          setError(undefined);
                          setInvalidLabels({});
                          setEditorEpoch((value) => value + 1);
                          setEditor(undefined);
                        }
                      });
                    }}
                    title={
                      dirty
                        ? "Отменить изменения и загрузить сохранённый черновик"
                        : "Загрузить сохранённый черновик"
                    }
                  >
                    {dirty ? "Сбросить изменения" : "Загрузить черновик"}
                  </Button>
                  {editable && (
                    <>
                      <Button
                        disabled={!writable || !dirty || labelsInvalid}
                        onClick={() => void save()}
                      >
                        <Save size={15} />
                        {busy === "save" ? "Сохраняем…" : "Сохранить черновик"}
                      </Button>
                      <Button
                        disabled={
                          !writable ||
                          labelsInvalid ||
                          instance.desired_state !== "enabled"
                        }
                        onClick={() => void validate()}
                      >
                        <Check size={15} />
                        {busy === "validate"
                          ? "Проверяем…"
                          : "Проверить конфигурацию"}
                      </Button>
                      <Button
                        variant="default"
                        disabled={
                          !writable ||
                          dirty ||
                          !valid ||
                          instance.desired_state !== "enabled" ||
                          draft.revision === state.data.applied?.revision ||
                          (job.data?.status === "failed" &&
                            !state.data.rolled_back)
                        }
                        onClick={() => setConfirmApply(true)}
                      >
                        Применить
                      </Button>
                    </>
                  )}
                </div>
                {editable && !valid && (
                  <p className="module-hint">
                    Перед применением сохраните черновик и выполните проверку
                    конфигурации.
                  </p>
                )}
                {jobID && (
                  <div className="module-job" aria-live="polite">
                    <div className="module-job-heading">
                      <strong>Применение конфигурации</strong>
                      <Badge
                        value={
                          job.data?.status === "succeeded"
                            ? "ok"
                            : job.data?.status === "failed"
                              ? "error"
                              : "unknown"
                        }
                      >
                        {job.data
                          ? jobStatus[job.data.status] || job.data.status
                          : "Получаем состояние…"}
                      </Badge>
                    </div>
                    <small>
                      Операция {jobID}
                      {job.data?.finished_at
                        ? ` · ${date(job.data.finished_at)}`
                        : ""}
                    </small>
                    {job.error && (
                      <ErrorBox
                        error={job.error}
                        retry={() => void job.refetch()}
                      />
                    )}
                    {job.data?.error && (
                      <ErrorBox error={new Error(job.data.error)} />
                    )}
                  </div>
                )}
                {job.data?.status === "failed" &&
                  !state.data.rolled_back &&
                  editable && (
                    <Button disabled={locked} onClick={() => void retryApply()}>
                      Повторить применение
                    </Button>
                  )}
                {state.data.rolled_back && (
                  <p className="notice compact" role="status">
                    Применение не удалось. Предыдущая конфигурация
                    восстановлена; сбор продолжается с ней.
                  </p>
                )}
                {state.data.last_error && !state.data.rolled_back && (
                  <p className="notice compact" role="status">
                    Применение завершилось ошибкой. Восстановление предыдущей
                    конфигурации не подтверждено; проверьте состояние
                    Prometheus.
                  </p>
                )}
                {state.data.last_error && (
                  <ErrorBox error={new Error(state.data.last_error)} />
                )}

                <p className="module-hint prom-config-explanation">
                  Job задаёт правила сбора, target — адрес экспортера.
                  Сохранение создаёт черновик. Применение меняет конфигурацию
                  Prometheus; при ошибке загрузки controller восстанавливает
                  предыдущую.
                </p>
              </div>
            </Panel>
          )}
          {showDraft && validation && (
            <Panel title="YAML после проверки" icon={<FileCode size={20} />}>
              <p className="module-hint">
                {valid
                  ? "Соответствует текущему черновику."
                  : "Предпросмотр устарел: проверьте изменённый черновик заново."}
              </p>
              <pre className="prom-config-yaml">{validation.result.yaml}</pre>
            </Panel>
          )}
        </>
      )}
      {confirmApply && (
        <Dialog
          title="Применить конфигурацию?"
          description={`Prometheus загрузит сохранённую версию ${draft?.revision}. История метрик сохраняется.`}
          onClose={() => setConfirmApply(false)}
        >
          <div className="actions">
            <Button onClick={() => setConfirmApply(false)}>Отмена</Button>
            <Button variant="default" onClick={() => void apply()}>
              Применить конфигурацию
            </Button>
          </div>
        </Dialog>
      )}
      {leave && (
        <Dialog
          title="Есть несохранённые изменения"
          description="При переходе изменения черновика будут потеряны."
          onClose={() => {
            deferredLeave.current = undefined;
            setLeave("");
          }}
        >
          <div className="actions">
            <Button
              onClick={() => {
                deferredLeave.current = undefined;
                setLeave("");
              }}
            >
              Продолжить редактирование
            </Button>
            <Button
              variant="default"
              onClick={() => {
                const href = leave;
                const proceed = deferredLeave.current;
                deferredLeave.current = undefined;
                reloadDraft();
                setLeave("");
                if (proceed) proceed();
                else location.assign(href);
              }}
            >
              Перейти без сохранения
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function TargetLabels({
  labels,
  editable,
  onChange,
  onValidity,
}: {
  labels: Record<string, string>;
  editable: boolean;
  onValidity: (key: string, invalid: boolean) => void;
  onChange: (labels: Record<string, string>) => void;
}) {
  // Keep incomplete/duplicate names locally until corrected; never silently overwrite a label.
  const [rows, setRows] = useState(() => Object.entries(labels));
  const [invalid, setInvalid] = useState(false);
  const labelID = useId();
  const source = useRef(JSON.stringify(labels));
  const validityCallback = useRef(onValidity);
  validityCallback.current = onValidity;
  useEffect(() => {
    validityCallback.current(labelID, invalid);
  }, [invalid, labelID]);
  useEffect(() => () => validityCallback.current(labelID, false), [labelID]);
  useEffect(() => {
    if (JSON.stringify(labels) !== source.current) {
      setRows(Object.entries(labels));
      source.current = JSON.stringify(labels);
      setInvalid(false);
    }
  }, [labels]);
  function update(next: [string, string][]) {
    setRows(next);
    const names = next.map(([name]) => name);
    const failed =
      names.some(
        (name) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          name.startsWith("__") ||
          ["job", "instance"].includes(name),
      ) || new Set(names).size !== names.length;
    setInvalid(failed);
    if (!failed) {
      const value = Object.fromEntries(next);
      source.current = JSON.stringify(value);
      onChange(value);
    }
  }
  return (
    <div className="prom-config-labels">
      <span className="module-hint">Метки target · {rows.length}</span>
      {rows.map(([name, value], index) => (
        <div className="prom-config-label" key={index}>
          <input
            aria-label={`Имя метки ${index + 1}`}
            placeholder="site"
            value={name}
            maxLength={128}
            onChange={(event) =>
              update(
                rows.map<[string, string]>((row, i) =>
                  i === index ? [event.target.value, row[1]] : row,
                ),
              )
            }
          />
          <input
            aria-label={`Значение метки ${index + 1}`}
            placeholder="office"
            value={value}
            maxLength={512}
            onChange={(event) =>
              update(
                rows.map<[string, string]>((row, i) =>
                  i === index ? [row[0], event.target.value] : row,
                ),
              )
            }
          />
          {editable && (
            <Button
              size="sm"
              aria-label={`Удалить метку ${index + 1}`}
              onClick={() => update(rows.filter((_, i) => i !== index))}
            >
              <Trash2 size={15} />
            </Button>
          )}
        </div>
      ))}
      {invalid && (
        <p role="alert" className="prom-config-label-error">
          Имена меток должны быть уникальными: буквы, цифры и _. Имена job,
          instance и префикс __ зарезервированы. Исправьте или удалите строку.
        </p>
      )}
      {editable && (
        <Button
          size="sm"
          disabled={rows.length >= 32}
          onClick={() => update([...rows, ["", ""]])}
        >
          <Plus size={14} /> Добавить метку
        </Button>
      )}
    </div>
  );
}
