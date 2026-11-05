import { ActionFeedback } from "./ActionNotifications";
import { useDraftRegistration } from "./settings/Draft";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Users } from "lucide-react";
import { APIError, api, date, queryClient, useAPI } from "./api";
import type { LocalUser, Settings } from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";

function userError(error: unknown) {
  if (
    error instanceof DOMException &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return new Error(
      "Время ожидания ответа истекло. Обновите список пользователей, чтобы проверить результат операции.",
    );
  if (!(error instanceof APIError)) return error;
  const messages: Record<string, string> = {
    username_conflict: "Этот логин уже занят. Укажите другой.",
    reserved_username:
      "Этот логин зарезервирован для встроенного администратора.",
    builtin_protected:
      "Встроенный администратор защищён от изменения роли и отключения.",
    revision_conflict:
      "Учётная запись уже изменена. Загрузите актуальные данные перед сохранением.",
    revision_required: "Обновите данные учётной записи перед сохранением.",
    invalid_username:
      "Проверьте логин: от 1 до 64 символов; первый — латинская буква или цифра, далее также допустимы точка, дефис и подчёркивание.",
    invalid_name: "Укажите корректное отображаемое имя.",
    invalid_password:
      "Пароль не соответствует настроенной минимальной длине или превышает 1024 байта.",
    forbidden:
      "Недостаточно прав для управления пользователями. Обновите страницу.",
  };
  return new Error(
    error.status === 401
      ? "Сессия завершена. Войдите в Платформу заново."
      : messages[error.code] || error.message,
  );
}

function validPassword(password: string, minimum: number) {
  return (
    Array.from(password).length >= minimum &&
    new TextEncoder().encode(password).length <= 1024 &&
    !/[\r\n\0]/.test(password)
  );
}

export function LocalUsers() {
  const users = useQuery({
    queryKey: ["/local-users"],
    queryFn: ({ signal }) =>
      api<{ items: LocalUser[] }>(
        "/local-users",
        "GET",
        undefined,
        {},
        AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      ),
  });
  const [editing, setEditing] = useState<LocalUser | "new">();
  const [resetting, setResetting] = useState<LocalUser>();
  const [notice, setNotice] = useState("");
  return (
    <>
      <Panel
        title="Локальные пользователи"
        icon={<Users size={20} />}
        action={
          <div className="actions">
            <Button
              size="sm"
              onClick={() => void users.refetch()}
              disabled={users.isFetching}
            >
              <RefreshCw size={15} /> Обновить
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                setNotice("");
                setEditing("new");
              }}
            >
              <Plus size={15} /> Добавить пользователя
            </Button>
          </div>
        }
      >
        <p className="muted">
          Локальные учётные записи работают независимо от AD. Администраторы
          управляют Платформой; пользователи получают доступ к опубликованным
          сервисам.
        </p>
        <ActionFeedback notice={notice} />
        {users.error ? (
          <ErrorBox
            error={userError(users.error)}
            retry={() => void users.refetch()}
          />
        ) : users.isPending ? (
          <div className="loading" role="status">
            Загружаем пользователей…
          </div>
        ) : users.data?.items.length ? (
          <div className="table-wrap local-users-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Пользователь</th>
                  <th scope="col">Роль</th>
                  <th scope="col">Состояние</th>
                  <th scope="col">Изменён</th>
                  <th scope="col">Действия</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name || user.username}</strong>
                      <small>{user.username}</small>
                      {user.builtin && (
                        <small>Встроенный администратор восстановления</small>
                      )}
                    </td>
                    <td>{user.admin ? "Администратор" : "Пользователь"}</td>
                    <td>
                      <Badge value={user.disabled ? "disabled" : "active"}>
                        {user.disabled ? "Отключён" : "Активен"}
                      </Badge>
                    </td>
                    <td>
                      {user.builtin ? "—" : date(user.updated_at || undefined)}
                    </td>
                    <td>
                      {user.builtin ? (
                        <span className="muted">Защищённая учётная запись</span>
                      ) : (
                        <div className="actions">
                          <Button
                            size="sm"
                            onClick={() => {
                              setNotice("");
                              setEditing(user);
                            }}
                            aria-label={`Изменить пользователя ${user.username}`}
                          >
                            Изменить
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              setNotice("");
                              setResetting(user);
                            }}
                            aria-label={`Задать пароль пользователю ${user.username}`}
                          >
                            <KeyRound size={14} /> Пароль
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Нет локальных пользователей"
            detail="Добавьте пользователя или администратора. Встроенная учётная запись восстановления сохраняется отдельно."
          />
        )}
        <p className="muted local-users-note">
          Встроенного администратора нельзя отключить или лишить прав. Его
          пароль меняется только самим администратором в разделе «Изменить
          пароль».
        </p>
      </Panel>
      {editing && (
        <LocalUserEditor
          value={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(message) => {
            setEditing(undefined);
            setNotice(message);
          }}
        />
      )}
      {resetting && (
        <LocalUserEditor
          value={resetting}
          passwordOnly
          onClose={() => setResetting(undefined)}
          onSaved={(message) => {
            setResetting(undefined);
            setNotice(message);
          }}
        />
      )}
    </>
  );
}

