import { Download } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiResponse } from "./api";
import { ErrorBox, Field } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";

const periodLabels: Record<number, string> = {
  1: "Последний час",
  6: "Последние 6 часов",
  24: "Последние сутки",
  72: "Последние 3 дня",
  168: "Последние 7 дней",
};

type ExportState =
  | { status: "idle" | "loading" }
  | { status: "error"; error: unknown }
  | { status: "downloading"; partial: boolean };

export function RuntimeLogExport({ periods }: { periods: number[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Download size={16} aria-hidden />
        Экспорт логов
      </Button>
      {open && (
        <LogExportDialog periods={periods} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function LogExportDialog({
  periods,
  onClose,
}: {
  periods: number[];
  onClose: () => void;
}) {
  const [selectedHours, setSelectedHours] = useState(24);
  const [state, setState] = useState<ExportState>({ status: "idle" });
  const request = useRef<AbortController | null>(null);
  const hours = periods.includes(selectedHours) ? selectedHours : periods[0];
  const busy = state.status === "loading";

  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    onClose();
  }

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ status: "loading" });
    try {
      const response = await apiResponse(
        "/runtime/log-export",
        "POST",
        { hours },
        { Accept: "application/zip" },
        controller.signal,
      );
      const type = response.headers.get("Content-Type")?.split(";")[0].trim();
      if (type !== "application/zip")
        throw new Error("Сервер не вернул ZIP-архив.");
      const archive = await response.blob();
      if (controller.signal.aborted) return;
      if (archive.size === 0) throw new Error("Сервер вернул пустой архив.");

      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = /\bfilename="(pl-diagnostics-\d{8}T\d{6}Z\.zip)"/.exec(
        disposition,
      )?.[1];
      const url = URL.createObjectURL(archive);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename ?? "pl-diagnostics.zip";
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setState({
        status: "downloading",
        partial: response.headers.get("X-PL-Log-Export-Partial") === "true",
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          status: "error",
          error:
            error instanceof TypeError
              ? new Error("Не удалось получить архив с сервера.")
              : error,
        });
      }
    } finally {
      request.current = null;
    }
  }

  return (
    <Dialog
      title="Экспорт логов"
      description="Выберите период для диагностического архива."
      onClose={close}
    >
      <form className="runtime-log-export-form" onSubmit={download}>
        <Field label="Период">
          <select
            value={hours}
            onChange={(event) => {
              setSelectedHours(Number(event.target.value));
              setState({ status: "idle" });
            }}
            disabled={busy}
          >
            {periods.map((period) => (
              <option key={period} value={period}>
                {periodLabels[period] ?? `Последние ${period} ч`}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">
          В архив войдут доступные логи PL, установленных локальных модулей и
          системных служб установки, а также события, аудит и операции. Глубина
          зависит от сохранённой истории. Состав архива описан в{" "}
          <code>manifest.json</code>.
        </p>
        {state.status === "error" && <ErrorBox error={state.error} />}
        <div role="status">
          {busy && <p className="muted">Собираем архив…</p>}
          {state.status === "downloading" && (
            <p className={state.partial ? "notice" : "muted"}>
              Скачивание началось.
              {state.partial && (
                <>
                  {" "}
                  Часть источников недоступна или выгружена не полностью.
                  Подробности в <code>manifest.json</code>.
                </>
              )}
            </p>
          )}
        </div>
        <div className="actions">
          <Button type="button" variant="secondary" onClick={close}>
            {state.status === "downloading" ? "Готово" : "Отмена"}
          </Button>
          <Button type="submit" variant="default" disabled={busy}>
            <Download size={16} aria-hidden />
            Скачать ZIP
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
