import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, RefreshCw } from "lucide-react";
import { api, APIError, params, queryClient } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Empty, ErrorBox, Field } from "./components/common";
import {
  sourceName,
  syslogTime,
  useSyslogRead,
  type SourceIdentity,
  type SyslogList,
  type SyslogMessage,
  type SyslogReceiver,
} from "./syslog";

function ReceiverEditor({
  initial,
  path,
  onClose,
  onSaved,
}: {
  initial: SyslogReceiver;
  path: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const conflict = error instanceof APIError && error.status === 409;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<SyslogReceiver>(path, "PUT", {
        address: draft.address,
        port: draft.port,
        udp: draft.udp,
        tcp: draft.tcp,
        retention_days: draft.retention_days,
        expected_revision: draft.revision,
      });
      queryClient.setQueryData([path], result);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      const result = await api<SyslogReceiver>(path);
      queryClient.setQueryData([path], result);
      setDraft(result);
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const addresses = Array.from(
    new Set([...(draft.addresses || []), draft.address]),
  ).filter(Boolean);
  return (
    <Dialog
      title="Настройки приёмника syslog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <fieldset className="syslog-fields" disabled={busy}>
          <Field label="Адрес приёма на хосте PL">
            <select
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            >
              <option value="">Только внутри PL</option>
              {addresses.map((ip) => (
                <option key={ip} value={ip}>
                  {ip}
                </option>
              ))}
            </select>
          </Field>
          <div className="syslog-form-pair">
            <Field label="Порт приёма">
              <input
                required
                type="number"
                min="1"
                max="65535"
                value={draft.port || ""}
                onChange={(e) =>
                  setDraft({ ...draft, port: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Хранение, дней">
              <input
                required
                type="number"
                min="1"
                max="365"
                value={draft.retention_days || ""}
                onChange={(e) =>
                  setDraft({ ...draft, retention_days: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <fieldset className="syslog-protocols">
            <legend>Протоколы приёма</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.udp}
                onChange={(e) => setDraft({ ...draft, udp: e.target.checked })}
              />{" "}
              UDP
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.tcp}
                onChange={(e) => setDraft({ ...draft, tcp: e.target.checked })}
              />{" "}
              TCP
            </label>
          </fieldset>
          {!draft.udp && !draft.tcp && (
            <p className="muted">Выберите протокол приёма.</p>
          )}
          <p className="muted">
            Если адрес, порт или протокол изменятся, обновите настройки на
            устройствах.
          </p>
        </fieldset>
        {!!error && <ErrorBox error={error} />}
        <div className="dialog-footer">
          <Button disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          {conflict && (
            <Button disabled={busy} onClick={() => void reload()}>
              Загрузить текущие параметры
            </Button>
          )}
          <Button
            type="submit"
            variant="default"
            disabled={busy || conflict || (!draft.tcp && !draft.udp)}
          >
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Expectation = SourceIdentity & { since: string };
function WaitForDevice({
  base,
  expected,
  onBack,
  onRead,
}: {
  base: string;
  expected: Expectation;
  onBack: () => void;
  onRead: (record: SyslogMessage) => void;
}) {
  const result = useQuery({
    queryKey: [base + "/wait", expected],
    queryFn: async ({ signal }) => {
      const from = Date.parse(expected.since);
      const until = Math.max(Date.now(), from + 1);
      const path =
        base +
        "/messages?" +
        params({
          from: expected.since,
          to: new Date(until).toISOString(),
          source: expected.source,
          address: expected.address,
        });
      const result = await api<SyslogList<SyslogMessage>>(
        path,
        "GET",
        undefined,
        {},
        signal,
      );
      return (
        result.items.find((item) => {
          const received = Date.parse(item.time);
          return (
            received >= from &&
            received <= until &&
            (!expected.source || item.source === expected.source) &&
            (!expected.address || item.address === expected.address)
          );
        }) ?? null
      );
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      q.state.data || q.state.status === "error" ? false : 5000,
  });
  const arrival = result.data;
  return (
    <>
      <p className="muted">
        Ожидаемый источник ·{" "}
        {[expected.source, expected.address].filter(Boolean).join(" · ")}
      </p>
      {result.isError ? (
        <ErrorBox error={result.error} retry={() => void result.refetch()} />
      ) : arrival ? (
        <div className="syslog-arrival" role="status">
          <CheckCircle size={20} />
          <div>
            <strong>Получено сообщение от устройства</strong>
            <p>
              {sourceName(arrival)} · {syslogTime(arrival.time)}
            </p>
            <pre className="syslog-text">{arrival.message}</pre>
          </div>
        </div>
      ) : (
        <div role="status">
          <h3>Ожидаем сообщение от устройства</h3>
          <p>
            Отправьте тестовое сообщение средствами устройства или вызовите
            событие, которое оно пишет в syslog. Проверяем новые поступления
            каждые пять секунд.
          </p>
        </div>
      )}
      <div className="dialog-footer">
        <Button onClick={onBack}>Изменить источник</Button>
        {arrival && !result.isError ? (
          <Button variant="default" onClick={() => onRead(arrival)}>
            Открыть сообщение
          </Button>
        ) : (
          <Button
            disabled={result.isFetching}
            onClick={() => void result.refetch()}
          >
            <RefreshCw size={15} /> Проверить поступление
          </Button>
        )}
      </div>
    </>
  );
}

export default function SyslogReceiverDialog({
  base,
  settings,
  onClose,
  onRead,
}: {
  base: string;
  settings: boolean;
  onClose: () => void;
  onRead: (record: SyslogMessage) => void;
}) {
  const path = base + "/receiver";
  const receiver = useSyslogRead<SyslogReceiver>(path);
  const [editing, setEditing] = useState(settings);
  const [source, setSource] = useState("");
  const [address, setAddress] = useState("");
  const [expected, setExpected] = useState<Expectation>();
  const value = receiver.data;
  function finishEditor() {
    if (settings) onClose();
    else setEditing(false);
  }
  if (editing && value && !receiver.isError)
    return (
      <ReceiverEditor
        initial={value}
        path={path}
        onClose={finishEditor}
        onSaved={finishEditor}
      />
    );
  return (
    <Dialog
      title={editing ? "Настройки приёмника syslog" : "Подключить устройство"}
      onClose={onClose}
    >
      {receiver.isError ? (
        <ErrorBox
          error={receiver.error}
          retry={() => void receiver.refetch()}
        />
      ) : !value ? (
        <p role="status">Загружаем параметры приёмника…</p>
      ) : expected ? (
        <WaitForDevice
          base={base}
          expected={expected}
          onBack={() => setExpected(undefined)}
          onRead={onRead}
        />
      ) : !value.address ? (
        <Empty
          title="Приём syslog из сети выключен"
          detail="Выберите адрес хоста PL и протокол для сообщений устройств."
          action={
            <Button variant="default" onClick={() => setEditing(true)}>
              Настроить приёмник
            </Button>
          }
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (source.trim() || address.trim())
              setExpected({
                source: source.trim(),
                address: address.trim(),
                since: new Date().toISOString(),
              });
          }}
        >
          <p>
            Укажите эти параметры в настройках удалённого syslog на устройстве.
          </p>
          <dl className="detail-grid syslog-destination">
            <div>
              <dt>Адрес PL</dt>
              <dd>{value.address}</dd>
            </div>
            <div>
              <dt>Порт</dt>
              <dd>{value.port}</dd>
            </div>
            <div>
              <dt>Протокол</dt>
              <dd>
                {[value.udp && "UDP", value.tcp && "TCP"]
                  .filter(Boolean)
                  .join(" / ") || "Не выбран"}
              </dd>
            </div>
          </dl>
          <p>
            Укажите имя из заголовка syslog или IP отправителя. При заполнении
            обоих полей должны совпасть оба значения.
          </p>
          <div className="syslog-form-pair">
            <Field label="Имя устройства в syslog">
              <input
                autoComplete="off"
                maxLength={255}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </Field>
            <Field label="IP отправителя">
              <input
                autoComplete="off"
                maxLength={64}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setEditing(true)}>Настроить приёмник</Button>
            <Button
              type="submit"
              variant="default"
              disabled={
                (!source.trim() && !address.trim()) ||
                (!value.udp && !value.tcp)
              }
            >
              Начать ожидание
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
