import { BranchCheckDialog } from "./BranchCheck";
import { ru } from "./ru";
import "./quick-tools.css";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Gauge,
  Route,
  Box,
  FileText,
  Globe,
  Network,
  Plus,
  Shield,
  Clock,
  RefreshCw,
} from "lucide-react";
import { api, useAPI, refresh, date } from "./api";
import type { Resource, Integration, Job, Report } from "./types";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import {
  Badge,
  Empty,
  ErrorBox,
  ExternalLink,
  Field,
  JSONView,
  Panel,
} from "./components/common";
import { copy, statusLabel } from "./copy";
import { CheckTargetInput, checkTargetValue } from "./CheckTargetInput";
export function OperationDialog({
  kind,
  resource,
  onClose,
}: {
  kind: string;
  resource?: Resource;
  onClose: () => void;
}) {
  const integrations = useAPI<Integration[]>("/integrations");
  const [checkKind, setCheckKind] = useState(resource?.check?.kind || "dns");
  const [target, setTarget] = useState(
    resource?.check?.target || resource?.hostname || resource?.url || "",
  );
  const [checkPort, setCheckPort] = useState("");
  const [dateValue, setDateValue] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [iperfDirection, setIperfDirection] = useState("upload");
  const [iperfDuration, setIperfDuration] = useState(10);
  const [integration, setIntegration] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [jobID, setJobID] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const job = useAPI<Job>(`/jobs/${jobID}`, !!jobID);
  const reports =
    integrations.data?.filter((i) => i.kind === "reports" && i.enabled) || [];
  const actualIntegration = integration || reports[0]?.id || "";
  async function execute() {
    setBusy(true);
    setError(undefined);
    try {
      const job = await api<Job>("/jobs", "POST", {
        kind,
        resource_id: resource?.id || "",
        integration_id: kind === "report" ? actualIntegration : "",
        parameters:
          kind === "check"
            ? {
                kind: checkKind,
                target: checkTargetValue(checkKind, target, checkPort),
                ...(checkKind === "iperf"
                  ? {
                      direction: iperfDirection,
                      duration_seconds: iperfDuration,
                    }
                  : {}),
              }
            : kind === "report"
              ? { target_date: dateValue }
              : {},
        idempotency_key: key,
        confirmed,
      });
      setJobID(job.id);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      helpTopic={
        kind === "restart"
          ? "operation-restart"
          : kind === "report"
            ? "operation-report"
            : "operation-check"
      }
      title={
        kind === "restart"
          ? ru.perezapusk_konteynera
          : kind === "report"
            ? ru.sformirovat_otchyot
            : ru.zapustit_proverku
      }
      onClose={onClose}
    >
      {jobID ? (
        <>
          <JobResult job={job.data} error={job.error} />
          {kind === "check" &&
            !["queued", "running"].includes(job.data?.status || "queued") && (
              <div className="dialog-footer">
                <Button
                  onClick={() => {
                    setJobID("");
                    setKey(crypto.randomUUID());
                  }}
                >
                  Новая проверка
                </Button>
              </div>
            )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void execute();
          }}
        >
          {resource?.name && (
            <p className="operation-resource">
              {ru.resurs_2}
              <strong>{resource.name}</strong>
            </p>
          )}
          {kind === "check" && (
            <>
              <div className="check-form">
                <div
                  className="check-kind-picker"
                  role="group"
                  aria-label="Тип проверки"
                >
                  {toolsList.map((tool) => (
                    <button
                      type="button"
                      key={tool.kind}
                      aria-pressed={checkKind === tool.kind}
                      onClick={() => setCheckKind(tool.kind)}
                    >
                      <tool.icon size={17} />
                      {tool.protocol}
                    </button>
                  ))}
                </div>
                <CheckTargetInput
                  kind={checkKind}
                  target={target}
                  port={checkPort}
                  onTargetChange={setTarget}
                  onPortChange={setCheckPort}
                />
              </div>
              {checkKind === "iperf" && (
                <div className="iperf-options">
                  <Field label="Направление">
                    <select
                      value={iperfDirection}
                      onChange={(e) => setIperfDirection(e.target.value)}
                    >
                      <option value="upload">Прямое</option>
                      <option value="download">Реверсивное</option>
                    </select>
                  </Field>
                  <Field label="Длительность">
                    <select
                      value={iperfDuration}
                      onChange={(e) => setIperfDuration(Number(e.target.value))}
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
                {checkKind === "iperf"
                  ? "Запуск с сервера платформы. Тест создаёт нагрузку на канал в течение выбранного времени."
                  : copy.checkOrigin}
              </p>
              <p className="muted">
                {toolsList.find((tool) => tool.kind === checkKind)?.hint}
              </p>
            </>
          )}
          {kind === "report" && (
            <>
              {reports.length ? (
                <Field label={ru.generator}>
                  <select
                    value={actualIntegration}
                    onChange={(e) => setIntegration(e.target.value)}
                  >
                    {reports.map((i) => (
                      <option value={i.id} key={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Empty
                  title={ru.generator_ne_podklyuchyon}
                  detail={ru.dobavte_integratsiyu_otchyotov_v_nastroykah}
                />
              )}
              <Field label={ru.period_otchyota}>
                <input
                  type="date"
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                  required
                />
              </Field>
            </>
          )}
          {kind === "restart" && (
            <>
              <div className="danger-notice">
                <strong>
                  {ru.tsel + " "}
                  {resource?.executor_target || ru.ne_zadana}
                </strong>
                <p>
                  {
                    ru.konteyner_budet_ostanovlen_i_zapuschen_servis_mozhet_vremenno_
                  }
                </p>
                <p>
                  {
                    ru.posle_neopredelyonnogo_rezultata_avtomaticheskogo_povtora_ne_b
                  }
                </p>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {ru.podtverzhdayu_perezapusk_ukazannogo_konteynera}
              </label>
            </>
          )}
          {!!error && <ErrorBox error={error} />}
          <div className="dialog-footer">
            <Button onClick={onClose}>{ru.otmena}</Button>
            <Button
              type="submit"
              variant={kind === "restart" ? "destructive" : "default"}
              disabled={
                busy ||
                (kind === "restart" &&
                  (!confirmed || !resource?.executor_target)) ||
                (kind === "report" && !actualIntegration)
              }
            >
              {busy
                ? ru.otpravlyaem
                : kind === "restart"
                  ? ru.perezapustit
                  : kind === "report"
                    ? ru.sformirovat
                    : ru.zapustit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
export function JobResult({
  job,
  error,
  showHeader = true,
}: {
  job?: Job;
  error?: unknown;
  showHeader?: boolean;
}) {
  if (error) return <ErrorBox error={error} />;
  if (!job) return <p className="loading">{copy.loading}</p>;
  return (
    <div className="job-result">
      {showHeader && (
        <div className="simple-row">
          <strong>{statusLabel[job.kind] || job.kind}</strong>
          <Badge value={job.status} />
        </div>
      )}
      {job.error && <ErrorBox error={new Error(job.error)} />}
      {job.kind === "check" && job.status === "succeeded" && (
        <CheckSummary job={job} />
      )}
      {job.kind !== "check" && typeof job.result?.url === "string" && (
        <ExternalLink url={String(job.result.url)}>
          Открыть результат
        </ExternalLink>
      )}
      <JobTechnicalDetails key={job.id} job={job} />
      {["queued", "running"].includes(job.status) && (
        <p className="notice">
          {ru.sostoyanie_sohraneno_na_servere_mozhno_zakryt_okno_i_vernutsya}
        </p>
      )}
      {job.status === "unknown" && (
        <p className="danger-notice">
          {ru.rezultat_neizvesten_proverte_tselevoy_servis_pered_sozdaniem_n}
        </p>
      )}
    </div>
  );
}
function JobTechnicalDetails({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const hasICMPOutput =
    job.kind === "check" &&
    job.parameters?.kind === "icmp" &&
    job.status === "succeeded";
  const path = `/jobs/${job.id}/output`;
  const output = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) =>
      api<{ raw_output: string }>(path, "GET", undefined, {}, signal),
    enabled: open && hasICMPOutput,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const rawOutput = output.data?.raw_output;
  const technicalResult = Object.fromEntries(
    Object.entries(job.result || {}).filter(([key]) => key !== "raw_output"),
  );
  return (
    <details
      className="check-technical-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Технические подробности</summary>
      <dl className="detail-grid">
        <div>
          <dt>{ru.avtor}</dt>
          <dd>{job.actor}</dd>
        </div>
        <div>
          <dt>{ru.sozdano}</dt>
          <dd>{date(job.created_at)}</dd>
        </div>
        <div>
          <dt>{ru.nachalo}</dt>
          <dd>{date(job.started_at)}</dd>
        </div>
        <div>
          <dt>{ru.zavershenie}</dt>
          <dd>{date(job.finished_at)}</dd>
        </div>
      </dl>
      {output.error && (
        <ErrorBox error={output.error} retry={() => void output.refetch()} />
      )}
      {open && output.isFetching && (
        <p role="status">Загружаем полный вывод…</p>
      )}
      {typeof rawOutput === "string" && rawOutput.length > 0 && (
        <div>
          <h4>Полный вывод ICMP-проверки</h4>
          <pre className="icmp-raw-output" aria-label="Полный вывод ICMP">
            {rawOutput}
          </pre>
        </div>
      )}
      <JSONView
        value={{
          id: job.id,
          resource_id: job.resource_id,
          integration_id: job.integration_id,
          parameters: job.parameters,
          result: technicalResult,
        }}
      />
    </details>
  );
}
function CheckSummary({ job }: { job: Job }) {
  const result = job.result || {};
  const kind = String(result.kind || job.parameters?.kind || "");
  const target = String(result.target || job.parameters?.target || "");
  const addresses = Array.isArray(result.addresses)
    ? result.addresses.map(String)
    : [];
  const status =
    typeof result.http_status === "number" ? result.http_status : undefined;
  const expires =
    typeof result.not_after === "string"
      ? new Date(result.not_after)
      : undefined;
  const observed =
    typeof result.observed_at === "string"
      ? new Date(result.observed_at)
      : new Date(job.finished_at || job.created_at);
  const days =
    expires && Number.isFinite(expires.getTime())
      ? Math.floor((expires.getTime() - observed.getTime()) / 86400000)
      : undefined;
  const warning =
    kind === "icmp"
      ? Number(result.loss_percent) > 0
      : kind === "http"
        ? status !== undefined && status >= 400
        : kind === "tls" && days !== undefined && days < 30;
  const title =
    kind === "icmp"
      ? Number(result.received) > 0
        ? "ICMP-проверка завершена"
        : "Ответы ICMP не получены"
      : kind === "iperf"
        ? "Скорость канала измерена"
        : kind === "nmap"
          ? "Проверка портов завершена"
          : kind === "dns_records"
            ? "Почтовые записи получены"
            : kind === "reverse_dns"
              ? Array.isArray(result.names) && result.names.length
                ? "Имя по IP найдено"
                : "Имя для IP не опубликовано"
              : kind === "dns"
                ? "Имя найдено"
                : kind === "tcp"
                  ? "Порт принимает соединения"
                  : kind === "tls"
                    ? "Сертификат проверен"
                    : status === 401 || status === 403
                      ? "Сайт ответил, доступ ограничен"
                      : status !== undefined && status >= 500
                        ? "Сайт ответил с ошибкой сервера"
                        : status !== undefined && status >= 400
                          ? "Сайт ответил с ошибкой"
                          : "Сайт ответил";
  const tlsVersion: Record<string, string> = {
    "769": "TLS 1.0",
    "770": "TLS 1.1",
    "771": "TLS 1.2",
    "772": "TLS 1.3",
  };
  return (
    <section
      className={`check-summary${warning ? " check-summary-warning" : ""}`}
      aria-label="Результат проверки"
    >
      <h3>{title}</h3>
      <p className="check-target">{target}</p>
      {kind === "icmp" && (
        <dl className="detail-grid" aria-label="Статистика ICMP">
          <div>
            <dt>Отправлено</dt>
            <dd>{String(result.transmitted)} пакетов</dd>
          </div>
          <div>
            <dt>Получено</dt>
            <dd>{String(result.received)} ответов</dd>
          </div>
          <div>
            <dt>Потери</dt>
            <dd>
              {Number(result.loss_percent).toLocaleString("ru-RU", {
                maximumFractionDigits: 2,
              })}
              %
            </dd>
          </div>
          <div>
            <dt>Интервал</dt>
            <dd>2 мс · 500 пакетов/с</dd>
          </div>
          <div>
            <dt>RTT мин. / ср. / макс.</dt>
            <dd>
              {Number(result.received) > 0
                ? [result.rtt_min_ms, result.rtt_avg_ms, result.rtt_max_ms]
                    .map((value) =>
                      typeof value === "number"
                        ? value.toLocaleString("ru-RU")
                        : "—",
                    )
                    .join(" / ") + " мс"
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Проверенный IP</dt>
            <dd>{String(result.scanned_address)}</dd>
          </div>
        </dl>
      )}
      {kind === "iperf" && (
        <div className="iperf-throughput" aria-label="Скорость передачи">
          <strong>
            {typeof result.throughput_mbps === "number" &&
            Number.isFinite(result.throughput_mbps)
              ? result.throughput_mbps.toLocaleString("ru-RU", {
                  maximumFractionDigits: 2,
                })
              : "—"}
          </strong>
          <span>Мбит/с</span>
        </div>
      )}
      <dl className="check-facts">
        {kind === "iperf" && (
          <>
            <div>
              <dt>Источник проверки</dt>
              <dd>
                {typeof result.origin === "string" &&
                result.origin !== "monitoring"
                  ? result.origin
                  : "сервер платформы"}
              </dd>
            </div>
            <div>
              <dt>Направление</dt>
              <dd>
                {(result.direction || job.parameters?.direction) === "download"
                  ? "Реверсивное"
                  : "Прямое"}
              </dd>
            </div>
            {typeof result.test_seconds === "number" && (
              <div>
                <dt>Длительность передачи</dt>
                <dd>
                  {result.test_seconds.toLocaleString("ru-RU", {
                    maximumFractionDigits: 2,
                  })}{" "}
                  с
                </dd>
              </div>
            )}
          </>
        )}
        {kind === "nmap" && Array.isArray(result.ports) && (
          <div>
            <dt>Порты TCP</dt>
            <dd>
              {result.ports.map(
                (entry: { port: number; state: string }, index: number) => (
                  <span className="check-fact-line" key={index}>
                    {entry.port} —{" "}
                    {(
                      {
                        open: "открыт",
                        closed: "закрыт",
                        filtered: "фильтруется",
                        unfiltered: "доступен",
                        "open|filtered": "открыт или фильтруется",
                      } as Record<string, string>
                    )[entry.state] || "состояние не определено"}
                  </span>
                ),
              )}
            </dd>
          </div>
        )}
        {(kind === "nmap" || kind === "iperf") &&
          typeof result.scanned_address === "string" && (
            <div>
              <dt>Проверенный IP</dt>
              <dd>{result.scanned_address}</dd>
            </div>
          )}
        {(kind === "dns" || kind === "reverse_dns") && (
          <div>
            <dt>IP-адреса</dt>
            <dd>
              {addresses.length ? addresses.join(", ") : "Адреса не получены"}
            </dd>
          </div>
        )}
        {kind === "reverse_dns" && Array.isArray(result.names) && (
          <div>
            <dt>Имена сервера</dt>
            <dd>
              {result.names.length
                ? result.names.map(String).join(", ")
                : "Нет записей PTR"}
            </dd>
          </div>
        )}
        {kind === "dns_records" && (
          <>
            <div>
              <dt>Почтовые серверы (MX)</dt>
              <dd>
                {Array.isArray(result.mx) && result.mx.length
                  ? result.mx.map(
                      (
                        entry: { host?: string; priority?: number },
                        index: number,
                      ) => (
                        <span className="check-fact-line" key={index}>
                          {entry.host} · приоритет {entry.priority}
                        </span>
                      ),
                    )
                  : "Не опубликованы"}
              </dd>
            </div>
            {["spf", "dmarc"].map((name) => (
              <div key={name}>
                <dt>{name.toUpperCase()}</dt>
                <dd>
                  {Array.isArray(result[name]) && result[name].length
                    ? (result[name] as string[]).join("; ")
                    : "Не опубликована"}
                </dd>
              </div>
            ))}
          </>
        )}
        {kind === "http" && status !== undefined && (
          <div>
            <dt>Ответ сайта</dt>
            <dd>
              HTTP {status}
              {status === 200
                ? " · OK"
                : status === 404
                  ? " · Страница не найдена"
                  : status === 403
                    ? " · Доступ запрещён"
                    : status === 401
                      ? " · Нужен вход"
                      : ""}
            </dd>
          </div>
        )}
        {kind === "http" && typeof result.content_type === "string" && (
          <div>
            <dt>Содержимое</dt>
            <dd>{result.content_type}</dd>
          </div>
        )}
        {kind === "tls" && expires && (
          <div>
            <dt>Сертификат действует до</dt>
            <dd>
              {date(String(result.not_after))}
              {days !== undefined
                ? ` · осталось дней: ${Math.max(0, days)}`
                : ""}
            </dd>
          </div>
        )}
        {kind === "tls" && result.tls_version != null && (
          <div>
            <dt>Защита соединения</dt>
            <dd>
              {String(
                result.tls_version_name ||
                  tlsVersion[String(result.tls_version)] ||
                  result.tls_version,
              )}
            </dd>
          </div>
        )}
        {kind === "tls" && typeof result.issuer === "string" && (
          <div>
            <dt>Кем выдан</dt>
            <dd>{result.issuer}</dd>
          </div>
        )}
        {kind !== "iperf" && typeof result.duration_ms === "number" && (
          <div>
            <dt>Время проверки</dt>
            <dd>{result.duration_ms} мс</dd>
          </div>
        )}
      </dl>
      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <p className="notice">{result.warnings.map(String).join(". ")}</p>
      )}
      <p className="check-scope">
        {kind === "icmp"
          ? "2000 ICMP-пакетов с сервера платформы. Устройства могут ограничивать частоту ICMP-ответов; потери здесь не всегда равны потерям прикладного трафика."
          : kind === "iperf"
            ? "Скорость между сервером платформы и выбранным сервером iperf3 на момент проверки."
            : kind === "http"
              ? "Ответ получен с сервера Платформы. Это не проверка всех функций приложения."
              : kind === "tcp"
                ? "Соединение установлено с сервера Платформы. Работа приложения за портом не проверялась."
                : "Проверено с сервера Платформы."}
      </p>
    </section>
  );
}

export const toolsList = [
  {
    kind: "icmp",
    protocol: "ICMP",
    name: "Проверить ping (ICMP)",
    description: "2000 пакетов с интервалом 2 мс",
    icon: Activity,
    hint: "IPv4-адрес или hostname из разрешённых сетей. 2000 пакетов, интервал 2 мс; параметры фиксированы.",
  },
  {
    kind: "iperf",
    protocol: "iperf3",
    name: "Измерить скорость (iperf3)",
    description: "Пропускная способность с сервера платформы",
    icon: Gauge,
    hint: "На выбранном сервере должен работать iperf3. Укажите адрес и порт, например 192.0.2.10:5201.",
  },
  {
    kind: "nmap",
    protocol: "Порты",
    name: "Проверить TCP-порты",
    description: "Несколько портов одного хоста",
    icon: Network,
    hint: "Один хост и до 16 портов через запятую: server:80,443. Без скриптов и сканирования подсетей.",
  },
  {
    kind: "dns",
    protocol: "DNS",
    name: "Найти IP-адрес",
    description: "По имени сервера или домену",
    icon: Globe,
    hint: "Например: server.example.invalid или example.org.",
  },
  {
    kind: "http",
    protocol: "HTTP",
    name: "Проверить сайт",
    description: "Ответ сайта и время запроса",
    icon: Activity,
    hint: "Введите домен или полный адрес сайта. Без протокола используется HTTPS. Ответ 403 означает, что сайт ответил, но ограничивает запрос.",
  },
  {
    kind: "tcp",
    protocol: "TCP",
    name: "Проверить порт (NC)",
    description: "Принимает ли сервер соединения",
    icon: Network,
    hint: "Например: server:443 для HTTPS, server:445 для файлового сервера.",
  },
  {
    kind: "tls",
    protocol: "TLS",
    name: "Проверить сертификат",
    description: "Доверие и срок действия",
    icon: Shield,
    hint: "Например: https://service.example.ru или service.example.ru:443. Проверка доверия к сертификату включена.",
  },
  {
    kind: "reverse_dns",
    protocol: "PTR",
    name: "Найти имя по IP",
    description: "Обратная DNS-запись сервера",
    icon: Network,
    hint: "Введите IPv4 или IPv6. Отсутствие имени не означает, что сервер недоступен.",
  },
];
export function QuickTools({
  onOperation,
}: {
  onOperation: (kind: string, resource?: Resource) => void;
}) {
  const [branchOpen, setBranchOpen] = useState(false);
  return (
    <>
      <div className="quick-checks">
        {toolsList.map((tool) => (
          <button
            className="quick-check"
            key={tool.kind}
            onClick={() =>
              onOperation("check", {
                check: { kind: tool.kind, target: "", interval_seconds: 0 },
              } as Resource)
            }
          >
            <tool.icon size={21} aria-hidden="true" />
            <span className="quick-check-copy">
              <strong>{tool.name}</strong>
              <small>{tool.description}</small>
            </span>
          </button>
        ))}
        <button className="quick-check" onClick={() => setBranchOpen(true)}>
          <Route size={21} aria-hidden="true" />
          <span className="quick-check-copy">
            <strong>Маршрут и потери (MTR)</strong>
            <small>Проверка через Wayline</small>
          </span>
        </button>
      </div>
      {branchOpen && <BranchCheckDialog onClose={() => setBranchOpen(false)} />}
    </>
  );
}
export function Tools({
  onOperation,
}: {
  onOperation: (kind: string, resource?: Resource) => void;
}) {
  const jobs = useAPI<Job[]>("/jobs");
  const resources = useAPI<Resource[]>("/resources");
  const [selected, setSelected] = useState<Job>();
  const selectedJob = useAPI<Job>(`/jobs/${selected?.id || ""}`, !!selected);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{copy.tools}</h1>
          <p>{ru.diagnostika_i_razreshyonnye_operatsii}</p>
        </div>
      </div>
      <div className="two-columns">
        <Panel title={ru.proverki} icon={<Activity size={19} />}>
          <QuickTools onOperation={onOperation} />
          <p className="panel-note">{copy.checkOrigin}</p>
        </Panel>
        <Panel title={ru.konteynery} icon={<Box size={19} />}>
          {resources.data
            ?.filter((r) => r.operations?.includes("restart"))
            .map((r) => (
              <div className="simple-row" key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <small>{r.executor_target || ru.tsel_ne_zadana}</small>
                </div>
                <Button size="sm" onClick={() => onOperation("restart", r)}>
                  {ru.perezapustit}
                </Button>
              </div>
            ))}
          {!resources.data?.some((r) => r.operations?.includes("restart")) && (
            <Empty
              title={ru.net_razreshyonnyh_konteynerov}
              detail={
                ru.operatsiya_vklyuchaetsya_dlya_konkretnogo_resursa_i_proveryaet
              }
            />
          )}
        </Panel>
      </div>
      <Panel
        title={ru.zadaniya}
        icon={<Clock size={19} />}
        action={
          <Button size="sm" variant="ghost" onClick={() => void jobs.refetch()}>
            <RefreshCw size={15} />
            {ru.obnovit}
          </Button>
        }
      >
        {jobs.error ? (
          <ErrorBox error={jobs.error} />
        ) : jobs.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{ru.operatsiya}</th>
                  <th>{ru.tsel_2}</th>
                  <th>{ru.sostoyanie}</th>
                  <th>{ru.avtor}</th>
                  <th>{ru.sozdano}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j.id}>
                    <td>{statusLabel[j.kind] || j.kind}</td>
                    <td>
                      {resources.data?.find((r) => r.id === j.resource_id)
                        ?.name || String(j.parameters?.target || "—")}
                    </td>
                    <td>
                      <Badge value={j.status} />
                    </td>
                    <td>{j.actor}</td>
                    <td>{date(j.created_at)}</td>
                    <td>
                      <Button size="sm" onClick={() => setSelected(j)}>
                        {ru.rezultat}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={ru.zadaniy_poka_net}
            detail={ru.rezultaty_proverok_i_operatsiy_poyavyatsya_zdes}
          />
        )}
      </Panel>
      {selected && (
        <Dialog
          helpTopic="job-result"
          title={ru.rezultat_zadaniya}
          onClose={() => setSelected(undefined)}
        >
          <JobResult
            job={selectedJob.data || selected}
            error={selectedJob.error}
          />
        </Dialog>
      )}
    </>
  );
}
export function ReportRows({
  reports,
  limit,
}: {
  reports: Report[];
  limit?: number;
}) {
  const reportDate = (report: Report) => {
    if (report.created_at && !report.created_at.startsWith("0001-")) {
      const timestamp = Date.parse(report.created_at);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    const dates = report.period.match(/\b\d{4}-\d{2}-\d{2}\b/g);
    return dates?.length ? Date.parse(dates[dates.length - 1]) || 0 : 0;
  };
  const reportRun = (report: Report) =>
    Number(report.title.match(/№\s*(\d+)/)?.[1] || 0);
  const ordered = [...reports].sort(
    (a, b) =>
      reportDate(b) - reportDate(a) ||
      reportRun(b) - reportRun(a) ||
      a.id.localeCompare(b.id),
  );
  return (
    <div>
      {ordered.slice(0, limit).map((r) => (
        <div className="report-row" key={r.id}>
          <FileText size={20} />
          <div>
            <strong>{r.title}</strong>
            <small>
              {r.period.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$3.$2.$1")}
              {r.created_at && !r.created_at.startsWith("0001-")
                ? `${r.period ? " · " : ""}${date(r.created_at)}`
                : ""}
            </small>
            {r.error && <span className="text-danger">{r.error}</span>}
          </div>
          {r.url ? (
            <ExternalLink className="button button-sm" url={r.url}>
              {ru.otkryt_2}
            </ExternalLink>
          ) : (
            <Badge value={r.status} />
          )}
        </div>
      ))}
    </div>
  );
}
export function Reports({
  onOperation,
}: {
  onOperation: (kind: string) => void;
}) {
  const reports = useAPI<Report[]>("/reports");
  const jobs = useAPI<Job[]>("/jobs");
  const integrations = useAPI<Integration[]>("/integrations");
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{copy.reports}</h1>
          <p>{ru.rezultaty_nastroennogo_generatora_i_sostoyanie_zadaniy}</p>
        </div>
        <Button variant="default" onClick={() => onOperation("report")}>
          <Plus size={16} />
          {ru.sformirovat_otchyot}
        </Button>
      </div>
      <Panel title={ru.katalog_otchyotov} icon={<FileText size={20} />}>
        {reports.error ? (
          <ErrorBox error={reports.error} />
        ) : reports.data?.length ? (
          <ReportRows reports={reports.data} />
        ) : (
          <Empty
            title={ru.otchyotov_poka_net}
            detail={
              integrations.data?.some((i) => i.kind === "reports" && i.enabled)
                ? ru.report_empty_create
                : integrations.data
                  ? ru.podklyuchite_generator_v_nastroykah_i_zapustite_formirovanie_o
                  : undefined
            }
          />
        )}
      </Panel>
      <Panel title={ru.poslednie_zadaniya_generatsii}>
        {jobs.data
          ?.filter((j) => j.kind === "report")
          .map((j) => (
            <details className="job-summary" key={j.id}>
              <summary>
                <span>
                  {date(j.created_at)} · {j.actor}
                </span>
                <Badge value={j.status} />
              </summary>
              <JobResult job={j} />
            </details>
          ))}
        {!jobs.data?.some((j) => j.kind === "report") && (
          <p className="muted">{ru.generatsiya_eschyo_ne_zapuskalas}</p>
        )}
      </Panel>
    </>
  );
}
