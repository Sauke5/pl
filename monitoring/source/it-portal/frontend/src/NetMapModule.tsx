import { Fragment, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Info,
  Map,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { ActionFeedback } from "./ActionNotifications";
import { api, queryClient, useAPI } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import NetMapInventory from "./NetMapInventory";
import "./netmap-module.css";

type Instance = { id: string; name: string; desired_state: string };
type Network = {
  id: string;
  cidr: string;
  name: string;
  profile: string;
  snmp_profiles?: string[];
  snmp_profiles_invalid?: boolean;
};
type Profile = {
  id: string;
  username?: string;
  password_set?: boolean;
  snmp_community_set?: boolean;
  ssh_known_hosts_set?: boolean;
  oxidized_model?: string;
};
type Poll = {
  id: string;
  network: string;
  state: string;
  error?: string;
  actor?: string;
  result?: Record<string, unknown>;
};
type Items<T> = { items: T[] };
type Networks = Items<Network> & {
  capabilities?: {
    device_access?: number;
    ordered_snmp_profiles?: number;
    inventory?: number;
  };
};
const netMapSections = [
  ["devices", "Устройства"],
  ["networks", "Сети"],
  ["access", "Доступ и конфигурации"],
] as const;
type NetMapSection = (typeof netMapSections)[number][0];
type Device = {
  id: number;
  name: string;
  collector_ip: string;
  source_loaded: boolean;
  binding: {
    profile_id: string;
    model_override: string;
    effective_model: string;
    host_key_set: boolean;
    ssh_ready: boolean;
  };
  last_attempt: { status: string; started_at?: string; finished_at?: string };
};
type DeviceDetails = {
  device: Device;
  version: string;
  network_id: string;
  collection: {
    state: string;
    saved_configuration?: {
      revision: string;
      bytes: number;
      sha256: string;
      committed_at?: string;
    } | null;
  };
};
const collectionLabels: Record<string, string> = {
  not_configured: "SSH не настроен",
  unconfirmed: "Сбор с текущими настройками не подтверждён",
  queued: "Ожидает результата сбора",
  failed: "Последняя попытка сбора завершилась ошибкой",
  collected: "Конфигурация получена",
};

function SNMPOrder({
  value,
  profiles,
  disabled,
  onChange,
}: {
  value: string[];
  profiles: Profile[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="netmap-snmp-order">
      <p className="module-hint">
        До четырёх SNMP-профилей по порядку. После первого ответа остальные не
        проверяются. Общее время проверки сети — до 10 минут.
      </p>
      <ol>
        {value.map((id, index) => (
          <li key={id}>
            <span>{id}</span>
            <Button
              size="sm"
              disabled={disabled || index === 0}
              aria-label={`Поднять ${id}`}
              onClick={() => {
                const next = [...value];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange(next);
              }}
            >
              Выше
            </Button>
            <Button
              size="sm"
              disabled={disabled || index === value.length - 1}
              aria-label={`Опустить ${id}`}
              onClick={() => {
                const next = [...value];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                onChange(next);
              }}
            >
              Ниже
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              aria-label={`Убрать SNMP-профиль ${id}`}
              onClick={() => onChange(value.filter((item) => item !== id))}
            >
              Убрать
            </Button>
          </li>
        ))}
      </ol>
      {!value.length && <p>SNMP выключен. Используются ICMP и TCP.</p>}
      <Field label="Добавить SNMP-профиль">
        <select
          value=""
          disabled={disabled || value.length >= 4}
          onChange={(event) => {
            if (event.target.value) onChange([...value, event.target.value]);
          }}
        >
          <option value="">Выберите профиль</option>
          {profiles
            .filter(
              (profile) =>
                profile.snmp_community_set && !value.includes(profile.id),
            )
            .map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.id}
              </option>
            ))}
        </select>
      </Field>
    </div>
  );
}

