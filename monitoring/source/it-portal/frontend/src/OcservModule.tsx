import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ClipboardList,
  Network,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { APIError, api, queryClient } from "./api";
import { Badge, Empty, ErrorBox } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import OcservEditor from "./OcservEditor";
import OcservEmployees from "./OcservEmployees";
import OcservProfiles from "./OcservProfiles";
import { authLabel, eventLabels, formatTime, vpnTimezone } from "./ocserv";
import type { VPNDialog, VPNPayload, VPNState, VPNTab } from "./ocserv";
import "./ocserv-module.css";

type Instance = {
  id: string;
  name: string;
  desired_state: string;
  observed_state: string;
};
type Editor = { model: VPNDialog; snapshot: VPNState };
const tabFromURL = (): VPNTab =>
  new URLSearchParams(location.hash.split("?")[1]).get("tab") === "networks"
    ? "networks"
    : "employees";
const success: Record<VPNDialog["kind"], string> = {
  profile: "Профиль сохранён.",
  grant: "Назначение доступа сохранено.",
  revoke: "Доступ отозван.",
  terminate: "Сессия завершена.",
};

function Details({
  kind,
  state,
  onClose,
}: {
  kind: "gateway" | "events";
  state: VPNState;
  onClose: () => void;
}) {
  const gateway = state.gateway;
  if (kind === "gateway")
    return (
      <Dialog title="Шлюз VPN" onClose={onClose}>
        <dl className="vpn-facts">
          <div>
            <dt>Шлюз</dt>
            <dd>{gateway.name || "Не настроен"}</dd>
          </div>
          <div>
            <dt>Состояние</dt>
            <dd>
              <Badge value={gateway.ready ? "healthy" : "warning"}>
                {gateway.ready ? "Готов" : "Ожидает настройки"}
              </Badge>
            </dd>
          </div>
          <div>
            <dt>Способ входа</dt>
            <dd>{authLabel(gateway.auth_mode)}</dd>
          </div>
          <div>
            <dt>Пул адресов VPN</dt>
            <dd>
              {gateway.pool ? <code>{gateway.pool}</code> : "Не настроен"}
            </dd>
          </div>
          {gateway.observed_at && (
            <div>
              <dt>Проверено</dt>
              <dd>
                <time dateTime={gateway.observed_at}>
                  {formatTime(gateway.observed_at)}
                </time>
              </dd>
            </div>
          )}
        </dl>
      </Dialog>
    );
  return (
    <Dialog title="Журнал VPN" wide onClose={onClose}>
      {state.events.length ? (
        <div className="vpn-scroll">
          <table className="vpn-table">
            <thead>
              <tr>
                <th scope="col">Время · {vpnTimezone}</th>
                <th scope="col">Действие</th>
                <th scope="col">Объект</th>
                <th scope="col">Кто изменил</th>
              </tr>
            </thead>
            <tbody>
              {state.events.map((e, index) => (
                <tr key={index}>
                  <td>
                    <time dateTime={e.at}>{formatTime(e.at)}</time>
                  </td>
                  <td>{eventLabels[e.action] || e.action}</td>
                  <td>{e.subject}</td>
                  <td>{e.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="В журнале пока нет событий" />
      )}
    </Dialog>
  );
}

export default function OcservModule({ instance }: { instance: Instance }) {
  const [tab, setTab] = useState<VPNTab>(tabFromURL);
  const [subject, selectSubject] = useState(""),
    [profile, selectProfile] = useState("");
  const [listVersion, resetList] = useState(0);
  const [editor, setEditor] = useState<Editor>(),
    [info, setInfo] = useState<"gateway" | "events">();
  const [notice, setNotice] = useState("");
  const base = "/modules/" + encodeURIComponent(instance.id) + "/ocserv";
  const href =
    "#modules?instance=" + encodeURIComponent(instance.id) + "&view=ocserv";
  const tabHref = (v: VPNTab) =>
    href + (v === "networks" ? "&tab=networks" : "");
  const online =
    instance.desired_state === "enabled" &&
    instance.observed_state === "running";
  const path = base + "/state";
  const state = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<VPNState>(path, "GET", undefined, {}, signal),
    enabled: online,
    retry: false,
    refetchInterval: editor ? false : 15000,
    refetchOnWindowFocus: !editor,
  });
  useEffect(() => {
    const changed = () => {
      setTab(tabFromURL());
      setEditor(undefined);
      setInfo(undefined);
      setNotice("");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  function open(model: VPNDialog) {
    if (!online || !state.data || state.isError) return;
    setNotice("");
    setEditor({ model, snapshot: state.data });
  }
  function member(id: string) {
    selectSubject(id);
    resetList((n) => n + 1);
    location.hash = tabHref("employees");
  }
  function showProfile(id: string) {
    selectProfile(id);
    location.hash = tabHref("networks");
  }
  async function afterSave(response: VPNState, payload: VPNPayload) {
    if (!editor) return;
    await queryClient.cancelQueries({ queryKey: [path], exact: true });
    queryClient.setQueryData([path], response);
    switch (editor.model.kind) {
      case "profile":
        if (typeof payload.id === "string") selectProfile(payload.id);
        break;
      case "grant":
        if (typeof payload.subject === "string") {
          selectSubject(payload.subject);
          resetList((n) => n + 1);
        }
        break;
    }
    setNotice(success[editor.model.kind]);
    setEditor(undefined);
  }
  async function review() {
    await state.refetch({ throwOnError: true });
    setEditor(undefined);
    setNotice(
      "Данные обновлены. Проверьте назначение или профиль перед повторным изменением.",
    );
  }
  function denied() {
    setEditor(undefined);
    void state.refetch();
  }
  const forbidden =
    state.error instanceof APIError && [401, 403].includes(state.error.status);
  const data = online && !state.isError ? state.data : undefined;
  const networks = tab === "networks";
  return (
    <div className="vpn-module">
      <div className="page-title">
        <div>
          <a
            className="vpn-back"
            href={"#module-catalog?direction=" + encodeURIComponent("Сети")}
          >
            <ArrowLeft size={15} /> Сети
          </a>
          <h1>Корпоративный VPN</h1>
          {data && (
            <p className="vpn-gateway-summary">
              {data.gateway.name || instance.name} ·{" "}
              {authLabel(data.gateway.auth_mode)}
            </p>
          )}
        </div>
        {data && (
          <div className="actions">
            <Button onClick={() => setInfo("gateway")}>
              <Server size={16} /> Шлюз
            </Button>
            <Button onClick={() => setInfo("events")}>
              <ClipboardList size={16} /> Журнал
            </Button>
            {networks ? (
              <Button
                variant="default"
                onClick={() => open({ kind: "profile" })}
              >
                <Plus size={16} /> Создать профиль
              </Button>
            ) : (
              <Button
                variant="default"
                disabled={!data.profiles.length}
                onClick={() => open({ kind: "grant" })}
              >
                <Plus size={16} /> Выдать доступ
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="vpn-toolbar">
        <nav className="segmented" aria-label="Разделы корпоративного VPN">
          <a
            className={
              "button " + (!networks ? "button-primary" : "button-ghost")
            }
            href={tabHref("employees")}
            aria-current={!networks ? "page" : undefined}
          >
            <UsersRound size={16} /> Сотрудники
          </a>
          <a
            className={
              "button " + (networks ? "button-primary" : "button-ghost")
            }
            href={tabHref("networks")}
            aria-current={networks ? "page" : undefined}
          >
            <Network size={16} /> Сети и профили
          </a>
        </nav>
        {online && (
          <Button
            disabled={state.isFetching}
            onClick={() => void state.refetch()}
          >
            <RefreshCw size={15} /> Обновить
          </Button>
        )}
      </div>
      {!online ? (
        <Empty
          title={
            instance.desired_state !== "enabled"
              ? "Модуль VPN отключён"
              : "Сервис VPN недоступен"
          }
          action={
            <a
              className="button button-secondary"
              href={"#modules?instance=" + encodeURIComponent(instance.id)}
            >
              Состояние модуля
            </a>
          }
        />
      ) : state.isError ? (
        <ErrorBox error={state.error} retry={() => void state.refetch()} />
      ) : !data ? (
        <p className="muted" role="status">
          Загружаем состояние VPN…
        </p>
      ) : (
        <>
          {!data.gateway.ready && (
            <div className="notice compact" role="status">
              <ShieldCheck size={16} />
              Шлюз ожидает настройки. Профили и назначения можно подготовить
              заранее.
            </div>
          )}
          {notice && (
            <div role="status" className="notice compact">
              {notice}
            </div>
          )}
          {networks ? (
            <OcservProfiles
              data={data}
              selectedID={profile}
              onSelect={selectProfile}
              onMember={member}
              onOpen={open}
              disabled={!!editor}
            />
          ) : (
            <OcservEmployees
              key={listVersion}
              data={data}
              selectedSubject={subject}
              onSelect={selectSubject}
              onProfile={showProfile}
              onOpen={open}
              disabled={!!editor}
            />
          )}
          {info && (
            <Details
              kind={info}
              state={data}
              onClose={() => setInfo(undefined)}
            />
          )}
        </>
      )}
      {online && !forbidden && editor && (
        <OcservEditor
          base={base}
          model={editor.model}
          snapshot={editor.snapshot}
          onClose={() => setEditor(undefined)}
          onReview={review}
          onDenied={denied}
          onSaved={afterSave}
        />
      )}
    </div>
  );
}
