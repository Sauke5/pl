import { withSettingsNavigation } from "./settings/navigation";
import { LocalAdminPassword } from "./LocalAdminPassword";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Headphones, Search, Star } from "lucide-react";
import { ErrorSceneContent, SceneArt } from "./AuthScenes";
import { PlatformShell } from "@pl/ui/react";
import { api, queryClient, useAPI } from "./api";
import { Button } from "./components/ui/button";
import { Empty, ErrorBox } from "./components/common";
import type { Board, BoardItem, Session } from "./types";
import { employeeURL, readEmployeeFavorites } from "./employeeServices";
import { SystemIcon } from "./components/SystemIcon";
import { DashboardLayout } from "./DashboardLayout";
import "./employee-portal.css";

export default function EmployeePortal({ session }: { session: Session }) {
  const board = useAPI<Board>("/board");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<unknown>();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const logoutPending = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const user = session.user!;
  const favoriteKey = `pl-ui-employee-favorites:${encodeURIComponent(user.id)}`;
  const [favorites, setFavorites] = useState<string[]>(() =>
    readEmployeeFavorites(favoriteKey),
  );
  const items = board.error ? [] : board.data?.items || [];
  useEffect(() => {
    if (!board.data?.items) return;
    setFavorites((previous) =>
      previous.filter((id) => board.data!.items.some((item) => item.id === id)),
    );
  }, [board.data]);
  useEffect(() => {
    try {
      localStorage.setItem(favoriteKey, JSON.stringify(favorites));
    } catch {
      /* Storage is optional. */
    }
  }, [favoriteKey, favorites]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  const categories = [
    ...new Set(
      items
        .map((item) => item.category)
        .filter((value): value is string => !!value),
    ),
  ];
  const activeCategory = categories.includes(category) ? category : "";
  const q = query.trim().toLocaleLowerCase("ru");
  const filtered = items.filter(
    (item) =>
      (!activeCategory || item.category === activeCategory) &&
      (!q ||
        `${item.name} ${item.description} ${item.category || ""}`
          .toLocaleLowerCase("ru")
          .includes(q)),
  );
  const support = items.find((item) => item.support && employeeURL(item.url));
  const missing =
    location.pathname !== "/" && location.pathname !== "/index.html";
  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLogoutBusy(true);
    setError(undefined);
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
  }
  function toggle(id: string) {
    setFavorites((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }
  function card(item: BoardItem) {
    const url = employeeURL(item.url);
    return (
      <article
        className={`employee-card ${url ? "" : "is-disabled"}`}
        key={item.id}
      >
        {url ? (
          <a
            className="employee-card-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="employee-service-icon">
              <SystemIcon
                name={item.name}
                url={url}
                icon={item.icon || "app"}
                manualIcon={item.resource_icon}
                size={30}
              />
            </span>
            <span className="employee-card-copy">
              <h3>{item.name}</h3>
              <p>
                {item.description || "Откройте сервис, чтобы начать работу."}
              </p>
              {item.status !== "unknown" && (
                <small>
                  {item.status === "problem"
                    ? "Есть сообщение о проблеме"
                    : item.status === "stale"
                      ? "Данные о состоянии устарели"
                      : "Состояние неизвестно"}
                </small>
              )}
            </span>
            <ArrowUpRight className="employee-open-arrow" size={24} />
          </a>
        ) : (
          <div className="employee-card-link" aria-disabled="true">
            <span className="employee-service-icon">
              <SystemIcon
                name={item.name}
                url={url}
                icon={item.icon || "app"}
                manualIcon={item.resource_icon}
                size={30}
              />
            </span>
            <span className="employee-card-copy">
              <h3>{item.name}</h3>
              <p>
                {item.description ||
                  "Администратор ещё не настроил ссылку на сервис."}
              </p>
              <small>Переход недоступен</small>
            </span>
          </div>
        )}
        <button
          type="button"
          className={`employee-favorite ${favorites.includes(item.id) ? "is-selected" : ""}`}
          aria-label={`${favorites.includes(item.id) ? "Убрать из избранного" : "Добавить в избранное"}: ${item.name}`}
          aria-pressed={favorites.includes(item.id)}
          onClick={() => toggle(item.id)}
        >
          <Star size={22} />
        </button>
      </article>
    );
  }
  return (
    <PlatformShell
      branding={{ name: "PL", subtitle: "PLATFORM", label: "Platform" }}
      sidebar={false}
      shellClassName="employee-shell"
      mainClassName="employee-main"
      context="Сервисы сотрудника"
      user={{ name: user.name || user.id, subtitle: "Пользователь Платформы" }}
      onPlatformNavigate={(event) => {
        event.preventDefault();
        withSettingsNavigation(() => location.assign("/"));
      }}
      onLogout={() => {
        if (!logoutBusy) withSettingsNavigation(() => void logout());
      }}
      actions={<LocalAdminPassword session={session} compact />}
      logoutDisabled={logoutBusy}
    >
      {!!error && <ErrorBox error={error} />}{" "}
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
          <section className="employee-hero">
            <div className="employee-start">
              <div className="employee-eyebrow">
                Platform · сервисы сотрудника
              </div>
              <h1>Куда перейдём?</h1>
              <label className="employee-search">
                <Search size={24} />
                <span className="sr-only">Найти сервис</span>
                <input
                  ref={search}
                  aria-label="Найти сервис"
                  type="search"
                  value={query}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!q && !activeCategory && value.trim()) {
                      withSettingsNavigation(() => setQuery(value));
                    } else {
                      setQuery(value);
                    }
                  }}
                  placeholder="Название сервиса или задача"
                />
                <kbd>Ctrl / ⌘ K</kbd>
              </label>
              <nav
                className="employee-categories"
                aria-label="Категории сервисов"
              >
                {["", ...categories].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={activeCategory === value ? "active" : ""}
                    aria-pressed={activeCategory === value}
                    onClick={() => {
                      if (!q && !activeCategory && value) {
                        withSettingsNavigation(() => setCategory(value));
                      } else {
                        setCategory(value);
                      }
                    }}
                  >
                    {value || "Все"}
                  </button>
                ))}
              </nav>
            </div>
            <aside className="employee-support">
              <span className="employee-service-icon">
                <Headphones size={34} />
              </span>
              <h2>Нужна помощь?</h2>
              {support ? (
                <>
                  <p>
                    {support.description ||
                      `Техническая поддержка доступна в ${support.name}.`}
                  </p>
                  <a
                    className="button button-primary employee-support-link"
                    href={employeeURL(support.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {support.name} <ArrowUpRight size={18} />
                  </a>
                  <small>Переход на главную сервиса</small>
                </>
              ) : (
                <p>
                  {board.isPending
                    ? "Загружаем доступные сервисы…"
                    : board.error
                      ? "Список сервисов сейчас недоступен."
                      : "Сервис поддержки пока не опубликован. Обратитесь к вашему IT-специалисту."}
                </p>
              )}
            </aside>
          </section>
          <section
            className="employee-services"
            aria-labelledby="employee-services-title"
          >
            <div className="employee-section-heading">
              <h2 id="employee-services-title">Все доступные сервисы</h2>
              {board.data && (
                <span>
                  {filtered.length} из {items.length}
                </span>
              )}
            </div>
            {board.isPending ? (
              <div
                className="employee-grid"
                aria-busy="true"
                aria-label="Загрузка сервисов"
              >
                {[0, 1, 2, 3].map((id) => (
                  <div className="employee-skeleton" key={id}>
                    <span />
                    <span />
                  </div>
                ))}
              </div>
            ) : board.error ? (
              <ErrorBox
                error={board.error}
                retry={() => void board.refetch()}
              />
            ) : !items.length ? (
              <Empty
                title="Сервисы пока не опубликованы"
                detail="Администратор добавит сюда доступные вам сервисы."
              />
            ) : !filtered.length ? (
              <Empty
                title="Ничего не найдено"
                detail="Попробуйте другое название или категорию."
                action={
                  <Button
                    onClick={() => {
                      setQuery("");
                      setCategory("");
                    }}
                  >
                    Сбросить поиск
                  </Button>
                }
              />
            ) : q || activeCategory ? (
              <div className="employee-grid">{filtered.map(card)}</div>
            ) : (
              <DashboardLayout
                view="employee"
                items={items.map((item) => ({
                  id: item.id,
                  label: item.name,
                  content: card(item),
                  width: 4,
                  height: 0,
                  hideable: true,
                }))}
              />
            )}
          </section>
          <footer className="employee-footer">
            Сервисы опубликованы администратором Платформы. Избранное
            сохраняется в этом браузере.
            {board.data && items.some((item) => item.status === "unknown") && (
              <span>Для части сервисов состояние неизвестно.</span>
            )}
          </footer>
        </>
      )}
    </PlatformShell>
  );
}
