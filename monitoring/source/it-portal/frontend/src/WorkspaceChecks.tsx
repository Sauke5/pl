import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Route, ScanLine, X } from "lucide-react";
import { api, queryClient } from "./api";
import type { Job, Resource } from "./types";
import { Button } from "./components/ui/button";
import { ErrorBox, Field } from "./components/common";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { toolsList, JobResult } from "./Operations";
import { BranchCheckDialog } from "./BranchCheck";
import { copy } from "./copy";
import { CheckTargetInput, checkTargetValue } from "./CheckTargetInput";

const checkEvent = "pl-ui-workspace-check";
export function openWorkspaceCheck(resource?: Resource) {
  window.dispatchEvent(new CustomEvent(checkEvent, { detail: resource }));
}

export function WorkspaceCheckButton() {
  return (
    <Button onClick={() => openWorkspaceCheck()}>
      <ScanLine size={16} />
      Проверить адрес
    </Button>
  );
}

export function WorkspaceCheckManager() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("dns");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("");
  const [resource, setResource] = useState<Resource>();
  const [duration, setDuration] = useState(10);
  const [direction, setDirection] = useState("upload");
  const [jobID, setJobID] = useState<string>();
  const [tracked, setTracked] = useState<string[]>([]);
  const [toast, setToast] = useState<Job>();
  const [branch, setBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submission = useRef<{ fingerprint: string; key: string } | undefined>(
    undefined,
  );
  const noticed = useRef(new Set<string>());
  useEffect(() => {
    const show = (event: Event) => {
      const next = (event as CustomEvent<Resource | undefined>).detail;
      setResource(next);
      if (next) {
        setTarget(
          next.check?.target || next.hostname || next.ip || next.url || "",
        );
        if (
          next.check?.kind &&
          toolsList.some((tool) => tool.kind === next.check.kind)
        )
          setKind(next.check.kind);
      }
      setJobID(undefined);
      setError(undefined);
      setOpen(true);
    };
    window.addEventListener(checkEvent, show);
    if (location.hash.split("?")[0] === "#tools") setOpen(true);
    return () => window.removeEventListener(checkEvent, show);
  }, []);
  const jobs = useQuery({
    queryKey: ["workspace-check-results", tracked],
    queryFn: () => Promise.all(tracked.map((id) => api<Job>(`/jobs/${id}`))),
    enabled: tracked.length > 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.every(
        (job) => !["queued", "running"].includes(job.status),
      )
        ? false
        : 2000,
  });
  const job = jobs.data?.find((item) => item.id === jobID);
  useEffect(() => {
    for (const completed of jobs.data || []) {
      if (
        ["queued", "running"].includes(completed.status) ||
        noticed.current.has(completed.id)
      )
        continue;
      noticed.current.add(completed.id);
      if (!open || jobID !== completed.id) setToast(completed);
      void queryClient.invalidateQueries({ queryKey: ["/operations"] });
    }
  }, [jobs.data, open, jobID]);
  async function execute() {
    setBusy(true);
    setError(undefined);
    const parameters = {
      kind,
      target: checkTargetValue(kind, target, port),
      ...(kind === "iperf" ? { direction, duration_seconds: duration } : {}),
    };
    const fingerprint = JSON.stringify([resource?.id || "", parameters]);
    if (submission.current?.fingerprint !== fingerprint)
      submission.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const created = await api<Job>("/jobs", "POST", {
        kind: "check",
        resource_id: resource?.id || "",
        integration_id: "",
        parameters,
        idempotency_key: submission.current.key,
        confirmed: false,
      });
      setJobID(created.id);
      setTracked((previous) => [
        ...new Set([...previous.slice(-19), created.id]),
      ]);
      void queryClient.invalidateQueries({ queryKey: ["/operations"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {open && (
        <WorkspaceDrawer
          helpTopic="tools"
          title="Проверка адреса"
          subtitle={resource?.name || "Ручная диагностика"}
          onClose={() => setOpen(false)}
        >
          {jobID ? (
            <>
              <JobResult job={job} error={jobs.error} />
              <div className="workspace-section">
                <Button
                  onClick={() => {
                    setJobID(undefined);
                    submission.current = undefined;
                  }}
                >
                  Новая проверка
                </Button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void execute();
              }}
            >
              <div
                className="workspace-check-options"
                role="group"
                aria-label="Тип проверки"
              >
                {toolsList.map((tool) => (
                  <Button
                    key={tool.kind}
                    size="sm"
                    aria-pressed={kind === tool.kind}
                    onClick={() => setKind(tool.kind)}
                  >
                    <tool.icon size={15} />
                    {tool.protocol}
                  </Button>
                ))}
              </div>
              <CheckTargetInput
                kind={kind}
                target={target}
                port={port}
                onTargetChange={setTarget}
                onPortChange={setPort}
              />
              {kind === "iperf" && (
                <div className="form-grid">
                  <Field label="Направление">
                    <select
                      value={direction}
                      onChange={(event) => setDirection(event.target.value)}
                    >
                      <option value="upload">Прямое</option>
                      <option value="download">Реверсивное</option>
                    </select>
                  </Field>
                  <Field label="Длительность">
                    <select
                      value={duration}
                      onChange={(event) =>
                        setDuration(Number(event.target.value))
                      }
                    >
                      {[5, 10, 15].map((seconds) => (
                        <option key={seconds} value={seconds}>
                          {seconds} с
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
              <p className="notice">
                {kind === "icmp"
                  ? "2000 пакетов, интервал 2 мс. Параметры заданы на сервере."
                  : kind === "iperf"
                    ? "Запуск с сервера платформы. Тест создаёт нагрузку на канал в течение выбранного времени."
                    : copy.checkOrigin}
              </p>
              <p className="muted">
                {toolsList.find((tool) => tool.kind === kind)?.hint}
              </p>
              {!!error && <ErrorBox error={error} />}
              <div className="actions">
                <Button type="submit" variant="default" disabled={busy}>
                  {busy ? (
                    "Запускаем…"
                  ) : (
                    <>
                      <Play size={16} />
                      Запустить проверку
                    </>
                  )}
                </Button>
                <Button onClick={() => setBranch(true)}>
                  <Route size={16} />
                  MTR через Wayline
                </Button>
              </div>
            </form>
          )}
        </WorkspaceDrawer>
      )}
      {branch && <BranchCheckDialog onClose={() => setBranch(false)} />}
      {toast &&
        createPortal(
          <div className="workspace-toast" role="status">
            <span>
              {toast.status === "succeeded"
                ? "Проверка завершена"
                : toast.status === "unknown"
                  ? "Результат проверки неизвестен"
                  : "Проверка завершилась с ошибкой"}
              <small>{String(toast.parameters?.target || "")}</small>
            </span>
            <Button
              size="sm"
              onClick={() => {
                setJobID(toast.id);
                setToast(undefined);
                setOpen(true);
              }}
            >
              Открыть результат
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Закрыть уведомление"
              onClick={() => setToast(undefined)}
            >
              <X size={16} />
            </Button>
          </div>,
          document.body,
        )}
    </>
  );
}
