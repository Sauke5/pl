import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { ExternalLink } from "lucide-react";
import { api } from "./api";
import { ErrorBox } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import "./module-initial-login.css";

type Service = "grafana" | "netbox" | "gitea" | "bookstack";
type InitialLoginModule = "grafana" | "netmap" | "bookstack";
type Login = {
  instance_id: string;
  module_id: string;
  service: Service;
  username: string;
  password: string;
  path: string;
};
type Entry = { service: Service; login?: Login; error?: unknown };
const services = {
  grafana: ["grafana"],
  netmap: ["netbox", "gitea"],
  bookstack: ["bookstack"],
} as const;
const names: Record<Service, string> = {
  grafana: "Grafana",
  netbox: "NetBox",
  gitea: "Gitea",
  bookstack: "Wiki",
};

export function supportsInitialLogin(
  value: string,
): value is InitialLoginModule {
  return Object.hasOwn(services, value);
}

// Credentials live only in this dialog. Automatic disclosure requires the
// caller's successful installation marker; historical jobs never request them.
export default function ModuleInitialLogin({
  instanceID,
  moduleID,
  disabled = false,
  autoOpenKey,
  onAutoOpen,
}: {
  instanceID: string;
  moduleID: InitialLoginModule;
  disabled?: boolean;
  autoOpenKey?: string;
  onAutoOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pending, setPending] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<Service>(services[moduleID][0]);
  const [copied, setCopied] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [copyError, setCopyError] = useState<unknown>();
  const active = useRef<AbortController | null>(null);
  const shown = useRef("");
  const panel = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const copyRequest = useRef(0);
  const id = useId();

  const clearCopy = useCallback(() => {
    window.clearTimeout(copyTimer.current);
    copyRequest.current++;
    setCopied(null);
    setCopyError(undefined);
  }, []);

  const close = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setOpen(false);
    setEntries([]);
    setPending(false);
    setAutomatic(false);
    setSelected(services[moduleID][0]);
    setVisible(false);
    clearCopy();
  }, [moduleID, clearCopy]);

  useEffect(() => {
    close();
    return () => {
      active.current?.abort();
      active.current = null;
      shown.current = "";
      window.clearTimeout(copyTimer.current);
      copyRequest.current++;
    };
  }, [instanceID, moduleID, disabled, close]);

  const load = useCallback(
    async (wanted: readonly Service[]) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setVisible(false);
      setPending(true);
      clearCopy();
      const values = await Promise.all(
        wanted.map(async (service): Promise<Entry> => {
          try {
            const login = await api<Login>(
              "/modules/" + instanceID + "/initial-login",
              "POST",
              { service },
              {},
              controller.signal,
            );
            if (login.instance_id !== instanceID || login.service !== service)
              throw new Error(
                "Не удалось подтвердить данные выбранного сервиса",
              );
            return { service, login };
          } catch (error) {
            return { service, error };
          }
        }),
      );
      if (active.current === controller && !controller.signal.aborted) {
        setEntries((current) => [
          ...current.filter((entry) => !wanted.includes(entry.service)),
          ...values,
        ]);
        setPending(false);
        return true;
      }
      return false;
    },
    [instanceID, clearCopy],
  );

  useEffect(() => {
    if (!autoOpenKey || disabled || shown.current === autoOpenKey) return;
    shown.current = autoOpenKey;
    setOpen(true);
    setAutomatic(true);
    setSelected(services[moduleID][0]);
    void load(services[moduleID]).then((completed) => {
      if (completed) onAutoOpen?.();
    });
  }, [autoOpenKey, disabled, moduleID, load, onAutoOpen]);

  async function copy(value: string, event: MouseEvent<HTMLButtonElement>) {
    clearCopy();
    const request = copyRequest.current;
    const controller = active.current;
    const field = event.currentTarget.getBoundingClientRect();
    const bounds = panel.current?.getBoundingClientRect();
    const x = event.detail ? event.clientX : field.left + field.width / 2;
    const y = event.detail ? event.clientY + 18 : field.bottom + 8;
    try {
      await navigator.clipboard.writeText(value);
      if (
        active.current !== controller ||
        copyRequest.current !== request ||
        !bounds
      )
        return;
      setCopied({
        left: Math.max(0, Math.min(x - bounds.left, bounds.width - 115)),
        top: y - bounds.top,
      });
      copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
    } catch {
      if (active.current === controller && copyRequest.current === request)
        setCopyError(
          new Error(
            "Не удалось скопировать. Выделите значение и скопируйте его вручную.",
          ),
        );
    }
  }

  function closeDialog() {
    close();
    if (automatic) onAutoOpen?.();
  }

  function select(service: Service) {
    setSelected(service);
    setVisible(false);
    clearCopy();
  }

  const entry = entries.find((item) => item.service === selected);
  const login = entry?.login;

  return (
    <>
      <Button
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setSelected(services[moduleID][0]);
          void load(services[moduleID]);
        }}
      >
        Первоначальный вход
      </Button>
      {open && (
        <Dialog title="Первый вход" onClose={closeDialog}>
          <div className="module-initial-login" ref={panel}>
            {services[moduleID].length > 1 && (
              <div
                className="initial-login-services"
                role="tablist"
                aria-label="Сервис"
              >
                {services[moduleID].map((service) => (
                  <Button
                    key={service}
                    role="tab"
                    id={id + "-tab-" + service}
                    aria-selected={selected === service}
                    aria-controls={id + "-credentials"}
                    tabIndex={selected === service ? 0 : -1}
                    onKeyDown={(event) => {
                      const list: readonly Service[] = services[moduleID];
                      const index = list.indexOf(service);
                      const next =
                        event.key === "ArrowRight"
                          ? (index + 1) % list.length
                          : event.key === "ArrowLeft"
                            ? (index + list.length - 1) % list.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? list.length - 1
                                : undefined;
                      if (next === undefined) return;
                      event.preventDefault();
                      select(list[next]);
                      document
                        .getElementById(id + "-tab-" + list[next])
                        ?.focus();
                    }}
                    onClick={() => select(service)}
                  >
                    {names[service]}
                  </Button>
                ))}
              </div>
            )}
            <section
              id={id + "-credentials"}
              role={services[moduleID].length > 1 ? "tabpanel" : "region"}
              aria-labelledby={
                services[moduleID].length > 1
                  ? id + "-tab-" + selected
                  : undefined
              }
              aria-label={
                services[moduleID].length === 1
                  ? "Первоначальный вход: " + names[selected]
                  : undefined
              }
              aria-busy={pending}
            >
              {pending && <p role="status">Получаем данные первого входа…</p>}
              {entry?.error != null && (
                <>
                  <ErrorBox error={entry.error} />
                  <Button
                    disabled={pending}
                    onClick={() => void load([selected])}
                  >
                    Повторить получение данных
                  </Button>
                </>
              )}
              {login && (
                <>
                  <div className="initial-login-fields">
                    <div className="initial-login-field">
                      <span id={id + "-username"}>Логин</span>
                      <button
                        type="button"
                        className="initial-login-value"
                        aria-labelledby={id + "-username"}
                        onClick={(event) => void copy(login.username, event)}
                      >
                        {login.username}
                      </button>
                    </div>
                    <div className="initial-login-field">
                      <span id={id + "-password"}>Пароль</span>
                      <button
                        type="button"
                        className="initial-login-value"
                        aria-labelledby={id + "-password"}
                        onClick={(event) => {
                          setVisible(true);
                          void copy(login.password, event);
                        }}
                      >
                        {visible ? login.password : "••••••••"}
                      </button>
                    </div>
                  </div>
                  <p className="initial-login-note">
                    Первоначальные данные. Если пароль изменён, используйте
                    новый.
                  </p>
                  <a
                    className="button button-primary initial-login-open"
                    href={login.path}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть {names[selected]}
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                </>
              )}
            </section>
            {copyError != null && <ErrorBox error={copyError} />}
            {copied && (
              <span
                className="initial-login-copied"
                role="status"
                style={copied}
              >
                Скопировано
              </span>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
