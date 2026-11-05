import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { api, date, errorText, queryClient } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Badge, ErrorBox, Panel } from "./components/common";
import { withSettingsNavigation } from "./settings/navigation";
import { ReleaseNotesArticle, type ReleaseNotes } from "./ReleaseNotes";

export type Delivery = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  checked_at?: string;
  error?: string;
  core_api: number;
  modules: { module_id: string; version: string }[];
  release_notes?: ReleaseNotes;
  operation?: {
    kind?: string;
    operation_id: string;
    version: string;
    phase: string;
    error?: string;
    started_at?: string;
    finished_at?: string;
  };
};
const terminal = new Set([
  "complete",
  "completed",
  "succeeded",
  "failed",
  "rolled_back",
  "recovery_required",
]);
const phases: Record<string, string> = {
  complete: "Обновление завершено",
  queued: "Обновление запланировано",
  downloading: "Загрузка поставки",
  validating: "Проверка поставки",
  preparing: "Подготовка обновления",
  preparing_host: "Подготовка компонентов диагностики",
  quiescing: "Подготовка резервной копии",
  snapshot: "Резервная копия установки",
  verifying_host: "Проверка служб установки",
  restoring: "Восстановление предыдущей версии",
  backing_up: "Резервная копия установки",
  snapshotting: "Резервная копия установки",
  stopping: "Остановка сервисов",
  applying: "Применение версии",
  starting: "Запуск сервисов",
  verifying: "Проверка новой версии",
  completed: "Обновление завершено",
  succeeded: "Обновление завершено",
  failed: "Обновление не применено",
  rolling_back: "Восстановление предыдущей версии",
  rolled_back: "Предыдущая версия восстановлена",
  recovery_required: "Требуется восстановление установки",
};
const configurationPhases: Record<string, string> = {
  complete: "Параметры применены",
  failed: "Параметры не применены",
  rolled_back: "Предыдущие параметры восстановлены",
  recovery_required: phases.recovery_required,
};
function useDelivery(enabled = true) {
  return useQuery({
    queryKey: ["/delivery"],
    queryFn: () => api<Delivery>("/delivery"),
    enabled,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.operation && !terminal.has(q.state.data.operation.phase)
        ? 2500
        : 60000,
  });
}
export function UpdateNotification({ enabled }: { enabled: boolean }) {
  const status = useDelivery(enabled);
  if (!status.data?.update_available) return null;
  return (
    <Button
      variant="ghost"
      aria-label={`PL ${status.data.latest_version}`}
      title={`Доступна PL ${status.data.latest_version}`}
      onClick={() =>
        withSettingsNavigation(() => {
          location.hash = "settings?section=operations";
        })
      }
    >
      <Download size={17} />
      <span className="update-notification-copy">
        <span>PL {status.data.latest_version}</span>
        {status.data.release_notes?.version === status.data.latest_version && (
          <small>{status.data.release_notes.title}</small>
        )}
      </span>
    </Button>
  );
}
export function UpdateSettings() {
  const status = useDelivery();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  const operationID = useRef<string | undefined>(undefined);
  const lastVersion = useRef<string | undefined>(undefined);
  const value = status.data;
  const running = !!value?.operation && !terminal.has(value.operation.phase);
  useEffect(() => {
    if (!value?.current_version) return;
    if (lastVersion.current && lastVersion.current !== value.current_version)
      location.reload();
    lastVersion.current = value.current_version;
  }, [value?.current_version]);
  async function check() {
    setBusy(true);
    setError(undefined);
    try {
      queryClient.setQueryData(
        ["/delivery"],
        await api<Delivery>("/delivery/check", "POST", {}),
      );
      await queryClient.invalidateQueries({ queryKey: ["/modules/catalog"] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function upgrade() {
    if (!value?.latest_version || running) return;
    setBusy(true);
    setError(undefined);
    // Preserve the idempotency key after a lost response; status determines outcome.
    operationID.current ||= crypto.randomUUID();
    try {
      queryClient.setQueryData(
        ["/delivery"],
        await api<Delivery>("/delivery/upgrade", "POST", {
          version: value.latest_version,
          operation_id: operationID.current,
        }),
      );
      setConfirm(false);
    } catch (e) {
      setError(e);
      const observed = await status.refetch();
      if (observed.data?.operation?.operation_id === operationID.current)
        setConfirm(false);
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    if (!value?.operation || value.operation.phase !== "recovery_required")
      return;
    setBusy(true);
    setError(undefined);
    try {
      queryClient.setQueryData(
        ["/delivery"],
        await api<Delivery>("/delivery/recover", "POST", {
          operation_id: value.operation.operation_id,
        }),
      );
    } catch (e) {
      setError(e);
      await status.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Версия и обновления PL" icon={<Download size={20} />}>
      {value ? (
        <>
          <div className="release-version-summary">
            <div>
              <span
                className={
                  value.update_available ? "release-update-available" : ""
                }
              >
                {value.update_available
                  ? "Доступно обновление"
                  : "Текущий релиз"}
              </span>
              <strong>
                PL{" "}
                {value.latest_version || value.current_version || "Нет данных"}
              </strong>
            </div>
            <span className="muted">
              Установленная версия: {value.current_version || "Нет данных"}
            </span>
          </div>
          {value.release_notes &&
          value.release_notes.version === value.latest_version ? (
            <ReleaseNotesArticle notes={value.release_notes} />
          ) : value.update_available ? (
            <p className="muted">
              Подробное описание этого релиза ещё не опубликовано.
            </p>
          ) : null}
          {value.checked_at && (
            <p className="muted">
              Последняя проверка: {date(value.checked_at)}
            </p>
          )}
          {value.error && <ErrorBox error={new Error(value.error)} />}
          {value.operation && (
            <div role="status" aria-live="polite">
              <Badge
                value={
                  value.operation.kind === "configuration"
                    ? configurationPhases[value.operation.phase] ||
                      "Применение параметров установки"
                    : phases[value.operation.phase] || "Операция обновления"
                }
              />
              <p>
                {value.operation.kind === "configuration"
                  ? "Параметры развёртывания PL"
                  : `PL ${value.operation.version}`}
              </p>
              {value.operation.error && (
                <ErrorBox error={new Error(value.operation.error)} />
              )}
            </div>
          )}
        </>
      ) : status.error ? (
        <ErrorBox error={status.error} />
      ) : (
        <p className="muted">Получаем состояние установки…</p>
      )}
      {!!error && <ErrorBox error={error} />}
      <div className="actions">
        <Button
          variant="secondary"
          disabled={busy || running}
          onClick={() => void check()}
        >
          <RefreshCw size={16} />
          Проверить обновления
        </Button>
        {value?.operation?.phase === "recovery_required" && (
          <Button disabled={busy} onClick={() => void recover()}>
            Восстановить предыдущую версию
          </Button>
        )}
        {value?.update_available && (
          <Button
            disabled={
              busy || running || value.operation?.phase === "recovery_required"
            }
            onClick={() => {
              operationID.current = undefined;
              setConfirm(true);
            }}
          >
            <Download size={16} />
            Обновить до {value.latest_version}
          </Button>
        )}
      </div>
      <p>
        <Button
          variant="ghost"
          onClick={() =>
            withSettingsNavigation(() => {
              location.hash = "settings?section=delivery";
            })
          }
        >
          Настроить доступ к GitHub
        </Button>
      </p>
      {confirm && (
        <Dialog
          title={`Обновление PL до ${value?.latest_version || ""}`}
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            PL сохранит резервную копию данных core и установленных модулей,
            затем применит новую версию. Во время обновления платформа и
            локальные модули будут временно недоступны.
          </p>
          <p>
            При неудачной проверке будет восстановлена предыдущая версия вместе
            с данными.
          </p>
          {!!error && <p role="alert">{errorText(error)}</p>}
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Отмена
            </Button>
            <Button disabled={busy} onClick={() => void upgrade()}>
              {busy ? "Запуск обновления…" : "Установить обновление"}
            </Button>
          </div>
        </Dialog>
      )}
    </Panel>
  );
}
