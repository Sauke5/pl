import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";

type Context = Awaited<ReturnType<typeof api.getContext>>;
const SessionContext = createContext<{ context: Context } | null>(null);
export function useDoskaSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Session is not verified");
  return session;
}
export function DoskaSession({ children }: { children: ReactNode }) {
  const { t } = useTranslation("doska");
  const session = useQuery({
    queryKey: ["doska", "context"],
    queryFn: api.getContext,
    retry: false,
    staleTime: 60_000,
  });
  if (!session.data || session.isError) {
    const unauthorized =
      session.error &&
      "status" in session.error &&
      session.error.status === 401;
    return (
      <div className="doska-app doska-gate">
        <section className="doska-panel" aria-live="polite">
          <h1>{t("app")}</h1>
          <p>
            {session.isPending
              ? t("loading")
              : unauthorized
                ? t("signInRequired")
                : t("sessionError")}
          </p>
          {unauthorized ? (
            <a className="doska-button" href="/">
              {t("signIn")}
            </a>
          ) : (
            session.isError && (
              <button onClick={() => void session.refetch()}>
                {t("retry")}
              </button>
            )
          )}
        </section>
      </div>
    );
  }
  return (
    <SessionContext.Provider value={{ context: session.data }}>
      {children}
    </SessionContext.Provider>
  );
}
