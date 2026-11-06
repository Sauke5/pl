import { RuntimeSettings, SessionSettings } from "./RuntimeSettings";
import { UpdateSettings } from "./UpdateSettings";
import { InstallationSettings } from "./InstallationSettings";
import { DeliveryProxySettings } from "./DeliveryProxySettings";
import { ADSettings } from "./ADSettings";
import { LocalUsers } from "./LocalUsers";
import { LocalAdminPassword } from "./LocalAdminPassword";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  Fragment,
} from "react";
import {
  ArrowRight,
  BookOpen,
  Clock,
  LayoutDashboard,
  Network,
  PlugZap,
  Search,
  Server,
  Shield,
  Users,
  RefreshCw,
  X,
} from "lucide-react";
import { useAPI } from "./api";
import type {
  Dictionaries,
  Integration,
  Settings as PortalSettings,
  Session,
} from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Empty, ErrorBox, JSONView } from "./components/common";
import { useHelpTopic } from "./Help";
import { DraftContext, type DraftController } from "./settings/Draft";
import {
  DictionarySettings,
  GeneralSettings,
  PublicationSettings,
} from "./settings/Groups";
import { Integrations } from "./settings/Integrations";
import { registerSettingsGuard } from "./settings/navigation";
import {
  displayValue,
  fieldLabels,
  fieldKeywords,
  integrationFields,
  kindLabels,
  searchEntries,
  sections,
  settingsHash,
  settingsLocation,
  type SearchEntry,
  type SettingsLocation,
} from "./settings/model";
import "./settings/settings.css";
import { SettingsOverview } from "./settings/Overview";

