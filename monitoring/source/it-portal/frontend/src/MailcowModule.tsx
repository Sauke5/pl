import { useEffect, useState, type FormEvent } from "react";
import { HardDrive, ListFilter, Mail, Shield } from "lucide-react";
import { ActionFeedback } from "./ActionNotifications";
import { api, APIError, date, queryClient, safeURL, useAPI } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import type { Session } from "./types";
import "./mailcow-module.css";

const groups = [
  ["inventory", "Домены и версия"],
  ["mailboxes", "Почтовые ящики"],
  ["queue", "Очередь"],
  ["services", "Службы"],
  ["storage", "Хранилище"],
  ["rspamd", "Rspamd"],
] as const;
type GroupID = (typeof groups)[number][0];
type Settings = Record<GroupID, { enabled: boolean; interval_seconds: number }>;
type Group = {
  enabled: boolean;
  interval_seconds: number;
  last_attempt_at: string | null;
  last_attempt_status: string;
  last_success_at: string | null;
  error_code: string;
  status: "disabled" | "pending" | "unsupported" | "error" | "stale" | "ok";
  stale: boolean;
  data: Record<string, unknown> | null;
};
type Snapshot = {
  instance_id: string;
  integration_id: string;
  name: string;
  url: string;
  revision: number;
  enabled: boolean;
  groups: Record<GroupID, Group>;
};
const statusLabels: Record<string, string> = {
  disabled: "Выключено",
  pending: "Ожидает данных",
  unsupported: "Не поддерживается",
  error: "Ошибка сбора",
  stale: "Данные устарели",
  ok: "Данные получены",
};
const attemptLabels: Record<string, string> = {
  success: "Данные получены",
  error: "Ошибка сбора",
  failed: "Ошибка сбора",
};
const errorLabels: Record<string, string> = {
  auth: "Mailcow отклонил API-ключ или адрес Платформы",
  network: "Не удалось подключиться к Mailcow",
  timeout: "Истекло время ожидания Mailcow",
  schema: "Неожиданный формат данных Mailcow",
  unsupported: "API этой группы недоступен в версии Mailcow",
  http: "Mailcow вернул ошибку HTTP",
  upstream: "Внутренняя ошибка Mailcow",
  body_limit: "Ответ превысил допустимый размер",
  record_limit: "Слишком много записей в ответе",
  secret: "Недоступен серверный API-ключ",
  policy: "Подключение отклонено политикой Платформы",
};

