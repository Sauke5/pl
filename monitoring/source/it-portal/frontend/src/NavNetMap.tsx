import NetMapModule from "./NetMapModule";
import { Empty, ErrorBox } from "./components/common";
import type { ManagedNavigationInstance } from "./managedModuleNavigation";

export default function NavNetMap({
  instances,
  loading,
  error,
  retry,
}: {
  instances: ManagedNavigationInstance[];
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  if (error) return <ErrorBox error={error} retry={retry} />;
  if (loading) return <p role="status">Загружаем подключение NetMap…</p>;
  if (!instances.length)
    return (
      <Empty
        title="NetMap не подключён"
        detail="Установите NetMap или подключите внешний сервер из каталога модулей."
        action={
          <a className="button button-secondary" href="#module-catalog">
            Открыть каталог модулей
          </a>
        }
      />
    );
  if (instances.length !== 1)
    return (
      <>
        <ErrorBox
          error={
            new Error(
              "Общий адрес NetMap занят несколькими подключениями. Проверьте список модулей.",
            )
          }
        />
        <a className="button button-secondary" href="#modules">
          Открыть модули
        </a>
      </>
    );
  return <NetMapModule instance={instances[0]} />;
}
