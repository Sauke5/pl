import { useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  FolderOpen,
  HardDrive,
  Settings2,
} from "lucide-react";
import { api, APIError, useAPI } from "./api";
import type { Session } from "./types";
import { PlatformShell } from "@pl/ui/react";
import { Button } from "./components/ui/button";
import { ErrorBox } from "./components/common";
import "./sftp-administration.css";

type SFTPAdministrationState = {
  configured: boolean;
  can_admin: boolean;
  can_access_files: boolean;
  files_reason?: string;
  native_username?: string;
};

export default function SFTPAdministration({ session }: { session: Session }) {
  const state = useAPI<SFTPAdministrationState>("/sftp-adm");
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const data = state.error ? undefined : state.data;
  const admin = session.user?.admin === true;
  const filesEnabled =
    data?.configured === true && data.can_access_files === true;
  const adminEnabled =
    admin && data?.configured === true && data.can_admin === true;

  async function logout() {
    try {
      await api("/auth/logout", "POST", {});
      location.assign("/");
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 401) {
        location.assign("/");
      } else setError(cause);
    }
  }

  async function copyUsername(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError(new Error("Не удалось скопировать логин."));
    }
  }

  return (
    <PlatformShell
      shellClassName="sftp-adm-shell"
      context="Файловый сервер"
      user={{
        name: session.user?.name || session.user?.id,
        subtitle: "Пользователь Платформы",
      }}
      onLogout={logout}
      navigation={
        <>
          <button className="active" aria-current="page" aria-label="Файловый сервер" title="Файловый сервер">
            <HardDrive size={21} />
            <span>Файловый сервер</span>
          </button>
          {admin && (
            <button
              aria-label="Обмен базами"
              title="Обмен базами"
              onClick={() => location.assign("/sftp-server")}
            >
              <Archive size={21} />
              <span>Обмен базами</span>
            </button>
          )}
        </>
      }
      sidebarFooter={
        <>
          <a className="sftp-adm-back" href="/" aria-label="Платформа" title="Платформа">
            <ArrowLeft size={18} />
            <span>Платформа</span>
          </a>
          <div className="sidebar-footer">
            <strong>PL</strong>
            <span>IT PLATFORM</span>
          </div>
        </>
      }
    >
          <div className="sftp-adm-heading">
            <h1>Файловый сервер</h1>
            <p className="muted">Файлы и настройки SFTPGo</p>
          </div>
          {!!error && <ErrorBox error={error} />}
          {state.isPending ? (
            <div className="panel sftp-adm-state" role="status">
              Проверка доступа…
            </div>
          ) : state.error ? (
            <ErrorBox error={state.error} retry={() => void state.refetch()} />
          ) : !data?.configured ? (
            <div className="panel sftp-adm-state" role="status">
              Веб-интерфейс SFTPGo не подключён.
            </div>
          ) : (
            <>
              <div className="sftp-adm-grid">
                <section className="panel sftp-adm-entry">
                  <FolderOpen size={26} aria-hidden="true" />
                  <h2>Файлы</h2>
                  <p>Каталоги, загрузка и скачивание файлов.</p>
                  {filesEnabled ? (
                    <a
                      className="button button-primary"
                      href="/sftp-adm/open/files"
                    >
                      Открыть файлы
                      <ArrowRight size={16} />
                    </a>
                  ) : (
                    <p className="sftp-adm-unavailable" role="status">
                      {data.files_reason || "Доступ к файлам не выдан."}
                    </p>
                  )}
                </section>
                {admin && (
                  <section className="panel sftp-adm-entry">
                    <Settings2 size={26} aria-hidden="true" />
                    <h2>Администрирование</h2>
                    <p>Пользователи, папки, права доступа и квоты.</p>
                    {adminEnabled ? (
                      <a
                        className="button button-secondary"
                        href="/sftp-adm/open/admin"
                      >
                        Открыть управление
                        <ArrowRight size={16} />
                      </a>
                    ) : (
                      <p className="sftp-adm-unavailable" role="status">
                        Администрирование недоступно.
                      </p>
                    )}
                  </section>
                )}
              </div>
              {data.native_username && (
                <div className="sftp-adm-identity">
                  <span>Ваша учётная запись</span>
                  <code>{data.native_username}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      copied ? "Логин скопирован" : "Скопировать логин"
                    }
                    title={copied ? "Логин скопирован" : "Скопировать логин"}
                    onClick={() => {
                      void copyUsername(data.native_username!);
                    }}
                  >
                    {copied ? <Check size={17} /> : <Copy size={17} />}
                  </Button>
                </div>
              )}
            </>
          )}
    </PlatformShell>
  );
}
