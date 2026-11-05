import { useEffect, useState } from "react";
import { useAPI } from "./api";
import { Empty, ErrorBox, Field } from "./components/common";
import MailcowModule from "./MailcowModule";
import {
  externalModules,
  type ManagedNavigationInstance,
} from "./managedModuleNavigation";
import { withSettingsNavigation } from "./settings/navigation";

function requestedInstance() {
  return (
    new URLSearchParams(location.hash.split("?")[1] || "").get("instance") || ""
  );
}

export default function Mail() {
  const modules = useAPI<{ items: ManagedNavigationInstance[] }>("/modules");
  const [requested, setRequested] = useState(requestedInstance);
  useEffect(() => {
    const update = () => setRequested(requestedInstance());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const instances = externalModules(modules.data?.items, "mailcow");
  const selected = requested
    ? instances.find((item) => item.id === requested)
    : instances.length === 1
      ? instances[0]
      : undefined;
  return (
    <div className="modules-page mail-workspace">
      {!selected && (
        <div className="page-title">
          <div>
            <h1>Почта</h1>
            <p>Подключённые серверы Mailcow</p>
          </div>
        </div>
      )}
      {modules.error ? (
        <ErrorBox error={modules.error} retry={() => void modules.refetch()} />
      ) : !modules.data ? (
        <p role="status">Загружаем подключения почты…</p>
      ) : !instances.length ? (
        <Empty
          title="Mailcow не подключён"
          detail="Добавьте почтовый сервер из каталога модулей."
          action={
            <a className="button button-default" href="#module-catalog">
              Открыть каталог модулей
            </a>
          }
        />
      ) : (
        <>
          {(instances.length > 1 || !selected) && (
            <Field label="Подключение Mailcow">
              <select
                value={selected?.id || ""}
                onChange={(event) => {
                  const id = event.target.value;
                  withSettingsNavigation(() => {
                    location.hash = `mail?instance=${encodeURIComponent(id)}`;
                  });
                }}
              >
                <option value="" disabled>
                  Выберите почтовый сервер
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
            <MailcowModule key={selected.id} instanceID={selected.id} />
          ) : (
            <Empty
              title={
                requested
                  ? "Это подключение Mailcow недоступно"
                  : "Выберите почтовый сервер"
              }
              detail="Сводка и настройки сбора относятся к выбранному подключению."
            />
          )}
        </>
      )}
    </div>
  );
}
