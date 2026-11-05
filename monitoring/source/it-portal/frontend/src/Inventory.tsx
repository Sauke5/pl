import { useAPI, date } from "./api";
import type { InventoryObject, InventorySource } from "./types";
import { Badge, ErrorBox, ExternalLink } from "./components/common";

export function InventorySummary({
  inventory: v,
}: {
  inventory?: InventoryObject;
}) {
  if (!v) return null;
  return (
    <small className="muted break">
      {[
        v.kind === "virtual_machine" ? "Виртуальная машина" : "Устройство",
        v.site,
        v.role,
        v.primary_ip,
      ]
        .filter(Boolean)
        .join(" · ")}
    </small>
  );
}

export function ResourceInventory({ resourceID }: { resourceID: string }) {
  const data = useAPI<{ sources: InventorySource[] }>(
    `/resources/${resourceID}/inventory`,
  );
  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data?.sources.length) return null;
  return (
    <section className="resource-inventory">
      <h3>Данные подключённых систем</h3>
      {data.data.sources.map((s) => (
        <details
          className="inventory-source"
          key={s.candidate_id}
          open={!!s.inventory}
        >
          <summary>
            <strong>{s.integration_name}</strong>
            <span>{s.name}</span>
            <Badge value={s.stale ? "warning" : "info"}>
              {s.stale ? "Данные устарели" : "Получено " + date(s.last_seen)}
            </Badge>
          </summary>
          {s.inventory ? (
            <>
              <InventorySummary inventory={s.inventory} />
              <dl className="detail-grid">
                <div>
                  <dt>Платформа</dt>
                  <dd>{s.inventory.platform || "—"}</dd>
                </div>
                <div>
                  <dt>Статус в NetBox</dt>
                  <dd>{s.inventory.status || "—"}</dd>
                </div>
              </dl>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Адрес</th>
                      <th>Интерфейс</th>
                      <th>VRF</th>
                      <th>Назначение</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.inventory.addresses.map((a, n) => (
                      <tr key={n}>
                        <td>{a.address}</td>
                        <td>{a.interface_name || "—"}</td>
                        <td>
                          {a.vrf_name ||
                            (a.vrf_id === null
                              ? "Общая таблица"
                              : String(a.vrf_id))}
                        </td>
                        <td>
                          {a.management_only
                            ? "BMC / управление"
                            : "Рабочий адрес"}
                          {a.observed_only
                            ? " · обнаружен, маска не указана"
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ExternalLink url={s.inventory.netbox_url}>
                Открыть запись NetBox
              </ExternalLink>
              <p className="muted">
                Статус учёта в NetBox не показывает доступность узла. Ручные
                поля карточки сохраняются отдельно.
              </p>
            </>
          ) : (
            <>
              <p className="break">
                {s.labels.job && (
                  <>
                    Job: <strong>{s.labels.job}</strong> ·{" "}
                  </>
                )}
                {s.labels.instance || s.name}
              </p>
              {s.observation && (
                <p>
                  <Badge
                    value={
                      s.stale
                        ? "unknown"
                        : s.observation.health === "up"
                          ? "success"
                          : "warning"
                    }
                  >
                    {s.stale
                      ? "Доступность неизвестна"
                      : s.observation.health === "up"
                        ? "Метрики доступны"
                        : s.observation.health === "down"
                          ? "Метрики недоступны"
                          : "Нет результата проверки"}
                  </Badge>{" "}
                  <span className="muted">
                    {date(s.observation.last_scrape)}
                  </span>
                </p>
              )}
              <p className="muted break">{s.url}</p>
            </>
          )}
        </details>
      ))}
    </section>
  );
}
