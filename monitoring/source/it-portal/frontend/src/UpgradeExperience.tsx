import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { api } from "./api";
import type { Session } from "./types";
import { Brand } from "./AuthScenes";
import { ThemeToggle } from "./Theme";
import { Button } from "./components/ui/button";
import "./upgrade-experience.css";

export type UpgradeOperation = {
  operation_id: string;
  kind?: string;
  module_id?: string;
  recovery_mode?: "resume" | "rollback";
  restored_snapshot?: boolean;
  version: string;
  phase: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
};
export type PublicUpgradeStatus = {
  active: boolean;
  ready: boolean;
  current_version: string;
  operation?: UpgradeOperation;
};
type Receipt = { operation: UpgradeOperation; confirmedAt: number };
const key = "pl.confirmed-upgrade";
const changed = "pl:confirmed-upgrade";
const checkStatus = "pl:check-upgrade-status";
const lifetime = 2 * 60 * 60_000;
const success = new Set(["complete", "completed", "succeeded"]);
const failures = new Set(["failed", "rolled_back", "recovery_required"]);
export function upgradeModuleName(id?: string) {
  const names: Record<string, string> = {
    prometheus: "Prometheus",
    alertmanager: "Alertmanager",
    grafana: "Grafana",
    bookstack: "Wiki",
    netmap: "NetMap",
    doska: "Doska",
    forms: "Forms",
    wayline: "Wayline",
    sftpgo: "SFTPGo",
    xray: "Xray",
    mailcow: "Mailcow",
  };
  return id && Object.hasOwn(names, id) ? names[id] : id || "модуль";
}
const stages: Record<string, string> = {
  queued: "Готовим обновление",
  queued_recovery: "Восстанавливаем предыдущую версию",
  downloading: "Загружаем новую версию",
  validating: "Проверяем поставку",
  preparing: "Готовим установку",
  preparing_host: "Готовим компоненты Платформы",
  verifying_host: "Проверяем службы установки",
  quiescing: "Готовим резервную копию",
  snapshot: "Создаём резервную копию",
  backing_up: "Создаём резервную копию",
  snapshotting: "Создаём резервную копию",
  stopping: "Останавливаем службы",
  applying: "Устанавливаем новую версию",
  starting: "Запускаем Платформу",
  resuming: "Запускаем модули",
  reconciling: "Обновляем состояние модулей",
  verifying: "Проверяем готовность",
  rolling_back: "Восстанавливаем предыдущую версию",
  restoring: "Восстанавливаем предыдущую версию",
  complete: "Обновление установлено",
  completed: "Обновление установлено",
  succeeded: "Обновление установлено",
};
function validOperation(value: unknown): value is UpgradeOperation {
  if (!value || typeof value !== "object") return false;
  const op = value as UpgradeOperation;
  return (
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(op.operation_id) &&
    typeof op.version === "string" &&
    op.version.length > 0 &&
    op.version.length <= 100 &&
    typeof op.phase === "string" &&
    op.phase.length > 0 &&
    op.phase.length <= 64 &&
    (op.error === undefined ||
      (typeof op.error === "string" && op.error.length <= 4000)) &&
    (op.recovery_mode === undefined ||
      op.recovery_mode === "resume" ||
      op.recovery_mode === "rollback") &&
    (op.restored_snapshot === undefined ||
      typeof op.restored_snapshot === "boolean") &&
    (!op.kind ||
      op.kind === "upgrade" ||
      (op.kind === "module_upgrade" &&
        typeof op.module_id === "string" &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(op.module_id)))
  );
}
function storedReceipt(): Receipt | undefined {
  try {
    const value = JSON.parse(
      localStorage.getItem(key) || "null",
    ) as Receipt | null;
    if (
      value &&
      validOperation(value.operation) &&
      Number.isFinite(value.confirmedAt) &&
      Date.now() - value.confirmedAt < lifetime &&
      value.confirmedAt <= Date.now() + 5000
    )
      return value;
    localStorage.removeItem(key);
  } catch {
    /* Storage is optional. Public status remains authoritative. */
  }
}
export function rememberUpgrade(operation?: UpgradeOperation) {
  if (
    !validOperation(operation) ||
    success.has(operation.phase) ||
    failures.has(operation.phase)
  )
    return;
  const receipt = { operation, confirmedAt: Date.now() };
  try {
    localStorage.setItem(key, JSON.stringify(receipt));
  } catch {
    /* optional */
  }
  window.dispatchEvent(new CustomEvent(changed, { detail: receipt }));
}
export function requestUpgradeStatus() {
  window.dispatchEvent(new Event(checkStatus));
}
function forgetUpgrade() {
  try {
    localStorage.removeItem(key);
  } catch {
    /* optional */
  }
}
function recoveryAdmin(session: Session) {
  return (
    session.authenticated === true &&
    session.user?.admin === true &&
    typeof session.csrf_token === "string" &&
    session.csrf_token.length > 0
  );
}

