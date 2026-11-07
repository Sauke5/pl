import { ActionFeedback } from "./ActionNotifications";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Download,
  ArrowUpRight,
  Trash2,
  Link,
  Pause,
  Play,
  RefreshCw,
  Server,
  Bell,
  BookOpen,
  ClipboardList,
  FileSearch,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  Mail,
  Network,
  Radio,
  Route,
  Search,
} from "lucide-react";
import { APIError, api, date, errorText, queryClient } from "./api";
import type { Job } from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import ModuleActionMenu from "./ModuleActionMenu";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import "./modules.css";
import PrometheusModule from "./PrometheusModule";
import PrometheusConfig from "./PrometheusConfig";
import XrayModule from "./XrayModule";
import AlertmanagerModule from "./AlertmanagerModule";
import NetMapModule from "./NetMapModule";
import MailcowModule from "./MailcowModule";
import ModuleInitialLogin, { supportsInitialLogin } from "./ModuleInitialLogin";
import { SFTPGo } from "./SFTPGo";
import { checkDeliveryCatalog, useDelivery } from "./UpdateSettings";

type ModuleMode = "local" | "external";
type ModuleDescriptor = {
  id: string;
  name: string;
  description: string;
  version: string;
  modes: ModuleMode[];
  data_preservation?: string;
  external_auth?: string;
  public_path?: string;
};
type ModuleInstance = {
  id: string;
  revision: number;
  module_id: string;
  name: string;
  mode: ModuleMode;
  endpoint?: string;
  integration_id?: string;
  resource_id?: string;
  desired_state: string;
  observed_state: string;
  version?: string;
  targets_up?: number;
  targets_total?: number;
  last_attempt?: string;
  last_success?: string;
  last_job_id?: string;
  error?: string;
};
type ModuleOperation = { instance: ModuleInstance; job: Job };
type ModuleCatalog = {
  items: ModuleDescriptor[];
  local_available: boolean;
  managed_credentials_available?: boolean;
};
type ModuleAction = "enable" | "disable" | "refresh" | "remove";

function createModule(
  payload: { module_id: string; name: string; mode: ModuleMode },
  key: string,
) {
  return api<ModuleOperation>(
    "/modules",
    "POST",
    { ...payload, idempotency_key: key },
    {},
    AbortSignal.timeout(20000),
  );
}

const activeJob = (status?: string) =>
  status === "queued" || status === "running";
const moduleStates: Record<string, string> = {
  pending: "Ожидает выполнения",
  running: "Работает",
  disabled: "Отключён",
  unavailable: "Недоступен",
  error: "Ошибка",
  unknown: "Состояние неизвестно",
  removing: "Удаляется",
  absent: "Удалён",
};
const operationNames: Record<string, string> = {
  install: "Установка",
  connect: "Подключение",
  reconnect: "Изменение подключения",
  enable: "Включение",
  disable: "Отключение",
  refresh: "Проверка",
  configure: "Настройка",
  remove: "Удаление",
};

const modulePresentation: Record<
  string,
  { name: string; icon: typeof Activity }
> = {
  prometheus: { name: "Prometheus", icon: Activity },
  alertmanager: { name: "Alertmanager", icon: Bell },
  xray: { name: "Xray", icon: Radio },
  sftpgo: { name: "SFTPGo", icon: FolderOpen },
  mailcow: { name: "Mailcow", icon: Mail },
  netmap: { name: "NetMap", icon: Network },
  grafana: { name: "Grafana", icon: LayoutDashboard },
  bookstack: { name: "Wiki", icon: BookOpen },
  forms: { name: "Forms", icon: ClipboardList },
  doska: { name: "Doska", icon: ListTodo },
  wayline: { name: "Wayline", icon: Route },
  fileauditor: { name: "File Auditor", icon: FileSearch },
};

function moduleHealth(instance: ModuleInstance) {
  const state = Object.hasOwn(moduleStates, instance.observed_state)
    ? instance.observed_state
    : "unknown";
  const stale =
    state === "running" &&
    instance.module_id !== "mailcow" &&
    instance.desired_state === "enabled" &&
    [instance.last_attempt, instance.last_success].some((value) => {
      const timestamp = value ? Date.parse(value) : NaN;
      return !Number.isFinite(timestamp) || Date.now() - timestamp > 150000;
    });
  const problem =
    stale ||
    !!instance.error ||
    ["error", "unavailable", "unknown"].includes(state);
  return { state, stale, problem };
}

function modulePrimaryLink(instance: ModuleInstance) {
  const id = encodeURIComponent(instance.id);
  switch (instance.module_id) {
    case "prometheus":
      return {
        label: "Мониторинг",
        href:
          instance.mode === "local"
            ? `#monitoring?instance=${id}`
            : `#modules?instance=${id}&view=monitoring`,
      };
    case "alertmanager":
      return { label: "Уведомления", href: `#notifications?instance=${id}` };
    case "xray":
      return { label: "Управлять прокси", href: `#proxy?instance=${id}` };
    case "sftpgo":
      return { label: "Открыть файлы", href: "/sftpgo/" };
    case "mailcow":
      return { label: "Управлять почтой", href: `#mail?instance=${id}` };
    case "netmap":
      return { label: "Открыть карту", href: "/netmap/" };
    case "bookstack":
      return { label: "Открыть Wiki", href: "/wiki/" };
    case "grafana":
      return { label: "Открыть Grafana", href: "/grafana/" };
    case "forms":
      return { label: "Открыть Forms", href: "/forms/" };
    case "doska":
      return { label: "Открыть Doska", href: "/doska/" };
    case "wayline":
      return { label: "Открыть Wayline", href: "/wayline/" };
    case "fileauditor": {
      const path = auditorNativePath(instance);
      return path ? { label: "Открыть File Auditor", href: path } : undefined;
    }
    default:
      return undefined;
  }
}

