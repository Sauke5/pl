import { useEffect, useState } from "react";
import { useAPI } from "./api";
import { Empty, ErrorBox, Field } from "./components/common";
import { Button } from "./components/ui/button";
import PrometheusConfig from "./PrometheusConfig";
import PrometheusModule from "./PrometheusModule";
import {
  installedLocalModules,
  type ManagedNavigationInstance,
} from "./managedModuleNavigation";
import { withSettingsNavigation } from "./settings/navigation";
import "./monitoring-workspace.css";

type Tab = "monitoring" | "configuration";
function selection() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const tab = params.get("tab");
  return {
    instance: params.get("instance") || "",
    tab: (["configuration", "settings", "jobs"].includes(tab || "")
      ? "configuration"
      : "monitoring") as Tab,
  };
}

export default function Monitoring() {
  const modules = useAPI<{ items: ManagedNavigationInstance[] }>("/modules");
  const [requested, setRequested] = useState(selection);
  useEffect(() => {
    const update = () => setRequested(selection());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const instances = installedLocalModules(modules.data?.items, "prometheus");
  const selected = requested.instance
    ? instances.find((item) => item.id === requested.instance)
    : instances.length === 1
      ? instances[0]
      : undefined;
  function selectTab(tab: Tab) {
    const params = new URLSearchParams({ tab });
    if (selected) params.set("instance", selected.id);
    location.hash = `monitoring?${params}`;
  }
  return (
    <div className="monitoring-workspace">
      <div className="page-title">
        <div>
          <h1>Мониторинг</h1>
          <p>{selected?.name || "Локальный Prometheus"}</p>
        </div>
        <div
          className="segmented"
          role="group"
          aria-label="Разделы мониторинга"
        >
          {(
            [
              ["monitoring", "Текущий мониторинг"],
              ["configuration", "Jobs и targets"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={requested.tab === value ? "default" : "ghost"}
              aria-pressed={requested.tab === value}
              onClick={() => selectTab(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {modules.error ? (
        <ErrorBox error={modules.error} retry={() => void modules.refetch()} />
      ) : !modules.data ? (
        <p role="status">Загружаем Prometheus…</p>
      ) : !instances.length ? (
        <Empty
          title="Локальный Prometheus не установлен"
          detail="Установите Prometheus из каталога модулей."
          action={
            <a className="button button-default" href="#module-catalog">
              Открыть каталог модулей
            </a>
          }
        />
      ) : (
        <>
          {(instances.length > 1 || !selected) && (
            <Field label="Экземпляр Prometheus">
              <select
                value={selected?.id || ""}
                onChange={(event) => {
                  const id = event.target.value;
                  withSettingsNavigation(() => {
                    location.hash = `monitoring?instance=${encodeURIComponent(id)}&tab=${requested.tab}`;
                  });
                }}
              >
                <option value="" disabled>
                  Выберите установленный экземпляр
                </option>
                {instances.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {selected ? (
            <>
              <div hidden={requested.tab !== "monitoring"}>
                <PrometheusModule
                  key={`monitoring-${selected.id}`}
                  instance={selected}
                  embedded
                  active={requested.tab === "monitoring"}
                />
              </div>
              <div hidden={requested.tab !== "configuration"}>
                <PrometheusConfig
                  key={selected.id}
                  instance={selected}
                  embedded
                />
              </div>
            </>
          ) : (
            <Empty
              title="Выберите Prometheus"
              detail="Настройки и цели сбора относятся к конкретному экземпляру."
            />
          )}
        </>
      )}
    </div>
  );
}
