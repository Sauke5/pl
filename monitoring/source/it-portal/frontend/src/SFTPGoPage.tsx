import { useAPI } from "./api";
import { Empty, ErrorBox } from "./components/common";
import { SFTPGo } from "./SFTPGo";

export default function SFTPGoPage({ admin }: { admin: boolean }) {
  const instance = useAPI<{ instance_id: string }>("/sftpgo");
  return (
    <main className="sftpgo-page">
      <a className="button button-secondary" href="/">
        На главную
      </a>
      {instance.error ? (
        <ErrorBox error={instance.error} />
      ) : !instance.data ? (
        <Empty title="Подключение к файловому серверу…" />
      ) : (
        <SFTPGo instanceID={instance.data.instance_id} admin={admin} />
      )}
    </main>
  );
}
