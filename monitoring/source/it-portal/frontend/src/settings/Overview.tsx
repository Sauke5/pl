import {
  ArrowRight,
  LayoutDashboard,
  PlugZap,
  RefreshCw,
  Server,
  Shield,
  Users,
} from "lucide-react";
import { date, useAPI } from "../api";
import type { Integration, Session, Settings } from "../types";
import type { ManagedNavigationInstance } from "../managedModuleNavigation";
import { useDelivery } from "../UpdateSettings";
import { Badge, Empty, ErrorBox, Panel } from "../components/common";
import { Button } from "../components/ui/button";
import { kindLabels, type SettingsLocation } from "./model";

const configured = (value?: boolean) =>
  value === true ? "Настроен" : value === false ? "Не настроен" : "Нет данных";

export function SettingsOverview({
  integrations,
  integrationsError,
  session,
  onNavigate,
}: {
  integrations?: Integration[];
  integrationsError?: unknown;
  session?: Session;
  onNavigate: (place: SettingsLocation) => void;
}) {
  const settings = useAPI<Settings>("/settings");
  const modules = useAPI<{ items: ManagedNavigationInstance[] }>("/modules");
  const delivery = useDelivery(session?.user?.admin === true);
  const installed = Array.isArray(modules.data?.items)
    ? modules.data.items
    : undefined;
  const connectionIssues =
    integrations?.filter((item) => item.enabled && !!item.error) || [];
  const moduleIssues = installed?.filter((item) => !!item.error) || [];
  const activeSources = integrations?.filter((item) => item.enabled);
  return (
    <section className="settings-overview" aria-label="Обзор настроек">
      <header className="settings-section-heading">
        <LayoutDashboard size={22} />
        <div>
          <h2>Обзор</h2>
          <p>Подключения, доступ пользователей и обслуживание PL</p>
        </div>
      </header>
      {(connectionIssues.length > 0 || moduleIssues.length > 0) && (
        <Panel title="Требуют внимания" className="settings-overview-attention">
          <div className="settings-attention-list">
            {connectionIssues.slice(0, 4).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  onNavigate({ section: "integrations", integration: item.id })
                }
              >
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {kindLabels[item.kind] || item.kind} · {item.error}
                  </small>
                </div>
                <ArrowRight size={16} />
              </button>
            ))}
            {moduleIssues.slice(0, 4).map((item) => (
              <a
                key={item.id}
                href={`#modules?instance=${encodeURIComponent(item.id)}`}
              >
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.error}</small>
                </div>
                <ArrowRight size={16} />
              </a>
            ))}
          </div>
          {(connectionIssues.length > 4 || moduleIssues.length > 4) && (
            <p className="muted">
              Остальные ошибки — в подключениях и установленных модулях.
            </p>
          )}
        </Panel>
      )}
      <div className="settings-overview-grid">
        <Panel
          title="Версия и обновления"
          icon={<RefreshCw size={20} />}
          action={
            <Button
              size="sm"
              onClick={() => onNavigate({ section: "updates" })}
            >
              Открыть обновления <ArrowRight size={15} />
            </Button>
          }
        >
          {delivery.error ? (
            <ErrorBox
              error={delivery.error}
              retry={() => void delivery.refetch()}
            />
          ) : !delivery.data ? (
            <p role="status">Получаем версию PL…</p>
          ) : (
            <>
              <p className="settings-overview-version">
                {delivery.data.current_version
                  ? `PL ${delivery.data.current_version}`
                  : "Версия не получена"}
              </p>
              {delivery.data.error ? (
                <p className="settings-inline-error">{delivery.data.error}</p>
              ) : delivery.data.update_available ? (
                <Badge value="warning">
                  Доступна {delivery.data.latest_version}
                </Badge>
              ) : delivery.data.checked_at ? (
                <p>Установлена последняя доступная версия</p>
              ) : (
                <p className="muted">Проверка обновлений ещё не выполнялась</p>
              )}
              {delivery.data.checked_at && (
                <p className="muted">
                  Последняя проверка: {date(delivery.data.checked_at)}
                </p>
              )}
            </>
          )}
        </Panel>
        <Panel
          title="Вход и пользователи"
          icon={<Users size={20} />}
          action={
            <Button
              size="sm"
              onClick={() =>
                onNavigate({
                  section:
                    session?.local_users_enabled ||
                    session?.local_password_change_enabled
                      ? "users"
                      : "ad",
                })
              }
            >
              Настроить доступ <ArrowRight size={15} />
            </Button>
          }
        >
          <dl className="settings-facts">
            <div>
              <dt>Вход через домен</dt>
              <dd>{configured(session?.ad_login_enabled)}</dd>
            </div>
            <div>
              <dt>Локальный вход</dt>
              <dd>{configured(session?.local_login_enabled)}</dd>
            </div>
            {session?.oidc_login_enabled && (
              <div>
                <dt>Вход через провайдера OIDC</dt>
                <dd>Настроен</dd>
              </div>
            )}
            <div>
              <dt>Минимальная длина пароля</dt>
              <dd>
                {settings.data?.local_password_min_length
                  ? `${settings.data.local_password_min_length} символов`
                  : "По настройкам сервера"}
              </dd>
            </div>
            <div>
              <dt>Повторный вход</dt>
              <dd>
                {settings.data?.session_lifetime_minutes
                  ? `Через ${settings.data.session_lifetime_minutes} мин`
                  : "По настройкам сервера"}
              </dd>
            </div>
          </dl>
          {!!settings.error && <ErrorBox error={settings.error} />}
          <Button size="sm" onClick={() => onNavigate({ section: "security" })}>
            Пароли и сессии
          </Button>
        </Panel>
        <Panel
          title="Установленные модули"
          icon={<Server size={20} />}
          action={
            <a className="button button-secondary" href="#modules">
              К модулям <ArrowRight size={15} />
            </a>
          }
        >
          {modules.error ? (
            <ErrorBox
              error={modules.error}
              retry={() => void modules.refetch()}
            />
          ) : !installed ? (
            <p role="status">Получаем список модулей…</p>
          ) : !installed.length ? (
            <Empty
              title="Модули ещё не установлены"
              action={
                <a className="button button-secondary" href="#module-catalog">
                  Открыть каталог модулей
                </a>
              }
            />
          ) : (
            <>
              <dl className="settings-facts">
                <div>
                  <dt>Всего</dt>
                  <dd>{installed.length}</dd>
                </div>
                <div>
                  <dt>Включены</dt>
                  <dd>
                    {
                      installed.filter(
                        (item) => item.desired_state === "enabled",
                      ).length
                    }
                  </dd>
                </div>
                <div>
                  <dt>Отключены</dt>
                  <dd>
                    {
                      installed.filter(
                        (item) => item.desired_state === "disabled",
                      ).length
                    }
                  </dd>
                </div>
                <div>
                  <dt>С ошибками проверки</dt>
                  <dd>{moduleIssues.length}</dd>
                </div>
              </dl>
              <div className="settings-overview-module-list">
                {installed.slice(0, 6).map((item) => (
                  <a
                    key={item.id}
                    href={`#modules?instance=${encodeURIComponent(item.id)}`}
                  >
                    {item.name}
                  </a>
                ))}
                {installed.length > 6 && (
                  <span>Ещё {installed.length - 6}</span>
                )}
              </div>
            </>
          )}
        </Panel>
        <Panel
          title="Источники данных"
          icon={<PlugZap size={20} />}
          action={
            <Button
              size="sm"
              onClick={() => onNavigate({ section: "integrations" })}
            >
              Все подключения <ArrowRight size={15} />
            </Button>
          }
        >
          {integrationsError ? (
            <ErrorBox error={integrationsError} />
          ) : !integrations ? (
            <p role="status">Получаем список подключений…</p>
          ) : !integrations.length ? (
            <Empty
              title="Источники ещё не подключены"
              action={
                <Button
                  size="sm"
                  onClick={() =>
                    onNavigate({ section: "integrations", integration: "new" })
                  }
                >
                  Добавить подключение
                </Button>
              }
            />
          ) : (
            <dl className="settings-facts">
              <div>
                <dt>Всего</dt>
                <dd>{integrations.length}</dd>
              </div>
              <div>
                <dt>Подключены</dt>
                <dd>
                  {
                    activeSources?.filter((item) => item.status === "connected")
                      .length
                  }
                </dd>
              </div>
              <div>
                <dt>С ошибками сбора</dt>
                <dd>{connectionIssues.length}</dd>
              </div>
              <div>
                <dt>Выключены</dt>
                <dd>{integrations.filter((item) => !item.enabled).length}</dd>
              </div>
            </dl>
          )}
        </Panel>
      </div>
      <div
        className="settings-overview-shortcuts"
        aria-label="Другие настройки"
      >
        <Button onClick={() => onNavigate({ section: "installation" })}>
          Адрес и сеть <ArrowRight size={15} />
        </Button>
        <Button onClick={() => onNavigate({ section: "delivery" })}>
          Прокси для загрузок <ArrowRight size={15} />
        </Button>
        <Button onClick={() => onNavigate({ section: "publication" })}>
          <Shield size={16} /> Страница для пользователей{" "}
          <ArrowRight size={15} />
        </Button>
      </div>
    </section>
  );
}