function initialSettings(snapshot: Snapshot): Settings {
  return Object.fromEntries(
    groups.map(([id]) => [
      id,
      {
        enabled: snapshot.groups[id].enabled,
        interval_seconds: snapshot.groups[id].interval_seconds,
      },
    ]),
  ) as Settings;
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function count(value: unknown) {
  const parsed = number(value);
  return parsed === undefined ? "Нет данных" : parsed.toLocaleString("ru-RU");
}
function bytes(value: unknown) {
  const parsed = number(value);
  if (parsed === undefined) return "Нет данных";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ", "ПиБ"];
  const index =
    parsed === 0
      ? 0
      : Math.min(5, Math.floor(Math.log(parsed) / Math.log(1024)));
  return `${(parsed / 1024 ** Math.max(0, index)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[Math.max(0, index)]}`;
}
function timestamp(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? date(value)
    : "Ещё не было";
}
function text(value: unknown) {
  return typeof value === "string" && value ? value : "Нет данных";
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
type Metric = [string, string];
function Metrics({ items }: { items: Metric[] }) {
  return (
    <dl className="detail-grid module-details">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function groupStatus(group: Group, sourceEnabled = true) {
  return !sourceEnabled || !group.enabled
    ? "disabled"
    : group.stale && group.status === "ok"
      ? "stale"
      : group.status;
}

function SummaryMetrics({
  items,
  compact = false,
}: {
  items: Metric[];
  compact?: boolean;
}) {
  return (
    <dl className={`mailcow-summary-metrics${compact ? " is-compact" : ""}`}>
      {items.map(([label, value]) => (
        <div
          key={label}
          className={value === "Нет данных" ? "mailcow-metric-unknown" : ""}
        >
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SummarySources({
  snapshot,
  ids,
}: {
  snapshot: Snapshot;
  ids: GroupID[];
}) {
  return (
    <div className="mailcow-summary-sources">
      {ids.map((id) => {
        const group = snapshot.groups[id];
        const status = groupStatus(group, snapshot.enabled);
        return (
          <p key={id}>
            <span>{groups.find(([key]) => key === id)?.[1]}: </span>
            <strong
              className={
                status === "error" || status === "stale"
                  ? "mailcow-source-warning"
                  : ""
              }
            >
              {statusLabels[status]}
            </strong>
            <span> · Успех: {timestamp(group.last_success_at)}</span>
          </p>
        );
      })}
    </div>
  );
}

function MailSummary({ snapshot }: { snapshot: Snapshot }) {
  const queue = snapshot.groups.queue.data;
  const mailboxes = snapshot.groups.mailboxes.data;
  const inventory = snapshot.groups.inventory.data;
  const storage = snapshot.groups.storage.data;
  const rspamd = snapshot.groups.rspamd.data;
  const actions = object(rspamd?.actions);
  const used = number(storage?.used_percent);
  const percent = used !== undefined && used <= 100 ? used : undefined;
  return (
    <div className="mailcow-overview" aria-label="Сводка почтового сервера">
      <Panel
        title="Очередь доставки"
        icon={<ListFilter size={22} />}
        className="mailcow-summary-card"
      >
        <SummaryMetrics
          items={[
            ["Писем в очереди", count(queue?.messages_observed)],
            ["Из них отложено", count(object(queue?.by_queue)?.deferred)],
          ]}
        />
        <div className="mailcow-summary-secondary">
          <SummaryMetrics
            compact
            items={[
              ["Объём очереди", bytes(queue?.bytes_observed)],
              [
                "Возраст старейшего, с",
                count(queue?.oldest_observed_age_seconds),
              ],
            ]}
          />
        </div>
        {queue?.empty_ambiguous === true && (
          <p className="module-hint">
            Пустой ответ: очередь пуста или список недоступен; исправность
            доставки не подтверждена.
          </p>
        )}
        {queue?.possibly_truncated === true && (
          <p className="module-hint">
            Ответ может быть усечён; показаны наблюдаемые сообщения.
          </p>
        )}
        <SummarySources snapshot={snapshot} ids={["queue"]} />
      </Panel>
      <Panel
        title="Хранилище и квоты"
        icon={<HardDrive size={22} />}
        className="mailcow-summary-card"
      >
        <SummaryMetrics
          items={[
            [
              "Заполнение диска vmail",
              percent === undefined ? "Нет данных" : `${count(percent)}%`,
            ],
            [
              "Ящиков у лимита (≥ 90%)",
              count(mailboxes?.quota_over_90_percent),
            ],
          ]}
        />
        <p className="mailcow-storage-display">
          {text(storage?.used_display)} из {text(storage?.total_display)}
        </p>
        {percent !== undefined && (
          <progress
            className="mailcow-storage-progress"
            max={100}
            value={percent}
            aria-label="Заполнение диска vmail"
          >
            {count(percent)}%
          </progress>
        )}
        <SummarySources snapshot={snapshot} ids={["storage", "mailboxes"]} />
      </Panel>
      <Panel
        title="Антиспам · Rspamd"
        icon={<Shield size={22} />}
        className="mailcow-summary-card"
      >
        <p className="mailcow-card-description">
          Накопительные счётчики, сброс при перезапуске
        </p>
        <SummaryMetrics
          items={[
            ["Проверено", count(rspamd?.scanned)],
            ["Отклонено", count(actions?.reject)],
            ["Добавлен заголовок", count(actions?.["add header"])],
          ]}
        />
        <SummarySources snapshot={snapshot} ids={["rspamd"]} />
      </Panel>
      <Panel
        title="Почтовые ящики"
        icon={<Mail size={22} />}
        className="mailcow-summary-card"
      >
        <SummaryMetrics
          items={[
            ["Включённые ящики", count(mailboxes?.active_mailboxes)],
            ["Всего ящиков", count(mailboxes?.mailboxes)],
            ["Хранящиеся письма", count(mailboxes?.messages)],
          ]}
        />
        <div className="mailcow-summary-secondary">
          <SummaryMetrics
            compact
            items={[
              ["Занято ящиками", bytes(mailboxes?.used_bytes)],
              ["Домены", count(inventory?.domains)],
              ["Активные домены", count(inventory?.active_domains)],
            ]}
          />
        </div>
        <SummarySources snapshot={snapshot} ids={["mailboxes", "inventory"]} />
      </Panel>
    </div>
  );
}

function GroupData({
  id,
  data,
}: {
  id: GroupID;
  data: Record<string, unknown>;
}) {
  switch (id) {
    case "inventory":
      return (
        <Metrics
          items={[
            ["Домены", count(data.domains)],
            ["Активные домены", count(data.active_domains)],
            ["Ящики в доменах", count(data.mailboxes)],
            ["Занято ящиками", bytes(data.used_bytes)],
            ["Выделено квот ящикам", bytes(data.mailbox_quota_allocated_bytes)],
            ["Сообщения в доменах", count(data.messages)],
            ["Версия Mailcow", text(data.version)],
          ]}
        />
      );
    case "mailboxes":
      return (
        <Metrics
          items={[
            ["Почтовые ящики", count(data.mailboxes)],
            ["Активные ящики", count(data.active_mailboxes)],
            ["Сообщения", count(data.messages)],
            ["Занято ящиками", bytes(data.used_bytes)],
            ["Сумма ограниченных квот", bytes(data.quota_limit_bytes)],
            ["Ящики без лимита", count(data.unlimited_mailboxes)],
            [
              "Квота заполнена на 90% и более",
              count(data.quota_over_90_percent),
            ],
          ]}
        />
      );
    case "queue": {
      const queues = object(data.by_queue);
      return (
        <>
          <Metrics
            items={[
              ["Сообщения в ответе", count(data.messages_observed)],
              ["Объём в ответе", bytes(data.bytes_observed)],
              [
                "Возраст старейшего, с",
                count(data.oldest_observed_age_seconds),
              ],
              ...Object.entries(queues || {}).map(([name, value]): Metric => [
                `Очередь ${name}`,
                count(value),
              ]),
            ]}
          />
          <p className="module-hint">
            Пустой ответ очереди не подтверждает исправность доставки: Mailcow
            может вернуть его при внутренней ошибке списка.
          </p>
          {data.empty_ambiguous === true && (
            <p className="module-hint">
              Получен пустой ответ: очередь пуста или внутренний список
              недоступен.
            </p>
          )}
          {data.possibly_truncated === true && (
            <p className="module-hint">
              Ответ может быть усечён. Показаны только наблюдаемые сообщения.
            </p>
          )}
        </>
      );
    }
    case "services": {
      const services = object(data.services);
      const entries = Object.entries(services || {});
      return (
        <>
          {entries.length ? (
            <div className="mailcow-table-wrap">
              <table>
                <caption className="sr-only">
                  Состояния контейнеров Mailcow
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Служба</th>
                    <th scope="col">Container state</th>
                    <th scope="col">Запущен</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([name, value]) => {
                    const service = object(value);
                    const started = number(service?.started_at);
                    const time =
                      started === undefined
                        ? undefined
                        : new Date(started * 1000);
                    return (
                      <tr key={name}>
                        <th scope="row">{name}</th>
                        <td>{text(service?.state)}</td>
                        <td>
                          {time && Number.isFinite(time.getTime())
                            ? timestamp(time.toISOString())
                            : "Нет данных"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="module-hint">Службы в ответе отсутствуют.</p>
          )}
          <p className="module-hint">
            Container state running не подтверждает готовность приложения.
            Готовность ClamAV и возраст антивирусных баз через этот API
            недоступны.
          </p>
        </>
      );
    }
    case "storage": {
      const used = number(data.used_percent);
      return (
        <>
          <Metrics
            items={[
              [
                "Заполнено",
                used === undefined || used > 100
                  ? "Нет данных"
                  : `${count(used)}%`,
              ],
              ["Занято на диске", text(data.used_display)],
              ["Ёмкость диска", text(data.total_display)],
            ]}
          />
        </>
      );
    }
    case "rspamd": {
      const actions = object(data.actions);
      return (
        <>
          <Metrics
            items={[
              ["Проверено сообщений", count(data.scanned)],
              ["Спам", count(data.spam_count)],
              ["Не спам", count(data.ham_count)],
              ["Обучено", count(data.learned)],
              ["Время работы, с", count(data.uptime)],
              ...Object.entries(actions || {}).map(([name, value]): Metric => [
                `Действие ${name}`,
                count(value),
              ]),
            ]}
          />
          <p className="module-hint">
            Накопительные счётчики Rspamd могут сбрасываться при перезапуске.
          </p>
        </>
      );
    }
  }
}

export default function MailcowModule({ instanceID }: { instanceID: string }) {
  return <MailcowDetails key={instanceID} instanceID={instanceID} />;
}

function MailcowDetails({ instanceID }: { instanceID: string }) {
  const base = `/modules/${encodeURIComponent(instanceID)}/mailcow`;
  const query = useAPI<Snapshot>(base);
  const session = useAPI<Session>("/session");
  const admin = session.data?.user?.admin === true;
  const snapshot = query.data;
  const [tab, setTab] = useState<"overview" | "collection">("overview");
  const [draft, setDraft] = useState<Settings>();
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (snapshot && !dirty) {
      setDraft(initialSettings(snapshot));
      setRevision(snapshot.revision);
    }
  }, [snapshot, dirty]);

  function change(id: GroupID, patch: Partial<Settings[GroupID]>) {
    if (!draft) return;
    setDraft({ ...draft, [id]: { ...draft[id], ...patch } });
    setDirty(true);
    setNotice("");
  }
  async function reload(discard = false) {
    setError(undefined);
    setNotice("");
    const result = await query.refetch();
    if (result.error) setError(result.error);
    else if (result.data) {
      if (discard) {
        setDraft(initialSettings(result.data));
        setRevision(result.data.revision);
        setDirty(false);
        setConflict(false);
      }
      setNotice("Сохранённые данные обновлены");
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !snapshot?.enabled || !admin || saving || conflict) return;
    if (
      groups.some(
        ([id]) =>
          !Number.isInteger(draft[id].interval_seconds) ||
          draft[id].interval_seconds < 5 ||
          draft[id].interval_seconds > 86400,
      )
    ) {
      setError(
        new Error(
          "Интервал каждой группы должен быть целым числом от 5 до 86400 секунд",
        ),
      );
      return;
    }
    setSaving(true);
    setError(undefined);
    setNotice("");
    try {
      const saved = await api<Snapshot>(base + "/settings", "PUT", {
        revision,
        groups: draft,
      });
      queryClient.setQueryData([base], saved);
      setDraft(initialSettings(saved));
      setRevision(saved.revision);
      setDirty(false);
      setNotice("Настройки сбора сохранены");
    } catch (failure) {
      if (failure instanceof APIError && failure.code === "revision_conflict")
        setConflict(true);
      setError(failure);
    } finally {
      setSaving(false);
    }
  }
  const href = snapshot ? safeURL(snapshot.url) : undefined;
  const hostname = href ? new URL(href).hostname : "Адрес источника недоступен";
  return (
    <div className="modules-page mailcow-module">
      <div className="page-title">
        <div>
          <h1>Почта</h1>
          <p>{snapshot?.name || "Mailcow"}</p>
        </div>
        <div className="actions">
          <div className="segmented" role="group" aria-label="Разделы почты">
            {(
              [
                ["overview", "Обзор"],
                ["collection", "Сбор данных"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={tab === value ? "default" : "ghost"}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            onClick={() => void reload()}
            disabled={query.isFetching || saving}
          >
            Обновить данные
          </Button>
          <a className="button button-secondary" href="#modules">
            К модулям
          </a>
        </div>
      </div>
      <ActionFeedback notice={notice} error={error} />
      {query.error && (
        <ErrorBox error={query.error} retry={() => void reload()} />
      )}
      {!snapshot ? (
        query.isLoading ? (
          <p role="status">Загружаем данные почты…</p>
        ) : null
      ) : (
        <>
          <section
            className="panel mailcow-source-bar"
            aria-label="Источник Mailcow"
          >
            <Mail
              className="mailcow-server-icon"
              size={24}
              aria-hidden="true"
            />
            <div className="mailcow-server-name">
              <h2>{hostname}</h2>
              <span>
                Загружено:{" "}
                {timestamp(
                  query.dataUpdatedAt
                    ? new Date(query.dataUpdatedAt).toISOString()
                    : null,
                )}
                {!snapshot.enabled ? " · Подключение отключено" : ""}
              </span>
            </div>
            <Badge value="info">mailcow</Badge>
            {href && (
              <a
                className="button button-secondary"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title="Собственный вход Mailcow"
              >
                Открыть Mailcow
              </a>
            )}
          </section>
          {tab === "overview" ? (
            <MailSummary snapshot={snapshot} />
          ) : (
            <>
              <Panel title="Источник и сбор данных">
                <p className="module-endpoint">
                  {href || "Адрес источника недоступен"}
                </p>
                <p className="module-hint">
                  Нативный интерфейс использует собственный вход Mailcow. Данные
                  ниже сохранены Платформой; обновление страницы не запускает
                  опрос Mailcow.
                </p>
                {!snapshot.enabled && (
                  <p className="module-hint">
                    Подключение отключено. Сбор остановлен; сохранённые данные
                    остаются доступны.
                  </p>
                )}
              </Panel>
              <h2 className="mailcow-section-title">
                Состояние групп и подробности
              </h2>
              <div className="mailcow-groups">
                {groups.map(([id, label]) => {
                  const group = snapshot.groups[id];
                  const status = groupStatus(group, snapshot.enabled);
                  return (
                    <Panel
                      key={id}
                      title={label}
                      action={
                        <Badge
                          value={
                            status === "unsupported" || status === "disabled"
                              ? "unknown"
                              : status
                          }
                        >
                          {statusLabels[status] || "Состояние неизвестно"}
                        </Badge>
                      }
                    >
                      <Metrics
                        items={[
                          [
                            "Последний успешный сбор",
                            timestamp(group.last_success_at),
                          ],
                          [
                            "Последняя попытка",
                            timestamp(group.last_attempt_at),
                          ],
                          [
                            "Результат попытки",
                            statusLabels[group.last_attempt_status] ||
                              attemptLabels[group.last_attempt_status] ||
                              (group.last_attempt_status
                                ? "Результат неизвестен"
                                : "Ещё не было"),
                          ],
                        ]}
                      />
                      {group.error_code && (
                        <p className="module-hint">
                          {errorLabels[group.error_code] ||
                            "Не удалось получить данные группы"}
                        </p>
                      )}
                      {group.stale && (
                        <p className="module-hint">
                          Данные устарели. Показан последний сохранённый
                          результат.
                        </p>
                      )}
                      {group.data && status !== "ok" && !group.stale && (
                        <p className="module-hint">
                          Показан последний сохранённый результат, он не
                          подтверждает текущее состояние.
                        </p>
                      )}
                      {group.data ? (
                        <details className="mailcow-group-data">
                          <summary>Данные группы</summary>
                          <GroupData id={id} data={group.data} />
                        </details>
                      ) : (
                        <Empty
                          title="Нет данных"
                          detail={
                            group.enabled
                              ? "У этой группы ещё нет успешного результата сбора."
                              : "Включите группу в настройках сбора."
                          }
                        />
                      )}
                    </Panel>
                  );
                })}
              </div>
              {admin && draft && (
                <Panel title="Настройки сбора">
                  <p className="module-hint">
                    Включите нужные группы. Интервал каждой группы — от 5 до
                    86400 секунд. Сбор выполняет Платформа через штатный
                    read-only API Mailcow.
                  </p>
                  <form onSubmit={(event) => void save(event)}>
                    <fieldset
                      className="mailcow-settings"
                      disabled={saving || !snapshot.enabled}
                    >
                      <legend className="sr-only">
                        Группы и интервалы сбора
                      </legend>
                      {groups.map(([id, label]) => (
                        <div className="mailcow-setting" key={id}>
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={draft[id].enabled}
                              onChange={(event) =>
                                change(id, { enabled: event.target.checked })
                              }
                            />
                            {label}
                          </label>
                          <Field label={`${label}: интервал, с`}>
                            <input
                              type="number"
                              min={5}
                              max={86400}
                              step={1}
                              required
                              value={
                                Number.isFinite(draft[id].interval_seconds)
                                  ? draft[id].interval_seconds
                                  : ""
                              }
                              onChange={(event) =>
                                change(id, {
                                  interval_seconds: event.target.valueAsNumber,
                                })
                              }
                            />
                          </Field>
                        </div>
                      ))}
                    </fieldset>
                    {conflict && (
                      <p className="module-hint">
                        Настройки изменены другим администратором. Черновик
                        сохранён на экране. Загрузите актуальные настройки перед
                        повторным редактированием; это заменит черновик.
                      </p>
                    )}
                    <div className="actions">
                      <Button
                        variant="default"
                        type="submit"
                        disabled={
                          !dirty || saving || conflict || !snapshot.enabled
                        }
                      >
                        {saving ? "Сохраняем…" : "Сохранить настройки"}
                      </Button>
                      {(dirty || conflict) && (
                        <Button
                          onClick={() => void reload(true)}
                          disabled={saving || query.isFetching}
                        >
                          Загрузить актуальные настройки
                        </Button>
                      )}
                    </div>
                  </form>
                </Panel>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
