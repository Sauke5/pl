import { RefreshCw } from "lucide-react";
import { APIError, useAPI } from "./api";
import type { Session } from "./types";
import { Badge, Empty, ErrorBox } from "./components/common";
import { Button } from "./components/ui/button";

type LocalInstance = { instance_id: string; name: string; state: string };
type LocalStatus = {
  state?: string;
  version?: string;
  configuration?: { listen_ip: string; port: number };
};
const states: Record<string, string> = {
  running: "Работает",
  pending: "Выполняется операция",
  disabled: "Отключён",
  unavailable: "Недоступен",
  error: "Ошибка",
  removing: "Удаляется",
  absent: "Не установлен",
};

export function SFTPGoSystemSummary({
  hasExternalServiceMetric,
}: {
  hasExternalServiceMetric: boolean;
}) {
  const session = useAPI<Session>("/session");
  return session.data?.user?.admin ? (
    <LocalSummary hasExternalServiceMetric={hasExternalServiceMetric} />
  ) : null;
}

function LocalSummary({
  hasExternalServiceMetric,
}: {
  hasExternalServiceMetric: boolean;
}) {
  const discovery = useAPI<LocalInstance>("/sftpgo");
  const instance = discovery.data;
  const canCheck = !discovery.error && instance?.state === "running";
  const status = useAPI<LocalStatus>(
    `/modules/${encodeURIComponent(instance?.instance_id || "")}/sftpgo/status`,
    canCheck,
  );
  const missing =
    discovery.error instanceof APIError &&
    discovery.error.status === 404 &&
    discovery.error.code === "module_not_installed";
  const state = canCheck ? status.data?.state : instance?.state;
  const label =
    canCheck && status.error
      ? "Состояние не подтверждено"
      : canCheck && status.isPending
        ? "Проверяем состояние…"
        : states[state || ""] || "Состояние не подтверждено";
  return (
    <section className="connection-detail" aria-label="Локальный SFTPGo">
      <div className="settings-heading">
        <div>
          <span className="settings-eyebrow">Локальный модуль</span>
          <h2>Файловый сервер SFTPGo</h2>
        </div>
        {instance && !discovery.error && (
          <a
            className="connection-inline-link"
            href={`#modules?instance=${encodeURIComponent(instance.instance_id)}&view=sftpgo`}
          >
            Управление SFTPGo
          </a>
        )}
      </div>
      {missing ? (
        <>
          <Empty
            title="SFTPGo не установлен"
            detail="Установите файловый сервер из каталога модулей."
          />
          <a className="connection-inline-link" href="#module-catalog">
            Открыть каталог модулей
          </a>
        </>
      ) : discovery.error ? (
        <ErrorBox
          error={discovery.error}
          retry={() => void discovery.refetch()}
        />
      ) : discovery.isPending ? (
        <p role="status">Ищем локальный SFTPGo…</p>
      ) : (
        <>
          <div className="connection-detail-status">
            <Badge
              value={
                status.error
                  ? "warning"
                  : state === "running"
                    ? "ok"
                    : "unknown"
              }
            >
              {label}
            </Badge>
            <span>{instance?.name}</span>
            {canCheck && !status.error && status.data?.version && (
              <span>Версия {status.data.version}</span>
            )}
            {canCheck && !status.error && status.data?.configuration && (
              <span>
                SFTP: {status.data.configuration.listen_ip}:
                {status.data.configuration.port}
              </span>
            )}
            <Button
              size="sm"
              disabled={discovery.isFetching || (canCheck && status.isFetching)}
              onClick={() => {
                void discovery.refetch();
                if (canCheck) void status.refetch();
              }}
            >
              <RefreshCw size={14} /> Обновить
            </Button>
          </div>
          {canCheck && status.error && (
            <ErrorBox
              error={status.error}
              retry={() => void status.refetch()}
            />
          )}
        </>
      )}
      {hasExternalServiceMetric && (
        <p className="muted">
          Показатель службы systemd ниже относится к выбранному серверу.
          Состояние локального модуля показано отдельно.
        </p>
      )}
    </section>
  );
}
