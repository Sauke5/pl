import { ActionFeedback } from "./ActionNotifications";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, APIError, queryClient } from "./api";
import type { Job } from "./types";
import { Badge, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  ArrowLeftRight,
  Database,
  GitFork,
  Pencil,
  Plus,
  RefreshCw,
  Activity,
} from "lucide-react";
import "./xray.css";
import "./xray-module.css";

type Inbound = {
  tag: string;
  protocol: "socks" | "http";
  listen: string;
  port: number;
  auth: "none" | "password";
  username: string;
  password_set?: boolean;
  password?: string;
};
type Outbound = {
  mode: "direct" | "imported";
  protocol?: string;
  server?: string;
  port?: number;
  name?: string;
  link?: string;
};
export type XrayConfiguration = {
  revision: number;
  ref?: string;
  inbounds: Inbound[];
  outbound: Outbound;
  routing: "proxy_all" | "private_direct";
};
type ConfigurationState = {
  editable: boolean;
  draft: XrayConfiguration;
  applied: XrayConfiguration | null;
  last_job_id: string;
  last_error: string;
  rolled_back: boolean;
};
type Status = {
  state: string;
  version: string;
  inbounds: Pick<Inbound, "tag" | "protocol" | "listen" | "port">[];
  outbound: Outbound | null;
  routing: string;
  counters: { name: string; value: number }[];
};
type Instance = { id: string; name: string; desired_state: string };
const active = (job?: Job) =>
  !!job && ["queued", "running"].includes(job.status);
const initial = (): XrayConfiguration => ({
  revision: 0,
  inbounds: [],
  outbound: { mode: "direct" },
  routing: "proxy_all",
});
const serialize = (configuration: XrayConfiguration) =>
  JSON.stringify(configuration);
const messages: Record<string, string> = {
  revision_conflict:
    "Черновик уже изменён другим администратором. Ваши поля сохранены на экране. Обновите черновик перед повторным редактированием.",
  conflict:
    "Черновик уже изменён другим администратором. Ваши поля сохранены на экране. Обновите черновик перед повторным редактированием.",
  module_busy: "Дождитесь завершения текущей операции.",
  forbidden: "Для настройки Xray нужны права администратора.",
};
type TrafficRow = { tag: string; sent?: number; received?: number };
// The host controller emits these outbounds in this order.
const outboundOrder = ["proxy", "direct", "block"];
function trafficRows(
  counters: Status["counters"],
  kind: "inbound" | "outbound",
  tagOrder: readonly string[],
) {
  const rows = new Map<string, TrafficRow>();
  for (const counter of counters || []) {
    const [category, tag, metric, direction, extra] = counter.name.split(">>>");
    if (
      category !== kind ||
      !tag ||
      metric !== "traffic" ||
      extra ||
      !["uplink", "downlink"].includes(direction)
    )
      continue;
    const row: TrafficRow = rows.get(tag) || { tag };
    if (direction === "uplink") row.sent = counter.value;
    else row.received = counter.value;
    rows.set(tag, row);
  }
  const rank = new Map(tagOrder.map((tag, index) => [tag, index]));
  return [...rows.values()].sort(
    (a, b) =>
      (rank.get(a.tag) ?? rank.size) - (rank.get(b.tag) ?? rank.size) ||
      a.tag.localeCompare(b.tag, "en"),
  );
}
function bytes(value?: number) {
  return value === undefined
    ? "Нет данных"
    : `${Number(value).toLocaleString("ru-RU")} байт`;
}
function TrafficTable({
  rows,
  empty,
  outboundMode,
}: {
  rows: TrafficRow[];
  empty: string;
  outboundMode?: Outbound["mode"];
}) {
  return rows.length ? (
    <div className="xray-table-scroll">
      <table className="xray-traffic-table">
        <thead>
          <tr>
            <th>Направление</th>
            <th>Отправлено</th>
            <th>Получено</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tag}>
              <td>
                {row.tag === "proxy"
                  ? outboundMode === "direct"
                    ? "Прямой выход"
                    : outboundMode === "imported"
                      ? "Через прокси"
                      : "Выбранный выход"
                  : row.tag === "direct"
                    ? "Напрямую"
                    : row.tag === "block"
                      ? "Блокировка"
                      : "Подключение"}
                <code>{row.tag}</code>
              </td>
              <td>{bytes(row.sent)}</td>
              <td>{bytes(row.received)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="muted">{empty}</p>
  );
}
function routingLabel(routing: string) {
  return routing === "private_direct"
    ? "Частные сети — напрямую"
    : routing === "proxy_all"
      ? "Весь трафик через выбранный выход"
      : "Нет данных";
}
function ConnectionSummary({ outbound }: { outbound?: Outbound | null }) {
  return (
    <>
      {outbound?.mode === "imported" ? (
        <>
          <span className="xray-protocol">
            {outbound.protocol?.toUpperCase() || "Прокси"}
          </span>
          <span>
            {outbound.server || "Адрес не получен"}
            {outbound.port ? `:${outbound.port}` : ""}
          </span>
        </>
      ) : outbound?.mode === "direct" ? (
        <span>Прямой выход</span>
      ) : (
        <span>Нет данных</span>
      )}
    </>
  );
}
function ConfigurationSummary({
  value,
}: {
  value: Pick<Status, "inbounds" | "outbound" | "routing">;
}) {
  return (
    <section className="xray-summary-grid" aria-label="Текущая схема Xray">
      <section className="xray-summary">
        <GitFork size={20} aria-hidden="true" />
        <div>
          <h3>Входящие подключения</h3>
          {value.inbounds?.length ? (
            value.inbounds.map((item) => (
              <p key={item.tag}>
                <strong>{item.tag}</strong> · {item.protocol.toUpperCase()}
                <br />
                {item.listen}:{item.port}
              </p>
            ))
          ) : (
            <p className="muted">Подключений пока нет</p>
          )}
        </div>
      </section>
      <section className="xray-summary">
        <Database size={20} aria-hidden="true" />
        <div>
          <h3>Исходящее подключение</h3>
          <div className="xray-connection">
            <ConnectionSummary outbound={value.outbound} />
          </div>
        </div>
      </section>
      <section className="xray-summary">
        <ArrowLeftRight size={20} aria-hidden="true" />
        <div>
          <h3>Маршрутизация</h3>
          <strong>{routingLabel(value.routing)}</strong>
          {value.routing === "private_direct" && (
            <p className="muted">Остальной трафик — через выбранный выход</p>
          )}
        </div>
      </section>
    </section>
  );
}
function explain(error: unknown) {
  return error instanceof APIError
    ? new Error(messages[error.code] || error.message)
    : error;
}

