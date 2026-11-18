import { Download } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { APIError, apiResponse, errorText } from "./api";
import "./ocserv-profile-download.css";

export default function OcservProfileDownload({
  path,
  mode,
  onUnavailable,
}: {
  path: string;
  mode?: string;
  onUnavailable?: () => void;
}) {
  const request = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => () => request.current?.abort(), [path]);
  async function download(event: MouseEvent<HTMLAnchorElement>) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await apiResponse(
        path,
        "GET",
        undefined,
        {},
        controller.signal,
      );
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename =
        /\bfilename="?([a-z\d_.@+-]+\.(?:zip|conf))"?(?:\s*;|$)/i.exec(
          disposition,
        )?.[1];
      if (!filename || !/^attachment\b/i.test(disposition))
        throw new Error("Шлюз вернул ответ без профиля OpenConnect.");
      const url = URL.createObjectURL(await response.blob());
      try {
        if (controller.signal.aborted) return;
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(errorText(cause));
        if (cause instanceof APIError && [403, 404, 410].includes(cause.status))
          onUnavailable?.();
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="vpn-profile-download">
      <a
        className="button button-primary"
        href={"/api/v1" + path}
        aria-disabled={busy}
        onClick={(event) => void download(event)}
      >
        <Download size={16} />{" "}
        {busy ? "Получаем профиль…" : "Скачать профиль OpenConnect"}
      </a>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <details>
        <summary>Как подключиться</summary>
        <p>
          {mode === "certificate"
            ? "Распакуйте все файлы ZIP в одну папку."
            : mode === "oidc"
              ? "Сохраните профиль как pl-vpn.conf."
              : "Распакуйте ZIP в одну папку или сохраните полученный файл как pl-vpn.conf."}{" "}
          Откройте терминал в папке с профилем. Понадобится установленный
          OpenConnect.
        </p>
        <p>Windows, терминал от имени администратора</p>
        <code>openconnect.exe --config pl-vpn.conf</code>
        <p>Linux и macOS</p>
        <code>sudo openconnect --config pl-vpn.conf</code>
        {mode === "oidc" && <p>Завершите вход через Dex в браузере.</p>}
      </details>
    </div>
  );
}
