import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { errorText } from "./api";
import "./action-notifications.css";

type Kind = "success" | "info" | "error";
type Status = {
  kind: Kind;
  message: string;
  title?: string;
  ongoing?: boolean;
};
type Notification = Status & { id: number | string; hidden?: boolean };
type Notify = (kind: Kind, message: string, allowRepeat?: boolean) => void;
const NotificationsContext = createContext<{
  notify: Notify;
  setStatus: (id: string, status?: Status) => void;
} | null>(null);
const titles: Record<Kind, string> = {
  success: "Готово",
  info: "Информация",
  error: "Не удалось выполнить действие",
};
function appendNotification(items: Notification[], item: Notification) {
  const oldest =
    items.length >= 4
      ? (items.find((entry) => !entry.ongoing) ?? items[0])
      : undefined;
  return [...items.filter((entry) => entry !== oldest), item];
}

export function ActionNotificationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [items, setItems] = useState<Notification[]>([]);
  const sequence = useRef(0);
  const recentErrors = useRef(new Map<string, number>());
  const notify = useCallback<Notify>((kind, message, allowRepeat = false) => {
    if (!message.trim()) return;
    const now = Date.now();
    for (const [text, at] of recentErrors.current) {
      if (now - at >= 1500) recentErrors.current.delete(text);
    }
    if (kind === "error") {
      if (!allowRepeat && recentErrors.current.has(message)) return;
      recentErrors.current.set(message, now);
      // Keep deduplication metadata bounded even during a burst of errors.
      if (recentErrors.current.size > 32) {
        const oldest = recentErrors.current.keys().next().value;
        if (oldest !== undefined) recentErrors.current.delete(oldest);
      }
    }
    const item = { id: ++sequence.current, kind, message };
    setItems((current) => appendNotification(current, item));
  }, []);
  const setStatus = useCallback((id: string, status?: Status) => {
    setItems((current) => {
      const previous = current.find((item) => item.id === id);
      // A finished notification stays visible for its normal timeout.
      if (!status)
        return previous?.ongoing
          ? current.filter((item) => item.id !== id)
          : current;
      const item = {
        ...status,
        id,
        hidden: status.ongoing && previous?.hidden,
      };
      return previous
        ? current.map((entry) => (entry.id === id ? item : entry))
        : appendNotification(current, item);
    });
  }, []);
  const dismiss = useCallback((id: Notification["id"]) => {
    setItems((current) =>
      current.flatMap((item) => {
        if (item.id !== id) return [item];
        return item.ongoing ? [{ ...item, hidden: true }] : [];
      }),
    );
  }, []);
  const actions = useMemo(() => ({ notify, setStatus }), [notify, setStatus]);
  return (
    <NotificationsContext.Provider value={actions}>
      {children}
      {createPortal(
        <section
          className="action-notifications"
          aria-label="Уведомления о действиях"
        >
          <ul>
            {items
              .filter((item) => !item.hidden)
              .map((item) => (
                <ActionNotification
                  key={`${item.id}-${item.ongoing ? "progress" : "result"}`}
                  item={item}
                  dismiss={dismiss}
                />
              ))}
          </ul>
        </section>,
        document.body,
      )}
    </NotificationsContext.Provider>
  );
}

function ActionNotification({
  item,
  dismiss,
}: {
  item: Notification;
  dismiss: (id: Notification["id"]) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.kind === "error" ? 10000 : 6000);
  const paused = hovered || focused;
  useEffect(() => {
    if (item.ongoing || paused) return;
    const started = performance.now();
    const timeout = window.setTimeout(
      () => dismiss(item.id),
      remaining.current,
    );
    return () => {
      window.clearTimeout(timeout);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - started),
      );
    };
  }, [paused, item.id, item.ongoing, dismiss]);
  const Icon =
    item.kind === "error"
      ? AlertCircle
      : item.kind === "info"
        ? Info
        : CheckCircle2;
  return (
    <li
      className={`action-notification action-notification-${item.kind}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <Icon className="action-notification-icon" size={21} aria-hidden="true" />
      <div
        className="action-notification-content"
        role={item.kind === "error" ? "alert" : "status"}
        aria-live={item.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <strong>{item.title || titles[item.kind]}</strong>
        <p>{item.message}</p>
      </div>
      <button
        type="button"
        className="action-notification-close"
        onClick={() => dismiss(item.id)}
        aria-label="Закрыть уведомление"
      >
        <X size={17} aria-hidden="true" />
      </button>
    </li>
  );
}

/** Keep one notification up to date for a long running action. */
export function useActionStatus(
  id: string | undefined,
  { kind, message, title, ongoing }: Status,
) {
  const setStatus = useContext(NotificationsContext)?.setStatus;
  useEffect(() => {
    if (id) setStatus?.(id, { kind, message, title, ongoing });
  }, [id, kind, message, title, ongoing, setStatus]);
  useEffect(() => {
    if (id) return () => setStatus?.(id);
  }, [id, setStatus]);
}

/** Publish action feedback only. Persistent query/service errors stay in their views. */
export function ActionFeedback({
  notice,
  error,
  noticeKind = "success",
}: {
  notice?: string;
  error?: unknown;
  noticeKind?: "success" | "info";
}) {
  const notify = useContext(NotificationsContext)?.notify;
  const previousNotice = useRef("");
  const previousError = useRef("");
  const previousErrorValue = useRef<unknown>(undefined);
  const errorWasCleared = useRef(false);
  const message =
    error === undefined || error === null || error === false
      ? ""
      : errorText(error);
  useEffect(() => {
    if (notice && notice !== previousNotice.current)
      notify?.(noticeKind, notice);
    previousNotice.current = notice || "";
  }, [notice, noticeKind, notify]);
  useEffect(() => {
    if (!message && previousError.current) errorWasCleared.current = true;
    if (
      message &&
      (message !== previousError.current ||
        error !== previousErrorValue.current)
    ) {
      const repeatedAction =
        message === previousError.current &&
        error !== previousErrorValue.current;
      notify?.("error", message, errorWasCleared.current || repeatedAction);
      errorWasCleared.current = false;
    }
    previousError.current = message;
    previousErrorValue.current = error;
  }, [error, message, notify]);
  return null;
}