export default function XrayModule({ instance }: { instance: Instance }) {
  const base = `/modules/${instance.id}/xray`;
  const state = useQuery({
    queryKey: [`${base}/configuration`],
    queryFn: ({ signal }) =>
      api<ConfigurationState>(
        `${base}/configuration`,
        "GET",
        undefined,
        {},
        signal,
      ),
    retry: false,
  });
  const status = useQuery({
    queryKey: [`${base}/status`],
    queryFn: ({ signal }) =>
      api<Status>(`${base}/status`, "GET", undefined, {}, signal),
    retry: false,
    refetchInterval: 15000,
  });
  const [draft, setDraft] = useState<XrayConfiguration>();
  const [editing, setEditing] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [saved, setSaved] = useState("");
  const [validated, setValidated] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"success" | "info">("success");
  const [error, setError] = useState<unknown>();
  const [jobID, setJobID] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [leave, setLeave] = useState("");
  const key = useRef<{ revision: number; value: string } | undefined>(
    undefined,
  );
  const handled = useRef("");
  const trackedJob = useRef("");
  const job = useQuery({
    queryKey: [`/jobs/${jobID}`],
    queryFn: ({ signal }) =>
      api<Job>(`/jobs/${jobID}`, "GET", undefined, {}, signal),
    enabled: !!jobID,
    retry: false,
    refetchInterval: (query) =>
      !query.state.data || active(query.state.data) ? 2000 : false,
  });
  const dirty = !!draft && serialize(draft) !== saved;
  const locked = !!busy || active(job.data) || (!!jobID && !job.data);
  const editable =
    state.data?.editable === true && instance.desired_state !== "removed";
  const writable = editable && !locked;
  useEffect(() => {
    if (!draft && state.data) {
      const value = structuredClone(state.data.draft || initial());
      setDraft(value);
      setSaved(serialize(value));
      setJobID(state.data.last_job_id || "");
    }
  }, [state.data, draft]);
  useEffect(() => {
    if (!job.data || active(job.data) || handled.current === job.data.id)
      return;
    handled.current = job.data.id;
    if (trackedJob.current === job.data.id) {
      if (job.data.status === "succeeded") {
        trackedJob.current = "";
        setError(undefined);
        setNoticeKind("success");
        setNotice("Конфигурация Xray применена.");
      } else if (job.data.status === "failed") {
        trackedJob.current = "";
        setNotice("");
        setError(
          new Error(
            job.data.error ||
              "Не удалось применить конфигурацию Xray. Подробности — в состоянии задания.",
          ),
        );
      } else if (job.data.status === "canceled") {
        trackedJob.current = "";
        setNoticeKind("info");
        setNotice(
          "Применение конфигурации Xray отменено. Успешное применение не подтверждено.",
        );
      }
    }
    void state.refetch();
    void status.refetch();
  }, [job.data, state.refetch, status.refetch]);
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
        event.button ||
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
  function change(next: XrayConfiguration) {
    setDraft(next);
    setValidated("");
    setNotice("");
    setError(undefined);
  }
  function inbound(index: number, patch: Partial<Inbound>) {
    if (draft)
      change({
        ...draft,
        inbounds: draft.inbounds.map((value, i) =>
          i === index ? { ...value, ...patch } : value,
        ),
      });
  }
  function checkFields(value: XrayConfiguration) {
    const tags = new Set<string>(),
      addresses = new Set<string>();
    for (const item of value.inbounds) {
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item.tag) ||
        ["api", "proxy", "direct", "block"].includes(item.tag)
      )
        throw new Error(
          "Tag должен начинаться с латинской буквы и содержать до 64 букв, цифр, точек, _ или -. Имена api, proxy, direct и block зарезервированы.",
        );
      if (tags.has(item.tag))
        throw new Error("Tag inbound должен быть уникальным.");
      tags.add(item.tag);
      if (
        !Number.isInteger(item.port) ||
        item.port < 1024 ||
        item.port > 65535 ||
        item.port === 10085
      )
        throw new Error("Порт: 1024–65535; 10085 зарезервирован для API.");
      if (addresses.has(`${item.listen}:${item.port}`))
        throw new Error("Адрес и порт inbound уже заняты в этом черновике.");
      addresses.add(`${item.listen}:${item.port}`);
      const octets = item.listen.split(".");
      const n = octets.map(Number);
      if (
        octets.length !== 4 ||
        octets.some(
          (part, i) =>
            !/^\d+$/.test(part) || String(n[i]) !== part || n[i] > 255,
        ) ||
        !(
          item.listen === "127.0.0.1" ||
          n[0] === 10 ||
          (n[0] === 192 && n[1] === 168) ||
          (n[0] === 172 && n[1] >= 16 && n[1] <= 31)
        )
      )
        throw new Error(
          "Укажите loopback 127.0.0.1 либо принадлежащий хосту частный IPv4. Наличие адреса проверит host controller.",
        );
      const existing = state.data?.draft?.inbounds.find(
        (old) =>
          old.tag === item.tag &&
          old.username === item.username &&
          old.password_set,
      );
      if (
        item.auth === "password" &&
        (!item.username.trim() || (!item.password && !existing))
      )
        throw new Error("Для нового пользователя задайте логин и пароль.");
    }
    if (
      value.outbound.mode === "imported" &&
      !value.outbound.link?.trim() &&
      !value.outbound.protocol
    )
      throw new Error("Вставьте ссылку подключения для импорта outbound.");
  }
  async function run(action: "save" | "validate" | "apply" | "retry") {
    if (!draft) return;
    setBusy(action);
    setError(undefined);
    setNoticeKind("success");
    setNotice("");
    try {
      if (action === "save") {
        checkFields(draft);
        const result = await api<ConfigurationState>(
          `${base}/configuration`,
          "PUT",
          {
            configuration: {
              ...draft,
              outbound: {
                mode: draft.outbound.mode,
                ...(draft.outbound.link ? { link: draft.outbound.link } : {}),
              },
            },
          },
          {},
          AbortSignal.timeout(20000),
        );
        // Only the redacted server model survives a successful save. Never cache request credentials.
        if (!result.draft?.ref)
          throw new Error("Сервер не вернул сохранённый план Xray.");
        queryClient.setQueryData([`${base}/configuration`], result);
        setDraft(structuredClone(result.draft));
        setSaved(serialize(result.draft));
        setValidated("");
        key.current = undefined;
        await state.refetch();
        setNotice("Черновик сохранён. Ссылка и пароли больше не отображаются.");
      } else if (action === "validate") {
        const result = await api<{ valid: boolean }>(
          `${base}/configuration/validate`,
          "POST",
          { configuration_ref: draft.ref },
          {},
          AbortSignal.timeout(30000),
        );
        if (!result.valid) throw new Error("Xray отклонил конфигурацию.");
        setValidated(draft.ref || "");
        setNotice(
          "Конфигурация прошла xray run -test. Работающий сервис не изменён.",
        );
      } else {
        if (key.current?.revision !== draft.revision)
          key.current = {
            revision: draft.revision,
            value: crypto.randomUUID(),
          };
        const result = await api<{ job: Job }>(
          `${base}/configuration/${action}`,
          "POST",
          action === "retry"
            ? { job_id: jobID }
            : { revision: draft.revision, idempotency_key: key.current.value },
          {},
          AbortSignal.timeout(20000),
        );
        queryClient.setQueryData([`/jobs/${result.job.id}`], result.job);
        handled.current = "";
        trackedJob.current = result.job.id;
        setNoticeKind("info");
        setJobID(result.job.id);
        setConfirm(false);
        setNotice(
          action === "retry"
            ? "Повторяется то же задание с прежним неизменяемым планом."
            : "Применение добавлено в очередь. Сохранённый план зафиксирован в задании.",
        );
      }
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy("");
    }
  }
  async function reload() {
    setBusy("reload");
    setError(undefined);
    try {
      const result = await state.refetch();
      if (result.error) throw result.error;
      if (result.data) {
        const value = structuredClone(result.data.draft || initial());
        setDraft(value);
        setSaved(serialize(value));
        setValidated("");
      }
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy("");
    }
  }
  async function refreshStatus() {
    setRefreshingStatus(true);
    try {
      await status.refetch({ cancelRefetch: false });
    } finally {
      setRefreshingStatus(false);
    }
  }
  function openEditor() {
    const serverDraft = state.data?.draft;
    if (!dirty && serverDraft && serverDraft.ref !== draft?.ref) {
      const value = structuredClone(serverDraft);
      setDraft(value);
      setSaved(serialize(value));
      setValidated("");
    }
    setEditing(true);
  }
  const configuration = draft || initial();
  const observed = status.data;
  const live = status.error ? undefined : observed;
  const applied = state.data?.applied;
  const appliedRevision = applied?.revision;
  const appliedConfiguration = applied || observed;
  const serverDraft = state.data?.draft;
  const hasUnapplied = !!serverDraft?.ref && serverDraft.ref !== applied?.ref;
  const outboundTraffic = trafficRows(
    observed?.counters || [],
    "outbound",
    outboundOrder,
  );
  const serviceOutboundTraffic = outboundTraffic.filter(
    (row) => row.tag === "api",
  );
  const clientOutboundTraffic = outboundTraffic.filter(
    (row) => row.tag !== "api",
  );
  const inboundTraffic = trafficRows(
    observed?.counters || [],
    "inbound",
    observed?.inbounds?.map((item) => item.tag) || [],
  );
  const serviceTraffic = inboundTraffic.filter((row) => row.tag === "api");
  const clientTraffic = inboundTraffic.filter((row) => row.tag !== "api");
  const otherCounters = (observed?.counters || [])
    .filter(
      (counter) =>
        !/^(inbound|outbound)>>>[^>]+>>>traffic>>>(uplink|downlink)$/.test(
          counter.name,
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return (
    <div className="modules-page xray-page xray-module">
      <div className="page-title">
        <div>
          <h1>Xray</h1>
          <p>{instance.name} · SOCKS / HTTP и исходящие подключения</p>
        </div>
        <a className="button button-secondary" href="#modules">
          К модулям
        </a>
      </div>
      <ActionFeedback notice={notice} error={error} noticeKind={noticeKind} />

      {state.error && (
        <ErrorBox
          error={explain(state.error)}
          retry={() => void state.refetch()}
        />
      )}
      {state.isPending ? (
        <p role="status">Загружаем конфигурацию…</p>
      ) : (
        state.data && (
          <>
            {!editable && (
              <p className="notice">Настройки доступны только для чтения.</p>
            )}
            <Panel
              className="xray-config-card"
              title={
                editing
                  ? "Редактор конфигурации Xray"
                  : "Действующая конфигурация"
              }
              action={
                <div className="xray-status-actions">
                  {editing ? (
                    <>
                      <span className="muted">
                        Черновик v{configuration.revision} ·{" "}
                        {dirty ? "Есть изменения" : "Без изменений"}
                      </span>
                      <Button onClick={() => setEditing(false)}>
                        К действующей конфигурации
                      </Button>
                    </>
                  ) : (
                    <>
                      {live ? (
                        <>
                          <Badge
                            value={live.state === "running" ? "ok" : live.state}
                          >
                            {live.state === "running"
                              ? "Работает"
                              : live.state === "disabled"
                                ? "Отключён"
                                : live.state}
                          </Badge>
                          {live.version && (
                            <span className="muted">Xray {live.version}</span>
                          )}
                        </>
                      ) : (
                        <Badge value="unknown">
                          {status.isPending
                            ? "Запрашиваем статус…"
                            : "Статус недоступен"}
                        </Badge>
                      )}
                      <Button disabled={!draft} onClick={openEditor}>
                        {editable && <Pencil size={16} aria-hidden="true" />}
                        {editable
                          ? "Редактировать конфигурацию"
                          : "Открыть черновик"}
                      </Button>
                    </>
                  )}
                </div>
              }
            >
              {state.data.rolled_back && (
                <p className="notice">
                  Предыдущая конфигурация восстановлена после ошибки применения.
                </p>
              )}
              {state.data.last_error && (
                <ErrorBox error={new Error(state.data.last_error)} />
              )}
              {editing ? (
                <>
                  <div className="xray-config-grid">
                    <fieldset
                      disabled={!writable}
                      className="xray-fieldset xray-surface xray-inbounds-editor"
                    >
                      <legend>
                        <span className="xray-inbound-heading">
                          <span>
                            <span>Входящие подключения</span>
                            <span className="muted xray-inbound-caption">
                              Адреса и порты для подключения к Xray
                            </span>
                          </span>
                          <Button
                            disabled={
                              !writable || configuration.inbounds.length >= 16
                            }
                            onClick={() => {
                              let tag = "proxy_1",
                                number = 1;
                              while (
                                configuration.inbounds.some(
                                  (item) => item.tag === tag,
                                )
                              )
                                tag = `proxy_${++number}`;
                              let port = 1080;
                              while (
                                configuration.inbounds.some(
                                  (item) =>
                                    item.listen === "127.0.0.1" &&
                                    item.port === port,
                                )
                              )
                                port++;
                              change({
                                ...configuration,
                                inbounds: [
                                  ...configuration.inbounds,
                                  {
                                    tag,
                                    protocol: "socks",
                                    listen: "127.0.0.1",
                                    port,
                                    auth: "none",
                                    username: "",
                                  },
                                ],
                              });
                            }}
                          >
                            <Plus size={16} aria-hidden="true" /> Добавить
                            inbound
                          </Button>
                        </span>
                      </legend>
                      {!configuration.inbounds.length && (
                        <div className="xray-inbound-empty">
                          <GitFork size={52} aria-hidden="true" />
                          <strong>Подключения не добавлены</strong>
                          <p className="muted">
                            Добавьте входящее подключение,
                            <br />
                            чтобы принимать трафик.
                          </p>
                        </div>
                      )}
                      {configuration.inbounds.map((item, index) => (
                        <section
                          className="xray-inbound"
                          aria-label={`Inbound ${index + 1}`}
                          key={index}
                        >
                          <div className="xray-fields">
                            <Field label={`Tag inbound ${index + 1}`}>
                              <input
                                required
                                value={item.tag}
                                maxLength={64}
                                onChange={(event) =>
                                  inbound(index, { tag: event.target.value })
                                }
                              />
                            </Field>
                            <Field label={`Протокол inbound ${index + 1}`}>
                              <select
                                value={item.protocol}
                                onChange={(event) =>
                                  inbound(index, {
                                    protocol: event.target
                                      .value as Inbound["protocol"],
                                  })
                                }
                              >
                                <option value="socks">SOCKS5 TCP</option>
                                <option value="http">HTTP CONNECT</option>
                              </select>
                            </Field>
                            <Field label={`IPv4 inbound ${index + 1}`}>
                              <input
                                value={item.listen}
                                onChange={(event) =>
                                  inbound(index, { listen: event.target.value })
                                }
                              />
                            </Field>
                            <Field label={`Порт inbound ${index + 1}`}>
                              <input
                                type="number"
                                min={1024}
                                max={65535}
                                value={item.port || ""}
                                onChange={(event) =>
                                  inbound(index, {
                                    port: Number(event.target.value),
                                  })
                                }
                              />
                            </Field>
                            <Field label={`Авторизация inbound ${index + 1}`}>
                              <select
                                value={item.auth}
                                onChange={(event) =>
                                  inbound(index, {
                                    auth: event.target.value as Inbound["auth"],
                                    username:
                                      event.target.value === "none"
                                        ? ""
                                        : item.username,
                                    password: "",
                                  })
                                }
                              >
                                <option value="none">Без пароля</option>
                                <option value="password">Логин и пароль</option>
                              </select>
                            </Field>
                            {item.auth === "password" && (
                              <>
                                <Field label={`Логин inbound ${index + 1}`}>
                                  <input
                                    autoComplete="off"
                                    value={item.username}
                                    onChange={(event) =>
                                      inbound(index, {
                                        username: event.target.value,
                                      })
                                    }
                                  />
                                </Field>
                                <Field
                                  label={`Пароль inbound ${index + 1}`}
                                  hint={
                                    item.password_set
                                      ? "Пустое поле сохраняет пароль при прежних tag и логине."
                                      : "Задайте пароль нового пользователя."
                                  }
                                >
                                  <input
                                    type="password"
                                    aria-label={`Пароль inbound ${index + 1}`}
                                    autoComplete="new-password"
                                    value={item.password || ""}
                                    onChange={(event) =>
                                      inbound(index, {
                                        password: event.target.value,
                                      })
                                    }
                                  />
                                </Field>
                              </>
                            )}
                          </div>
                          <Button
                            variant="destructive"
                            onClick={() =>
                              change({
                                ...configuration,
                                inbounds: configuration.inbounds.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                          >
                            Удалить inbound {index + 1}
                          </Button>
                        </section>
                      ))}

                      <p className="muted">
                        127.0.0.1 доступен только с хоста. Для LAN выберите
                        частный IPv4 этого хоста. Авторизация опциональна. Адрес
                        должен принадлежать хосту, порт — быть свободным.
                        Поддерживается TCP.
                      </p>
                    </fieldset>
                    <fieldset
                      disabled={!writable}
                      className="xray-fieldset xray-surface xray-outbound-editor"
                    >
                      <legend>Исходящее подключение</legend>
                      <p className="muted">Сервер для выхода в сеть</p>
                      {configuration.outbound.mode === "imported" &&
                        configuration.outbound.protocol && (
                          <div className="xray-saved-connection">
                            <Database size={28} aria-hidden="true" />
                            <div>
                              <p className="muted">Сохранённое подключение</p>
                              <div className="xray-connection">
                                <ConnectionSummary
                                  outbound={configuration.outbound}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      <Field label="Шаблон исходящего подключения">
                        <select
                          value={configuration.outbound.mode}
                          onChange={(event) =>
                            change({
                              ...configuration,
                              outbound:
                                event.target.value === "direct"
                                  ? { mode: "direct" }
                                  : { mode: "imported" },
                            })
                          }
                        >
                          <option value="direct">Прямой выход</option>
                          <option value="imported">Прокси по ссылке</option>
                        </select>
                      </Field>
                      {configuration.outbound.mode === "imported" && (
                        <>
                          <Field
                            label="Ссылка подключения outbound"
                            hint="Connection URI, а не subscription URL. TLS verification обязательна; неподдерживаемые параметры будут отклонены."
                          >
                            <input
                              type="password"
                              aria-label="Ссылка подключения outbound"
                              autoComplete="new-password"
                              value={configuration.outbound.link || ""}
                              onChange={(event) =>
                                change({
                                  ...configuration,
                                  outbound: {
                                    ...configuration.outbound,
                                    link: event.target.value,
                                  },
                                })
                              }
                              placeholder={
                                configuration.outbound.protocol
                                  ? "Подключение сохранено. Вставьте новую ссылку для замены"
                                  : "vless://… или trojan://…"
                              }
                            />
                          </Field>
                          <p className="muted">
                            После сохранения здесь останется только протокол и
                            адрес сервера. Исходная ссылка повторно не
                            отображается.
                          </p>
                        </>
                      )}
                    </fieldset>
                  </div>
                  <fieldset
                    disabled={!writable}
                    className="xray-fieldset xray-surface xray-routing-editor"
                  >
                    <legend>Маршрутизация</legend>
                    <div>
                      <p className="muted">Правила выхода в сеть</p>
                    </div>
                    <Field label="Базовая маршрутизация">
                      <select
                        value={configuration.routing}
                        onChange={(event) =>
                          change({
                            ...configuration,
                            routing: event.target
                              .value as XrayConfiguration["routing"],
                          })
                        }
                      >
                        <option value="proxy_all">
                          Весь трафик через выбранный выход
                        </option>
                        <option value="private_direct">
                          Частные сети напрямую, остальное через выбранный выход
                        </option>
                      </select>
                    </Field>
                  </fieldset>
                  <div className="xray-config-footer">
                    <div className="xray-draft-state">
                      <strong>
                        {appliedRevision !== undefined
                          ? `Применена версия ${appliedRevision}`
                          : "Конфигурация ещё не применена"}
                      </strong>
                      <span className="muted">
                        {dirty
                          ? "Есть несохранённые изменения"
                          : "Нет несохранённых изменений"}
                        {!dirty &&
                        appliedRevision !== undefined &&
                        configuration.revision !== appliedRevision
                          ? " · Черновик отличается от активной версии"
                          : ""}
                      </span>
                    </div>
                    <div className="actions">
                      <Button
                        disabled={locked}
                        onClick={() => {
                          if (dirty) {
                            if (
                              !window.confirm(
                                "Отбросить несохранённые изменения и загрузить черновик сервера?",
                              )
                            )
                              return;
                          }
                          void reload();
                        }}
                      >
                        Обновить черновик
                      </Button>
                      <Button
                        disabled={!writable || !dirty}
                        onClick={() => void run("save")}
                      >
                        {busy === "save" ? "Сохраняем…" : "Сохранить черновик"}
                      </Button>
                      <Button
                        disabled={!writable || dirty || !configuration.ref}
                        onClick={() => void run("validate")}
                      >
                        {busy === "validate"
                          ? "Проверяем…"
                          : "Проверить конфигурацию"}
                      </Button>
                      <Button
                        variant="default"
                        disabled={
                          !writable ||
                          dirty ||
                          !validated ||
                          validated !== configuration.ref ||
                          instance.desired_state === "disabled"
                        }
                        onClick={() => setConfirm(true)}
                      >
                        Применить
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="xray-applied-revision">
                    <strong>
                      {applied
                        ? `Применена версия ${applied.revision}`
                        : "Версия появится после первого применения"}
                    </strong>
                  </p>
                  {appliedConfiguration && (
                    <ConfigurationSummary value={appliedConfiguration} />
                  )}
                  {(dirty || hasUnapplied) && (
                    <p className="muted xray-draft-summary">
                      {dirty
                        ? "Есть несохранённые изменения"
                        : "Есть неприменённые изменения"}
                      {" · Черновик v"}
                      {dirty ? configuration.revision : serverDraft?.revision}
                    </p>
                  )}
                </>
              )}
              {job.error && (
                <ErrorBox error={job.error} retry={() => void job.refetch()} />
              )}
              {job.data && (
                <div className="module-job" role="status">
                  <p>
                    Применение конфигурации · <Badge value={job.data.status} />
                  </p>
                  {job.data.error && (
                    <ErrorBox error={new Error(job.data.error)} />
                  )}
                  {job.data.status === "failed" && editable && (
                    <Button disabled={locked} onClick={() => void run("retry")}>
                      Повторить то же задание
                    </Button>
                  )}
                </div>
              )}
            </Panel>
            <Panel
              className="xray-status-card"
              title="Состояние и трафик"
              action={
                <Button
                  aria-busy={refreshingStatus}
                  disabled={refreshingStatus}
                  onClick={() => void refreshStatus()}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Обновить состояние
                </Button>
              }
            >
              {status.error &&
                (observed ? (
                  <p className="notice" role="status">
                    Обновление не удалось. Показаны последние полученные
                    счётчики.
                  </p>
                ) : (
                  <ErrorBox error={explain(status.error)} />
                ))}
              {status.isPending && (
                <p role="status">Получаем состояние Xray…</p>
              )}
              {observed && (
                <>
                  <div className="xray-traffic-grid">
                    <section className="xray-surface">
                      <h3>
                        <Activity size={20} />
                        Трафик по выходам
                      </h3>
                      <TrafficTable
                        rows={clientOutboundTraffic}
                        outboundMode={observed.outbound?.mode}
                        empty="Счётчики исходящего трафика пока не получены."
                      />
                      {!!clientTraffic.length && (
                        <>
                          <h4>Трафик входящих подключений</h4>
                          <TrafficTable rows={clientTraffic} empty="" />
                        </>
                      )}
                    </section>
                    <section className="xray-surface">
                      <h3>
                        <Database size={20} />
                        Служебный трафик
                      </h3>
                      <p className="muted">API · входящее подключение</p>
                      {serviceTraffic.length ? (
                        serviceTraffic.map((row) => (
                          <dl className="xray-service-stats" key={row.tag}>
                            <div>
                              <dt>Отправлено</dt>
                              <dd>{bytes(row.sent)}</dd>
                            </div>
                            <div>
                              <dt>Получено</dt>
                              <dd>{bytes(row.received)}</dd>
                            </div>
                          </dl>
                        ))
                      ) : (
                        <p className="muted">Счётчики API пока не получены.</p>
                      )}
                      {!!serviceOutboundTraffic.length && (
                        <>
                          <p className="muted">API · исходящее подключение</p>
                          {serviceOutboundTraffic.map((row) => (
                            <dl className="xray-service-stats" key={row.tag}>
                              <div>
                                <dt>Отправлено</dt>
                                <dd>{bytes(row.sent)}</dd>
                              </div>
                              <div>
                                <dt>Получено</dt>
                                <dd>{bytes(row.received)}</dd>
                              </div>
                            </dl>
                          ))}
                        </>
                      )}
                      <p className="muted">Трафик управления Xray</p>
                    </section>
                  </div>
                  {!!otherCounters.length && (
                    <details className="xray-other-counters">
                      <summary>
                        Другие счётчики · {otherCounters.length}
                      </summary>
                      <dl className="detail-grid">
                        {otherCounters.map((counter) => (
                          <div key={counter.name}>
                            <dt>{counter.name}</dt>
                            <dd>
                              {Number(counter.value).toLocaleString("ru-RU")}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                </>
              )}
            </Panel>
          </>
        )
      )}
      {confirm && (
        <Dialog
          title="Применить конфигурацию Xray?"
          description="Изменение входящих портов может разорвать текущие proxy-соединения."
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            Будет применена сохранённая версия {configuration.revision}. При
            ошибке host controller восстановит предыдущую конфигурацию. Пароли и
            исходная ссылка не попадут в задание.
          </p>
          <div className="dialog-footer">
            <Button disabled={!!busy} onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button
              variant="default"
              disabled={!!busy}
              onClick={() => void run("apply")}
            >
              Применить конфигурацию
            </Button>
          </div>
        </Dialog>
      )}
      {leave && (
        <Dialog title="Уйти без сохранения?" onClose={() => setLeave("")}>
          <p>Несохранённые изменения будут потеряны.</p>
          <div className="dialog-footer">
            <Button onClick={() => setLeave("")}>Остаться</Button>
            <Button
              variant="destructive"
              onClick={() => {
                setSaved(serialize(configuration));
                location.href = leave;
              }}
            >
              Уйти
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
