import { useEffect, useState } from "react";
import { useAPI } from "./api";
import { Empty, ErrorBox, Field } from "./components/common";
import AlertmanagerModule from "./AlertmanagerModule";
import {
  installedLocalModules,
  type ManagedNavigationInstance,
} from "./managedModuleNavigation";
import { withSettingsNavigation } from "./settings/navigation";

function requestedInstance() {
  return (
    new URLSearchParams(location.hash.split("?")[1] || "").get("instance") || ""
  );
}

export default function Notifications() {
  const modules = useAPI<{ items: ManagedNavigationInstance[] }>("/modules");
  const [requested, setRequested] = useState(requestedInstance);
  useEffect(() => {
    const update = () => setRequested(requestedInstance());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const instances = installedLocalModules(modules.data?.items, "alertmanager");
  const selected = requested
    ? instances.find((item) => item.id === requested)
    : instances.length === 1
      ? instances[0]
      : undefined;
  return (
    <div className="modules-page notifications-workspace">
      {!selected && (
        <div className="page-title">
          <div>
            <h1>Уведомления</h1>
            <p>Локальный Alertmanager</p>
          </div>
        </div>
      )}
      {modules.error ? (
        <ErrorBox error={modules.error} retry={() => void modules.refetch()} />
      ) : !modules.data ? (
        <p role="status">Загружаем Alertmanager…</p>
      ) : !instances.length ? (
        <Empty
          title="Alertmanager не установлен"
          detail="Установите Alertmanager из каталога модулей."
          action={
            <a className="button button-default" href="#module-catalog">
              Открыть каталог модулей
            </a>
          }
        />
      ) : (
        <>
          {(instances.length > 1 || !selected) && (
            <Field label="Экземпляр Alertmanager">
              <select
                value={selected?.id || ""}
                onChange={(event) => {
                  const id = event.target.value;
                  withSettingsNavigation(() => {
                    location.hash = `notifications?instance=${encodeURIComponent(id)}`;
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
            <AlertmanagerModule key={selected.id} instance={selected} />
          ) : (
            <Empty
              title="Выберите Alertmanager"
              detail="Получатели и правила доставки относятся к конкретному экземпляру."
            />
          )}
        </>
      )}
    </div>
  );
}