function DeviceAccess({
  base,
  network,
  profiles,
  disabled,
  setBusy,
}: {
  base: string;
  network: Network;
  profiles: Profile[];
  disabled: boolean;
  setBusy: (value: string) => void;
}) {
  const devices = useAPI<Items<Device> & { collector_available: boolean }>(
    base + "/devices?network=" + network.id,
  );
  const [selected, setSelected] = useState<number>();
  const detail = useAPI<DeviceDetails>(
    base + "/devices/" + selected,
    selected !== undefined,
  );
  const [draft, setDraft] = useState<{
    id: number;
    version: string;
    profile: string;
    model: string;
  }>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>();
  const [waitingUntil, setWaitingUntil] = useState(0);
  const pending = useRef(false);
  function adopt(value: DeviceDetails) {
    setDraft({
      id: value.device.id,
      version: value.version,
      profile: value.device.binding.profile_id,
      model: value.device.binding.model_override,
    });
  }
  async function refreshDevice() {
    const value = await detail.refetch();
    if (value.data && !value.error) adopt(value.data);
    await devices.refetch();
  }
  useEffect(() => {
    if (!waitingUntil || !selected) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= waitingUntil) {
        setWaitingUntil(0);
        return;
      }
      void detail.refetch();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [waitingUntil, selected, detail.refetch]);
  useEffect(() => {
    if (["collected", "failed"].includes(detail.data?.collection.state || ""))
      setWaitingUntil(0);
  }, [detail.data]);
  // Background reads never replace a draft or its optimistic-concurrency token.
  useEffect(() => {
    const value = detail.data;
    if (value && value.device.id === selected && !draft)
      setDraft({
        id: value.device.id,
        version: value.version,
        profile: value.device.binding.profile_id,
        model: value.device.binding.model_override,
      });
  }, [detail.data, selected, draft]);
  async function action(kind: "ssh-binding" | "collect") {
    if (!detail.data || !draft || disabled || pending.current) return;
    pending.current = true;
    setBusy("device-" + kind);
    setError(undefined);
    setNotice("");
    try {
      const body =
        kind === "collect"
          ? { version: draft.version }
          : {
              network_id: network.id,
              collector_ip: detail.data.device.collector_ip,
              profile_id: draft.profile,
              model: draft.model,
              version: draft.version,
            };
      const result = await api<{
        saved?: boolean;
        source_loaded?: boolean;
        state?: string;
      }>(base + "/devices/" + draft.id + "/" + kind, "POST", body, {
        "Idempotency-Key": crypto.randomUUID(),
      });
      if (kind === "ssh-binding") {
        if (result.saved !== true)
          throw new Error(
            "Сохранение привязки не подтверждено. Обновите данные устройства.",
          );
        setNotice(
          result.source_loaded
            ? "SSH-привязка сохранена. Получение конфигурации проверяется отдельно."
            : "Привязка сохранена, но Oxidized не подтвердил загрузку. Обновите данные перед сбором.",
        );
      } else {
        if (!["queued", "unconfirmed"].includes(result.state || ""))
          throw new Error(
            "Результат запуска неизвестен. Обновите данные перед новой попыткой.",
          );
        setNotice(
          result.state === "queued"
            ? "Устройство поставлено в очередь. Ожидаем результат сбора."
            : "Запуск не подтверждён. Проверьте результат перед новой попыткой.",
        );
        setWaitingUntil(Date.now() + 120000);
      }
      if (kind === "ssh-binding") await refreshDevice();
      else await Promise.all([detail.refetch(), devices.refetch()]);
    } catch (failure) {
      setError(failure);
    } finally {
      pending.current = false;
      setBusy("");
    }
  }
  const selectedProfile = profiles.find(
    (profile) => profile.id === draft?.profile,
  );
  const dirty =
    !!draft &&
    !!detail.data &&
    (draft.profile !== detail.data.device.binding.profile_id ||
      draft.model !== detail.data.device.binding.model_override);
  const collection = detail.data?.collection;
  return (
    <Panel title="SSH и конфигурации устройств" className="netmap-devices">
      <p className="module-hint">
        Профиль и модель задаются каждому устройству. Смена профиля сети не
        меняет существующие привязки.
      </p>
      <ActionFeedback notice={notice} error={error} noticeKind="info" />
      {devices.error && (
        <ErrorBox error={devices.error} retry={() => void devices.refetch()} />
      )}
      {devices.data?.collector_available === false && (
        <p role="status">Oxidized недоступен. Состояние сбора неизвестно.</p>
      )}
      {!devices.data && !devices.error && (
        <p role="status">Загружаем устройства…</p>
      )}
      {devices.data?.items?.length === 0 && (
        <p>
          Устройств пока нет. Запустите проверку сети, чтобы добавить их в
          NetBox.
        </p>
      )}
      {!!devices.data?.items?.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Устройство</th>
                <th>SSH-профиль / модель</th>
                <th>Oxidized</th>
              </tr>
            </thead>
            <tbody>
              {devices.data.items.map((device) => (
                <tr key={device.id}>
                  <td>
                    <Button
                      disabled={disabled}
                      onClick={() => {
                        setSelected(device.id);
                        setDraft(undefined);
                        setError(undefined);
                        setNotice("");
                        setWaitingUntil(0);
                      }}
                    >
                      {device.name} · {device.collector_ip}
                    </Button>
                  </td>
                  <td>
                    {device.binding.profile_id || "Не назначен"} /{" "}
                    {device.binding.effective_model || "—"}
                  </td>
                  <td>
                    {device.source_loaded
                      ? "Устройство загружено"
                      : "Загрузка не подтверждена"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected !== undefined && (
        <div className="netmap-device-editor">
          {detail.error && (
            <ErrorBox
              error={detail.error}
              retry={() => void detail.refetch()}
            />
          )}
          {detail.data?.device.id === selected && draft && (
            <>
              <h3>
                {detail.data.device.name} · {detail.data.device.collector_ip}
              </h3>
              <div className="form-grid">
                <Field label="SSH-профиль устройства">
                  <select
                    value={draft.profile}
                    disabled={disabled}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        profile: event.target.value,
                        model: event.target.value ? draft.model : "",
                      })
                    }
                  >
                    <option value="">Не собирать конфигурацию</option>
                    {profiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Модель устройства"
                  hint={`Пустое поле — модель из профиля${selectedProfile?.oxidized_model ? ": " + selectedProfile.oxidized_model : ""}.`}
                >
                  <input
                    value={draft.model}
                    disabled={disabled || !draft.profile}
                    maxLength={64}
                    pattern="[a-z][a-z0-9_]{0,63}"
                    placeholder="Из профиля"
                    onChange={(event) =>
                      setDraft({ ...draft, model: event.target.value })
                    }
                  />
                </Field>
              </div>
              {draft.profile &&
                (!selectedProfile?.username ||
                  !selectedProfile.password_set ||
                  !selectedProfile.ssh_known_hosts_set) && (
                  <p>
                    Для SSH нужны логин, пароль и проверенный host key в
                    профиле.
                  </p>
                )}
              <div className="actions">
                <Button
                  disabled={disabled || !dirty}
                  onClick={() => void action("ssh-binding")}
                >
                  Сохранить SSH-привязку
                </Button>
                <Button
                  disabled={
                    disabled ||
                    dirty ||
                    !detail.data.device.binding.ssh_ready ||
                    !!waitingUntil
                  }
                  onClick={() => void action("collect")}
                >
                  Получить конфигурацию
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() => void refreshDevice()}
                >
                  Обновить устройство
                </Button>
              </div>
              <p role="status">
                {collectionLabels[collection?.state || ""] ||
                  "Состояние сбора неизвестно"}
              </p>
              {collection?.saved_configuration && (
                <dl className="netmap-config-summary">
                  <dt>Сохранённая ревизия</dt>
                  <dd>
                    <code>{collection.saved_configuration.revision}</code>
                  </dd>
                  <dt>Размер</dt>
                  <dd>{collection.saved_configuration.bytes} байт</dd>
                  <dt>SHA-256</dt>
                  <dd>
                    <code>{collection.saved_configuration.sha256}</code>
                  </dd>
                  <dt>Время ревизии</dt>
                  <dd>
                    {collection.saved_configuration.committed_at ||
                      "Неизвестно"}
                  </dd>
                </dl>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
const running = (state: string) =>
  ["queued", "pending", "running"].includes(state);
const pollLabels: Record<string, string> = {
  queued: "В очереди",
  pending: "Ожидает запуска",
  running: "Выполняется",
  complete: "Завершена",
  completed: "Завершена",
  succeeded: "Завершена",
  error: "Ошибка",
  failed: "Ошибка",
  unknown: "Состояние неизвестно",
};
const resultColumns = [
  ["targets_total", "Адресов"],
  ["responders", "Ответили"],
  ["unresponsive", "Без ответа"],
  ["devices", "NetBox"],
  ["observed_hosts", "Адресов без SNMP"],
  ["interfaces_created", "Новых портов"],
  ["interfaces_updated", "Обновлено портов"],
  ["manual_conflicts", "Конфликтов"],
  ["errors", "Ошибок"],
] as const;
const mapLink = (network: Network) =>
  `/netmap/?scope=${encodeURIComponent("network-" + network.id)}`;

function pollResult(poll: Poll): Record<string, unknown> {
  const result = poll.result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result
    : {};
}

function pollValue(poll: Poll, key: string) {
  const value = pollResult(poll)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(value)
    : "—";
}

function PollErrors({ poll }: { poll: Poll }) {
  const values = pollResult(poll);
  const errors = Array.isArray(values.errors)
    ? values.errors.filter((item): item is string => typeof item === "string")
    : [];
  return (
    <>
      {poll.error && <p className="module-job-error">{poll.error}</p>}
      {typeof values.error === "string" && values.error !== poll.error && (
        <p className="module-job-error">{values.error}</p>
      )}
      {errors.length > 0 && (
        <ul>
          {errors.slice(0, 20).map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function PollSNMP({ poll }: { poll: Poll }) {
  const records = pollResult(poll).snmp_attempts;
  if (!Array.isArray(records) || records.length === 0) return null;
  return (
    <details>
      <summary>SNMP: какие профили ответили</summary>
      <ul>
        {records.slice(0, 100).map((record, index) => {
          if (
            !record ||
            typeof record.ip !== "string" ||
            !Array.isArray(record.attempts)
          )
            return null;
          return (
            <li key={index}>
              {record.ip}:{" "}
              {record.attempts
                .slice(0, 4)
                .map(
                  (attempt: { profile_id?: string; outcome?: string }) =>
                    `${attempt.profile_id || "Неизвестный профиль"} — ${attempt.outcome === "responded" ? "ответ получен" : "ответ не подтверждён"}`,
                )
                .join("; ")}
            </li>
          );
        })}
      </ul>
      {records.length > 100 && <p>Показаны первые 100 адресов.</p>}
    </details>
  );
}

type ObservationImportProps = {
  disabled: boolean;
  onImport: (
    source: string,
    records: Record<string, unknown>[],
    onSaved: () => void,
  ) => Promise<void>;
};

function ObservationImport({ disabled, onImport }: ObservationImportProps) {
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!file || disabled || reading) return;
    setReading(true);
    setError("");
    try {
      if (file.size > 3 * 1024 * 1024)
        throw new Error("Файл наблюдений должен быть не больше 3 MiB.");
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error("Не удалось прочитать JSON с наблюдениями.");
      }
      const records =
        data && typeof data === "object" && "records" in data
          ? data.records
          : data;
      if (
        !Array.isArray(records) ||
        records.length === 0 ||
        records.length > 4096 ||
        records.some(
          (record) =>
            !record || typeof record !== "object" || Array.isArray(record),
        )
      )
        throw new Error("Ожидается список records от 1 до 4096 наблюдений.");
      await onImport(source.trim(), records, () => {
        setFile(undefined);
        if (input.current) input.current.value = "";
      });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Не удалось прочитать файл наблюдений.",
      );
    } finally {
      setReading(false);
    }
  }

  return (
    <details className="netmap-add-network netmap-observation-import">
      <summary>
        <ChevronDown size={18} aria-hidden="true" />
        Импорт наблюдений
      </summary>
      <p className="module-hint">
        Данные DHCP, ARP и Wi-Fi дополняют карту адресами, которые не ответили
        на проверку. Источник и время сохраняются; наличие записи не означает,
        что устройство сейчас в сети.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="form-grid">
          <Field label="ID источника наблюдений">
            <input
              required
              maxLength={64}
              pattern="[A-Za-z0-9_.:\-]{1,64}"
              value={source}
              disabled={disabled || reading}
              onChange={(event) => setSource(event.target.value)}
            />
          </Field>
          <Field
            label="Файл наблюдений"
            hint="JSON со списком records, до 3 MiB."
          >
            <input
              ref={input}
              type="file"
              accept=".json,application/json"
              required
              disabled={disabled || reading}
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setError("");
              }}
            />
          </Field>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="netmap-form-actions">
          <Button
            type="submit"
            disabled={disabled || reading || !file || !source.trim()}
          >
            {reading ? "Импортируем…" : "Импортировать наблюдения"}
          </Button>
        </div>
      </form>
    </details>
  );
}

export default function NetMapModule({ instance }: { instance: Instance }) {
  return <NetMapSettings key={instance.id} instance={instance} />;
}

function NetMapSettings({ instance }: { instance: Instance }) {
  const enabled = instance.desired_state === "enabled";
  const base = `/modules/${instance.id}/netmap`;
  const networks = useAPI<Networks>(base + "/networks", enabled);
  const inventory = networks.data?.capabilities?.inventory === 1;
  const [selectedSection, setSelectedSection] = useState<NetMapSection>();
  const section =
    selectedSection || (networks.data && !inventory ? "networks" : "devices");
  const [legacyProfileOpen, setLegacyProfileOpen] = useState(false);
  const deviceAccess = networks.data?.capabilities?.device_access === 1;
  const orderedSNMP = networks.data?.capabilities?.ordered_snmp_profiles === 1;
  const profiles = useAPI<Items<Profile>>(base + "/profiles", enabled);
  const polls = useAPI<Items<Poll>>(base + "/polls", enabled);
  const networkItems = Array.isArray(networks.data?.items)
    ? networks.data.items
    : [];
  const profileItems = Array.isArray(profiles.data?.items)
    ? profiles.data.items
    : [];
  const pollItems = Array.isArray(polls.data?.items) ? polls.data.items : [];
  const pollsReady = Array.isArray(polls.data?.items) && !polls.error;
  const [selectedID, setSelectedID] = useState("");
  const selected =
    networkItems.find((item) => item.id === selectedID) || networkItems[0];
  const [name, setName] = useState("");
  const [cidr, setCidr] = useState("");
  const [networkProfile, setNetworkProfile] = useState("");
  const [networkAccess, setNetworkAccess] = useState<string>();
  const [snmpDraft, setSnmpDraft] = useState<string[]>();
  const [profileID, setProfileID] = useState("");
  const [community, setCommunity] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hostKeys, setHostKeys] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"success" | "info">("success");
  const [error, setError] = useState<unknown>();
  const [removing, setRemoving] = useState<Network>();
  const activePoll = pollItems.some((poll) => running(poll.state));
  const selectedProfile = profileItems.find((item) => item.id === profileID);
  const currentAccess = profileItems.find(
    (item) => item.id === selected?.profile,
  );
  const needsSNMP = orderedSNMP
    ? !selected?.snmp_profiles?.length
    : !currentAccess?.snmp_community_set;
  const profileInput = useRef<HTMLInputElement>(null);
  const selectedPolls = selected
    ? pollItems.filter((poll) => poll.network === selected.id)
    : pollItems;

  useEffect(() => {
    if (!enabled || !activePoll) return;
    const timer = window.setInterval(() => void polls.refetch(), 2000);
    return () => window.clearInterval(timer);
  }, [enabled, activePoll, polls.refetch]);

  async function reload() {
    await Promise.all([
      ...["networks", "profiles", "polls"].map((path) =>
        queryClient.invalidateQueries({ queryKey: [base + "/" + path] }),
      ),
      queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].startsWith(base + "/devices"),
      }),
    ]);
  }

  async function mutate<T>(
    action: string,
    path: string,
    body: unknown,
    message: string,
    onSaved?: (value: T) => void,
    kind: "success" | "info" = "success",
  ) {
    if (busy || !enabled) return;
    setBusy(action);
    setError(undefined);
    setNotice("");
    try {
      const value = await api<T>(base + path, "POST", body, {
        "Idempotency-Key": crypto.randomUUID(),
      });
      if (
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string"
      ) {
        throw new Error(value.error);
      }
      onSaved?.(value);
      setNoticeKind(kind);
      setNotice(message);
      await reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  function editProfile(id: string) {
    const profile = profileItems.find((item) => item.id === id);
    setProfileID(id);
    setCommunity("");
    setPassword("");
    setHostKeys("");
    setUsername(profile?.username || "");
    setModel(profile?.oxidized_model || "");
  }

  function configureNetworkProfile(id: string) {
    editProfile(id);
    setSelectedSection("access");
    setLegacyProfileOpen(true);
    requestAnimationFrame(() => profileInput.current?.focus());
  }

  return (
    <div className="modules-page netmap-page">
      <div className="page-title netmap-title">
        <div>
          <h1>NetMap</h1>
          <p>Карта сети и опрос устройств</p>
        </div>
        <div className="actions">
          {enabled && (
            <a className="button button-secondary" href="/netmap/">
              <Map size={17} aria-hidden="true" />
              Открыть карту
            </a>
          )}
          <a className="button button-secondary" href="#modules">
            К модулям
          </a>
        </div>
      </div>
      <ActionFeedback notice={notice} error={error} noticeKind={noticeKind} />
      {!enabled ? (
        <Empty
          title="NetMap отключён"
          detail="Включите модуль, чтобы открыть карту и настройки сетей."
        />
      ) : (
        <>
          <nav
            className="segmented netmap-sections"
            aria-label="Разделы NetMap"
          >
            {netMapSections.map(([value, label]) => (
              <Button
                key={value}
                variant={section === value ? "default" : "ghost"}
                aria-current={section === value ? "page" : undefined}
                onClick={() => setSelectedSection(value)}
              >
                {label}
              </Button>
            ))}
          </nav>
          {inventory && (
            <NetMapInventory
              base={base}
              enabled={enabled}
              networks={networkItems}
              view={
                section === "devices"
                  ? "devices"
                  : section === "access"
                    ? "profiles"
                    : "hidden"
              }
            />
          )}
          {section === "devices" && !inventory && (
            <Panel title="Устройства">
              {networks.error ? (
                <ErrorBox
                  error={networks.error}
                  retry={() => void networks.refetch()}
                />
              ) : networks.isPending ? (
                <p role="status">Загружаем возможности NetMap…</p>
              ) : (
                <Empty
                  title="Опрос устройств доступен после обновления NetMap"
                  detail="В разделе «Сети» можно проверить диапазон адресов."
                  action={
                    <a
                      className="button button-secondary"
                      href="#settings?section=updates"
                    >
                      Открыть обновления
                    </a>
                  }
                />
              )}
            </Panel>
          )}
          {section === "networks" && (
            <Panel
              title="Сети"
              className="netmap-networks"
              action={
                <Button
                  size="icon"
                  aria-label="Обновить данные"
                  title="Обновить данные"
                  onClick={() => void reload()}
                  disabled={!!busy}
                >
                  <RefreshCw size={18} aria-hidden="true" />
                </Button>
              }
            >
              <p className="module-hint">
                Проверка сети ищет устройства в диапазоне адресов. Профили SNMP
                добавляют сведения об оборудовании.
              </p>
              {networks.error && (
                <ErrorBox
                  error={networks.error}
                  retry={() => void networks.refetch()}
                />
              )}
              {!networks.data && !networks.error && (
                <p role="status">Загружаем сети…</p>
              )}
              {networks.data && !Array.isArray(networks.data.items) && (
                <ErrorBox
                  error={new Error("NetMap вернул некорректный список сетей")}
                />
              )}
              {networkItems.length > 0 ? (
                <>
                  <Field label="Выбранная сеть">
                    <select
                      value={selected?.id || ""}
                      disabled={!!busy}
                      onChange={(event) => {
                        setSelectedID(event.target.value);
                        setNetworkAccess(undefined);
                        setSnmpDraft(undefined);
                      }}
                    >
                      {networkItems.map((network) => (
                        <option key={network.id} value={network.id}>
                          {network.name} · {network.cidr}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {selected && (
                    <>
                      <div className="netmap-network-profile">
                        <label>
                          <span>
                            {deviceAccess
                              ? "SSH-профиль новых устройств"
                              : "Профиль"}
                          </span>
                          <select
                            aria-label="Профиль выбранной сети"
                            disabled={!!busy || activePoll || !!profiles.error}
                            value={networkAccess ?? selected.profile}
                            onChange={(event) =>
                              setNetworkAccess(event.target.value)
                            }
                          >
                            <option value="">Без профиля: ICMP/TCP</option>
                            {profileItems.map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        {networkAccess !== undefined &&
                          networkAccess !== selected.profile && (
                            <Button
                              size="icon"
                              aria-label="Применить профиль к сети"
                              disabled={
                                !!busy || activePoll || !!profiles.error
                              }
                              onClick={() =>
                                void mutate(
                                  "network-profile",
                                  "/networks",
                                  {
                                    cidr: selected.cidr,
                                    name: selected.name,
                                    profile: networkAccess,
                                    ...(orderedSNMP
                                      ? {
                                          snmp_profiles:
                                            selected.snmp_profiles ?? [],
                                        }
                                      : {}),
                                  },
                                  "Профиль сети обновлён.",
                                  () => setNetworkAccess(undefined),
                                )
                              }
                            >
                              <Check size={17} aria-hidden="true" />
                            </Button>
                          )}
                      </div>
                      {deviceAccess && (
                        <p className="module-hint">
                          Этот профиль назначается новым устройствам. Привязки
                          уже добавленных устройств сохраняются.
                        </p>
                      )}
                      {orderedSNMP && (
                        <>
                          <h3>SNMP-профили сети</h3>
                          {selected.snmp_profiles_invalid && (
                            <p role="alert">
                              Список SNMP-профилей требует исправления: профиль
                              удалён или в нём не задан SNMP community.
                            </p>
                          )}
                          <SNMPOrder
                            value={snmpDraft ?? selected.snmp_profiles ?? []}
                            profiles={profileItems}
                            disabled={!!busy || activePoll || !!profiles.error}
                            onChange={setSnmpDraft}
                          />
                          {snmpDraft !== undefined && (
                            <Button
                              disabled={
                                !!busy || activePoll || !!profiles.error
                              }
                              onClick={() =>
                                void mutate(
                                  "snmp-order",
                                  "/networks",
                                  {
                                    cidr: selected.cidr,
                                    name: selected.name,
                                    profile: selected.profile,
                                    snmp_profiles: snmpDraft,
                                  },
                                  "Порядок SNMP-профилей сохранён.",
                                  () => setSnmpDraft(undefined),
                                )
                              }
                            >
                              Сохранить SNMP-профили
                            </Button>
                          )}
                        </>
                      )}
                      <div className="actions netmap-network-actions">
                        <Button
                          variant="default"
                          disabled={
                            !!busy ||
                            activePoll ||
                            !pollsReady ||
                            !!networks.error
                          }
                          onClick={() =>
                            void mutate<{ id: string; state: string }>(
                              "poll",
                              "/networks/" +
                                encodeURIComponent(selected.id) +
                                "/poll",
                              {},
                              "Проверка запущена. Результат появится в истории.",
                              (value) => {
                                if (!value?.id || !running(value.state))
                                  throw new Error(
                                    "NetMap не подтвердил запуск проверки. Обновите историю.",
                                  );
                              },
                              "info",
                            )
                          }
                        >
                          <Play size={16} aria-hidden="true" />
                          {busy === "poll"
                            ? "Запускаем…"
                            : "Запустить проверку"}
                        </Button>
                        <a
                          className="button button-secondary"
                          href={mapLink(selected)}
                        >
                          <Map size={17} aria-hidden="true" />
                          На карте
                        </a>
                        <Button
                          variant="destructive"
                          size="icon"
                          aria-label="Удалить сеть"
                          title="Удалить сеть"
                          disabled={
                            !!busy ||
                            activePoll ||
                            !pollsReady ||
                            !!networks.error
                          }
                          onClick={() => setRemoving(selected)}
                        >
                          <Trash2 size={17} aria-hidden="true" />
                        </Button>
                      </div>
                      {needsSNMP && (
                        <div className="netmap-setup-note" role="note">
                          <Info size={17} aria-hidden="true" />
                          <div>
                            Проверка ищет ответы ICMP и TCP. SNMP необязателен:
                            он добавляет имя и интерфейсы устройства.
                            {selected.profile && (
                              <Button
                                size="sm"
                                onClick={() =>
                                  configureNetworkProfile(selected.profile)
                                }
                              >
                                Настроить профиль
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                      <ObservationImport
                        key={selected.id}
                        disabled={!!busy || activePoll || !!networks.error}
                        onImport={(source, records, onSaved) =>
                          mutate<{ accepted: number }>(
                            "observations",
                            "/networks/" +
                              encodeURIComponent(selected.id) +
                              "/observations",
                            { source, records },
                            "Наблюдения импортированы. Они доступны на карте выбранной сети.",
                            (value) => {
                              if (value?.accepted !== records.length)
                                throw new Error(
                                  "NetMap не подтвердил импорт всех наблюдений. Обновите карту.",
                                );
                              onSaved();
                            },
                          )
                        }
                      />
                    </>
                  )}
                </>
              ) : networks.data && Array.isArray(networks.data.items) ? (
                <p>Сетей пока нет. Добавьте первую сеть для инвентаризации.</p>
              ) : null}
              <details
                className="netmap-add-network"
                open={!networkItems.length}
              >
                <summary>
                  <ChevronDown size={18} aria-hidden="true" />
                  Добавить сеть
                </summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate<{ id: string }>(
                      "network",
                      "/networks",
                      {
                        cidr: cidr.trim(),
                        name: name.trim(),
                        profile: networkProfile,
                        ...(orderedSNMP ? { snmp_profiles: [] } : {}),
                      },
                      "Сеть сохранена.",
                      (value) => {
                        setSelectedID(value.id);
                        setNetworkAccess(undefined);
                        setName("");
                        setCidr("");
                      },
                    );
                  }}
                >
                  <div className="form-grid">
                    <Field label="Название сети">
                      <input
                        required
                        maxLength={128}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="CIDR"
                      hint="До 4096 адресов. Один хост — адрес с /32."
                    >
                      <input
                        required
                        value={cidr}
                        placeholder="192.0.2.0/24"
                        onChange={(event) => setCidr(event.target.value)}
                      />
                    </Field>
                    <Field
                      label={
                        deviceAccess
                          ? "SSH-профиль новых устройств"
                          : "Профиль доступа"
                      }
                      hint={
                        orderedSNMP
                          ? "После добавления сети задайте порядок SNMP-профилей отдельно."
                          : undefined
                      }
                    >
                      <select
                        value={networkProfile}
                        onChange={(event) =>
                          setNetworkProfile(event.target.value)
                        }
                      >
                        <option value="">Без профиля: ICMP/TCP</option>
                        {profileItems.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.id}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="netmap-form-actions">
                    <Button
                      type="submit"
                      disabled={
                        !!busy ||
                        !!profiles.error ||
                        !name.trim() ||
                        !cidr.trim()
                      }
                    >
                      {busy === "network" ? "Сохраняем…" : "Добавить сеть"}
                    </Button>
                  </div>
                </form>
              </details>
            </Panel>
          )}
          {section === "access" && (
            <>
              <Panel
                title="Доступ для SNMP и Oxidized"
                className="netmap-profiles"
                action={
                  <Button
                    size="sm"
                    aria-expanded={legacyProfileOpen}
                    onClick={() => setLegacyProfileOpen((open) => !open)}
                  >
                    {legacyProfileOpen
                      ? "Скрыть настройки"
                      : "Настроить профили"}
                  </Button>
                }
              >
                <p className="module-hint">
                  SNMP дополняет проверку сети именами и интерфейсами. Oxidized
                  сохраняет конфигурации оборудования в Gitea.
                </p>
                {profiles.error && (
                  <ErrorBox
                    error={profiles.error}
                    retry={() => void profiles.refetch()}
                  />
                )}
                {!profiles.data && !profiles.error && (
                  <p role="status">Загружаем профили…</p>
                )}
                {profiles.data && !Array.isArray(profiles.data.items) && (
                  <ErrorBox
                    error={
                      new Error("NetMap вернул некорректный список профилей")
                    }
                  />
                )}
                {legacyProfileOpen && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate(
                        "profile",
                        "/profiles",
                        {
                          id: profileID,
                          username,
                          oxidized_model: model,
                          ...(community ? { snmp_community: community } : {}),
                          ...(password ? { password } : {}),
                          ...(hostKeys.trim()
                            ? { ssh_known_hosts: hostKeys.trim() }
                            : {}),
                        },
                        "Профиль сохранён.",
                        () => {
                          setCommunity("");
                          setPassword("");
                          setHostKeys("");
                          setNetworkProfile(profileID);
                        },
                      );
                    }}
                  >
                    <div className="form-grid">
                      <Field label="Профиль">
                        <select
                          value={selectedProfile?.id || ""}
                          onChange={(event) => editProfile(event.target.value)}
                        >
                          <option value="">Новый профиль</option>
                          {profileItems.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.id}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label="ID профиля"
                        hint="Латинские строчные буквы, цифры, дефис и подчёркивание."
                      >
                        <input
                          ref={profileInput}
                          required
                          pattern={"[a-z0-9_\\-]{1,64}"}
                          maxLength={64}
                          value={profileID}
                          onChange={(event) => editProfile(event.target.value)}
                        />
                      </Field>
                      <Field
                        label="SNMP community"
                        hint={
                          selectedProfile?.snmp_community_set
                            ? "Сохранена. Пустое поле сохраняет текущее значение."
                            : "Необязательно. Добавляет имя и интерфейсы устройства."
                        }
                      >
                        <input
                          type="password"
                          autoComplete="new-password"
                          maxLength={1024}
                          value={community}
                          onChange={(event) => setCommunity(event.target.value)}
                        />
                      </Field>
                      <Field label="Модель Oxidized">
                        <input
                          pattern="[a-z][a-z0-9_]{0,63}"
                          maxLength={64}
                          placeholder="ios"
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                        />
                      </Field>
                      <Field label="Логин SSH">
                        <input
                          autoComplete="off"
                          maxLength={1024}
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                        />
                      </Field>
                      <Field
                        label="Пароль SSH"
                        hint={
                          selectedProfile?.password_set
                            ? "Сохранён. Пустое поле сохраняет текущее значение."
                            : "Для сбора конфигураций Oxidized."
                        }
                      >
                        <input
                          type="password"
                          autoComplete="new-password"
                          maxLength={1024}
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </Field>
                      <Field
                        label="SSH host keys (known_hosts)"
                        hint={
                          selectedProfile?.ssh_known_hosts_set
                            ? "Ключи сохранены. Пустое поле сохраняет текущие ключи."
                            : "Проверенные ключи: IP, тип и ключ сервера. Без них SSH-сбор завершится ошибкой."
                        }
                      >
                        <textarea
                          rows={3}
                          maxLength={65536}
                          spellCheck={false}
                          value={hostKeys}
                          onChange={(event) => setHostKeys(event.target.value)}
                        />
                      </Field>
                    </div>
                    <p className="module-hint">
                      ICMP/TCP работают без профиля. SNMP добавляет
                      инвентаризацию, SSH и модель — сбор конфигураций.
                      Сохранение профиля не запускает проверку сети.
                    </p>
                    <div className="netmap-form-actions">
                      <Button
                        type="submit"
                        disabled={!!busy || !profileID || !!profiles.error}
                      >
                        {busy === "profile"
                          ? "Сохраняем…"
                          : "Сохранить профиль"}
                      </Button>
                    </div>
                  </form>
                )}
                <nav
                  className="netmap-native-links"
                  aria-label="Сервисы NetMap"
                >
                  {[
                    ["NetBox", "/netmap/netbox/"],
                    ["Oxidized", "/netmap/oxidized/"],
                    ["Gitea", "/netmap/gitea/"],
                  ].map(([label, path]) => (
                    <a
                      key={path}
                      className="button button-secondary"
                      href={path}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {label}
                      <ExternalLink size={15} aria-hidden="true" />
                    </a>
                  ))}
                </nav>
              </Panel>
              {selected && deviceAccess && (
                <>
                  {networkItems.length > 1 && (
                    <div className="netmap-backup-network">
                      <Field label="Сеть для сбора конфигураций">
                        <select
                          disabled={!!busy}
                          value={selected.id}
                          onChange={(event) => {
                            setSelectedID(event.target.value);
                            setNetworkAccess(undefined);
                            setSnmpDraft(undefined);
                          }}
                        >
                          {networkItems.map((network) => (
                            <option key={network.id} value={network.id}>
                              {network.name} · {network.cidr}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  )}
                  <DeviceAccess
                    key={selected.id}
                    base={base}
                    network={selected}
                    profiles={profileItems}
                    disabled={
                      !!busy ||
                      activePoll ||
                      !!networks.error ||
                      !!profiles.error
                    }
                    setBusy={setBusy}
                  />
                </>
              )}
              {selected && !deviceAccess && (
                <p className="module-hint">
                  Настройка SSH для отдельных устройств доступна после
                  обновления NetMap.{" "}
                  <a href="#settings?section=updates">Открыть обновления</a>
                </p>
              )}
            </>
          )}
          {section === "networks" && (
            <Panel
              title="История проверок"
              className="netmap-history"
              action={
                <span className="netmap-count">{selectedPolls.length}</span>
              }
            >
              {polls.error && (
                <ErrorBox
                  error={polls.error}
                  retry={() => void polls.refetch()}
                />
              )}
              {!polls.data && !polls.error && (
                <p role="status">Загружаем проверки…</p>
              )}
              {polls.data && !Array.isArray(polls.data.items) && (
                <ErrorBox
                  error={
                    new Error("NetMap вернул некорректный список проверок")
                  }
                />
              )}
              {polls.data &&
                Array.isArray(polls.data.items) &&
                selectedPolls.length === 0 && (
                  <p>Проверки ещё не запускались.</p>
                )}
              {polls.error && pollItems.length > 0 && (
                <p className="module-hint">
                  Показаны сохранённые данные. Текущее состояние не получено.
                </p>
              )}
              {selectedPolls.length > 0 && (
                <div className="netmap-history-scroll">
                  <table aria-label="История проверок сетей">
                    <thead>
                      <tr>
                        <th>Сеть</th>
                        {resultColumns.map(([key, label]) => (
                          <th key={key}>{label}</th>
                        ))}
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedPolls.map((poll) => {
                        const network = networkItems.find(
                          (item) => item.id === poll.network,
                        );
                        const values = pollResult(poll);
                        const hasErrors =
                          !!poll.error ||
                          typeof values.error === "string" ||
                          (Array.isArray(values.errors) &&
                            values.errors.length > 0);
                        const icmpUnavailable =
                          Array.isArray(values.warnings) &&
                          values.warnings.includes("icmp_unavailable");
                        return (
                          <Fragment key={poll.id}>
                            <tr className="netmap-poll-row">
                              <td>
                                <strong>{network?.name || poll.network}</strong>
                                {network && <small>{network.cidr}</small>}
                              </td>
                              {resultColumns.map(([key]) => (
                                <td key={key} className="netmap-poll-value">
                                  {pollValue(poll, key)}
                                </td>
                              ))}
                              <td>
                                <Badge
                                  value={
                                    running(poll.state)
                                      ? "running"
                                      : ["error", "failed"].includes(poll.state)
                                        ? "error"
                                        : [
                                              "complete",
                                              "completed",
                                              "succeeded",
                                            ].includes(poll.state)
                                          ? "success"
                                          : "unknown"
                                  }
                                >
                                  {pollLabels[poll.state] ||
                                    "Состояние неизвестно"}
                                </Badge>
                              </td>
                            </tr>
                            {hasErrors && (
                              <tr className="netmap-poll-errors">
                                <td colSpan={resultColumns.length + 2}>
                                  <PollErrors poll={poll} />
                                </td>
                              </tr>
                            )}
                            {Array.isArray(pollResult(poll).snmp_attempts) && (
                              <tr>
                                <td colSpan={resultColumns.length + 2}>
                                  <PollSNMP poll={poll} />
                                </td>
                              </tr>
                            )}
                            {icmpUnavailable && (
                              <tr className="netmap-poll-warning">
                                <td colSpan={resultColumns.length + 2}>
                                  ICMP недоступен. Проверка использовала TCP;
                                  устройства без ответа на TCP могли остаться
                                  необнаруженными.
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}
        </>
      )}
      {removing && (
        <Dialog
          title="Удалить сеть?"
          description={`${removing.name} · ${removing.cidr}. Инвентаризация NetBox и история конфигураций сохранятся.`}
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <div className="actions">
            <Button disabled={!!busy} onClick={() => setRemoving(undefined)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() =>
                void mutate<{ removed: boolean }>(
                  "remove",
                  "/networks/" + encodeURIComponent(removing.id) + "/remove",
                  {},
                  "Сеть удалена.",
                  (value) => {
                    if (value?.removed !== true)
                      throw new Error(
                        "NetMap не подтвердил удаление сети. Обновите данные.",
                      );
                    setRemoving(undefined);
                    setSelectedID("");
                  },
                )
              }
            >
              {busy === "remove" ? "Удаляем…" : "Удалить"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
