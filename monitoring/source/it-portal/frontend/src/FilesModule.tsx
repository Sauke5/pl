import { useEffect, useState } from "react";
import { useAPI } from "./api";
import { Empty, ErrorBox, Field } from "./components/common";
import { SFTPGo } from "./SFTPGo";
import {
  installedLocalModules,
  type ManagedNavigationInstance,
} from "./managedModuleNavigation";

function requestedInstance() {
  return (
    new URLSearchParams(location.hash.split("?")[1] || "").get("instance") || ""
  );
}

export default function FilesModule() {
  const modules = useAPI<{ items: ManagedNavigationInstance[] }>("/modules");
  const [requested, setRequested] = useState(requestedInstance);
  useEffect(() => {
    const update = () => setRequested(requestedInstance());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const instances = installedLocalModules(modules.data?.items, "sftpgo");
  const selected = requested
    ? instances.find((item) => item.id === requested)
    : instances.length === 1
      ? instances[0]
      : undefined;
  return (
    <div className="modules-page files-workspace">
      <div className="page-title">
        <div>
          <h1>Файлы</h1>
          <p>{selected?.name || "Файловый сервер SFTPGo"}</p>
        </div>
      </div>
      {modules.error ? (
        <ErrorBox error={modules.error} retry={() => void modules.refetch()} />
      ) : !modules.data ? (
        <p role="status">Загружаем файловый сервер…</p>
      ) : !instances.length ? (
        <Empty
          title="SFTPGo не установлен"
          detail="Установите файловый сервер из каталога модулей."
          action={
            <a className="button button-default" href="#module-catalog">
              Открыть каталог модулей
            </a>
          }
        />
      ) : (
        <>
          {(instances.length > 1 || !selected) && (
            <Field label="Файловый сервер">
              <select
                value={selected?.id || ""}
                onChange={(event) => {
                  location.hash = `files?instance=${encodeURIComponent(event.target.value)}`;
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
            <SFTPGo key={selected.id} instanceID={selected.id} admin />
          ) : (
            <Empty
              title="Выберите файловый сервер"
              detail="Откройте установленный экземпляр SFTPGo."
            />
          )}
        </>
      )}
    </div>
  );
}
