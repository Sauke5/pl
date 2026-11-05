import { useDraftRegistration } from "./settings/Draft";
import { UpdateSettings } from "./UpdateSettings";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Server, Shield } from "lucide-react";
import { APIError, api, refresh, useAPI, date } from "./api";
import type { Settings } from "./types";
import { Button } from "./components/ui/button";
import { ErrorBox, Field, Panel } from "./components/common";
import "./runtime-settings.css";

type Runtime = {
  host?: {
    hostname: string;
    kernel: string;
    cpus: number;
    load_average: number[];
    uptime_seconds: number;
    memory: { total_bytes: number; available_bytes: number };
    storage: { total_bytes: number; used_bytes: number; free_bytes: number };
    observed_at: string;
  };
  host_error?: string;
  go_version: string;
  os: string;
  architecture: string;
  process_memory_bytes: number;
  process_heap_bytes: number;
  available_cpus: number;
  goroutines: number;
  session_lifetime_minutes: number;
  allowed_cidrs: string[] | null;
  allowed_ports: number[] | null;
};
const bytes = (value?: number) =>
  value === undefined
    ? "Нет данных"
    : value >= 1073741824
      ? `${(value / 1073741824).toFixed(1)} ГиБ`
      : `${(value / 1048576).toFixed(1)} МБ`;