const sectionIcons = {
  overview: LayoutDashboard,
  integrations: PlugZap,
  dictionaries: BookOpen,
  publication: Shield,
  general: Clock,
  system: Server,
  operations: Server,
  security: Shield,
  updates: RefreshCw,
  installation: Server,
  delivery: Network,
  users: Users,
  ad: Shield,
};
export default function Settings() {
  const session = useAPI<Session>("/session");
  const [place, setPlace] = useState(settingsLocation);
  const [search, setSearch] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [height, setHeight] = useState(650);
  const workspace = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const activeDraft = useRef<DraftController | undefined>(undefined);
  const pending = useRef<(() => void) | undefined>(undefined);
  const acceptedHash = useRef(location.hash);
  const integrations = useAPI<Integration[]>("/integrations");
  useHelpTopic(
    place.section === "publication" ? "settings-board" : "settings",
    1,
  );
  const registerDraft = useCallback((controller: DraftController) => {
    activeDraft.current = controller;
    return () => {
      if (activeDraft.current === controller) activeDraft.current = undefined;
    };
  }, []);
  const requestNavigation = useCallback((proceed: () => void) => {
    if (activeDraft.current?.dirty || activeDraft.current?.busy) {
      pending.current = proceed;
      setLeaving(true);
    } else proceed();
  }, []);
  useEffect(
    () => registerSettingsGuard(requestNavigation),
    [requestNavigation],
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!activeDraft.current?.dirty && !activeDraft.current?.busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const hash = (event: Event) => {
      const desired = location.hash;
      if (acceptedHash.current === desired) return;
      if (activeDraft.current?.dirty || activeDraft.current?.busy) {
        event.stopImmediatePropagation();
        history.replaceState(
          history.state,
          "",
          location.pathname + location.search + acceptedHash.current,
        );
        requestNavigation(() => {
          acceptedHash.current = desired;
          location.hash = desired;
          setPlace(settingsLocation(desired));
        });
      } else {
        acceptedHash.current = desired;
        if (desired.split("?")[0] === "#settings")
          setPlace(settingsLocation(desired));
      }
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("hashchange", hash, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("hashchange", hash, true);
    };
  }, [requestNavigation]);
  useLayoutEffect(() => {
    const element = workspace.current;
    const main = element?.closest("main");
    if (!element || !main) return;
    const footer = main.parentElement?.querySelector(".app-footer");
    let frame: number | undefined;
    function measure() {
      frame = undefined;
      const bottom = parseFloat(getComputedStyle(main!).paddingBottom) || 0;
      setHeight(
        Math.max(
          430,
          Math.floor(
            window.innerHeight -
              (element!.getBoundingClientRect().top + window.scrollY) -
              bottom -
              (footer?.getBoundingClientRect().height || 0) -
              1,
          ),
        ),
      );
    }
    function scheduleMeasure() {
      if (frame === undefined) frame = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(scheduleMeasure);
    function observeLayout() {
      observer.disconnect();
      observer.observe(main!);
      if (footer) observer.observe(footer);
      // Banners can move Settings without changing the flex main's size.
      for (const parent of [main!, main!.parentElement]) {
        if (!parent) continue;
        const stop = parent === main ? element : main;
        for (const sibling of parent.children) {
          if (sibling === stop) break;
          observer.observe(sibling);
        }
      }
      scheduleMeasure();
    }
    const changes = new MutationObserver(observeLayout);
    changes.observe(main, { childList: true });
    measure();
    observeLayout();
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== undefined) cancelAnimationFrame(frame);
      changes.disconnect();
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!place.field) {
      if (content.current) content.current.scrollTop = 0;
      return;
    }
    const root = workspace.current;
    const observer = new MutationObserver(focus);
    let finished = false;
    function focus() {
      if (finished) return;
      const target = root?.querySelector<HTMLElement>(
        '[data-settings-field="' + CSS.escape(place.field || "") + '"]',
      );
      if (!target) return;
      finished = true;
      observer.disconnect();
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
    }
    if (root) observer.observe(root, { subtree: true, childList: true });
    focus();
    return () => observer.disconnect();
  }, [place.section, place.integration, place.field]);
  function commit(next: SettingsLocation) {
    setPlace(next);
    setSearch("");
    acceptedHash.current = settingsHash(next);
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search + acceptedHash.current,
    );
  }
  function navigate(next: SettingsLocation) {
    requestNavigation(() => commit(next));
  }
  async function resolveLeave(choice: "stay" | "discard" | "save") {
    if (choice === "stay") {
      pending.current = undefined;
      setLeaving(false);
      return;
    }
    const controller = activeDraft.current;
    if (controller?.busy) return;
    const proceed = pending.current;
    pending.current = undefined;
    setLeaving(false);
    if (choice === "save" && controller && !(await controller.save())) return;
    if (choice === "discard") controller?.discard();
    activeDraft.current = undefined;
    proceed?.();
  }
  const entries: SearchEntry[] = [
    ...searchEntries.filter(
      (entry) =>
        (entry.section !== "ad" || session.data?.user?.admin) &&
        (entry.section !== "users" ||
          session.data?.local_users_enabled ||
          session.data?.local_password_change_enabled),
    ),
    ...(integrations.data || []).flatMap((item) => [
      {
        section: "integrations" as const,
        integration: item.id,
        title: item.name,
        description: "Интеграции · " + (kindLabels[item.kind] || item.kind),
        keywords: item.kind + " " + item.url,
      },
      ...[
        ...integrationFields.filter((key) => key !== "config"),
        ...Object.keys(item.config || {}).map((key) => "config." + key),
      ].map((field) => ({
        section: "integrations" as const,
        integration: item.id,
        field,
        title: fieldLabels[field] || field,
        description: "Интеграции · " + item.name,
        keywords: item.kind + " " + (fieldKeywords[field] || ""),
      })),
    ]),
  ];
  const terms = search
    .trim()
    .toLocaleLowerCase("ru")
    .split(/\s+/)
    .filter(Boolean);
  const matches = terms.length
    ? entries.filter((entry) =>
        terms.every((term) =>
          (entry.title + " " + entry.description + " " + (entry.keywords || ""))
            .toLocaleLowerCase("ru")
            .includes(term),
        ),
      )
    : [];
  const results = matches.slice(0, 24);
  const visibleSections = sections.filter(
    (section) =>
      (section.id !== "ad" || session.data?.user?.admin) &&
      (section.id !== "users" ||
        session.data?.local_users_enabled ||
        session.data?.local_password_change_enabled),
  );
  return (
    <DraftContext.Provider value={registerDraft}>
      <div
        className="settings-workspace"
        data-settings-workspace
        ref={workspace}
        style={{ height }}
      >
        <div className="page-title">
          <div>
            <h1>Настройки</h1>
            <p>Данные, доступ пользователей и обслуживание PL</p>
          </div>
        </div>
        <div className="settings-layout">
          <aside className="settings-navigation">
            <div className="settings-search">
              <Search size={16} />
              <input
                type="search"
                aria-label="Поиск по настройкам"
                placeholder="Найти настройку"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button
                  type="button"
                  aria-label="Очистить поиск настроек"
                  onClick={() => setSearch("")}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            {terms.length ? (
              <div
                className="settings-search-results"
                aria-label="Результаты поиска настроек"
              >
                <p className="settings-nav-caption">
                  {matches.length
                    ? "Найдено: " + matches.length
                    : "Ничего не найдено"}
                </p>
                {results.map((entry) => (
                  <button
                    type="button"
                    key={[entry.section, entry.integration, entry.field].join(
                      ":",
                    )}
                    onClick={() => navigate(entry)}
                  >
                    <strong>{entry.title}</strong>
                    <small>{entry.description}</small>
                  </button>
                ))}
                {matches.length > results.length && (
                  <p className="settings-nav-caption">
                    Уточните запрос: показаны первые 24 результата.
                  </p>
                )}
              </div>
            ) : (
              <nav aria-label="Разделы настроек">
                {visibleSections.map((section, index) => {
                  const Icon = sectionIcons[section.id];
                  return (
                    <Fragment key={section.id}>
                      {section.group &&
                        section.group !== visibleSections[index - 1]?.group && (
                          <p className="settings-nav-group">{section.group}</p>
                        )}
                      <button
                        type="button"
                        title={section.description}
                        aria-current={
                          place.section === section.id ? "page" : undefined
                        }
                        className={
                          place.section === section.id ? "is-active" : ""
                        }
                        onClick={() => navigate({ section: section.id })}
                      >
                        <Icon size={17} />
                        <span>{section.label}</span>
                        <ArrowRight size={14} />
                      </button>
                    </Fragment>
                  );
                })}
              </nav>
            )}
          </aside>
          <div
            className={
              "settings-content" +
              (place.section === "integrations" ? " is-connections" : "")
            }
            ref={content}
            data-settings-content
          >
            {place.section === "overview" ? (
              <SettingsOverview
                session={session.data}
                integrations={integrations.data}
                integrationsError={integrations.error}
                onNavigate={navigate}
              />
            ) : place.section === "integrations" ? (
              <Integrations
                selected={place.integration}
                focusField={place.field}
                onSelect={(id) =>
                  navigate({ section: "integrations", integration: id })
                }
                onSaved={(id) =>
                  commit({ section: "integrations", integration: id })
                }
              />
            ) : place.section === "operations" ? (
              <RuntimeSettings />
            ) : place.section === "security" ? (
              <SessionSettings />
            ) : place.section === "updates" ? (
              <UpdateSettings />
            ) : place.section === "installation" ? (
              <InstallationSettings />
            ) : place.section === "delivery" ? (
              <DeliveryProxySettings />
            ) : place.section === "ad" ? (
              <ADSettings />
            ) : place.section === "users" ? (
              <>
                <LocalAdminPassword session={session.data} />
                {session.data?.local_users_enabled ? (
                  <LocalUsers />
                ) : (
                  <Empty title="Каталог пользователей недоступен" />
                )}
              </>
            ) : place.section === "system" ? (
              <SystemSettings />
            ) : (
              <EditableGroup section={place.section} />
            )}
          </div>
        </div>
      </div>
      {leaving && (
        <Dialog
          title="Есть несохранённые изменения"
          description="Сохранить изменения перед переходом?"
          onClose={() => void resolveLeave("stay")}
        >
          <div className="dialog-footer">
            <Button onClick={() => void resolveLeave("stay")}>Остаться</Button>
            <Button
              disabled={activeDraft.current?.busy}
              onClick={() => void resolveLeave("discard")}
            >
              Отбросить
            </Button>
            <Button
              variant="default"
              disabled={activeDraft.current?.busy}
              onClick={() => void resolveLeave("save")}
            >
              Сохранить
            </Button>
          </div>
        </Dialog>
      )}
    </DraftContext.Provider>
  );
}
function EditableGroup({
  section,
}: {
  section: "dictionaries" | "publication" | "general";
}) {
  const settings = useAPI<PortalSettings>(
    "/settings",
    section !== "dictionaries",
  );
  const dictionaries = useAPI<Dictionaries>(
    "/dictionaries",
    section === "dictionaries",
  );
  const query = section === "dictionaries" ? dictionaries : settings;
  if (query.error && !query.data)
    return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  if (query.isPending)
    return (
      <p role="status" className="settings-loading">
        Загрузка настроек…
      </p>
    );
  return (
    <>
      {!!query.error && (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      )}
      {section === "dictionaries" ? (
        <DictionarySettings value={dictionaries.data!} />
      ) : section === "publication" ? (
        <PublicationSettings value={settings.data!} />
      ) : (
        <GeneralSettings value={settings.data!} />
      )}
    </>
  );
}
function SystemSettings() {
  const runtime = useAPI<Record<string, unknown>>("/runtime");
  const session = useAPI<Session>("/session");
  return (
    <section className="settings-group" aria-label="Серверная конфигурация">
      <header className="settings-section-heading">
        <Server size={22} />
        <div>
          <h2>Серверная конфигурация</h2>
          <p>Технические параметры действующей установки PL</p>
        </div>
        <span className="settings-readonly">Только чтение</span>
      </header>
      {runtime.error ? (
        <ErrorBox error={runtime.error} retry={() => void runtime.refetch()} />
      ) : runtime.isPending ? (
        <p role="status">Загрузка конфигурации…</p>
      ) : (
        <>
          <section
            className="settings-system-section"
            data-settings-field="auth"
            tabIndex={-1}
          >
            <h3>Вход и доступ</h3>
            <dl className="settings-facts">
              <div>
                <dt>Вход через AD</dt>
                <dd>{displayValue(session.data?.ad_login_enabled)}</dd>
              </div>
              <div>
                <dt>Вход через OIDC</dt>
                <dd>
                  {displayValue(
                    session.data?.oidc_login_enabled ??
                      runtime.data.oidc_configured,
                  )}
                </dd>
              </div>
              <div>
                <dt>Локальный вход</dt>
                <dd>{displayValue(session.data?.local_login_enabled)}</dd>
              </div>
              <div>
                <dt>Группа OIDC</dt>
                <dd>{displayValue(runtime.data.auth_allowed_group)}</dd>
              </div>
              <div>
                <dt>Поле группы OIDC</dt>
                <dd>{displayValue(runtime.data.auth_group_claim)}</dd>
              </div>
            </dl>
          </section>
          <section
            className="settings-system-section"
            data-settings-field="network"
            tabIndex={-1}
          >
            <h3>Сетевые ограничения</h3>
            <dl className="settings-facts">
              <div>
                <dt>Разрешённые сети</dt>
                <dd>{displayValue(runtime.data.allowed_cidrs)}</dd>
              </div>
              <div>
                <dt>Разрешённые порты</dt>
                <dd>{displayValue(runtime.data.allowed_ports)}</dd>
              </div>
              <div>
                <dt>Источник проверок</dt>
                <dd>{displayValue(runtime.data.probe_origin)}</dd>
              </div>
            </dl>
          </section>
          <section
            className="settings-system-section"
            data-settings-field="executor"
            tabIndex={-1}
          >
            <h3>Исполнитель операций</h3>
            <dl className="settings-facts">
              <div>
                <dt>Настроен</dt>
                <dd>{displayValue(runtime.data.executor_configured)}</dd>
              </div>
              <div>
                <dt>Демонстрационный режим</dt>
                <dd>{displayValue(runtime.data.demo)}</dd>
              </div>
            </dl>
          </section>
          <p className="muted">
            Эти параметры задаются в конфигурации сервера.
          </p>
          <details className="settings-technical">
            <summary>Технические поля</summary>
            <JSONView value={runtime.data} />
          </details>
        </>
      )}
    </section>
  );
}
