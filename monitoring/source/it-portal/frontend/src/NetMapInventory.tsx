import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { ActionFeedback } from "./ActionNotifications";
import { APIError, api, useAPI } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";

type Kind = "network" | "linux" | "windows";
type Network = { id: string; name: string; cidr: string };
type Items<T> = { items: T[] };
type Profile = {
  id: string;
  name: string;
  kind: Kind;
  username: string;
  port: number;
  driver?: string;
  auth_method?: "password" | "key";
  password_set?: boolean;
  private_key_set?: boolean;
  passphrase_set?: boolean;
  enable_password_set?: boolean;
  ssh_known_hosts_set?: boolean;
  ca_pem_set?: boolean;
  scheme?: "https" | "http";
  transport?: "ntlm";
};
type Target = {
  id: string;
  name: string;
  kind: Kind;
  address: string;
  profile_id: string;
  network_id?: string;
  interval_minutes?: number;
};
type Summary = {
  hostname?: string;
  os_name?: string;
  os_version?: string;
  manufacturer?: string;
  model?: string;
  serial?: string;
  cpu_count?: number;
  memory_mib?: number;
  virtualization?: string;
  interfaces?: number;
  addresses?: number;
  disks?: number;
};
type Job = {
  id: string;
  target_id: string;
  target_name?: string;
  kind?: Kind;
  address?: string;
  state: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  result?: {
    summary?: Summary;
    sync?: {
      created?: number;
      updated?: number;
      unchanged?: number;
      conflicts?: number;
      errors?: number;
      object_type?: string;
      object_id?: number;
      warnings?: string[];
    };
    warnings?: string[];
    [key: string]: unknown;
  };
};
type ProfileDraft = {
  id?: string;
  name: string;
  kind: Kind;
  username: string;
  port: string;
  driver: string;
  auth_method: "password" | "key";
  password: string;
  private_key: string;
  passphrase: string;
  enable_password: string;
  ssh_known_hosts: string;
  ca_pem: string;
  scheme: "https" | "http";
  clear_secrets: string[];
};
type TargetDraft = Omit<Target, "id" | "interval_minutes"> & {
  id?: string;
  interval_minutes: string;
};

