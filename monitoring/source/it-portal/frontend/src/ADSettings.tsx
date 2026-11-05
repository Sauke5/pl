import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, RefreshCw, Save } from "lucide-react";
import { APIError, api, date, refresh, useAPI } from "./api";
import { Button } from "./components/ui/button";
import { Empty, ErrorBox, Field, Panel } from "./components/common";
import { useDraftRegistration } from "./settings/Draft";

type ADConfiguration = {
  url: string;
  base_dn: string;
  user_suffix: string;
  admin_group_dn: string;
  bind_username: string;
  ca_pem: string;
};
type ADState = ADConfiguration & {
  revision: number;
  configured: boolean;
  writable: boolean;
  password_set: boolean;
  source: string;
  updated_at?: string;
  tested_at?: string;
};
const fields: (keyof ADConfiguration)[] = [
  "url",
  "base_dn",
  "user_suffix",
  "admin_group_dn",
  "bind_username",
  "ca_pem",
];

export function ADSettings() {
  const state = useAPI<ADState>("/settings/ad");
  const [draft, setDraft] = useState<ADState>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const baseline = useRef<ADState | undefined>(undefined);
  const locked = useRef(false);
  useEffect(() => {
    if (state.data && !draft) {
      baseline.current = state.data;
      setDraft(state.data);
    }
  }, [state.data, draft]);
  const dirty =
    !!password ||
    (!!draft &&
      !!baseline.current &&
      fields.some(
        (field) => (draft[field] || "") !== (baseline.current?.[field] || ""),
      ));
  function change(field: keyof ADConfiguration, value: string) {
    if (draft) setDraft({ ...draft, [field]: value });
    setMessage("");
    setError(undefined);
  }
  function discard() {
    setDraft(baseline.current);
    setPassword("");
    setError(undefined);
    setMessage("");
    setConflict(false);
  }
  async function reload() {
    if (locked.current) return;
    try {
      const latest = await api<ADState>("/settings/ad");
      baseline.current = latest;
      setDraft(latest);
      setPassword("");
      setConflict(false);
      setMessage("");
      setError(undefined);
    } catch (cause) {
      setError(cause);
    }
  }
  async function apply(save: boolean) {
    if (!draft || locked.current) return false;
    locked.current = true;
    setBusy(true);
    setMessage("");
    setError(undefined);
    try {
      const body = {
        revision: draft.revision,
        password,
        ...Object.fromEntries(
          fields.map((field) => [field, draft[field] || ""]),
        ),
      };
      if (save) {
        const latest = await api<ADState>("/settings/ad", "PUT", body);
        baseline.current = latest;
        setDraft(latest);
        setPassword("");
        setConflict(false);
        setMessage("Настройки AD сохранены");
        await refresh();
      } else {
        await api("/settings/ad/test", "POST", body);
        setMessage(
          "Подключение проверено: TLS, учётная запись, Base DN и группа доступны",
        );
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
  useDraftRegistration({ dirty, busy, save: () => apply(true), discard });
  return (
    <Panel title="Active Directory" icon={<KeyRound size={20} />}>
      <p className="muted">
        Вход с учётными записями домена. Участники выбранной группы получают
        права администратора PL; остальные пользователи домена — доступ к
        пользовательскому интерфейсу.
      </p>
      {state.error ? (
        <ErrorBox error={state.error} />
      ) : !draft ? (
        <Empty title="Загрузка настроек AD…" />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void apply(true);
          }}
        >
          <p>
            {draft.configured ? "AD настроен" : "Укажите параметры подключения"}
            {draft.updated_at ? " · " + date(draft.updated_at) : ""}
          </p>
          {!draft.writable && (
            <p role="status">
              Защищённое хранилище учётных данных недоступно. Проверьте
              установку ключа шифрования PL.
            </p>
          )}
          <fieldset disabled={busy || conflict || !draft.writable}>
            <div className="form-grid">
              <Field
                label="Сервер AD"
                hint="ldaps://dc.example.test:636 или ldap://dc.example.test:389 с обязательным StartTLS."
              >
                <input
                  type="url"
                  required
                  value={draft.url || ""}
                  maxLength={2048}
                  placeholder="ldaps://dc.example.test:636"
                  onChange={(event) => change("url", event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Домен входа"
                hint="Суффикс UPN, например example.test."
              >
                <input
                  required
                  value={draft.user_suffix || ""}
                  maxLength={253}
                  placeholder="example.test"
                  onChange={(event) =>
                    change("user_suffix", event.target.value)
                  }
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Base DN"
                hint="Корень поиска пользователей в каталоге."
              >
                <input
                  required
                  value={draft.base_dn || ""}
                  maxLength={2048}
                  placeholder="DC=example,DC=test"
                  onChange={(event) => change("base_dn", event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="DN группы администраторов"
                hint="Вложенные группы учитываются."
              >
                <input
                  required
                  value={draft.admin_group_dn || ""}
                  maxLength={2048}
                  placeholder="CN=PL Admins,OU=Groups,DC=example,DC=test"
                  onChange={(event) =>
                    change("admin_group_dn", event.target.value)
                  }
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Учётная запись чтения"
                hint="UPN или полный DN. Нужна для проверки актуальных прав пользователей."
              >
                <input
                  required
                  value={draft.bind_username || ""}
                  maxLength={2048}
                  placeholder="pl-reader@example.test"
                  onChange={(event) =>
                    change("bind_username", event.target.value)
                  }
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Пароль учётной записи чтения"
                hint={
                  draft.password_set
                    ? "Оставьте пустым, чтобы сохранить пароль. При смене сервера или учётной записи укажите его заново."
                    : "Пароль хранится в зашифрованном виде на сервере."
                }
              >
                <input
                  type="password"
                  required={!draft.password_set}
                  value={password}
                  maxLength={1024}
                  autoComplete="new-password"
                  placeholder={draft.password_set ? "Пароль сохранён" : ""}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setMessage("");
                  }}
                />
              </Field>
            </div>
            <Field
              label="Сертификат центра сертификации (PEM)"
              hint="Для внутреннего CA вставьте его сертификат или цепочку. Без значения используются системные доверенные CA; имя сервера проверяется всегда."
            >
              <textarea
                rows={6}
                spellCheck={false}
                value={draft.ca_pem || ""}
                maxLength={65536}
                onChange={(event) => change("ca_pem", event.target.value)}
              />
            </Field>
          </fieldset>
          {!!error && <ErrorBox error={error} />}
          {message && (
            <p role="status">
              <Check size={16} /> {message}
            </p>
          )}
          {conflict && (
            <div className="actions">
              <p>Настройки изменены другим администратором.</p>
              <Button
                type="button"
                disabled={busy}
                onClick={() => void reload()}
              >
                <RefreshCw size={16} />
                Загрузить актуальные
              </Button>
            </div>
          )}
          <div className="actions" style={{ marginTop: 16 }}>
            <Button
              type="button"
              disabled={busy || conflict || !draft.writable}
              onClick={() => void apply(false)}
            >
              <KeyRound size={16} />
              Проверить подключение
            </Button>
            <Button type="button" disabled={busy || !dirty} onClick={discard}>
              Отменить изменения
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={busy || conflict || !dirty || !draft.writable}
            >
              <Save size={16} />
              {busy ? "Проверка AD…" : "Проверить и сохранить"}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
