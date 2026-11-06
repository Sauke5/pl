import { useState } from "react";
import { Database, FolderClock, X } from "lucide-react";
import { date, useAPI } from "./api";
import type { Integration, Resource } from "./types";
import { Badge, Empty, ErrorBox, ExternalLink } from "./components/common";
import { Button } from "./components/ui/button";
import "./connection-details.css";

export type ConfigurationNode = {
  key: string;
  name: string;
  group: string;
  collection_status: string;
  last_successful_collection_at: string | null;
  last_change_at: string | null;
  revision: string;
  history_url: string;
  diff_url: string;
  error?: string;
  resource_id?: string;
};
export type ConfigurationHistory = {
  integration_id: string;
  observed_at: string | null;
  last_success_at: string | null;
  source_status: string;
  stale: boolean;
  nodes: ConfigurationNode[];
};
const collectionLabels: Record<string, string> = {
  success: "Собрана",
  failed: "Ошибка сбора",
  never: "Ещё не собиралась",
  unknown: "Нет данных о сборе",
};
function ConfigurationRows({ value }: { value: ConfigurationHistory }) {
  return (
    <div className="connection-history-block">
      <div className="connection-detail-status">
        <Badge
          value={
            value.source_status === "partial"
              ? "warning"
              : value.stale
                ? "stale"
                : "ok"
          }
        >
          {value.source_status === "partial"
            ? "Часть истории недоступна"
            : value.stale
              ? "Данные не обновлены"
              : "Данные актуальны"}
        </Badge>
        <span className="muted">
          Получено: {date(value.observed_at || undefined)}
        </span>
      </div>
      {value.nodes.length ? (
        <div className="connection-table-scroll">
          <table className="connection-table">
            <thead>
              <tr>
                <th>Устройство</th>
                <th>Последний успешный сбор</th>
                <th>Изменение конфигурации</th>
                <th>История</th>
              </tr>
            </thead>
            <tbody>
              {value.nodes.map((node) => (
                <tr key={node.key}>
                  <th scope="row">
                    <strong>{node.name}</strong>
                    <small>{node.group}</small>
                    <small
                      className={
                        node.collection_status === "failed"
                          ? "settings-field-error"
                          : "muted"
                      }
                    >
                      {collectionLabels[node.collection_status] ||
                        "Нет данных о сборе"}
                    </small>
                  </th>
                  <td>
                    {date(node.last_successful_collection_at || undefined)}
                  </td>
                  <td>
                    {node.last_change_at ? (
                      <>
                        {date(node.last_change_at)}
                        <small className="connection-revision">
                          {node.revision.slice(0, 10)}
                        </small>
                      </>
                    ) : (
                      <span className="muted">Нет данных</span>
                    )}
                    {node.error && (
                      <small className="settings-field-error">
                        {node.error}
                      </small>
                    )}
                  </td>
                  <td>
                    <div className="connection-history-links">
                      {node.history_url && (
                        <ExternalLink url={node.history_url}>
                          История
                        </ExternalLink>
                      )}
                      {node.diff_url && (
                        <ExternalLink url={node.diff_url}>
                          Изменение
                        </ExternalLink>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="Данные ещё не получены"
          detail="Сохраните подключение и нажмите «Получить данные»."
        />
      )}
    </div>
  );
}
export function IntegrationConfigurationHistory({
  integrationID,
}: {
  integrationID: string;
}) {
  const query = useAPI<ConfigurationHistory>(
    "/integrations/" +
      encodeURIComponent(integrationID) +
      "/configuration-history",
  );
  return (
    <section className="connection-detail" aria-label="Конфигурации устройств">
      <h3>
        <FolderClock size={18} />
        Конфигурации устройств
      </h3>
      {query.error ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : query.isPending ? (
        <p role="status">Загрузка истории…</p>
      ) : (
        <ConfigurationRows value={query.data} />
      )}
    </section>
  );
}
export function ResourceConfigurationHistory({
  resourceID,
}: {
  resourceID: string;
}) {
  const query = useAPI<ConfigurationHistory[]>(
    "/resources/" + encodeURIComponent(resourceID) + "/configuration-history",
  );
  if (query.isPending || (!query.error && !query.data?.length)) return null;
  return (
    <section className="connection-detail" aria-label="Конфигурации устройства">
      <h3>
        <FolderClock size={18} />
        Конфигурации устройства
      </h3>
      {query.error ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        query.data?.map((value) => (
          <ConfigurationRows key={value.integration_id} value={value} />
        ))
      )}
    </section>
  );
}
export function OxidizedBindings({
  integration,
  config,
  onChange,
}: {
  integration?: Integration;
  config: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const resources = useAPI<Resource[]>("/resources");
  const history = useAPI<ConfigurationHistory>(
    "/integrations/" +
      encodeURIComponent(integration?.id || "") +
      "/configuration-history",
    !!integration,
  );
  const [nodeKey, setNodeKey] = useState("");
  const [resourceID, setResourceID] = useState("");
  let bindings: Record<string, string> = {};
  try {
    bindings = JSON.parse(config.node_bindings || "{}");
  } catch {
    /* Server validation reports malformed imported data. */
  }
  const keys = Array.from(
    new Set([
      ...Object.keys(bindings),
      ...(history.data?.nodes.map((node) => node.key) || []),
    ]),
  ).sort();
  function bind(key: string, id: string) {
    const next = { ...bindings };
    if (id) next[key] = id;
    else delete next[key];
    onChange(
      "node_bindings",
      Object.keys(next).length ? JSON.stringify(next) : "",
    );
  }
  const options = resources.data || [];
  return (
    <section
      className="connection-bindings"
      aria-label="Связи устройств с каталогом"
    >
      <h3>
        <Database size={17} />
        Ресурсы каталога
      </h3>
      {resources.error && (
        <ErrorBox
          error={resources.error}
          retry={() => void resources.refetch()}
        />
      )}
      {keys.map((key) => (
        <div className="connection-binding" key={key}>
          <span>{key}</span>
          <select
            aria-label={"Ресурс для " + key}
            value={bindings[key] || ""}
            onChange={(e) => bind(key, e.target.value)}
          >
            <option value="">Не связан</option>
            {bindings[key] &&
              !options.some((resource) => resource.id === bindings[key]) && (
                <option value={bindings[key]}>Ресурс недоступен</option>
              )}
            {options.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
          {bindings[key] && (
            <Button
              size="icon"
              variant="ghost"
              type="button"
              aria-label={"Убрать соответствие " + key}
              onClick={() => bind(key, "")}
            >
              <X size={14} />
            </Button>
          )}
        </div>
      ))}
      <div className="connection-binding-new">
        <label>
          Устройство в Oxidized
          <input
            aria-label="Устройство в Oxidized"
            placeholder="группа/имя"
            value={nodeKey}
            onChange={(e) => setNodeKey(e.target.value)}
          />
        </label>
        <label>
          Ресурс каталога
          <select
            aria-label="Ресурс каталога"
            value={resourceID}
            onChange={(e) => setResourceID(e.target.value)}
          >
            <option value="">Выберите ресурс</option>
            {options.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          disabled={
            !nodeKey.trim() ||
            !resourceID ||
            Object.keys(bindings).length >= 100
          }
          onClick={() => {
            bind(nodeKey.trim(), resourceID);
            setNodeKey("");
            setResourceID("");
          }}
        >
          Добавить соответствие
        </Button>
      </div>
    </section>
  );
}
