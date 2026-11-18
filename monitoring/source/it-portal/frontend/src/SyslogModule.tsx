import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Network,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react";
import { params, queryClient } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import SyslogReceiverDialog from "./SyslogReceiver";
import {
  parseSeverity,
  severityName,
  severityNames,
  sourceKey,
  sourceName,
  syslogTime,
  syslogTimezone,
  useSyslogRead,
  type SyslogList,
  type SyslogMessage,
  type SyslogSource,
} from "./syslog";
import "./syslog-module.css";

type Range = { from: string; to: string };
type Module = {
  id: string;
  name: string;
  desired_state: string;
  observed_state: string;
};
const day = 24 * 60 * 60 * 1000;
function recent(minutes: number): Range {
  const now = Date.now();
  return {
    from: new Date(now - minutes * 60000).toISOString(),
    to: new Date(now).toISOString(),
  };
}
function localInput(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}
function Period({
  value,
  range,
  onPreset,
  onRange,
}: {
  value: string;
  range: Range;
  onPreset: (v: string) => void;
  onRange: (r: Range) => void;
}) {
  const [from, setFrom] = useState(() => localInput(range.from)),
    [to, setTo] = useState(() => localInput(range.to));
  const [error, setError] = useState("");
  function apply(e: FormEvent) {
    e.preventDefault();
    const start = Date.parse(from),
      end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setError("Конец периода должен быть позже начала.");
      return;
    }
    if (end - start > 31 * day) {
      setError("Выберите период до 31 дня.");
      return;
    }
    setError("");
    onRange({
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
    });
  }
  return (
    <div className="syslog-period">
      <Field label="Период приёма">
        <select
          value={value}
          onChange={(e) => {
            setError("");
            if (e.target.value === "custom") {
              setFrom(localInput(range.from));
              setTo(localInput(range.to));
            }
            onPreset(e.target.value);
          }}
        >
          <option value="15">Последние 15 минут</option>
          <option value="60">Последний час</option>
          <option value="1440">Последние 24 часа</option>
          <option value="10080">Последние 7 дней</option>
          <option value="custom">Выбрать период</option>
        </select>
      </Field>
      {value === "custom" && (
        <form onSubmit={apply} className="syslog-custom">
          <Field label="Начало периода">
            <input
              type="datetime-local"
              required
              step="1"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="Конец периода">
            <input
              type="datetime-local"
              required
              step="1"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Button type="submit">Применить период</Button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <small className="muted syslog-range">
        {syslogTime(range.from)} — {syslogTime(range.to)} · {syslogTimezone}
      </small>
    </div>
  );
}
function Severity({ value }: { value: string }) {
  const n = parseSeverity(value);
  return (
    <Badge
      value={
        n < 0 ? "unknown" : n <= 3 ? "critical" : n === 4 ? "warning" : "info"
      }
    >
      {severityName(value)}
    </Badge>
  );
}
function MessageDetail({
  item,
  onClose,
}: {
  item: SyslogMessage;
  onClose: () => void;
}) {
  return (
    <Dialog title="Сообщение syslog" onClose={onClose}>
      <dl className="detail-grid syslog-facts">
        <div>
          <dt>Устройство</dt>
          <dd>{sourceName(item)}</dd>
        </div>
        <div>
          <dt>Адрес отправителя</dt>
          <dd>{item.address || "Не передан"}</dd>
        </div>
        <div>
          <dt>Принято PL · {syslogTimezone}</dt>
          <dd>
            <time dateTime={item.time} title={item.time}>
              {syslogTime(item.time)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Время устройства · {syslogTimezone}</dt>
          <dd>
            {item.device_time ? (
              <time dateTime={item.device_time} title={item.device_time}>
                {syslogTime(item.device_time)}
              </time>
            ) : (
              "Не передано"
            )}
          </dd>
        </div>
        <div>
          <dt>Уровень</dt>
          <dd>
            <Severity value={item.severity} />
          </dd>
        </div>
        {item.program && (
          <div>
            <dt>Программа</dt>
            <dd>{item.program}</dd>
          </div>
        )}
        {item.format && (
          <div>
            <dt>Формат</dt>
            <dd>{item.format}</dd>
          </div>
        )}
      </dl>
      <h3>Текст сообщения</h3>
      {item.message ? (
        <pre className="syslog-text" tabIndex={0}>
          {item.message}
        </pre>
      ) : (
        <p className="muted">Пустой текст сообщения.</p>
      )}
    </Dialog>
  );
}
function MessageTable({
  items,
  all,
  onRead,
}: {
  items: SyslogMessage[];
  all: boolean;
  onRead: (m: SyslogMessage) => void;
}) {
  return (
    <div className="syslog-table-wrap">
      <table className="syslog-table" aria-label="Сообщения syslog">
        <thead>
          <tr>
            <th scope="col">Принято PL</th>
            {all && <th scope="col">Устройство</th>}
            <th scope="col">Уровень</th>
            <th scope="col">Сообщение</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td>
                <time dateTime={item.time} title={item.time}>
                  {syslogTime(item.time)}
                </time>
              </td>
              {all && (
                <td>
                  {sourceName(item)}
                  {item.address && item.address !== item.source && (
                    <small>{item.address}</small>
                  )}
                </td>
              )}
              <td>
                <Severity value={item.severity} />
              </td>
              <td>
                <button
                  type="button"
                  className="syslog-message-link"
                  onClick={() => onRead(item)}
                >
                  {item.message || "Открыть сообщение"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function SyslogWorkspace({ instance }: { instance: Module }) {
  const base = "/modules/" + encodeURIComponent(instance.id) + "/syslog";
  const [section, setSection] = useState<"sources" | "journal">("sources");
  const [period, setPeriod] = useState("1440");
  const [range, setRange] = useState<Range>(() => recent(1440));
  const [selected, setSelected] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [text, setText] = useState(""),
    [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("");
  const [mode, setMode] = useState<"connect" | "receiver">();
  const [record, setRecord] = useState<SyslogMessage>();
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const sources = useSyslogRead<SyslogList<SyslogSource>>(
    base + "/sources?" + params(range),
    section === "sources",
  );
  const needle = sourceFilter.trim().toLocaleLowerCase("ru");
  const visible = (sources.data?.items || []).filter(
    (s) =>
      !needle ||
      [s.source, s.address].some((value) =>
        value.toLocaleLowerCase("ru").includes(needle),
      ),
  );
  const chosen =
    section === "sources" && !sources.isError
      ? visible.find((s) => sourceKey(s) === selected) || visible[0]
      : undefined;
  const journal = section === "journal";
  const identifiable = !!(chosen?.source || chosen?.address);
  const messages = useSyslogRead<SyslogList<SyslogMessage>>(
    base +
      "/messages?" +
      params({
        ...range,
        source: chosen?.source,
        address: chosen?.address,
        text: query,
        severity,
      }),
    journal || identifiable,
  );
  function preset(value: string) {
    setPeriod(value);
    if (value !== "custom") setRange(recent(Number(value)));
  }
  function update() {
    if (period !== "custom") {
      const next = recent(Number(period));
      if (next.to !== range.to) {
        setRange(next);
        return;
      }
    }
    if (!journal) void sources.refetch();
    if (journal || identifiable) void messages.refetch();
  }
  function afterArrival(item: SyslogMessage) {
    setMode(undefined);
    setSourceFilter("");
    setSelected(sourceKey(item));
    setText("");
    setQuery("");
    setSeverity("");
    setSection("sources");
    preset("1440");
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        typeof queryKey[0] === "string" &&
        (queryKey[0].startsWith(base + "/sources?") ||
          queryKey[0].startsWith(base + "/messages?")),
    });
    setRecord(item);
  }
  return (
    <div className="syslog-page">
      <div className="page-title">
        <div>
          <a
            className="back-link"
            href={"#modules?instance=" + encodeURIComponent(instance.id)}
          >
            <ArrowLeft size={15} /> К модулям
          </a>
          <h1>{journal ? "Журнал syslog" : "Источники syslog"}</h1>
        </div>
        <div className="actions">
          <Button onClick={() => setMode("receiver")}>
            <Settings size={16} /> Приёмник
          </Button>
          <Button variant="default" onClick={() => setMode("connect")}>
            <Plus size={16} /> Подключить устройство
          </Button>
        </div>
      </div>
      <div className="syslog-toolbar">
        <nav className="segmented" aria-label="Разделы syslog">
          <Button
            aria-current={!journal ? "page" : undefined}
            variant={!journal ? "default" : "ghost"}
            onClick={() => setSection("sources")}
          >
            Источники
          </Button>
          <Button
            aria-current={journal ? "page" : undefined}
            variant={journal ? "default" : "ghost"}
            onClick={() => setSection("journal")}
          >
            Журнал
          </Button>
        </nav>
        <Button
          onClick={update}
          disabled={(!journal && sources.isFetching) || messages.isFetching}
        >
          <RefreshCw size={15} /> Обновить
        </Button>
      </div>
      <Period
        value={period}
        range={range}
        onPreset={preset}
        onRange={setRange}
      />
      <div className={journal ? "" : "syslog-layout"}>
        {!journal && (
          <Panel title="Устройства" icon={<Network size={18} />}>
            <Field label="Поиск источника">
              <input
                type="search"
                value={sourceFilter}
                placeholder="Имя или адрес"
                onChange={(e) => setSourceFilter(e.target.value)}
              />
            </Field>
            {sources.isError ? (
              <ErrorBox
                error={sources.error}
                retry={() => void sources.refetch()}
              />
            ) : sources.isPending ? (
              <p role="status">Загружаем источники…</p>
            ) : visible.length ? (
              <ul className="syslog-sources" aria-label="Источники сообщений">
                {visible.map((s) => (
                  <li key={sourceKey(s)}>
                    <button
                      type="button"
                      aria-pressed={sourceKey(s) === sourceKey(chosen!)}
                      onClick={() => setSelected(sourceKey(s))}
                    >
                      <strong>{sourceName(s)}</strong>
                      {s.address && s.address !== s.source && (
                        <span>{s.address}</span>
                      )}
                      <small>
                        Последнее сообщение · {syslogTime(s.last_seen)}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : needle ? (
              <Empty
                title="Источники не найдены"
                action={
                  <Button onClick={() => setSourceFilter("")}>
                    Сбросить поиск
                  </Button>
                }
              />
            ) : (
              <Empty
                title="За этот период источников нет"
                detail="Выберите другой период или подключите устройство."
              />
            )}
            {sources.data?.truncated && !sources.isError && (
              <p className="muted">
                Показана часть источников. Сократите период.
              </p>
            )}
          </Panel>
        )}
        {(journal || chosen) && (
          <Panel
            title={journal ? "Все устройства" : sourceName(chosen!)}
            action={
              !journal && chosen?.address ? (
                <span className="muted">{chosen.address}</span>
              ) : undefined
            }
          >
            <div className="syslog-filters">
              <Field label="Текст сообщения">
                <input
                  type="search"
                  placeholder="Строка сообщения или порт"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
              <Field label="Уровень syslog">
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="">Все уровни</option>
                  {severityNames.map((name, n) => (
                    <option key={name} value={String(n)}>
                      {n} · {name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!journal && !identifiable ? (
              <Empty
                title="Идентификатор источника отсутствует"
                detail="Откройте журнал всех устройств за выбранный период."
              />
            ) : messages.isError ? (
              <ErrorBox
                error={messages.error}
                retry={() => void messages.refetch()}
              />
            ) : messages.isPending ? (
              <p role="status">Загружаем сообщения…</p>
            ) : messages.data?.items?.length ? (
              <MessageTable
                items={messages.data.items}
                all={journal}
                onRead={setRecord}
              />
            ) : (
              <Empty
                title="Сообщений за выбранный период нет"
                detail={
                  text || severity
                    ? "Измените фильтры или расширьте период."
                    : "Попробуйте расширить период."
                }
                action={
                  text || severity ? (
                    <Button
                      onClick={() => {
                        setText("");
                        setQuery("");
                        setSeverity("");
                      }}
                    >
                      Сбросить фильтры
                    </Button>
                  ) : undefined
                }
              />
            )}
            {messages.data?.truncated && !messages.isError && (
              <p className="muted">
                Показана часть сообщений. Уточните период или фильтры.
              </p>
            )}
            {!journal && (
              <div className="syslog-context">
                <Button variant="ghost" onClick={() => setSection("journal")}>
                  Все устройства за этот период <ArrowRight size={15} />
                </Button>
              </div>
            )}
          </Panel>
        )}
      </div>
      {mode && (
        <SyslogReceiverDialog
          key={mode}
          base={base}
          settings={mode === "receiver"}
          onClose={() => setMode(undefined)}
          onRead={afterArrival}
        />
      )}
      {record && (
        <MessageDetail item={record} onClose={() => setRecord(undefined)} />
      )}
    </div>
  );
}
export default function SyslogModule({ instance }: { instance: Module }) {
  if (
    instance.desired_state !== "enabled" ||
    instance.observed_state === "pending"
  )
    return (
      <div className="syslog-page">
        <a
          className="back-link"
          href={"#modules?instance=" + encodeURIComponent(instance.id)}
        >
          <ArrowLeft size={15} /> К модулям
        </a>
        <h1>Источники syslog</h1>
        <Empty
          title={
            instance.desired_state !== "enabled"
              ? "Модуль syslog отключён"
              : "Модуль syslog готовится к работе"
          }
          detail="Состояние экземпляра доступно в списке модулей."
        />
      </div>
    );
  return <SyslogWorkspace instance={instance} />;
}
