import { useHelpTopic } from "./Help";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, Clock3, X } from "lucide-react";
import { api, date, useAPI } from "./api";
import type { Integration, Job, Resource } from "./types";
import type { WorkspaceOperation } from "./workspaceTypes";
import { Button } from "./components/ui/button";
import { Badge, Empty, ErrorBox, Panel } from "./components/common";
import { JobResult } from "./Operations";
import { statusLabel } from "./copy";
import "./workspace.css";

function operationAction(item: Job) {
  return statusLabel[item.kind] || "Операция";
}

function operationActor(item: WorkspaceOperation) {
  return (
    item.actor_name?.trim() ||
    (item.actor === "system" ? "Система" : "Имя не указано")
  );
}

function operationTarget(
  item: Job,
  resources: Map<string, string>,
  integrations: Map<string, string>,
) {
  const resource = item.resource_name || resources.get(item.resource_id);
  if (resource) return resource;
  const integration =
    item.integration_name || integrations.get(item.integration_id);
  if (integration) return integration;
  const target = item.parameters?.target;
  if (typeof target === "string" && target.trim()) return target.trim();
  if (item.integration_id) return "Источник недоступен";
  if (item.resource_id) return "Ресурс недоступен в каталоге";
  return "Цель не указана";
}

function OperationOutcome({ job }: { job: Job }) {
  if (job.status !== "succeeded") return null;
  if (job.kind === "refresh" && job.result?.refreshed === true)
    return (
      <p className="workspace-operation-outcome">Данные источника обновлены.</p>
    );
  if (job.kind === "enrich") {
    const suggestions = job.result?.suggestions;
    const observations = job.result?.observations;
    const name =
      suggestions && typeof suggestions === "object" && "name" in suggestions
        ? suggestions.name
        : undefined;
    const http =
      observations &&
      typeof observations === "object" &&
      "http_status" in observations
        ? observations.http_status
        : undefined;
    return (
      <div className="workspace-operation-outcome">
        <p>
          Получены предложения для карточки
          {typeof http === "number" ? ` · HTTP ${http}` : ""}.
        </p>
        {typeof name === "string" && name.trim() && (
          <p>Предложенное название: {name}</p>
        )}
        {job.result?.requires_confirmation === true && (
          <p>Предложения требуют подтверждения.</p>
        )}
      </div>
    );
  }
  if (job.kind === "report" && job.result?.created === true)
    return <p className="workspace-operation-outcome">Отчёт сформирован.</p>;
  if (job.kind === "report" && job.result?.created === false)
    return (
      <p className="workspace-operation-outcome">
        Найден ранее сформированный отчёт.
      </p>
    );
  return null;
}

export function OperationsTimeline({
  onJournal,
  active = true,
}: {
  onJournal: (audit: boolean) => void;
  active?: boolean;
}) {
  useHelpTopic(active ? "operations" : undefined, active ? 2 : -1);
  const operations = useQuery({
    queryKey: ["/operations"],
    queryFn: () => api<WorkspaceOperation[]>("/operations"),
    enabled: active,
    refetchInterval: (query) =>
      query.state.data?.some(
        (item) => item.status === "queued" || item.status === "running",
      )
        ? 2000
        : 60000,
  });
  const resources = useAPI<Resource[]>("/resources");
  const integrations = useAPI<Integration[]>("/integrations");
  const [selected, setSelected] = useState<WorkspaceOperation>();
  const result = useAPI<Job>(
    `/jobs/${selected?.id || ""}`,
    active && !!selected,
  );
  const resourceNames = new Map(
    resources.data?.map((resource) => [resource.id, resource.name]),
  );
  const integrationNames = new Map(
    integrations.data?.map((integration) => [integration.id, integration.name]),
  );
  const selectedJob =
    selected && result.data?.id === selected.id ? result.data : selected;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>События</h1>
          <p>Запуски и результаты операций команды</p>
        </div>
        <div className="segmented" role="group" aria-label="Режим журнала">
          <Button variant="ghost" onClick={() => onJournal(false)}>
            События
          </Button>
          <Button variant="ghost" onClick={() => onJournal(true)}>
            Аудит
          </Button>
          <Button variant="default" aria-pressed>
            Операции
          </Button>
        </div>
      </div>
      <div className="workspace-operations-grid">
        <Panel title="Операции команды" icon={<Clock3 size={18} />}>
          {operations.error && (
            <ErrorBox
              error={operations.error}
              retry={() => void operations.refetch()}
            />
          )}
          {operations.isPending ? (
            <p className="loading">Загружаем операции…</p>
          ) : operations.data?.length ? (
            <div className="workspace-operation-list">
              {operations.data.map((item) => (
                <button
                  className="workspace-operation-row"
                  key={item.id}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => setSelected(item)}
                >
                  {item.status === "succeeded" ? (
                    <CircleCheck size={18} />
                  ) : (
                    <Clock3 size={18} />
                  )}
                  <span>
                    <strong>
                      {operationAction(item)} ·{" "}
                      {operationTarget(item, resourceNames, integrationNames)}
                    </strong>
                    <small>
                      Инициатор: {operationActor(item)} ·{" "}
                      <Badge value={item.status} />
                    </small>
                  </span>
                  <time>{date(item.created_at)}</time>
                </button>
              ))}
            </div>
          ) : (
            !operations.error && (
              <Empty
                title="Операций пока нет"
                detail="Здесь сохраняются проверки и разрешённые действия, выполненные через Платформу."
              />
            )
          )}
        </Panel>
        <section
          className="workspace-operation-result"
          aria-label="Результат операции"
        >
          {selected ? (
            <>
              <div className="simple-row">
                <h3>{operationAction(selected)}</h3>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Сбросить выбор операции"
                  onClick={() => setSelected(undefined)}
                >
                  <X size={18} />
                </Button>
              </div>
              <dl className="workspace-operation-facts">
                <div>
                  <dt>Цель</dt>
                  <dd>
                    {operationTarget(
                      selectedJob!,
                      resourceNames,
                      integrationNames,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Инициатор</dt>
                  <dd>{operationActor(selected)}</dd>
                </div>
                <div>
                  <dt>Результат</dt>
                  <dd>
                    {statusLabel[selectedJob?.status || ""] || "Неизвестно"}
                  </dd>
                </div>
                <div>
                  <dt>Создано</dt>
                  <dd>{date(selected.created_at)}</dd>
                </div>
              </dl>
              {selectedJob && <OperationOutcome job={selectedJob} />}
              <JobResult
                job={selectedJob}
                error={result.error}
                showHeader={false}
              />
            </>
          ) : (
            <Empty
              title="Результат операции"
              detail="Выбери запись слева — справа появятся параметры и результат."
            />
          )}
          {selected?.resource_id && (
            <a
              className="button"
              href={`#catalog?q=${encodeURIComponent(resourceNames.get(selected.resource_id) || "")}`}
            >
              Ресурс в каталоге <ArrowRight size={14} />
            </a>
          )}
        </section>
      </div>
    </>
  );
}
