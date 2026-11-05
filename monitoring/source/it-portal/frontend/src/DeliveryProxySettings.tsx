import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network, RefreshCw, Save } from "lucide-react";
import { APIError, api, date, queryClient } from "./api";
import { Button } from "./components/ui/button";
import { ErrorBox, Field, Panel } from "./components/common";
import { useDraftRegistration } from "./settings/Draft";
import { withSettingsNavigation } from "./settings/navigation";

type Mode = "direct" | "external" | "xray";
type Protocol = "http" | "socks5";
type Authentication = "none" | "password";
export type DeliveryProxyStatus = {
  core_api: number;
  revision: number;
  configuration: {
    mode: Mode;
    external?: {
      protocol: Protocol;
      host: string;
      port: number;
      auth: Authentication;
      username: string;
      password_configured: boolean;
    };
    xray?: { instance_id: string; inbound_tag: string };
  };
  custom_ca: boolean;
  ca_sha256?: string;
  xray_inbounds: {
    instance_id: string;
    inbound_tag: string;
    protocol: Protocol;
    listen: string;
    port: number;
    auth: Authentication;
    ready: boolean;
  }[];
  error_code?: string;
  error?: string;
};
type TestResult = {
  ok: boolean;
  checked_at: string;
  mode: Mode;
  latest_version?: string;
  error_code?: string;
  error?: string;
};
type Draft = {
  mode: Mode;
  protocol: Protocol;
  host: string;
  port: string;
  auth: Authentication;
  username: string;
  password: string;
  instance_id: string;
  inbound_tag: string;
  ca_action: "keep" | "set" | "clear";
  ca_pem: string;
};
function form(value: DeliveryProxyStatus): Draft {
  const external = value.configuration.external;
  return {
    mode: value.configuration.mode,
    protocol: external?.protocol || "http",
    host: external?.host || "",
    port: String(external?.port || 3128),
    auth: external?.auth || "none",
    username: external?.username || "",
    password: "",
    instance_id: value.configuration.xray?.instance_id || "",
    inbound_tag: value.configuration.xray?.inbound_tag || "",
    ca_action: "keep",
    ca_pem: "",
  };
}

