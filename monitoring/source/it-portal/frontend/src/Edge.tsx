import { APIError, date, useAPI } from "./api";
import { Badge, Empty, ErrorBox, Panel } from "./components/common";
import { Button } from "./components/ui/button";
type EdgeStatus = {
  configured: boolean;
  state: "running" | "stop" | "error";
  version?: string;
  observed_at: string;
};
export default function Edge() {
  const status = useAPI<EdgeStatus>("/edge/status");
  const disabled =
    status.error instanceof APIError && status.error.code === "edge_disabled";
  const data = status.isError ? undefined : status.data;
  const labels = {
    running: "Запущен",
    stop: "Остановлен",
    error: "Ошибка Xray",
  };
  return (
    <Panel
      title="Edge"
      action={
        <Button
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          {status.isFetching ? "Обновление…" : "Обновить"}
        </Button>
      }
    >
      <p className="muted">Состояние Xray по данным панели 3x-ui.</p>
      {status.isPending && <p role="status">Получаем состояние Edge…</p>}
      {disabled && (
        <Empty
          title="Edge не подключён"
          detail="Администратор должен настроить источник состояния на сервере Платформы."
        />
      )}
      {status.isError && !disabled && (
        <ErrorBox error={status.error} retry={() => void status.refetch()} />
      )}
      {data && (
        <table>
          <tbody>
            <tr>
              <td>Xray</td>
              <td>
                <Badge
                  value={
                    data.state === "running"
                      ? "healthy"
                      : data.state === "stop"
                        ? "warning"
                        : "critical"
                  }
                >
                  {labels[data.state] || "Нет данных"}
                </Badge>
              </td>
            </tr>
            <tr>
              <td>Версия Xray</td>
              <td>{data.version || "Нет данных"}</td>
            </tr>
            <tr>
              <td>Получено Платформой</td>
              <td>
                {Number.isFinite(Date.parse(data.observed_at))
                  ? date(data.observed_at)
                  : "Нет данных"}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}
