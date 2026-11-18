import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { queryClient, useAPI } from "../api";
import { Empty, ErrorBox, Panel } from "../components/common";
import { Button } from "../components/ui/button";
import type { ManagedNavigationInstance } from "../managedModuleNavigation";
import OcservGateway from "../OcservGateway";
import "../ocserv-module.css";

export function VPNSettings() {
  const modules = useAPI<{ items: ManagedNavigationInstance[] }>("/modules");
  const [gateway, setGateway] = useState<string>();
  const instance = modules.data?.items.find(
    (item) =>
      item.module_id === "ocserv" &&
      item.mode === "local" &&
      item.desired_state !== "removed" &&
      item.observed_state !== "absent",
  );
  const ready =
    instance?.desired_state === "enabled" &&
    instance.observed_state === "running";
  const id = instance && encodeURIComponent(instance.id);

  return (
    <Panel title="Корпоративный VPN" icon={<ShieldCheck size={20} />}>
      {modules.error ? (
        <ErrorBox error={modules.error} retry={() => void modules.refetch()} />
      ) : modules.isPending ? (
        <p role="status" className="settings-loading">
          Получаем состояние модуля VPN…
        </p>
      ) : !id ? (
        <Empty
          title="Корпоративный VPN не установлен"
          action={
            <a className="button button-secondary" href="#module-catalog">
              Каталог модулей
            </a>
          }
        />
      ) : (
        <>
          <p className="muted">
            {ready
              ? "Адрес шлюза, способ входа, сертификаты и пул клиентов."
              : "Шлюз недоступен. Состояние установки можно проверить в модуле VPN."}
          </p>
          <div className="actions">
            <Button
              variant="default"
              disabled={!ready}
              onClick={() => setGateway(`/modules/${id}/ocserv`)}
            >
              Настроить шлюз
            </Button>
            <a
              className="button button-secondary"
              href={`#modules?instance=${id}&view=ocserv`}
            >
              Открыть модуль VPN
            </a>
          </div>
        </>
      )}
      {gateway && (
        <OcservGateway
          base={gateway}
          onClose={() => setGateway(undefined)}
          onApplied={() =>
            void queryClient.invalidateQueries({
              queryKey: [gateway + "/state"],
            })
          }
        />
      )}
    </Panel>
  );
}
