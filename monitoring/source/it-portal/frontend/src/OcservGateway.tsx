import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { api, APIError, errorText, queryClient } from "./api";
import { Badge, ErrorBox, Field } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { authLabel, cidrRange, formatTime } from "./ocserv";

export type GatewaySetup = {
  revision: string;
  name: string;
  auth_mode: string;
  managed_certificates?: boolean;
  issuer: string;
  client_id: string;
  public_host: string;
  public_port: number;
  bind_address: string;
  port: number;
  pool: string;
  has_certificate: boolean;
  has_key: boolean;
  has_client_secret: boolean;
  has_idp_ca: boolean;
  certificate_pin: string;
  ready: boolean;
};
type Discovery = {
  addresses: string[];
  bind_address: string;
  public_ip: string;
  source: string;
  pool: string;
};
type GatewayProps = {
  base: string;
  observedAt?: string;
  onClose: () => void;
  onApplied: () => void;
};
type Step = 0 | 1 | 2;
const steps = ["Адрес шлюза", "Вход и сертификат", "Проверка"];
const gatewayQuery = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchInterval: false as const,
  refetchOnMount: "always" as const,
  gcTime: 0,
};

function vpnURL(host: string, port: number) {
  return "https://" + host + (port === 443 ? "" : ":" + port);
}

function validHost(host: string) {
  if (/^[\d.]+$/.test(host)) return !!cidrRange(host + "/32");
  return (
    host.length <= 253 &&
    host
      .split(".")
      .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  );
}

