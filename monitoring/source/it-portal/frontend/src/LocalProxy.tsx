import { useEffect, useState } from "react";
import { useAPI } from "./api";
import { Empty, ErrorBox, Field } from "./components/common";
import XrayModule from "./XrayModule";

export type LocalProxyInstance = {
  id: string;
  name: string;
  module_id: string;
  mode: string;
  desired_state: string;
  observed_state?: string;
  last_success?: string;
};
export function installedLocalXrays(items: LocalProxyInstance[] = []) {
  return items.filter(
    (item) =>
      item.module_id === "xray" &&
      item.mode === "local" &&
      item.desired_state !== "removed" &&
      (item.observed_state === "running" ||
        item.observed_state === "disabled" ||
        !!item.last_success),
  );
}

// This view uses the exact same owned configuration/status API as the module
// catalogue. It cannot fall back to the former company-specific proxy endpoint.
export default function LocalProxy() {
  const modules = useAPI<{ items: LocalProxyInstance[] }>("/modules");
  const [requested, setRequested] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1] || "").get("instance") ||
      "",
  );
  useEffect(() => {
    const update = () =>
      setRequested(
        new URLSearchParams(location.hash.split("?")[1] || "").get(
          "instance",
        ) || "",
      );
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const instances = installedLocalXrays(modules.data?.items);
  if (modules.error)
    return (
      <ErrorBox error={modules.error} retry={() => void modules.refetch()} />
    );
  if (!modules.data) return <p role="status">Загружаем локальный Xray…</p>;
  if (!instances.length)
    return (
      <Empty
        title="Локальный Xray не установлен"
        detail="Установите Xray из каталога модулей. После установки здесь появятся состояние, подключения и маршрутизация."
        action={
          <a className="button button-default" href="#module-catalog">
            Открыть каталог модулей
          </a>
        }
      />
    );
  const selected = requested
    ? instances.find((item) => item.id === requested)
    : instances[0];
  return (
    <>
      {(instances.length > 1 || !selected) && (
        <Field label="Локальный Xray">
          <select
            value={selected?.id || ""}
            onChange={(event) => {
              location.hash = `proxy?instance=${event.target.value}`;
            }}
          >
            {!selected && (
              <option value="" disabled>
                Выберите установленный экземпляр
              </option>
            )}
            {instances.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {selected ? (
        <XrayModule key={selected.id} instance={selected} />
      ) : (
        <Empty
          title="Этот экземпляр Xray больше не доступен"
          detail="Выберите установленный экземпляр, чтобы открыть его настройки."
        />
      )}
    </>
  );
}
