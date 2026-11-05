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
import "./netmap-module.css";

type Instance = { id: string; name: string; desired_state: string };
type Network = { id: string; cidr: string; name: string; profile: string };
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
  const networks = useAPI<Items<Network>>(base + "/networks", enabled);
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
  const needsSNMP = !currentAccess?.snmp_community_set;
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
    await Promise.all(
      ["networks", "profiles", "polls"].map((path) =>
        queryClient.invalidateQueries({ queryKey: [base + "/" + path] }),
      ),
    );
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

  return (
    <div className="modules-page netmap-page">
      <div className="page-title netmap-title">
        <div className="netmap-header-main">
          <div>
            <h1>NetMap</h1>
            <p>Сети и конфигурации</p>
          </div>
          {enabled && (
            <nav className="netmap-native-links" aria-label="Сервисы NetMap">
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
          )}
        </div>
        <div className="actions">
          {enabled && (
            <a className="button button-primary" href="/netmap/">
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
          <div className="netmap-settings-grid">
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
                          <span>Профиль</span>
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
                                onClick={() => {
                                  editProfile(selected.profile);
                                  profileInput.current?.focus();
                                }}
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
              <details className="netmap-add-network" open>
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
                    <Field label="Профиль доступа">
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
            <Panel title="Профили доступа" className="netmap-profiles">
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
                  ICMP/TCP работают без профиля. SNMP добавляет инвентаризацию,
                  SSH и модель — сбор конфигураций. Сохранение профиля не
                  запускает проверку сети.
                </p>
                <div className="netmap-form-actions">
                  <Button
                    type="submit"
                    disabled={!!busy || !profileID || !!profiles.error}
                  >
                    {busy === "profile" ? "Сохраняем…" : "Сохранить профиль"}
                  </Button>
                </div>
              </form>
            </Panel>
          </div>
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
                error={new Error("NetMap вернул некорректный список проверок")}
              />
            )}
            {polls.data &&
              Array.isArray(polls.data.items) &&
              selectedPolls.length === 0 && <p>Проверки ещё не запускались.</p>}
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
