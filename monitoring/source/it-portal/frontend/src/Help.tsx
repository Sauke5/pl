import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CircleHelp, X } from "lucide-react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import { api } from "./api";
import { helpTopics, type HelpTopic } from "./helpTopics";
import { Button } from "./components/ui/button";
import { ru } from "./ru";

type HelpState = { disabled: boolean; seen: string[] };
type Patch = { topic: HelpTopic; disabled?: boolean };
type Write = { patch: Patch; version: number };
type Scope = { id: string; topic?: HelpTopic; level: number };
type HelpContextValue = {
  open: boolean;
  register: (scope: Scope) => () => void;
  replay: (topic?: HelpTopic) => void;
  feedback: ReactNode;
};
const HelpContext = createContext<HelpContextValue | null>(null);
const stateKey = ["/help-state"];

export function HelpProvider({
  children,
  userID,
}: {
  children: ReactNode;
  userID: string;
}) {
  const client = useQueryClient();
  const state = useQuery<HelpState>({
    queryKey: [...stateKey, userID],
    queryFn: () =>
      api("/help-state", "GET", undefined, {}, AbortSignal.timeout(10000)),
    staleTime: "static",
    retry: 1,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [current, setCurrent] = useState<HelpTopic>();
  const [localSeen, setLocalSeen] = useState<Set<string>>(() => new Set());
  const [localDisabled, setLocalDisabled] = useState<boolean>();
  const [failed, setFailed] = useState<Write[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingWrites = useRef(0);
  const preferenceVersion = useRef(0);
  const [retrying, setRetrying] = useState(false);
  const [hideLoadError, setHideLoadError] = useState(false);
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const register = useCallback((scope: Scope) => {
    setScopes((items) => [
      ...items.filter((item) => item.id !== scope.id),
      scope,
    ]);
    return () =>
      setScopes((items) => items.filter((item) => item.id !== scope.id));
  }, []);
  const active = [...scopes].sort((a, b) => a.level - b.level).at(-1);
  const activeTopic = active?.topic;
  const disabled = localDisabled ?? state.data?.disabled ?? false;
  useEffect(() => {
    if (
      current ||
      !state.data ||
      disabled ||
      !activeTopic ||
      localSeen.has(activeTopic) ||
      state.data.seen.includes(activeTopic)
    )
      return;
    const timer = setTimeout(() => setCurrent(activeTopic), 240);
    return () => clearTimeout(timer);
  }, [activeTopic, current, disabled, localSeen, state.data]);
  const replay = useCallback(
    (topic?: HelpTopic) => {
      const selected =
        topic ||
        activeTopic ||
        [...scopes].reverse().find((scope) => scope.topic)?.topic;
      if (selected) setCurrent(selected);
      if (
        !pendingWrites.current &&
        !failedRef.current.length &&
        localDisabled === undefined
      )
        void state.refetch();
    },
    [activeTopic, scopes, localDisabled, state.refetch],
  );
  function persist(write: Write) {
    pendingWrites.current += 1;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        const patch = { ...write.patch };
        if (write.version !== preferenceVersion.current) delete patch.disabled;
        try {
          const updated = await api<HelpState>(
            "/help-state",
            "PATCH",
            patch,
            {},
            AbortSignal.timeout(10000),
          );
          client.setQueryData<HelpState>([...stateKey, userID], (previous) => ({
            seen: [...new Set([...(previous?.seen || []), ...updated.seen])],
            disabled: patch.disabled ?? previous?.disabled ?? updated.disabled,
          }));
          setFailed((items) => items.filter((item) => item !== write));
        } catch {
          setFailed((items) =>
            items.includes(write) ? items : [...items, write],
          );
        } finally {
          pendingWrites.current -= 1;
        }
      });
    return queue.current;
  }
  function dismiss(
    topic: HelpTopic,
    nextDisabled: boolean,
    initialDisabled: boolean,
  ) {
    setLocalSeen((seen) => new Set([...seen, topic]));
    const patch: Patch = { topic };
    if (nextDisabled !== initialDisabled) {
      patch.disabled = nextDisabled;
      setLocalDisabled(nextDisabled);
      preferenceVersion.current += 1;
    }
    setCurrent(undefined);
    void persist({ patch, version: preferenceVersion.current });
  }
  async function retry() {
    setRetrying(true);
    try {
      if (state.error) await state.refetch();
      for (const write of failedRef.current) await persist(write);
    } finally {
      setRetrying(false);
    }
  }
  const loadError = !!state.error && !hideLoadError;
  const feedback =
    failed.length > 0 || loadError ? (
      <div className="help-save-notice" role="status">
        <span>{failed.length ? ru.help_save_failed : ru.help_load_failed}</span>
        <Button size="sm" disabled={retrying} onClick={() => void retry()}>
          {ru.help_retry}
        </Button>
        {!failed.length && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={ru.zakryt}
            onClick={() => setHideLoadError(true)}
          >
            <X size={15} />
          </Button>
        )}
      </div>
    ) : null;
  const context = { open: !!current, register, replay, feedback };
  return (
    <HelpContext.Provider value={context}>
      {children}
      {!scopes.some((scope) => scope.level >= 10) && feedback}
      {current && (
        <HelpCoach
          key={current}
          topic={current}
          initialDisabled={disabled}
          stateKnown={!!state.data}
          onClose={(next) => dismiss(current, next, disabled)}
        />
      )}
    </HelpContext.Provider>
  );
}

