import { type ReactNode } from "react";
import { ArrowLeft, LockKeyhole, SearchX } from "lucide-react";
import { ThemeToggle } from "./Theme";
import "./auth-scenes.css";

import { Brand as SharedBrand } from "@pl/ui/react";
export function Brand() {
  return (
    <SharedBrand
      branding={{ name: "PL", subtitle: "PLATFORM", label: "Platform" }}
    />
  );
}

export function SceneArt({ kind }: { kind: "login" | "401" | "404" }) {
  return (
    <div className={`auth-art auth-art-${kind}`} aria-hidden="true">
      <div className="auth-art-line auth-art-line-one" />
      <div className="auth-art-line auth-art-line-two" />
      {kind === "404" ? (
        <div className="auth-art-map">
          <div className="auth-art-node auth-art-node-one">
            <span className="brand-mark">
              <span />
              <span />
              <span />
              <span />
            </span>
          </div>
          <div className="auth-art-node auth-art-node-two">
            <span className="brand-mark">
              <span />
              <span />
              <span />
              <span />
            </span>
          </div>
          <div className="auth-art-node auth-art-node-three">
            <span className="brand-mark">
              <span />
              <span />
              <span />
              <span />
            </span>
          </div>
          <div className="auth-art-missing">
            <SearchX size={46} strokeWidth={1.25} />
          </div>
        </div>
      ) : (
        <div className="auth-art-gateway">
          <div className="auth-art-pane auth-art-pane-back" />
          <div className="auth-art-pane auth-art-pane-middle" />
          <div className="auth-art-pane auth-art-pane-front">
            <LockKeyhole size={88} strokeWidth={1.05} />
          </div>
        </div>
      )}
    </div>
  );
}

export function AuthScene({
  children,
  kind,
}: {
  children: ReactNode;
  kind: "login" | "401" | "404";
}) {
  return (
    <div className={`auth-scene auth-scene-${kind}`}>
      <header className="auth-scene-header">
        <Brand />
        <ThemeToggle />
      </header>
      <main className="auth-scene-layout">
        <div className="auth-scene-content">{children}</div>
        <SceneArt kind={kind} />
      </main>
    </div>
  );
}

export function LoginSuccess() {
  return (
    <div className="login-success" role="status" aria-live="polite">
      <div className="login-success-gateway" aria-hidden="true">
        <span className="login-success-panel login-success-panel-left" />
        <span className="login-success-panel login-success-panel-right" />
        <span className="login-success-mark">
          <span className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </span>
        </span>
      </div>
      <strong>Вход выполнен</strong>
      <span>Открываем Платформу…</span>
    </div>
  );
}

export function ErrorSceneContent({
  kind,
  embedded = false,
  returnTarget,
}: {
  kind: "401" | "403" | "404";
  embedded?: boolean;
  returnTarget?: string;
}) {
  const title =
    kind === "401"
      ? "Требуется вход"
      : kind === "403"
        ? "Нет доступа"
        : "Страница не найдена";
  const description =
    kind === "401"
      ? "Войдите в Платформу, чтобы открыть эту страницу."
      : kind === "403"
        ? "У вашей учётной записи нет прав для этой страницы."
        : "Возможно, ссылка устарела или в адресе есть ошибка.";
  function goBack() {
    const referrer = document.referrer;
    try {
      const url = new URL(referrer);
      if (
        url.origin === location.origin &&
        url.pathname !== location.pathname &&
        !url.pathname.startsWith("/auth/")
      ) {
        history.back();
        return;
      }
    } catch {
      /* no useful history */
    }
    location.assign("/");
  }
  return (
    <div
      className={`error-scene-content ${embedded ? "error-scene-embedded" : ""}`}
    >
      <span className="error-scene-code" aria-hidden="true">
        {kind}
      </span>
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="error-scene-actions">
        {kind === "401" ? (
          <a
            className="button button-primary"
            href={
              returnTarget
                ? `/?return_to=${encodeURIComponent(returnTarget)}`
                : "/"
            }
          >
            Войти в Платформу
          </a>
        ) : (
          <a className="button button-primary" href="/">
            На главную
          </a>
        )}
        {kind === "404" ? (
          <button
            className="button button-secondary"
            type="button"
            onClick={goBack}
          >
            <ArrowLeft size={16} />
            Назад
          </button>
        ) : (
          <a className="button button-secondary" href="/">
            На главную
          </a>
        )}
      </div>
    </div>
  );
}
