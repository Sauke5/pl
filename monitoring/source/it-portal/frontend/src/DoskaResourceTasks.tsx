import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "./components/ui/button";
import { ErrorBox } from "./components/common";
import { APIError, useAPI } from "./api";
import type { InventorySource, Session } from "./types";
import {
  createResourceTaskHref,
  resourceTaskLinks,
  type ResourceSelection,
} from "./doskaCatalog";

// A mounted drawer owns this data. It is fetched again on focus and page
// changes; failed revalidation never leaves old task titles on screen.
export function DoskaResourceTasks({ resourceId }: { resourceId: string }) {
  const session = useAPI<Session>("/session");
  if (session.error)
    return (
      <ErrorBox error={session.error} retry={() => void session.refetch()} />
    );
  if (session.isPending)
    return <p role="status">Проверка доступности Doska…</p>;
  return session.data?.features?.doska ? (
    <ConnectedDoskaResourceTasks resourceId={resourceId} />
  ) : null;
}
function ConnectedDoskaResourceTasks({ resourceId }: { resourceId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [sourceKind, setSourceKind] =
    useState<ResourceSelection["sourceKind"]>("platform");
  const inventory = useAPI<{ sources: InventorySource[] }>(
    `/resources/${resourceId}/inventory`,
  );
  const netbox = inventory.data?.sources.filter(
    (source) =>
      source.kind === "netbox" &&
      source.inventory &&
      ["device", "virtual_machine"].includes(source.inventory.kind),
  );
  const hasNetbox = !inventory.error && netbox?.length === 1;
  const effectiveSourceKind = hasNetbox ? sourceKind : "platform";
  useEffect(() => {
    if (!hasNetbox && sourceKind === "netbox") {
      setSourceKind("platform");
      setCursor(null);
    }
  }, [hasNetbox, sourceKind]);
  const selection: ResourceSelection = {
    resourceId,
    sourceKind: effectiveSourceKind,
  };
  const tasks = useQuery({
    queryKey: ["doska-resource-tasks", resourceId, effectiveSourceKind, cursor],
    queryFn: ({ signal }) => resourceTaskLinks(selection, cursor, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: 30000,
  });
  const unavailable =
    tasks.error instanceof APIError && tasks.error.status === 404;
  return (
    <section className="doska-resource-tasks" aria-label="Задачи Doska">
      <div className="doska-resource-tasks-heading">
        <h3>Задачи Doska</h3>
        <a
          className="resource-detail-link"
          href={createResourceTaskHref(selection)}
        >
          Создать задачу
        </a>
      </div>
      {hasNetbox && (
        <label className="doska-resource-source">
          Объект связи
          <select
            value={sourceKind}
            onChange={(event) => {
              setSourceKind(
                event.target.value as ResourceSelection["sourceKind"],
              );
              setCursor(null);
            }}
          >
            <option value="platform">Ресурс Платформы</option>
            <option value="netbox">Объект NetBox</option>
          </select>
        </label>
      )}
      {tasks.isFetching ? (
        <p className="muted" role="status">
          Загрузка задач…
        </p>
      ) : tasks.error ? (
        <div role="status">
          <p className="muted">
            {unavailable
              ? "Связи с задачами недоступны."
              : "Не удалось получить задачи Doska."}
          </p>
          <Button variant="secondary" onClick={() => void tasks.refetch()}>
            Повторить
          </Button>
        </div>
      ) : tasks.data?.items.length ? (
        <ul className="doska-resource-task-list">
          {tasks.data.items.map((task) => (
            <li key={`${task.projectId}:${task.taskId}`}>
              <a href={task.href}>{task.title}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Доступных связанных задач нет.</p>
      )}
      {!tasks.isFetching &&
        !tasks.error &&
        (cursor || tasks.data?.nextCursor) && (
          <div className="actions">
            {cursor && (
              <Button variant="secondary" onClick={() => setCursor(null)}>
                К началу
              </Button>
            )}
            {tasks.data?.nextCursor && (
              <Button
                variant="secondary"
                onClick={() => setCursor(tasks.data!.nextCursor)}
              >
                Следующие задачи
              </Button>
            )}
          </div>
        )}
    </section>
  );
}
