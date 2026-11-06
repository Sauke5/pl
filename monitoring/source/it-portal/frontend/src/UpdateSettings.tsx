import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Download, RefreshCw, X } from "lucide-react";
import { api, date, errorText, queryClient } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Badge, ErrorBox, Panel } from "./components/common";
import { withSettingsNavigation } from "./settings/navigation";
import { ReleaseNotesArticle, type ReleaseNotes } from "./ReleaseNotes";
import "./upgrade-experience.css";
import { startUpdateBatch, useUpdateBatch } from "./UpdateBatch";
import {
  rememberUpgrade,
  requestUpgradeStatus,
  upgradeModuleName,
  type UpgradeOperation,
} from "./UpgradeExperience";

export type DeliveryModule = {
  module_id: string;
  version: string;
  installed?: boolean;
  installed_version?: string;
  update_available?: boolean;
  upgrade_supported?: boolean;
  artifact_sha256?: string;
  blocked_reason?: string;
};
function canUpgradeModule(module: DeliveryModule) {
  return (
    module.installed === true &&
    module.update_available === true &&
    module.upgrade_supported === true &&
    !module.blocked_reason &&
    /^[0-9a-f]{64}$/i.test(module.artifact_sha256 || "")
  );
}

export type Delivery = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  checked_at?: string;
  error?: string;
  core_api: number;
  modules: DeliveryModule[];
  release_notes?: ReleaseNotes;
  operation?: UpgradeOperation;
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
  resuming: "Запускаем модули",
  reconciling: "Обновляем состояние модулей",
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
export function useDelivery(enabled = true) {
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
const dismissedReleaseKey = "pl.release-dismissed";
export function ReleaseBanner({ enabled }: { enabled: boolean }) {
  const status = useDelivery(enabled);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissedReleaseKey);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === dismissedReleaseKey) setDismissed(event.newValue);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const value = status.data;
  if (
    !enabled ||
    !value?.update_available ||
    !value.latest_version ||
    dismissed === value.latest_version
  )
    return null;
  const notes =
    value.release_notes?.version === value.latest_version
      ? value.release_notes
      : undefined;
  const highlights = notes?.sections
    .flatMap((section) => section.items)
    .slice(0, 3);
  return (
    <section
      className="release-banner"
      aria-label={`Доступна PL ${value.latest_version}`}
    >
      <div className="release-banner-icon" aria-hidden="true">
        <Download size={25} />
      </div>
      <div className="release-banner-content">
        <p className="release-banner-eyebrow">
          Доступна PL {value.latest_version}
        </p>
        <h2>{notes?.title || "Новая версия Платформы"}</h2>
        {notes?.summary && (
          <p className="release-banner-summary">{notes.summary}</p>
        )}
        {!!highlights?.length && (
          <ul>
            {highlights.map((item, index) => (
              <li key={index}>
                <Check size={15} aria-hidden="true" />
                {item.title}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="release-banner-actions">
        <Button
          onClick={() =>
            withSettingsNavigation(() => {
              location.hash = "settings?section=updates";
            })
          }
        >
          Посмотреть обновление <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <span>Установка запускается вручную</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="release-banner-close"
        aria-label={`Скрыть уведомление о PL ${value.latest_version}`}
        onClick={() => {
          setDismissed(value.latest_version);
          try {
            localStorage.setItem(dismissedReleaseKey, value.latest_version);
          } catch {
            /* optional */
          }
        }}
      >
        <X size={18} />
      </Button>
    </section>
  );
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
          location.hash = "settings?section=updates";
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
  const [allConfirm, setAllConfirm] = useState(false);
  const batch = useUpdateBatch();
  const [moduleConfirm, setModuleConfirm] = useState<DeliveryModule>();
  const moduleOperationID = useRef<string | undefined>(undefined);
  const operationID = useRef<string | undefined>(undefined);
  const lastVersion = useRef<string | undefined>(undefined);
  const value = status.data;
  const batchRunning =
    !!batch &&
    !batch.error &&
    batch.steps.some(
      (step) => step.state === "pending" || step.state === "sent",
    );
  const running =
    batchRunning ||
    (!!value?.operation && !terminal.has(value.operation.phase));
  const resumeRequired =
    value?.operation?.phase === "recovery_required" &&
    value.operation.recovery_mode === "resume";
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
      const accepted = await api<Delivery>("/delivery/upgrade", "POST", {
        version: value.latest_version,
        operation_id: operationID.current,
      });
      queryClient.setQueryData(["/delivery"], accepted);
      if (accepted.operation?.operation_id === operationID.current)
        rememberUpgrade(accepted.operation);
      setConfirm(false);
    } catch (e) {
      setError(e);
      requestUpgradeStatus();
      const observed = await status.refetch();
      if (observed.data?.operation?.operation_id === operationID.current) {
        rememberUpgrade(observed.data.operation);
        setConfirm(false);
      }
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
      const accepted = await api<Delivery>("/delivery/recover", "POST", {
        operation_id: value.operation.operation_id,
      });
      queryClient.setQueryData(["/delivery"], accepted);
      rememberUpgrade(accepted.operation);
    } catch (e) {
      setError(e);
      await status.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function upgradeModule() {
    if (!moduleConfirm || !canUpgradeModule(moduleConfirm) || running) return;
    setBusy(true);
    setError(undefined);
    moduleOperationID.current ||= crypto.randomUUID();
    const matches = (operation?: UpgradeOperation) =>
      !!operation &&
      operation.operation_id === moduleOperationID.current &&
      operation.kind === "module_upgrade" &&
      operation.module_id === moduleConfirm.module_id;
    try {
      const accepted = await api<Delivery>("/delivery/module-upgrade", "POST", {
        operation_id: moduleOperationID.current,
        module_id: moduleConfirm.module_id,
        artifact_sha256: moduleConfirm.artifact_sha256,
      });
      queryClient.setQueryData(["/delivery"], accepted);
      if (!matches(accepted.operation))
        throw new Error(
          "Не удалось подтвердить запуск обновления модуля. Проверьте состояние операции.",
        );
      rememberUpgrade(accepted.operation);
      setModuleConfirm(undefined);
    } catch (e) {
      setError(e);
      requestUpgradeStatus();
      const observed = await status.refetch();
      if (matches(observed.data?.operation)) {
        rememberUpgrade(observed.data?.operation);
        setModuleConfirm(undefined);
      }
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
                    : resumeRequired
                      ? value.operation.restored_snapshot === true
                        ? "Данные восстановлены. Нужно завершить запуск модулей"
                        : "Версия установлена. Нужно завершить запуск модулей"
                      : value.operation.scope === "module" &&
                          value.operation.phase === "snapshot"
                        ? "Резервная копия модуля"
                        : phases[value.operation.phase] || "Операция обновления"
                }
              />
              <p>
                {value.operation.kind === "configuration"
                  ? "Параметры развёртывания PL"
                  : value.operation.kind === "module_upgrade"
                    ? `Обновление ${upgradeModuleName(value.operation.module_id)}`
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
        {value &&
          (value.update_available ||
            value.modules.some((m) => m.installed && m.update_available)) && (
            <Button
              disabled={
                busy ||
                running ||
                !!batch ||
                value.operation?.phase === "recovery_required"
              }
              onClick={() => setAllConfirm(true)}
            >
              Обновить всё
            </Button>
          )}
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
            {resumeRequired
              ? "Завершить запуск модулей"
              : "Восстановить предыдущую версию"}
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
      {value && (
        <section
          className="module-delivery"
          aria-labelledby="module-delivery-title"
        >
          <header>
            <div>
              <h3 id="module-delivery-title">Обновления модулей</h3>
              <p>Новые поставки для уже установленных локальных модулей.</p>
            </div>
            <Button
              variant="secondary"
              disabled={busy || running}
              onClick={() => void check()}
            >
              <RefreshCw size={16} />
              Проверить обновления модулей
            </Button>
          </header>
          {value.modules.some((module) => module.installed) ? (
            <ul className="module-delivery-list">
              {value.modules
                .filter((module) => module.installed)
                .map((module) => (
                  <li key={module.module_id}>
                    <div>
                      <strong>{upgradeModuleName(module.module_id)}</strong>
                      <p>
                        Установлено:{" "}
                        {module.installed_version || "Версия неизвестна"}
                        {module.update_available && (
                          <>
                            {" "}
                            ·{" "}
                            {module.installed_version === module.version
                              ? "Новая сборка"
                              : "Доступно"}
                            : {module.version}
                          </>
                        )}
                      </p>
                      {module.blocked_reason ? (
                        <p className="module-delivery-reason">
                          {module.blocked_reason}
                        </p>
                      ) : !module.upgrade_supported ? (
                        <p className="module-delivery-reason">
                          Обновление этой поставки пока не поддерживается.
                        </p>
                      ) : module.update_available &&
                        !canUpgradeModule(module) ? (
                        <p className="module-delivery-reason">
                          Не удалось подтвердить новую поставку. Проверьте
                          обновления ещё раз.
                        </p>
                      ) : !module.update_available ? (
                        <p className="module-delivery-reason">
                          Новая поставка не найдена.
                        </p>
                      ) : null}
                    </div>
                    {canUpgradeModule(module) && (
                      <Button
                        disabled={
                          busy ||
                          running ||
                          value.operation?.phase === "recovery_required"
                        }
                        onClick={() => {
                          moduleOperationID.current = undefined;
                          setError(undefined);
                          setModuleConfirm({ ...module });
                        }}
                      >
                        <Download size={16} />
                        Обновить {upgradeModuleName(module.module_id)}
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">
              Для этой установки нет сведений об обновлениях модулей.
            </p>
          )}
        </section>
      )}
      {allConfirm && value && (
        <Dialog
          title="Обновить Платформу и модули"
          onClose={() => {
            if (!busy) setAllConfirm(false);
          }}
        >
          <p>
            Сначала обновится PL, затем — установленные модули с доступной
            совместимой поставкой. Модули обновляются по одному; при ошибке
            очередь остановится.
          </p>
          <p>
            Оставьте вкладку открытой. После перезагрузки страницы очередь
            продолжится. Неподдерживаемые поставки будут показаны отдельно.
          </p>
          {!!error && <p role="alert">{errorText(error)}</p>}
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setAllConfirm(false)}
            >
              Отмена
            </Button>
            <Button
              disabled={busy || running}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void startUpdateBatch(value)
                  .then(() => setAllConfirm(false))
                  .catch(setError)
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Подготовка очереди…" : "Запустить обновления"}
            </Button>
          </div>
        </Dialog>
      )}
      {moduleConfirm && (
        <Dialog
          title={`Обновление ${upgradeModuleName(moduleConfirm.module_id)}`}
          onClose={() => {
            if (!busy) setModuleConfirm(undefined);
          }}
        >
          <p>
            Будут обновлены все локальные экземпляры{" "}
            {upgradeModuleName(moduleConfirm.module_id)}. Перед заменой поставки
            PL создаст полную резервную копию установки и данных модулей.
          </p>
          <p>
            Во время обновления PL и локальные модули будут недоступны. Версия
            PL {value?.current_version} останется прежней.
          </p>
          <dl className="module-delivery-confirm">
            <div>
              <dt>Установлено</dt>
              <dd>{moduleConfirm.installed_version || "Версия неизвестна"}</dd>
            </div>
            <div>
              <dt>Новая поставка</dt>
              <dd>
                {moduleConfirm.version}
                {moduleConfirm.installed_version === moduleConfirm.version
                  ? " · новая сборка"
                  : ""}
              </dd>
            </div>
          </dl>
          <details className="module-delivery-artifact">
            <summary>Идентификатор поставки</summary>
            <code>SHA-256 {moduleConfirm.artifact_sha256}</code>
          </details>
          {!!error && <p role="alert">{errorText(error)}</p>}
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setModuleConfirm(undefined)}
            >
              Отмена
            </Button>
            <Button
              disabled={busy || running}
              onClick={() => void upgradeModule()}
            >
              {busy ? "Запуск обновления…" : "Обновить модуль"}
            </Button>
          </div>
        </Dialog>
      )}
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
