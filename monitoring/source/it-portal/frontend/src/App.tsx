import LocalProxy, {
  type LocalProxyInstance,
  installedLocalXrays,
} from "./LocalProxy";
import {
  LocalAdminPassword,
  RequiredLocalPassword,
} from "./LocalAdminPassword";
import { ReleaseBanner, UpdateNotification } from "./UpdateSettings";
import { requestUpgradeStatus, UpgradeBoundary } from "./UpgradeExperience";
import {
  InstallationTransitionNotice,
  pendingInstallationTransition,
  settleInstallationTransition,
} from "./InstallationTransition";
import Modules from "./Modules";
import NavNetMap from "./NavNetMap";
import {
  externalModules,
  installedLocalModules,
  netMapModules,
} from "./managedModuleNavigation";
import { ActionFeedback } from "./ActionNotifications";
import {
  clearBoardLoginReturn,
  isBoardServiceID,
  pendingBoardLoginReturn,
  selectBoardLoginReturn,
} from "./boardLoginReturn";
import { employeeURL } from "./employeeServices";
import { isServiceCardResource } from "./serviceCardEligibility";
import { WorkspaceHome as Home } from "./WorkspaceHome";
import {
  WorkspaceProblemIndicator,
  openWorkspaceProblems,
} from "./WorkspaceProblems";
import {
  WorkspaceCheckButton,
  WorkspaceCheckManager,
  openWorkspaceCheck,
} from "./WorkspaceChecks";
import { WorkspaceLegacyRoute } from "./WorkspaceLegacyRoute";
import { catalogResourceId } from "./doskaCatalog";
import { lazy, Suspense } from "react";
const SFTPGoPage = lazy(() => import("./SFTPGoPage"));
const Monitoring = lazy(() => import("./Monitoring"));
const FilesModule = lazy(() => import("./FilesModule"));
const Notifications = lazy(() => import("./Notifications"));
const Mail = lazy(() => import("./Mail"));
import EmployeePortal from "./EmployeePortal";
import "./home-header.css";
import { ThemeToggle } from "./Theme";
import { PlatformShell } from "@pl/ui/react";
import {
  AuthScene,
  Brand,
  ErrorSceneContent,
  LoginSuccess,
  SceneArt,
} from "./AuthScenes";
import {
  clearLoginReturn,
  loginReturnTarget,
  pendingLoginReturn,
} from "./loginReturn";
import { HelpProvider, HelpButton, useHelpTopic, useHelpOpen } from "./Help";
import { helpTopics, type HelpTopic } from "./helpTopics";
import { ru } from "./ru";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Command,
  FileText,
  Activity,
  Folder,
  Home as HomeIcon,
  LayoutGrid,
  LogOut,
  Mail as MailIcon,
  Network,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Wrench,
  X,
  Shield,
  Radio,
  Eye,
  EyeOff,
  Blocks,
  Server,
} from "lucide-react";
import { api, useAPI, refresh, queryClient, setTimezone, safeURL } from "./api";
import { copy, nav } from "./copy";
import type { Session, Board, Resource, Preferences, Candidate } from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  Badge,
  Empty,
  ErrorBox,
  Field,
  ResourceIcon,
} from "./components/common";
import Catalog, { ResourceDetails } from "./Catalog";
import type { ResourceActions } from "./Catalog";
import ResourceEditor from "./ResourceEditor";
import { WaylineSelection } from "./Wayline";
import { OperationDialog } from "./Operations";
import { Candidates } from "./Observations";
import { Events } from "./Events";
import Settings from "./Settings";
import { withSettingsNavigation } from "./settings/navigation";
const icons = {
  home: HomeIcon,
  catalog: LayoutGrid,
  "module-catalog": Blocks,
  modules: Server,
  problems: AlertTriangle,
  tools: Wrench,
  reports: FileText,
  events: Bell,
  monitoring: Activity,
  notifications: Bell,
  mail: MailIcon,
  netmap: Network,
  files: Folder,
  settings: SettingsIcon,
  proxy: Radio,
  edge: Shield,
};
function route() {
  if (location.pathname === "/sftpgo" || location.pathname === "/sftpgo/")
    return "sftpgo";
  if (location.pathname === "/proxy-4.14") return "proxy";
  const [page, query] = location.hash.replace("#", "").split("?");
  if (
    page === "modules" &&
    new URLSearchParams(query).get("view") === "mailcow"
  )
    return "mail";
  return page || "home";
}
const knownPages = new Set([
  "sftpgo",
  "proxy",
  "home",
  "catalog",
  "module-catalog",
  "modules",
  "problems",
  "tools",
  "reports",
  "events",
  "monitoring",
  "notifications",
  "mail",
  "netmap",
  "files",
  "candidates",
  "settings",
]);
function isMissingLocation(page = route()) {
  return (
    (location.pathname !== "/" &&
      location.pathname !== "/reports/" &&
      location.pathname !== "/sftpgo" &&
      location.pathname !== "/sftpgo/" &&
      location.pathname !== "/proxy-4.14") ||
    !knownPages.has(page)
  );
}
const loginAnimationKey = "pl-ui-login-animation";
function markLoginSuccessCandidate() {
  try {
    sessionStorage.setItem(loginAnimationKey, String(Date.now()));
  } catch {
    /* optional */
  }
}
function takeLoginSuccessCandidate() {
  try {
    const stamp = Number(sessionStorage.getItem(loginAnimationKey));
    sessionStorage.removeItem(loginAnimationKey);
    return stamp > 0 && Date.now() - stamp < 5 * 60_000;
  } catch {
    return false;
  }
}
export default function App() {
  return (
    <UpgradeBoundary>
      <PortalApp />
    </UpgradeBoundary>
  );
}
function PortalApp() {
  useEffect(() => {
    if (
      ["/sftp-server", "/sftp-server/", "/sftp-adm", "/sftp-adm/"].includes(
        location.pathname,
      )
    )
      location.replace("/#files");
  }, []);
  const session = useAPI<Session>("/session");
  useEffect(() => {
    if (session.error) requestUpgradeStatus();
  }, [session.error]);
  const [error, setError] = useState<unknown>();
  const [successVisible, setSuccessVisible] = useState(
    takeLoginSuccessCandidate,
  );
  const [boardServiceID, setBoardServiceID] = useState(pendingBoardLoginReturn);
  const [boardReturnFailed, setBoardReturnFailed] = useState(false);
  const [boardSelectionError, setBoardSelectionError] = useState(false);
  const loginForm = useRef<HTMLDivElement>(null);
  const selectedBoard = useAPI<Board>(
    "/board",
    session.data?.authenticated === false && Boolean(boardServiceID),
  );
  const returningToService = useRef(false);
  useEffect(() => {
    if (
      !session.data?.authenticated ||
      !session.data.user?.admin ||
      session.data.local_password_change_required ||
      session.error ||
      !pendingInstallationTransition()
    )
      return;
    const controller = new AbortController();
    void api<{
      public_url: string;
      operation?: { operation_id: string; phase: string };
    }>("/installation", "GET", undefined, {}, controller.signal)
      .then(settleInstallationTransition)
      .catch(() => {});
    return () => controller.abort();
  }, [
    session.data?.authenticated,
    session.data?.user?.admin,
    session.data?.local_password_change_required,
    session.error,
  ]);
  useEffect(() => {
    const target = pendingLoginReturn();
    if (
      !session.data?.authenticated ||
      session.data.local_password_change_required ||
      returningToService.current
    )
      return;
    if (successVisible) {
      const delay = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 150
        : 1050;
      const timer = window.setTimeout(() => setSuccessVisible(false), delay);
      return () => window.clearTimeout(timer);
    }
    if (boardServiceID) {
      clearLoginReturn();
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        controller.abort();
        clearBoardLoginReturn();
        setBoardServiceID(undefined);
        setBoardReturnFailed(true);
      }, 10000);
      // Bypass the query cache: the anonymous projection has no URLs, and
      // publication or the primary URL may have changed during login.
      void api<Board>("/board", "GET", undefined, {}, controller.signal)
        .then((board) => {
          if (controller.signal.aborted) return;
          const href = employeeURL(
            board.items.find((item) => item.id === boardServiceID)?.url,
          );
          clearBoardLoginReturn();
          setBoardServiceID(undefined);
          if (href && href !== location.href) {
            returningToService.current = true;
            location.replace(href);
          } else {
            setBoardReturnFailed(true);
          }
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          clearBoardLoginReturn();
          setBoardServiceID(undefined);
          setBoardReturnFailed(true);
        })
        .finally(() => window.clearTimeout(timer));
      return () => {
        window.clearTimeout(timer);
        controller.abort();
      };
    }
    clearLoginReturn();
    if (loginReturnTarget(target)) {
      returningToService.current = true;
      location.replace(target);
    } else if (location.pathname === "/401") {
      returningToService.current = true;
      location.replace("/");
    }
  }, [
    session.data?.authenticated,
    session.data?.local_password_change_required,
    successVisible,
    boardServiceID,
  ]);
  useEffect(() => {
    if (
      session.data &&
      !session.data.local_password_change_required &&
      !knownPages.has(route()) &&
      location.pathname === "/"
    )
      location.replace("/404");
  }, [
    session.data?.local_password_change_required,
    session.data?.authenticated,
  ]);
  if (session.isPending)
    return (
      <AuthScene kind="login">
        <div className="auth-state" role="status">
          {copy.loading}
        </div>
      </AuthScene>
    );
  if (session.error)
    return (
      <AuthScene kind="login">
        <div className="auth-state">
          {pendingInstallationTransition() ? (
            <InstallationTransitionNotice
              retry={() => void session.refetch()}
            />
          ) : (
            <ErrorBox
              error={session.error}
              retry={() => void session.refetch()}
            />
          )}
        </div>
      </AuthScene>
    );
  const s = session.data!;
  if (s.timezone) setTimezone(s.timezone);
  if (s.authenticated && s.local_password_change_required)
    return <RequiredLocalPassword session={s} />;
  const requestedReturn =
    location.pathname === "/401" && location.hash.startsWith("#return_to:")
      ? location.hash.slice("#return_to:".length)
      : new URLSearchParams(location.search).get("return_to");
  async function demo(role: string) {
    try {
      await api("/auth/demo", "POST", { role });
      markLoginSuccessCandidate();
      queryClient.clear();
      location.reload();
    } catch (e) {
      setError(e);
    }
  }
  function chooseBoardService(id: string) {
    const stored = selectBoardLoginReturn(id);
    setBoardServiceID(stored ? id : undefined);
    setBoardSelectionError(!stored);
    const form = loginForm.current;
    form
      ?.querySelector<HTMLElement>(
        'input[autocomplete="username"], .auth-oidc-link, summary, button',
      )
      ?.focus({ preventScroll: true });
    form?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (s.authenticated && successVisible) return <LoginSuccess />;
  if (s.authenticated && (boardServiceID || boardReturnFailed))
    return (
      <AuthScene kind="login">
        <div className="auth-state" role="status">
          {boardReturnFailed ? (
            <>
              <h1>Не удалось открыть сервис</h1>
              <p>Проверьте список сервисов на главной и попробуйте ещё раз.</p>
              <Button onClick={() => location.replace("/")}>На главную</Button>
            </>
          ) : (
            "Открываем выбранный сервис…"
          )}
        </div>
      </AuthScene>
    );
  if (s.authenticated && location.pathname === "/401")
    return (
      <AuthScene kind="401">
        <div className="auth-state" role="status">
          {copy.loading}
        </div>
      </AuthScene>
    );
  if (
    !s.authenticated &&
    (location.pathname === "/401" || location.pathname === "/403")
  )
    return (
      <AuthScene kind="401">
        <ErrorSceneContent
          kind="401"
          returnTarget={
            loginReturnTarget(requestedReturn) ? requestedReturn : undefined
          }
        />
      </AuthScene>
    );
  if (!s.authenticated && isMissingLocation())
    return (
      <AuthScene kind="404">
        <ErrorSceneContent kind="404" />
      </AuthScene>
    );
  if (
    s.authenticated &&
    !s.user?.admin &&
    [
      "proxy",
      "monitoring",
      "notifications",
      "mail",
      "netmap",
      "files",
    ].includes(route())
  )
    return (
      <AuthScene kind="404">
        <ErrorSceneContent kind="403" />
      </AuthScene>
    );
  if (!s.authenticated)
    return (
      <>
        <AuthScene kind="login">
          <div className="auth-login" ref={loginForm}>
            <h1>Вход в Платформу</h1>
            {new URLSearchParams(location.search).get("password_changed") ===
              "1" && (
              <ActionFeedback notice="Пароль изменён. Войдите с новым паролем." />
            )}
            <p>
              {s.ad_login_enabled
                ? s.local_login_enabled
                  ? "Используйте доменную или локальную учётную запись."
                  : "Используйте доменную учётную запись."
                : s.oidc_login_enabled
                  ? "Выберите способ входа в Platform."
                  : s.local_login_enabled
                    ? "Используйте локальную учётную запись Платформы."
                    : "Способ входа не настроен."}
            </p>
            {boardServiceID && (
              <div className="board-login-selection" role="status">
                <p>
                  После входа откроется{" "}
                  <strong>
                    {selectedBoard.data?.items.find(
                      (item) => item.id === boardServiceID,
                    )?.name || "выбранный сервис"}
                  </strong>
                  .
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearBoardLoginReturn();
                    setBoardServiceID(undefined);
                  }}
                >
                  Отменить выбор
                </Button>
              </div>
            )}
            {boardSelectionError && (
              <p role="alert">
                Браузер не сохранил выбор. После входа откройте сервис на
                главной.
              </p>
            )}
            {s.ad_login_enabled && <DomainLogin />}
            {s.oidc_login_enabled && (
              <a
                className="auth-oidc-link"
                href="/auth/login"
                onClick={() => {
                  if (
                    location.pathname === "/proxy-4.14" ||
                    route() === "sftpgo"
                  ) {
                    try {
                      sessionStorage.setItem(
                        "pl-ui-login-return",
                        location.pathname,
                      );
                    } catch {
                      /* storage optional */
                    }
                  }
                  markLoginSuccessCandidate();
                }}
              >
                {ru.voyti_cherez_keycloak}
                <ArrowRight size={16} />
              </a>
            )}
            {s.local_login_enabled && (
              <LocalLogin
                primary={!s.ad_login_enabled && !s.oidc_login_enabled}
              />
            )}
            {s.demo && (
              <div className="demo-login">
                <p>{ru.izolirovannyy_demonstratsionnyy_rezhim}</p>
                <Button onClick={() => void demo("admin")}>
                  {ru.voyti_kak_it_spetsialist}
                </Button>
                <Button onClick={() => void demo("viewer")}>
                  {ru.otkryt_ogranichennyy_board}
                </Button>
              </div>
            )}
            {!!error && <ErrorBox error={error} />}
          </div>
        </AuthScene>
        {s.board_anonymous_enabled && (
          <BoardView anonymous onSelect={chooseBoardService} />
        )}
      </>
    );
  return (
    <HelpProvider key={s.user?.id || "viewer"} userID={s.user?.id || "viewer"}>
      {route() === "sftpgo" ? (
        <Suspense
          fallback={<div role="status">Загрузка файлового сервера…</div>}
        >
          <SFTPGoPage admin={s.user?.admin === true} />
        </Suspense>
      ) : s.user?.admin ? (
        <Admin session={s} />
      ) : (
        <EmployeePortal key={s.user?.id} session={s} />
      )}
    </HelpProvider>
  );
}
function BoardView({
  anonymous = false,
  onSelect,
}: {
  anonymous?: boolean;
  onSelect?: (id: string) => void;
}) {
  useHelpTopic(anonymous ? undefined : "viewer-board");
  const board = useAPI<Board>("/board");
  const [error, setError] = useState<unknown>();
  const missing = !anonymous && isMissingLocation();
  async function logout() {
    try {
      await api("/auth/logout", "POST", {});
      location.reload();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="board-shell">
      <header>
        <Brand />
        {!anonymous && <HelpButton topic="viewer-board" />}
        {!anonymous && <ThemeToggle />}
        {!anonymous && (
          <Button onClick={() => void logout()}>
            <LogOut size={16} />
            {ru.vyyti}
          </Button>
        )}
      </header>
      {missing ? (
        <div className="shell-error-scene">
          <ErrorSceneContent
            kind={location.pathname === "/403" ? "403" : "404"}
            embedded
          />
          <SceneArt kind="404" />
        </div>
      ) : (
        <>
          <div className="page-title">
            <div>
              <h1>{board.data?.title || ru.informatsionnyy_board}</h1>
              <p>{ru.opublikovannaya_informatsiya_o_servisah}</p>
            </div>
            <Shield size={26} />
          </div>
          {!!error && <ErrorBox error={error} />}{" "}
          {board.error ? (
            <ErrorBox error={board.error} />
          ) : board.data?.items?.length ? (
            <div className="board-grid">
              {board.data.items.map((item) => {
                const href = anonymous ? undefined : employeeURL(item.url);
                const content = (
                  <>
                    <span className="panel-heading">
                      <span className="board-service-title">{item.name}</span>
                      <Badge value={item.status} />
                    </span>
                    {item.description && (
                      <span className="board-service-description">
                        {item.description}
                      </span>
                    )}
                    <span className="board-service-action">
                      {anonymous
                        ? "Войти и открыть"
                        : href
                          ? "Открыть сервис"
                          : "Ссылка пока недоступна"}
                    </span>
                  </>
                );
                return anonymous ? (
                  <button
                    key={item.id}
                    type="button"
                    className="panel board-service-card"
                    disabled={!isBoardServiceID(item.id)}
                    aria-label={`Войти и открыть ${item.name}`}
                    onClick={() => onSelect?.(item.id)}
                  >
                    {content}
                  </button>
                ) : href ? (
                  <a
                    key={item.id}
                    className="panel board-service-card"
                    href={href}
                  >
                    {content}
                  </a>
                ) : (
                  <section key={item.id} className="panel board-service-card">
                    {content}
                  </section>
                );
              })}
            </div>
          ) : (
            <Empty title={ru.poka_net_opublikovannyh_resursov} />
          )}
        </>
      )}
    </div>
  );
}
function Admin({ session }: { session: Session }) {
  const helpOpen = useHelpOpen();
  const [page, setPage] = useState(route);
  const [resourcePermalink, setResourcePermalink] = useState(() =>
    catalogResourceId(location.hash),
  );
  const missingPage = isMissingLocation(page);
  useHelpTopic(page in helpTopics ? (page as HelpTopic) : undefined);
  const [palette, setPalette] = useState(false);
  const [editor, setEditor] = useState<Resource | "new">();
  const [detail, setDetail] = useState<Resource>();
  const [operation, setOperation] = useState<{
    kind: string;
    resource?: Resource;
  }>();
  const [personal, setPersonal] = useState(false);
  const [error, setError] = useState<unknown>();
  const [connection, setConnection] = useState("connecting");
  const localModules = useAPI<{ items: LocalProxyInstance[] }>("/modules");
  const proxyInstalled =
    installedLocalXrays(localModules.data?.items).length > 0;
  const monitoringInstalled =
    installedLocalModules(localModules.data?.items, "prometheus").length > 0;
  const notificationsInstalled =
    installedLocalModules(localModules.data?.items, "alertmanager").length > 0;
  const filesInstalled =
    installedLocalModules(localModules.data?.items, "sftpgo").length > 0;
  const mailConnected =
    externalModules(localModules.data?.items, "mailcow").length > 0;
  const netMapInstances = netMapModules(localModules.data?.items);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const logoutPending = useRef(false);
  const prefs = useAPI<Preferences>("/preferences");
  const resources = useAPI<Resource[]>("/resources");
  const candidates = useAPI<Candidate[]>("/candidates");
  const pending = candidates.data?.filter((c) => c.state === "pending") || [];
  function navigate(next: string) {
    withSettingsNavigation(() => {
      if (next === "tools") {
        openWorkspaceCheck();
        return;
      }
      if (next === "problems") {
        openWorkspaceProblems();
        return;
      }
      if (next === "reports") {
        location.assign("/reports/");
        return;
      }
      if (location.pathname === "/proxy-4.14") {
        location.assign("/#" + next);
        return;
      }
      location.hash = next;
      setPage(next.split("?")[0]);
    });
  }
  function navigateLink(
    event: React.MouseEvent<HTMLAnchorElement>,
    next: string,
  ) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(next);
  }
  useEffect(() => {
    const handler = () => {
      setPage(route());
      setResourcePermalink(catalogResourceId(location.hash));
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    if (!resourcePermalink) return;
    const controller = new AbortController();
    setDetail(undefined);
    void api<Resource>(
      `/resources/${resourcePermalink}`,
      "GET",
      undefined,
      {},
      controller.signal,
    )
      .then((resource) => {
        if (!controller.signal.aborted && resource.lifecycle === "active")
          setDetail(resource);
        else if (!controller.signal.aborted)
          setError(new Error("Ресурс недоступен"));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [resourcePermalink]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!helpOpen) setPalette((v) => !v);
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [helpOpen]);
  useEffect(() => {
    const stream = new EventSource("/api/v1/stream", { withCredentials: true });
    stream.onopen = () => {
      setConnection("connected");
      void refresh();
    };
    stream.onerror = () => setConnection("reconnecting");
    stream.addEventListener("change", () => void refresh());
    stream.addEventListener("session_expired", () => {
      stream.close();
      void queryClient.invalidateQueries({ queryKey: ["/session"] });
    });
    return () => stream.close();
  }, []);
  async function preferences(value: Preferences) {
    try {
      const updated = await api<Preferences>("/preferences", "PUT", value);
      queryClient.setQueryData(["/preferences"], updated);
    } catch (e) {
      setError(e);
      void prefs.refetch();
      throw e;
    }
  }
  function logout() {
    withSettingsNavigation(() => {
      if (logoutPending.current) return;
      logoutPending.current = true;
      setLogoutBusy(true);
      void (async () => {
        try {
          await api("/auth/logout", "POST", {});
          queryClient.clear();
          location.reload();
        } catch (e) {
          setError(e);
        } finally {
          logoutPending.current = false;
          setLogoutBusy(false);
        }
      })();
    });
  }
  const actions: ResourceActions = {
    onEdit: (r) => {
      setDetail(undefined);
      if (r?.managed_module_id) {
        navigate(`modules?instance=${r.managed_module_id}`);
        return;
      }
      setEditor(r || "new");
    },
    onDetails: setDetail,
    onOperation: (kind, resource) => {
      setDetail(undefined);
      if (kind === "check") {
        openWorkspaceCheck(resource);
        return;
      }
      setOperation({ kind, resource });
    },
    preferences: prefs.data,
    onPreferences: (v) => void preferences(v).catch(() => {}),
  };
  return (
    <>
      <PlatformShell
        branding={{ name: "PL", subtitle: "PLATFORM", label: "Platform" }}
        context={
          missingPage
            ? location.pathname === "/403"
              ? "Нет доступа"
              : "Страница не найдена"
            : nav.find(([id]) => id === page)?.[1] || copy.candidates
        }
        user={{
          name: session.user?.name || session.user?.id,
          subtitle: "Пользователь Платформы",
        }}
        initialCollapsed={prefs.data?.sidebar_collapsed}
        onCollapsedChange={(collapsed) => {
          if (prefs.data)
            void preferences({
              ...prefs.data,
              sidebar_collapsed: collapsed,
            }).catch(() => {});
        }}
        onPlatformNavigate={(event) => {
          event.preventDefault();
          withSettingsNavigation(() => location.assign("/"));
        }}
        onLogout={logout}
        logoutDisabled={logoutBusy}
        navigation={
          <>
            {nav
              .filter(
                ([id]) =>
                  !["settings", "problems", "tools", "reports"].includes(id) &&
                  (id !== "proxy" || proxyInstalled) &&
                  (id !== "monitoring" || monitoringInstalled) &&
                  (id !== "notifications" || notificationsInstalled) &&
                  (id !== "mail" || mailConnected) &&
                  (id !== "netmap" || netMapInstances.length > 0) &&
                  (id !== "files" || filesInstalled),
              )
              .map(([id, label]) => {
                const Icon = icons[id];
                return (
                  <a
                    key={id}
                    href={`/#${id}`}
                    title={label}
                    className={!missingPage && page === id ? "active" : ""}
                    aria-current={
                      !missingPage && page === id ? "page" : undefined
                    }
                    onClick={(event) => navigateLink(event, id)}
                  >
                    <Icon size={21} />
                    <span>{label}</span>
                  </a>
                );
              })}
            <div className="nav-divider" />
            <a
              href="/#candidates"
              title={ru.obnaruzhenie}
              className={!missingPage && page === "candidates" ? "active" : ""}
              aria-current={
                !missingPage && page === "candidates" ? "page" : undefined
              }
              onClick={(event) => navigateLink(event, "candidates")}
            >
              <Sparkles size={21} />
              <span>{ru.obnaruzhenie}</span>
              {pending.length > 0 && (
                <b className="nav-count subtle">{pending.length}</b>
              )}
            </a>
          </>
        }
        sidebarFooter={
          <>
            <HelpButton sidebar />
            <a
              href="/#settings"
              title={ru.nastroyki}
              className={!missingPage && page === "settings" ? "active" : ""}
              aria-current={
                !missingPage && page === "settings" ? "page" : undefined
              }
              onClick={(event) => navigateLink(event, "settings")}
            >
              <SettingsIcon size={21} />
              <span>{ru.nastroyki}</span>
            </a>
            <div className="sidebar-footer">
              <strong>PL</strong>
              <span>{ru.it_portal}</span>
            </div>
          </>
        }
        actions={
          <>
            <UpdateNotification
              enabled={!!session.user?.admin && !session.demo}
            />{" "}
            <Button
              className="topbar-search"
              variant="ghost"
              aria-label="Поиск по платформе"
              aria-keyshortcuts="Control+K Meta+K"
              title="Поиск по платформе · Ctrl / ⌘ K"
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setPalette(true);
              }}
            >
              <Search size={17} />
              <span>Поиск</span>
              <kbd aria-hidden="true">Ctrl / ⌘ K</kbd>
            </Button>
            <WorkspaceProblemIndicator actions={actions} />
            <WorkspaceCheckButton />
            <Button
              variant="ghost"
              size="icon"
              aria-label={ru.sobytiya}
              onClick={() => navigate("events")}
            >
              <Bell size={20} />
            </Button>
          </>
        }
        banner={
          session.demo ? (
            <div className="demo-banner">{copy.demo}</div>
          ) : undefined
        }
        footer={
          <>
            <span>
              {resources.data?.length ?? "—"}
              {" " + ru.resursov_v_obschem_kataloge}
            </span>
            <span>
              <span
                className={`status-dot ${connection !== "connected" ? "unknown" : ""}`}
              />
              {connection === "connected"
                ? ru.obnovleniya_podklyucheny
                : ru.periodicheskoe_obnovlenie}{" "}
              · {session.timezone}
            </span>
          </>
        }
      >
        <ReleaseBanner enabled={!!session.user?.admin && !session.demo} />
        <LocalAdminPassword session={session} prompt />
        {!!error && (
          <ErrorBox
            error={error}
            retry={() => {
              setError(undefined);
              void refresh();
            }}
          />
        )}
        {!missingPage && connection === "reconnecting" && (
          <div className="notice compact">
            <Radio size={15} />
            {ru.svyaz_s_obnovleniyami_poteryana_sohraneny_poslednie_dannye_pov}
          </div>
        )}
        {missingPage ? (
          <div className="shell-error-scene">
            <ErrorSceneContent
              kind={location.pathname === "/403" ? "403" : "404"}
              embedded
            />
            <SceneArt kind="404" />
          </div>
        ) : page === "home" ? (
          <Home
            session={session}
            actions={actions}
            onPalette={() => setPalette(true)}
            navigate={navigate}
            onPersonal={() => setPersonal(true)}
          />
        ) : page === "catalog" ? (
          <Catalog {...actions} />
        ) : page === "module-catalog" || page === "modules" ? (
          <Modules
            key={page}
            view={page === "module-catalog" ? "catalog" : "installed"}
          />
        ) : page === "problems" ? (
          <WorkspaceLegacyRoute kind="problems" />
        ) : page === "tools" ? (
          <WorkspaceLegacyRoute kind="tools" />
        ) : page === "reports" ? (
          <WorkspaceLegacyRoute kind="reports" />
        ) : page === "monitoring" ? (
          <Suspense fallback={<p role="status">Загрузка мониторинга…</p>}>
            <Monitoring />
          </Suspense>
        ) : page === "notifications" ? (
          <Suspense fallback={<p role="status">Загрузка уведомлений…</p>}>
            <Notifications />
          </Suspense>
        ) : page === "mail" ? (
          <Suspense fallback={<p role="status">Загрузка почты…</p>}>
            <Mail />
          </Suspense>
        ) : page === "netmap" ? (
          <NavNetMap
            instances={netMapInstances}
            loading={localModules.isPending}
            error={localModules.error}
            retry={() => void localModules.refetch()}
          />
        ) : page === "files" ? (
          <Suspense fallback={<p role="status">Загрузка файлового сервера…</p>}>
            <FilesModule />
          </Suspense>
        ) : page === "proxy" ? (
          <LocalProxy />
        ) : page === "events" ? (
          <Events
            onResource={(id) => {
              const resource = resources.data?.find((item) => item.id === id);
              if (resource) setDetail(resource);
            }}
          />
        ) : page === "candidates" ? (
          <Candidates />
        ) : (
          <Settings />
        )}
      </PlatformShell>
      {editor && (
        <ResourceEditor
          resource={editor === "new" ? undefined : editor}
          onClose={() => setEditor(undefined)}
        />
      )}{" "}
      {detail && (
        <ResourceDetails
          resource={resources.data?.find((r) => r.id === detail.id) || detail}
          onClose={() => {
            setDetail(undefined);
            if (resourcePermalink) {
              setResourcePermalink(undefined);
              location.hash = "catalog";
            }
          }}
          onEdit={actions.onEdit}
          onOperation={actions.onOperation}
          preferences={actions.preferences}
          onPreferences={preferences}
          onDetails={actions.onDetails}
        />
      )}{" "}
      {operation && (
        <OperationDialog
          kind={operation.kind}
          resource={
            operation.resource?.id
              ? operation.resource
              : operation.resource?.check
                ? operation.resource
                : undefined
          }
          onClose={() => setOperation(undefined)}
        />
      )}{" "}
      {palette && (
        <Palette
          resources={resources.data || []}
          onClose={() => setPalette(false)}
          navigate={navigate}
          onAdd={() => setEditor("new")}
          onOperation={actions.onOperation}
          onDetails={setDetail}
        />
      )}{" "}
      <WorkspaceCheckManager />
      {personal && prefs.data && (
        <Personalization
          preferences={prefs.data}
          resources={resources.data || []}
          onSave={preferences}
          onClose={() => setPersonal(false)}
        />
      )}
    </>
  );
}

function Palette({
  onClose,
  navigate,
  onAdd,
  onOperation,
  onDetails,
  resources,
}: {
  onClose: () => void;
  navigate: (page: string) => void;
  onAdd: () => void;
  onOperation: (kind: string, r?: Resource) => void;
  onDetails: (r: Resource) => void;
  resources: Resource[];
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const deferred = useDebounce(query, 140);
  const search = useAPI<Resource[]>(
    `/search?q=${encodeURIComponent(deferred)}`,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const commands = [
    { name: ru.dobavit_resurs, run: onAdd },
    { name: ru.otkryt_katalog, run: () => navigate("catalog") },
    { name: ru.aktualnye_problemy, run: () => navigate("problems") },
    {
      name: ru.zapustit_proverku_dns_tcp_http_tls,
      run: () => onOperation("check"),
    },
    { name: ru.sformirovat_otchyot, run: () => onOperation("report") },
    {
      name: ru.perezapusk_konteynera_vybrat_tsel,
      run: () => navigate("catalog?kind=infrastructure"),
    },
    { name: ru.nastroyki_integratsiy, run: () => navigate("settings") },
  ].filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()));
  const found = search.data || (!query ? resources : []);
  const items = [
    ...found.slice(0, 15).map((r) => ({
      id: r.id,
      name: r.name,
      detail: r.hostname || r.ip || r.url,
      resource: r,
      run: () => {
        const url = safeURL(r.url);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else onDetails(r);
      },
    })),
    ...commands.map((c, i) => ({
      id: `command-${i}`,
      name: c.name,
      detail: ru.komanda_portala,
      resource: undefined,
      run: c.run,
    })),
  ];
  useEffect(() => setSelected(0), [deferred]);
  function run(index: number) {
    const item = items[index];
    if (item) {
      onClose();
      item.run();
    }
  }
  return (
    <Dialog
      helpTopic="command-palette"
      title={ru.poisk_i_komandy}
      onClose={onClose}
    >
      <div className="palette-search">
        <Search size={20} />
        <input
          autoFocus
          value={query}
          placeholder={copy.search}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={
            items[selected] ? `palette-${items[selected].id}` : undefined
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.max(
                0,
                Math.min(
                  items.length - 1,
                  selected + (e.key === "ArrowDown" ? 1 : -1),
                ),
              );
              setSelected(next);
              document
                .getElementById(`palette-${items[next]?.id}`)
                ?.scrollIntoView({ block: "nearest" });
            }
            if (e.key === "Enter") {
              e.preventDefault();
              run(selected);
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      {search.error && <ErrorBox error={search.error} />}
      <div
        className="palette-results"
        id="palette-results"
        role="listbox"
        ref={listRef}
      >
        {items.map((item, i) => (
          <div
            role="option"
            aria-selected={i === selected}
            id={`palette-${item.id}`}
            key={item.id}
            className={`palette-option ${i === selected ? "selected" : ""}`}
            onMouseEnter={() => setSelected(i)}
          >
            <button onClick={() => run(i)}>
              {item.resource ? (
                <ResourceIcon
                  type={item.resource.type}
                  name={item.name}
                  url={item.resource.url}
                  manualIcon={item.resource.icon}
                />
              ) : (
                <Command size={20} />
              )}
              <span>
                <strong>{item.name}</strong>
                <small>{item.detail}</small>
              </span>
              <ArrowRight size={15} />
            </button>
            {item.resource && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onClose();
                  onDetails(item.resource!);
                }}
              >
                {ru.detali}
              </Button>
            )}
          </div>
        ))}
      </div>
      {!items.length && <Empty title={ru.nichego_ne_naydeno} />}
      <div className="palette-footer">
        <span>{ru.vybor}</span>
        <span>{ru.otkryt}</span>
        <span>{ru.esc_zakryt}</span>
      </div>
    </Dialog>
  );
}
function useDebounce<T>(value: T, delay: number) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setResult(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return result;
}
function Personalization({
  preferences,
  resources,
  onSave,
  onClose,
}: {
  preferences: Preferences;
  resources: Resource[];
  onSave: (p: Preferences) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(preferences);
  const [saveError, setSaveError] = useState<unknown>();
  const visibleFavorites = draft.favorites.filter((id) =>
    resources.some(
      (resource) => resource.id === id && isServiceCardResource(resource),
    ),
  );
  function reorder(id: string, delta: number) {
    const ids = [...draft.favorites];
    const index = ids.indexOf(id);
    const target = ids.indexOf(
      visibleFavorites[visibleFavorites.indexOf(id) + delta],
    );
    if (index < 0 || target < 0) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setDraft({ ...draft, favorites: ids });
  }
  return (
    <Dialog
      helpTopic="preferences"
      title="Избранное и Wayline"
      description={
        ru.eti_nastroyki_sohranyayutsya_tolko_dlya_vashey_uchyotnoy_zapis
      }
      onClose={onClose}
    >
      <h3>{ru.poryadok_zakrepleniy}</h3>
      {visibleFavorites.length ? (
        visibleFavorites.map((id, i) => (
          <div className="simple-row" key={id}>
            <strong>
              {resources.find((r) => r.id === id)?.name || ru.resurs_nedostupen}
            </strong>
            <div className="actions">
              <Button
                size="icon"
                disabled={i === 0}
                aria-label={ru.vyshe}
                onClick={() => reorder(id, -1)}
              >
                <ArrowUp size={15} />
              </Button>
              <Button
                size="icon"
                disabled={i === visibleFavorites.length - 1}
                aria-label={ru.nizhe}
                onClick={() => reorder(id, 1)}
              >
                <ArrowDown size={15} />
              </Button>
              <Button
                size="icon"
                aria-label={ru.otkrepit}
                onClick={() =>
                  setDraft({
                    ...draft,
                    favorites: draft.favorites.filter((v) => v !== id),
                  })
                }
              >
                <X size={15} />
              </Button>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">
          {ru.resursy_zakreplyayutsya_v_kataloge_knopkoy_so_zvezdoy}
        </p>
      )}
      <WaylineSelection value={draft} onChange={setDraft} />
      <>{!!saveError && <ErrorBox error={saveError} />}</>
      <div className="dialog-footer">
        <Button
          variant="default"
          onClick={() => void onSave(draft).then(onClose).catch(setSaveError)}
        >
          {ru.sohranit}
        </Button>
      </div>
    </Dialog>
  );
}
function LocalLogin({ primary = false }: { primary?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      await api("/auth/local", "POST", { username, password });
      markLoginSuccessCandidate();
      setPassword("");
      queryClient.clear();
      location.reload();
    } catch (e) {
      setError(e);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <details className="local-login" open={primary || undefined}>
      <summary>Локальный вход</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void login();
        }}
      >
        <Field label={ru.login}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label={ru.parol}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {!!error && <ErrorBox error={error} />}
        <Button variant="default" type="submit" disabled={busy}>
          {busy ? ru.vhodim : ru.voyti_lokalno}
        </Button>
      </form>
    </details>
  );
}

function DomainLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      await api("/auth/ad", "POST", { username, password });
      markLoginSuccessCandidate();
      queryClient.clear();
      location.reload();
    } catch (e) {
      setError(e);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <form
      className="domain-login"
      onSubmit={(event) => {
        event.preventDefault();
        void login();
      }}
    >
      <Field label="Логин">
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={busy}
          placeholder="Введите логин"
        />
      </Field>
      <div className="field">
        <label htmlFor="domain-password">Пароль</label>
        <span className="password-control">
          <input
            id="domain-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
          <button
            type="button"
            aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
            onClick={() => setShowPassword(!showPassword)}
            disabled={busy}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </span>
      </div>
      {!!error && <ErrorBox error={error} />}
      <Button variant="default" type="submit" disabled={busy}>
        {busy ? ru.vhodim : "Войти"}
      </Button>
    </form>
  );
}