function validIssuer(address: string) {
  try {
    const url = new URL(address);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function Upload({
  label,
  file,
  saved,
  onChange,
}: {
  label: string;
  file?: File;
  saved: boolean;
  onChange: (file?: File) => void;
}) {
  const hint = file?.name || (saved ? "Загружен на шлюзе" : "Файл PEM");
  return (
    <Field label={label} hint={hint}>
      <input
        type="file"
        aria-label={label}
        accept=".pem,.crt,.cer,.key,application/x-pem-file"
        onChange={(event) => onChange(event.currentTarget.files?.[0])}
      />
    </Field>
  );
}

export default function OcservGateway({
  base,
  observedAt,
  onClose,
  onApplied,
}: GatewayProps) {
  const path = base + "/setup";
  const setup = useQuery({
    ...gatewayQuery,
    queryKey: [path],
    queryFn: ({ signal }) =>
      api<GatewaySetup>(path, "GET", undefined, {}, signal),
  });
  const discovery = useQuery({
    ...gatewayQuery,
    queryKey: [base + "/discovery"],
    queryFn: ({ signal }) =>
      api<Discovery>(base + "/discovery", "GET", undefined, {}, signal),
  });
  const [editing, setEditing] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [newProfile, setNewProfile] = useState(false);
  const [generation, setGeneration] = useState(0);
  const config = setup.data;
  function saved(result: GatewaySetup) {
    setNewProfile(
      !!config?.ready &&
        (config.public_host !== result.public_host ||
          config.public_port !== result.public_port ||
          config.auth_mode !== result.auth_mode ||
          (!!config.certificate_pin &&
            !!result.certificate_pin &&
            config.certificate_pin !== result.certificate_pin)),
    );
    queryClient.setQueryData([path], result);
    setEditing(false);
    setApplied(true);
    onApplied();
  }
  async function loadCurrent() {
    await setup.refetch({ throwOnError: true });
    setGeneration((n) => n + 1);
    setEditing(true);
    setApplied(false);
  }
  return (
    <Dialog
      title="Шлюз VPN"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {setup.isError ? (
        <ErrorBox error={setup.error} retry={() => void setup.refetch()} />
      ) : !config || !setup.isFetchedAfterMount ? (
        <p className="muted" role="status">
          Загружаем настройки шлюза…
        </p>
      ) : (editing ?? !config.ready) ? (
        <GatewayForm
          key={generation}
          path={path}
          setup={config}
          discovery={discovery.data}
          discovering={discovery.isFetching}
          discoveryFailed={discovery.isError}
          onDiscover={() => void discovery.refetch()}
          onClose={onClose}
          onReview={loadCurrent}
          onSaved={saved}
          busy={busy}
          onBusy={setBusy}
        />
      ) : (
        <>
          {applied && (
            <p className="notice compact" role="status">
              <Check size={16} /> Настройки применены.{" "}
              {newProfile &&
                "Параметры подключения изменились. Сотрудникам нужно заново скачать профиль OpenConnect."}
            </p>
          )}
          <dl className="vpn-facts">
            <div>
              <dt>Шлюз</dt>
              <dd>{config.name}</dd>
            </div>
            <div>
              <dt>Состояние</dt>
              <dd>
                <Badge value={config.ready ? "healthy" : "warning"}>
                  {config.ready ? "Готов" : "Ожидает настройки"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Способ входа</dt>
              <dd>
                {authLabel(config.auth_mode, config.managed_certificates)}
              </dd>
            </div>
            {config.public_host && (
              <div>
                <dt>Адрес для сотрудников</dt>
                <dd>
                  <code>{vpnURL(config.public_host, config.public_port)}</code>
                </dd>
              </div>
            )}
            {config.bind_address && (
              <div>
                <dt>Локальный адрес</dt>
                <dd>
                  <code>
                    {config.bind_address}:{config.port}
                  </code>
                </dd>
              </div>
            )}
            <div>
              <dt>Пул адресов VPN</dt>
              <dd>
                <code>{config.pool}</code>
              </dd>
            </div>
            {config.issuer && (
              <div>
                <dt>Адрес Dex (issuer)</dt>
                <dd>
                  <code>{config.issuer}</code>
                </dd>
              </div>
            )}
            {observedAt && (
              <div>
                <dt>Проверено</dt>
                <dd>
                  <time dateTime={observedAt}>{formatTime(observedAt)}</time>
                </dd>
              </div>
            )}
          </dl>
          <div className="dialog-footer">
            <Button
              onClick={() => {
                setApplied(false);
                setEditing(true);
              }}
            >
              Изменить настройки
            </Button>
            <Button variant="default" onClick={onClose}>
              Готово
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function GatewayForm({
  path,
  setup: loadedSetup,
  discovery,
  discovering,
  discoveryFailed,
  onDiscover,
  onClose,
  onReview,
  onSaved,
  busy,
  onBusy,
}: {
  path: string;
  setup: GatewaySetup;
  discovery?: Discovery;
  discovering: boolean;
  discoveryFailed: boolean;
  onDiscover: () => void;
  onClose: () => void;
  onReview: () => Promise<void>;
  onSaved: (config: GatewaySetup) => void;
  busy: boolean;
  onBusy: (value: boolean) => void;
}) {
  const [setup] = useState(loadedSetup);
  const inFlight = useRef(false);
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState(setup.name || "Корпоративный VPN");
  const [publicHost, setPublicHost] = useState<string>();
  const [publicPort, setPublicPort] = useState(
    String(setup.public_port || setup.port || 4443),
  );
  const [bind, setBind] = useState<string>();
  const [port, setPort] = useState(String(setup.port || 4443));
  const [pool, setPool] = useState<string>();
  const [mode, setMode] = useState(
    setup.auth_mode === "oidc" ? "oidc" : "certificate",
  );
  const [issuer, setIssuer] = useState(setup.issuer || "");
  const [client, setClient] = useState(setup.client_id || "");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [cert, setCert] = useState<File>();
  const [keyFile, setKeyFile] = useState<File>();
  const [ca, setCA] = useState<File>();
  const [clearCA, setClearCA] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const host =
    publicHost ??
    ((setup.auth_mode && setup.public_host) || discovery?.public_ip || "");
  const local = bind ?? (setup.bind_address || discovery?.bind_address || "");
  const clientPool = pool ?? (setup.pool || discovery?.pool || "");
  const advertised = vpnURL(host.trim(), Number(publicPort));
  const callback = advertised + "/sso/callback";

  function addressError() {
    if (!name.trim()) return "Укажите название шлюза.";
    if (!validHost(host.trim()))
      return "Укажите IPv4 или DNS-имя шлюза для сотрудников.";
    if (!cidrRange(local.trim() + "/32"))
      return "Выберите или укажите IPv4 локального интерфейса.";
    if (
      ![publicPort, port].every(
        (value) =>
          /^\d{1,5}$/.test(value) &&
          Number(value) >= 1 &&
          Number(value) <= 65535,
      )
    )
      return "Порты шлюза должны быть в диапазоне 1–65535.";
    const prefix = Number(clientPool.trim().split("/")[1]);
    if (!cidrRange(clientPool.trim()) || prefix < 8 || prefix > 29)
      return "Укажите адрес сети для VPN-клиентов с префиксом от /8 до /29.";
    return "";
  }
  function identityError() {
    if (mode === "oidc" && !validIssuer(issuer.trim()))
      return "Укажите HTTPS-адрес issuer из настроек Dex.";
    if (mode === "oidc" && !client.trim())
      return "Укажите идентификатор клиента, зарегистрированного в Dex.";
    if (
      (cert && !keyFile && !setup.has_key) ||
      (keyFile && !cert && !setup.has_certificate)
    )
      return "Для своего сертификата загрузите сертификат шлюза и соответствующий ему закрытый ключ.";
    const invalid = [cert, keyFile, ...(mode === "oidc" ? [ca] : [])].some(
      (file) => file && (file.size === 0 || file.size > 131072),
    );
    if (invalid)
      return "Файл PEM должен быть непустым и занимать не более 128 КиБ.";
    return "";
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || stale) return;
    const problem = step === 0 ? addressError() : identityError();
    setError(problem);
    if (problem) return;
    if (step === 0) {
      setPublicHost(host.trim());
      setBind(local.trim());
      setPool(clientPool.trim());
    }
    if (step < 2) {
      setStep(step === 0 ? 1 : 2);
      return;
    }
    inFlight.current = true;
    onBusy(true);
    try {
      const body = {
        revision: setup.revision,
        name: name.trim(),
        public_host: host.trim(),
        public_port: Number(publicPort),
        bind_address: local.trim(),
        port: Number(port),
        pool: clientPool.trim(),
        auth_mode: mode,
        ...(cert && { cert_pem: await cert.text() }),
        ...(keyFile && { key_pem: await keyFile.text() }),
        ...(mode === "oidc" && {
          issuer: issuer.trim(),
          client_id: client.trim(),
          ...(secret || clearSecret ? { client_secret: secret } : {}),
          ...(ca
            ? { idp_ca_pem: await ca.text() }
            : clearCA
              ? { idp_ca_pem: "" }
              : {}),
        }),
      };
      if (new Blob([JSON.stringify(body)]).size > 262144) {
        setError("Общий размер настроек и файлов PEM превышает 256 КиБ.");
        return;
      }
      const result = await api<GatewaySetup>(path, "POST", body);
      onSaved(result);
    } catch (cause) {
      if (
        cause instanceof APIError &&
        cause.status === 409 &&
        ["ocserv_conflict", "revision_conflict"].includes(cause.code)
      ) {
        setStale(true);
        setError(
          "Настройки шлюза изменились. Загрузите действующие настройки и проверьте их ещё раз.",
        );
      } else {
        setError(errorText(cause));
      }
    } finally {
      inFlight.current = false;
      onBusy(false);
    }
  }
  async function review() {
    onBusy(true);
    try {
      await onReview();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      onBusy(false);
    }
  }

  return (
    <form className="vpn-form vpn-setup" onSubmit={submit}>
      <ol className="vpn-setup-steps" aria-label="Этапы настройки">
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={index < step ? "is-complete" : undefined}
          >
            <span aria-hidden="true">
              {index < step ? <Check size={13} /> : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <fieldset disabled={busy || stale}>
        {step === 0 && (
          <>
            <Field label="Название шлюза">
              <input
                value={name}
                maxLength={128}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="vpn-setup-grid">
              <Field label="Внешний адрес VPN">
                <input
                  value={host}
                  required
                  placeholder="vpn.example.org"
                  onChange={(e) => setPublicHost(e.target.value)}
                />
              </Field>
              <Field label="Внешний порт">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={publicPort}
                  onChange={(e) => setPublicPort(e.target.value)}
                />
              </Field>
            </div>
            <div className="vpn-discovery">
              <p role="status">
                {discovering
                  ? "Определяем внешний IPv4 шлюза…"
                  : discovery?.public_ip && !discoveryFailed
                    ? (discovery.source === "interface"
                        ? "Публичный IPv4 интерфейса — "
                        : "Внешний сервис видит IPv4 ") +
                      discovery.public_ip +
                      "."
                    : "Внешний IPv4 определить не удалось."}{" "}
                За NAT укажите публичное имя или IP и проброшенный порт.
              </p>
              <Button size="sm" disabled={discovering} onClick={onDiscover}>
                <RefreshCw size={14} /> Определить заново
              </Button>
            </div>
            {!discovering &&
              !discoveryFailed &&
              discovery?.public_ip &&
              discovery.public_ip !== host && (
                <button
                  className="vpn-link vpn-use-address"
                  type="button"
                  onClick={() => setPublicHost(discovery.public_ip)}
                >
                  Подставить {discovery.public_ip}
                </button>
              )}
            <div className="vpn-setup-grid">
              <Field label="Локальный IPv4">
                <input
                  list="vpn-local-addresses"
                  value={local}
                  required
                  placeholder="192.168.1.10"
                  onChange={(e) => setBind(e.target.value)}
                />
                <datalist id="vpn-local-addresses">
                  {discovery?.addresses?.map((ip) => (
                    <option value={ip} key={ip} />
                  ))}
                </datalist>
              </Field>
              <Field label="Локальный порт">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Пул адресов VPN"
              hint="Из этой подсети шлюз выдаёт адреса подключённым сотрудникам."
            >
              <input
                aria-label="Пул адресов VPN"
                value={clientPool}
                required
                placeholder="10.77.0.0/24"
                onChange={(e) => setPool(e.target.value)}
              />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <Field label="Способ входа">
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="certificate">Встроенный доступ PL</option>
                <option value="oidc">Внешний Dex</option>
              </select>
            </Field>
            {mode === "certificate" ? (
              <p className="muted vpn-field-note">
                При выдаче доступа PL выпустит сертификат сотрудника и соберёт
                комплект для OpenConnect.
              </p>
            ) : (
              <>
                <div className="vpn-form-grid">
                  <Field label="Адрес Dex (issuer)">
                    <input
                      type="url"
                      value={issuer}
                      placeholder="https://login.example.org/dex"
                      required
                      onChange={(e) => setIssuer(e.target.value)}
                    />
                  </Field>
                  <Field label="Идентификатор клиента Dex">
                    <input
                      value={client}
                      placeholder="pl-vpn"
                      required
                      onChange={(e) => setClient(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="vpn-callback">
                  <strong>Redirect URI для регистрации в Dex</strong>
                  <code>{callback}</code>
                </div>
                <Field
                  label="Секрет клиента Dex"
                  hint={
                    setup.has_client_secret
                      ? "Секрет сохранён. Введите новое значение для замены."
                      : "Заполните для конфиденциального клиента Dex."
                  }
                >
                  <input
                    type="password"
                    aria-label="Секрет клиента Dex"
                    autoComplete="new-password"
                    disabled={clearSecret}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </Field>
                {setup.has_client_secret && (
                  <label className="vpn-setup-toggle">
                    <input
                      type="checkbox"
                      checked={clearSecret}
                      onChange={(e) => {
                        setClearSecret(e.target.checked);
                        setSecret("");
                      }}
                    />
                    Удалить сохранённый секрет
                  </label>
                )}
                <Upload
                  label="Сертификат CA для Dex"
                  file={ca}
                  saved={setup.has_idp_ca && !clearCA}
                  onChange={(file) => {
                    setCA(file);
                    if (file) setClearCA(false);
                  }}
                />
                <p className="muted vpn-field-note">
                  Загрузите CA, если Dex использует внутренний центр
                  сертификации.
                </p>
                {setup.has_idp_ca && (
                  <label className="vpn-setup-toggle">
                    <input
                      type="checkbox"
                      checked={clearCA}
                      onChange={(e) => {
                        setClearCA(e.target.checked);
                        setCA(undefined);
                      }}
                    />
                    Использовать только системные CA
                  </label>
                )}
              </>
            )}
            <div className="vpn-form-grid">
              <Upload
                label="Сертификат шлюза"
                file={cert}
                saved={setup.has_certificate}
                onChange={setCert}
              />
              <Upload
                label="Закрытый ключ шлюза"
                file={keyFile}
                saved={setup.has_key}
                onChange={setKeyFile}
              />
            </div>
            <p className="muted vpn-field-note">
              {setup.has_certificate && setup.has_key
                ? "Оставьте поля пустыми, чтобы сохранить текущий сертификат."
                : "PL выпустит сертификат шлюза автоматически. При наличии своего загрузите его вместе с ключом."}{" "}
              {mode === "oidc" &&
                "Для входа через браузер нужен сертификат, которому доверяет браузер сотрудника."}
            </p>
          </>
        )}
        {step === 2 && (
          <dl className="vpn-facts">
            <div>
              <dt>Шлюз</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>Адрес для сотрудников</dt>
              <dd>
                <code>{advertised}</code>
              </dd>
            </div>
            <div>
              <dt>Локальный адрес</dt>
              <dd>
                <code>
                  {local}:{port}
                </code>
              </dd>
            </div>
            <div>
              <dt>Пул адресов VPN</dt>
              <dd>
                <code>{clientPool}</code>
              </dd>
            </div>
            <div>
              <dt>Способ входа</dt>
              <dd>{authLabel(mode, true)}</dd>
            </div>
            {mode === "oidc" && (
              <>
                <div>
                  <dt>Dex</dt>
                  <dd>
                    {issuer} · {client}
                  </dd>
                </div>
                <div>
                  <dt>Redirect URI</dt>
                  <dd>
                    <code>{callback}</code>
                  </dd>
                </div>
                <div>
                  <dt>Секрет клиента Dex</dt>
                  <dd>
                    {secret
                      ? "Будет сохранён"
                      : clearSecret
                        ? "Будет удалён"
                        : setup.has_client_secret
                          ? "Сохранён"
                          : "Публичный клиент"}
                  </dd>
                </div>
                <div>
                  <dt>Доверие к Dex</dt>
                  <dd>
                    {ca?.name ||
                      (setup.has_idp_ca && !clearCA
                        ? "Сохранённый CA и системные CA"
                        : "Системные CA")}
                  </dd>
                </div>
              </>
            )}
            <div>
              <dt>Сертификат шлюза</dt>
              <dd>
                {cert?.name ||
                  (setup.has_certificate ? "Загружен на шлюзе" : "Выпустит PL")}
              </dd>
            </div>
            <div>
              <dt>Закрытый ключ шлюза</dt>
              <dd>
                {keyFile?.name ||
                  (setup.has_key ? "Загружен на шлюзе" : "Создаст PL")}
              </dd>
            </div>
          </dl>
        )}
      </fieldset>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer">
        <Button disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        {step > 0 && !stale && (
          <Button
            disabled={busy}
            onClick={() => {
              setError("");
              setStep(step === 2 ? 1 : 0);
            }}
          >
            Назад
          </Button>
        )}
        {stale ? (
          <Button
            variant="default"
            disabled={busy}
            onClick={() => void review()}
          >
            Загрузить действующие настройки
          </Button>
        ) : (
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? "Применяем…" : step === 2 ? "Применить" : "Далее"}
          </Button>
        )}
      </div>
    </form>
  );
}
