import { Field } from "./components/common";

export function checkNeedsPort(kind: string, target: string) {
  if (kind !== "tcp" || target.includes("://")) return false;
  const value = target.trim();
  if (value.startsWith("[")) return !/^\[[^\]]+\]:/.test(value);
  return value.split(":").length !== 2;
}

export function checkTargetValue(kind: string, target: string, port: string) {
  const value = target.trim();
  if (!checkNeedsPort(kind, value)) return value;
  const host = value.replace(/^\[|\]$/g, "");
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function CheckTargetInput({
  kind,
  target,
  port,
  onTargetChange,
  onPortChange,
}: {
  kind: string;
  target: string;
  port: string;
  onTargetChange: (value: string) => void;
  onPortChange: (value: string) => void;
}) {
  const labels: Record<string, string> = {
    icmp: "IP-адрес или hostname",
    dns: "Имя сервера, IP или адрес сайта",
    dns_records: "Домен или адрес сайта",
    reverse_dns: "IP-адрес",
    http: "Адрес сайта",
    tcp: "Адрес сервера",
    tls: "Сервер или HTTPS-адрес",
    nmap: "Сервер и порты",
    iperf: "Сервер iperf3 и порт",
  };
  const placeholders: Record<string, string> = {
    icmp: "192.0.2.10 или server.example.ru",
    dns: "server.example.ru",
    dns_records: "example.ru",
    reverse_dns: "192.0.2.10",
    http: "https://service.example.ru",
    tcp: "192.0.2.10",
    tls: "service.example.ru:443",
    nmap: "server.example.ru:22,443,19100",
    iperf: "192.0.2.10:5201",
  };
  return (
    <>
      <Field label={labels[kind] || "Адрес"}>
        <input
          required
          value={target}
          onChange={(event) => onTargetChange(event.target.value)}
          placeholder={placeholders[kind] || "server.example.ru"}
        />
      </Field>
      {checkNeedsPort(kind, target) && (
        <Field label="TCP-порт">
          <input
            required
            type="number"
            min={1}
            max={65535}
            step={1}
            value={port}
            onChange={(event) => onPortChange(event.target.value)}
            placeholder="Например, 443 или 19100"
          />
        </Field>
      )}
    </>
  );
}