function auditorNativePath(instance: ModuleInstance) {
  if (
    !instance.integration_id ||
    !instance.endpoint ||
    instance.endpoint.includes("\\")
  )
    return undefined;
  try {
    const url = new URL(instance.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    // These fixed PL gateways resolve an enabled persisted integration. An API
    // origin alone does not prove a native UI route and must never open PL home.
    switch (url.pathname) {
      case "/audit":
      case "/audit/":
        return "/audit/";
      case "/audit-arch":
      case "/audit-arch/":
        return "/audit-arch/";
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function moduleError(error: unknown) {
  if (
    error instanceof DOMException &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return new Error(
      "Ответ не получен вовремя. Операция могла попасть в очередь. Обновите список или повторите запрос с теми же параметрами — повтор не создаст второе задание.",
    );
  if (!(error instanceof APIError)) return error;
  const messages: Record<string, string> = {
    local_unavailable:
      "Установка на этом хосте недоступна. Проверьте подключение host controller.",
    controller_unavailable:
      "Host controller недоступен. Подключение внешнего сервиса остаётся доступным.",
    module_busy:
      "Для этого экземпляра уже выполняется операция. Дождитесь её результата.",
    forbidden: "Для управления модулями нужны права администратора.",
    module_exists:
      "Такой модуль уже добавлен. Откройте установленный экземпляр или подтвердите создание дополнительного.",
    confirmation_required: "Для удаления введите точное название экземпляра.",
    managed_module: "Этот объект управляется из раздела «Модули».",
    revision_conflict:
      "Экземпляр уже изменён. Обновите список перед новой операцией.",
  };
  return new Error(messages[error.code] || error.message);
}

function moduleRequest<T>(path: string, signal: AbortSignal) {
  return api<T>(
    path,
    "GET",
    undefined,
    {},
    AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  );
}

async function refreshModules() {
  await queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      const path = queryKey[0];
      return (
        typeof path === "string" &&
        [
          "/modules",
          "/integrations",
          "/resources",
          "/candidates",
          "/problems",
          "/reports",
        ].some((prefix) => path.startsWith(prefix))
      );
    },
  });
}

export default function Modules({
  view = "installed",
}: {
  view?: "catalog" | "installed";
}) {
  const isCatalog = view === "catalog";
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [placement, setPlacement] = useState("all");
  const [sort, setSort] = useState("problems");
  const [setupJobID, setSetupJobID] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1] || "").get("setup") || "",
  );
  const [configurationView, setConfigurationView] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1] || "").get("view") ===
      "configuration",
  );
  const [monitoringID, setMonitoringID] = useState(() => {
    const route = new URLSearchParams(location.hash.split("?")[1] || "");
    return [
      "monitoring",
      "configuration",
      "xray",
      "alertmanager",
      "sftpgo",
      "netmap",
      "mailcow",
    ].includes(route.get("view") || "")
      ? route.get("instance") || ""
      : "";
  });
  useEffect(() => {
    function routeChanged() {
      const route = new URLSearchParams(location.hash.split("?")[1] || "");
      if (route.get("instance")) {
        setSearch("");
        setStatusFilter("all");
        setPlacement("all");
      }
      setSetupJobID(route.get("setup") || "");
      setConfigurationView(route.get("view") === "configuration");
      setMonitoringID(
        [
          "monitoring",
          "configuration",
          "xray",
          "alertmanager",
          "sftpgo",
          "netmap",
          "mailcow",
        ].includes(route.get("view") || "")
          ? route.get("instance") || ""
          : "",
      );
    }
    window.addEventListener("hashchange", routeChanged);
    return () => window.removeEventListener("hashchange", routeChanged);
  }, []);
  const catalog = useQuery({
    queryKey: ["/modules/catalog"],
    queryFn: ({ signal }) =>
      moduleRequest<ModuleCatalog>("/modules/catalog", signal),
    enabled: isCatalog,
    retry: false,
  });
  const instances = useQuery({
    queryKey: ["/modules"],
    queryFn: ({ signal }) =>
      moduleRequest<{ items: ModuleInstance[] }>("/modules", signal),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) =>
        ["pending", "removing"].includes(item.observed_state),
      )
        ? 2000
        : 30000,
    retry: false,
  });
  const [adding, setAdding] = useState<{
    descriptor: ModuleDescriptor;
    mode: ModuleMode;
  }>();
  const [installChoices, setInstallChoices] = useState<ModuleDescriptor[]>();
  const [notice, setNotice] = useState("");
  function setupHandled() {
    const route = new URLSearchParams(location.hash.split("?")[1] || "");
    if (route.get("setup") !== setupJobID) return;
    route.delete("setup");
    const next = new URL(location.href);
    const query = route.toString();
    next.hash = location.hash.split("?")[0] + (query ? "?" + query : "");
    history.replaceState(history.state, "", next.href);
    setSetupJobID("");
  }
  const previousInstances = useRef<ModuleInstance[]>([]);
  useEffect(() => {
    if (!instances.data) return;
    const removed = previousInstances.current.filter(
      (old) =>
        old.desired_state === "removed" &&
        !instances.data.items.some((item) => item.id === old.id),
    );
    if (removed.length)
      setNotice(
        `${removed.map((item) => `«${item.name}»`).join(", ")}: удаление завершено. Принятые ранее ресурсы целей сохранены.`,
      );
    previousInstances.current = instances.data.items;
  }, [instances.data]);
  const localAvailable = catalog.data?.local_available === true;
  const installed = instances.data?.items || [];
  const localOffers = (catalog.data?.items || []).filter((descriptor) =>
    descriptor.modes.includes("local"),
  );
  const newLocalModules =
    localAvailable && instances.isSuccess
      ? localOffers.filter(
          (descriptor) =>
            !installed.some(
              (item) =>
                item.module_id === descriptor.id &&
                (item.mode === "local" ||
                  ["bookstack", "netmap"].includes(descriptor.id)),
            ),
        )
      : [];
  const visibleInstances = installed
    .filter((instance) => {
      const health = moduleHealth(instance);
      return (
        (placement === "all" || instance.mode === placement) &&
        (statusFilter === "all" ||
          (statusFilter === "problems"
            ? health.problem
            : statusFilter === "registered"
              ? instance.module_id === "mailcow" && health.state === "running"
              : health.state === statusFilter &&
                !(
                  statusFilter === "running" && instance.module_id === "mailcow"
                ))) &&
        `${instance.name} ${instance.endpoint || ""} ${modulePresentation[instance.module_id]?.name || instance.module_id}`
          .toLocaleLowerCase("ru-RU")
          .includes(search.trim().toLocaleLowerCase("ru-RU"))
      );
    })
    .sort(
      (left, right) =>
        (sort === "problems"
          ? Number(moduleHealth(right).problem) -
            Number(moduleHealth(left).problem)
          : 0) ||
        left.name.localeCompare(right.name, "ru", { numeric: true }) ||
        left.id.localeCompare(right.id),
    );
  const catalogItems = (catalog.data?.items || [])
    .map((descriptor, index) => {
      const confirmed = (instances.data?.items || []).filter(
        (instance) =>
          instance.module_id === descriptor.id &&
          instance.desired_state !== "removed" &&
          instance.observed_state !== "absent" &&
          (["running", "disabled"].includes(instance.observed_state) ||
            !!instance.last_success),
      );
      const installed = confirmed.filter(
        (item) => item.mode === "local",
      ).length;
      const connected = confirmed.filter(
        (item) => item.mode === "external",
      ).length;
      return { descriptor, index, installed, connected };
    })
    .sort(
      (left, right) =>
        Number(left.installed + left.connected > 0) -
          Number(right.installed + right.connected > 0) ||
        left.index - right.index,
    );
  useEffect(() => {
    function focusInstance() {
      const id = new URLSearchParams(location.hash.split("?")[1] || "").get(
        "instance",
      );
      if (id) {
        const card = document.getElementById(`module-${id}`);
        card?.focus({ preventScroll: true });
        card?.scrollIntoView({ block: "center", behavior: "instant" });
      }
    }
    focusInstance();
    window.addEventListener("hashchange", focusInstance);
    return () => window.removeEventListener("hashchange", focusInstance);
  }, [instances.data]);

  if (!isCatalog && monitoringID) {
    const instance = instances.data?.items.find(
      (item) =>
        item.id === monitoringID &&
        [
          "prometheus",
          "xray",
          "alertmanager",
          "sftpgo",
          "netmap",
          "mailcow",
        ].includes(item.module_id),
    );
    return instance ? (
      instance.module_id === "mailcow" ? (
        <MailcowModule key={instance.id} instanceID={instance.id} />
      ) : instance.module_id === "netmap" ? (
        <NetMapModule key={instance.id} instance={instance} />
      ) : instance.module_id === "sftpgo" ? (
        <SFTPGo key={instance.id} instanceID={instance.id} admin={true} />
      ) : instance.module_id === "alertmanager" ? (
        <AlertmanagerModule key={instance.id} instance={instance} />
      ) : instance.module_id === "xray" ? (
        <XrayModule key={instance.id} instance={instance} />
      ) : configurationView ? (
        <PrometheusConfig key={instance.id} instance={instance} />
      ) : (
        <PrometheusModule key={instance.id} instance={instance} />
      )
    ) : (
      <div className="modules-page">
        <div className="page-title">
          <h1>Модуль</h1>
          <a className="button button-secondary" href="#modules">
            К модулям
          </a>
        </div>
        {instances.error ? (
          <ErrorBox
            error={moduleError(instances.error)}
            retry={() => void instances.refetch()}
          />
        ) : instances.isPending ? (
          <p className="muted" role="status">
            Загружаем модуль…
          </p>
        ) : (
          <Empty
            title="Модуль не найден"
            detail="Экземпляр мог быть удалён. Выберите доступный модуль в списке."
          />
        )}
      </div>
    );
  }
  return (
    <div className="modules-page">
      <div className="page-title">
        <div>
          <h1
            className={isCatalog ? undefined : "module-installed-heading"}
            aria-label={isCatalog ? undefined : "Подключённые модули"}
          >
            {isCatalog ? "Каталог модулей" : "Подключённые модули"}
            {!isCatalog && (
              <span className="module-heading-count" aria-hidden="true">
                {instances.isPending ? "—" : installed.length}
              </span>
            )}
          </h1>
          {isCatalog && (
            <p>
              Установка сервисов на хосте Платформы и подключение внешних
              экземпляров.
            </p>
          )}
        </div>
        <Button
          disabled={instances.isFetching || catalog.isFetching}
          onClick={() => void refreshModules()}
        >
          <RefreshCw size={16} /> Обновить
        </Button>
      </div>
      <ActionFeedback notice={notice} />
      {isCatalog ? (
        <Panel
          title="Доступные модули"
          icon={<Download size={20} />}
          action={
            newLocalModules.length > 1 &&
            !catalog.error && (
              <Button
                variant="default"
                onClick={() => setInstallChoices(newLocalModules)}
              >
                <Download size={16} /> Установить несколько
              </Button>
            )
          }
        >
          {catalog.data && !catalog.error && (
            <ModuleCatalogSource
              localAvailable={localAvailable}
              hasLocalOffers={localOffers.length > 0}
            />
          )}
          {!catalog.error && instances.error && (
            <ErrorBox
              error={moduleError(instances.error)}
              retry={() => void instances.refetch()}
            />
          )}
          {catalog.error ? (
            <ErrorBox
              error={moduleError(catalog.error)}
              retry={() => void catalog.refetch()}
            />
          ) : catalog.isPending || instances.isPending ? (
            <p className="muted" role="status">
              Загружаем каталог…
            </p>
          ) : catalog.data?.items.length ? (
            <div className="module-catalog">
              {catalogItems.map(({ descriptor, installed, connected }) => (
                <article
                  className={`module-definition${installed ? " is-installed" : connected ? " is-connected" : ""}`}
                  key={descriptor.id}
                >
                  <div className="module-definition-icon">
                    <Activity size={21} />
                  </div>
                  <div className="module-definition-content">
                    <div className="module-definition-heading">
                      <h3>{descriptor.name}</h3>
                    </div>
                    <div className="module-definition-meta">
                      {(descriptor.version ||
                        descriptor.modes.includes("local")) && (
                        <span className="tag">
                          {descriptor.version || "Версия из пакета"}
                        </span>
                      )}
                      {installed > 0 && (
                        <span className="module-catalog-state is-installed">
                          {installed === 1
                            ? "Установлен"
                            : `Установлено: ${installed}`}
                        </span>
                      )}
                      {connected > 0 && (
                        <span className="module-catalog-state is-connected">
                          {connected === 1
                            ? "Подключён"
                            : `Подключено: ${connected}`}
                        </span>
                      )}
                    </div>
                    <p className="muted">{descriptor.description}</p>
                    <div className="actions">
                      {descriptor.modes.includes("local") && (
                        <Button
                          variant="default"
                          disabled={!localAvailable}
                          onClick={() =>
                            setAdding({ descriptor, mode: "local" })
                          }
                        >
                          <Download size={15} /> Установить на хост
                        </Button>
                      )}
                      {descriptor.modes.includes("external") && (
                        <Button
                          disabled={
                            descriptor.id === "netmap" &&
                            catalog.data?.managed_credentials_available !== true
                          }
                          onClick={() =>
                            setAdding({ descriptor, mode: "external" })
                          }
                        >
                          <Link size={15} /> Подключить существующий
                        </Button>
                      )}
                    </div>
                    {!descriptor.modes.length && (
                      <span className="module-hint">Пакет недоступен</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty title="В каталоге пока нет доступных модулей" />
          )}
        </Panel>
      ) : (
        <section
          className="module-installed-overview"
          aria-label="Подключённые модули"
        >
          {instances.error && (
            <ErrorBox
              error={moduleError(instances.error)}
              retry={() => void instances.refetch()}
            />
          )}
          {instances.isPending ? (
            <p className="muted" role="status">
              Загружаем экземпляры…
            </p>
          ) : instances.data?.items.length ? (
            <>
              <div className="module-summary" aria-label="Сводка модулей">
                {[
                  [
                    "Работают",
                    installed.filter(
                      (item) =>
                        item.observed_state === "running" &&
                        item.module_id !== "mailcow",
                    ).length,
                    "running",
                  ],
                  [
                    "Подключение добавлено",
                    installed.filter(
                      (item) =>
                        item.module_id === "mailcow" &&
                        item.observed_state === "running",
                    ).length,
                    "registered",
                  ],
                  [
                    "Требуют внимания",
                    installed.filter((item) => moduleHealth(item).problem)
                      .length,
                    "attention",
                  ],
                  [
                    "Отключены",
                    installed.filter(
                      (item) => item.observed_state === "disabled",
                    ).length,
                    "disabled",
                  ],
                ].map(([label, count, state]) => (
                  <div key={label} data-module-summary={state}>
                    <strong>{count}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div
                className="module-toolbar"
                role="search"
                aria-label="Поиск и фильтры модулей"
              >
                <label className="module-search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    aria-label="Поиск модулей"
                    placeholder="Название или адрес сервиса"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <label>
                  <span>Состояние</span>
                  <select
                    aria-label="Состояние модуля"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="all">Все состояния</option>
                    <option value="problems">Требуют внимания</option>
                    <option value="running">Работает</option>
                    <option value="registered">Подключение добавлено</option>
                    <option value="unavailable">Недоступен</option>
                    <option value="error">Ошибка</option>
                    <option value="disabled">Отключён</option>
                    <option value="pending">Ожидает выполнения</option>
                    <option value="removing">Удаляется</option>
                    <option value="unknown">Состояние неизвестно</option>
                  </select>
                </label>
                <label>
                  <span>Размещение</span>
                  <select
                    aria-label="Размещение модуля"
                    value={placement}
                    onChange={(event) => setPlacement(event.target.value)}
                  >
                    <option value="all">Любое размещение</option>
                    <option value="local">На хосте PL</option>
                    <option value="external">Внешний сервис</option>
                  </select>
                </label>
                <label>
                  <span>Сортировка</span>
                  <select
                    aria-label="Сортировка модулей"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="problems">Сначала проблемы</option>
                    <option value="name">По названию</option>
                  </select>
                </label>
              </div>
              <p className="module-list-count" aria-live="polite">
                Показано {visibleInstances.length} из {installed.length}
              </p>
              <div className="module-instances">
                {visibleInstances.map((instance) => (
                  <InstanceCard
                    key={instance.id}
                    instance={instance}
                    onNotice={setNotice}
                    setupJobID={setupJobID}
                    onSetupHandled={setupHandled}
                  />
                ))}
              </div>
              {!visibleInstances.length && (
                <Empty
                  title="Модули не найдены"
                  detail="Измените поиск или фильтры."
                  action={
                    <Button
                      onClick={() => {
                        setSearch("");
                        setStatusFilter("all");
                        setPlacement("all");
                      }}
                    >
                      Сбросить фильтры
                    </Button>
                  }
                />
              )}
            </>
          ) : !instances.error ? (
            <Empty
              title="Модули ещё не добавлены"
              detail="Установите сервис на этом хосте или подключите существующий в каталоге модулей."
              action={
                <a className="button button-secondary" href="#module-catalog">
                  Открыть каталог модулей
                </a>
              }
            />
          ) : null}
        </section>
      )}
      {installChoices && (
        <AddModules
          choices={installChoices}
          onClose={() => setInstallChoices(undefined)}
          onQueued={(names) => {
            setNotice(
              `Созданы задания на установку ${names.join(", ")}. Ход установки виден в подключённых модулях.`,
            );
            setInstallChoices(undefined);
          }}
        />
      )}
      {adding && (
        <AddModule
          key={`${adding.descriptor.id}:${adding.mode}`}
          descriptor={adding.descriptor}
          mode={adding.mode}
          managedCredentials={
            catalog.data?.managed_credentials_available === true
          }
          existing={(instances.data?.items || []).filter(
            (item) =>
              item.module_id === adding.descriptor.id &&
              (["bookstack", "netmap"].includes(adding.descriptor.id) ||
                item.mode === adding.mode),
          )}
          onClose={() => setAdding(undefined)}
          onCreated={(value) => {
            setAdding(undefined);
            const route = new URLSearchParams({ instance: value.instance.id });
            if (
              value.instance.mode === "local" &&
              supportsInitialLogin(value.instance.module_id)
            )
              route.set("setup", value.job.id);
            location.hash = "modules?" + route.toString();
          }}
        />
      )}
    </div>
  );
}

function ModuleCatalogSource({
  localAvailable,
  hasLocalOffers,
}: {
  localAvailable: boolean;
  hasLocalOffers: boolean;
}) {
  const delivery = useDelivery(localAvailable);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>();
  const deliveryUnavailable =
    delivery.error instanceof APIError &&
    (delivery.error.status === 404 ||
      (hasLocalOffers && delivery.error.code === "delivery_unavailable"));
  const canCheck = localAvailable && !deliveryUnavailable;
  const failed = !!(
    checkError ||
    delivery.data?.error ||
    (canCheck && delivery.error)
  );

  async function check() {
    setChecking(true);
    setCheckError(undefined);
    try {
      await checkDeliveryCatalog();
    } catch (error) {
      setCheckError(error);
    } finally {
      setChecking(false);
    }
  }

  if (localAvailable && hasLocalOffers && !failed && !checking) return null;
  let title = "Каталог установки ещё не загружен";
  if (!localAvailable) title = "Установка на сервере PL недоступна";
  else if (!canCheck) title = "На этой установке нет доступных пакетов";
  else if (checking) title = "Проверяем каталог установки…";
  else if (failed) title = "Не удалось проверить каталог установки";
  else if (delivery.data?.latest_version)
    title = "Нет пакетов для этого сервера";
  return (
    <section className="module-catalog-source" aria-label="Каталог установки">
      <div aria-live="polite">
        <strong>{title}</strong>
        <p className="muted">
          {!canCheck
            ? "Подключение уже работающих сервисов доступно из карточек ниже."
            : hasLocalOffers
              ? "Доступны пакеты из сохранённого каталога."
              : "Проверьте каталог. Если для доступа к GitHub нужен прокси, настройте его и повторите проверку."}
        </p>
        {checkError !== undefined && (
          <p className="module-install-error" role="alert">
            {errorText(checkError)}
          </p>
        )}
      </div>
      {canCheck && (
        <div className="actions">
          <Button disabled={checking} onClick={() => void check()}>
            <RefreshCw size={15} /> Проверить каталог
          </Button>
          <a
            className="button button-secondary"
            href="#settings?section=delivery"
          >
            Настроить прокси для GitHub
          </a>
        </div>
      )}
    </section>
  );
}

type InstallSubmission = {
  status: "queued" | "existing" | "failed";
  message?: string;
};

function AddModules({
  choices,
  onClose,
  onQueued,
}: {
  choices: ModuleDescriptor[];
  onClose: () => void;
  onQueued: (names: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState(new Map<string, InstallSubmission>());
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());
  const pending = choices.filter(
    (module) =>
      selected.includes(module.id) &&
      !["queued", "existing"].includes(results.get(module.id)?.status || ""),
  );

  async function install() {
    if (busy || !pending.length) return;
    setBusy(true);
    const next = new Map(results);
    for (const module of pending) {
      try {
        const key = keys.current.get(module.id) || crypto.randomUUID();
        keys.current.set(module.id, key);
        const result = await createModule(
          { module_id: module.id, name: module.name, mode: "local" },
          key,
        );
        queryClient.setQueryData([`/jobs/${result.job.id}`], result.job);
        next.set(module.id, { status: "queued" });
      } catch (error) {
        if (error instanceof APIError && error.code === "module_exists") {
          next.set(module.id, { status: "existing" });
        } else {
          next.set(module.id, {
            status: "failed",
            message:
              error instanceof TypeError
                ? "Связь с PL прервалась. Повторите отправку после восстановления связи."
                : errorText(moduleError(error)),
          });
          if (
            !(error instanceof APIError) ||
            error.status >= 500 ||
            error.status === 401 ||
            error.status === 403
          )
            break;
        }
      }
      setResults(new Map(next));
    }
    setResults(next);
    setBusy(false);
    void refreshModules();
    if (selected.every((id) => next.get(id)?.status === "queued")) {
      onQueued(
        choices
          .filter((module) => next.get(module.id)?.status === "queued")
          .map((module) => module.name),
      );
    }
  }

  return (
    <Dialog
      title="Установить несколько модулей"
      description="Выберите модули. PL поставит их в очередь, а ход установки будет виден в подключённых модулях."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void install();
        }}
      >
        <fieldset className="module-install-choices" disabled={busy}>
          <legend>Модули для установки</legend>
          {choices.map((module) => {
            const result = results.get(module.id);
            return (
              <div className="module-install-choice" key={module.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(module.id)}
                    disabled={
                      result?.status === "queued" ||
                      result?.status === "existing"
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, module.id]
                          : current.filter((id) => id !== module.id),
                      )
                    }
                  />
                  <strong>{module.name}</strong>
                  {module.version && (
                    <span className="tag">{module.version}</span>
                  )}
                </label>
                {result && (
                  <p
                    className={
                      result.status === "failed"
                        ? "module-install-error"
                        : "muted"
                    }
                  >
                    {result.status === "queued"
                      ? "Задание создано"
                      : result.status === "existing"
                        ? "Модуль уже добавлен"
                        : result.message}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
        <div className="actions dialog-actions">
          {results.size > 0 && !busy && (
            <a
              className="button button-secondary"
              href="#modules"
              onClick={onClose}
            >
              К подключённым модулям
            </a>
          )}
          <Button
            type="submit"
            variant="default"
            disabled={busy || !pending.length}
          >
            <Download size={16} />{" "}
            {busy ? "Ставим в очередь…" : "Запустить установку"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InstanceCard({
  instance,
  onNotice,
  setupJobID,
  onSetupHandled,
}: {
  instance: ModuleInstance;
  onNotice: (message: string) => void;
  setupJobID: string;
  onSetupHandled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [removing, setRemoving] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const completedJob = useRef("");
  const keys = useRef(new Map<string, string>());
  const jobID = instance.last_job_id || "";
  const job = useQuery({
    queryKey: [`/jobs/${jobID}`],
    queryFn: ({ signal }) => moduleRequest<Job>(`/jobs/${jobID}`, signal),
    enabled: !!jobID,
    refetchInterval: (query) =>
      activeJob(query.state.data?.status) ? 2000 : false,
    retry: false,
  });
  const pending =
    busy ||
    ["pending", "removing"].includes(instance.observed_state) ||
    activeJob(job.data?.status);
  const disabled = instance.desired_state === "disabled";
  const removalRequested = instance.desired_state === "removed";
  const { state, stale, problem } = moduleHealth(instance);
  const presentation = modulePresentation[instance.module_id];
  const Icon = presentation?.icon || Server;
  const primary = modulePrimaryLink(instance);
  const auditorPath = auditorNativePath(instance);
  const lastCompleted = job.data?.finished_at;
  useEffect(() => {
    if (lastCompleted && completedJob.current !== jobID) {
      completedJob.current = jobID;
      if (
        job.data?.parameters?.action === "remove" &&
        job.data.status === "succeeded"
      )
        onNotice(
          `«${instance.name}»: удаление завершено. Принятые ранее ресурсы целей сохранены.`,
        );
      void refreshModules();
    }
  }, [lastCompleted, jobID, job.data, instance.name, onNotice]);

  async function action(value: ModuleAction) {
    setBusy(true);
    setError(undefined);
    onNotice("");
    const key = keys.current.get(value) || crypto.randomUUID();
    keys.current.set(value, key);
    try {
      const result = await api<ModuleOperation>(
        `/modules/${instance.id}/actions`,
        "POST",
        {
          action: value,
          idempotency_key: key,
          ...(value === "remove" ? { confirm_name: confirmName } : {}),
        },
        {},
        AbortSignal.timeout(20000),
      );
      keys.current.delete(value);
      if (value === "remove") setRemoving(false);
      queryClient.setQueryData([`/jobs/${result.job.id}`], result.job);
      queryClient.setQueryData<{ items: ModuleInstance[] }>(
        ["/modules"],
        (previous) =>
          previous
            ? {
                items: previous.items.map((item) =>
                  item.id === result.instance.id ? result.instance : item,
                ),
              }
            : previous,
      );
      onNotice(
        `«${instance.name}»: ${operationNames[value].toLocaleLowerCase("ru-RU")} добавлено в очередь.`,
      );
      await refreshModules();
    } catch (e) {
      setError(moduleError(e));
      void refreshModules();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`module-instance${problem ? " needs-attention" : ""}`}
      id={`module-${instance.id}`}
      tabIndex={-1}
      aria-label={instance.name}
    >
      <div className="module-instance-heading">
        <span className="module-instance-icon">
          <Icon size={22} aria-hidden="true" />
        </span>
        <div className="module-instance-title">
          <h3>{instance.name}</h3>
          <p className="muted">
            {presentation?.name || instance.module_id}
            {instance.version
              ? ` · ${instance.version}`
              : " · Версия неизвестна"}
          </p>
        </div>
        <ModuleActionMenu
          name={instance.name}
          pending={pending}
          disabled={disabled}
          removing={removalRequested}
          onAction={(value) => void action(value)}
          onRemove={() => {
            setConfirmName("");
            setRemoving(true);
          }}
        />
      </div>
      <div className="module-card-state">
        <Badge
          value={
            instance.module_id === "mailcow" && state === "running"
              ? "info"
              : stale
                ? "warning"
                : state === "running"
                  ? "ok"
                  : state
          }
        >
          {stale
            ? "Данные устарели"
            : instance.module_id === "mailcow" && state === "running"
              ? "Подключение добавлено"
              : moduleStates[state] || "Состояние неизвестно"}
        </Badge>
        <span className="module-placement">
          {instance.mode === "local" ? "На хосте PL" : "Внешний сервис"}
        </span>
      </div>
      {instance.endpoint && (
        <p className="module-card-endpoint" title={instance.endpoint}>
          {instance.endpoint}
        </p>
      )}
      <p className="module-card-check">
        <span>
          {stale && instance.last_success
            ? "Последний успех"
            : "Последняя проверка"}
        </span>
        <time>
          {date(
            stale && instance.last_success
              ? instance.last_success
              : instance.last_attempt,
          )}
        </time>
      </p>
      {instance.module_id === "prometheus" &&
        instance.last_success &&
        instance.targets_total !== undefined && (
          <p className="module-card-targets">
            Цели сбора:{" "}
            <strong>
              {instance.targets_up ?? "—"} / {instance.targets_total}
            </strong>
          </p>
        )}
      {instance.error && (
        <p className="module-card-error" title={instance.error}>
          {instance.error}
        </p>
      )}
      {job.data && (
        <div
          className={`module-job module-card-operation ${job.data.status === "failed" ? "is-failed" : ""}`}
          role={activeJob(job.data.status) ? "status" : undefined}
        >
          <span>
            {job.data.parameters?.action === "install" &&
            instance.mode === "external"
              ? "Подключение"
              : operationNames[String(job.data.parameters?.action)] ||
                "Операция"}
          </span>
          <Badge value={job.data.status} />
          {job.data.error && (
            <p className="module-job-error" title={job.data.error}>
              {job.data.error}
            </p>
          )}
        </div>
      )}
      {job.error && (
        <p className="module-card-error">
          Не удалось получить состояние операции. Подробности — в карточке.
        </p>
      )}
      <div className="module-card-actions">
        {primary && !removalRequested && (
          <a
            className="button button-secondary button-sm"
            href={primary.href}
            target={primary.href.startsWith("/") ? "_blank" : undefined}
            rel={
              primary.href.startsWith("/") ? "noopener noreferrer" : undefined
            }
          >
            {primary.label}
            {primary.href.startsWith("/") && <ArrowUpRight size={14} />}
          </a>
        )}
        <Button size="sm" variant="ghost" onClick={() => setDetailsOpen(true)}>
          Подробнее
        </Button>
      </div>
      {instance.mode === "local" &&
        supportsInitialLogin(instance.module_id) &&
        !removalRequested && (
          <div className="module-card-initial-login">
            <ModuleInitialLogin
              instanceID={instance.id}
              moduleID={instance.module_id}
              autoOpenKey={
                setupJobID === jobID &&
                job.data?.status === "succeeded" &&
                job.data.parameters?.action === "install" &&
                instance.observed_state === "running"
                  ? jobID
                  : undefined
              }
              onAutoOpen={onSetupHandled}
              disabled={
                instance.desired_state !== "enabled" ||
                instance.observed_state !== "running"
              }
            />
          </div>
        )}
      {detailsOpen && (
        <WorkspaceDrawer
          title={instance.name}
          subtitle={`${presentation?.name || instance.module_id} · ${instance.mode === "local" ? "На хосте PL" : "Внешний сервис"}`}
          onClose={() => setDetailsOpen(false)}
        >
          <div className="module-drawer-content">
            {instance.endpoint && (
              <p className="module-endpoint">
                {instance.mode === "local" && "Служебный адрес на хосте: "}
                {instance.endpoint}
              </p>
            )}
            <dl className="detail-grid module-details">
              <div>
                <dt>Версия</dt>
                <dd>{instance.version || "—"}</dd>
              </div>
              <div>
                <dt>
                  {instance.module_id !== "prometheus"
                    ? "Управление"
                    : "Доступные цели сбора / всего"}
                </dt>
                <dd>
                  {instance.module_id !== "prometheus"
                    ? "Через Платформу"
                    : instance.last_success &&
                        instance.targets_total !== undefined
                      ? `${instance.targets_up ?? "—"} / ${instance.targets_total}`
                      : "—"}
                </dd>
              </div>
              <div>
                <dt>Последняя проверка</dt>
                <dd>{date(instance.last_attempt)}</dd>
              </div>
              <div>
                <dt>Последний успех</dt>
                <dd>{date(instance.last_success)}</dd>
              </div>
            </dl>
            {instance.mode === "local" &&
              instance.module_id === "prometheus" && (
                <p className="module-hint">
                  После установки Prometheus собирает собственные метрики: одна
                  доступная цель из одной означает сам Prometheus. Остальные
                  цели добавляются в его конфигурацию.
                </p>
              )}
            <div className="actions module-service-links">
              {instance.mode === "local" &&
                supportsInitialLogin(instance.module_id) &&
                !removalRequested && (
                  <ModuleInitialLogin
                    instanceID={instance.id}
                    moduleID={instance.module_id}
                    disabled={
                      instance.desired_state !== "enabled" ||
                      instance.observed_state !== "running"
                    }
                  />
                )}
              {["forms", "doska", "sftpgo"].includes(instance.module_id) &&
                !removalRequested && (
                  <a
                    className="button button-secondary button-sm"
                    href={`/${instance.module_id}/`}
                  >
                    {instance.module_id === "sftpgo"
                      ? "Открыть файлы"
                      : `Открыть ${instance.module_id === "forms" ? "Forms" : "Doska"}`}{" "}
                    <ArrowUpRight size={14} />
                  </a>
                )}
              {instance.module_id === "sftpgo" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href={`#files?instance=${instance.id}`}
                >
                  Управлять SFTPGo
                </a>
              )}
              {instance.module_id === "mailcow" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href={`#mail?instance=${instance.id}`}
                >
                  Управлять почтой
                </a>
              )}
              {instance.module_id === "netmap" && !removalRequested && (
                <>
                  <a
                    className="button button-secondary button-sm"
                    href="/netmap/"
                  >
                    Открыть NetMap <ArrowUpRight size={14} />
                  </a>
                  <a
                    className="button button-secondary button-sm"
                    href={`#modules?instance=${instance.id}&view=netmap`}
                  >
                    Настроить сети
                  </a>
                </>
              )}
              {instance.module_id === "bookstack" && !removalRequested && (
                <a className="button button-secondary button-sm" href="/wiki/">
                  Открыть Wiki <ArrowUpRight size={14} />
                </a>
              )}
              {instance.module_id === "bookstack" &&
                instance.mode === "external" &&
                !removalRequested && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => setConnectionOpen(true)}
                  >
                    <Link size={14} /> Изменить подключение
                  </Button>
                )}
              {instance.module_id === "grafana" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href="/grafana/"
                >
                  Открыть Grafana <ArrowUpRight size={14} />
                </a>
              )}
              {instance.module_id === "wayline" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href="/wayline/"
                >
                  Открыть Wayline <ArrowUpRight size={14} />
                </a>
              )}
              {instance.module_id === "fileauditor" &&
                auditorPath &&
                !removalRequested && (
                  <a
                    className="button button-secondary button-sm"
                    href={auditorPath}
                  >
                    Открыть File Auditor <ArrowUpRight size={14} />
                  </a>
                )}
              {instance.module_id === "alertmanager" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href={`#modules?instance=${instance.id}&view=alertmanager`}
                >
                  Настроить уведомления
                </a>
              )}
              {instance.module_id === "xray" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href={`#modules?instance=${instance.id}&view=xray`}
                >
                  Настройка и мониторинг Xray
                </a>
              )}
              {instance.module_id === "prometheus" && !removalRequested && (
                <a
                  className="button button-secondary button-sm"
                  href={
                    instance.mode === "local"
                      ? `#monitoring?instance=${instance.id}&tab=configuration`
                      : `#modules?instance=${instance.id}&view=configuration`
                  }
                >
                  Jobs и targets
                </a>
              )}
              {instance.module_id === "prometheus" &&
                !disabled &&
                !removalRequested && (
                  <a
                    className="button button-secondary button-sm"
                    href={
                      instance.mode === "local"
                        ? `#monitoring?instance=${instance.id}&tab=monitoring`
                        : `#modules?instance=${instance.id}&view=monitoring`
                    }
                  >
                    Мониторинг Prometheus
                  </a>
                )}
              {instance.module_id === "prometheus" &&
                instance.mode === "local" &&
                state === "running" &&
                !disabled &&
                !removalRequested && (
                  <a
                    className="button button-secondary button-sm"
                    href={`/api/v1/modules/${instance.id}/prometheus/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Интерфейс Prometheus <ArrowUpRight size={14} />
                  </a>
                )}
              {instance.integration_id && (
                <a
                  className="button button-secondary button-sm"
                  href={`#settings?integration=${instance.integration_id}`}
                >
                  Интеграция
                </a>
              )}
              {instance.resource_id && (
                <a
                  className="button button-secondary button-sm"
                  href={`#catalog?resource=${instance.resource_id}`}
                >
                  Ресурс в каталоге
                </a>
              )}
              {instance.integration_id && (
                <a className="button button-ghost button-sm" href="#candidates">
                  Обнаруженные цели
                </a>
              )}
            </div>
            {(state !== "running" || stale) && instance.last_success && (
              <p className="module-hint">
                Показаны данные последней успешной проверки.
              </p>
            )}
            {instance.error && <ErrorBox error={new Error(instance.error)} />}
            {job.error && (
              <ErrorBox
                error={moduleError(job.error)}
                retry={() => void job.refetch()}
              />
            )}
            {job.data && (
              <div
                className="module-job"
                role={activeJob(job.data.status) ? "status" : undefined}
              >
                <div className="module-job-heading">
                  <span>
                    {job.data.parameters?.action === "install" &&
                    instance.mode === "external"
                      ? "Подключение"
                      : operationNames[String(job.data.parameters?.action)] ||
                        "Операция"}
                  </span>
                  <Badge value={job.data.status} />
                </div>
                <small>
                  {date(job.data.started_at || job.data.created_at)}
                  {job.data.finished_at
                    ? ` → ${date(job.data.finished_at)}`
                    : ""}
                </small>
                {job.data.error && job.data.error !== instance.error && (
                  <p className="module-job-error">{job.data.error}</p>
                )}
              </div>
            )}
            <div className="actions module-instance-actions">
              <Button
                size="sm"
                disabled={pending || disabled || removalRequested}
                onClick={() => void action("refresh")}
              >
                <RefreshCw size={14} /> Проверить
              </Button>
              {!removalRequested && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => void action(disabled ? "enable" : "disable")}
                >
                  {disabled ? <Play size={14} /> : <Pause size={14} />}
                  {disabled ? "Включить" : "Отключить"}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  setConfirmName("");
                  setRemoving(true);
                }}
              >
                <Trash2 size={14} />{" "}
                {removalRequested ? "Повторить удаление" : "Удалить"}
              </Button>
            </div>
            <p className="module-hint">
              {removalRequested
                ? "Удаление запрошено. При ошибке повторите операцию; карточка исчезнет после подтверждения удаления."
                : instance.mode === "local"
                  ? "Отключение останавливает сервис и сохраняет его данные."
                  : instance.module_id === "netmap"
                    ? "Отключение прекращает доступ и проверки NetMap через PL. Внешний сервер и его данные сохраняются."
                    : "Отключение прекращает проверки в Платформе. Внешний сервис продолжает работать."}
            </p>
          </div>
        </WorkspaceDrawer>
      )}
      <ActionFeedback error={error} />
      {removing && (
        <Dialog
          title={`Удалить «${instance.name}»?`}
          description="Удаление нельзя отменить."
          onClose={() => {
            if (!busy) setRemoving(false);
          }}
        >
          <p>
            {instance.module_id === "netmap"
              ? instance.mode === "external"
                ? "Будут удалены подключение NetMap, ключ связи, интеграция и карточки сервисов в PL. Внешние NetBox, Oxidized, Gitea и все данные сохранятся на своём хосте."
                : "Будут удалены все компоненты сетевого стека, инвентарь NetBox, конфигурации и история Gitea, профили опроса и четыре карточки сервисов. Восстановление возможно только из отдельной резервной копии."
              : instance.module_id === "bookstack"
                ? instance.mode === "external"
                  ? "Будут удалены подключение Wiki, интеграция и карточка в PL. Внешний BookStack, его учётные записи, документы и вложения сохранятся на своём хосте."
                  : "Будут удалены Wiki, её база данных, документы, изображения, вложения и настройки BookStack. Восстановление возможно только из отдельной резервной копии."
                : instance.module_id === "sftpgo"
                  ? "Будут удалены файловый сервер, его учётные записи, настройки и все принадлежащие экземпляру файлы. Восстановление возможно только из отдельной резервной копии."
                  : instance.module_id === "forms"
                    ? "Будут удалены контейнеры Forms, анкеты, ответы, аналитика, настройки и интеграция PL. Восстановление возможно только из отдельной резервной копии."
                    : instance.module_id === "doska"
                      ? "Будут удалены контейнеры Doska, проекты, задачи, вложения, настройки и интеграция PL. Восстановление возможно только из отдельной резервной копии."
                      : instance.module_id === "grafana"
                        ? "Будут удалены контейнер Grafana, панели, источники данных, локальные настройки и интеграция PL. Метрики Prometheus сохранятся."
                        : instance.module_id === "wayline"
                          ? instance.mode === "local"
                            ? "Будут удалены контейнеры Wayline, цели, история проверок и интеграция PL."
                            : "Будет удалено подключение Wayline в PL. Внешнее приложение и его данные сохранятся."
                          : instance.module_id === "fileauditor"
                            ? "Будет удалено только подключение File Auditor в PL. Windows-сервер, приложение и результаты сканирования сохранятся."
                            : instance.module_id === "alertmanager"
                              ? "Будут удалены контейнер Alertmanager, его конфигурация, секреты получателей и карточка сервиса. Доставка уведомлений этого экземпляра прекратится."
                              : instance.module_id === "xray"
                                ? "Будут удалены принадлежащие этому экземпляру контейнер Xray, конфигурация, секреты подключений и карточка сервиса. Выбранные proxy-порты будут закрыты."
                                : instance.mode === "local"
                                  ? "Будут удалены контейнер Prometheus, его конфигурация и хранилище метрик, а также интеграция, карточка сервиса и связанные данные обнаружения в Платформе."
                                  : "Будут удалены подключение, интеграция, карточка сервиса и связанные данные обнаружения в Платформе. Внешний Prometheus и его данные останутся на своём хосте."}
          </p>
          <p className="muted">
            {instance.module_id === "prometheus" &&
              "Ресурсы целей, которые вы ранее приняли в каталог, сохранятся. "}
            История операций останется в журнале.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (confirmName === instance.name) void action("remove");
            }}
          >
            <Field label={`Введите название: ${instance.name}`}>
              <input
                autoFocus
                value={confirmName}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setConfirmName(event.target.value)}
              />
            </Field>
            <div className="dialog-footer">
              <Button disabled={busy} onClick={() => setRemoving(false)}>
                Отмена
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={busy || confirmName !== instance.name}
              >
                {busy
                  ? "Отправляем…"
                  : instance.module_id === "netmap" &&
                      instance.mode === "external"
                    ? "Удалить подключение"
                    : "Удалить полностью"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {connectionOpen && (
        <BookStackConnection
          instance={instance}
          onClose={() => setConnectionOpen(false)}
          onSaved={() => {
            setConnectionOpen(false);
            onNotice(
              `«${instance.name}»: изменение подключения добавлено в очередь.`,
            );
          }}
        />
      )}
    </article>
  );
}

function BookStackConnection({
  instance,
  onClose,
  onSaved,
}: {
  instance: ModuleInstance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [endpoint, setEndpoint] = useState(instance.endpoint || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<
    { endpoint: string; revision: number; key: string } | undefined
  >(undefined);
  async function submit() {
    const address = endpoint.trim();
    if (request.current?.endpoint !== address)
      request.current = {
        endpoint: address,
        revision: instance.revision,
        key: crypto.randomUUID(),
      };
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<ModuleOperation>(
        `/modules/${instance.id}/actions`,
        "POST",
        {
          action: "reconnect",
          endpoint: address,
          revision: request.current.revision,
          idempotency_key: request.current.key,
        },
        {},
        AbortSignal.timeout(20000),
      );
      queryClient.setQueryData([`/jobs/${result.job.id}`], result.job);
      await refreshModules();
      onSaved();
    } catch (e) {
      if (e instanceof APIError && e.code === "revision_conflict")
        request.current = undefined;
      setError(moduleError(e));
      void refreshModules();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Подключение Wiki"
      description="Новый адрес или повторное разрешение адреса после смены IP."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Адрес BookStack"
          hint="HTTP(S) адрес сервера с портом, без /wiki и других путей."
        >
          <input
            type="url"
            autoFocus
            required
            value={endpoint}
            disabled={busy}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </Field>
        <p className="muted">
          На сервере BookStack задайте APP_URL={location.origin}/wiki.
          Пользователи входят своей учётной записью BookStack.
        </p>
        <p className="muted">
          Сохранение заново разрешает адрес и включает подключение. PL проверит
          базу, cache, session и адрес формы входа. Книги и вложения между
          серверами не переносятся.
        </p>
        {!!error && <ErrorBox error={error} />}
        <div className="dialog-footer">
          <Button disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button
            type="submit"
            variant="default"
            disabled={busy || !endpoint.trim()}
          >
            {busy ? "Отправляем…" : "Сохранить и проверить"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddModule({
  descriptor,
  mode,
  managedCredentials,
  existing,
  onClose,
  onCreated,
}: {
  descriptor: ModuleDescriptor;
  mode: ModuleMode;
  managedCredentials: boolean;
  existing: ModuleInstance[];
  onClose: () => void;
  onCreated: (value: ModuleOperation) => void;
}) {
  const [additional, setAdditional] = useState(false);
  const [existingID, setExistingID] = useState(existing[0]?.id || "");
  const [name, setName] = useState(descriptor.name);
  const [endpoint, setEndpoint] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [apiKey, setAPIKey] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [credentialSource, setCredentialSource] = useState<"key" | "reference">(
    managedCredentials ? "key" : "reference",
  );
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<{ serialized: string; key: string } | undefined>(
    undefined,
  );
  const connectionName =
    descriptor.id === "mailcow" ? "Mailcow" : descriptor.name;
  const externalNetMap = descriptor.id === "netmap" && mode === "external";
  function close() {
    setGatewayKey("");
    request.current = undefined;
    onClose();
  }
  async function submit() {
    if (busy) return;
    const submittedGatewayKey = gatewayKey;
    if (externalNetMap) setGatewayKey("");
    setError(undefined);
    if (externalNetMap && !managedCredentials) {
      setError(
        new Error(
          "Сохранение ключей подключения на этой установке недоступно.",
        ),
      );
      return;
    }
    if (externalNetMap && !/^[0-9a-fA-F]{64}$/.test(submittedGatewayKey)) {
      setError(
        new Error("Укажите ключ NetMap из 64 шестнадцатеричных символов."),
      );
      return;
    }
    const payload = {
      module_id: descriptor.id,
      name: name.trim(),
      mode,
      ...(additional ? { additional_instance: true } : {}),
      ...(mode === "external" ? { endpoint: endpoint.trim() } : {}),
      ...(externalNetMap
        ? { gateway_key: submittedGatewayKey.toLowerCase() }
        : {}),
      ...(mode === "external" &&
      ["wayline", "fileauditor", "mailcow"].includes(descriptor.id)
        ? {
            ...(descriptor.id === "mailcow" && credentialSource === "key"
              ? { api_key: apiKey }
              : { secret_ref: secretRef.trim() }),
            config:
              descriptor.id === "wayline" && username.trim()
                ? { basic_username: username.trim() }
                : {},
          }
        : {}),
    };
    if (mode === "external") {
      try {
        const url = new URL(payload.endpoint!);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search ||
          (externalNetMap &&
            (url.protocol !== "https:" ||
              url.pathname !== "/" ||
              payload.endpoint!.includes("\\")))
        )
          throw new Error();
      } catch {
        setError(
          new Error(
            externalNetMap
              ? "Укажите HTTPS-адрес удалённого NetMap без /netmap, других путей, логина и параметров."
              : `Укажите адрес ${connectionName}, начиная с http:// или https://. Уберите логин, пароль и параметры после ? или #.`,
          ),
        );
        return;
      }
    }
    setBusy(true);
    try {
      // A retry retains only the NetMap payload digest, never its plaintext key.
      const serialized = externalNetMap
        ? Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(JSON.stringify(payload)),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("")
        : JSON.stringify(payload);
      if (request.current?.serialized !== serialized)
        request.current = { serialized, key: crypto.randomUUID() };
      const result = await createModule(payload, request.current.key);
      setAPIKey("");
      request.current = undefined;
      queryClient.setQueryData([`/jobs/${result.job.id}`], result.job);
      await refreshModules();
      onCreated(result);
    } catch (e) {
      if (
        e instanceof APIError &&
        e.code === "module_exists" &&
        typeof e.details.existing_instance_id === "string"
      ) {
        setExistingID(e.details.existing_instance_id);
        setAdditional(false);
      }
      setError(moduleError(e));
      void refreshModules();
    } finally {
      setGatewayKey("");
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${mode === "local" ? "Установить" : "Подключить"} ${connectionName}`}
      description={
        mode === "local"
          ? "Новый экземпляр на хосте Платформы."
          : `Подключите уже работающий ${connectionName}.`
      }
      onClose={() => {
        if (!busy) close();
      }}
    >
      {existingID && !additional ? (
        <>
          <div className="notice">
            <p>
              {descriptor.name} уже{" "}
              {mode === "local" ? "установлен на этом хосте" : "подключён"}.{" "}
              {existing.length > 1
                ? `Экземпляров: ${existing.length}.`
                : existing[0]?.name}
            </p>
            <p>
              {[
                "grafana",
                "forms",
                "doska",
                "sftpgo",
                "netmap",
                "bookstack",
              ].includes(descriptor.id) ? (
                "На этой установке доступен один экземпляр приложения с общим адресом интерфейса. Управляйте уже установленным экземпляром."
              ) : (
                <>
                  Дополнительный экземпляр получит отдельные настройки и
                  карточку в каталоге
                  {mode === "local" ? ", контейнер и хранилище" : ""}.
                </>
              )}
            </p>
          </div>
          <div className="dialog-footer">
            <Button
              onClick={() => {
                close();
                location.hash = `modules?instance=${existingID}`;
              }}
            >
              Открыть установленный
            </Button>
            {![
              "grafana",
              "forms",
              "doska",
              "sftpgo",
              "netmap",
              "bookstack",
            ].includes(descriptor.id) && (
              <Button
                variant="default"
                onClick={() => {
                  setAdditional(true);
                  setError(undefined);
                }}
              >
                Создать дополнительный экземпляр
              </Button>
            )}
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy} className="module-fields">
            <Field label="Название экземпляра">
              <input
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            {mode === "external" ? (
              <>
                <Field
                  label={`Адрес ${connectionName}`}
                  hint={
                    descriptor.id === "netmap"
                      ? "HTTPS-адрес удалённого NetMap, без /netmap и других путей."
                      : descriptor.id === "bookstack"
                        ? "Адрес сервера BookStack с портом, без /wiki и других путей."
                        : descriptor.id === "mailcow"
                          ? "Адрес панели Mailcow без /admin и /api/v1."
                          : descriptor.id === "fileauditor"
                            ? "Адрес File Auditor. Сохраните путь /audit, если сервис размещён по этому пути."
                            : descriptor.id === "wayline"
                              ? "Адрес Wayline, включая порт и путь, если они используются."
                              : "Адрес Prometheus с портом, без /api/v1."
                  }
                >
                  <input
                    type="url"
                    required
                    placeholder={
                      descriptor.id === "netmap"
                        ? "https://netmap.example.org"
                        : descriptor.id === "bookstack"
                          ? "https://wiki.example.org"
                          : descriptor.id === "fileauditor"
                            ? "https://auditor.example.org/audit"
                            : descriptor.id === "wayline"
                              ? "https://wayline.example.org"
                              : descriptor.id === "mailcow"
                                ? "https://mail.example.org"
                                : "http://prometheus.example.org:9090"
                    }
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </Field>
                {descriptor.id === "netmap" && (
                  <>
                    <Field
                      label="Ключ подключения NetMap"
                      hint="64 шестнадцатеричных символа из gateway_key_hex файла connection.json. Ключ сохраняется в PL и повторно не показывается."
                    >
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        minLength={64}
                        maxLength={64}
                        pattern="[0-9a-fA-F]{64}"
                        value={gatewayKey}
                        onChange={(event) => setGatewayKey(event.target.value)}
                      />
                    </Field>
                    <p className="muted">
                      При установке NetMap укажите публичный адрес PL{" "}
                      {location.origin}. Для входа в NetBox и Gitea используйте
                      учётные записи внешнего сервера. HTTPS-сертификату NetMap
                      должен доверять сервер PL.
                    </p>
                  </>
                )}
                {descriptor.id === "bookstack" && (
                  <p className="muted">
                    На сервере BookStack задайте APP_URL={location.origin}/wiki.
                    Доступ через /wiki/ требует входа администратора PL и
                    собственной учётной записи BookStack. Проверка HTTPS
                    использует доверенные сертификаты сервера PL.
                  </p>
                )}
                {descriptor.id === "grafana"
                  ? "Будет установлена Grafana с собственным входом и отдельным хранилищем данных. Начальная учётная запись: admin / admin. Пользователи, права и источники настраиваются в Grafana. Доступ — через прокси PL."
                  : descriptor.id === "wayline" && (
                      <Field
                        label="Логин Wayline"
                        hint="Заполните, если Wayline требует логин и пароль."
                      >
                        <input
                          value={username}
                          autoComplete="off"
                          onChange={(event) => setUsername(event.target.value)}
                        />
                      </Field>
                    )}
                {descriptor.id === "mailcow" && (
                  <Field label="API-ключ: способ ввода">
                    <select
                      value={credentialSource}
                      onChange={(event) => {
                        setCredentialSource(
                          event.target.value as "key" | "reference",
                        );
                        setAPIKey("");
                        setSecretRef("");
                        request.current = undefined;
                      }}
                    >
                      <option value="key" disabled={!managedCredentials}>
                        Ввести ключ
                      </option>
                      <option value="reference">
                        Использовать ключ на сервере
                      </option>
                    </select>
                  </Field>
                )}
                {descriptor.id === "mailcow" && credentialSource === "key" && (
                  <Field
                    label="API-ключ Mailcow"
                    hint="Доступ только для чтения. Ключ сохраняется в PL и повторно не показывается."
                  >
                    <input
                      type="password"
                      value={apiKey}
                      autoComplete="new-password"
                      required
                      maxLength={4096}
                      placeholder="Вставьте ключ из настроек Mailcow"
                      onChange={(event) => setAPIKey(event.target.value)}
                    />
                  </Field>
                )}
                {(["wayline", "fileauditor"].includes(descriptor.id) ||
                  (descriptor.id === "mailcow" &&
                    credentialSource === "reference")) && (
                  <Field
                    label={
                      descriptor.id === "mailcow"
                        ? "API-ключ Mailcow на сервере"
                        : descriptor.id === "fileauditor"
                          ? "Ключ доступа File Auditor на сервере"
                          : "Пароль Wayline на сервере"
                    }
                    hint={
                      descriptor.id === "mailcow"
                        ? "Ссылка на сохранённый ключ только для чтения: file:имя или env:PORTAL_SECRET_ИМЯ."
                        : descriptor.id === "fileauditor"
                          ? "Укажите file:имя разрешённого файла с ключом шлюза File Auditor."
                          : "Если указан логин, добавьте ссылку на сохранённый пароль: file:имя или env:PORTAL_SECRET_ИМЯ."
                    }
                  >
                    <input
                      value={secretRef}
                      required={["fileauditor", "mailcow"].includes(
                        descriptor.id,
                      )}
                      autoComplete="off"
                      placeholder={
                        descriptor.id === "mailcow"
                          ? "file:mailcow-api-key"
                          : descriptor.id === "fileauditor"
                            ? "file:auditor-gateway-key"
                            : "file:wayline-password"
                      }
                      onChange={(event) => setSecretRef(event.target.value)}
                    />
                  </Field>
                )}
                {descriptor.id === "mailcow" && (
                  <details className="settings-technical">
                    <summary>Как подключить Mailcow</summary>
                    <ol className="list-decimal space-y-2 pl-5 pt-3">
                      <li>
                        В Mailcow откройте «Система → Конфигурация», затем
                        «Настройки доступа → Администраторы» и раскройте «API».
                      </li>
                      <li>
                        В блоке «Доступ только для чтения» отметьте «Включить
                        API». В поле «Список IP-адресов для доступа к API»
                        добавьте IP хоста PL, каким его видит Mailcow: после
                        NAT, если он используется. Нажмите «Сохранить
                        изменения».
                      </li>
                      <li>Скопируйте «Ключ API» из этого же блока.</li>
                      <li>
                        В «Адрес Mailcow» укажите адрес панели, например
                        https://mail.example.org, без /admin и /api/v1.
                        Заполните поле API-ключа и нажмите «Подключить».
                      </li>
                      <li>
                        На странице «Почта» откройте «Сбор данных» и включите
                        нужные коллекторы.
                      </li>
                    </ol>
                  </details>
                )}
                <p className="muted">
                  {descriptor.id === "netmap"
                    ? "PL проверит NetMap и адрес Платформы, указанный при его установке. Опрос сети запускается отдельно. Отключение и удаление подключения сохраняют внешний сервер и его данные."
                    : descriptor.id === "bookstack"
                      ? "PL проверит подключение и форму входа BookStack. Отключение и удаление подключения не изменяют внешний сервер, книги и вложения."
                      : descriptor.id === "fileauditor"
                        ? "PL проверит подключение к File Auditor. Его интерфейс откроется через Платформу для просмотра состояния файлового сервера."
                        : descriptor.id === "mailcow"
                          ? "PL проверит доступ к API. После подключения включите нужные группы в разделе «Сбор данных»."
                          : descriptor.id === "wayline"
                            ? "Интерфейс Wayline откроется через PL. Цели и интервалы проверок настраиваются в Wayline."
                            : "PL проверит Prometheus и получит список targets. Поддерживается подключение без логина и пароля."}
                </p>
              </>
            ) : (
              <p className="muted">
                {descriptor.id === "sftpgo"
                  ? `Будет установлен SFTPGo ${descriptor.version} с отдельным хранилищем. Пароли и SSH-ключи настраиваются для каждой учётной записи. По умолчанию SFTP доступен только с хоста; адрес и порт выбираются в настройках модуля. Веб-доступ идёт через PL.`
                  : descriptor.id === "netmap"
                    ? `Будет установлен единый стек NetMap ${descriptor.version} с NetBox, Oxidized и Gitea. Сервисы доступны через PL; опрос сети запускается отдельно после настройки профиля доступа.`
                    : descriptor.id === "bookstack"
                      ? `Будет установлена Wiki на BookStack ${descriptor.version} с отдельной базой данных и собственным входом.`
                      : descriptor.id === "forms"
                        ? "Будут установлены Forms, приватный движок анкет и отдельные хранилища. Новая установка пустая. Анкеты и агрегаты доступны администратору, участие в опубликованных анкетах — пользователям PL. Служебные порты не публикуются в LAN."
                        : descriptor.id === "doska"
                          ? "Будут установлены Doska и отдельная база проектов и задач. Учётные записи синхронизируются из PL; доступ к доскам определяется правами приложения. Служебные порты не публикуются в LAN."
                          : descriptor.id === "grafana"
                            ? "Будет установлена Grafana с собственным входом и отдельным хранилищем данных. Начальная учётная запись: admin / admin. Пользователи, права и источники настраиваются в Grafana. Доступ — через прокси PL."
                            : descriptor.id === "wayline"
                              ? "Будут установлены Wayline и изолированный исполнитель сетевых проверок. Цели, интервалы и история хранятся отдельно. Вход — через Платформу, без публикации служебных портов в LAN."
                              : descriptor.id === "alertmanager"
                                ? `Будет установлен Alertmanager${descriptor.version ? ` ${descriptor.version}` : " из подготовленного пакета"}. Получателей и proxy доставки можно настроить в Платформе. По умолчанию уведомления выключены; API сервиса не публикуется в LAN.`
                                : descriptor.id === "xray"
                                  ? `Будет установлен Xray${descriptor.version ? ` ${descriptor.version}` : " из подготовленного пакета"}. После установки добавьте SOCKS/HTTP inbound и выберите прямой выход или импорт подключения по ссылке. По умолчанию proxy доступен только на loopback; авторизация для LAN опциональна. Управление доступно через Платформу.`
                                  : `Будет установлен Prometheus ${descriptor.version} с отдельным хранилищем и сбором собственных метрик. Сервис появится в интеграциях и каталоге. Jobs и targets доступны в редакторе конфигурации.`}
              </p>
            )}
          </fieldset>
          {!!error && <ErrorBox error={error} />}
          <div className="dialog-footer">
            <Button disabled={busy} onClick={close}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={busy || !name.trim()}
            >
              {busy
                ? "Отправляем…"
                : mode === "local"
                  ? "Установить"
                  : "Подключить"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
