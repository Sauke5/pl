import { useHelpTopic } from "./Help";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Link,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { api, date, errorText, queryClient, useAPI } from "./api";
import type { Integration, Resource } from "./types";
import type { PresentedProblem, ProblemPresentation } from "./workspaceTypes";
import type { ResourceActions } from "./Catalog";
import type { JournalEvent } from "./Events";
import { Button } from "./components/ui/button";
import {
  Badge,
  Empty,
  ErrorBox,
  ExternalLink,
  JSONView,
} from "./components/common";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { ProblemLinks } from "./ProblemLinks";
import { isProblemMuted, requiresAttention } from "./problemVisibility";
import { openWorkspaceCheck } from "./WorkspaceChecks";
import { settingsHash } from "./settings/model";

export function openWorkspaceProblems() {
  window.dispatchEvent(new Event("pl-ui-workspace-problems"));
}

function ProblemPanel({
  problem,
  resources,
  sources,
  actions,
  onClose,
}: {
  problem: PresentedProblem;
  resources: Resource[];
  sources: Integration[];
  actions: ResourceActions;
  onClose: () => void;
}) {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const policy = useAPI<ProblemPresentation>("/problem-presentation");
  const journal = useAPI<JournalEvent[]>("/events");
  const related =
    journal.data?.filter(
      (event) =>
        event.details?.problem_id === problem.id ||
        (event.details?.external_id === problem.external_id &&
          event.details?.integration_id === problem.integration_id),
    ) || [];
  const ids = problem.resource_ids?.length
    ? problem.resource_ids
    : problem.resource_id
      ? [problem.resource_id]
      : [];
  const linked = resources.filter((resource) => ids.includes(resource.id));
  const source = sources.find((source) => source.id === problem.integration_id);
  async function changeVisibility() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/problems/${problem.id}/visibility`, "PUT", {
        hidden: !problem.hidden,
        expected_started_at: problem.started_at,
      });
      await queryClient.invalidateQueries({
        queryKey: ["/workspace-problems"],
      });
      await queryClient.invalidateQueries({ queryKey: ["/problems"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function refreshSource() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/integrations/${problem.integration_id}/refresh`, "POST", {});
      await queryClient.invalidateQueries();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function changeMarketing() {
    if (!policy.data) return;
    setBusy(true);
    setError(undefined);
    try {
      const instance = problem.labels?.instance || "";
      let targets = policy.data.targets;
      let resourceIDs = policy.data.resource_ids;
      if (problem.marketing) {
        targets = targets.filter(
          (target) =>
            !(
              target.integration_id === problem.integration_id &&
              normalizedTarget(target.instance) === normalizedTarget(instance)
            ),
        );
        resourceIDs = resourceIDs.filter((id) => !ids.includes(id));
      } else if (normalizedTarget(instance)) {
        targets = [
          ...targets,
          { integration_id: problem.integration_id, instance },
        ];
      } else if (ids.length) {
        resourceIDs = [...new Set([...resourceIDs, ...ids])];
      } else
        throw new Error(
          "Сначала добавь адрес сайта или свяжи проблему с ресурсом.",
        );
      const result = await api<ProblemPresentation>(
        "/problem-presentation",
        "PUT",
        { ...policy.data, targets, resource_ids: resourceIDs },
      );
      queryClient.setQueryData(["/problem-presentation"], result);
      await queryClient.invalidateQueries({
        queryKey: ["/workspace-problems"],
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkspaceDrawer
      helpTopic="problem-details"
      title={problem.title}
      subtitle="Текущая неисправность"
      onClose={onClose}
    >
      <div className="actions">
        <Badge value={problem.status} />
        <Badge value={problem.severity} />
        {problem.stale && <Badge value="stale" />}
        {problem.hidden && <Badge value="unknown">Скрыта</Badge>}
        {isProblemMuted(problem) && !problem.hidden && (
          <Badge value="unknown">Приглушена источником</Badge>
        )}
      </div>
      <p>{problem.description || "Источник не передал описание."}</p>
      <dl className="detail-grid">
        <div>
          <dt>Начало</dt>
          <dd>{date(problem.started_at)}</dd>
        </div>
        <div>
          <dt>Последнее подтверждение</dt>
          <dd>{date(problem.last_seen)}</dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>{source?.name || "Источник не найден"}</dd>
        </div>
        <div>
          <dt>Связь с источником</dt>
          <dd>
            <Badge value={source?.status || "unknown"} />
          </dd>
        </div>
      </dl>
      {(problem.stale || source?.status === "error") && (
        <p className="notice">
          Источник пока не обновился. Сейчас здесь последние полученные данные.
        </p>
      )}
      <section className="workspace-section">
        <h3>Ресурсы и диагностика</h3>
        {linked.map((resource) => (
          <div className="simple-row" key={resource.id}>
            <div>
              <strong>{resource.name}</strong>
              <small>{resource.description || resource.hostname}</small>
            </div>
            <div className="actions">
              <Button size="sm" onClick={() => actions.onDetails(resource)}>
                Карточка
              </Button>
              <Button size="sm" onClick={() => openWorkspaceCheck(resource)}>
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
        {!linked.length && (
          <p className="muted">
            У проблемы пока нет связанных ресурсов. Добавь связь или проверь
            адрес вручную.
          </p>
        )}
        <div className="actions">
          <Button size="sm" onClick={() => setLinking(true)}>
            <Link size={15} />
            Настроить связи
          </Button>
          <Button size="sm" onClick={() => openWorkspaceCheck()}>
            Проверить адрес
          </Button>
          {problem.source_url && (
            <ExternalLink url={problem.source_url} className="button button-sm">
              Открыть источник
            </ExternalLink>
          )}
        </div>
      </section>
      <section className="workspace-section">
        <h3>История проблемы</h3>
        {journal.error && (
          <ErrorBox
            error={journal.error}
            retry={() => void journal.refetch()}
          />
        )}
        {related.map((event) => (
          <div className="simple-row" key={event.id}>
            <span>{event.title}</span>
            <small>{date(event.occurred_at || event.created_at)}</small>
          </div>
        ))}
        {!journal.isPending && !related.length && (
          <p className="muted">
            Среди последних событий связанных записей нет. Открой журнал, чтобы
            посмотреть всю историю.
          </p>
        )}
        <a
          className="button button-sm"
          href={`#events${problem.resource_id ? `?resource_id=${encodeURIComponent(problem.resource_id)}` : ""}`}
        >
          Открыть события <ArrowRight size={14} />
        </a>
      </section>
      <section className="workspace-section">
        <h3>Отображение</h3>
        <p className="muted">
          Сайты маркетинга лежат в отдельном свёрнутом списке. Счётчик проблем
          их пропускает, уведомлениями по-прежнему управляет Alertmanager.
        </p>
        <Button
          disabled={busy || !policy.data}
          onClick={() => void changeMarketing()}
        >
          {problem.marketing
            ? "Вернуть в общий список инфраструктуры"
            : "Отнести к публичным сайтам маркетинга"}
        </Button>
        {policy.error && <ErrorBox error={policy.error} />}
        {problem.status === "firing" && (
          <Button disabled={busy} onClick={() => void changeVisibility()}>
            {problem.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
            {problem.hidden
              ? "Вернуть в требующие внимания"
              : "Скрыть из требующих внимания"}
          </Button>
        )}
      </section>
      <details className="workspace-section">
        <summary>Технические подробности</summary>
        <JSONView
          value={{ external_id: problem.external_id, labels: problem.labels }}
        />
      </details>
      {!!error && <ErrorBox error={error} />}
      <div className="workspace-section">
        <Button disabled={busy} onClick={() => void refreshSource()}>
          <RefreshCw size={15} />
          Повторно получить данные источника
        </Button>
      </div>
      {linking && (
        <ProblemLinks
          problem={problem}
          resources={resources}
          onClose={() => {
            setLinking(false);
            void queryClient.invalidateQueries({
              queryKey: ["/workspace-problems"],
            });
          }}
        />
      )}
    </WorkspaceDrawer>
  );
}

function normalizedTarget(value: string) {
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function duration(value: string) {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "Длительность неизвестна";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  return minutes < 60
    ? `${minutes} мин`
    : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function alertSourceNotice(sources: Integration[], active: PresentedProblem[]) {
  const configured = sources.filter((source) => source.kind === "alertmanager");
  const connections = "/" + settingsHash({ section: "integrations" });
  if (!configured.length)
    return {
      title: "Alertmanager не подключён",
      detail:
        "Установите модуль на хосте PL или добавьте подключение к вашему серверу Alertmanager.",
      links: [
        { href: "/#module-catalog", label: "Открыть каталог модулей" },
        { href: connections, label: "Подключить существующий Alertmanager" },
      ],
    };
  const enabled = configured.filter((source) => source.enabled);
  const staleSources = new Set(
    active
      .filter((problem) => problem.stale)
      .map((problem) => problem.integration_id),
  );
  const incomplete = enabled.filter((source) => {
    const lastSuccess = Date.parse(source.last_success || "");
    return (
      source.status !== "connected" ||
      !Number.isFinite(lastSuccess) ||
      Date.now() - lastSuccess > Math.max(180000, source.poll_seconds * 3000) ||
      staleSources.has(source.id)
    );
  });
  if (enabled.length && !incomplete.length && !staleSources.size) return;
  const affected = enabled.length ? incomplete : configured;
  const source = affected.length === 1 ? affected[0] : undefined;
  const link = source?.managed_module_id
    ? {
        href:
          "/#modules?instance=" + encodeURIComponent(source.managed_module_id),
        label: "Открыть модуль",
      }
    : {
        href:
          "/" +
          settingsHash({ section: "integrations", integration: source?.id }),
        label: source ? "Открыть подключение" : "Открыть подключения",
      };
  if (!enabled.length)
    return {
      title: "Alertmanager отключён",
      detail: source
        ? `Включите «${source.name}», чтобы видеть новые оповещения в PL.`
        : "Включите один из источников, чтобы видеть новые оповещения в PL.",
      links: [link],
    };
  let detail = "В списке есть неисправности с устаревшими данными.";
  if (source) {
    const lastUpdate = Number.isFinite(Date.parse(source.last_success || ""))
      ? `Последнее успешное обновление — ${date(source.last_success)}.`
      : "Ожидается первое успешное обновление.";
    detail =
      source.status === "error"
        ? `Ошибка опроса источника «${source.name}». ${lastUpdate}`
        : `Источник «${source.name}». ${lastUpdate}`;
  } else if (incomplete.length) {
    detail = `Источников без актуальных данных — ${incomplete.length}.`;
  }
  return {
    title: "Данные Alertmanager требуют проверки",
    detail,
    links: [link],
  };
}

export function WorkspaceProblemIndicator({
  actions,
}: {
  actions: ResourceActions;
}) {
  const problems = useAPI<PresentedProblem[]>("/workspace-problems");
  const sources = useAPI<Integration[]>("/integrations");
  const resources = useAPI<Resource[]>("/resources");
  const [open, setOpen] = useState(false);
  useHelpTopic(open ? "problems" : undefined, open ? 2 : -1);
  const [muted, setMuted] = useState(false);
  const [selected, setSelected] = useState<PresentedProblem>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState({ top: 90, right: 24 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const bounds = root.current?.getBoundingClientRect();
      if (bounds)
        setAnchor({
          top: bounds.bottom + 12,
          right: Math.max(16, window.innerWidth - bounds.right),
        });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("pl-ui-workspace-problems", show);
    if (location.hash.split("?")[0] === "#problems") setOpen(true);
    return () => window.removeEventListener("pl-ui-workspace-problems", show);
  }, []);
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const active = (problems.data || []).filter(
    (problem) => !problem.marketing && requiresAttention(problem),
  );
  const rows = (problems.data || [])
    .filter(
      (problem) =>
        !problem.marketing &&
        (muted
          ? problem.status === "firing" && isProblemMuted(problem)
          : requiresAttention(problem)),
    )
    .sort(
      (a, b) =>
        (order[a.severity] ?? 3) - (order[b.severity] ?? 3) ||
        a.started_at.localeCompare(b.started_at),
    );
  const websites =
    problems.data?.filter(
      (problem) => problem.marketing && problem.status === "firing",
    ) || [];
  const notice = sources.data
    ? alertSourceNotice(sources.data, active)
    : undefined;
  const pending = sources.isPending || problems.isPending;
  const failed = sources.isError || problems.isError;
  const current = !notice && !pending && !failed;
  const hasRecords = problems.data?.some(
    (problem) => problem.status === "firing",
  );
  let summary =
    notice?.title ||
    (hasRecords
      ? "Нет проблем, требующих внимания"
      : "Нет текущих неисправностей");
  if (pending) summary = "Загружаем состояние…";
  if (failed) summary = "Не удалось получить состояние";
  if (active.length)
    summary = `${current ? "Проблемы" : "Известные проблемы"}: ${active.length}`;
  const resourceNames = new Map(
    resources.data?.map((resource) => [resource.id, resource.name]),
  );
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest("[data-help-replay]")) return;
      if (
        !root.current?.contains(event.target as Node) &&
        !popover.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const row = (problem: PresentedProblem) => (
    <button
      className="workspace-problem-row"
      key={problem.id}
      onClick={() => {
        setSelected(problem);
        setOpen(false);
      }}
    >
      <TriangleAlert
        size={17}
        className={
          problem.severity === "critical" ? "text-danger" : "text-orange"
        }
      />
      <span>
        <strong>{problem.title}</strong>
        <small>
          {resourceNames.get(problem.resource_id) || "Ресурс не связан"} ·{" "}
          {duration(problem.started_at)}
          {problem.stale ? " · данные устарели" : ""}
        </small>
      </span>
    </button>
  );
  return (
    <div className="workspace-problem-trigger" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`top-status ${active.length ? "has-problems" : ""}`}
        aria-expanded={open}
        aria-controls="workspace-current-problems"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className={`status-dot ${current ? "" : "unknown"}`} />
        {summary}
      </button>
      {createPortal(
        <section
          ref={popover}
          id="workspace-current-problems"
          className="workspace-problem-popover"
          style={{ top: anchor.top, right: anchor.right }}
          role={open ? "dialog" : undefined}
          aria-label={open ? "Текущие неисправности" : undefined}
          hidden={!open}
        >
          <h3>
            Текущие неисправности
            {current || active.length ? ` · ${active.length}` : ""}
          </h3>
          {pending && !failed && (
            <p role="status">Загружаем источники и неисправности…</p>
          )}
          {sources.error && (
            <ErrorBox
              error={
                new Error(
                  `Не удалось загрузить источники. ${errorText(sources.error)}`,
                )
              }
              retry={() => void sources.refetch()}
            />
          )}
          {problems.error && (
            <ErrorBox
              error={
                new Error(
                  `Не удалось загрузить неисправности. ${errorText(problems.error)}`,
                )
              }
              retry={() => void problems.refetch()}
            />
          )}
          {failed && hasRecords && (
            <p className="muted">Показаны последние полученные записи.</p>
          )}
          {notice && !sources.isError && !pending && (
            <div className="notice">
              <strong>{notice.title}</strong>
              <p>{notice.detail}</p>
              <div className="actions">
                {notice.links.map(({ href, label }) => (
                  <a
                    key={href}
                    className="button button-sm"
                    href={href}
                    onClick={() => setOpen(false)}
                  >
                    {label}
                  </a>
                ))}
              </div>
            </div>
          )}
          {(current || hasRecords) && (
            <>
              <div
                className="segmented"
                role="group"
                aria-label="Видимость неисправностей"
              >
                <Button
                  size="sm"
                  variant={muted ? "ghost" : "default"}
                  onClick={() => setMuted(false)}
                >
                  Требуют внимания
                </Button>
                <Button
                  size="sm"
                  variant={muted ? "default" : "ghost"}
                  onClick={() => setMuted(true)}
                >
                  Скрытые и приглушённые
                </Button>
              </div>
              {rows.length ? (
                rows.map(row)
              ) : current ? (
                <Empty
                  title={
                    muted
                      ? "Скрытых неисправностей нет"
                      : "Нет записей, требующих внимания"
                  }
                />
              ) : (
                <p className="muted">
                  В последних данных подходящих записей нет.
                </p>
              )}
              <details>
                <summary>Публичные сайты · {websites.length}</summary>
                {websites.length ? (
                  websites.map(row)
                ) : (
                  <p>
                    {current
                      ? "Активных записей по выбранным сайтам нет."
                      : "В последних данных записей по выбранным сайтам нет."}
                  </p>
                )}
              </details>
            </>
          )}
        </section>,
        document.body,
      )}
      {selected && (
        <ProblemPanel
          problem={
            problems.data?.find((problem) => problem.id === selected.id) ||
            selected
          }
          resources={resources.data || []}
          sources={sources.data || []}
          actions={actions}
          onClose={() => {
            setSelected(undefined);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}
