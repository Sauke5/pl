import { useState, type FormEvent } from "react";
import { api, useAPI } from "./api";
import { Button } from "./components/ui/button";
import { ErrorBox, Field } from "./components/common";

export function InventorySettings({ instanceID }: { instanceID: string }) {
  const path = `/modules/${encodeURIComponent(instanceID)}/inventory/settings`;
  const settings = useAPI<{ archive_password_configured: boolean }>(path);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api(path, "PUT", {
        archive_password: password,
        operation_id: crypto.randomUUID(),
      });
      setPassword("");
      setSaved(true);
      await settings.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="module-connection-settings"
    >
      <h3>Импорт Inventory</h3>
      <p className="muted">
        {settings.isPending
          ? "Проверяем настройки импорта…"
          : settings.data?.archive_password_configured
            ? "Пароль архива сохранён. Можно задать новый для следующих загрузок."
            : "Задайте пароль Source.zip перед первым импортом. Существующие отчёты доступны и без него."}
      </p>
      <Field label="Пароль архива">
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          required
          maxLength={4096}
          onChange={(event) => {
            setPassword(event.target.value);
            setSaved(false);
          }}
        />
      </Field>
      {!!(error || settings.error) && (
        <ErrorBox error={error || settings.error} />
      )}
      {saved && <p role="status">Пароль сохранён для новых импортов.</p>}
      <Button type="submit" disabled={busy || !password}>
        {busy ? "Сохраняем…" : "Сохранить пароль"}
      </Button>
    </form>
  );
}
