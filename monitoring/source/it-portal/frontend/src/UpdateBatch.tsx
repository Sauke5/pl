import { useEffect, useState } from "react";
import { api, APIError, errorText } from "./api";
import type { Session } from "./types";
import type { Delivery } from "./UpdateSettings";
import { rememberUpgrade, upgradeModuleName } from "./UpgradeExperience";
import { Button } from "./components/ui/button";

const key = "pl.update-batch.v1",
  event = "pl:update-batch",
  lock = "pl:update-batch";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const version = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const modules = new Set([
  "prometheus",
  "alertmanager",
  "grafana",
  "bookstack",
  "netmap",
  "doska",
  "forms",
  "wayline",
  "sftpgo",
  "xray",
]);
type Step = {
  operation_id: string;
  version: string;
  module_id?: string;
  artifact_sha256?: string;
  state: "pending" | "sent" | "done" | "skipped";
  note?: string;
};
type Batch = {
  schema: 1;
  id: string;
  actor: string;
  origin: string;
  created: number;
  steps: Step[];
  error?: string;
  previous_operation_id?: string;
};
function temporarilyUnavailable(error: unknown) {
  return (
    (error instanceof APIError && [502, 503, 504].includes(error.status)) ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof TypeError &&
      /fetch|network|load failed/i.test(error.message))
  );
}
async function batchAPI<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await api<T>(path, method, body, {}, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
function load(): { raw: string | null; batch?: Batch } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
    if (raw && raw.length > 32768) return { raw };
    const b = JSON.parse(raw || "null") as Batch;
    if (
      !b ||
      b.schema !== 1 ||
      !uuid.test(b.id) ||
      typeof b.actor !== "string" ||
      !b.actor ||
      b.actor.length > 200 ||
      b.origin !== location.origin ||
      (b.previous_operation_id !== undefined &&
        !uuid.test(b.previous_operation_id)) ||
      !Number.isFinite(b.created) ||
      b.created > Date.now() + 5000 ||
      Date.now() - b.created > 6 * 3600000 ||
      !Array.isArray(b.steps) ||
      !b.steps.length ||
      b.steps.length > 11 ||
      (b.error !== undefined &&
        (typeof b.error !== "string" || b.error.length > 2000))
    )
      return { raw };
    const ids = new Set(),
      kinds = new Set();
    for (const [i, s] of b.steps.entries()) {
      if (
        !s ||
        !uuid.test(s.operation_id) ||
        ids.has(s.operation_id) ||
        typeof s.version !== "string" ||
        s.version.length > 100 ||
        !version.test(s.version) ||
        !["pending", "sent", "done", "skipped"].includes(s.state) ||
        (s.note !== undefined &&
          (typeof s.note !== "string" || s.note.length > 2000))
      )
        return { raw };
      const kind = s.module_id ?? "core";
      if (
        kinds.has(kind) ||
        (kind === "core"
          ? i !== 0 || s.artifact_sha256 !== undefined
          : !modules.has(kind) ||
            !/^[0-9a-f]{64}$/.test(s.artifact_sha256 || ""))
      )
        return { raw };
      ids.add(s.operation_id);
      kinds.add(kind);
    }
    return { raw, batch: b };
  } catch {
    return { raw };
  }
}
function save(expected: string | null, batch?: Batch) {
  if (localStorage.getItem(key) !== expected) return false;
  if (batch) localStorage.setItem(key, JSON.stringify(batch));
  else localStorage.removeItem(key);
  window.dispatchEvent(new Event(event));
  return true;
}
export function useUpdateBatch() {
  const [batch, setBatch] = useState(() => load().batch);
  useEffect(() => {
    const changed = () => setBatch(load().batch);
    window.addEventListener(event, changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener(event, changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  return batch;
}
export async function startUpdateBatch(value: Delivery) {
  if (!navigator.locks)
    throw new Error(
      "Для очереди обновлений нужен браузер с поддержкой Web Locks.",
    );
  const session = await batchAPI<Session>("/session");
  if (
    !session.authenticated ||
    !session.user?.admin ||
    session.demo ||
    session.local_password_change_required
  )
    throw new Error("Для запуска обновлений войдите как администратор.");
  await navigator.locks.request(lock, async () => {
    const existing = load();
    if (existing.batch)
      throw new Error(
        "Сначала завершите или сбросьте сохранённую очередь обновлений.",
      );
    const steps: Step[] = value.modules
      .filter(
        (m) => m.installed && m.update_available && modules.has(m.module_id),
      )
      .map((m) => {
        if (!/^[0-9a-f]{64}$/.test(m.artifact_sha256 || ""))
          throw new Error("Не удалось подтвердить поставку модуля.");
        return {
          operation_id: crypto.randomUUID(),
          version: m.version,
          module_id: m.module_id,
          artifact_sha256: m.artifact_sha256,
          state: "pending",
        };
      });
    if (value.update_available)
      steps.unshift({
        operation_id: crypto.randomUUID(),
        version: value.latest_version,
        state: "pending",
      });
    if (!steps.length) throw new Error("Доступных обновлений нет.");
    const batch: Batch = {
      schema: 1,
      id: crypto.randomUUID(),
      actor: session.user!.id,
      origin: location.origin,
      created: Date.now(),
      steps,
      previous_operation_id: value.operation?.operation_id,
    };
    if (!save(existing.raw, batch) || load().batch?.id !== batch.id)
      throw new Error("Не удалось сохранить очередь обновлений в браузере.");
  });
}
export function UpdateBatchRunner({ session }: { session: Session }) {
  const batch = useUpdateBatch();
  const [coordinationError, setCoordinationError] = useState("");
  const actor =
    session.authenticated &&
    session.user?.admin &&
    !session.demo &&
    !session.local_password_change_required
      ? session.user.id
      : "";
  const active =
    !!batch &&
    batch.actor === actor &&
    !batch.error &&
    batch.steps.some((s) => s.state === "pending" || s.state === "sent");
  useEffect(() => {
    if (!active || !actor || !navigator.locks) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await navigator.locks.request(
          lock,
          { ifAvailable: true },
          async (lease) => {
            if (!lease || stopped) return;
            const { raw, batch: b } = load();
            if (!b || b.actor !== actor || b.error) return;
            const step = b.steps.find(
              (s) => s.state === "pending" || s.state === "sent",
            );
            if (!step) return;
            const name = step.module_id
              ? upgradeModuleName(step.module_id)
              : "Платформа";
            try {
              const freshSession = await batchAPI<Session>("/session");
              if (
                !freshSession.authenticated ||
                !freshSession.user?.admin ||
                freshSession.user.id !== actor ||
                freshSession.demo ||
                freshSession.local_password_change_required
              )
                throw new Error(
                  "Сеанс администратора изменился. Очередь остановлена.",
                );
              const value = await batchAPI<Delivery>("/delivery");
              if (stopped || localStorage.getItem(key) !== raw) return;
              const op = value.operation;
              const own = (status: Delivery) =>
                status.operation?.operation_id === step.operation_id &&
                (step.module_id
                  ? status.operation.kind === "module_upgrade" &&
                    status.operation.module_id === step.module_id
                  : (!status.operation.kind ||
                      status.operation.kind === "upgrade") &&
                    status.operation.version === step.version);
              if (step.state === "sent") {
                if (!own(value))
                  throw new Error(
                    "Не удалось подтвердить свою операцию. Проверьте состояние обновлений.",
                  );
                if (
                  ["failed", "rolled_back", "recovery_required"].includes(
                    op!.phase,
                  )
                )
                  throw new Error(
                    op!.error || "Операция не завершилась успешно.",
                  );
                if (op!.phase === "complete") {
                  if (!step.module_id && value.current_version !== step.version)
                    throw new Error(
                      "Установленная версия PL отличается от запланированной.",
                    );
                  step.state = "done";
                  b.previous_operation_id = op!.operation_id;
                  save(raw, b);
                } else rememberUpgrade(op);
                return;
              }
              if (op?.operation_id !== b.previous_operation_id)
                throw new Error(
                  "Другая операция изменила состояние установки. Очередь остановлена.",
                );
              if (
                op &&
                !["complete", "failed", "rolled_back"].includes(op.phase)
              )
                throw new Error(
                  "Другая операция уже выполняется. Очередь остановлена.",
                );
              if (step.module_id) {
                const offer = value.modules.find(
                  (m) => m.module_id === step.module_id,
                );
                if (
                  !offer?.installed ||
                  offer.artifact_sha256 !== step.artifact_sha256 ||
                  offer.version !== step.version ||
                  !offer.update_available
                )
                  throw new Error(
                    "Поставка или состояние модуля изменились. Проверьте обновления.",
                  );
                if (!offer.upgrade_supported || offer.blocked_reason) {
                  step.state = "skipped";
                  step.note =
                    offer.blocked_reason ||
                    "Эта поставка пока не поддерживается.";
                  save(raw, b);
                  return;
                }
              } else if (
                !value.update_available ||
                value.latest_version !== step.version
              )
                throw new Error(
                  "Доступная версия PL изменилась. Проверьте обновления.",
                );
              step.state = "sent";
              if (!save(raw, b)) return;
              const submitted = JSON.stringify(b);
              let accepted: Delivery;
              try {
                accepted = await batchAPI<Delivery>(
                  step.module_id
                    ? "/delivery/module-upgrade"
                    : "/delivery/upgrade",
                  "POST",
                  step.module_id
                    ? {
                        operation_id: step.operation_id,
                        module_id: step.module_id,
                        artifact_sha256: step.artifact_sha256,
                      }
                    : {
                        operation_id: step.operation_id,
                        version: step.version,
                      },
                );
              } catch {
                accepted = await batchAPI<Delivery>("/delivery");
              }
              if (!own(accepted))
                throw new Error(
                  "Не удалось подтвердить запуск. Очередь остановлена; проверьте состояние операции.",
                );
              if (localStorage.getItem(key) === submitted)
                rememberUpgrade(accepted.operation);
            } catch (e) {
              // Core may temporarily stop the API, including after accepting a
              // POST whose response was lost. Keep the sent UUID; subsequent
              // ticks only reconcile it by GET, never repeat the write.
              if (temporarilyUnavailable(e)) return;
              const latest = load();
              if (
                latest.batch?.id === b.id &&
                latest.batch.steps.find(
                  (s) => s.state === "pending" || s.state === "sent",
                )?.operation_id === step.operation_id
              ) {
                latest.batch.error = `${name}: ${errorText(e)}`.slice(0, 2000);
                save(latest.raw, latest.batch);
              }
            }
          },
        );
      } catch {
        stopped = true;
        setCoordinationError(
          "Браузер не позволяет продолжить очередь. Проверьте состояние операций и сбросьте очередь.",
        );
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), 1000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [actor, batch?.id, active]);
  if (!batch || !actor) return null;
  const pending = batch.steps.find(
    (s) => s.state === "pending" || s.state === "sent",
  );
  return (
    <section className="notice" aria-label="Очередь обновлений">
      <div role="status">
        <strong>
          {batch.error
            ? "Обновление остановлено"
            : pending
              ? `Обновить всё: ${batch.steps.filter((s) => s.state === "done").length} из ${batch.steps.length}`
              : "Очередь обновлений завершена"}
        </strong>
        <p>
          {batch.actor !== actor
            ? "Очередь создана другим администратором и приостановлена."
            : batch.error ||
              coordinationError ||
              (pending
                ? "Оставьте вкладку открытой. После перезагрузки страницы очередь продолжится."
                : "Все доступные шаги обработаны.")}
        </p>
        {batch.steps
          .filter((s) => s.state === "skipped")
          .map((s) => (
            <p key={s.operation_id}>
              {upgradeModuleName(s.module_id)}: пропущено — {s.note}
            </p>
          ))}
      </div>
      <Button
        variant="secondary"
        onClick={() =>
          void navigator.locks?.request(lock, async () => {
            const current = load();
            if (current.batch?.id === batch.id) save(current.raw);
          })
        }
      >
        Сбросить очередь
      </Button>
      {pending?.state === "sent" && (
        <span>Сброс очереди не отменяет уже запущенную операцию.</span>
      )}
    </section>
  );
}
