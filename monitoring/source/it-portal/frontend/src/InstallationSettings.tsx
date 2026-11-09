import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network, RefreshCw } from "lucide-react";
import { APIError, api, queryClient } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ErrorBox, Field, Panel } from "./components/common";
import { useDraftRegistration } from "./settings/Draft";
import {
  rememberInstallationTransition,
  settleInstallationTransition,
} from "./InstallationTransition";

type Configuration = {
  revision: number;
  public_url: string;
  bind_address: string;
  allowed_cidrs: string[];
  allowed_ports: number[];
  icmp_policy_mode?: "interactive" | "cidr";
  icmp_allowed_cidrs?: string[];
  outbound_ca_pem?: string;
};
type Status = Configuration & {
  core_api: number;
  custom_tls: boolean;
  operation?: {
    kind?: string;
    operation_id: string;
    phase: string;
    error?: string;
    next_url?: string;
  };
};
type Draft = {
  public_url: string;
  bind_address: string;
  cidrs: string;
  ports: string;
  tls_cert_pem: string;
  tls_key_pem: string;
  outbound_ca_pem: string;
  icmp_policy_mode: "interactive" | "cidr";
  icmp_cidrs: string;
};
const terminal = new Set([
  "complete",
  "failed",
  "rolled_back",
  "recovery_required",
]);
const split = (value: string) =>
  value
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
const form = (value: Configuration): Draft => ({
  public_url: value.public_url,
  bind_address: value.bind_address,
  cidrs: (value.allowed_cidrs || []).join("\n"),
  ports: (value.allowed_ports || []).join(", "),
  tls_cert_pem: "",
  tls_key_pem: "",
  outbound_ca_pem: value.outbound_ca_pem || "",
  icmp_policy_mode:
    value.icmp_policy_mode ||
    (value.icmp_allowed_cidrs === undefined ? "interactive" : "cidr"),
  icmp_cidrs: (value.icmp_allowed_cidrs || []).join("\n"),
});
function nextURL(value?: string) {
  try {
    const u = new URL(value || "");
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function InstallationSettings() {
  const status = useQuery({
    queryKey: ["/installation"],
    queryFn: () => api<Status>("/installation"),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.operation && !terminal.has(q.state.data.operation.phase)
        ? 2500
        : 60000,
  });
  const [draft, setDraft] = useState<Draft>();
  const [baseline, setBaseline] = useState<Draft>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState(false);
  const [uploadKey, setUploadKey] = useState(0);
  const operationID = useRef<string | undefined>(undefined);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline);
  const running =
    !!status.data?.operation && !terminal.has(status.data.operation.phase);
  const waitingForServer =
    running &&
    status.data?.operation?.kind === "configuration" &&
    (status.error instanceof TypeError ||
      (status.error instanceof APIError &&
        [502, 503, 504].includes(status.error.status)));
  useEffect(() => {
    const value = status.data;
    if (value) settleInstallationTransition(value);
    if (!value || dirty || running) return;
    const next = form(value);
    setDraft(next);
    setBaseline(next);
    setRevision(value.revision);
  }, [status.data, dirty, running]);
  function accepted(value: Status) {
    if (value.operation?.next_url && value.operation.operation_id)
      rememberInstallationTransition(
        value.operation.operation_id,
        value.operation.next_url,
      );
    settleInstallationTransition(value);
    queryClient.setQueryData(["/installation"], value);
    if (draft) {
      const clean = { ...draft, tls_cert_pem: "", tls_key_pem: "" };
      setDraft(clean);
      setBaseline(clean);
    }
    setUploadKey((v) => v + 1);
    setConfirm(false);
  }
  async function save() {
    if (!draft || busy || running || conflict) return false;
    const ports = split(draft.ports).map(Number);
    if (
      ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) ||
      ports.length > 64 ||
      split(draft.cidrs).length > 64 ||
      (draft.icmp_policy_mode === "cidr" &&
        split(draft.icmp_cidrs).length > 64) ||
      !!draft.tls_cert_pem !== !!draft.tls_key_pem
    ) {
      setError(
        new Error(
          "Укажите корректные сети и порты. Для собственного TLS нужны сертификат и ключ вместе.",
        ),
      );
      return false;
    }
    setBusy(true);
    setError(undefined);
    operationID.current ||= crypto.randomUUID();
    try {
      const value = await api<Status>("/installation", "PUT", {
        revision,
        operation_id: operationID.current,
        public_url: draft.public_url.trim().replace(/\/$/, ""),
        bind_address: draft.bind_address.trim(),
        allowed_cidrs: [...new Set(split(draft.cidrs))],
        allowed_ports: [...new Set(ports)],
        outbound_ca_pem: draft.outbound_ca_pem,
        ...(status.data?.icmp_policy_mode
          ? {
              icmp_policy_mode: draft.icmp_policy_mode,
              icmp_allowed_cidrs:
                draft.icmp_policy_mode === "cidr"
                  ? [...new Set(split(draft.icmp_cidrs))]
                  : [],
            }
          : {}),
        ...(draft.tls_cert_pem
          ? { tls_cert_pem: draft.tls_cert_pem, tls_key_pem: draft.tls_key_pem }
          : {}),
      });
      accepted(value);
      return true;
    } catch (e) {
      setError(e);
      if (e instanceof APIError && e.code === "installation_conflict")
        setConflict(true);
      const observed = await status.refetch();
      if (observed.data?.operation?.operation_id === operationID.current) {
        accepted(observed.data);
        return true;
      }
      return false;
    } finally {
      setBusy(false);
    }
  }
  function discard() {
    if (baseline) setDraft(baseline);
    setError(undefined);
    setUploadKey((v) => v + 1);
  }
  async function loadCurrent() {
    const latest = await status.refetch();
    if (!latest.data) return;
    const next = form(latest.data);
    setDraft(next);
    setBaseline(next);
    setRevision(latest.data.revision);
    setConflict(false);
    setError(undefined);
    setUploadKey((v) => v + 1);
    operationID.current = undefined;
  }
  useDraftRegistration({ dirty, busy, save, discard });
  async function file(
    file: File | undefined,
    field: "tls_cert_pem" | "tls_key_pem" | "outbound_ca_pem",
  ) {
    if (!file || !draft) return;
    if (file.size > 65536) {
      setError(new Error("Размер PEM-файла не должен превышать 64 КиБ"));
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      setDraft((current) =>
        current ? { ...current, [field]: content } : current,
      );
      operationID.current = undefined;
    } catch {
      setError(new Error("Не удалось прочитать выбранный PEM-файл"));
    } finally {
      setBusy(false);
    }
  }
  const target = nextURL(status.data?.operation?.next_url);
  return (
    <div className="runtime-settings">
      <Panel title="Адрес и сеть" icon={<Network size={20} />}>
        <p className="muted">
          Адрес открытия PL, сертификат HTTPS и сети подключаемых сервисов. При
          применении PL кратковременно перезапустится.
        </p>
        {status.error && !waitingForServer && <ErrorBox error={status.error} />}
        {status.data?.operation?.kind === "configuration" && (
          <div role="status" aria-live="polite">
            <p>
              {running
                ? "Применяем параметры установки…"
                : status.data.operation.phase === "complete"
                  ? "Параметры применены"
                  : status.data.operation.phase === "rolled_back"
                    ? "Восстановлены предыдущие параметры"
                    : status.data.operation.phase === "recovery_required"
                      ? "Требуется восстановление. Откройте раздел обновлений."
                      : "Параметры не применены"}
            </p>
            {waitingForServer && (
              <p className="muted">Ждём ответа PL после перезапуска…</p>
            )}
            {status.data.operation.error && (
              <ErrorBox error={new Error(status.data.operation.error)} />
            )}
            {target && target !== location.origin + "/" && (
              <p>
                Новый адрес: <a href={target}>{target}</a>. При недоступности
                дождитесь окончания операции и повторите переход.
              </p>
            )}
          </div>
        )}
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setConfirm(true);
            }}
          >
            <fieldset disabled={busy || running}>
              <div className="form-grid">
                <Field
                  label="Адрес PL"
                  hint="HTTPS-адрес, по которому пользователи открывают платформу."
                >
                  <input
                    required
                    type="url"
                    value={draft.public_url}
                    onChange={(e) => {
                      setDraft({ ...draft, public_url: e.target.value });
                      operationID.current = undefined;
                    }}
                  />
                </Field>
                <Field
                  label="На каком адресе принимать подключения"
                  hint="Укажите IP-адрес этого сервера. Значение 0.0.0.0 разрешает подключаться через все его IPv4-интерфейсы."
                >
                  <input
                    required
                    value={draft.bind_address}
                    onChange={(e) => {
                      setDraft({ ...draft, bind_address: e.target.value });
                      operationID.current = undefined;
                    }}
                  />
                </Field>
                <Field
                  label="Сети подключаемых сервисов"
                  hint="PL сможет обращаться к сервисам в этих сетях. Укажите до 64 сетей, каждую с новой строки. Например, 192.168.2.0/24 — адреса сети 192.168.2.x."
                >
                  <textarea
                    rows={5}
                    value={draft.cidrs}
                    onChange={(e) => {
                      setDraft({ ...draft, cidrs: e.target.value });
                      operationID.current = undefined;
                    }}
                  />
                </Field>
                <Field
                  label="Порты подключаемых сервисов"
                  hint="TCP-порты, к которым PL сможет подключаться в указанных сетях. До 64 значений через запятую, например: 80, 443, 9090."
                >
                  <input
                    value={draft.ports}
                    onChange={(e) => {
                      setDraft({ ...draft, ports: e.target.value });
                      operationID.current = undefined;
                    }}
                  />
                </Field>
              </div>
              {status.data?.icmp_policy_mode && (
                <details>
                  <summary>ICMP-диагностика</summary>
                  <p className="muted">
                    По умолчанию ICMP проверяет адрес, указанный
                    администратором, как остальные ручные инструменты. При
                    необходимости можно ограничить его выбранными IPv4-сетями.
                  </p>
                  <Field label="Доступные адреса для ICMP">
                    <select
                      value={draft.icmp_policy_mode}
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          icmp_policy_mode: event.target
                            .value as Draft["icmp_policy_mode"],
                        });
                        operationID.current = undefined;
                      }}
                    >
                      <option value="interactive">
                        Как в других ручных проверках
                      </option>
                      <option value="cidr">Только указанные сети</option>
                    </select>
                  </Field>
                  {draft.icmp_policy_mode === "cidr" && (
                    <Field
                      label="Разрешённые IPv4-сети для ICMP"
                      hint="CIDR по одному на строке, не более 64. Пустой список запрещает ICMP-проверки."
                    >
                      <textarea
                        rows={4}
                        value={draft.icmp_cidrs}
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            icmp_cidrs: event.target.value,
                          });
                          operationID.current = undefined;
                        }}
                      />
                    </Field>
                  )}
                </details>
              )}
              <details>
                <summary>Собственный TLS-сертификат</summary>
                <p className="muted">
                  Текущий сертификат:{" "}
                  {status.data?.custom_tls
                    ? "собственный"
                    : "создан установкой PL"}
                  . Для замены выберите оба PEM-файла. Закрытый ключ после
                  сохранения не возвращается в браузер.
                </p>
                <div className="form-grid" key={uploadKey}>
                  <Field label="TLS-сертификат PEM">
                    <input
                      type="file"
                      accept=".pem,.crt,.cer"
                      onChange={(e) =>
                        void file(e.target.files?.[0], "tls_cert_pem")
                      }
                    />
                  </Field>
                  <Field label="Закрытый TLS-ключ PEM">
                    <input
                      type="file"
                      accept=".pem,.key"
                      onChange={(e) =>
                        void file(e.target.files?.[0], "tls_key_pem")
                      }
                    />
                  </Field>
                </div>
              </details>
              <details>
                <summary>Сертификаты внешних интеграций</summary>
                <p className="muted">
                  Загрузите сертификат корпоративного центра сертификации один
                  раз для HTTPS-интеграций Платформы и входа через AD. В
                  настройках AD при необходимости можно выбрать отдельный
                  сертификат. Используйте DNS-имена из сертификатов серверов.
                </p>
                <Field label="Дополнительный CA для интеграций">
                  <input
                    key={`outbound-${uploadKey}`}
                    type="file"
                    accept=".pem,.crt,.cer"
                    onChange={(e) =>
                      void file(e.target.files?.[0], "outbound_ca_pem")
                    }
                  />
                </Field>
                {draft.outbound_ca_pem ? (
                  <div className="actions">
                    <span>Дополнительный CA задан</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setDraft({ ...draft, outbound_ca_pem: "" });
                        operationID.current = undefined;
                      }}
                    >
                      Использовать только системные CA
                    </Button>
                  </div>
                ) : (
                  <p className="muted">
                    Используются системные центры сертификации.
                  </p>
                )}
              </details>
            </fieldset>
            {!!error && <ErrorBox error={error} />}
            <div className="actions">
              <Button
                type="submit"
                disabled={!dirty || busy || running || conflict}
              >
                Применить параметры
              </Button>
              {conflict && (
                <Button
                  type="button"
                  disabled={busy || running}
                  onClick={() => void loadCurrent()}
                >
                  Загрузить текущие параметры
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={busy || running}
                onClick={() => void status.refetch()}
              >
                <RefreshCw size={16} />
                Обновить состояние
              </Button>
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || running}
                  onClick={discard}
                >
                  Отменить изменения
                </Button>
              )}
            </div>
          </form>
        ) : (
          !status.error && <p>Загрузка параметров установки…</p>
        )}
        {confirm && (
          <Dialog
            title="Применить параметры установки?"
            onClose={() => {
              if (!busy) setConfirm(false);
            }}
          >
            <p>
              PL проверит конфигурацию и перезапустит API и web. При неудачной
              проверке предыдущие параметры будут восстановлены.
              Пользовательские данные сохраняются.
            </p>
            {draft?.public_url && (
              <p>
                Адрес после применения: <strong>{draft.public_url}</strong>
              </p>
            )}
            {!!error && <ErrorBox error={error} />}
            <div className="actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Отмена
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? "Отправка…" : "Проверить и применить"}
              </Button>
            </div>
          </Dialog>
        )}
      </Panel>
    </div>
  );
}