export function UpgradeScreen({
  operation,
  unavailable,
  ready,
  checking,
  retry,
  returnToPlatform,
  recoveryAccess,
  recovering,
  recoveryError,
  recover,
}: {
  operation: UpgradeOperation;
  unavailable: boolean;
  ready: boolean;
  checking: boolean;
  retry: () => void;
  returnToPlatform: () => void;
  recoveryAccess: "checking" | "admin" | "other" | "unavailable";
  recovering: boolean;
  recoveryError?: string;
  recover: () => void;
}) {
  const failed = failures.has(operation.phase);
  const done = success.has(operation.phase);
  const resume =
    operation.phase === "recovery_required" &&
    operation.recovery_mode === "resume";
  const restoredSnapshot =
    operation.recovery_mode === "resume" &&
    operation.restored_snapshot === true;
  const restoredResume = resume && restoredSnapshot;
  const moduleName =
    operation.kind === "module_upgrade"
      ? upgradeModuleName(operation.module_id)
      : undefined;
  const stageLabel =
    operation.phase === "queued_recovery" &&
    operation.recovery_mode === "resume"
      ? "Готовим запуск модулей"
      : stages[operation.phase];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const title = resume
    ? restoredResume
      ? "Предыдущая версия восстановлена"
      : moduleName
        ? `Поставка ${moduleName} установлена`
        : "Версия установлена"
    : failed
      ? operation.phase === "rolled_back"
        ? moduleName
          ? `Предыдущая поставка ${moduleName} восстановлена`
          : "Предыдущая версия восстановлена"
        : moduleName
          ? `Обновление ${moduleName} не завершено`
          : "Обновление не завершено"
      : unavailable
        ? "Ожидаем подключения к PL"
        : moduleName
          ? `Обновляем ${moduleName}`
          : "Платформа обновляется";
  return (
    <div className="upgrade-scene">
      <header className="upgrade-scene-header">
        <Brand />
        <ThemeToggle />
      </header>
      <main className="upgrade-scene-main">
        <section className="upgrade-card" aria-labelledby="upgrade-title">
          <div
            className={`upgrade-symbol ${failed || unavailable ? "upgrade-symbol-warning" : ""}`}
            aria-hidden="true"
          >
            {failed || unavailable ? (
              <AlertTriangle size={32} strokeWidth={1.5} />
            ) : done ? (
              <Check size={32} />
            ) : (
              <RefreshCw size={32} strokeWidth={1.5} />
            )}
          </div>
          <p className="upgrade-eyebrow">
            {restoredSnapshot
              ? "Завершение восстановления PL"
              : moduleName
                ? `Обновление модуля · PL ${operation.version}`
                : `Обновление до PL ${operation.version}`}
          </p>
          <h1 id="upgrade-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <p className="upgrade-description">
            {resume
              ? restoredResume
                ? "Данные восстановлены. Нужно завершить запуск модулей."
                : "Нужно завершить запуск модулей. Продолжение использует текущую версию и текущие данные установки."
              : failed
                ? operation.phase === "rolled_back"
                  ? moduleName
                    ? "Новая поставка не прошла проверку. Установка восстановлена из резервной копии."
                    : "Новая версия не прошла проверку. PL вернулась к сохранённой версии."
                  : "Автоматическое обновление остановлено. Проверьте состояние установки перед повторной попыткой."
                : unavailable
                  ? "Обновление было принято, но сейчас не удаётся получить его состояние. Проверяем связь автоматически."
                  : "Платформа и локальные модули временно недоступны. Страница откроется автоматически, когда проверка готовности завершится."}
          </p>
          <div
            className="upgrade-stage"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span
              className={`upgrade-stage-dot ${failed || unavailable ? "paused" : ""}`}
            />
            <div>
              <strong>
                {resume
                  ? "Нужно завершить запуск модулей"
                  : failed
                    ? "Обновление остановлено"
                    : unavailable
                      ? "Последний подтверждённый этап"
                      : stageLabel || "Получаем состояние обновления"}
              </strong>
              <p>
                {failed
                  ? operation.error ||
                    "Подробности доступны в настройках обновления."
                  : unavailable
                    ? stageLabel || "Операция принята"
                    : done
                      ? "Проверяем подключение к Платформе…"
                      : "Этап выполняется. Обновлять страницу не нужно."}
              </p>
            </div>
          </div>
          {(failed || unavailable) && (
            <div className="upgrade-actions">
              <Button variant="secondary" disabled={checking} onClick={retry}>
                <RefreshCw size={16} />
                {checking ? "Проверяем…" : "Проверить связь"}
              </Button>
              {failed && ready && (
                <Button onClick={returnToPlatform}>
                  Вернуться в Платформу
                </Button>
              )}
              {operation.phase === "recovery_required" &&
                recoveryAccess === "admin" && (
                  <Button disabled={recovering} onClick={recover}>
                    {recovering
                      ? "Запускаем восстановление…"
                      : resume
                        ? "Завершить запуск модулей"
                        : "Восстановить установку"}
                  </Button>
                )}
            </div>
          )}
          {operation.phase === "recovery_required" &&
            recoveryAccess !== "admin" && (
              <p className="upgrade-access-note">
                {recoveryAccess === "checking"
                  ? "Проверяем доступ администратора…"
                  : recoveryAccess === "unavailable"
                    ? "Не удалось проверить доступ. Для продолжения восстановления нужен администратор PL."
                    : "Продолжить восстановление может администратор PL."}
              </p>
            )}
          {recoveryError && (
            <p className="upgrade-recovery-error" role="alert">
              {recoveryError}
            </p>
          )}
          <p className="upgrade-reference">
            Операция <span>{operation.operation_id}</span>
          </p>
        </section>
        <p className="upgrade-footnote">Можно оставить эту вкладку открытой</p>
      </main>
    </div>
  );
}