export function DeliveryProxySettings() {
  const status = useQuery({
    queryKey: ["/delivery/proxy"],
    queryFn: () => api<DeliveryProxyStatus>("/delivery/proxy"),
    retry: false,
    refetchInterval: 60000,
  });
  const [baseline, setBaseline] = useState<DeliveryProxyStatus>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<unknown>();
  const [test, setTest] = useState<TestResult>();
  const [message, setMessage] = useState("");
  const [uploadKey, setUploadKey] = useState(0);
  const locked = useRef(false);
  const operationID = useRef<string | undefined>(undefined);
  const dirty =
    !!draft &&
    !!baseline &&
    JSON.stringify(draft) !== JSON.stringify(form(baseline));
  useEffect(() => {
    const value = status.data;
    if (!value || busy) return;
    if (!baseline || (!dirty && value.revision !== baseline.revision)) {
      setBaseline(value);
      setDraft(form(value));
      setConflict(false);
    } else if (value.revision !== baseline.revision) setConflict(true);
  }, [status.data, baseline, dirty, busy]);
  function change(next: Draft) {
    setDraft(next);
    operationID.current = undefined;
    setError(undefined);
    setTest(undefined);
    setMessage("");
  }
  function discard() {
    if (baseline) setDraft(form(baseline));
    operationID.current = undefined;
    setError(undefined);
    setTest(undefined);
    setMessage("");
    setUploadKey((value) => value + 1);
  }
  const savedExternal = baseline?.configuration.external;
  const canKeepPassword =
    !!savedExternal?.password_configured &&
    draft?.auth === "password" &&
    savedExternal.auth === "password" &&
    draft.protocol === savedExternal.protocol &&
    draft.host.trim() === savedExternal.host &&
    Number(draft.port) === savedExternal.port &&
    draft.username.trim() === savedExternal.username;
  function configuration() {
    if (!draft) throw new Error("Параметры загрузок ещё не получены");
    if (draft.mode === "external") {
      const port = Number(draft.port);
      if (
        !draft.host.trim() ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        throw new Error(
          "Укажите имя или IP-адрес прокси и TCP-порт от 1 до 65535.",
        );
      if (
        draft.auth === "password" &&
        (!draft.username.trim() || (!draft.password && !canKeepPassword))
      )
        throw new Error("Для этого прокси укажите имя пользователя и пароль.");
    }
    if (draft.mode === "xray" && (!draft.instance_id || !draft.inbound_tag))
      throw new Error("Выберите доступный вход установленного Xray.");
    return {
      mode: draft.mode,
      ...(draft.mode === "external"
        ? {
            external: {
              protocol: draft.protocol,
              host: draft.host.trim(),
              port: Number(draft.port),
              auth: draft.auth,
              username: draft.auth === "password" ? draft.username.trim() : "",
              password_action:
                draft.auth === "none"
                  ? "clear"
                  : draft.password
                    ? "set"
                    : "keep",
              ...(draft.auth === "password" && draft.password
                ? { password: draft.password }
                : {}),
            },
          }
        : {}),
      ...(draft.mode === "xray"
        ? {
            xray: {
              instance_id: draft.instance_id,
              inbound_tag: draft.inbound_tag,
            },
          }
        : {}),
      ...(draft.ca_action === "set"
        ? { ca_pem: draft.ca_pem }
        : draft.ca_action === "clear"
          ? { ca_pem: "" }
          : {}),
    };
  }
  async function apply(save: boolean) {
    if (!draft || !baseline || locked.current || conflict) return false;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    setTest(undefined);
    setMessage("");
    try {
      const body = {
        revision: baseline.revision,
        configuration: configuration(),
      };
      if (save) {
        operationID.current ||= crypto.randomUUID();
        const latest = await api<DeliveryProxyStatus>(
          "/delivery/proxy",
          "PUT",
          {
            ...body,
            operation_id: operationID.current,
          },
        );
        setBaseline(latest);
        setDraft(form(latest));
        queryClient.setQueryData(["/delivery/proxy"], latest);
        setUploadKey((value) => value + 1);
        setMessage("Параметры загрузок сохранены");
        operationID.current = undefined;
      } else {
        setTest(await api<TestResult>("/delivery/proxy/test", "POST", body));
      }
      return true;
    } catch (cause) {
      setError(cause);
      if (cause instanceof APIError && cause.status === 409) setConflict(true);
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (locked.current) return;
    setBusy(true);
    try {
      const latest = await api<DeliveryProxyStatus>("/delivery/proxy");
      setBaseline(latest);
      setDraft(form(latest));
      setConflict(false);
      setError(undefined);
      setTest(undefined);
      setMessage("");
      operationID.current = undefined;
      setUploadKey((value) => value + 1);
      queryClient.setQueryData(["/delivery/proxy"], latest);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function loadCA(file: File | undefined) {
    if (!file || !draft || locked.current) return;
    if (file.size > 65536) {
      setError(new Error("Размер PEM-файла не должен превышать 64 КиБ"));
      return;
    }
    locked.current = true;
    setBusy(true);
    try {
      change({ ...draft, ca_action: "set", ca_pem: await file.text() });
    } catch {
      setError(new Error("Не удалось прочитать выбранный PEM-файл"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  useDraftRegistration({ dirty, busy, save: () => apply(true), discard });
  const choices = status.data?.xray_inbounds || [];
  const selected =
    draft && JSON.stringify([draft.instance_id, draft.inbound_tag]);
  return (
    <Panel title="Доступ к GitHub" icon={<Network size={20} />}>
      <p className="muted">
        Выберите, как PL получает каталог релизов, обновления и модули.
        Изменения применяются к следующим загрузкам без перезапуска платформы.
      </p>
      {status.error && (
        <ErrorBox error={status.error} retry={() => void reload()} />
      )}
      {status.data?.error && <ErrorBox error={new Error(status.data.error)} />}
      {draft ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void apply(true);
          }}
        >
          <fieldset disabled={busy || conflict}>
            <Field label="Способ подключения">
              <select
                value={draft.mode}
                onChange={(event) =>
                  change({ ...draft, mode: event.target.value as Mode })
                }
              >
                <option value="direct">Прямое соединение</option>
                <option value="external">Внешний прокси</option>
                <option value="xray">Установленный Xray</option>
              </select>
            </Field>
            {draft.mode === "direct" && (
              <p className="muted">Сервер PL обращается к GitHub напрямую.</p>
            )}
            {draft.mode === "external" && (
              <>
                <div className="form-grid">
                  <Field
                    label="Протокол прокси"
                    hint="SOCKS5 также передаёт разрешение имён прокси-серверу."
                  >
                    <select
                      value={draft.protocol}
                      onChange={(event) =>
                        change({
                          ...draft,
                          protocol: event.target.value as Protocol,
                        })
                      }
                    >
                      <option value="http">HTTP CONNECT</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </Field>
                  <Field
                    label="Адрес прокси"
                    hint="Имя или IP-адрес без протокола и порта."
                  >
                    <input
                      required
                      value={draft.host}
                      placeholder="proxy.example.com"
                      onChange={(event) =>
                        change({ ...draft, host: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Порт прокси">
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.port}
                      onChange={(event) =>
                        change({ ...draft, port: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Авторизация прокси">
                    <select
                      value={draft.auth}
                      onChange={(event) =>
                        change({
                          ...draft,
                          auth: event.target.value as Authentication,
                        })
                      }
                    >
                      <option value="none">Без авторизации</option>
                      <option value="password">
                        Имя пользователя и пароль
                      </option>
                    </select>
                  </Field>
                  {draft.auth === "password" && (
                    <>
                      <Field label="Пользователь прокси">
                        <input
                          required
                          autoComplete="off"
                          value={draft.username}
                          onChange={(event) =>
                            change({ ...draft, username: event.target.value })
                          }
                        />
                      </Field>
                      <Field
                        label="Пароль прокси"
                        hint={
                          canKeepPassword
                            ? "Пароль сохранён. Оставьте поле пустым, чтобы использовать его."
                            : "Для нового адреса или пользователя укажите пароль заново."
                        }
                      >
                        <input
                          required={!canKeepPassword}
                          type="password"
                          autoComplete="new-password"
                          value={draft.password}
                          onChange={(event) =>
                            change({ ...draft, password: event.target.value })
                          }
                        />
                      </Field>
                    </>
                  )}
                </div>
                <p className="muted">
                  Если Xray установлен на этом сервере отдельно, укажите его
                  локальный HTTP- или SOCKS5-вход.
                </p>
              </>
            )}
            {draft.mode === "xray" && (
              <>
                <Field label="Вход Xray">
                  <select
                    required
                    value={selected || ""}
                    onChange={(event) => {
                      const value = JSON.parse(event.target.value) as [
                        string,
                        string,
                      ];
                      change({
                        ...draft,
                        instance_id: value[0],
                        inbound_tag: value[1],
                      });
                    }}
                  >
                    <option value={JSON.stringify(["", ""])} disabled>
                      Выберите вход
                    </option>
                    {draft.instance_id &&
                      !choices.some(
                        (item) =>
                          item.instance_id === draft.instance_id &&
                          item.inbound_tag === draft.inbound_tag,
                      ) && (
                        <option value={selected} disabled>
                          {draft.inbound_tag} — недоступен
                        </option>
                      )}
                    {choices.map((item) => (
                      <option
                        key={JSON.stringify([
                          item.instance_id,
                          item.inbound_tag,
                        ])}
                        value={JSON.stringify([
                          item.instance_id,
                          item.inbound_tag,
                        ])}
                        disabled={!item.ready}
                      >
                        {item.inbound_tag} ·{" "}
                        {item.protocol === "http" ? "HTTP" : "SOCKS5"} ·{" "}
                        {item.listen}:{item.port}
                        {item.ready ? "" : " — недоступен"}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="muted">
                  Доступны HTTP- и SOCKS5-входы Xray, установленного через PL.
                  Чтобы скачать сам Xray при закрытом доступе к GitHub, сначала
                  подключите внешний прокси.
                </p>
                {!choices.length && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      withSettingsNavigation(() => {
                          location.hash = "module-catalog";
                      })
                    }
                  >
                    Открыть модули
                  </Button>
                )}
              </>
            )}
            <details>
              <summary>Собственный центр сертификации</summary>
              <p className="muted">
                Если ваша сеть использует собственный CA для HTTPS, добавьте
                PEM-сертификат или цепочку. Системные центры сертификации и
                проверка имени сервера сохраняются.
              </p>
              <Field label="Дополнительный CA для загрузок">
                <input
                  key={uploadKey}
                  type="file"
                  accept=".pem,.crt,.cer"
                  onChange={(event) => void loadCA(event.target.files?.[0])}
                />
              </Field>
              <p className="muted">
                {draft.ca_action === "set"
                  ? "Выбран новый сертификат CA"
                  : draft.ca_action === "clear"
                    ? "Дополнительный CA будет удалён"
                    : baseline?.custom_ca
                      ? "Дополнительный CA задан"
                      : "Используются системные центры сертификации"}
              </p>
              {(draft.ca_action === "set" ||
                (baseline?.custom_ca && draft.ca_action !== "clear")) && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    change({ ...draft, ca_action: "clear", ca_pem: "" })
                  }
                >
                  Удалить дополнительный CA
                </Button>
              )}
            </details>
            {draft.mode !== "direct" && (
              <p className="muted">
                Если прокси недоступен, загрузка завершится с ошибкой. Для
                прямого доступа выберите его явно.
              </p>
            )}
            <div className="actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void apply(false)}
              >
                <RefreshCw size={16} />
                {busy ? "Проверяем подключение…" : "Проверить доступ к GitHub"}
              </Button>
              <Button type="submit" disabled={!dirty}>
                <Save size={16} />
                Сохранить
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" onClick={discard}>
                  Отменить изменения
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      ) : (
        !status.error && <p className="muted">Получаем параметры загрузок…</p>
      )}
      {conflict && (
        <div role="alert">
          <p>
            Настройки изменены или операция установки ещё выполняется. Получите
            текущее состояние перед сохранением.
          </p>
          <Button disabled={busy} onClick={() => void reload()}>
            Получить текущие параметры
          </Button>
        </div>
      )}
      {!!error && <ErrorBox error={error} />}
      {test && (
        <div role="status" aria-live="polite">
          <p>
            {test.ok
              ? `Подписанный каталог PL доступен${test.latest_version ? `. Последняя версия: ${test.latest_version}` : "."}`
              : test.error ||
                "Не удалось получить подписанный каталог через выбранное соединение."}
          </p>
          <p className="muted">
            Проверено: {date(test.checked_at)}. Проверка не сохраняет параметры.
          </p>
        </div>
      )}
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </Panel>
  );
}