export function useHelpTopic(topic?: HelpTopic, level = 0) {
  const help = useContext(HelpContext);
  const id = useId();
  const register = help?.register;
  useEffect(
    () => register?.({ id, topic, level }),
    [register, id, topic, level],
  );
}
export function HelpFeedback() {
  return useContext(HelpContext)?.feedback ?? null;
}
export function useHelpOpen() {
  return useContext(HelpContext)?.open ?? false;
}
export function HelpButton({
  topic,
  sidebar = false,
}: {
  topic?: HelpTopic;
  sidebar?: boolean;
}) {
  const help = useContext(HelpContext);
  if (!help) return null;
  if (sidebar)
    return (
      <button
        data-help-replay
        title={ru.help_show}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          help.replay(topic);
        }}
      >
        <CircleHelp size={21} />
        <span>{ru.help_show}</span>
      </button>
    );
  return (
    <Button
      data-help-replay
      className="help-replay-button"
      variant="ghost"
      size="sm"
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        help.replay(topic);
      }}
    >
      <CircleHelp size={16} />
      {ru.help_show}
    </Button>
  );
}

function HelpCoach({
  topic,
  initialDisabled,
  stateKnown,
  onClose,
}: {
  topic: HelpTopic;
  initialDisabled: boolean;
  stateKnown: boolean;
  onClose: (disabled: boolean) => void;
}) {
  const content = helpTopics[topic];
  const [disabled, setDisabled] = useState(initialDisabled);
  const checkboxChanged = useRef(false);
  useEffect(() => {
    if (!checkboxChanged.current) setDisabled(initialDisabled);
  }, [initialDisabled]);
  const reduced = useReducedMotion();
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const primary = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    onClose(disabled);
  };
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <LazyMotion features={domAnimation}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="help-overlay" />
          <DialogPrimitive.Content
            asChild
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              primary.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = previousFocus.current;
              requestAnimationFrame(() => {
                if (target?.isConnected) target.focus();
              });
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <m.section
              data-help-topic={topic}
              className="help-coach"
              onKeyDownCapture={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                close();
              }}
              initial={reduced ? false : { opacity: 0, y: 9, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 350, damping: 31 }
              }
              transformTemplate={(_, transform) =>
                `translate(-50%, -50%) ${transform === "none" ? "" : transform}`
              }
            >
              <div className="help-coach-top">
                <span>
                  <CircleHelp size={17} />
                  {ru.help_heading}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={ru.help_close}
                  onClick={close}
                >
                  <X size={20} />
                </Button>
              </div>
              <DialogPrimitive.Title className="help-title">
                {content.title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {content.steps.join(" ")}
              </DialogPrimitive.Description>
              <ol className="help-steps">
                {content.steps.map((step, index) => (
                  <li key={step}>
                    <span aria-hidden="true">{index + 1}</span>
                    <p>{step}</p>
                  </li>
                ))}
              </ol>
              <div className="help-coach-footer">
                <label className="help-disable">
                  <input
                    type="checkbox"
                    checked={disabled}
                    disabled={!stateKnown}
                    onChange={(event) => {
                      checkboxChanged.current = true;
                      setDisabled(event.target.checked);
                    }}
                  />
                  {ru.help_disable}
                </label>
                <Button ref={primary} variant="default" onClick={close}>
                  {ru.help_understood}
                </Button>
              </div>
            </m.section>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </LazyMotion>
    </DialogPrimitive.Root>
  );
}
