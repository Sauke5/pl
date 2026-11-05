import { ActionFeedback } from "./ActionNotifications";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Info, Plus, Trash2 } from "lucide-react";
import { api, APIError, queryClient } from "./api";
import type { Job } from "./types";
import { Badge, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import "./alertmanager.css";
import "./alertmanager-module.css";

type ProxySettings = {
  mode: "direct" | "http";
  url: string;
  username: string;
  password_set?: boolean;
  ca_set?: boolean;
  no_proxy: string[];
  password?: string;
  ca_pem?: string;
  clear_ca?: boolean;
};
type SMTPSettings = {
  smarthost: string;
  from: string;
  to: string[];
  tls_mode: "starttls" | "implicit";
  username: string;
  password?: string;
  password_set?: boolean;
};
const smtpDefaults = (): SMTPSettings => ({
  smarthost: "",
  from: "",
  to: [],
  tls_mode: "starttls",
  username: "",
});
const emailAddress = (value: string) =>
  /^[A-Za-z0-9!#$%&'*+/=?^_`|~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(
    value,
  ) &&
  value.length <= 254 &&
  value.split("@")[0].length <= 64 &&
  !value.startsWith(".") &&
  !value.split("@")[0].endsWith(".") &&
  !value.includes("..");
type Receiver = {
  name: string;
  kind:
    | "webhook"
    | "telegram"
    | "slack"
    | "discord"
    | "email"
    | "msteamsv2"
    | "pagerduty";
  smtp?: SMTPSettings;
  endpoint_set?: boolean;
  token_set?: boolean;
  chat_id?: number;
  proxy: ProxySettings;
  endpoint?: string;
  token?: string;
};
type Configuration = {
  revision: number;
  ref: string;
  route: {
    receiver: string;
    group_wait: string;
    group_interval: string;
    repeat_interval: string;
  };
  receivers: Receiver[];
};
type State = {
  editable: boolean;
  draft: Configuration;
  applied: Configuration | null;
  last_job_id: string;
  last_error: string;
  rolled_back: boolean;
};
type Instance = {
  id: string;
  name: string;
  desired_state: string;
  version?: string;
};
const direct = (): ProxySettings => ({
  mode: "direct",
  url: "",
  username: "",
  no_proxy: [],
});
const initial = (): Configuration => ({
  revision: 0,
  ref: "",
  route: {
    receiver: "",
    group_wait: "30s",
    group_interval: "5m",
    repeat_interval: "4h",
  },
  receivers: [],
});
const active = (job?: Job) =>
  !!job && ["queued", "running"].includes(job.status);
const content = (value: Configuration) => JSON.stringify(value);
function explain(error: unknown) {
  if (error instanceof APIError) {
    if (["conflict", "revision_conflict"].includes(error.code))
      return new Error(
        "Черновик изменён другим администратором. Ваши поля сохранены на экране; обновите черновик перед новой попыткой.",
      );
    if (error.status === 403)
      return new Error(
        "Для настройки Alertmanager нужны права администратора.",
      );
    if (error.code === "module_busy")
      return new Error("Дождитесь завершения текущей операции.");
  }
  return error;
}
function duration(value: string): number {
  const match = /^(0|[1-9][0-9]{0,6})(s|m|h)$/.exec(value);
  if (!match) return NaN;
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  return Number(match[1]) * multiplier;
}

export default function AlertmanagerModule({
  instance,
}: {
  instance: Instance;
}) {
  const base = `/modules/${instance.id}/alertmanager/configuration`;
  const state = useQuery({
    queryKey: [base],
    queryFn: ({ signal }) => api<State>(base, "GET", undefined, {}, signal),
    retry: false,
  });
  const [draft, setDraft] = useState<Configuration>();
  const [saved, setSaved] = useState("");
  const [validated, setValidated] = useState("");
  const [jobID, setJobID] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"success" | "info">("success");
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [leave, setLeave] = useState("");
  const handled = useRef("");
  const trackedJob = useRef("");
  const requestKey = useRef<{ revision: number; key: string } | undefined>(
    undefined,
  );
  const job = useQuery({
    queryKey: [`/jobs/${jobID}`],
    queryFn: ({ signal }) =>
      api<Job>(`/jobs/${jobID}`, "GET", undefined, {}, signal),
    enabled: !!jobID,
    retry: false,
    refetchInterval: (query) =>
      !query.state.data || active(query.state.data) ? 2000 : false,
  });
  const dirty = !!draft && content(draft) !== saved;
  const locked = !!busy || active(job.data) || (!!jobID && !job.data);
  const editable =
    state.data?.editable === true && instance.desired_state !== "removed";
  const writable = editable && !locked;
  useEffect(() => {
    if (!draft && state.data) {
      const value = structuredClone(state.data.draft || initial());
      setDraft(value);
      setSaved(content(value));
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
        setNotice("Конфигурация Alertmanager применена.");
      } else if (job.data.status === "failed") {
        trackedJob.current = "";
        setNotice("");
        setError(
          new Error(
            job.data.error ||
              "Не удалось применить конфигурацию Alertmanager. Подробности — в состоянии задания.",
          ),
        );
      } else if (job.data.status === "canceled") {
        trackedJob.current = "";
        setNoticeKind("info");
        setNotice(
          "Применение конфигурации Alertmanager отменено. Успешное применение не подтверждено.",
        );
      }
    }
    void state.refetch();
  }, [job.data, state.refetch]);
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
  function change(value: Configuration) {
    setDraft(value);
    setValidated("");
    setError(undefined);
    setNotice("");
  }
  function receiver(index: number, patch: Partial<Receiver>) {
    if (draft)
      change({
        ...draft,
        receivers: draft.receivers.map((item, i) =>
          i === index ? { ...item, ...patch } : item,
        ),
      });
  }
  function smtp(index: number, patch: Partial<SMTPSettings>) {
    if (draft)
      receiver(index, {
        smtp: { ...(draft.receivers[index].smtp || smtpDefaults()), ...patch },
      });
  }
  function proxy(index: number, patch: Partial<ProxySettings>) {
    if (draft)
      receiver(index, { proxy: { ...draft.receivers[index].proxy, ...patch } });
  }
  function validateFields(value: Configuration) {
    const names = new Set<string>();
    const route = value.route;
    const wait = duration(route.group_wait),
      interval = duration(route.group_interval),
      repeat = duration(route.repeat_interval);
    if (
      ![wait, interval, repeat].every(Number.isFinite) ||
      wait < 0 ||
      interval < 1 ||
      repeat < interval ||
      Math.max(wait, interval, repeat) > 168 * 3600
    )
      throw new Error(
        "Проверьте интервалы: s/m/h; ожидание 0–168h, группировка от 1s, повтор не меньше группировки и не больше 168h.",
      );
    if (
      value.receivers.length &&
      !value.receivers.some((item) => item.name === route.receiver)
    )
      throw new Error("Выберите получателя по умолчанию.");
    for (const item of value.receivers) {
      if (item.proxy.clear_ca && item.proxy.ca_pem)
        throw new Error(
          "Выберите удаление сохранённого CA либо новый PEM-сертификат.",
        );
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item.name) ||
        names.has(item.name)
      )
        throw new Error(
          "Название получателя: латинская буква в начале, затем буквы, цифры, точка, _ или -. До 64 символов; названия должны быть уникальными.",
        );
      names.add(item.name);
      const old = state.data?.draft?.receivers.find(
        (other) => other.name === item.name && other.kind === item.kind,
      );
      if (item.kind === "email") {
        const mail = item.smtp
          ? {
              ...item.smtp,
              to: item.smtp.to.map((value) => value.trim()).filter(Boolean),
            }
          : undefined;
        if (
          !mail ||
          !mail.smarthost ||
          !/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]):[1-9][0-9]{0,4}$/.test(
            mail.smarthost,
          ) ||
          Number(mail.smarthost.split(":").at(-1)) > 65535
        )
          throw new Error(
            "Укажите SMTP сервер с явным портом, например smtp.example:587.",
          );
        if (
          !emailAddress(mail.from) ||
          !mail.to.length ||
          mail.to.length > 32 ||
          mail.to.some((address) => !emailAddress(address)) ||
          new Set(mail.to).size !== mail.to.length
        )
          throw new Error(
            "Укажите адрес отправителя и от 1 до 32 разных адресов получателей без имён и заголовков.",
          );
        if (
          mail.username &&
          !mail.password &&
          !(
            old?.smtp?.password_set &&
            old.smtp.smarthost === mail.smarthost &&
            old.smtp.username === mail.username &&
            old.smtp.tls_mode === mail.tls_mode
          )
        )
          throw new Error(
            "Задайте пароль SMTP для этого сервера, режима TLS и логина.",
          );
        if (!mail.username && mail.password)
          throw new Error("Для пароля SMTP укажите логин.");
        continue;
      }
      const endpoint = item.endpoint?.trim();
      if (endpoint) {
        let url: URL;
        try {
          url = new URL(endpoint);
        } catch {
          throw new Error("Укажите полный HTTPS endpoint получателя.");
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error(
            "Endpoint должен использовать HTTPS без логина, пароля и фрагмента URL.",
          );
      } else if (
        item.kind !== "telegram" &&
        item.kind !== "pagerduty" &&
        !old?.endpoint_set
      )
        throw new Error("Задайте HTTPS endpoint нового получателя.");
      if (item.kind === "telegram") {
        if (!Number.isSafeInteger(item.chat_id) || item.chat_id === 0)
          throw new Error(
            "Telegram chat ID должен быть ненулевым целым числом в точном диапазоне JavaScript.",
          );
        if (endpoint && !item.token)
          throw new Error(
            "При вводе Telegram API endpoint задайте токен заново.",
          );
        if (!item.token && !old?.token_set)
          throw new Error("Задайте токен Telegram-бота.");
      }
      if (item.kind === "pagerduty") {
        if (item.token && /[{}\s]/u.test(item.token))
          throw new Error(
            "Routing key PagerDuty должен быть обычным ключом без шаблонов и пробелов.",
          );
        if (endpoint && !item.token)
          throw new Error(
            "При вводе PagerDuty endpoint задайте routing key заново.",
          );
        if (!item.token && !old?.token_set)
          throw new Error(
            "Задайте routing key интеграции PagerDuty Events API v2.",
          );
      }
      if (item.proxy.mode === "http") {
        let url: URL;
        try {
          url = new URL(item.proxy.url);
        } catch {
          throw new Error("Укажите HTTP proxy с явным портом.");
        }
        if (
          url.protocol !== "http:" ||
          (!url.port && !/:80\/?$/.test(item.proxy.url)) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        )
          throw new Error(
            "Proxy: HTTP адрес с явным портом, без встроенных credentials, query и пути.",
          );
        if (item.proxy.username.includes(":"))
          throw new Error("Логин Basic auth не должен содержать двоеточие.");
        const sameProxyUser =
          old?.proxy.mode === "http" &&
          old.proxy.username === item.proxy.username &&
          old.proxy.url === item.proxy.url;
        if (
          item.proxy.username &&
          !item.proxy.password &&
          !(sameProxyUser && old.proxy.password_set)
        )
          throw new Error("Задайте пароль нового proxy-пользователя.");
        if (!item.proxy.username && item.proxy.password)
          throw new Error("Для proxy-пароля укажите логин.");
      }
    }
  }
  async function action(kind: "save" | "validate" | "apply" | "retry") {
    if (!draft) return;
    setBusy(kind);
    setError(undefined);
    setNoticeKind("success");
    setNotice("");
    try {
      if (kind === "save") {
        validateFields(draft);
        const configuration = {
          ...draft,
          receivers: draft.receivers.map((item) => {
            const settings = item.proxy;
            return {
              name: item.name,
              kind: item.kind,
              ...(item.endpoint ? { endpoint: item.endpoint.trim() } : {}),
              ...(item.token ? { token: item.token } : {}),
              ...(item.kind === "telegram" ? { chat_id: item.chat_id } : {}),
              ...(item.kind === "email" && item.smtp
                ? {
                    smtp: {
                      smarthost: item.smtp.smarthost,
                      from: item.smtp.from,
                      to: item.smtp.to
                        .map((value) => value.trim())
                        .filter(Boolean),
                      tls_mode: item.smtp.tls_mode,
                      username: item.smtp.username,
                      ...(item.smtp.password
                        ? { password: item.smtp.password }
                        : {}),
                    },
                  }
                : {}),
              proxy:
                settings.mode === "direct"
                  ? {
                      ...direct(),
                      ...(settings.ca_pem ? { ca_pem: settings.ca_pem } : {}),
                      ...(settings.clear_ca ? { clear_ca: true } : {}),
                    }
                  : {
                      mode: "http",
                      url: settings.url,
                      username: settings.username,
                      no_proxy: settings.no_proxy
                        .map((value) => value.trim())
                        .filter(Boolean),
                      ...(settings.password
                        ? { password: settings.password }
                        : {}),
                      ...(settings.ca_pem ? { ca_pem: settings.ca_pem } : {}),
                      ...(settings.clear_ca ? { clear_ca: true } : {}),
                    },
            };
          }),
        };
        const result = await api<State>(
          base,
          "PUT",
          { configuration },
          {},
          AbortSignal.timeout(20000),
        );
        if (!result.draft?.ref)
          throw new Error("Сервер не вернул сохранённый план Alertmanager.");
        setDraft(structuredClone(result.draft));
        setSaved(content(result.draft));
        setValidated("");
        requestKey.current = undefined;
        await state.refetch();
        setNotice(
          "Черновик сохранён. Endpoint, токены, SMTP- и proxy-пароли, CA не возвращаются в форму.",
        );
      } else if (kind === "validate") {
        const result = await api<{ valid: boolean }>(
          `${base}/validate`,
          "POST",
          { configuration_ref: draft.ref },
          {},
          AbortSignal.timeout(30000),
        );
        if (!result.valid)
          throw new Error("Alertmanager отклонил конфигурацию.");
        setValidated(draft.ref);
        setNotice(
          "Конфигурация прошла проверку amtool. Работающий сервис не изменён.",
        );
      } else {
        if (requestKey.current?.revision !== draft.revision)
          requestKey.current = {
            revision: draft.revision,
            key: crypto.randomUUID(),
          };
        const result = await api<{ job: Job }>(
          `${base}/${kind}`,
          "POST",
          kind === "retry"
            ? { job_id: jobID }
            : {
                revision: draft.revision,
                idempotency_key: requestKey.current.key,
              },
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
          kind === "retry"
            ? "Повторяется то же задание с прежним планом."
            : "Сохранённая конфигурация поставлена на применение.",
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
        setSaved(content(value));
        setValidated("");
        setDiscard(false);
      }
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy("");
    }
  }
  const configuration = draft || initial();
  return (
    <div className="modules-page alertmanager-page am-notification-layout">
      <div className="page-title">
        <div>
          <h1>Уведомления Alertmanager</h1>
          <p>
            {instance.name} · установленная версия{" "}
            {instance.version || "не получена"}
          </p>
        </div>
        <a className="button button-secondary" href="#modules">
          <ArrowLeft size={16} aria-hidden="true" /> К модулям
        </a>
      </div>
      <ActionFeedback notice={notice} error={error} noticeKind={noticeKind} />

      {state.error && (
        <ErrorBox error={explain(state.error)} retry={() => void reload()} />
      )}
      {state.isPending ? (
        <p role="status">Загружаем настройки уведомлений…</p>
      ) : (
        state.data && (
          <Panel
            title="Конфигурация уведомлений"
            className="am-config-card"
            action={
              <span className="am-draft-version">
                Черновик · версия {configuration.revision}
              </span>
            }
          >
            {!editable && (
              <p className="notice">Настройки доступны только для чтения.</p>
            )}
            <p className="am-config-description muted">
              Получатели, доставка и интервалы уведомлений
            </p>
            {configuration.receivers.length === 0 && (
              <p className="notice">
                {state.data.applied?.receivers.length
                  ? "В черновике нет получателей. После применения уведомления будут выключены."
                  : "Уведомления выключены: получатели не добавлены."}
              </p>
            )}
            {state.data.rolled_back && (
              <p className="notice">
                После ошибки восстановлена предыдущая конфигурация.
              </p>
            )}
            {state.data.last_error && (
              <ErrorBox error={new Error(state.data.last_error)} />
            )}
            <div className="am-editor-columns">
              <fieldset
                disabled={!writable}
                className="am-fieldset am-section-card am-receivers-card"
              >
                <legend className="am-visually-hidden">Получатели</legend>
                <div className="am-section-heading">
                  <h3>
                    Получатели{" "}
                    <span className="am-receiver-count">
                      {configuration.receivers.length}
                    </span>
                  </h3>
                  <Button
                    disabled={!writable || configuration.receivers.length >= 32}
                    onClick={() => {
                      let number = 1;
                      while (
                        configuration.receivers.some(
                          (item) => item.name === `receiver_${number}`,
                        )
                      )
                        number++;
                      const name = `receiver_${number}`;
                      change({
                        ...configuration,
                        receivers: [
                          ...configuration.receivers,
                          { name, kind: "webhook", proxy: direct() },
                        ],
                        route: {
                          ...configuration.route,
                          receiver: configuration.route.receiver || name,
                        },
                      });
                    }}
                  >
                    <Plus size={16} aria-hidden="true" /> Добавить получателя
                  </Button>
                </div>
                {configuration.receivers.map((item, index) => (
                  <section
                    className="am-receiver"
                    aria-label={`Получатель ${index + 1}`}
                    key={index}
                  >
                    <div className="am-fields">
                      <Field label="Название получателя">
                        <input
                          aria-label={`Название получателя ${index + 1}`}
                          value={item.name}
                          maxLength={64}
                          onChange={(event) => {
                            const name = event.target.value;
                            change({
                              ...configuration,
                              route: {
                                ...configuration.route,
                                receiver:
                                  configuration.route.receiver === item.name
                                    ? name
                                    : configuration.route.receiver,
                              },
                              receivers: configuration.receivers.map(
                                (value, i) =>
                                  i === index ? { ...value, name } : value,
                              ),
                            });
                          }}
                        />
                      </Field>
                      <Field label="Канал">
                        <select
                          aria-label={`Канал получателя ${index + 1}`}
                          value={item.kind}
                          onChange={(event) =>
                            receiver(index, {
                              kind: event.target.value as Receiver["kind"],
                              endpoint: "",
                              token: "",
                              endpoint_set: false,
                              token_set: false,
                              chat_id: undefined,
                              smtp:
                                event.target.value === "email"
                                  ? smtpDefaults()
                                  : undefined,
                              proxy: direct(),
                            })
                          }
                        >
                          <option value="webhook">Webhook</option>
                          <option value="telegram">Telegram</option>
                          <option value="slack">Slack</option>
                          <option value="discord">Discord</option>
                          <option value="email">Email · SMTP</option>
                          <option value="msteamsv2">
                            Microsoft Teams · Workflows v2
                          </option>
                          <option value="pagerduty">
                            PagerDuty · Events API v2
                          </option>
                        </select>
                      </Field>
                    </div>
                    {item.kind !== "email" && (
                      <Field
                        label={
                          item.kind === "telegram"
                            ? "Telegram API endpoint"
                            : item.kind === "pagerduty"
                              ? "PagerDuty Events API endpoint"
                              : item.kind === "msteamsv2"
                                ? "Teams Workflow webhook URL"
                                : "HTTPS endpoint"
                        }
                        hint={
                          item.endpoint_set
                            ? "Endpoint сохранён. Пустое поле сохранит его только при прежнем имени и канале."
                            : item.kind === "telegram"
                              ? "Пустое поле использует стандартный Telegram API."
                              : item.kind === "pagerduty"
                                ? "Пустое поле использует https://events.pagerduty.com/v2/enqueue. При замене endpoint введите routing key заново."
                                : item.kind === "msteamsv2"
                                  ? "HTTPS webhook потока Teams Workflows, принимающего Adaptive Cards. После сохранения URL скрыт."
                                  : "Укажите полный HTTPS URL. После сохранения адрес не отображается."
                        }
                      >
                        <input
                          aria-label={`Endpoint получателя ${index + 1}`}
                          type="password"
                          autoComplete="new-password"
                          value={item.endpoint || ""}
                          onChange={(event) =>
                            receiver(index, { endpoint: event.target.value })
                          }
                        />
                      </Field>
                    )}
                    {item.kind === "email" && (
                      <div className="am-fields">
                        <Field
                          label="SMTP сервер"
                          hint="Имя или IP с портом, например smtp.example:587. SMTP подключается напрямую; HTTP proxy не применяется."
                        >
                          <input
                            aria-label={`SMTP сервер ${index + 1}`}
                            value={item.smtp?.smarthost || ""}
                            placeholder="smtp.example:587"
                            maxLength={320}
                            onChange={(event) =>
                              smtp(index, { smarthost: event.target.value })
                            }
                          />
                        </Field>
                        <Field label="Защита SMTP">
                          <select
                            aria-label={`Защита SMTP ${index + 1}`}
                            value={item.smtp?.tls_mode || "starttls"}
                            onChange={(event) =>
                              smtp(index, {
                                tls_mode: event.target
                                  .value as SMTPSettings["tls_mode"],
                              })
                            }
                          >
                            <option value="starttls">
                              STARTTLS · обычно порт 587
                            </option>
                            <option value="implicit">
                              TLS · обычно порт 465
                            </option>
                          </select>
                        </Field>
                        <Field
                          label="Отправитель"
                          hint="Только email-адрес, без имени и заголовков."
                        >
                          <input
                            aria-label={`Отправитель SMTP ${index + 1}`}
                            type="email"
                            value={item.smtp?.from || ""}
                            maxLength={254}
                            onChange={(event) =>
                              smtp(index, { from: event.target.value })
                            }
                          />
                        </Field>
                        <Field
                          label="Получатели"
                          hint="От 1 до 32 адресов, по одному на строку."
                        >
                          <textarea
                            aria-label={`Получатели SMTP ${index + 1}`}
                            rows={3}
                            value={(item.smtp?.to || []).join("\n")}
                            onChange={(event) =>
                              smtp(index, {
                                to: event.target.value.split("\n"),
                              })
                            }
                          />
                        </Field>
                        <Field
                          label="Логин SMTP"
                          hint="Оставьте пустым, если SMTP сервер не требует авторизации."
                        >
                          <input
                            aria-label={`Логин SMTP ${index + 1}`}
                            autoComplete="off"
                            value={item.smtp?.username || ""}
                            maxLength={128}
                            onChange={(event) =>
                              smtp(index, {
                                username: event.target.value,
                                ...(!event.target.value
                                  ? { password: "" }
                                  : {}),
                              })
                            }
                          />
                        </Field>
                        <Field
                          label="Пароль SMTP"
                          hint={
                            item.smtp?.password_set
                              ? "Пароль сохранён. Пустое поле сохранит его при прежнем имени получателя, SMTP сервере, режиме TLS и логине."
                              : "Пароль приложения или учётной записи SMTP. После сохранения не отображается."
                          }
                        >
                          <input
                            aria-label={`Пароль SMTP ${index + 1}`}
                            type="password"
                            autoComplete="new-password"
                            value={item.smtp?.password || ""}
                            maxLength={1024}
                            onChange={(event) =>
                              smtp(index, { password: event.target.value })
                            }
                          />
                        </Field>
                      </div>
                    )}
                    {item.kind === "pagerduty" && (
                      <Field
                        label="Routing key PagerDuty"
                        hint={
                          item.token_set
                            ? "Ключ сохранён. Пустое поле сохранит его при прежних имени, канале и endpoint."
                            : "Integration key для Events API v2; не REST API token. После сохранения скрыт."
                        }
                      >
                        <input
                          aria-label={`Routing key PagerDuty ${index + 1}`}
                          type="password"
                          autoComplete="new-password"
                          maxLength={4096}
                          value={item.token || ""}
                          onChange={(event) =>
                            receiver(index, { token: event.target.value })
                          }
                        />
                      </Field>
                    )}
                    {item.kind === "telegram" && (
                      <div className="am-fields">
                        <Field
                          label="Токен бота"
                          hint={
                            item.token_set
                              ? "Токен сохранён; пустое поле сохранит его при прежнем имени, канале и API endpoint."
                              : "Нужен токен нового Telegram-бота."
                          }
                        >
                          <input
                            aria-label={`Токен Telegram ${index + 1}`}
                            type="password"
                            autoComplete="new-password"
                            value={item.token || ""}
                            onChange={(event) =>
                              receiver(index, { token: event.target.value })
                            }
                          />
                        </Field>
                        <Field label="Chat ID">
                          <input
                            aria-label={`Telegram chat ID ${index + 1}`}
                            type="number"
                            step="1"
                            value={item.chat_id ?? ""}
                            onChange={(event) =>
                              receiver(index, {
                                chat_id: event.target.value
                                  ? Number(event.target.value)
                                  : undefined,
                              })
                            }
                          />
                        </Field>
                      </div>
                    )}
                    {item.kind !== "email" && (
                      <Field label="Доставка">
                        <select
                          aria-label={`Доставка получателя ${index + 1}`}
                          value={item.proxy.mode}
                          onChange={(event) =>
                            receiver(index, {
                              proxy:
                                event.target.value === "direct"
                                  ? {
                                      ...direct(),
                                      ca_set: item.proxy.ca_set,
                                      ca_pem: item.proxy.ca_pem,
                                      clear_ca: item.proxy.clear_ca,
                                    }
                                  : {
                                      ...direct(),
                                      mode: "http",
                                      ca_set: item.proxy.ca_set,
                                      ca_pem: item.proxy.ca_pem,
                                      clear_ca: item.proxy.clear_ca,
                                    },
                            })
                          }
                        >
                          <option value="direct">Напрямую</option>
                          <option value="http">Через HTTP proxy</option>
                        </select>
                      </Field>
                    )}
                    {item.kind !== "email" && item.proxy.mode === "http" && (
                      <div className="am-proxy">
                        <h3>Proxy для этого получателя</h3>
                        <Field
                          label="Адрес proxy"
                          hint="Обычный HTTP proxy с явным портом. 127.0.0.1 означает сам контейнер Alertmanager, а не хост. Логин и пароль задаются отдельно."
                        >
                          <input
                            aria-label={`HTTP proxy URL ${index + 1}`}
                            placeholder="http://proxy.example:3128"
                            value={item.proxy.url}
                            onChange={(event) =>
                              proxy(index, { url: event.target.value })
                            }
                          />
                        </Field>
                        <div className="am-fields">
                          <Field label="Логин proxy">
                            <input
                              aria-label={`Логин proxy ${index + 1}`}
                              autoComplete="off"
                              value={item.proxy.username}
                              onChange={(event) =>
                                proxy(index, { username: event.target.value })
                              }
                            />
                          </Field>
                          <Field
                            label="Пароль proxy"
                            hint={
                              item.proxy.password_set
                                ? "Пароль сохранён; пустое поле сохранит его при прежних адресе proxy и логине."
                                : "Для Basic auth задайте логин и пароль."
                            }
                          >
                            <input
                              aria-label={`Пароль proxy ${index + 1}`}
                              type="password"
                              autoComplete="new-password"
                              value={item.proxy.password || ""}
                              onChange={(event) =>
                                proxy(index, { password: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                        <Field
                          label="Исключения proxy"
                          hint="По одному имени хоста, IP или CIDR на строку."
                        >
                          <textarea
                            aria-label={`No proxy ${index + 1}`}
                            rows={3}
                            value={item.proxy.no_proxy.join("\n")}
                            onChange={(event) =>
                              proxy(index, {
                                no_proxy: event.target.value.split("\n"),
                              })
                            }
                          />
                        </Field>
                      </div>
                    )}
                    <Field
                      label={
                        item.kind === "email"
                          ? "CA SMTP сервера"
                          : "CA получателя"
                      }
                      hint={
                        item.proxy.ca_set
                          ? "CA сохранён; пустое поле сохранит сертификат при прежнем имени и канале, включая прямую доставку."
                          : item.kind === "email"
                            ? "Необязательно: доверенный CA SMTP сервера. Проверка сертификата и TLS обязательны."
                            : "Необязательно: доверенный CA HTTPS получателя. Применяется напрямую и через proxy. Проверка сертификата всегда включена."
                      }
                    >
                      <textarea
                        aria-label={`CA получателя ${index + 1}`}
                        autoComplete="off"
                        rows={4}
                        value={item.proxy.ca_pem || ""}
                        onChange={(event) =>
                          proxy(index, {
                            ca_pem: event.target.value,
                            clear_ca: false,
                          })
                        }
                      />
                    </Field>
                    {item.proxy.ca_set && (
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          aria-label={`Использовать системные CA получателя ${index + 1}`}
                          checked={item.proxy.clear_ca === true}
                          onChange={(event) =>
                            proxy(index, {
                              clear_ca: event.target.checked,
                              ...(event.target.checked ? { ca_pem: "" } : {}),
                            })
                          }
                        />
                        Использовать системные CA · удалить сохранённый
                        сертификат
                      </label>
                    )}
                    <Button
                      variant="destructive"
                      onClick={() => {
                        const receivers = configuration.receivers.filter(
                          (_, i) => i !== index,
                        );
                        change({
                          ...configuration,
                          receivers,
                          route: {
                            ...configuration.route,
                            receiver:
                              configuration.route.receiver === item.name
                                ? receivers[0]?.name || ""
                                : configuration.route.receiver,
                          },
                        });
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" /> Удалить получателя{" "}
                      {index + 1}
                    </Button>
                  </section>
                ))}
              </fieldset>
              <fieldset
                disabled={!writable}
                className="am-fieldset am-section-card am-routing-card"
              >
                <legend className="am-visually-hidden">
                  Группировка и повтор
                </legend>
                <div className="am-routing-heading">
                  <h3>Группировка и повтор</h3>
                  <p className="muted">Кому и когда отправлять уведомления</p>
                </div>
                <div className="am-fields am-routing-fields">
                  <Field label="Получатель по умолчанию">
                    <select
                      aria-label="Получатель по умолчанию"
                      value={configuration.route.receiver}
                      disabled={!writable || !configuration.receivers.length}
                      onChange={(event) =>
                        change({
                          ...configuration,
                          route: {
                            ...configuration.route,
                            receiver: event.target.value,
                          },
                        })
                      }
                    >
                      <option value="">Не выбран</option>
                      {configuration.receivers.map((item, index) => (
                        <option key={index} value={item.name}>
                          {item.name || `Получатель ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {(
                    [
                      [
                        "group_wait",
                        "Ожидание группы",
                        "Задержка перед первым уведомлением новой группы.",
                      ],
                      [
                        "group_interval",
                        "Интервал группы",
                        "Интервал уведомлений об изменениях в группе.",
                      ],
                      [
                        "repeat_interval",
                        "Повтор уведомления",
                        "Повтор активных алертов, если изменений нет.",
                      ],
                    ] as const
                  ).map(([field, label, hint]) => (
                    <Field key={field} label={label} hint={hint}>
                      <input
                        aria-label={label}
                        value={configuration.route[field]}
                        onChange={(event) =>
                          change({
                            ...configuration,
                            route: {
                              ...configuration.route,
                              [field]: event.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
                <div className="am-units-note">
                  <Info size={18} aria-hidden="true" />
                  <div>
                    <strong>Единицы времени</strong>
                    <p>s — секунды · m — минуты · h — часы</p>
                  </div>
                </div>
                <p className="muted am-delivery-note">
                  Трафик каждого получателя идёт напрямую либо через выбранный
                  для него proxy.
                </p>
              </fieldset>
            </div>
            <div className="am-config-footer">
              <div className="am-applied-state" role="status">
                <Info size={19} aria-hidden="true" />
                <div>
                  <strong>
                    {state.data.applied
                      ? `Применена версия ${state.data.applied.revision}`
                      : "Конфигурация ещё не применена"}
                  </strong>
                  <small>
                    {dirty
                      ? "Есть несохранённые изменения"
                      : configuration.ref
                        ? "Черновик сохранён"
                        : "Черновик ещё не сохранён"}
                  </small>
                </div>
              </div>
              <div className="actions am-config-actions">
                <Button
                  disabled={locked}
                  onClick={() => (dirty ? setDiscard(true) : void reload())}
                >
                  Обновить черновик
                </Button>
                <Button
                  disabled={!writable || !dirty}
                  onClick={() => void action("save")}
                >
                  {busy === "save" ? "Сохраняем…" : "Сохранить черновик"}
                </Button>
                <Button
                  disabled={!writable || dirty || !configuration.ref}
                  onClick={() => void action("validate")}
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
            <p className="muted am-gateway-note">
              Управление идёт через PL; собственный API Alertmanager не
              публикуется в LAN.
            </p>
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
                  <Button
                    disabled={locked}
                    onClick={() => void action("retry")}
                  >
                    Повторить то же задание
                  </Button>
                )}
              </div>
            )}
          </Panel>
        )
      )}
      {confirm && (
        <Dialog
          title="Применить уведомления?"
          description="Alertmanager начнёт использовать сохранённые получатели и маршрутизацию."
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            Будет применена версия {configuration.revision}. При ошибке host
            controller восстановит прежнюю конфигурацию. Секреты передаются в
            root-private план и не входят в задание.
          </p>
          <div className="dialog-footer">
            <Button disabled={!!busy} onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button
              variant="default"
              disabled={!!busy}
              onClick={() => void action("apply")}
            >
              Применить конфигурацию
            </Button>
          </div>
        </Dialog>
      )}
      {discard && (
        <Dialog title="Обновить черновик?" onClose={() => setDiscard(false)}>
          <p>Несохранённые поля будут заменены черновиком сервера.</p>
          <div className="dialog-footer">
            <Button onClick={() => setDiscard(false)}>Отмена</Button>
            <Button disabled={!!busy} onClick={() => void reload()}>
              Отбросить и обновить
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
                setSaved(content(configuration));
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
