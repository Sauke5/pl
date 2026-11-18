import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { APIError, api, errorText } from "./api";
import { ErrorBox, Field } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { cidrRange, expiryInput, formatTime, vpnTimezone } from "./ocserv";
import type { VPNDialog, VPNPayload, VPNState } from "./ocserv";
import type { LocalUser } from "./types";

type Props = {
  base: string;
  model: VPNDialog;
  snapshot: VPNState;
  onClose: () => void;
  onReview: () => Promise<void>;
  onDenied: () => void;
  onSaved: (response: VPNState, payload: VPNPayload) => Promise<void>;
};

export default function OcservEditor({
  base,
  model,
  snapshot,
  onClose,
  onReview,
  onDenied,
  onSaved,
}: Props) {
  const priorProfile =
    model.kind === "profile"
      ? snapshot.profiles.find((p) => p.id === model.id)
      : undefined;
  const grant =
    model.kind === "grant" || model.kind === "revoke"
      ? snapshot.grants.find((g) => g.subject === model.subject)
      : undefined;
  const native =
    model.kind === "grant" &&
    (!snapshot.gateway.auth_mode ||
      (snapshot.gateway.auth_mode === "certificate" &&
        !!snapshot.gateway.managed_certificates));
  const directory = useQuery({
    queryKey: ["/local-users"],
    queryFn: ({ signal }) =>
      api<{ items: LocalUser[] }>("/local-users", "GET", undefined, {}, signal),
    enabled: native && !grant,
    refetchInterval: false,
    retry: false,
  });
  const employees = (directory.data?.items || []).filter(
    (user) => !user.disabled && !user.builtin,
  );
  const [id, setId] = useState(priorProfile?.id || ""),
    [name, setName] = useState(priorProfile?.name || grant?.display_name || "");
  const [networks, setNetworks] = useState(
    priorProfile?.networks.join("\n") || "",
  );
  const [subject, setSubject] = useState(grant?.subject || "");
  const [profileID, setProfileID] = useState(
    grant?.profile_id ||
      (model.kind === "grant" && model.profile) ||
      snapshot.profiles[0]?.id ||
      "",
  );
  const [expiry, setExpiry] = useState(expiryInput(grant?.expires_at));
  const [error, setError] = useState(""),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const routes = networks
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const target = model.kind === "terminate" ? model.session.subject : subject;
  const sessions = snapshot.sessions.filter((s) => s.subject === target);
  const currentProfile = snapshot.profiles.find((p) => p.id === profileID);
  const title =
    model.kind === "profile"
      ? priorProfile
        ? "Изменить профиль"
        : "Создать профиль"
      : model.kind === "grant"
        ? grant && !["revoked", "expired"].includes(grant.status)
          ? "Изменить доступ"
          : "Выдать доступ"
        : model.kind === "revoke"
          ? "Отозвать VPN-доступ?"
          : "Завершить сессию?";
  const submitLabel =
    model.kind === "revoke"
      ? "Отозвать доступ"
      : model.kind === "terminate"
        ? "Завершить сессию"
        : model.kind === "profile"
          ? priorProfile
            ? "Сохранить профиль"
            : "Создать профиль"
          : grant && !["revoked", "expired"].includes(grant.status)
            ? "Сохранить доступ"
            : "Выдать доступ";
  function payload(): VPNPayload {
    if (model.kind === "revoke") return { subject: model.subject };
    if (model.kind === "terminate") return { id: model.session.id };
    if (model.kind === "profile") {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(id))
        throw new Error(
          "Введите идентификатор до 48 знаков. Используйте строчные латинские буквы, цифры и дефис, начните с буквы.",
        );
      if (!name.trim()) throw new Error("Укажите название профиля.");
      if (!priorProfile && snapshot.profiles.some((p) => p.id === id))
        throw new Error("Профиль с этим идентификатором уже существует.");
      if (!routes.length || routes.some((cidr) => !cidrRange(cidr)))
        throw new Error(
          "Укажите IPv4-подсети с сетевым адресом и префиксом от /1 до /32.",
        );
      if (routes.length > 64)
        throw new Error("В профиле может быть до 64 подсетей.");
      if (new Set(routes).size !== routes.length)
        throw new Error("Уберите повторяющиеся подсети.");
      return { id, name: name.trim(), networks: routes };
    }
    if (
      native &&
      !grant &&
      (!subject || !employees.some((user) => user.id === subject))
    )
      throw new Error("Выберите действующую учётную запись сотрудника PL.");
    if (!subject.trim() || !name.trim() || !currentProfile)
      throw new Error(
        "Укажите идентификатор сотрудника, имя и профиль доступа.",
      );
    if (!/^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,61}$/.test(subject.trim()))
      throw new Error(
        "Идентификатор должен начинаться с латинской буквы или цифры. Допустимы до 62 букв, цифр и знаки . _ @ : + -.",
      );
    if (!grant && snapshot.grants.some((g) => g.subject === subject.trim()))
      throw new Error(
        "У сотрудника уже есть назначение. Откройте его карточку для изменения доступа.",
      );
    let expires = "";
    if (expiry) {
      const instant = new Date(expiry);
      if (
        !Number.isFinite(instant.valueOf()) ||
        instant.valueOf() <= Date.now()
      )
        throw new Error("Укажите будущую дату и время окончания доступа.");
      expires =
        grant?.expires_at && expiry === expiryInput(grant.expires_at)
          ? grant.expires_at
          : instant.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    return {
      subject: subject.trim(),
      display_name: name.trim(),
      profile_id: currentProfile.id,
      expires_at: expires,
    };
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || review) return;
    setError("");
    let changes: VPNPayload;
    try {
      changes = payload();
    } catch (err) {
      setError(errorText(err));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await api<VPNState>(base + "/" + model.kind, "POST", {
        ...changes,
        revision: snapshot.revision,
      });
      await onSaved(response, changes);
    } catch (err) {
      if (
        err instanceof APIError &&
        (err.status === 403 || err.status === 401)
      ) {
        onDenied();
        return;
      }
      const conflict = err instanceof APIError && err.status === 409;
      const uncertain = !(err instanceof APIError) || err.status >= 500;
      setReview(conflict || uncertain);
      setError(
        conflict
          ? "Данные изменились. Перечитайте состояние шлюза и проверьте форму."
          : errorText(err),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reread() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await onReview();
    } catch (err) {
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const unchanged =
    (model.kind === "profile" &&
      priorProfile &&
      priorProfile.name === name.trim() &&
      routes.join("\n") === priorProfile.networks.join("\n")) ||
    (model.kind === "grant" &&
      grant?.status === "active" &&
      name.trim() === grant.display_name &&
      profileID === grant.profile_id &&
      expiry === expiryInput(grant.expires_at));
  return (
    <Dialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="vpn-form" onSubmit={submit}>
        <fieldset disabled={busy || review}>
          {model.kind === "profile" && (
            <>
              <div className="vpn-form-grid">
                <Field label="Название профиля">
                  <input
                    required
                    maxLength={128}
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Идентификатор профиля">
                  <input
                    required
                    maxLength={48}
                    readOnly={!!priorProfile}
                    value={id}
                    placeholder="office"
                    onChange={(e) => setId(e.target.value)}
                  />
                </Field>
              </div>
              <Field
                label="Разрешённые IPv4-подсети"
                hint="По одной подсети на строку, в формате CIDR."
              >
                <textarea
                  rows={5}
                  required
                  placeholder="192.0.2.0/24"
                  value={networks}
                  onChange={(e) => setNetworks(e.target.value)}
                />
              </Field>
              {priorProfile &&
                routes.join("\n") !== priorProfile.networks.join("\n") && (
                  <div className="notice" role="status">
                    Изменятся разрешённые сети профиля «{priorProfile.name}».
                    Действующих назначений:{" "}
                    {
                      snapshot.grants.filter(
                        (g) =>
                          g.profile_id === priorProfile.id &&
                          g.status === "active",
                      ).length
                    }
                    .
                  </div>
                )}
            </>
          )}
          {model.kind === "grant" && (
            <>
              {native && !grant ? (
                <>
                  <Field label="Сотрудник PL">
                    <select
                      required
                      autoFocus
                      value={subject}
                      disabled={
                        directory.isPending ||
                        directory.isError ||
                        !employees.length
                      }
                      onChange={(event) => {
                        const user = employees.find(
                          (item) => item.id === event.target.value,
                        );
                        setSubject(user?.id || "");
                        setName(user?.name || user?.username || "");
                      }}
                    >
                      <option value="">
                        {directory.isPending
                          ? "Загружаем сотрудников…"
                          : "Выберите сотрудника"}
                      </option>
                      {employees.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name || user.username}
                          {user.name && user.name !== user.username
                            ? " · " + user.username
                            : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {directory.isError ? (
                    <ErrorBox
                      error={directory.error}
                      retry={() => void directory.refetch()}
                    />
                  ) : (
                    !directory.isPending &&
                    !employees.length && (
                      <p className="muted">
                        Добавьте сотрудника в разделе{" "}
                        <a href="#settings?section=users">
                          Локальные пользователи
                        </a>
                        .
                      </p>
                    )
                  )}
                </>
              ) : native && grant ? (
                <div className="vpn-note">
                  <strong>Сотрудник PL</strong>
                  <span>{grant.display_name || grant.subject}</span>
                </div>
              ) : (
                <>
                  <Field label="Имя сотрудника">
                    <input
                      required
                      maxLength={128}
                      value={name}
                      autoFocus
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field
                    label={
                      snapshot.gateway.auth_mode === "oidc"
                        ? "Идентификатор OIDC (sub)"
                        : "Имя в сертификате (CN)"
                    }
                    hint={
                      grant
                        ? undefined
                        : "Укажите точное значение, которое шлюз получает при входе."
                    }
                  >
                    <input
                      required
                      maxLength={62}
                      autoCapitalize="none"
                      spellCheck={false}
                      readOnly={!!grant}
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                    />
                  </Field>
                </>
              )}
              <div className="vpn-form-grid">
                <Field label="Профиль доступа">
                  <select
                    required
                    value={profileID}
                    onChange={(e) => setProfileID(e.target.value)}
                  >
                    {snapshot.profiles.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Доступ до"
                  hint={vpnTimezone + ". Пустое поле — без срока."}
                >
                  <input
                    type="datetime-local"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                </Field>
              </div>
              {currentProfile && (
                <div className="vpn-note">
                  <strong>Разрешённые сети</strong>
                  <ul className="vpn-net-list">
                    {currentProfile.networks.map((n) => (
                      <li key={n}>
                        <code>{n}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {model.kind === "revoke" && (
            <>
              <p>
                <strong>{grant?.display_name || model.subject}</strong> ·{" "}
                {model.subject}
              </p>
              <p>
                Шлюз блокирует новые подключения сотрудника и закрывает доступ
                по действующим сессиям.
              </p>
              {snapshot.gateway.sessions_known && (
                <p>Активных сессий: {sessions.length}.</p>
              )}
            </>
          )}
          {model.kind === "terminate" && (
            <>
              <p>
                <strong>{model.session.device || model.session.subject}</strong>{" "}
                · {model.session.ip || "Адрес не передан"}
              </p>
              <p>
                Сессия с {formatTime(model.session.since)} будет завершена.
                Сотрудник сможет войти заново при действующем назначении.
              </p>
            </>
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
          {review ? (
            <Button disabled={busy} onClick={() => void reread()}>
              Загрузить актуальные данные
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={
                busy ||
                !!unchanged ||
                (native &&
                  !grant &&
                  (!subject || directory.isError || directory.isPending))
              }
              variant={
                model.kind === "revoke" || model.kind === "terminate"
                  ? "destructive"
                  : "default"
              }
            >
              {busy ? "Применяется…" : submitLabel}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
