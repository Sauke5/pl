import { DetailsMenu } from "./details-menu";
import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch, useRouterState } from "@tanstack/react-router";
import { ChevronDown, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Task } from "./api";
import {
  BoardDragSurface,
  DraggableBoardTask,
  DroppableBoardColumn,
} from "./board-drag";
import { previewBoardMove, sortBoardTasks, useBoardMove } from "./board-move";
import { readMyTasksContext } from "./task-navigation";
import { readTaskSearchContext } from "./task-search-context";
import { DoskaTaskCard } from "./task-card";
import { DoskaTaskTable } from "./task-table";
import { DoskaTaskBulkActions } from "./task-bulk-actions";
import { DoskaTaskCalendar } from "./task-calendar";
import { DoskaTaskDrawer } from "./task-drawer";
import "./board.css";
import "./board-toolbar.css";
import { DoskaMembersPanel } from "./members-panel";
import { DoskaColumnsPanel } from "./columns-panel";
import { DoskaTaskImport } from "./task-import-panel";
import { DoskaTemplateSave } from "./template-save";
import { DoskaProjectSettings } from "./project-settings";
import { DoskaProjectManagement } from "./project-management";
const pageSize = 100;
export function DoskaBoard({ projectId }: { projectId: string }) {
  const { t } = useTranslation("doska");
  const navigate = useNavigate();
  const returnToMyTasks = useRouterState({
    select: (state) => readMyTasksContext(state.location.state),
  });
  const returnToSearch = useRouterState({
    select: (state) => readTaskSearchContext(state.location.state),
  });
  const search = useSearch({ strict: false }) as {
    taskId?: string;
    panel?: "members";
  };
  const cache = useQueryClient();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const move = useBoardMove(projectId);
  const [view, setView] = useState<"board" | "table" | "calendar">("board");
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTasks, setBulkTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    setSelectedIds(new Set());
  }, [projectId, archived, filter, view]);
  const [newColumn, setNewColumn] = useState<string | null>(null);
  const projectMenu = useRef<HTMLDetailsElement>(null);
  const [panel, setPanel] = useState<
    | "members"
    | "columns"
    | "settings"
    | "management"
    | "template"
    | "import"
    | null
  >(null);
  const openPanel = (
    value:
      | "members"
      | "columns"
      | "settings"
      | "management"
      | "template"
      | "import",
  ) => {
    if (projectMenu.current) {
      projectMenu.current.open = false;
      projectMenu.current.querySelector("summary")?.focus();
    }
    setPanel(value);
  };
  const project = useQuery({
    queryKey: ["doska", "project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const access = useQuery({
    queryKey: ["doska", "access", projectId],
    queryFn: () => api.getAccess(projectId),
  });
  const columns = useQuery({
    queryKey: ["doska", "columns", projectId],
    queryFn: () => api.listColumns(projectId),
  });
  const members = useQuery({
    queryKey: ["doska", "members", projectId],
    queryFn: () => api.listMembers(projectId),
  });
  const tasks = useInfiniteQuery({
    queryKey: ["doska", "tasks", projectId, archived],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.listTasks(projectId, {
        limit: pageSize,
        offset: pageParam,
        archived,
      }),
    getNextPageParam: (last, pages) =>
      last.length === pageSize ? pages.flat().length : undefined,
  });
  const { hasNextPage, isFetching, isError, fetchNextPage } = tasks;
  useEffect(() => {
    if (view !== "board" && hasNextPage && !isFetching && !isError)
      void fetchNextPage();
  }, [view, hasNextPage, isFetching, isError, fetchNextPage]);
  const openTask = (taskId?: string) =>
    void navigate({
      to: "/projects/$projectId",
      params: { projectId },
      search: { taskId },
    } as never);
  const changed = () => {
    void cache.invalidateQueries({ queryKey: ["doska"] });
  };
  const allTasks = sortBoardTasks(tasks.data?.pages.flat() ?? []);
  const taskMap = new Map(allTasks.map((task) => [task.id, task]));
  const visibleTasks = previewBoardMove(allTasks, move.pending).filter((task) =>
    `${task.title} ${task.description ?? ""}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase()),
  );
  const selectedTasks = visibleTasks.filter((task) => selectedIds.has(task.id));
  const roster = members.data
    ? [members.data.owner, ...members.data.members]
    : [];
  const canWork = Boolean(
    access.data?.workOnTasks && project.data && !project.data.archivedAt,
  );
  const boardColumns = columns.data ?? [];
  if (project.isPending || access.isPending || columns.isPending)
    return (
      <div className="doska-panel" role="status">
        {t("loading")}
      </div>
    );
  const boardReadError = [project, access, columns].some(
    (query) => query.isError,
  );
  const inaccessible = [project, access, columns].some(
    (query) =>
      query.error instanceof ApiError &&
      [401, 403, 404].includes(query.error.status),
  );
  if (!project.data || !access.data || !columns.data || inaccessible)
    return (
      <div className="doska-panel doska-error" role="alert">
        <p>{t("loadError")}</p>
        <button onClick={changed}>{t("retry")}</button>
      </div>
    );
  return (
    <>
      <div className="doska-board-toolbar">
        <div className="doska-board-title">
          <h1 title={project.data.name}>{project.data.name}</h1>
          {project.data.archivedAt && <p>{t("archivedProject")}</p>}
        </div>
        <div
          className="doska-view-switch"
          role="group"
          aria-label={t("taskViews")}
        >
          {(["board", "table", "calendar"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={view === item}
              onClick={() => setView(item)}
            >
              {t(
                item === "board"
                  ? "board"
                  : item === "table"
                    ? "tableView"
                    : "calendarTitle",
              )}
            </button>
          ))}
        </div>
        <div className="doska-filters doska-board-filters">
          <label>
            <Search size={17} />
            <input
              type="search"
              aria-label={t("searchTasks")}
              placeholder={t("searchTasks")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            {t("archived")}
          </label>
          {tasks.data && (tasks.hasNextPage || filter.trim()) && (
            <span className="doska-meta">
              {t(filter.trim() ? "foundTasks" : "loadedTasksPartial", {
                count: filter.trim() ? visibleTasks.length : allTasks.length,
              })}
            </span>
          )}
        </div>
        <div className="doska-heading-actions">
          <DetailsMenu
            ref={projectMenu}
            className="doska-project-menu"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary>
              {t("projectMenu")}
              <ChevronDown size={15} />
            </summary>
            <div className="doska-project-menu-items">
              <button onClick={() => openPanel("members")}>
                {t("participants")}
              </button>
              {access.data.manageSettings && (
                <>
                  <button onClick={() => openPanel("columns")}>
                    {t("columnSettings")}
                  </button>
                  <button onClick={() => openPanel("settings")}>
                    {t("projectSettings")}
                  </button>
                </>
              )}
              {canWork && boardColumns.length > 0 && (
                <button onClick={() => openPanel("import")}>
                  {t("importTasks")}
                </button>
              )}
              {access.data.manageSettings && !project.data.archivedAt && (
                <button onClick={() => openPanel("template")}>
                  {t("templateSave")}
                </button>
              )}
              {access.data.readManagementMetadata && (
                <button onClick={() => openPanel("management")}>
                  {t("manageProject")}
                </button>
              )}
            </div>
          </DetailsMenu>
          {canWork && boardColumns.length > 0 && (
            <button
              className="doska-primary"
              onClick={() => setNewColumn(boardColumns[0].id)}
            >
              <Plus size={17} />
              {t("newTask")}
            </button>
          )}
        </div>
      </div>
      {filter && tasks.hasNextPage && (
        <p className="doska-meta">{t("searchLoadedOnly")}</p>
      )}
      {boardReadError && (
        <div className="doska-notice doska-error" role="alert">
          {t("loadError")} <button onClick={changed}>{t("retry")}</button>
        </div>
      )}
      {tasks.isError && (
        <div className="doska-notice doska-error" role="alert">
          {t("loadError")}{" "}
          <button onClick={() => void tasks.refetch()}>{t("retry")}</button>
        </div>
      )}
      {move.error && (
        <div className="doska-notice doska-error" role="alert">
          {t(move.error)} <button onClick={move.dismiss}>{t("close")}</button>
        </div>
      )}
      {move.confirmation && (
        <div className="doska-notice" role="alert">
          <p>{t("incompleteSubtasks")}</p>
          <button
            className="doska-primary"
            onClick={() => {
              const value = move.confirmation;
              if (value)
                void move.move(
                  value.task,
                  value.columnId,
                  value.beforeTaskId,
                  true,
                );
            }}
          >
            {t("completeAnyway")}
          </button>
          <button onClick={move.cancel}>{t("cancel")}</button>
        </div>
      )}
      {view === "table" && !archived && canWork && selectedTasks.length > 0 && (
        <div className="doska-bulk-toolbar">
          <span>{t("bulkSelected", { count: selectedTasks.length })}</span>
          <button
            className="doska-primary"
            onClick={() => setBulkTasks(selectedTasks)}
          >
            {t("bulkActions")}
          </button>
          <button onClick={() => setSelectedIds(new Set())}>
            {t("bulkClearSelection")}
          </button>
        </div>
      )}
      <span className="doska-sr-only" role="status">
        {move.pending ? t("movingTask") : ""}
      </span>
      {tasks.isPending ||
      (view !== "board" && tasks.hasNextPage && !tasks.isError) ? (
        <div className="doska-panel" role="status">
          {t("loading")}
        </div>
      ) : tasks.data && view === "table" && !tasks.hasNextPage ? (
        <DoskaTaskTable
          selection={
            canWork && !archived
              ? {
                  selectedIds,
                  onChange: (tasks) =>
                    setSelectedIds(new Set(tasks.map((task) => task.id))),
                }
              : undefined
          }
          tasks={visibleTasks}
          columns={boardColumns}
          roster={roster}
          onOpen={openTask}
          now={now}
        />
      ) : tasks.data && view === "calendar" && !tasks.hasNextPage ? (
        <DoskaTaskCalendar
          tasks={visibleTasks}
          columns={boardColumns}
          onOpen={openTask}
          now={now}
        />
      ) : tasks.data && view === "board" ? (
        <BoardDragSurface
          tasks={allTasks}
          disabled={
            !canWork || archived || !!move.pending || !!move.confirmation
          }
          onMove={(task, columnId, beforeTaskId) =>
            void move.move(task, columnId, beforeTaskId)
          }
        >
          <div className="doska-board" aria-label={t("board")}>
            {boardColumns.map((column) => {
              const items = visibleTasks.filter(
                (task) => task.columnId === column.id,
              );
              return (
                <DroppableBoardColumn
                  id={column.id}
                  name={column.name}
                  disabled={
                    !canWork ||
                    archived ||
                    !!move.pending ||
                    !!move.confirmation
                  }
                  semanticState={column.semanticState ?? "planned"}
                  key={column.id}
                >
                  <header>
                    <h2>
                      <span className="doska-column-dot" />
                      {column.name}
                    </h2>
                    <span className="doska-column-count">
                      {items.length}
                      {tasks.hasNextPage ? "+" : ""}
                    </span>
                    {canWork && !archived && (
                      <button
                        className="doska-icon"
                        aria-label={t("addTaskToColumn", {
                          column: column.name,
                        })}
                        onClick={() => setNewColumn(column.id)}
                      >
                        <Plus size={16} />
                      </button>
                    )}
                  </header>
                  <div className="doska-column-tasks">
                    {items.map((task) => (
                      <DraggableBoardTask
                        key={task.id}
                        task={task}
                        disabled={
                          !canWork ||
                          archived ||
                          !!move.pending ||
                          !!move.confirmation
                        }
                      >
                        <DoskaTaskCard
                          canWork={canWork && !archived && !move.pending}
                          task={task}
                          parentTitle={
                            task.parentTaskId
                              ? taskMap.get(task.parentTaskId)?.title
                              : undefined
                          }
                          now={now}
                          completed={column.semanticState === "completed"}
                          selected={task.id === search.taskId}
                          assignee={
                            roster.find(
                              (person) => person.userId === task.userId,
                            )?.name
                          }
                          onOpen={() => openTask(task.id)}
                        />
                      </DraggableBoardTask>
                    ))}
                  </div>
                </DroppableBoardColumn>
              );
            })}
            {!boardColumns.length && (
              <div className="doska-panel">{t("noColumns")}</div>
            )}
          </div>
        </BoardDragSurface>
      ) : null}
      {view === "board" &&
        allTasks.some(
          (task) => !boardColumns.some((column) => column.id === task.columnId),
        ) && (
          <div className="doska-unplaced">
            <h2>{t("withoutColumn")}</h2>
            {visibleTasks
              .filter(
                (task) =>
                  !boardColumns.some((column) => column.id === task.columnId),
              )
              .map((task) => (
                <DoskaTaskCard
                  key={task.id}
                  canWork={canWork && !archived && !move.pending}
                  task={task}
                  parentTitle={
                    task.parentTaskId
                      ? taskMap.get(task.parentTaskId)?.title
                      : undefined
                  }
                  now={now}
                  selected={task.id === search.taskId}
                  onOpen={() => openTask(task.id)}
                />
              ))}
          </div>
        )}
      {view === "board" && tasks.hasNextPage && (
        <div className="doska-pagination">
          <button
            disabled={tasks.isFetchingNextPage}
            onClick={() => void tasks.fetchNextPage()}
          >
            {t(tasks.isFetchingNextPage ? "loading" : "loadMore")}
          </button>
        </div>
      )}
      {panel === "import" && canWork && (
        <DoskaTaskImport
          projectId={projectId}
          columns={boardColumns}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "template" && access.data.manageSettings && (
        <DoskaTemplateSave
          projectId={projectId}
          onClose={() => setPanel(null)}
        />
      )}
      {(panel === "members" || search.panel === "members") && (
        <DoskaMembersPanel
          projectId={projectId}
          onClose={() => {
            setPanel(null);
            if (search.panel === "members")
              void navigate({
                to: "/projects/$projectId",
                params: { projectId },
                search: { taskId: search.taskId },
                replace: true,
                resetScroll: false,
              } as never);
          }}
        />
      )}
      {panel === "columns" && (
        <DoskaColumnsPanel
          projectId={projectId}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "settings" && access.data.manageSettings && (
        <DoskaProjectSettings
          project={project.data}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "management" && (
        <DoskaProjectManagement
          projectId={projectId}
          onClose={() => setPanel(null)}
        />
      )}
      {bulkTasks && (
        <DoskaTaskBulkActions
          projectId={projectId}
          tasks={bulkTasks}
          allTasks={allTasks}
          columns={boardColumns}
          roster={roster
            .filter(
              (person) => !("role" in person) || person.role === "participant",
            )
            .map((person) => ({
              userId: person.userId,
              name: person.name ?? t("unavailableMember"),
            }))}
          onClose={() => setBulkTasks(null)}
          onChanged={() => {
            setSelectedIds(new Set());
            changed();
          }}
        />
      )}
      {(search.taskId || newColumn !== null) && (
        <DoskaTaskDrawer
          key={search.taskId ?? `new-${newColumn}`}
          projectId={projectId}
          taskId={search.taskId}
          initialColumn={newColumn ?? undefined}
          columns={boardColumns}
          canWork={canWork}
          canManageParticipants={Boolean(
            access.data?.manageParticipants && !project.data?.archivedAt,
          )}
          canDelete={Boolean(
            access.data.deleteTask && !project.data.archivedAt,
          )}
          onClose={() => {
            setNewColumn(null);
            if (returnToSearch) {
              void navigate({
                to: "/search",
                state: { doskaTaskSearch: returnToSearch },
                replace: true,
                resetScroll: false,
              } as never);
            } else if (returnToMyTasks) {
              void navigate({
                to: "/my-tasks",
                state: { doskaMyTasks: returnToMyTasks },
                replace: true,
                resetScroll: false,
              } as never);
            } else {
              openTask();
            }
          }}
          onChanged={changed}
        />
      )}
    </>
  );
}
