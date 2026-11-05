import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowRight, X } from "lucide-react";
import { api, date, useAPI } from "./api";
import { Button } from "./components/ui/button";
import { Empty, ErrorBox, ExternalLink, JSONView } from "./components/common";
import { useHelpTopic } from "./Help";
import type { Integration, Resource, Session } from "./types";
import "./events.css";
import { OperationsTimeline } from "./WorkspaceOperations";

export type JournalEvent = {
  id: string;
  kind: string;
  title: string;
  created_at: string;
  occurred_at?: string;
  time_basis?: string;
  source?: string;
  source_name?: string;
  severity?: string;
  resource_id?: string;
  resource_name?: string;
  actor?: string;
  actor_name?: string;
  details?: Record<string, unknown>;
  unread?: boolean;
  event_type?: string;
  source_stale?: boolean;
  received_at?: string;
  object_kind?: string;
  object_id?: string;
  object_name?: string;
  action?: string;
  job_kind?: string;
};

function localInputValue(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function exactTime(value: string, timezone?: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}
function eventTime(event: JournalEvent) {
  return event.occurred_at || event.created_at;
}
function eventSource(event: JournalEvent) {
  return (
    event.source_name ||
    {
      prometheus: "Prometheus",
      alertmanager: "Alertmanager",
      platform: "Платформа",
    }[event.source || ""] ||
    event.source ||
    "Платформа"
  );
}
function eventTone(event: JournalEvent) {
  if (event.event_type === "recovery") return "success";
  if (event.event_type === "problem")
    return event.severity === "warning" ? "warning" : "danger";
  if (/resolved|recovered|restored|healthy/.test(event.kind)) return "success";
  if (event.severity === "critical" || /firing|down/.test(event.kind))
    return "danger";
  if (event.severity === "warning" || /unavailable|failed/.test(event.kind))
    return "warning";
  return "info";
}
function eventKind(event: JournalEvent) {
  const label = (
    {
      problem: "Проблема",
      recovery: "Восстановление",
      connection: "Связь с источником",
      discovery: "Обнаружение",
      operation: "Операция",
      change: "Изменение",
    } as Record<string, string>
  )[event.event_type || ""];
  if (label) return label;
  if (/resolved|recovered|restored|healthy/.test(event.kind))
    return "Восстановление";
  if (/firing|down/.test(event.kind)) return "Проблема";
  if (/integration|source/.test(event.kind)) return "Связь с источником";
  if (/discover|candidate/.test(event.kind)) return "Обнаружение";
  if (/job|operation/.test(event.kind)) return "Операция";
  return "Изменение";
}

function eventActor(event: JournalEvent) {
  return (
    event.actor_name?.trim() ||
    (event.actor === "system" || event.actor?.startsWith("system:")
      ? `Система${event.actor?.startsWith("system:") ? ` · ${event.actor.slice(7)}` : ""}`
      : "Имя не указано")
  );
}

const auditObjects: Record<string, string> = {
  preferences: "Личные настройки",
  dashboard_layout: "Раскладка рабочего пространства",
  workspace_preferences: "Настройки систем",
  settings: "Настройки Платформы",
  dictionaries: "Справочники",
  integration: "Источник",
  resource: "Ресурс",
  collection: "Подборка",
  session: "Сессия Платформы",
  job: "Операция",
};
function auditObjectKind(event: JournalEvent) {
  return event.object_kind || event.kind.split(".")[0];
}
function auditObject(event: JournalEvent, resourceName?: string) {
  const kind = auditObjectKind(event);
  if (event.object_name?.trim()) return event.object_name.trim();
  if (kind === "resource" && resourceName) return resourceName;
  if (
    kind === "job" &&
    typeof event.details?.target === "string" &&
    event.details.target.trim()
  )
    return event.details.target.trim();
  return auditObjects[kind] || "Объект не указан";
}
function auditTitle(event: JournalEvent) {
  const kind = auditObjectKind(event);
  if (event.kind === "auth.login" || event.action === "login")
    return "Вход в Платформу";
  const title = event.title?.trim();
  if (
    title &&
    ![
      "Изменена запись",
      "Удалена запись",
      "Задание поставлено в очередь",
    ].includes(title) &&
    !title.startsWith("Завершено задание:")
  )
    return title;
  if (kind === "job" || event.kind.startsWith("job.")) {
    const jobKind =
      event.job_kind ||
      (typeof event.details?.kind === "string" ? event.details.kind : "");
    const action =
      (
        {
          check: "Проверка",
          enrich: "Уточнение данных",
          report: "Формирование отчёта",
          restart: "Перезапуск",
          refresh: "Обновление источника",
        } as Record<string, string>
      )[jobKind] || "Операция";
    const status = event.kind.split(".")[1];
    const outcome = (
      {
        queued: "в очереди",
        running: "выполняется",
        succeeded: "завершено",
        failed: "ошибка",
        unknown: "результат неизвестен",
      } as Record<string, string>
    )[status];
    return outcome ? `${action} — ${outcome}` : action;
  }
  const saved: Record<string, string> = {
    preferences: "Обновлены личные настройки",
    dashboard_layout: "Обновлена раскладка рабочего пространства",
    workspace_preferences: "Обновлены настройки систем",
    settings: "Обновлены настройки Платформы",
    dictionaries: "Обновлены справочники",
    integration: "Обновлён источник",
    resource: "Обновлён ресурс",
    collection: "Обновлена подборка",
  };
  if (event.action === "created") {
    const created: Record<string, string> = {
      preferences: "Сохранены личные настройки",
      dashboard_layout: "Сохранена раскладка рабочего пространства",
      workspace_preferences: "Сохранены настройки систем",
      integration: "Добавлен источник",
      resource: "Создан ресурс",
      collection: "Создана подборка",
    };
    return created[kind] || "Созданы данные";
  }
  if (event.action === "saved" || event.kind.endsWith(".saved"))
    return saved[kind] || "Обновлены данные";
  if (event.action === "deleted" || event.kind.endsWith(".deleted"))
    return kind === "resource"
      ? "Удалён ресурс"
      : kind === "collection"
        ? "Удалена подборка"
        : "Удалены данные";
  return "Действие в Платформе";
}

function EventRow({
  event,
  audit,
  selected,
  resourceName,
  scrollRoot,
  onSelect,
  onSeen,
}: {
  event: JournalEvent;
  audit: boolean;
  selected: boolean;
  resourceName?: string;
  scrollRoot: HTMLDivElement | null;
  onSelect: () => void;
  onSeen: (id: string) => Promise<void>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  const [hadNew, setHadNew] = useState(!!event.unread);
  useEffect(() => {
    if (event.unread) setHadNew(true);
  }, [event.unread]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !event.unread || seen) return;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let sending = false;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const start = () => {
      cancel();
      if (!visible || document.hidden || sending) return;
      timer = setTimeout(() => {
        if (!visible || document.hidden || disposed) return;
        sending = true;
        void onSeen(event.id)
          .then(() => {
            if (!disposed) setSeen(true);
          })
          .catch(() => {
            // Failed acknowledgements stay new and can be retried after another visibility interval.
          })
          .finally(() => {
            sending = false;
          });
      }, 3000);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextVisible =
          entry.isIntersecting && entry.intersectionRatio >= 0.9;
        if (visible !== nextVisible) {
          visible = nextVisible;
          start();
        }
      },
      { root: scrollRoot, threshold: [0, 0.9, 1] },
    );
    const visibility = () => start();
    observer.observe(element);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      cancel();
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [event.id, event.unread, onSeen, scrollRoot, seen]);
  const isNew = !!event.unread && !seen;
  return (
    <button
      ref={ref}
      type="button"
      className={`events-entry ${selected ? "is-selected" : ""} ${isNew ? "is-new" : "is-seen"}`}
      aria-pressed={selected}
      onClick={onSelect}
      data-event-id={event.id}
    >
      <span>
        <time dateTime={eventTime(event)}>{date(eventTime(event))}</time>
        {event.time_basis === "observed" && <small>обнаружено</small>}
      </span>
      <span>
        <strong>
          {audit ? auditTitle(event) : event.title}
          {hadNew && (
            <span className="events-new-label" aria-hidden={!isNew}>
              Новое
            </span>
          )}
        </strong>
        {audit && (
          <small className="events-row-author">
            Автор: {eventActor(event)}
          </small>
        )}
        <span className={`events-tone events-tone-${eventTone(event)}`}>
          {audit ? "Действие" : eventKind(event)}
        </span>
        <small className="events-compact-source">{eventSource(event)}</small>
        {event.source_stale && <small>Данные устарели</small>}
      </span>
      <span>
        {audit
          ? auditObject(event, resourceName)
          : resourceName ||
            event.resource_name ||
            (event.kind.startsWith("source.")
              ? "Источник мониторинга"
              : "Без привязки к объекту")}
      </span>
      <span className="events-entry-source">{eventSource(event)}</span>
    </button>
  );
}