const kinds: Record<Kind, string> = {
  network: "Сетевое оборудование · SSH",
  linux: "Linux · SSH",
  windows: "Windows · WinRM",
};
const drivers: Record<string, string> = {
  huawei_vrp: "Huawei VRP",
  cisco_ios: "Cisco IOS / IOS XE",
  junos: "Juniper Junos",
};
const states: Record<string, [string, string]> = {
  queued: ["unknown", "В очереди"],
  running: ["warning", "Собираем данные"],
  succeeded: ["healthy", "Данные обновлены"],
  partial: ["warning", "Обновлено частично"],
  failed: ["error", "Ошибка сбора"],
};
const explanations: Record<string, string> = {
  inventory_profile_invalid: "Проверьте поля профиля доступа.",
  inventory_target_invalid:
    "Проверьте адрес, профиль доступа и выбранную сеть.",
  inventory_invalid_profile: "Проверьте поля профиля доступа.",
  inventory_invalid_target: "Проверьте поля устройства.",
  inventory_invalid_address:
    "Укажите IP-адрес устройства, доступный с хоста PL. Служебные и локальные адреса использовать нельзя.",
  inventory_invalid_name: "Укажите короткое название без переноса строки.",
  inventory_profile_kind_changed:
    "Тип сохранённого профиля изменить нельзя. Создайте профиль нужного типа.",
  inventory_profile_mismatch:
    "Выберите профиль для указанного типа устройства.",
  inventory_network_mismatch:
    "IP-адрес устройства должен входить в выбранную сеть NetMap.",
  inventory_invalid_interval:
    "Выберите запуск по кнопке или интервал от 5 минут до суток.",
  inventory_profile_busy:
    "Профиль сейчас используется для сбора. Дождитесь завершения и сохраните изменения.",
  inventory_target_busy:
    "Устройство сейчас опрашивается. Дождитесь завершения сбора.",
  inventory_address_exists:
    "Устройство с таким IP-адресом уже добавлено. Измените его существующую запись.",
  inventory_interrupted:
    "Сбор прерван перезапуском NetMap. Запустите его повторно.",
  inventory_writer_busy:
    "NetMap занят обновлением другой сети. Повторите сбор после завершения её опроса.",
  inventory_sync_failed:
    "Сведения получены, но обновление NetBox не завершилось. Проверьте его доступность и повторите сбор.",
  inventory_collection_failed:
    "Сведения об устройстве не получены. Проверьте доступ и повторите сбор.",
  inventory_profile_limit:
    "Достигнут предел в 128 профилей доступа. Удалите неиспользуемый профиль.",
  inventory_target_limit: "Достигнут предел в 2048 устройств для опроса.",
  inventory_driver_unsupported:
    "Выберите поддерживаемую операционную систему оборудования.",
  inventory_dependency_missing:
    "В установленной сборке NetMap отсутствует нужный сборщик. Обновите модуль.",
  inventory_timeout:
    "Устройство не ответило за отведённое время. Проверьте доступность и повторите сбор.",
  inventory_output_limit:
    "Ответ устройства превысил допустимый размер. Проверьте число интерфейсов и результат команд просмотра.",
  inventory_auth_failed:
    "Устройство отклонило доступ. Проверьте пользователя, пароль или ключ и права на чтение сведений.",
  inventory_host_key_failed:
    "SSH-ключ устройства не совпадает с доверенным. Проверьте отпечаток и список ключей в профиле.",
  inventory_tls_failed:
    "Не удалось проверить сертификат WinRM. Проверьте IP-адрес в сертификате и доверенный центр сертификации.",
  inventory_connection_failed:
    "Не удалось подключиться. Проверьте адрес, порт и доступ с хоста PL.",
  inventory_command_failed:
    "Не удалось прочитать сведения об устройстве. Проверьте права учётной записи и выбранную систему оборудования.",
  inventory_output_invalid:
    "Не удалось разобрать ответ устройства. Проверьте выбранную систему оборудования.",
  inventory_profile_in_use:
    "Этот профиль используется. Сначала выберите другой профиль у его устройств.",
  profile_in_use:
    "Этот профиль используется. Сначала выберите другой профиль у его устройств.",
  inventory_profile_missing: "Профиль доступа удалён. Выберите другой профиль.",
  inventory_target_missing: "Устройство удалено. Обновите список.",
  inventory_busy:
    "Все сборщики заняты. Повторите запуск через несколько секунд.",
  inventory_job_interrupted:
    "Сбор прерван перезапуском NetMap. Запустите его повторно.",
  ssh_auth_failed:
    "Устройство отклонило SSH-доступ. Проверьте пользователя, пароль или ключ.",
  ssh_host_key_missing:
    "Добавьте доверенный SSH-ключ устройства в профиль доступа.",
  ssh_host_key_unknown:
    "SSH-ключ устройства не найден среди доверенных ключей профиля.",
  ssh_host_key_mismatch:
    "SSH-ключ устройства изменился. Проверьте его отпечаток перед обновлением профиля.",
  ssh_connection_failed:
    "Не удалось подключиться по SSH. Проверьте адрес, порт и доступ с хоста PL.",
  collection_timeout:
    "Устройство не ответило за отведённое время. Проверьте доступность и повторите сбор.",
  winrm_auth_failed:
    "Сервер отклонил WinRM-доступ. Проверьте пользователя и его права на чтение CIM.",
  winrm_connection_failed:
    "Не удалось подключиться к WinRM. Проверьте адрес, порт и доступ с хоста PL.",
  winrm_tls_failed:
    "Не удалось проверить сертификат WinRM. Проверьте имя в сертификате и доверенный центр сертификации.",
  netbox_conflict:
    "В NetBox уже есть данные с другим владельцем. Проверьте привязку устройства и ручные изменения.",
  inventory_network_attachment_required:
    "Устройство уже найдено по SNMP. Выберите его сеть в настройках опроса.",
  inventory_network_attachment_conflict:
    "Привязка к сети не совпадает с данными NetBox. Проверьте выбранную сеть и карточку устройства.",
  inventory_foreign_owner:
    "Объект NetBox принадлежит другому источнику. Его данные сохранены.",
  inventory_object_kind_changed:
    "Тип устройства изменился между физическим и виртуальным. Проверьте его карточку NetBox перед повторным сбором.",
  inventory_manual_value_preserved: "Ручные изменения в NetBox сохранены.",
  inventory_netbox_write_failed:
    "Часть сведений не удалось записать в NetBox. Проверьте его доступность и повторите сбор.",
  inventory_invalid_address_observation:
    "В ответе устройства есть некорректный IP-адрес. Он пропущен.",
  inventory_invalid_mac_observation:
    "В ответе устройства есть некорректный MAC-адрес. Он пропущен.",
  address_invalid: "Часть IP-адресов в ответе устройства не удалось разобрать.",
  ip_tool_unavailable:
    "На Linux-сервере недоступна команда ip. Сведения об IP-адресах получены не полностью.",
  disk_tool_unavailable: "Не удалось получить список дисков Linux-сервера.",
  serial_unavailable: "Устройство не предоставило серийный номер.",
  model_unavailable: "Устройство не предоставило название модели.",
  virtualization_unconfirmed:
    "Сервер не подтвердил, является ли он виртуальной машиной. Тип требует проверки в NetBox.",
  interface_provider_unavailable:
    "Системный источник сведений об интерфейсах недоступен.",
  interfaces_unavailable:
    "Сведения об интерфейсах не получены. Проверьте права учётной записи.",
};

function failureText(failure: unknown): Error {
  const code = failure instanceof APIError ? failure.code : "";
  return new Error(
    explanations[code] ||
      (failure instanceof Error && !/^[a-z][a-z0-9_]+$/.test(failure.message)
        ? failure.message
        : "Не удалось выполнить действие. Проверьте подключение и повторите попытку."),
  );
}

function jobLabel(job?: Job) {
  const [tone, label] = job
    ? states[job.state] || ["unknown", "Состояние неизвестно"]
    : ["unknown", "Ещё не опрашивалось"];
  return <Badge value={tone}>{label}</Badge>;
}