function LocalUserEditor({
  value,
  passwordOnly = false,
  onClose,
  onSaved,
}: {
  value?: LocalUser;
  passwordOnly?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const policy = useAPI<Settings>("/settings");
  const minimum = policy.data?.local_password_min_length || 12;
  const [record, setRecord] = useState(value);
  const [username, setUsername] = useState("");
  const [name, setName] = useState(value?.name || "");
  const [admin, setAdmin] = useState(value?.admin || false);
  const [disabled, setDisabled] = useState(value?.disabled || false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [inlineError, setInlineError] = useState(true);
  const [conflict, setConflict] = useState(false);
  const pending = useRef(false);
  const needsPassword = !record || passwordOnly;
  function close() {
    if (pending.current) return;
    setPassword("");
    setConfirmation("");
    onClose();
  }
  async function reload() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const latest = await api<{ items: LocalUser[] }>(
        "/local-users",
        "GET",
        undefined,
        {},
        AbortSignal.timeout(15000),
      );
      queryClient.setQueryData(["/local-users"], latest);
      const user = latest.items.find((item) => item.id === record?.id);
      if (!user || user.builtin)
        throw new Error("Эта учётная запись больше недоступна для изменения.");
      setRecord(user);
      setName(user.name);
      setAdmin(user.admin);
      setDisabled(user.disabled);
      setPassword("");
      setConfirmation("");
      setConflict(false);
      setError(undefined);
    } catch (e) {
      setInlineError(
        e instanceof APIError &&
          (e.status === 401 ||
            e.status === 403 ||
            e.code.startsWith("invalid_") ||
            [
              "username_conflict",
              "reserved_username",
              "builtin_protected",
              "revision_conflict",
              "revision_required",
            ].includes(e.code)),
      );
      setError(userError(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (pending.current || conflict) return false;
    setInlineError(true);
    setError(undefined);
    if (
      !passwordOnly &&
      (!name.trim() ||
        Array.from(name.trim()).length > 128 ||
        /\p{Cc}/u.test(name))
    ) {
      setError(
        new Error(
          "Укажите имя длиной от 1 до 128 символов без управляющих символов.",
        ),
      );
      return false;
    }
    if (needsPassword && !validPassword(password, minimum)) {
      setError(
        new Error(
          "Пароль не соответствует настроенной минимальной длине или превышает 1024 байта.",
        ),
      );
      return false;
    }
    if (needsPassword && password !== confirmation) {
      setError(new Error("Пароли не совпадают."));
      return false;
    }
    pending.current = true;
    setBusy(true);
    try {
      const path = record
        ? `/local-users/${encodeURIComponent(record.id)}${passwordOnly ? "/password" : ""}`
        : "/local-users";
      const body = !record
        ? { username: username.trim(), name: name.trim(), admin, password }
        : passwordOnly
          ? { password, revision: record.revision }
          : { name: name.trim(), admin, disabled, revision: record.revision };
      await api<LocalUser>(
        path,
        record && !passwordOnly ? "PATCH" : "POST",
        body,
        {},
        AbortSignal.timeout(15000),
      );
      setPassword("");
      setConfirmation("");
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/local-users"] }),
        queryClient.invalidateQueries({ queryKey: ["/session"] }),
      ]);
      onSaved(
        !record
          ? "Пользователь создан."
          : passwordOnly
            ? "Пароль изменён. Все сессии пользователя завершены."
            : "Учётная запись обновлена. При изменении доступа пользователь войдёт заново.",
      );
      return true;
    } catch (e) {
      setPassword("");
      setConfirmation("");
      setConflict(
        e instanceof APIError &&
          ["revision_conflict", "revision_required"].includes(e.code),
      );
      setInlineError(
        e instanceof APIError &&
          (e.status === 401 ||
            e.status === 403 ||
            e.code.startsWith("invalid_") ||
            [
              "username_conflict",
              "reserved_username",
              "builtin_protected",
              "revision_conflict",
              "revision_required",
            ].includes(e.code)),
      );
      setError(userError(e));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useDraftRegistration({
    dirty:
      !!username ||
      !!password ||
      !!confirmation ||
      (!passwordOnly &&
        (name !== (record?.name || "") ||
          admin !== (record?.admin || false) ||
          disabled !== (record?.disabled || false))),
    busy,
    save,
    discard: close,
  });
  return (
    <Dialog
      title={
        !record
          ? "Добавить пользователя"
          : passwordOnly
            ? "Задать новый пароль"
            : "Изменить пользователя"
      }
      description={
        passwordOnly
          ? `Пользователь: ${record?.username}. Все его сессии будут завершены после смены пароля.`
          : record
            ? `Логин: ${record.username}. Изменение роли или отключение завершит сессии пользователя.`
            : "Учётная запись будет доступна для локального входа в Платформу."
      }
      onClose={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {!record && (
          <Field
            label="Логин"
            hint="1–64 символа. Начните с латинской буквы или цифры; далее допустимы также точка, дефис и подчёркивание."
          >
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              name="username"
              autoComplete="off"
              required
              minLength={1}
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              disabled={busy}
            />
          </Field>
        )}
        {!passwordOnly && (
          <>
            <Field label="Отображаемое имя">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                name="display-name"
                autoComplete="off"
                required
                maxLength={256}
                disabled={busy}
              />
            </Field>
            <Field label="Роль">
              <select
                value={admin ? "admin" : "user"}
                onChange={(event) => setAdmin(event.target.value === "admin")}
                disabled={busy}
              >
                <option value="user">Пользователь</option>
                <option value="admin">Администратор</option>
              </select>
            </Field>
            {record && (
              <Field label="Доступ">
                <select
                  value={disabled ? "disabled" : "active"}
                  onChange={(event) =>
                    setDisabled(event.target.value === "disabled")
                  }
                  disabled={busy}
                >
                  <option value="active">Активен</option>
                  <option value="disabled">Отключён</option>
                </select>
              </Field>
            )}
          </>
        )}
        {needsPassword && (
          <>
            <Field label="Пароль" hint={`Не менее ${minimum} символов.`}>
              <input
                type="password"
                name="new-password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                maxLength={1024}
                disabled={busy}
              />
            </Field>
            <Field label="Повторите пароль">
              <input
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                maxLength={1024}
                disabled={busy}
              />
            </Field>
          </>
        )}
        <ActionFeedback error={!inlineError ? error : undefined} />
        {inlineError && !!error && <ErrorBox error={error} />}
        {conflict && (
          <Button onClick={() => void reload()} disabled={busy}>
            <RefreshCw size={15} /> Загрузить актуальные данные
          </Button>
        )}
        <div className="dialog-actions">
          <Button onClick={close} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="default" disabled={busy || conflict}>
            {busy
              ? "Сохраняем…"
              : !record
                ? "Создать пользователя"
                : "Сохранить"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
