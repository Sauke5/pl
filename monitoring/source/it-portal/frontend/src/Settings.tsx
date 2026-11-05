import { RuntimeSettings } from "./RuntimeSettings";
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
  X,
} from "lucide-react";
import { date, useAPI } from "./api";
import type {
  Dictionaries,
  Integration,
  Settings as PortalSettings,
  Session,
} from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Badge, Empty, ErrorBox, JSONView } from "./components/common";
import { useHelpTopic } from "./Help";
import { DraftContext, type DraftController } from "./settings/Draft";
import {
  DictionarySettings,
  GeneralSettings,
  PublicationSettings,
} from "./settings/Groups";
import { Integrations } from "./settings/Integrations";
import { SFTP_EXCHANGE_ID } from "./ConnectionDetails";
import { registerSettingsGuard } from "./settings/navigation";
import {
  displayValue,
  fieldLabels,
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

const sectionIcons = {
  overview: LayoutDashboard,
  integrations: PlugZap,
  dictionaries: BookOpen,
  publication: Shield,
  general: Clock,
  system: Server,
  operations: Server,
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
    function measure() {
      const element = workspace.current;
      if (!element) return;
      const main = element.closest("main"),
        footer = main?.parentElement?.querySelector(".app-footer");
      const bottom = main
        ? parseFloat(getComputedStyle(main).paddingBottom)
        : 30;
      setHeight(
        Math.max(
          430,
          Math.floor(
            window.innerHeight -
              element.getBoundingClientRect().top -
              bottom -
              (footer?.getBoundingClientRect().height || 0) -
              1,
          ),
        ),
      );
    }
    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    const main = workspace.current?.closest("main");
    if (main) observer.observe(main);
    return () => {
      window.removeEventListener("resize", measure);
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
          session.data?.local_password_change_enabled) &&
        (entry.integration !== SFTP_EXCHANGE_ID ||
          session.data?.features?.sftp_exchange),
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
        keywords: item.kind,
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
            <p>Конфигурация Платформы и подключений</p>
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
                {sections
                  .filter(
                    (section) =>
                      (section.id !== "ad" || session.data?.user?.admin) &&
                      (section.id !== "users" ||
                        session.data?.local_users_enabled ||
                        session.data?.local_password_change_enabled),
                  )
                  .map((section) => {
                    const Icon = sectionIcons[section.id];
                    return (
                      <button
                        type="button"
                        key={section.id}
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
              <Overview
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
function Overview({
  integrations,
  integrationsError,
  onNavigate,
}: {
  integrations?: Integration[];
  integrationsError?: unknown;
  onNavigate: (place: SettingsLocation) => void;
}) {
  const settings = useAPI<PortalSettings>("/settings");
  const session = useAPI<Session>("/session");
  return (
    <section className="settings-overview" aria-label="Обзор настроек">
      <header className="settings-section-heading">
        <LayoutDashboard size={22} />
        <div>
          <h2>Обзор</h2>
          <p>Текущая конфигурация Платформы</p>
        </div>
      </header>
      <section className="settings-overview-block">
        <div className="settings-heading">
          <h3>
            <PlugZap size={18} />
            Подключения
          </h3>
          <Button
            size="sm"
            onClick={() => onNavigate({ section: "integrations" })}
          >
            Все подключения
            <ArrowRight size={15} />
          </Button>
        </div>
        {integrations && !integrationsError && (
          <p className="settings-overview-summary">
            Всего: {integrations.length}
            {" · Подключены: " +
              integrations.filter(
                (item) => item.enabled && item.status === "connected",
              ).length}
            {" · С ошибкой: " +
              integrations.filter((item) => item.enabled && !!item.error)
                .length}
            {" · Выключены: " +
              integrations.filter((item) => !item.enabled).length}
          </p>
        )}
        {integrationsError ? (
          <ErrorBox error={integrationsError} />
        ) : !integrations ? (
          <p role="status">Загрузка подключений…</p>
        ) : integrations.length ? (
          <div className="settings-overview-connections">
            {[...integrations]
              .sort(
                (a, b) =>
                  Number(!!b.error && b.enabled) -
                  Number(!!a.error && a.enabled),
              )
              .slice(0, 3)
              .map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="settings-overview-connection"
                  onClick={() =>
                    onNavigate({
                      section: "integrations",
                      integration: item.id,
                    })
                  }
                >
                  <div>
                    <strong>{item.name}</strong>
                    <small>{kindLabels[item.kind] || item.kind}</small>
                  </div>
                  <Badge
                    value={item.enabled ? item.status || "unknown" : "disabled"}
                  />
                  <span className="settings-overview-attempt">
                    {item.enabled && item.error ? (
                      <span className="settings-inline-error">
                        {item.error}
                      </span>
                    ) : (
                      <>
                        Последний успех
                        <br />
                        {date(item.last_success)}
                      </>
                    )}
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
          </div>
        ) : (
          <Empty
            title="Нет подключённых источников"
            action={
              <Button
                onClick={() =>
                  onNavigate({ section: "integrations", integration: "new" })
                }
              >
                Добавить подключение
              </Button>
            }
          />
        )}
        {integrations && integrations.length > 3 && (
          <p className="settings-overview-summary">
            Показано 3 из {integrations.length}. Все источники — в разделе
            «Интеграции».
          </p>
        )}
      </section>
      {session.data?.features?.sftp_exchange && (
        <section className="settings-overview-block">
          <button
            type="button"
            className="settings-overview-connection"
            onClick={() =>
              onNavigate({
                section: "integrations",
                integration: SFTP_EXCHANGE_ID,
              })
            }
          >
            <div>
              <strong>Приём выгрузок 1С</strong>
              <small>SFTP · архивы филиалов</small>
            </div>
            <ArrowRight size={16} />
          </button>
        </section>
      )}
      {settings.error ? (
        <ErrorBox
          error={settings.error}
          retry={() => void settings.refetch()}
        />
      ) : settings.isPending ? (
        <p role="status">Загрузка общих параметров…</p>
      ) : (
        <div className="settings-overview-bottom">
          <section className="settings-overview-block">
            <div className="settings-heading">
              <h3>
                <Shield size={18} />
                Публикация
              </h3>
              <Button
                size="sm"
                onClick={() => onNavigate({ section: "publication" })}
              >
                Открыть
                <ArrowRight size={15} />
              </Button>
            </div>
            <dl className="settings-facts">
              <div>
                <dt>Board</dt>
                <dd>{settings.data.board_enabled ? "Включён" : "Выключен"}</dd>
              </div>
              <div>
                <dt>Доступ</dt>
                <dd>
                  {!settings.data.board_enabled
                    ? "Публикация выключена"
                    : settings.data.board_anonymous
                      ? "Без входа"
                      : "После входа"}
                </dd>
              </div>
              <div>
                <dt>Ресурсы</dt>
                <dd>{settings.data.board_resource_ids.length}</dd>
              </div>
              <div>
                <dt>Заголовок</dt>
                <dd>{settings.data.board_title || "—"}</dd>
              </div>
            </dl>
          </section>
          <section className="settings-overview-block">
            <div className="settings-heading">
              <h3>
                <Clock size={18} />
                Общие параметры
              </h3>
              <Button
                size="sm"
                onClick={() => onNavigate({ section: "general" })}
              >
                Открыть
                <ArrowRight size={15} />
              </Button>
            </div>
            <dl className="settings-facts">
              <div>
                <dt>Часовой пояс</dt>
                <dd>{settings.data.timezone}</dd>
              </div>
              <div>
                <dt>Порог устаревания</dt>
                <dd>{settings.data.stale_after_seconds} с</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </section>
  );
}
function SystemSettings() {
  const runtime = useAPI<Record<string, unknown>>("/runtime");
  const session = useAPI<Session>("/session");
  return (
    <section className="settings-group" aria-label="Система">
      <header className="settings-section-heading">
        <Server size={22} />
        <div>
          <h2>Система</h2>
          <p>Действующая конфигурация сервера</p>
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