export function UpgradeBoundary({ children }: { children: ReactNode }) {
  const initial = useRef(storedReceipt());
  const [receipt, setReceipt] = useState<Receipt | undefined>(initial.current);
  const [unavailable, setUnavailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [recoveryAccess, setRecoveryAccess] = useState<
    "checking" | "admin" | "other" | "unavailable"
  >("checking");
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  const pollRef = useRef<() => void>(() => {});
  const returnRef = useRef<() => void>(() => {});
  const recoverRef = useRef<() => void>(() => {});
  useEffect(() => {
    let current = initial.current;
    let stopped = false;
    let inFlight = false;
    let checkAgain = false;
    let recoveringNow = false;
    let recoveryConfirmed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const returnToPlatform = async () => {
      setChecking(true);
      const sessionController = new AbortController();
      const sessionTimeout = window.setTimeout(
        () => sessionController.abort(),
        4000,
      );
      try {
        const session = await api<Session>(
          "/session",
          "GET",
          undefined,
          {},
          sessionController.signal,
        );
        if (typeof session.authenticated !== "boolean")
          throw new Error("Invalid session response");
        if (stopped) return;
        forgetUpgrade();
        location.reload();
      } catch {
        if (!stopped) {
          setUnavailable(true);
          setChecking(false);
        }
      } finally {
        clearTimeout(sessionTimeout);
      }
    };
    returnRef.current = () => void returnToPlatform();
    recoverRef.current = () =>
      void (async () => {
        const op = current?.operation;
        if (
          recoveringNow ||
          !recoveryConfirmed ||
          op?.phase !== "recovery_required"
        )
          return;
        recoveringNow = true;
        setRecovering(true);
        setRecoveryError(undefined);
        const recoverController = new AbortController();
        const recoverTimeout = window.setTimeout(
          () => recoverController.abort(),
          10000,
        );
        try {
          const session = await api<Session>(
            "/session",
            "GET",
            undefined,
            {},
            recoverController.signal,
          );
          if (!recoveryAdmin(session)) {
            setRecoveryAccess("other");
            return;
          }
          if (
            stopped ||
            !recoveryConfirmed ||
            current?.operation.operation_id !== op.operation_id ||
            current.operation.phase !== "recovery_required"
          )
            return;
          await api(
            "/delivery/recover",
            "POST",
            { operation_id: op.operation_id },
            { "X-CSRF-Token": session.csrf_token as string },
            recoverController.signal,
          );
          if (stopped) return;
          rememberUpgrade({
            ...op,
            phase: "queued_recovery",
            error: undefined,
          });
        } catch {
          if (!stopped) {
            setRecoveryError(
              "Не удалось подтвердить запуск восстановления. Проверьте связь и состояние операции.",
            );
            requestUpgradeStatus();
          }
        } finally {
          clearTimeout(recoverTimeout);
          recoveringNow = false;
          if (!stopped) setRecovering(false);
        }
      })();
    const poll = async () => {
      if (stopped || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      setChecking(true);
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 4000);
      try {
        const value = await api<PublicUpgradeStatus>(
          "/upgrade-status",
          "GET",
          undefined,
          { "Cache-Control": "no-cache" },
          controller.signal,
        );
        if (
          typeof value.active !== "boolean" ||
          typeof value.ready !== "boolean" ||
          typeof value.current_version !== "string"
        )
          throw new Error("Invalid public status");
        if (stopped) return;
        const op = value.operation;
        recoveryConfirmed =
          validOperation(op) &&
          op.phase === "recovery_required" &&
          (value.active || current?.operation.operation_id === op.operation_id);
        if (recoveryConfirmed) {
          current = { operation: op!, confirmedAt: Date.now() };
          setReceipt(current);
          setReady(value.ready);
          setUnavailable(false);
          try {
            const session = await api<Session>(
              "/session",
              "GET",
              undefined,
              {},
              controller.signal,
            );
            if (!stopped)
              setRecoveryAccess(recoveryAdmin(session) ? "admin" : "other");
          } catch {
            if (!stopped) setRecoveryAccess("unavailable");
          }
        } else {
          setRecoveryAccess("checking");
          if (validOperation(op) && op.phase !== "recovery_required")
            setRecoveryError(undefined);
        }
        if (stopped) return;
        if (validOperation(op) && value.active && !success.has(op.phase)) {
          current = { operation: op, confirmedAt: Date.now() };
          try {
            localStorage.setItem(key, JSON.stringify(current));
          } catch {
            /* optional */
          }
          setReceipt(current);
          setUnavailable(!stages[op.phase] && !failures.has(op.phase));
          setReady(value.ready);
        } else if (
          validOperation(op) &&
          current?.operation.operation_id === op.operation_id
        ) {
          current = { operation: op, confirmedAt: Date.now() };
          setReceipt(current);
          setReady(value.ready);
          setUnavailable(false);
          if (
            success.has(op.phase) &&
            value.ready &&
            value.current_version === op.version
          )
            await returnToPlatform();
        } else if (current) {
          setUnavailable(true);
        }
      } catch {
        recoveryConfirmed = false;
        if (!stopped) setRecoveryAccess("unavailable");
        if (!stopped && current && Date.now() - current.confirmedAt >= 15_000)
          setUnavailable(true);
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        if (!stopped) {
          setChecking(false);
          timer = setTimeout(
            () => void poll(),
            checkAgain ? 0 : current ? 2000 : 15000,
          );
          checkAgain = false;
        }
      }
    };
    const checkNow = () => {
      if (inFlight) checkAgain = true;
      else void poll();
    };
    pollRef.current = checkNow;
    const accepted = (event: Event) => {
      const next =
        event instanceof CustomEvent
          ? (event.detail as Receipt)
          : storedReceipt();
      if (!next || !validOperation(next.operation)) return;
      current = next;
      setReceipt(next);
      setUnavailable(false);
      checkNow();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === key && event.newValue) accepted(event);
    };
    window.addEventListener(changed, accepted);
    window.addEventListener("storage", storage);
    window.addEventListener(checkStatus, checkNow);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener(changed, accepted);
      window.removeEventListener("storage", storage);
      window.removeEventListener(checkStatus, checkNow);
    };
  }, []);
  return receipt ? (
    <UpgradeScreen
      operation={receipt.operation}
      unavailable={unavailable}
      ready={ready}
      checking={checking}
      retry={() => pollRef.current()}
      returnToPlatform={() => returnRef.current()}
      recoveryAccess={recoveryAccess}
      recovering={recovering}
      recoveryError={recoveryError}
      recover={() => recoverRef.current()}
    />
  ) : (
    children
  );
}