type JournalPage = {
  items: JournalEvent[];
  snapshot: string;
  next_cursor: string;
  total: number;
  new_count: number;
};
type JournalDetail = {
  event: JournalEvent;
  related: JournalEvent[];
  observation?: Record<string, unknown>;
};
const types = [
  ["problem", "Проблема"],
  ["recovery", "Восстановление"],
  ["connection", "Связь с источником"],
  ["discovery", "Обнаружение"],
  ["operation", "Операция"],
  ["change", "Изменение"],
];

export function Events({
  onResource,
}: { onResource?: (id: string) => void } = {}) {
  const [operations, setOperations] = useState(false);
  const [audit, setAudit] = useState(false);
  return (
    <>
      <div hidden={operations}>
        <EventJournal
          onResource={onResource}
          audit={audit}
          setAudit={setAudit}
          onOperations={() => setOperations(true)}
        />
      </div>
      <div hidden={!operations}>
        <OperationsTimeline
          active={operations}
          onJournal={(nextAudit) => {
            setAudit(nextAudit);
            setOperations(false);
            window.dispatchEvent(new Event("resize"));
          }}
        />
      </div>
    </>
  );
}

function EventJournal({
  onResource,
  audit,
  setAudit,
  onOperations,
}: {
  onResource?: (id: string) => void;
  audit: boolean;
  setAudit: (value: boolean) => void;
  onOperations: () => void;
}) {
  useHelpTopic(audit ? "audit" : "events", 1);
  const channel = audit ? "audit" : "events";
  const session = useAPI<Session>("/session");
  const resources = useAPI<Resource[]>("/resources");
  const integrations = useAPI<Integration[]>("/integrations");
  const [resource, setResource] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1] || "").get(
        "resource_id",
      ) || "",
  );
  const [source, setSource] = useState("");
  const [type, setType] = useState("");
  const [hours, setHours] = useState("24");
  const [rangeFrom, setRangeFrom] = useState(() =>
    localInputValue(new Date(Date.now() - 86400000)),
  );
  const [rangeTo, setRangeTo] = useState(() => localInputValue(new Date()));
  const [customRange, setCustomRange] = useState(() => ({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date().toISOString(),
  }));
  const [periodError, setPeriodError] = useState("");
  function applyRange() {
    const from = new Date(rangeFrom),
      to = new Date(rangeTo);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from) {
      setPeriodError(
        "Укажите начало и конец периода. Конец должен быть позже начала.",
      );
      return;
    }
    setPeriodError("");
    setCustomRange({ from: from.toISOString(), to: to.toISOString() });
  }
  const [quick, setQuick] = useState(false);
  const [showCollection, setShowCollection] = useState(false);
  const [showServiceRefresh, setShowServiceRefresh] = useState(false);
  const [actor, setActor] = useState("");
  const [page, setPage] = useState<JournalPage>();
  const [selected, setSelected] = useState<JournalEvent>();
  const [detail, setDetail] = useState<JournalDetail>();
  const [detailError, setDetailError] = useState<unknown>();
  const [detailRevision, setDetailRevision] = useState(0);
  const [error, setError] = useState<unknown>();
  const [seenError, setSeenError] = useState<unknown>();
  const [seenRetry, setSeenRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [retry, setRetry] = useState(0);
  const workspace = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const snapshot = useRef<JournalPage | undefined>(undefined);
  const generation = useRef(0);
  const query = useRef("");
  const [height, setHeight] = useState(650);
  const [pollError, setPollError] = useState<unknown>();

  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const measure = () => {
      const main = element.closest("main");
      const footer = main?.parentElement?.querySelector(".app-footer");
      const bottom = main
        ? parseFloat(getComputedStyle(main).paddingBottom)
        : 30;
      const footerHeight = footer?.getBoundingClientRect().height || 0;
      setHeight(
        Math.max(
          280,
          window.innerHeight -
            element.getBoundingClientRect().top -
            bottom -
            footerHeight -
            1,
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    const main = element.closest("main");
    if (main) observer.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setError(undefined);
    void api("/event-journal/view", "POST", { initialize: true })
      .then(() => {
        if (active) setInitialized(true);
      })
      .catch((e) => {
        if (active) {
          setError(e);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [retry]);

  useEffect(() => {
    if (!initialized) return;
    const current = ++generation.current;
    const params = new URLSearchParams({ channel, limit: "50" });
    if (hours === "custom") {
      params.set("from", customRange.from);
      params.set("to", customRange.to);
    } else if (hours !== "all")
      params.set(
        "from",
        new Date(Date.now() - Number(hours) * 3600000).toISOString(),
      );
    if (resource) params.set("resource_id", resource);
    if (!audit && source) params.set("source", source);
    if (type && (!audit || type === "change" || type === "operation"))
      params.set("type", type);
    if (audit && actor.trim()) params.set("actor", actor.trim());
    if (!audit && quick) params.set("monitoring_only", "true");
    if (!audit && !showCollection) params.set("exclude_collection", "true");
    if (!showServiceRefresh) params.set("exclude_service_refresh", "true");
    query.current = params.toString();
    snapshot.current = undefined;
    setPage(undefined);
    setSelected(undefined);
    setDetail(undefined);
    setLoading(true);
    setError(undefined);
    setPollError(undefined);
    setBusy(false);
    if (scrollRoot) scrollRoot.scrollTop = 0;
    const controller = new AbortController();
    void api<JournalPage>(
      `/event-journal?${params}`,
      "GET",
      undefined,
      {},
      controller.signal,
    )
      .then((result) => {
        if (generation.current !== current) return;
        snapshot.current = result;
        setPage(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted && generation.current === current)
          setError(e);
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => controller.abort();
  }, [
    initialized,
    channel,
    resource,
    source,
    type,
    hours,
    customRange,
    quick,
    showCollection,
    showServiceRefresh,
    actor,
    retry,
  ]);

  useEffect(() => {
    if (!initialized) return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      const frozen = snapshot.current;
      if (!frozen || document.hidden || inFlight) return;
      const current = generation.current;
      inFlight = true;
      try {
        const params = new URLSearchParams(query.current);
        params.set("snapshot", frozen.snapshot);
        params.set("limit", "1");
        const result = await api<JournalPage>(`/event-journal?${params}`);
        if (
          !disposed &&
          current === generation.current &&
          snapshot.current?.snapshot === frozen.snapshot
        ) {
          setPage((value) =>
            value ? { ...value, new_count: result.new_count } : value,
          );
          setPollError(undefined);
        }
      } catch (e) {
        if (!disposed && current === generation.current) setPollError(e);
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), 15000);
    const visibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [initialized]);

  async function loadMore() {
    const frozen = snapshot.current;
    if (!frozen?.next_cursor || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(undefined);
    const params = new URLSearchParams(query.current);
    params.set("snapshot", frozen.snapshot);
    params.set("cursor", frozen.next_cursor);
    try {
      const result = await api<JournalPage>(`/event-journal?${params}`);
      if (current !== generation.current) return;
      const ids = new Set(frozen.items.map((item) => item.id));
      const updated = {
        ...result,
        items: [
          ...frozen.items,
          ...result.items.filter((item) => !ids.has(item.id)),
        ],
      };
      snapshot.current = updated;
      setPage(updated);
    } catch (e) {
      if (current === generation.current) setError(e);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function acceptNew() {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError(undefined);
    const root = scrollRoot;
    const anchor =
      root &&
      Array.from(root.querySelectorAll<HTMLElement>("[data-event-id]")).find(
        (el) =>
          el.getBoundingClientRect().bottom > root.getBoundingClientRect().top,
      );
    const anchorID = anchor?.dataset.eventId;
    const offset =
      anchor && root
        ? anchor.getBoundingClientRect().top - root.getBoundingClientRect().top
        : 0;
    const old = snapshot.current;
    const frozenQuery = query.current;
    try {
      // Reload the loaded window against a single new snapshot, retaining the scroll anchor.
      let result = await api<JournalPage>(`/event-journal?${frozenQuery}`);
      if (current !== generation.current) return;
      let combined = result.items;
      while (
        result.next_cursor &&
        (combined.length < (old?.items.length || 0) ||
          (!!anchorID && !combined.some((item) => item.id === anchorID)))
      ) {
        const params = new URLSearchParams(frozenQuery);
        params.set("snapshot", result.snapshot);
        params.set("cursor", result.next_cursor);
        result = await api<JournalPage>(`/event-journal?${params}`);
        if (current !== generation.current) return;
        combined = [...combined, ...result.items];
      }
      if (current !== generation.current) return;
      const updated = { ...result, items: combined };
      snapshot.current = updated;
      setPage(updated);
      setPollError(undefined);
      setDetailRevision((value) => value + 1);
      requestAnimationFrame(() => {
        if (!root || current !== generation.current) return;
        const next = Array.from(
          root.querySelectorAll<HTMLElement>("[data-event-id]"),
        ).find((el) => el.dataset.eventId === anchorID);
        if (next)
          root.scrollTop +=
            next.getBoundingClientRect().top -
            root.getBoundingClientRect().top -
            offset;
      });
    } catch (e) {
      if (current === generation.current) setError(e);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  const markSeen = useCallback(
    async (id: string) => {
      try {
        await api("/event-journal/view", "POST", { channel, ids: [id] });
        setSeenError(undefined);
      } catch (e) {
        setSeenError(e);
        throw e;
      }
    },
    [channel, seenRetry],
  );

  useEffect(() => {
    setDetail(undefined);
    setDetailError(undefined);
    if (!selected) return;
    const controller = new AbortController();
    void api<JournalDetail>(
      `/event-journal/${encodeURIComponent(selected.id)}?channel=${channel}`,
      "GET",
      undefined,
      {},
      controller.signal,
    )
      .then(setDetail)
      .catch((e) => {
        if (!controller.signal.aborted) setDetailError(e);
      });
    return () => controller.abort();
  }, [selected?.id, channel, detailRevision]);
  useEffect(() => {
    if (inspector.current) inspector.current.scrollTop = 0;
  }, [selected?.id]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"]')
      )
        setSelected(undefined);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const selectedEvent = detail?.event || selected;
  function isStale(event: JournalEvent) {
    if (event.source_stale) return true;
    const integrationID = event.details?.integration_id;
    if (typeof integrationID !== "string") return false;
    const integration = integrations.data?.find(
      (item) => item.id === integrationID,
    );
    return (
      !!integration &&
      (integration.enabled === false ||
        !!integration.error ||
        ["error", "disabled", "unavailable"].includes(integration.status))
    );
  }
  const name = (event: JournalEvent) =>
    event.object_name ||
    event.resource_name ||
    resources.data?.find((item) => item.id === event.resource_id)?.name;

  return (
    <div className="events-workspace" ref={workspace} style={{ height }}>
      <div className="page-title">
        <div>
          <h1>События</h1>
          <p>
            {audit
              ? "Действия пользователей Платформы"
              : "Последовательность изменений инфраструктуры и действий Платформы"}
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Режим журнала">
          <Button
            aria-pressed={!audit}
            variant={!audit ? "default" : "ghost"}
            onClick={() => setAudit(false)}
          >
            События
          </Button>
          <Button
            aria-pressed={audit}
            variant={audit ? "default" : "ghost"}
            onClick={() => setAudit(true)}
          >
            Аудит
          </Button>
          <Button variant="ghost" aria-pressed={false} onClick={onOperations}>
            Операции
          </Button>
        </div>
      </div>
      {!audit && (
        <label className="events-collection-toggle">
          <input
            type="checkbox"
            checked={showCollection}
            onChange={(event) => setShowCollection(event.target.checked)}
          />
          <span>Показывать переключения сбора метрик</span>
          <small>
            Отдельная ошибка сбора не доказывает недоступность устройства.
            Инциденты мониторинга показываются независимо.
          </small>
        </label>
      )}
      <label className="events-collection-toggle">
        <input
          type="checkbox"
          checked={showServiceRefresh}
          onChange={(event) => setShowServiceRefresh(event.target.checked)}
        />
        <span>Показывать успешные служебные обновления</span>
        <small>
          Ручные операции, ошибки и незавершённые задания показываются всегда.
          История сохраняется.
        </small>
      </label>
      <div className="events-filters">
        <label>
          Ресурс
          <select
            value={resource}
            onChange={(e) => setResource(e.target.value)}
          >
            <option value="">Все ресурсы</option>
            {resources.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {!audit && (
          <label>
            Источник
            <select
              aria-label="Источник"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Все источники</option>
              <option value="prometheus">Prometheus</option>
              <option value="alertmanager">Alertmanager</option>
              <option value="platform">Платформа</option>
            </select>
          </label>
        )}
        <label>
          Тип события
          <select
            aria-label="Тип события"
            value={
              audit && type !== "change" && type !== "operation" ? "" : type
            }
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">Все типы</option>
            {(audit
              ? [
                  ["change", "Действия и изменения"],
                  ["operation", "Операции"],
                ]
              : types
            ).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Период
          <select
            aria-label="Период"
            className="events-period"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          >
            <option value="24">Последние 24 часа</option>
            <option value="1">Последний час</option>
            <option value="168">Последние 7 дней</option>
            <option value="720">Последние 30 дней</option>
            <option value="all">Вся история</option>
            <option value="custom">Выбрать период</option>
          </select>
        </label>
        {hours === "custom" && (
          <>
            <label>
              С
              <input
                aria-label="Начало периода"
                type="datetime-local"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
              />
            </label>
            <label>
              По
              <input
                aria-label="Конец периода"
                type="datetime-local"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
              />
            </label>
            <Button onClick={applyRange}>Применить период</Button>
            <span className="events-count">
              Ввод: {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </span>
          </>
        )}
        {audit ? (
          <label>
            Автор
            <input
              placeholder="Имя или логин"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </label>
        ) : (
          <Button
            variant={quick ? "default" : "secondary"}
            aria-pressed={quick}
            onClick={() => setQuick((value) => !value)}
          >
            Проблемы и восстановления
          </Button>
        )}
        <span className="events-count" role="status">
          {loading ? "Загрузка…" : page ? `${page.total} записей` : ""}
        </span>
        {!!page?.new_count && (
          <Button
            className="events-new-button"
            disabled={busy}
            onClick={() => void acceptNew()}
          >
            Новых событий: {page.new_count}
          </Button>
        )}
      </div>
      {!!periodError && hours === "custom" && (
        <p role="alert" className="events-period-error">
          {periodError}
        </p>
      )}
      {!!resources.error && (
        <div className="events-banner">
          <ErrorBox
            error={resources.error}
            retry={() => void resources.refetch()}
          />
        </div>
      )}
      {!!pollError && (
        <div className="events-banner">
          <ErrorBox error={pollError} retry={() => void acceptNew()} />
        </div>
      )}
      {!!seenError && (
        <div className="events-banner">
          <ErrorBox
            error={seenError}
            retry={() => {
              setSeenError(undefined);
              setSeenRetry((value) => value + 1);
            }}
          />
        </div>
      )}
      <div className="events-split">
        <section
          className="events-list"
          aria-label={audit ? "Журнал аудита" : "Журнал событий"}
        >
          <div className="events-tablehead">
            <span>Время события</span>
            <span>Событие</span>
            <span>Объект</span>
            <span className="events-table-source">Источник</span>
          </div>
          <div className="events-list-scroll" ref={setScrollRoot}>
            {loading ? (
              <div className="events-loading" role="status">
                Загрузка событий…
              </div>
            ) : (
              <>
                {!!error && (
                  <ErrorBox
                    error={error}
                    retry={() => {
                      if (!initialized || !page) setRetry((value) => value + 1);
                      else void acceptNew();
                    }}
                  />
                )}
                {page?.items.map((event) => (
                  <EventRow
                    key={`${channel}:${event.id}`}
                    event={{ ...event, source_stale: isStale(event) }}
                    audit={audit}
                    selected={selected?.id === event.id}
                    resourceName={name(event)}
                    scrollRoot={scrollRoot}
                    onSelect={() => setSelected(event)}
                    onSeen={markSeen}
                  />
                ))}
                {page && !page.items.length && (
                  <Empty
                    title="Нет событий по выбранным фильтрам"
                    detail="Измените период, объект или тип события."
                  />
                )}
                {!!page?.next_cursor && (
                  <div className="events-pagination">
                    <Button disabled={busy} onClick={() => void loadMore()}>
                      {busy ? "Загрузка…" : "Показать ещё"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
        <aside
          className="events-inspector"
          ref={inspector}
          aria-label="Детали события"
        >
          {!selectedEvent ? (
            <div className="events-inspector-empty">
              <h2>Детали события</h2>
              <p>
                Выберите запись слева, чтобы посмотреть подробности и связанные
                события.
              </p>
            </div>
          ) : (
            <>
              <Button
                className="events-close"
                variant="ghost"
                size="icon"
                aria-label="Закрыть детали"
                onClick={() => setSelected(undefined)}
              >
                <X size={18} />
              </Button>
              <div className="events-detail-heading">
                <small>{eventSource(selectedEvent)}</small>
                <h2>
                  {audit ? auditTitle(selectedEvent) : selectedEvent.title}
                </h2>
                <span
                  className={`events-tone events-tone-${eventTone(selectedEvent)}`}
                >
                  {audit ? "Действие пользователя" : eventKind(selectedEvent)}
                </span>
              </div>
              {isStale(selectedEvent) && (
                <p className="notice">
                  Данные устарели. Сохранено последнее известное состояние.
                </p>
              )}
              <section>
                <h3>Что произошло</h3>
                {typeof selectedEvent.details?.description === "string" && (
                  <p>{selectedEvent.details.description}</p>
                )}
                {typeof selectedEvent.details?.result_summary === "string" && (
                  <p>{selectedEvent.details.result_summary}</p>
                )}
                {typeof selectedEvent.details?.error === "string" && (
                  <p className="notice">{selectedEvent.details.error}</p>
                )}
                <dl>
                  <dt>Объект</dt>
                  <dd>
                    {audit
                      ? auditObject(selectedEvent, name(selectedEvent))
                      : name(selectedEvent) ||
                        (selectedEvent.kind.startsWith("source.")
                          ? "Источник мониторинга"
                          : "Без привязки к объекту")}
                  </dd>
                  <dt>Время события</dt>
                  <dd>
                    <time dateTime={eventTime(selectedEvent)}>
                      {exactTime(
                        eventTime(selectedEvent),
                        session.data?.timezone,
                      )}
                    </time>
                    {selectedEvent.time_basis === "observed" && (
                      <small>По времени обнаружения</small>
                    )}
                  </dd>
                  {audit && (
                    <>
                      <dt>Автор</dt>
                      <dd>{eventActor(selectedEvent)}</dd>
                    </>
                  )}
                </dl>
                {selectedEvent.resource_id &&
                  (!audit ||
                    ["resource", "job"].includes(
                      auditObjectKind(selectedEvent),
                    )) && (
                    <p>
                      <Button
                        disabled={
                          !onResource ||
                          !resources.data?.some(
                            (resource) =>
                              resource.id === selectedEvent.resource_id,
                          )
                        }
                        onClick={() => onResource?.(selectedEvent.resource_id!)}
                      >
                        {resources.data?.some(
                          (resource) =>
                            resource.id === selectedEvent.resource_id,
                        ) ? (
                          <>
                            Открыть объект <ArrowRight size={14} />
                          </>
                        ) : (
                          "Объект недоступен в каталоге"
                        )}
                      </Button>
                    </p>
                  )}
                {typeof selectedEvent.details?.source_url === "string" && (
                  <p>
                    <ExternalLink url={selectedEvent.details.source_url}>
                      Открыть источник
                    </ExternalLink>
                  </p>
                )}
              </section>
              {!detail && !detailError && (
                <p role="status">Загрузка подробностей…</p>
              )}
              {!!detailError && (
                <ErrorBox
                  error={detailError}
                  retry={() => setDetailRevision((value) => value + 1)}
                />
              )}
              {!audit && !!detail?.related?.length && (
                <section>
                  <h3>Связанные события</h3>
                  {detail.related.map((event) => (
                    <button
                      key={event.id}
                      className="events-related"
                      onClick={() => setSelected(event)}
                    >
                      <strong>{event.title}</strong>
                      <small>
                        {date(eventTime(event))} · {eventSource(event)}
                      </small>
                    </button>
                  ))}
                </section>
              )}
              {detail?.observation && (
                <section>
                  <h3>Подтверждения</h3>
                  <dl>
                    <dt>Подтверждений</dt>
                    <dd>
                      {typeof detail.observation.confirmations === "number"
                        ? detail.observation.confirmations
                        : "Нет данных"}
                    </dd>
                    <dt>Последнее подтверждение</dt>
                    <dd>
                      {typeof detail.observation.last_confirmed_at === "string"
                        ? date(detail.observation.last_confirmed_at)
                        : "Нет данных"}
                    </dd>
                  </dl>
                </section>
              )}
              <section>
                <details>
                  <summary>Технические поля и исходные данные</summary>
                  <JSONView
                    value={{
                      ...selectedEvent,
                      observation: detail?.observation,
                    }}
                  />
                </details>
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
