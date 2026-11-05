import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Info,
  LayoutGrid,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { date, safeURL, useAPI } from "./api";
import type { Integration, PortalEvent, Resource, Session } from "./types";
import type { ResourceActions } from "./Catalog";
import type { FavoriteGroup, WorkspacePreferences } from "./workspaceTypes";
import { DashboardLayout } from "./DashboardLayout";
import { ServerClock } from "./ServerClock";
import { GrafanaCharts } from "./GrafanaCharts";
import { WaylineDashboard } from "./Wayline";
import { EventRows } from "./Observations";
import { SelectedSystems, saveWorkspacePreferences } from "./Systems";
import { isServiceCardResource } from "./serviceCardEligibility";
import { resourceKind } from "./resourceKind";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  Badge,
  Empty,
  ErrorBox,
  Field,
  Panel,
  ResourceIcon,
} from "./components/common";
import "./workspace.css";

function FavoriteCards({
  resources,
  actions,
}: {
  resources: Resource[];
  actions: ResourceActions;
}) {
  return (
    <div className="workspace-favorites-grid">
      {resources.map((resource) => {
        const href = safeURL(resource.url);
        const content = (
          <>
            <ResourceIcon
              type={resource.type}
              name={resource.name}
              url={resource.url}
              manualIcon={resource.icon}
            />
            <span className="workspace-favorite-copy">
              <strong>{resource.name}</strong>
              <small>
                {resource.description || resource.hostname || resource.type}
              </small>
            </span>
          </>
        );
        return (
          <div className="workspace-favorite" key={resource.id}>
            {href ? (
              <>
                <a
                  className="workspace-favorite-link"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Открыть: ${resource.name}`}
                >
                  {content}
                </a>
                <Button
                  className="workspace-favorite-details"
                  variant="ghost"
                  size="icon"
                  aria-label={`Подробнее: ${resource.name}`}
                  onClick={() => actions.onDetails(resource)}
                >
                  <Info size={16} aria-hidden="true" />
                </Button>
              </>
            ) : (
              <button
                type="button"
                className="workspace-favorite-link workspace-favorite-fallback"
                aria-label={`Подробнее: ${resource.name}`}
                onClick={() => actions.onDetails(resource)}
              >
                {content}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FavoriteGroupEditor({
  value,
  preferences,
  resources,
  onClose,
  onSaved,
}: {
  value?: FavoriteGroup;
  preferences: WorkspacePreferences;
  resources: Resource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FavoriteGroup>(
    () =>
      value || {
        id: crypto.randomUUID(),
        name: "",
        resource_ids: [],
        collapsed: false,
      },
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [remove, setRemove] = useState(false);
  async function save(deleting = false) {
    setBusy(true);
    setError(undefined);
    try {
      const groups = deleting
        ? preferences.groups.filter((group) => group.id !== draft.id)
        : value
          ? preferences.groups.map((group) =>
              group.id === draft.id ? draft : group,
            )
          : [...preferences.groups, draft];
      await saveWorkspacePreferences({ ...preferences, groups });
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      helpTopic="favorite-group-editor"
      title={value ? "Группа закреплений" : "Добавить группу закреплений"}
      description="Эта группа появится только у тебя. Другие участники команды соберут свои."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Название группы">
          <input
            required
            maxLength={120}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
            placeholder="Например, ежедневная работа"
          />
        </Field>
        <Field label="Найти ресурс">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Название или адрес"
          />
        </Field>
        <div className="workspace-chooser">
          {resources
            .filter(isServiceCardResource)
            .filter((resource) =>
              `${resource.name} ${resource.hostname} ${resource.url}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((resource) => (
              <label key={resource.id}>
                <input
                  type="checkbox"
                  checked={draft.resource_ids.includes(resource.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      resource_ids: event.target.checked
                        ? [...draft.resource_ids, resource.id]
                        : draft.resource_ids.filter((id) => id !== resource.id),
                    })
                  }
                />
                <span>
                  {resource.name}
                  <small>{resource.description || resource.hostname}</small>
                </span>
              </label>
            ))}
        </div>
        {remove && (
          <p className="notice">
            Удалить личную группу «{draft.name}»? Карточки ресурсов останутся в
            каталоге.
          </p>
        )}
        {!!error && <ErrorBox error={error} />}
        <div className="dialog-footer">
          {value && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => (remove ? void save(true) : setRemove(true))}
            >
              {remove ? "Подтвердить удаление группы" : "Удалить группу"}
            </Button>
          )}
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить группу"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function WorkspaceHome({
  session,
  actions,
  onPalette,
  navigate,
  onPersonal,
}: {
  session: Session;
  actions: ResourceActions;
  onPalette: () => void;
  navigate: (page: string) => void;
  onPersonal: () => void;
}) {
  const resources = useAPI<Resource[]>("/resources");
  const preferences = useAPI<WorkspacePreferences>("/workspace-preferences");
  const integrations = useAPI<Integration[]>("/integrations");
  const events = useAPI<PortalEvent[]>("/events");
  const [editing, setEditing] = useState<FavoriteGroup | "new">();
  const [error, setError] = useState<unknown>();
  const [groupBusy, setGroupBusy] = useState(false);
  const byID = new Map(
    resources.data?.map((resource) => [resource.id, resource]),
  );
  const picks = (ids: string[]) =>
    ids
      .map((id) => byID.get(id))
      .filter(
        (resource): resource is Resource =>
          !!resource && isServiceCardResource(resource),
      );
  const favorites = picks(actions.preferences?.favorites || []);
  async function collapse(group: FavoriteGroup) {
    if (!preferences.data || groupBusy) return;
    setError(undefined);
    setGroupBusy(true);
    try {
      await saveWorkspacePreferences({
        ...preferences.data,
        groups: preferences.data.groups.map((item) =>
          item.id === group.id ? { ...item, collapsed: !item.collapsed } : item,
        ),
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setGroupBusy(false);
    }
  }
  const blocks: {
    id: string;
    label: string;
    content: ReactNode;
    width: number;
    height: number;
    hideable: boolean;
  }[] = [
    {
      id: "favorites",
      label: "Закрепления",
      width: 12,
      height: 0,
      hideable: true,
      content: (
        <section className="home-favorites">
          <div className="section-heading">
            <h2>
              <Star size={20} className="text-orange" />
              Закрепления
            </h2>
            <Button size="sm" variant="ghost" onClick={onPersonal}>
              <SlidersHorizontal size={15} />
              Выбрать и упорядочить
            </Button>
          </div>
          {resources.error ? (
            <ErrorBox error={resources.error} />
          ) : favorites.length ? (
            <FavoriteCards resources={favorites} actions={actions} />
          ) : (
            <div className="empty-favorites">
              <Star size={19} />
              <span>Найди нужные ресурсы в каталоге и нажми на звёздочки.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigate("catalog")}
              >
                Открыть каталог <ArrowRight size={14} />
              </Button>
            </div>
          )}
        </section>
      ),
    },
    {
      id: "directions",
      label: "Приложения",
      width: 4,
      height: 0,
      hideable: true,
      content: (
        <Panel
          title="Приложения"
          icon={<LayoutGrid size={18} />}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate("catalog?kind=applications")}
            >
              Открыть каталог <ArrowRight size={14} />
            </Button>
          }
        >
          <div className="direction-cards">
            {[
              ...new Set(
                resources.data
                  ?.filter(
                    (resource) => resourceKind(resource) === "applications",
                  )
                  .flatMap((resource) => resource.directions || []),
              ),
            ]
              .slice(0, 6)
              .map((direction) => (
                <button
                  key={direction}
                  onClick={() =>
                    navigate(
                      `catalog?kind=applications&direction=${encodeURIComponent(direction)}`,
                    )
                  }
                >
                  {direction}
                  <ChevronRight size={14} />
                </button>
              ))}
          </div>
          <div className="catalog-summary">
            <strong>
              {resources.data?.filter(
                (resource) => resourceKind(resource) === "applications",
              ).length ?? "—"}
            </strong>
            <span>приложений в каталоге</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate("catalog?kind=infrastructure")}
          >
            Инфраструктура <ArrowRight size={14} />
          </Button>
        </Panel>
      ),
    },
    {
      id: "events",
      label: "Недавние события",
      width: 4,
      height: 0,
      hideable: true,
      content: (
        <Panel
          title="Недавние события"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate("events")}
            >
              Все события <ArrowRight size={14} />
            </Button>
          }
        >
          {events.error ? (
            <ErrorBox error={events.error} />
          ) : events.data?.length ? (
            <EventRows events={events.data} limit={5} />
          ) : (
            <p className="muted">Событий пока нет.</p>
          )}
        </Panel>
      ),
    },
    {
      id: "integrations",
      label: "Состояние интеграций",
      width: 4,
      height: 0,
      hideable: true,
      content: (
        <Panel title="Состояние интеграций">
          {integrations.error ? (
            <ErrorBox error={integrations.error} />
          ) : (
            integrations.data?.slice(0, 6).map((source) => (
              <div className="workspace-integration-row" key={source.id}>
                <strong>{source.name}</strong>
                <Badge value={source.enabled ? source.status : "disabled"} />
                <small>{date(source.last_success)}</small>
              </div>
            ))
          )}
        </Panel>
      ),
    },
    {
      id: "systems",
      label: "Контроль выбранных систем",
      width: 12,
      height: 0,
      hideable: true,
      content: (
        <SelectedSystems
          actions={actions}
          onCatalog={() => navigate("catalog?kind=systems")}
        />
      ),
    },
    {
      id: "wayline",
      label: "Wayline",
      width: 12,
      height: 0,
      hideable: true,
      content: (
        <WaylineDashboard
          preferences={
            actions.preferences
              ? {
                  ...actions.preferences,
                  hidden_sections: actions.preferences.hidden_sections.filter(
                    (section) => section !== "wayline",
                  ),
                }
              : undefined
          }
          onChange={(value) =>
            actions.onPreferences({
              ...value,
              hidden_sections: actions.preferences?.hidden_sections || [],
            })
          }
          onSelect={onPersonal}
        />
      ),
    },
    {
      id: "grafana",
      label: "Grafana",
      width: 12,
      height: 0,
      hideable: true,
      content: <GrafanaCharts timezone={session.timezone || "Europe/Moscow"} />,
    },
  ];
  for (const group of preferences.data?.groups || []) {
    blocks.push({
      id: `favorite-group_${group.id}`,
      label: group.name,
      width: 6,
      height: 0,
      hideable: true,
      content: (
        <section>
          <div className="workspace-group-heading">
            <h2>{group.name}</h2>
            <div className="workspace-group-actions">
              <Button
                size="icon"
                variant="ghost"
                disabled={groupBusy}
                aria-label={`${group.collapsed ? "Развернуть" : "Свернуть"} группу ${group.name}`}
                onClick={() => void collapse(group)}
              >
                {group.collapsed ? (
                  <ChevronRight size={17} />
                ) : (
                  <ChevronDown size={17} />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Настроить группу ${group.name}`}
                onClick={() => setEditing(group)}
              >
                <SlidersHorizontal size={16} />
              </Button>
            </div>
          </div>
          {group.collapsed ? (
            <p className="workspace-group-collapsed">
              Ресурсов: {picks(group.resource_ids).length}
            </p>
          ) : picks(group.resource_ids).length ? (
            <FavoriteCards
              resources={picks(group.resource_ids)}
              actions={actions}
            />
          ) : (
            <Empty
              title="В группе нет доступных ресурсов"
              action={
                <Button onClick={() => setEditing(group)}>
                  Выбрать ресурсы
                </Button>
              }
            />
          )}
        </section>
      ),
    });
  }
  const legacyHidden = [
    ...(actions.preferences?.hidden_sections || []).filter(
      (id) => !["problems", "tools", "reports"].includes(id),
    ),
  ];
  if (!preferences.data?.system_ids.length) legacyHidden.push("systems");
  const order = actions.preferences?.section_order || [];
  blocks.sort(
    (a, b) =>
      (order.includes(a.id) ? order.indexOf(a.id) : 100) -
      (order.includes(b.id) ? order.indexOf(b.id) : 100),
  );
  return (
    <>
      <div className="home-intro workspace-home-intro">
        <div className="greeting">
          <h1>Моё рабочее пространство</h1>
          <ServerClock timezone={session.timezone || "Europe/Moscow"} />
        </div>
        <button className="global-search" onClick={onPalette}>
          <Search size={23} />
          <span>Найти ресурс или действие</span>
        </button>
        <div className="intro-actions">
          <Button variant="default" onClick={() => actions.onEdit()}>
            <Plus size={17} />
            <span>Добавить ресурс</span>
          </Button>
        </div>
      </div>
      {!!(error || preferences.error) && (
        <ErrorBox
          error={error || preferences.error}
          retry={() => void preferences.refetch()}
        />
      )}
      <DashboardLayout
        view="admin"
        items={blocks.filter(
          (block) =>
            block.id !== "systems" || !!preferences.data?.system_ids.length,
        )}
        legacyHidden={legacyHidden}
        onAdvanced={onPersonal}
        toolbarActions={
          <Button
            size="sm"
            disabled={!preferences.data || !resources.data}
            onClick={() => setEditing("new")}
          >
            <FolderPlus size={15} />
            Добавить группу
          </Button>
        }
      />
      {editing && preferences.data && resources.data && (
        <FavoriteGroupEditor
          value={editing === "new" ? undefined : editing}
          preferences={preferences.data}
          resources={resources.data}
          onClose={() => setEditing(undefined)}
          onSaved={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