export function RuntimeSettings() {
  const settings = useAPI<Settings>("/settings");
  const runtime = useAPI<Runtime>("/runtime");
  const [draft, setDraft] = useState<Settings>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const pending = useRef(false);
  const baseline = useRef<Settings | undefined>(undefined);
  useEffect(() => {
    if (settings.data && !draft) {
      baseline.current = settings.data;
      setDraft(settings.data);
    }
  }, [settings.data, draft]);
  function change(next: Settings) {
    setDraft(next);
    setSaved(false);
  }
  async function reload() {
    if (pending.current) return;
    try {
      const latest = await api<Settings>("/settings");
      baseline.current = latest;
      setDraft(latest);
      setConflict(false);
      setError(undefined);
      setSaved(false);
    } catch (e) {
      setError(e);
    }
  }
  async function save() {
    if (!draft || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const latest = await api<Settings>("/settings", "PUT", draft);
      baseline.current = latest;
      setDraft(latest);
      setSaved(true);
      setConflict(false);
      await refresh();
      return true;
    } catch (e) {
      setError(e);
      if (e instanceof APIError && e.status === 409) setConflict(true);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useDraftRegistration({
    dirty:
      !!draft &&
      !!baseline.current &&
      (["session_lifetime_minutes", "local_password_min_length"] as const).some(
        (field) => draft[field] !== baseline.current?.[field],
      ),
    busy,
    save,
    discard: () => {
      if (baseline.current) setDraft(baseline.current);
      setError(undefined);
      setConflict(false);
      setSaved(false);
    },
  });
  return (
    <div className="runtime-settings">
      <UpdateSettings />
      <Panel title="Сессии и пароли" icon={<Shield size={20} />}>
        <p className="muted">
          Изменения сохраняются на сервере и действуют без перезапуска.
        </p>
        {settings.error ? (
          <ErrorBox error={settings.error} />
        ) : draft ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy || conflict}>
              <div className="form-grid">
                <Field
                  label="Срок новой сессии, мин"
                  hint="От 15 минут до 7 дней. Уже открытые сессии сохраняют прежний срок. Внешний вход также ограничен сроком токена провайдера."
                >
                  <input
                    type="number"
                    min={15}
                    max={10080}
                    required
                    value={
                      draft.session_lifetime_minutes ||
                      runtime.data?.session_lifetime_minutes ||
                      480
                    }
                    onChange={(e) =>
                      change({
                        ...draft,
                        session_lifetime_minutes: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label="Минимальная длина пароля"
                  hint="От 8 до 128 символов. Для новых и изменяемых локальных паролей; существующие пароли сохраняются."
                >
                  <input
                    type="number"
                    min={8}
                    max={128}
                    required
                    value={draft.local_password_min_length || 12}
                    onChange={(e) =>
                      change({
                        ...draft,
                        local_password_min_length: Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
            </fieldset>
            {!!error && <ErrorBox error={error} />}
            <div className="actions">
              <Button
                type="submit"
                variant="default"
                disabled={busy || conflict}
              >
                {busy ? "Сохранение…" : "Сохранить настройки"}
              </Button>
              {conflict && (
                <Button type="button" onClick={() => void reload()}>
                  <RefreshCw size={16} />
                  Загрузить актуальные
                </Button>
              )}
              {saved && (
                <span role="status" className="text-green">
                  Настройки сохранены
                </span>
              )}
            </div>
            {conflict && (
              <p className="muted">
                Настройки уже изменены в другой сессии. Загрузка актуальных
                заменит введённые значения.
              </p>
            )}
          </form>
        ) : (
          <p>Загрузка настроек…</p>
        )}
      </Panel>
      <Panel title="Хост Платформы" icon={<Server size={20} />}>
        {runtime.error ? (
          <ErrorBox error={runtime.error} />
        ) : runtime.data?.host ? (
          <>
            <dl className="runtime-facts">
              <div>
                <dt>Имя хоста</dt>
                <dd>{runtime.data.host.hostname}</dd>
              </div>
              <div>
                <dt>Ядро ОС</dt>
                <dd>{runtime.data.host.kernel}</dd>
              </div>
              <div>
                <dt>Логические CPU / нагрузка за 1 минуту</dt>
                <dd>
                  {runtime.data.host.cpus} /{" "}
                  {runtime.data.host.load_average[0]?.toFixed(2) ??
                    "Нет данных"}
                </dd>
              </div>
              <div>
                <dt>Оперативная память: доступно / всего</dt>
                <dd>
                  {bytes(runtime.data.host.memory.available_bytes)} /{" "}
                  {bytes(runtime.data.host.memory.total_bytes)}
                </dd>
              </div>
              <div>
                <dt>Диск Платформы: занято / свободно / всего</dt>
                <dd>
                  {bytes(runtime.data.host.storage.used_bytes)} /{" "}
                  {bytes(runtime.data.host.storage.free_bytes)} /{" "}
                  {bytes(runtime.data.host.storage.total_bytes)}
                </dd>
              </div>
              <div>
                <dt>Время работы хоста</dt>
                <dd>
                  {Math.floor(runtime.data.host.uptime_seconds / 86400)} дн.{" "}
                  {Math.floor(
                    (runtime.data.host.uptime_seconds % 86400) / 3600,
                  )}{" "}
                  ч.{" "}
                  {Math.floor((runtime.data.host.uptime_seconds % 3600) / 60)}{" "}
                  мин.
                </dd>
              </div>
              <div>
                <dt>Данные получены</dt>
                <dd>{date(runtime.data.host.observed_at)}</dd>
              </div>
            </dl>
            <p className="muted">
              Диск — файловая система каталога установки Платформы. Нагрузка —
              число выполняемых и ожидающих задач, не процент CPU.
            </p>
          </>
        ) : runtime.data ? (
          <p className="notice">
            {runtime.data.host_error ||
              "Host controller не предоставил данные хоста"}
          </p>
        ) : (
          <p>Загрузка состояния…</p>
        )}
        <Button
          onClick={() => void runtime.refetch()}
          disabled={runtime.isFetching}
        >
          <RefreshCw size={16} />
          Обновить состояние
        </Button>
        <details className="runtime-process">
          <summary>Процесс API и ограничения проверок</summary>
          <p className="muted">
            Показатели процесса API внутри контейнера, отдельно от ресурсов
            хоста.
          </p>
          {runtime.data ? (
            <dl className="runtime-facts">
              <div>
                <dt>Среда API</dt>
                <dd>
                  {runtime.data.os} / {runtime.data.architecture} ·{" "}
                  {runtime.data.go_version}
                </dd>
              </div>
              <div>
                <dt>Логические CPU, доступные процессу</dt>
                <dd>{runtime.data.available_cpus ?? "Нет данных"}</dd>
              </div>
              <div>
                <dt>Память, выделенная Go из ОС</dt>
                <dd>{bytes(runtime.data.process_memory_bytes)}</dd>
              </div>
              <div>
                <dt>Память объектов Go</dt>
                <dd>{bytes(runtime.data.process_heap_bytes)}</dd>
              </div>
              <div>
                <dt>Сети для проверок</dt>
                <dd>{runtime.data.allowed_cidrs?.join(", ") || "Не заданы"}</dd>
              </div>
              <div>
                <dt>Порты для проверок</dt>
                <dd>{runtime.data.allowed_ports?.join(", ") || "Не заданы"}</dd>
              </div>
            </dl>
          ) : (
            <p>Нет данных процесса</p>
          )}
        </details>
      </Panel>
      <Panel title="Права и границы управления" icon={<Shield size={20} />}>
        <dl className="runtime-facts">
          <div>
            <dt>Администратор</dt>
            <dd>
              Настройки Платформы, пользователи, интеграции, установка и
              конфигурация модулей.
            </dd>
          </div>
          <div>
            <dt>Пользователь</dt>
            <dd>
              Просмотр разрешённых сервисов и смена своего пароля. Настройки
              сервера недоступны.
            </dd>
          </div>
          <div>
            <dt>Через администратора хоста</dt>
            <dd>
              SSH, firewall, TLS-сертификаты, сетевые allowlists, диски,
              перезагрузка и обновление ОС.
            </dd>
          </div>
          <div>
            <dt>Обязательные проверки</dt>
            <dd>
              Вход в Платформу, проверка прав, защита изменяющих запросов и
              проверка TLS подключаемых сервисов.
            </dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}
