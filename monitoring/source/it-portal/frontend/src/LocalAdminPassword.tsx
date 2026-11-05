import { ActionFeedback } from "./ActionNotifications";
import { withSettingsNavigation } from "./settings/navigation";
import { useDraftRegistration } from "./settings/Draft";
import { useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { APIError, api, queryClient } from "./api";
import type { Session } from "./types";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ErrorBox, Field, Panel } from "./components/common";

export function LocalAdminPassword({
  session,
  prompt = false,
  compact = false,
}: {
  session?: Session;
  prompt?: boolean;
  compact?: boolean;
}) {
  const minimum = session?.local_password_min_length || 12;
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [inlineError, setInlineError] = useState(true);
  const pending = useRef(false);
  function clear() {
    setCurrent("");
    setPassword("");
    setConfirmation("");
  }
  function close() {
    if (pending.current) return;
    clear();
    setError(undefined);
    setOpen(false);
  }
  async function save() {
    if (pending.current) return false;
    setInlineError(true);
    setError(undefined);
    const bytes = new TextEncoder().encode(password).length;
    if (
      Array.from(password).length < minimum ||
      bytes > 1024 ||
      /[\r\n\0]/.test(password)
    ) {
      setError(
        new Error(
          `Новый пароль должен содержать не менее ${minimum} символов и не более 1024 байт без переводов строк.`,
        ),
      );
      return false;
    }
    if (password !== confirmation) {
      setError(new Error("Новые пароли не совпадают."));
      return false;
    }
    if (password === current) {
      setError(new Error("Новый пароль должен отличаться от текущего."));
      return false;
    }
    pending.current = true;
    setBusy(true);
    try {
      await api(
        session?.user?.id.startsWith("local:")
          ? "/local-users/me/password"
          : "/local-admin/password",
        "POST",
        { current_password: current, new_password: password },
        {},
        AbortSignal.timeout(15000),
      );
      clear();
      queryClient.clear();
      location.assign("/?password_changed=1");
      return true;
    } catch (e) {
      clear();
      setInlineError(
        e instanceof APIError &&
          (e.status === 401 ||
            e.status === 403 ||
            e.code.startsWith("invalid_")),
      );
      setError(
        e instanceof APIError &&
          ["invalid_current_password", "invalid_credentials"].includes(e.code)
          ? new Error("Текущий пароль указан неверно.")
          : e,
      );
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (
    !session?.local_password_change_enabled ||
    (prompt && !session.local_password_change_required)
  )
    return null;
  const button = (
    <Button onClick={() => withSettingsNavigation(() => setOpen(true))}>
      <KeyRound size={16} />
      Изменить пароль
    </Button>
  );
  return (
    <>
      {compact ? (
        button
      ) : prompt ? (
        <div className="notice compact" role="status">
          <KeyRound size={18} />
          <span>Задайте собственный пароль локального администратора.</span>
          {button}
        </div>
      ) : (
        <Panel
          title="Пароль учётной записи"
          icon={<KeyRound size={19} />}
          action={button}
        >
          <p className="muted">
            Изменение пароля завершит все сессии вашей учётной записи. После
            сохранения войдите заново.
          </p>
        </Panel>
      )}
      {open && (
        <PasswordDraftGuard
          dirty={!!current || !!password || !!confirmation}
          busy={busy}
          save={save}
          discard={close}
        />
      )}
      {open && (
        <Dialog
          title="Изменить пароль"
          description={`Все сессии вашей учётной записи будут завершены. Новый пароль должен содержать не менее ${minimum} символов.`}
          onClose={close}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field label="Текущий пароль">
              <input
                type="password"
                name="current-password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                required
                disabled={busy}
                maxLength={1024}
              />
            </Field>
            <Field label="Новый пароль">
              <input
                type="password"
                name="new-password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={busy}
                maxLength={1024}
              />
            </Field>
            <Field label="Повторите новый пароль">
              <input
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                disabled={busy}
                maxLength={1024}
              />
            </Field>
            <ActionFeedback error={!inlineError ? error : undefined} />
            {inlineError && !!error && <ErrorBox error={error} />}
            <div className="dialog-actions">
              <Button type="button" onClick={close} disabled={busy}>
                Отмена
              </Button>
              <Button type="submit" variant="default" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить пароль"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function PasswordDraftGuard(props: {
  dirty: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}) {
  useDraftRegistration(props);
  return null;
}
