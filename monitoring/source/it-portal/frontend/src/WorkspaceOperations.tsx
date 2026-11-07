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
  if (item.kind === "delivery")
    return item.parameters?.action === "module-upgrade"
      ? "Обновление модуля"
      : "Обновление PL";
  if (item.kind === "module") {
    const action =
      typeof item.parameters?.action === "string" ? item.parameters.action : "";
    return (
      (
        {
          enable: "Включение модуля",
          disable: "Отключение модуля",
          refresh: "Обновление состояния модуля",
          install: "Установка модуля",
          connect: "Подключение модуля",
          reconnect: "Переподключение модуля",
          configure: "Применение конфигурации модуля",
          remove: "Удаление модуля",
          start: "Запуск модуля",
          stop: "Остановка модуля",
          restart: "Перезапуск модуля",
          update: "Обновление модуля",
        } as Record<string, string>
      )[action] || (action ? `Модуль: ${action}` : "Операция с модулем")
    );
  }
  return statusLabel[item.kind] || item.kind || "Операция";
}

function operationActor(item: WorkspaceOperation) {
  return (
    item.actor_name?.trim() ||
    (item.actor === "system" || item.actor?.startsWith("system:")
      ? `Система${item.actor?.startsWith("system:") ? ` · ${item.actor.slice(7)}` : ""}`
      : (item.kind === "delivery" && item.actor?.trim()) || "Имя не указано")
  );
}

function operationTarget(
  item: Job,
  resources: Map<string, string>,
  integrations: Map<string, string>,
) {
  if (item.kind === "delivery") {
    const target = item.parameters?.target;
    if (typeof target === "string" && target.trim()) return target.trim();
    return item.parameters?.action === "module-upgrade"
      ? "Модуль"
      : "Платформа";
  }
  if (item.kind === "module") {
    const name = item.parameters?.module_name;
    if (typeof name === "string" && name.trim()) return name.trim();
    const id = item.parameters?.instance_id;
    if (typeof id === "string" && id.trim()) return `Экземпляр ${id}`;
  }
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

const moduleStateLabels: Record<string, string> = {
  pending: "Ожидает выполнения",
  running: "Работает",
  disabled: "Отключён",
  unavailable: "Недоступен",
  error: "Ошибка",
  unknown: "Состояние неизвестно",
  removing: "Удаляется",
  absent: "Удалён",
};

const deliveryPhaseLabels: Record<string, string> = {
  requesting: "Передаём запрос на обновление",
  queued: "Ожидает запуска",
  queued_recovery: "Ожидает продолжения обновления",
  downloading: "Загружаем обновление",
  preparing_host: "Готовим сервер",
  verifying_host: "Проверяем готовность сервера",
  preparing: "Готовим обновление",
  staging: "Подготавливаем файлы",
  quiescing: "Приостанавливаем приложения",
  snapshot: "Сохраняем текущее состояние",
  applying: "Устанавливаем обновление",
  verifying: "Проверяем новую версию",
  resuming: "Запускаем приложения",
  reconciling: "Уточняем состояние обновления",
  restoring: "Восстанавливаем предыдущую версию",
  complete: "Обновление завершено",
  failed: "Обновление не завершено",
  rolled_back: "Предыдущая версия восстановлена",
  recovery_required: "Нужно проверить состояние установки",
  unconfirmed: "Ожидаем подтверждения сервера",
};

function deliveryVersion(item: Job) {
  const version = item.parameters?.version || item.result?.target_version;
  return typeof version === "string" ? version.trim() : "";
}

function operationStatus(item: Job) {
  if (item.kind === "delivery") {
    if (item.status === "unknown") return "Не подтверждено";
    if (item.result?.phase === "rolled_back")
      return "Предыдущая версия восстановлена";
  }
  return statusLabel[item.status] || "Неизвестно";
}

function OperationOutcome({ job }: { job: Job }) {
  if (job.kind === "delivery") {
    const summary = job.result?.summary;
    return (
      <div className="workspace-operation-outcome">
        {typeof summary === "string" && summary.trim() && <p>{summary}</p>}
        {job.status === "unknown" ? (
          <p>
            Сервер пока не подтвердил результат. Проверьте состояние этой
            операции в настройках обновлений.
          </p>
        ) : (
          job.result?.restored_snapshot === true &&
          job.result?.phase !== "rolled_back" && (
            <p>Предыдущее состояние восстановлено.</p>
          )
        )}
      </div>
    );
  }
  if (job.status !== "succeeded") return null;
  if (job.kind === "module") {
    const instance = job.result?.instance as
      Record<string, unknown> | undefined;
    const state =
      typeof instance?.observed_state === "string"
        ? instance.observed_state
        : "";
    const version =
      typeof instance?.version === "string" ? instance.version : "";
    const removed = job.parameters?.action === "remove";
    return (
      <p className="workspace-operation-outcome">
        {removed ? "Модуль удалён." : "Операция с модулем завершена."}
        {state
          ? ` Состояние: ${moduleStateLabels[state] || "Состояние неизвестно"}.`
          : ""}
        {version ? ` Версия: ${version}.` : ""}
      </p>
    );
  }
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
  const [showServiceRefresh, setShowServiceRefresh] = useState(false);
  const operations = useQuery({
    queryKey: ["/operations", showServiceRefresh],
    queryFn: () =>
      api<WorkspaceOperation[]>(
        `/operations?exclude_service_refresh=${!showServiceRefresh}`,
      ),
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
  const [selectedId, setSelectedId] = useState<string>();
  const selected = operations.data?.find((item) => item.id === selectedId);
  if (selectedId && operations.data && !selected) setSelectedId(undefined);
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
      <label className="events-collection-toggle">
        <input
          type="checkbox"
          checked={showServiceRefresh}
          onChange={(event) => setShowServiceRefresh(event.target.checked)}
        />
        <span>Показывать историю фоновых проверок</span>
        <small>
          Включая успешные проверки и ошибки, после которых опрос модуля прошёл
          успешно.
        </small>
      </label>
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
                  aria-pressed={selectedId === item.id}
                  onClick={() => setSelectedId(item.id)}
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
                      {item.kind === "delivery" && deliveryVersion(item)
                        ? ` · до ${deliveryVersion(item)}`
                        : ""}
                    </strong>
                    <small>
                      Инициатор: {operationActor(item)} ·{" "}
                      <Badge value={item.status}>{operationStatus(item)}</Badge>
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
                  onClick={() => setSelectedId(undefined)}
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
                    {selectedJob ? operationStatus(selectedJob) : "Неизвестно"}
                  </dd>
                </div>
                {selectedJob?.kind === "delivery" && (
                  <>
                    {deliveryVersion(selectedJob) && (
                      <div>
                        <dt>Версия обновления</dt>
                        <dd>{deliveryVersion(selectedJob)}</dd>
                      </div>
                    )}
                    {typeof selectedJob.result?.phase === "string" && (
                      <div>
                        <dt>Этап</dt>
                        <dd>
                          {deliveryPhaseLabels[selectedJob.result.phase] ||
                            "Проверяем состояние операции"}
                        </dd>
                      </div>
                    )}
                  </>
                )}
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
