import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { resolveApiBaseUrl } from "@kaneo/libs";
import { useTranslation } from "react-i18next";

import { useDoskaSession } from "./session";
import { parseLiveEvent } from "./live-events";
import { createLiveCacheScheduler } from "./live-cache";
import { clearLiveData, reconcileLiveAccess } from "./live-reconcile";

/** Keep drafts mounted during access checks; no stale private content is visible. */
export function DoskaLiveUpdates({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { context } = useDoskaSession();
  const { t } = useTranslation("doska");
  const [checking, setChecking] = useState(true);
  const [checkedUser, setCheckedUser] = useState<string | null>(null);
  const previousUser = useRef(context.user.id);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let connection = 0;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let checkingAccess = false;
    let accessController: AbortController | undefined;
    let checkAgain = false;
    let ready = false;
    let accessFailed = false;
    const scheduler = createLiveCacheScheduler(client, {
      onResync: () => void reconcile(),
    });
    async function reconcile() {
      if (disposed) return;
      if (checkingAccess) {
        checkAgain = true;
        return;
      }
      checkingAccess = true;
      setChecking(true);
      const current = ++generation;
      accessController = new AbortController();
      try {
        const result = await reconcileLiveAccess(
          client,
          context.user.id,
          () => !disposed && current === generation,
          undefined,
          accessController.signal,
        );
        if (disposed || current !== generation) return;
        if (result !== "same-user") return;
        accessFailed = false;
        setFailed(false);
        if (!checkAgain) {
          setCheckedUser(context.user.id);
          setChecking(false);
        }
        scheduler.resyncAvailableQueries();
      } catch {
        if (disposed || current !== generation) return;
        accessFailed = true;
        setFailed(true);
      } finally {
        checkingAccess = false;
        if (checkAgain && !disposed) {
          checkAgain = false;
          void reconcile();
        }
      }
    }
    function reconnect() {
      if (disposed) return;
      ready = false;
      connection++;
      clearTimeout(readyTimer);
      source?.close();
      void reconcile();
      clearTimeout(retry);
      retry = setTimeout(connect, 1000 + Math.random() * 2000);
    }
    function connect() {
      if (disposed) return;
      const epoch = ++connection;
      ready = false;
      const opened = new EventSource(
        resolveApiBaseUrl(
          import.meta.env.VITE_API_URL,
          import.meta.env.BASE_URL,
          import.meta.env.VITE_DOSKA_MODE,
        ) + "/doska/events",
      );
      source = opened;
      readyTimer = setTimeout(() => {
        if (!disposed && epoch === connection && !ready) reconnect();
      }, 5000);
      for (const name of ["ready", "changed", "personal", "reset"]) {
        opened.addEventListener(name, (message) => {
          if (disposed || epoch !== connection || source !== opened) return;
          const event = parseLiveEvent(
            name,
            (message as MessageEvent<string>).data,
          );
          if (!event || (!ready && event.type !== "ready")) {
            reconnect();
            return;
          }
          if (event.type === "ready") {
            if (ready) {
              reconnect();
              return;
            }
            ready = true;
            clearTimeout(readyTimer);
          }
          if (
            event.type === "reset" ||
            (event.type === "changed" &&
              event.scopes.some(
                (scope) => scope === "access" || scope === "members",
              ))
          ) {
            void reconcile();
            return;
          }
          if (checkingAccess) {
            checkAgain = true;
            return;
          }
          scheduler.accept(event);
        });
      }
      opened.onerror = () => {
        if (!disposed && epoch === connection && source === opened) reconnect();
      };
    }
    void (async () => {
      if (previousUser.current !== context.user.id) {
        await clearLiveData(client, () => !disposed);
        if (disposed) return;
        previousUser.current = context.user.id;
      }
      if (!disposed) connect();
    })();
    // A failed connection cannot retain an unchecked session indefinitely.
    const offlineCheck = setInterval(() => {
      if (!ready || accessFailed) void reconcile();
    }, 5000);
    return () => {
      disposed = true;
      accessController?.abort();
      generation++;
      connection++;
      clearTimeout(readyTimer);
      clearInterval(offlineCheck);
      clearTimeout(retry);
      source?.close();
      scheduler.stop();
    };
  }, [client, context.user.id]);
  const blocked = checking || checkedUser !== context.user.id;
  return (
    <>
      {blocked && (
        <div className="doska-live-check" role="status">
          {t(failed ? "sessionError" : "loading")}
        </div>
      )}
      <div
        key={context.user.id}
        inert={blocked}
        style={blocked ? { visibility: "hidden" } : undefined}
      >
        {children}
      </div>
    </>
  );
}