function dateLabel(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function emptyProfile(kind: Kind = "network"): ProfileDraft {
  return {
    name: "",
    kind,
    username: "",
    port: kind === "windows" ? "5986" : "22",
    driver: "huawei_vrp",
    auth_method: "password",
    password: "",
    private_key: "",
    passphrase: "",
    enable_password: "",
    ssh_known_hosts: "",
    ca_pem: "",
    scheme: "https",
    clear_secrets: [],
  };
}

export default function NetMapInventory({
  base,
  enabled = true,
  networks = [],
}: {
  base: string;
  enabled?: boolean;
  networks?: Network[];
}) {
  const endpoint = base + "/inventory";
  const profiles = useAPI<Items<Profile>>(endpoint + "/profiles", enabled);
  const targets = useAPI<Items<Target>>(endpoint + "/targets", enabled);
  const jobs = useAPI<Items<Job>>(endpoint + "/jobs", enabled);
  const profileItems = Array.isArray(profiles.data?.items)
    ? profiles.data.items
    : [];
  const targetItems = Array.isArray(targets.data?.items)
    ? targets.data.items
    : [];
  const jobItems = Array.isArray(jobs.data?.items) ? jobs.data.items : [];
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>();
  const [targetDraft, setTargetDraft] = useState<TargetDraft>();
  const [testing, setTesting] = useState<Profile>();
  const [testAddress, setTestAddress] = useState("");
  const [testResult, setTestResult] = useState<Summary>();
  const [removing, setRemoving] = useState<{
    type: "profiles" | "targets";
    id: string;
    name: string;
  }>();
  const [selectedJob, setSelectedJob] = useState<string>();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>();
  const pending = useRef(false);
  const hasPending = jobItems.some((job) =>
    ["queued", "running"].includes(job.state),
  );
  const selected = jobItems.find((job) => job.id === selectedJob);
  const selectedWarnings = [
    ...new Set(
      [
        ...(selected?.result?.warnings || []),
        ...(selected?.result?.sync?.warnings || []),
      ].map(
        (warning) =>
          explanations[warning] ||
          "Часть сведений не удалось обновить. Проверьте данные устройства в NetBox.",
      ),
    ),
  ];
  const existingProfile = profileItems.find(
    (profile) => profile.id === profileDraft?.id,
  );
  const latestJobs = new Map<string, Job>();
  for (const job of jobItems) {
    const previous = latestJobs.get(job.target_id);
    if (!previous || job.created_at > previous.created_at)
      latestJobs.set(job.target_id, job);
  }

  useEffect(() => {
    if (!enabled || !hasPending) return;
    const timer = window.setInterval(() => void jobs.refetch(), 2000);
    const deadline = window.setTimeout(
      () => window.clearInterval(timer),
      15 * 60 * 1000,
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(deadline);
    };
  }, [enabled, hasPending, jobs.refetch]);

  async function reload() {
    await Promise.all([profiles.refetch(), targets.refetch(), jobs.refetch()]);
  }

  async function mutate<T>(
    action: string,
    path: string,
    method: "POST" | "DELETE",
    body: unknown,
    success: (value: T) => void,
  ) {
    if (!enabled || pending.current) return;
    pending.current = true;
    setBusy(action);
    setError(undefined);
    setNotice("");
    try {
      const value = await api<T>(endpoint + path, method, body, {
        "Idempotency-Key": crypto.randomUUID(),
      });
      success(value);
      await reload();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy("");
      pending.current = false;
    }
  }

  function editProfile(profile: Profile) {
    setError(undefined);
    setProfileDraft({
      ...emptyProfile(profile.kind),
      id: profile.id,
      name: profile.name,
      username: profile.username,
      port: String(profile.port),
      driver: profile.driver || "huawei_vrp",
      auth_method:
        profile.auth_method || (profile.private_key_set ? "key" : "password"),
      scheme: profile.scheme || "https",
    });
  }

  function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!profileDraft) return;
    const {
      password,
      private_key,
      passphrase,
      enable_password,
      ssh_known_hosts,
      ca_pem,
      clear_secrets,
      ...fields
    } = profileDraft;
    const body: Record<string, unknown> = {
      ...fields,
      port: Number(fields.port),
    };
    if (clear_secrets.length) body.clear_secrets = clear_secrets;
    if (fields.kind === "windows") {
      body.transport = "ntlm";
      delete body.driver;
      delete body.auth_method;
      if (password) body.password = password;
      if (ca_pem.trim()) body.ca_pem = ca_pem.trim();
    } else {
      delete body.scheme;
      if (fields.kind !== "network") delete body.driver;
      if (fields.auth_method === "key") {
        if (private_key.trim()) body.private_key = private_key.trim();
        if (passphrase) body.passphrase = passphrase;
      } else if (password) body.password = password;
      if (ssh_known_hosts.trim()) body.ssh_known_hosts = ssh_known_hosts.trim();
      if (fields.kind === "network" && enable_password)
        body.enable_password = enable_password;
    }
    void mutate("profile-save", "/profiles", "POST", body, () => {
      setProfileDraft(undefined);
      setNotice("Профиль доступа сохранён.");
    });
  }

  function clearSecret(name: string, checked: boolean) {
    setProfileDraft((draft) =>
      draft
        ? {
            ...draft,
            [name]: "",
            clear_secrets: checked
              ? [...new Set([...draft.clear_secrets, name])]
              : draft.clear_secrets.filter((item) => item !== name),
          }
        : draft,
    );
  }

  function newTarget() {
    const first = profileItems[0];
    setError(undefined);
    setTargetDraft({
      name: "",
      kind: first?.kind || "network",
      address: "",
      profile_id: first?.id || "",
      network_id: "",
      interval_minutes: "0",
    });
  }

  if (!enabled) return null;

  return (
    <div className="netmap-inventory netmap-history">
      <ActionFeedback notice={notice} error={error} />
      <Panel
        title="Автонаполнение NetBox"
        icon={<Server size={20} aria-hidden="true" />}
        action={
          <div className="actions">
            <Button
              size="sm"
              onClick={() => void reload()}
              disabled={!!busy}
              aria-label="Обновить инвентаризацию"
            >
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={newTarget}
              disabled={!!busy || !profileItems.length}
            >
              <Plus size={16} aria-hidden="true" /> Добавить устройство
            </Button>
          </div>
        }
      >
        <p className="module-hint">
          Добавьте оборудование или сервер: PL прочитает сведения об устройстве,
          его интерфейсах и IP-адресах и сохранит их в NetBox. Конфигурации
          сетевого оборудования по-прежнему собирает Oxidized, историю хранит
          Gitea.
        </p>
        {targets.error && (
          <ErrorBox
            error={failureText(targets.error)}
            retry={() => void targets.refetch()}
          />
        )}
        {jobs.error && (
          <ErrorBox
            error={failureText(jobs.error)}
            retry={() => void jobs.refetch()}
          />
        )}
        {!targets.data && !targets.error && (
          <p role="status">Загружаем устройства…</p>
        )}
        {targets.data && !Array.isArray(targets.data.items) && (
          <ErrorBox
            error={new Error("Не удалось прочитать список устройств.")}
          />
        )}
        {targets.data && !targetItems.length && !targets.error ? (
          <Empty
            title="Устройства ещё не добавлены"
            detail={
              profileItems.length
                ? "Укажите адрес устройства и выберите профиль доступа для первого сбора."
                : "Сначала добавьте профиль доступа ниже: его можно использовать для нескольких устройств."
            }
            action={
              !profileItems.length && (
                <Button
                  size="sm"
                  onClick={() => {
                    setError(undefined);
                    setProfileDraft(emptyProfile());
                  }}
                  disabled={!!busy}
                >
                  Добавить профиль доступа
                </Button>
              )
            }
          />
        ) : targetItems.length ? (
          <div className="netmap-history-scroll">
            <table>
              <thead>
                <tr>
                  <th>Устройство</th>
                  <th>Доступ и расписание</th>
                  <th>Последний сбор</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {targetItems.map((target) => {
                  const profile = profileItems.find(
                    (item) => item.id === target.profile_id,
                  );
                  const job = latestJobs.get(target.id);
                  const collecting =
                    !!job && ["queued", "running"].includes(job.state);
                  return (
                    <tr key={target.id}>
                      <td>
                        <strong>{target.name || target.address}</strong>
                        <br />
                        <small>
                          {target.address} · {kinds[target.kind]}
                        </small>
                      </td>
                      <td>
                        {profile?.name || "Профиль недоступен"}
                        <br />
                        <small>
                          {target.interval_minutes
                            ? `Каждые ${target.interval_minutes} мин`
                            : "По кнопке"}
                        </small>
                      </td>
                      <td>
                        {jobLabel(job)}
                        <br />
                        <small>
                          {dateLabel(job?.finished_at || job?.started_at)}
                        </small>
                        {job && (
                          <div>
                            <Button
                              size="sm"
                              onClick={() => setSelectedJob(job.id)}
                            >
                              Результат
                            </Button>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="actions">
                          <Button
                            size="sm"
                            disabled={!!busy || collecting || !profile}
                            onClick={() =>
                              void mutate<{ id?: string }>(
                                "collect-" + target.id,
                                "/targets/" + target.id + "/collect",
                                "POST",
                                {},
                                () =>
                                  setNotice(
                                    "Сбор поставлен в очередь. Результат появится здесь.",
                                  ),
                              )
                            }
                          >
                            <Play size={14} aria-hidden="true" />
                            {collecting ? "Сбор выполняется" : "Опросить"}
                          </Button>
                          <Button
                            size="sm"
                            aria-label={`Изменить устройство ${target.name || target.address}`}
                            disabled={!!busy || collecting}
                            onClick={() => {
                              setError(undefined);
                              setTargetDraft({
                                ...target,
                                interval_minutes: String(
                                  target.interval_minutes || 0,
                                ),
                              });
                            }}
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </Button>
                          <Button
                            size="sm"
                            aria-label={`Удалить устройство ${target.name || target.address}`}
                            disabled={!!busy || collecting}
                            onClick={() =>
                              setRemoving({
                                type: "targets",
                                id: target.id,
                                name: target.name || target.address,
                              })
                            }
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Профили для опроса"
        action={
          <Button
            size="sm"
            onClick={() => {
              setError(undefined);
              setProfileDraft(emptyProfile());
            }}
            disabled={!!busy}
          >
            <Plus size={16} aria-hidden="true" /> Добавить профиль
          </Button>
        }
      >
        <p className="module-hint">
          В одной сети могут быть разные учётные записи. Создайте нужные профили
          и выберите подходящий для каждого устройства.
        </p>
        {profiles.error && (
          <ErrorBox
            error={failureText(profiles.error)}
            retry={() => void profiles.refetch()}
          />
        )}
        {!profiles.data && !profiles.error && (
          <p role="status">Загружаем профили…</p>
        )}
        {profiles.data && !Array.isArray(profiles.data.items) && (
          <ErrorBox
            error={new Error("Не удалось прочитать список профилей доступа.")}
          />
        )}
        {profileItems.length > 0 && (
          <div className="netmap-history-scroll">
            <table>
              <thead>
                <tr>
                  <th>Профиль</th>
                  <th>Подключение</th>
                  <th>Используется</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {profileItems.map((profile) => {
                  const used = targetItems.filter(
                    (target) => target.profile_id === profile.id,
                  ).length;
                  return (
                    <tr key={profile.id}>
                      <td>
                        <strong>{profile.name}</strong>
                        <br />
                        <small>
                          {kinds[profile.kind]}
                          {profile.driver &&
                            ` · ${drivers[profile.driver] || profile.driver}`}
                        </small>
                      </td>
                      <td>
                        {profile.username} · порт {profile.port}
                        <br />
                        <small>
                          {profile.kind === "windows"
                            ? profile.scheme === "http"
                              ? "HTTP · NTLM с шифрованием"
                              : "HTTPS · проверка сертификата"
                            : profile.private_key_set
                              ? "Ключ SSH"
                              : "Пароль SSH"}
                        </small>
                      </td>
                      <td>{used ? `${used} устр.` : "Не назначен"}</td>
                      <td>
                        <div className="actions">
                          <Button
                            size="sm"
                            disabled={!!busy}
                            onClick={() => {
                              setError(undefined);
                              setTestAddress(
                                targetItems.find(
                                  (target) => target.profile_id === profile.id,
                                )?.address || "",
                              );
                              setTestResult(undefined);
                              setTesting(profile);
                            }}
                          >
                            <Check size={14} aria-hidden="true" /> Проверить
                            доступ
                          </Button>
                          <Button
                            size="sm"
                            disabled={!!busy}
                            onClick={() => editProfile(profile)}
                            aria-label={`Изменить профиль ${profile.name}`}
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </Button>
                          <Button
                            size="sm"
                            disabled={
                              !!busy ||
                              !!used ||
                              !!targets.error ||
                              !targets.data
                            }
                            title={
                              used
                                ? "Сначала назначьте устройствам другой профиль"
                                : undefined
                            }
                            onClick={() =>
                              setRemoving({
                                type: "profiles",
                                id: profile.id,
                                name: profile.name,
                              })
                            }
                            aria-label={`Удалить профиль ${profile.name}`}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {profileDraft && (
        <Dialog
          title={
            profileDraft.id
              ? "Изменить профиль доступа"
              : "Добавить профиль доступа"
          }
          onClose={() => {
            if (!busy) {
              setProfileDraft(undefined);
              setError(undefined);
            }
          }}
          wide
        >
          <form onSubmit={saveProfile}>
            <div className="form-grid">
              <Field label="Название">
                <input
                  autoFocus
                  value={profileDraft.name}
                  required
                  maxLength={120}
                  placeholder="Например, коммутаторы офиса"
                  disabled={!!busy}
                  onChange={(event) =>
                    setProfileDraft({
                      ...profileDraft,
                      name: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Что опрашиваем">
                <select
                  value={profileDraft.kind}
                  disabled={!!busy || !!profileDraft.id}
                  onChange={(event) => {
                    const kind = event.target.value as Kind;
                    setProfileDraft({
                      ...emptyProfile(kind),
                      name: profileDraft.name,
                    });
                  }}
                >
                  {Object.entries(kinds).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Пользователь"
                hint={
                  profileDraft.kind === "windows"
                    ? "Локальная или доменная учётная запись с правами чтения CIM: ДОМЕН\\пользователь."
                    : profileDraft.kind === "linux"
                      ? "Учётная запись SSH с доступом на чтение. На Linux должен быть установлен Python 3."
                      : "Учётная запись с доступом на чтение сведений об устройстве."
                }
              >
                <input
                  autoComplete="off"
                  aria-label="Пользователь"
                  value={profileDraft.username}
                  required
                  maxLength={256}
                  disabled={!!busy}
                  onChange={(event) =>
                    setProfileDraft({
                      ...profileDraft,
                      username: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Порт">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={profileDraft.port}
                  required
                  disabled={!!busy}
                  onChange={(event) =>
                    setProfileDraft({
                      ...profileDraft,
                      port: event.target.value,
                    })
                  }
                />
              </Field>
              {profileDraft.kind === "network" && (
                <Field label="Операционная система оборудования">
                  <select
                    value={profileDraft.driver}
                    disabled={!!busy}
                    onChange={(event) => {
                      const driver = event.target.value;
                      setProfileDraft({
                        ...profileDraft,
                        driver,
                        enable_password:
                          driver === "cisco_ios"
                            ? profileDraft.enable_password
                            : "",
                        clear_secrets:
                          driver !== "cisco_ios" &&
                          existingProfile?.enable_password_set
                            ? [
                                ...new Set([
                                  ...profileDraft.clear_secrets,
                                  "enable_password",
                                ]),
                              ]
                            : profileDraft.clear_secrets.filter(
                                (name) => name !== "enable_password",
                              ),
                      });
                    }}
                  >
                    {Object.entries(drivers).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {profileDraft.kind !== "windows" && (
                <Field label="Способ входа">
                  <select
                    value={profileDraft.auth_method}
                    disabled={!!busy}
                    onChange={(event) =>
                      setProfileDraft({
                        ...profileDraft,
                        auth_method: event.target.value as "password" | "key",
                        password: "",
                        private_key: "",
                        passphrase: "",
                      })
                    }
                  >
                    <option value="password">Пароль</option>
                    <option value="key">Ключ SSH</option>
                  </select>
                </Field>
              )}
              {(profileDraft.kind === "windows" ||
                profileDraft.auth_method === "password") && (
                <Field
                  label="Пароль"
                  hint={
                    existingProfile?.password_set
                      ? "Пароль сохранён. Оставьте поле пустым, чтобы использовать его."
                      : undefined
                  }
                >
                  <input
                    type="password"
                    aria-label="Пароль"
                    autoComplete="new-password"
                    value={profileDraft.password}
                    required={!existingProfile?.password_set}
                    maxLength={4096}
                    disabled={!!busy}
                    onChange={(event) =>
                      setProfileDraft({
                        ...profileDraft,
                        password: event.target.value,
                      })
                    }
                  />
                </Field>
              )}
              {profileDraft.kind === "windows" && (
                <Field label="Соединение WinRM">
                  <select
                    value={profileDraft.scheme}
                    disabled={!!busy}
                    onChange={(event) => {
                      const scheme = event.target.value as "https" | "http";
                      setProfileDraft({
                        ...profileDraft,
                        scheme,
                        port: ["5985", "5986"].includes(profileDraft.port)
                          ? scheme === "https"
                            ? "5986"
                            : "5985"
                          : profileDraft.port,
                        ca_pem: scheme === "http" ? "" : profileDraft.ca_pem,
                        clear_secrets:
                          scheme === "http" && existingProfile?.ca_pem_set
                            ? [
                                ...new Set([
                                  ...profileDraft.clear_secrets,
                                  "ca_pem",
                                ]),
                              ]
                            : profileDraft.clear_secrets.filter(
                                (name) => name !== "ca_pem",
                              ),
                      });
                    }}
                  >
                    <option value="https">HTTPS · порт 5986</option>
                    <option value="http">
                      HTTP · NTLM с шифрованием · порт 5985
                    </option>
                  </select>
                </Field>
              )}
            </div>
            {profileDraft.kind !== "windows" &&
              profileDraft.auth_method === "key" && (
                <>
                  <Field
                    label="Закрытый ключ SSH"
                    hint={
                      existingProfile?.private_key_set
                        ? "Ключ сохранён. Заполняйте поле только для его замены."
                        : "Вставьте ключ в формате OpenSSH или PEM. Он сохраняется только в настройках сборщика."
                    }
                  >
                    <textarea
                      rows={5}
                      autoComplete="off"
                      spellCheck={false}
                      value={profileDraft.private_key}
                      required={!existingProfile?.private_key_set}
                      maxLength={32768}
                      disabled={!!busy}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          private_key: event.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="Пароль ключа, если задан"
                    hint={
                      existingProfile?.passphrase_set
                        ? "Пароль ключа сохранён. Пустое поле сохраняет его."
                        : undefined
                    }
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={profileDraft.passphrase}
                      maxLength={4096}
                      disabled={
                        !!busy ||
                        profileDraft.clear_secrets.includes("passphrase")
                      }
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          passphrase: event.target.value,
                        })
                      }
                    />
                  </Field>
                  {existingProfile?.passphrase_set && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={profileDraft.clear_secrets.includes(
                          "passphrase",
                        )}
                        disabled={!!busy}
                        onChange={(event) =>
                          clearSecret("passphrase", event.target.checked)
                        }
                      />
                      Ключ больше не защищён паролем
                    </label>
                  )}
                </>
              )}
            {profileDraft.kind === "network" &&
              profileDraft.driver === "cisco_ios" && (
                <>
                  <Field
                    label="Пароль привилегированного режима, если нужен"
                    hint={
                      existingProfile?.enable_password_set
                        ? "Пароль сохранён. Пустое поле сохраняет его."
                        : "Для оборудования, которое требует отдельный пароль для команд просмотра."
                    }
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={profileDraft.enable_password}
                      maxLength={4096}
                      disabled={
                        !!busy ||
                        profileDraft.clear_secrets.includes("enable_password")
                      }
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          enable_password: event.target.value,
                        })
                      }
                    />
                  </Field>
                  {existingProfile?.enable_password_set && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={profileDraft.clear_secrets.includes(
                          "enable_password",
                        )}
                        disabled={!!busy}
                        onChange={(event) =>
                          clearSecret("enable_password", event.target.checked)
                        }
                      />
                      Устройство больше не требует отдельный пароль
                    </label>
                  )}
                </>
              )}
            {profileDraft.kind !== "windows" ? (
              <Field
                label="Доверенные SSH-ключи устройств"
                hint={
                  existingProfile?.ssh_known_hosts_set
                    ? "Ключи сохранены. Новое содержимое заменит весь список. Пустое поле сохраняет его."
                    : "Вставьте строки known_hosts: IP, тип ключа и сам ключ. Для нестандартного порта адрес записывают как [IP]:порт. Сверьте отпечаток с устройством перед добавлением."
                }
              >
                <textarea
                  rows={4}
                  spellCheck={false}
                  autoComplete="off"
                  value={profileDraft.ssh_known_hosts}
                  required={!existingProfile?.ssh_known_hosts_set}
                  maxLength={65536}
                  placeholder="192.0.2.10 ssh-ed25519 AAAA…"
                  disabled={!!busy}
                  onChange={(event) =>
                    setProfileDraft({
                      ...profileDraft,
                      ssh_known_hosts: event.target.value,
                    })
                  }
                />
              </Field>
            ) : profileDraft.scheme === "https" ? (
              <>
                <Field
                  label="Сертификат центра сертификации, если свой"
                  hint={
                    existingProfile?.ca_pem_set
                      ? "Сертификат сохранён. Заполните поле только для его замены."
                      : "Для внутреннего центра сертификации вставьте доверенный сертификат PEM. Для публичного сертификата поле можно оставить пустым. Сертификат WinRM должен включать IP-адрес сервера."
                  }
                >
                  <textarea
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    value={profileDraft.ca_pem}
                    maxLength={65536}
                    disabled={
                      !!busy || profileDraft.clear_secrets.includes("ca_pem")
                    }
                    onChange={(event) =>
                      setProfileDraft({
                        ...profileDraft,
                        ca_pem: event.target.value,
                      })
                    }
                  />
                </Field>
                {existingProfile?.ca_pem_set && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={profileDraft.clear_secrets.includes("ca_pem")}
                      disabled={!!busy}
                      onChange={(event) =>
                        clearSecret("ca_pem", event.target.checked)
                      }
                    />
                    Использовать системные доверенные сертификаты
                  </label>
                )}
              </>
            ) : (
              <p className="module-hint">
                PL использует NTLM и шифрует содержимое запросов WinRM. На
                сервере должен быть разрешён доступ WinRM для выбранной учётной
                записи.
              </p>
            )}
            {!!error && <ErrorBox error={error} />}
            <div className="dialog-footer">
              <Button
                type="button"
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setProfileDraft(undefined);
                  setError(undefined);
                }}
              >
                Отмена
              </Button>
              <Button type="submit" variant="default" disabled={!!busy}>
                {busy === "profile-save" ? "Сохраняем…" : "Сохранить профиль"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {targetDraft && (
        <Dialog
          title={targetDraft.id ? "Изменить устройство" : "Добавить устройство"}
          onClose={() => {
            if (!busy) {
              setTargetDraft(undefined);
              setError(undefined);
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                "target-save",
                "/targets",
                "POST",
                {
                  ...targetDraft,
                  interval_minutes: Number(targetDraft.interval_minutes),
                  network_id: targetDraft.network_id || "",
                },
                () => {
                  setTargetDraft(undefined);
                  setNotice(
                    "Устройство сохранено. Можно запустить первый сбор.",
                  );
                },
              );
            }}
          >
            <Field label="Название">
              <input
                autoFocus
                required
                maxLength={120}
                value={targetDraft.name}
                disabled={!!busy}
                placeholder="Например, маршрутизатор офиса"
                onChange={(event) =>
                  setTargetDraft({ ...targetDraft, name: event.target.value })
                }
              />
            </Field>
            <div className="form-grid">
              <Field label="Тип устройства">
                <select
                  disabled={!!busy || !!targetDraft.id}
                  value={targetDraft.kind}
                  onChange={(event) => {
                    const kind = event.target.value as Kind;
                    setTargetDraft({
                      ...targetDraft,
                      kind,
                      profile_id:
                        profileItems.find((profile) => profile.kind === kind)
                          ?.id || "",
                      network_id: "",
                    });
                  }}
                >
                  {Object.entries(kinds).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="IP-адрес"
                hint="Адрес устройства, доступный с хоста PL. IPv4 или IPv6."
              >
                <input
                  required
                  aria-label="IP-адрес"
                  maxLength={45}
                  spellCheck={false}
                  value={targetDraft.address}
                  placeholder="192.0.2.10"
                  disabled={!!busy}
                  onChange={(event) =>
                    setTargetDraft({
                      ...targetDraft,
                      address: event.target.value.trim(),
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Профиль доступа">
              <select
                required
                value={targetDraft.profile_id}
                disabled={!!busy}
                onChange={(event) =>
                  setTargetDraft({
                    ...targetDraft,
                    profile_id: event.target.value,
                  })
                }
              >
                <option value="">Выберите профиль</option>
                {profileItems
                  .filter((profile) => profile.kind === targetDraft.kind)
                  .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.username}
                    </option>
                  ))}
              </select>
            </Field>
            {!profileItems.some(
              (profile) => profile.kind === targetDraft.kind,
            ) && (
              <p className="module-hint">
                Для этого типа устройства пока нет профиля. Сохраните профиль
                доступа перед добавлением устройства.
              </p>
            )}
            {targetDraft.kind === "network" && (
              <Field
                label="Связать с опрошенной сетью"
                hint="Выберите сеть, если устройство уже найдено по SNMP. PL дополнит ту же карточку NetBox."
              >
                <select
                  value={targetDraft.network_id || ""}
                  disabled={!!busy || !!targetDraft.id}
                  onChange={(event) =>
                    setTargetDraft({
                      ...targetDraft,
                      network_id: event.target.value,
                    })
                  }
                >
                  <option value="">Отдельное устройство</option>
                  {networks.map((network) => (
                    <option key={network.id} value={network.id}>
                      {network.name} · {network.cidr}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Когда обновлять сведения">
              <select
                value={targetDraft.interval_minutes}
                disabled={!!busy}
                onChange={(event) =>
                  setTargetDraft({
                    ...targetDraft,
                    interval_minutes: event.target.value,
                  })
                }
              >
                {!["0", "15", "60", "1440"].includes(
                  targetDraft.interval_minutes,
                ) && (
                  <option value={targetDraft.interval_minutes}>
                    Каждые {targetDraft.interval_minutes} мин
                  </option>
                )}
                <option value="0">Только по кнопке «Опросить»</option>
                <option value="15">Каждые 15 минут</option>
                <option value="60">Каждый час</option>
                <option value="1440">Раз в сутки</option>
              </select>
            </Field>
            {!!error && <ErrorBox error={error} />}
            <div className="dialog-footer">
              <Button
                type="button"
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setTargetDraft(undefined);
                  setError(undefined);
                }}
              >
                Отмена
              </Button>
              <Button
                type="submit"
                variant="default"
                disabled={!!busy || !targetDraft.profile_id}
              >
                {busy === "target-save" ? "Сохраняем…" : "Сохранить устройство"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {testing && (
        <Dialog
          title={`Проверить доступ · ${testing.name}`}
          onClose={() => {
            if (!busy) {
              setTesting(undefined);
              setError(undefined);
            }
          }}
        >
          <p className="module-hint">
            PL подключится к устройству и прочитает сведения о нём. Проверка не
            меняет NetBox.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setTestResult(undefined);
              void mutate<{ summary: Summary }>(
                "profile-test",
                "/profiles/" + testing.id + "/test",
                "POST",
                { address: testAddress },
                (value) => {
                  setTestResult(value.summary);
                  setNotice(
                    "Доступ подтверждён, сведения об устройстве получены.",
                  );
                },
              );
            }}
          >
            <Field label="IP-адрес устройства">
              <input
                autoFocus
                required
                maxLength={45}
                spellCheck={false}
                value={testAddress}
                disabled={!!busy}
                onChange={(event) => {
                  setTestAddress(event.target.value.trim());
                  setTestResult(undefined);
                }}
              />
            </Field>
            {testResult && (
              <p role="status">
                <Check size={16} aria-hidden="true" /> Доступ подтверждён
                {testResult.hostname ? ` · ${testResult.hostname}` : ""}
                {typeof testResult.interfaces === "number"
                  ? ` · интерфейсов: ${testResult.interfaces}`
                  : ""}
                .
              </p>
            )}
            {!!error && <ErrorBox error={error} />}
            <div className="dialog-footer">
              <Button
                type="button"
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setTesting(undefined);
                  setError(undefined);
                }}
              >
                Закрыть
              </Button>
              <Button type="submit" variant="default" disabled={!!busy}>
                {busy === "profile-test" ? "Проверяем…" : "Проверить доступ"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {selected && (
        <Dialog
          title={`Результат сбора · ${selected.target_name || selected.address || "Устройство"}`}
          onClose={() => setSelectedJob(undefined)}
        >
          {jobLabel(selected)}
          <dl className="netmap-config-summary">
            <dt>Начало</dt>
            <dd>{dateLabel(selected.started_at || selected.created_at)}</dd>
            <dt>Завершение</dt>
            <dd>{dateLabel(selected.finished_at)}</dd>
          </dl>
          {selected.result?.summary && (
            <dl className="netmap-config-summary">
              <dt>Имя устройства</dt>
              <dd>{selected.result.summary.hostname || "Не получено"}</dd>
              <dt>Система</dt>
              <dd>
                {[
                  selected.result.summary.os_name,
                  selected.result.summary.os_version,
                ]
                  .filter(Boolean)
                  .join(" ") || "Не получено"}
              </dd>
              <dt>Модель</dt>
              <dd>
                {[
                  selected.result.summary.manufacturer,
                  selected.result.summary.model,
                ]
                  .filter(Boolean)
                  .join(" ") || "Не получено"}
              </dd>
              {selected.result.summary.serial && (
                <>
                  <dt>Серийный номер</dt>
                  <dd>{selected.result.summary.serial}</dd>
                </>
              )}
              <dt>Интерфейсы / IP-адреса</dt>
              <dd>
                {selected.result.summary.interfaces ?? "—"} /{" "}
                {selected.result.summary.addresses ?? "—"}
              </dd>
              {selected.result.summary.cpu_count != null && (
                <>
                  <dt>Процессоры</dt>
                  <dd>{selected.result.summary.cpu_count}</dd>
                </>
              )}
              {selected.result.summary.memory_mib != null && (
                <>
                  <dt>Память</dt>
                  <dd>{selected.result.summary.memory_mib} МиБ</dd>
                </>
              )}
            </dl>
          )}
          {selected.result?.sync && (
            <dl className="netmap-config-summary">
              <dt>Создано / обновлено</dt>
              <dd>
                {selected.result.sync.created ?? "—"} /{" "}
                {selected.result.sync.updated ?? "—"}
              </dd>
              {!!selected.result.sync.conflicts && (
                <>
                  <dt>Требует проверки в NetBox</dt>
                  <dd>{selected.result.sync.conflicts}</dd>
                </>
              )}
            </dl>
          )}
          {selected.error && (
            <ErrorBox
              error={
                new Error(
                  explanations[selected.error] ||
                    "Не удалось завершить сбор. Проверьте профиль доступа и доступность устройства, затем повторите запуск.",
                )
              }
            />
          )}
          {selectedWarnings.length > 0 && (
            <>
              <h3>Требует внимания</h3>
              <ul>
                {selectedWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}
          <div className="dialog-footer">
            <a
              className="button button-secondary"
              href="/netmap/netbox/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Открыть NetBox
            </a>
            <Button variant="ghost" onClick={() => setSelectedJob(undefined)}>
              Закрыть
            </Button>
          </div>
        </Dialog>
      )}

      {removing && (
        <Dialog
          title={
            removing.type === "profiles"
              ? "Удалить профиль доступа?"
              : "Убрать устройство из опроса?"
          }
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <p>{removing.name}</p>
          {removing.type === "targets" && (
            <p className="module-hint">
              Автоматический сбор остановится. Карточка в NetBox и история
              конфигураций сохранятся.
            </p>
          )}
          {!!error && <ErrorBox error={error} />}
          <div className="dialog-footer">
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() => {
                setRemoving(undefined);
                setError(undefined);
              }}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() =>
                void mutate(
                  "delete",
                  "/" + removing.type + "/" + removing.id,
                  "DELETE",
                  {},
                  () => {
                    setRemoving(undefined);
                    setNotice("Настройка удалена.");
                  },
                )
              }
            >
              {busy === "delete" ? "Удаляем…" : "Удалить"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
