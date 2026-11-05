import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ChevronRight,
  Clock3,
  Database,
  FileArchive,
  Folder,
  HardDrive,
  History,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Upload,
  Users,
  Trash2,
} from "lucide-react";
import { api, useAPI, date, APIError, queryClient } from "./api";
import type { Session } from "./types";
import { PlatformShell } from "@pl/ui/react";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Empty, ErrorBox, Field } from "./components/common";
import {
  auditLabels,
  bytes,
  orderedVersions,
  isDeletedVersion,
  versionCanDownload,
  deletionLabel,
  versionSummary,
  confirmedDeletedVersion,
  needsDeletionCheck,
  readerOptions,
  publicKeyLines,
  provisioningLabel,
  providerLabel,
  minimumAccountQuota,
  accountQuotaBytes,
  accountKindLabel,
  type SFTPAccountKind,
  provisioningReason,
  type SFTPAccount,
  type SFTPCollection,
  type SFTPState,
  type SFTPVersion,
} from "./sftpData";
import "./sftp-server.css";

type Page = "versions" | "audit" | "accounts";
type Editor = "collection" | "upload" | "account" | undefined;
// A version is acknowledged only after four uninterrupted seconds on screen.
function VersionRow({
  version,
  folder,
  active,
  retry,
  onSeen,
  onOpen,
}: {
  version: SFTPVersion;
  folder: string;
  active: boolean;
  retry: number;
  onSeen: (id: string) => Promise<void>;
  onOpen: (version: SFTPVersion) => void;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  const [seeing, setSeeing] = useState(false);
  const [seen, setSeen] = useState(false);
  const [hadNew, setHadNew] = useState(version.is_new);
  const isNew = version.is_new && !seen && !isDeletedVersion(version);
  useEffect(() => {
    if (version.is_new) setHadNew(true);
  }, [version.is_new]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !isNew || !active) {
      setSeeing(false);
      return;
    }
    let visible = false;
    let disposed = false;
    let sending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      setSeeing(false);
    };
    const start = () => {
      cancel();
      if (!visible || document.hidden || sending) return;
      setSeeing(true);
      timer = setTimeout(() => {
        if (!visible || document.hidden || disposed) return;
        sending = true;
        void onSeen(version.id)
          .then(() => {
            if (!disposed) setSeen(true);
          })
          .catch(() => {
            // Restore the marker on failure. Retry explicitly or re-enter the viewport.
            if (!disposed) setSeeing(false);
          })
          .finally(() => {
            sending = false;
          });
      }, 4000);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextVisible =
          entry.isIntersecting && entry.intersectionRatio >= 0.9;
        if (visible !== nextVisible) {
          visible = nextVisible;
          start();
        }
      },
      { threshold: [0, 0.9, 1] },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", start);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", start);
    };
  }, [version.id, isNew, active, retry, onSeen]);
  return (
    <tr
      ref={ref}
      data-version-id={version.id}
      className={`sftp-version-row ${isNew ? "sftp-new-row" : "sftp-seen-row"} ${isNew && seeing ? "sftp-seeing-row" : ""}`}
    >
      <td>
        <button className="sftp-file-button" onClick={() => onOpen(version)}>
          <span className="sftp-file-icon">
            <FileArchive size={21} />
          </span>
          <span>
            <strong>{version.filename}</strong>
            <small>
              {folder}
              {deletionLabel(version.deletion_state) && (
                <span className="badge status-unknown">
                  {deletionLabel(version.deletion_state)}
                </span>
              )}
              {hadNew && !isDeletedVersion(version) && (
                <b className="sftp-new-label" aria-hidden={!isNew}>
                  Новая версия
                </b>
              )}
            </small>
          </span>
        </button>
      </td>
      <td>{date(version.received_at)}</td>
      <td>{version.received_by_name || version.received_by}</td>
      <td className="sftp-numeric">{bytes(version.size_bytes)}</td>
      <td>
        <Button size="sm" variant="ghost" onClick={() => onOpen(version)}>
          Подробнее
          <ChevronRight size={15} />
        </Button>
      </td>
    </tr>
  );
}

export default function SFTPServer({ session }: { session: Session }) {
  const state = useAPI<SFTPState>("/sftp-server");
  const [page, setPage] = useState<Page>("versions");
  const [collection, setCollection] = useState("");
  const [query, setQuery] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [detailSnapshot, setDetail] = useState<SFTPVersion>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>();
  const deleteInFlight = useRef(false);
  const [editor, setEditor] = useState<Editor>();
  const [editingCollection, setEditingCollection] = useState<SFTPCollection>();
  const [account, setAccount] = useState<SFTPAccount>();
  const [accountKind, setAccountKind] = useState<SFTPAccountKind>("sender");
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [seenError, setSeenError] = useState<unknown>();
  const [seenRetry, setSeenRetry] = useState(0);
  const entered = useRef(false);
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    void api("/sftp-server/access", "POST")
      .then(() => state.refetch())
      .catch(setError);
  }, []);
  const data = state.data;
  const detail =
    data?.versions.find((v) => v.id === detailSnapshot?.id) || detailSnapshot;
  const collections = data?.collections || [];
  const versions = orderedVersions(
    data?.versions || [],
    collection,
    query,
    onlyNew,
    includeDeleted,
  );
  const minimumQuota = minimumAccountQuota(collections, selectedFolders);
  const localCandidate = data?.mode === "local_candidate";
  const current = collections.find((c) => c.id === collection);
  const { newCount, totalBytes } = versionSummary(data?.versions || []);
  const folderLabel = (id?: string) =>
    collections.find((c) => c.id === id)?.label || "—";
  const markSeen = useCallback(async (id: string) => {
    try {
      await api(`/sftp-server/versions/${encodeURIComponent(id)}/seen`, "POST");
      await queryClient.cancelQueries({ queryKey: ["/sftp-server"] });
      queryClient.setQueryData<SFTPState>(["/sftp-server"], (previous) =>
        previous
          ? {
              ...previous,
              versions: previous.versions.map((version) =>
                version.id === id ? { ...version, is_new: false } : version,
              ),
            }
          : previous,
      );
    } catch (cause) {
      setSeenError(cause);
      throw cause;
    }
  }, []);
  const openVersion = (version: SFTPVersion) => {
    setConfirmDelete(false);
    setDeleteError(undefined);
    setDetail(version);
  };
  const closeDetail = () => {
    if (deleteInFlight.current) return;
    setDetail(undefined);
    setConfirmDelete(false);
    setDeleteError(undefined);
  };
  async function syncDeletion() {
    if (deleteInFlight.current) return;
    setDeleteBusy(true);
    try {
      const result = await state.refetch();
      setDeleteError(
        result.error
          ? new Error(
              "Не удалось обновить состояние файла. Повторите проверку позже.",
            )
          : undefined,
      );
    } finally {
      setDeleteBusy(false);
    }
  }
  async function deleteVersion() {
    if (
      !detail ||
      !data?.can_manage ||
      !detail.can_delete ||
      isDeletedVersion(detail) ||
      deleteInFlight.current ||
      !confirmDelete
    )
      return;
    deleteInFlight.current = true;
    setDeleteBusy(true);
    setDeleteError(undefined);
    const version = detail;
    try {
      const response = await api<unknown>(
        `/sftp-server/versions/${encodeURIComponent(version.id)}`,
        "DELETE",
      );
      const deleted = confirmedDeletedVersion(version, response);
      queryClient.setQueryData<SFTPState>(["/sftp-server"], (previous) =>
        previous
          ? {
              ...previous,
              versions: previous.versions.map((item) =>
                item.id === deleted.id ? deleted : item,
              ),
            }
          : previous,
      );
      setDetail(deleted);
      setConfirmDelete(false);
      const synced = await state.refetch();
      if (synced.error)
        setDeleteError(
          new Error(
            "Удаление подтверждено, но список файлов не обновился. Повторите проверку состояния.",
          ),
        );
    } catch (cause) {
      const definite =
        cause instanceof APIError &&
        [
          "delete_failed",
          "delete_unavailable",
          "file_identity_conflict",
          "delete_busy",
          "unsupported_source",
          "file_access_denied",
          "forbidden",
        ].includes(cause.code);
      setDeleteError(
        new Error(
          definite && cause instanceof Error
            ? cause.message
            : "Результат удаления не подтверждён. Обновите состояние файла перед повторным решением об удалении.",
        ),
      );
      setConfirmDelete(false);
      await state.refetch();
    } finally {
      deleteInFlight.current = false;
      setDeleteBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      if (editor === "upload") {
        const response = await fetch("/api/v1/sftp-server/test-upload", {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": session.csrf_token },
          body: form,
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(
            result.message ||
              result.error ||
              `Ошибка загрузки (${response.status})`,
          );
        }
      } else if (editor === "collection") {
        await api(
          `/sftp-server/collections${editingCollection ? `/${encodeURIComponent(editingCollection.id)}` : ""}`,
          editingCollection ? "PUT" : "POST",
          {
            ...(editingCollection
              ? { revision: editingCollection.revision }
              : {}),
            branch: form.get("branch"),
            label: form.get("label"),
            folder: form.get("folder"),
            reader_ids: form.getAll("reader_ids"),
            quota_bytes: Number(form.get("quota")) * 1024 ** 3,
          },
        );
      } else {
        const assigned = form.getAll("collection_ids").map(String);
        const quota = accountQuotaBytes(
          accountKind,
          Number(form.get("quota")),
          collections,
          assigned,
        );
        if (!assigned.length)
          throw new Error("Выберите хотя бы один каталог для учётной записи.");
        await api(
          `/sftp-server/accounts${account ? `/${encodeURIComponent(account.id)}` : ""}`,
          account ? "PUT" : "POST",
          {
            ...(account ? { revision: account.revision } : {}),
            kind: accountKind,
            username: form.get("username"),
            label: form.get("label"),
            collection_ids: assigned,
            quota_bytes: quota,
            enabled: form.get("enabled") === "on",
            public_keys: publicKeyLines(
              String(form.get("public_keys") || ""),
              form.get("enabled") === "on",
            ),
          },
        );
      }
      setEditor(undefined);
      setEditingCollection(undefined);
      setAccount(undefined);
      setAccountKind("sender");
      setSelectedFolders([]);
      await state.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api("/sftp-server/reconcile", "POST");
      await state.refetch();
    } catch (e) {
      setError(e);
      await state.refetch();
    } finally {
      setBusy(false);
    }
  }
  const closeEditor = () => {
    if (!busy) {
      setEditor(undefined);
      setEditingCollection(undefined);
      setAccount(undefined);
      setAccountKind("sender");
      setSelectedFolders([]);
      setError(undefined);
    }
  };
  return (
    <PlatformShell
      shellClassName="sftp-shell"
      context="Выгрузки баз"
      user={{
        name: session.user?.name || session.user?.id,
        subtitle: "Пользователь Платформы",
      }}
      onLogout={() =>
        api("/auth/logout", "POST")
          .then(() => location.assign("/"))
          .catch(setError)
      }
      navigation={
        <>
          <button
            className={page === "versions" ? "active" : ""}
            aria-label="Версии баз"
            title="Версии баз"
            onClick={() => setPage("versions")}
          >
            <Archive size={21} />
            <span>Версии баз</span>
            {newCount > 0 && <b className="nav-count">{newCount}</b>}
          </button>
          <button
            className={page === "audit" ? "active" : ""}
            aria-label="Журнал действий"
            title="Журнал действий"
            onClick={() => setPage("audit")}
          >
            <History size={21} />
            <span>Журнал действий</span>
          </button>
          {data?.can_manage && (
            <button
              className={page === "accounts" ? "active" : ""}
              aria-label="Учётные записи"
              title="Учётные записи"
              onClick={() => setPage("accounts")}
            >
              <Users size={21} />
              <span>Учётные записи</span>
            </button>
          )}
          {session.user?.admin && (
            <button
              aria-label="Файловый сервер"
              title="Файловый сервер"
              onClick={() => location.assign("/sftp-adm")}
            >
              <HardDrive size={21} />
              <span>Файловый сервер</span>
            </button>
          )}
        </>
      }
      sidebarFooter={
        <>
          <a className="sftp-back" href="/" aria-label="Платформа" title="Платформа">
            <ArrowLeft size={18} />
            <span>Платформа</span>
          </a>
          <div className="sidebar-footer">
            <strong>PL</strong>
            <span>IT PLATFORM</span>
          </div>
        </>
      }
      mainClassName="sftp-main"
    >
          <div className="sftp-heading">
            <div>
              <p className="sftp-eyebrow">ФАЙЛОВЫЙ АРХИВ</p>
              <h1>
                {page === "versions"
                  ? "Выгрузки баз"
                  : page === "audit"
                    ? "Журнал действий"
                    : "Учётные записи"}
              </h1>
              <p className="muted">
                {page === "versions"
                  ? "Файлы филиалов и история полученных версий"
                  : page === "audit"
                    ? "Входы в сервис, загрузки и изменения настроек"
                    : "Отправители и получатели файлов по SFTP"}
              </p>
            </div>
            <div className="sftp-actions">
              <Button
                aria-label="Обновить данные"
                onClick={() => void state.refetch()}
                disabled={state.isFetching}
              >
                <RefreshCw
                  size={16}
                  className={state.isFetching ? "sftp-spin" : ""}
                />
                Обновить
              </Button>
              {data?.can_manage && page === "versions" && (
                <Button
                  onClick={() => {
                    setError(undefined);
                    setEditor("collection");
                  }}
                >
                  <Plus size={16} />
                  Каталог
                </Button>
              )}
              {data?.can_manage &&
                data.demo_upload_enabled &&
                localCandidate &&
                page === "versions" && (
                  <Button
                    variant="default"
                    disabled={!collections.length}
                    onClick={() => {
                      setError(undefined);
                      setEditor("upload");
                    }}
                  >
                    <Upload size={16} />
                    Тестовая загрузка
                  </Button>
                )}
              {data?.can_manage && page === "accounts" && (
                <Button
                  variant="default"
                  disabled={!collections.length}
                  onClick={() => {
                    setError(undefined);
                    setAccountKind("sender");
                    setEditor("account");
                  }}
                >
                  <Plus size={16} />
                  Учётная запись
                </Button>
              )}
            </div>
          </div>
          {data && (
            <div
              className={`notice sftp-candidate sftp-provider-${data.provider?.status || "unknown"}`}
              role="status"
            >
              <Shield size={18} />
              <div>
                <strong>
                  {localCandidate
                    ? "Локальный стенд"
                    : providerLabel(data.provider?.status)}
                </strong>
                <span>
                  {" "}
                  ·{" "}
                  {localCandidate
                    ? data.demo_upload_enabled && data.can_manage
                      ? "Доступна загрузка тестовых ZIP-архивов до 8 МиБ."
                      : "Приём файлов SFTP не подключён."
                    : "Приём файлов и управление доступом"}
                </span>
                {!localCandidate && (
                  <small className="sftp-provider-time">
                    Последняя проверка:{" "}
                    {data.provider?.last_attempt_at
                      ? date(data.provider.last_attempt_at)
                      : "Нет данных"}{" "}
                    · Последняя успешная проверка:{" "}
                    {data.provider?.last_success_at
                      ? date(data.provider.last_success_at)
                      : "Нет подтверждения"}
                  </small>
                )}
                {!localCandidate &&
                  ["error", "stale"].includes(data.provider?.status || "") && (
                    <small className="sftp-provider-time">
                      Статусы и файлы показаны по последним сохранённым данным.
                      {data.can_manage && data.provider?.error && (
                        <> {provisioningReason(data.provider.error)}</>
                      )}
                    </small>
                  )}
                {!localCandidate &&
                  (data.provider?.quarantined_receipts || 0) > 0 && (
                    <small className="sftp-provider-time">
                      Изолировано событий загрузки:{" "}
                      {data.provider?.quarantined_receipts}. Эти файлы не
                      включены в архив; остальные загрузки обрабатываются.
                    </small>
                  )}
              </div>
              {!localCandidate && data.can_manage && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void reconcile()}
                >
                  <RefreshCw size={15} className={busy ? "sftp-spin" : ""} />
                  {busy ? "Проверяем…" : "Проверить и применить"}
                </Button>
              )}
            </div>
          )}
          {state.error && (
            <ErrorBox error={state.error} retry={() => void state.refetch()} />
          )}
          {!!error && !editor && (
            <ErrorBox error={error} retry={() => setError(undefined)} />
          )}
          {!!seenError && (
            <ErrorBox
              error={seenError}
              retry={() => {
                setSeenError(undefined);
                setSeenRetry((value) => value + 1);
              }}
            />
          )}
          {!data && !state.error && (
            <section className="panel sftp-loading" aria-busy="true">
              <RefreshCw size={24} className="sftp-spin" />
              <span>Загружаем архив…</span>
            </section>
          )}
          {data && page === "versions" && (
            <>
              <div className="sftp-summary">
                <div>
                  <Database size={19} />
                  <span>
                    Каталоги<strong>{collections.length}</strong>
                  </span>
                </div>
                <div>
                  <FileArchive size={19} />
                  <span>
                    Получено версий
                    <strong>
                      {data.versions_total ?? data.versions.length}
                    </strong>
                  </span>
                </div>
                <div>
                  <HardDrive size={19} />
                  <span>
                    Объём в списке<strong>{bytes(totalBytes)}</strong>
                  </span>
                </div>
                <button
                  className={onlyNew ? "selected" : ""}
                  onClick={() => setOnlyNew(!onlyNew)}
                  aria-pressed={onlyNew}
                  aria-label={`Новые для вас: ${newCount}`}
                >
                  <span className="sftp-new-dot" />
                  <span>
                    Новые для вас<strong>{newCount}</strong>
                  </span>
                </button>
              </div>
              {data.versions_has_more && (
                <div className="notice compact">
                  Показаны последние {data.versions.length} из{" "}
                  {data.versions_total} версий. Поиск и фильтры применяются к
                  этому списку.
                </div>
              )}
              <section className="panel sftp-archive">
                <div className="sftp-folder-list">
                  <button
                    className={!collection ? "active" : ""}
                    onClick={() => setCollection("")}
                  >
                    <Archive size={17} />
                    <span>Все каталоги</span>
                    <small>{data.versions.length}</small>
                  </button>
                  {collections.map((c) => (
                    <button
                      key={c.id}
                      className={collection === c.id ? "active" : ""}
                      onClick={() => setCollection(c.id)}
                    >
                      <Folder size={17} />
                      <span>
                        {c.branch}
                        <small>{c.label}</small>
                      </span>
                      {data.versions.some(
                        (v) =>
                          v.collection_id === c.id &&
                          v.is_new &&
                          !isDeletedVersion(v),
                      ) && <i className="sftp-new-dot" />}
                    </button>
                  ))}
                  {data.retention_enforced && (
                    <div className="sftp-folder-note">
                      <Clock3 size={15} />
                      <span>Хранение: {data.retention_months} месяца</span>
                    </div>
                  )}
                </div>
                <div className="sftp-files">
                  <div className="sftp-toolbar">
                    <div>
                      <h2>{current?.label || "Все версии"}</h2>
                      <small className="muted">
                        {current
                          ? `${current.branch} · /${current.folder}`
                          : "От новых к ранним"}
                      </small>
                      {data.can_manage && current && !localCandidate && (
                        <small
                          className={`sftp-provision sftp-provision-${current.provisioning_state || "pending"}`}
                        >
                          Каталог:{" "}
                          {provisioningLabel(current.provisioning_state)}
                          {["error", "conflict"].includes(
                            current.provisioning_state || "",
                          ) && (
                            <>
                              {" "}
                              · {provisioningReason(current.provisioning_error)}
                            </>
                          )}
                        </small>
                      )}
                    </div>
                    {data.can_manage && current && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Настройки каталога"
                        onClick={() => {
                          setEditingCollection(current);
                          setError(undefined);
                          setEditor("collection");
                        }}
                      >
                        <Settings2 size={16} />
                      </Button>
                    )}
                    <label className="sftp-search">
                      <Search size={16} />
                      <input
                        aria-label="Найти файл или отправителя"
                        placeholder="Файл или отправитель"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <label className="sftp-check">
                      <input
                        type="checkbox"
                        checked={includeDeleted}
                        onChange={(event) =>
                          setIncludeDeleted(event.target.checked)
                        }
                      />
                      Показать удалённые
                    </label>
                    <label className="sftp-check">
                      <input
                        type="checkbox"
                        checked={onlyNew}
                        onChange={(e) => setOnlyNew(e.target.checked)}
                      />
                      Новые
                    </label>
                  </div>
                  {!versions.length ? (
                    <Empty
                      title={
                        data.versions.length
                          ? "Нет подходящих версий"
                          : "Файлов пока нет"
                      }
                      detail={
                        data.versions.length
                          ? "Измените поиск, отключите фильтр новых версий или включите «Показать удалённые»."
                          : data.can_manage &&
                              data.demo_upload_enabled &&
                              localCandidate
                            ? "Создайте каталог и загрузите тестовый ZIP-архив."
                            : "В этом разделе появятся полученные версии файлов."
                      }
                      action={
                        data.versions.length ? (
                          <Button
                            onClick={() => {
                              setQuery("");
                              setOnlyNew(false);
                              setCollection("");
                              setIncludeDeleted(true);
                            }}
                          >
                            Сбросить фильтры
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <div className="sftp-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Файл / каталог</th>
                            <th>Получен</th>
                            <th>Отправитель</th>
                            <th>Размер</th>
                            <th>
                              <span className="sftp-visually-hidden">
                                Действия
                              </span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {versions.map((v) => (
                            <VersionRow
                              key={v.id}
                              version={v}
                              folder={folderLabel(v.collection_id)}
                              active={!detail && !editor}
                              retry={seenRetry}
                              onSeen={markSeen}
                              onOpen={openVersion}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
          {data && page === "audit" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  <History size={18} />
                  Последние действия
                </h2>
                <span className="muted">
                  {data.audit.length} из {data.audit_total ?? data.audit.length}{" "}
                  записей
                </span>
              </div>
              {!data.audit.length ? (
                <Empty title="Журнал пока пуст" />
              ) : (
                <div className="sftp-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Время</th>
                        <th>Действие</th>
                        <th>Пользователь</th>
                        <th>Каталог</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.audit.map((a) => (
                        <tr key={a.id}>
                          <td>{date(a.occurred_at)}</td>
                          <td>{auditLabels[a.action] || a.action}</td>
                          <td>{a.actor_name || a.actor}</td>
                          <td>{folderLabel(a.collection_id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {data?.can_manage && page === "accounts" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  <Users size={18} />
                  Доступ по SFTP
                </h2>
                <span className="muted">
                  Учётных записей: {data.accounts.length}
                </span>
              </div>
              <div className="notice compact">
                <Shield size={16} />
                {localCandidate
                  ? "Настройки сохраняются на локальном стенде."
                  : "Вход только по SSH-ключу. Отправители загружают файлы, получатели просматривают и скачивают из назначенных папок. Удаление и изменение файлов запрещены."}
              </div>
              {!data.accounts.length ? (
                <Empty
                  title="Учётных записей пока нет"
                  detail="Создайте каталог, затем добавьте отправителя или получателя и назначьте ему папки."
                />
              ) : (
                <div className="sftp-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Учётная запись</th>
                        <th>Тип / доступ</th>
                        <th>Назначенные каталоги</th>
                        <th>Квота</th>
                        <th>Настройка</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.accounts.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <strong>{a.label}</strong>
                            <small>{a.username}</small>
                          </td>
                          <td>
                            <strong>{accountKindLabel(a.kind)}</strong>
                            <small>
                              {a.kind === "receiver"
                                ? "Просмотр и скачивание"
                                : "Только загрузка"}
                            </small>
                          </td>
                          <td>
                            {a.collection_ids
                              .map((id) => folderLabel(id))
                              .join(", ")}
                          </td>
                          <td>
                            {a.kind === "receiver"
                              ? "Не требуется"
                              : bytes(a.quota_bytes)}
                          </td>
                          <td>
                            <span
                              className={`sftp-provision sftp-provision-${a.provisioning_state}`}
                            >
                              {provisioningLabel(a.provisioning_state)}
                            </span>
                            <small>
                              {a.provisioning_state === "applied"
                                ? a.enabled
                                  ? "Включена"
                                  : "Отключена"
                                : a.enabled
                                  ? "Запрошено включение"
                                  : "Запрошено отключение"}{" "}
                              · ключей: {a.public_keys?.length || 0}
                            </small>
                            {a.last_applied_at && (
                              <small>
                                Применено: {date(a.last_applied_at)}
                              </small>
                            )}
                            {["error", "conflict"].includes(
                              a.provisioning_state,
                            ) && (
                              <small>
                                {provisioningReason(a.provisioning_error)}
                              </small>
                            )}
                          </td>
                          <td>
                            <div className="sftp-actions">
                              {["error", "conflict", "pending"].includes(
                                a.provisioning_state,
                              ) &&
                                !localCandidate && (
                                  <Button
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void reconcile()}
                                  >
                                    <RefreshCw size={15} />
                                    Повторить
                                  </Button>
                                )}
                              <Button
                                size="sm"
                                onClick={() => {
                                  setAccount(a);
                                  setAccountKind(a.kind || "sender");
                                  setSelectedFolders(a.collection_ids);
                                  setError(undefined);
                                  setEditor("account");
                                }}
                              >
                                <Settings2 size={15} />
                                Изменить
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
      {detail && (
        <Dialog
          title={detail.filename}
          description="Сведения о полученном архиве"
          onClose={closeDetail}
        >
          <dl className="sftp-details">
            <div>
              <dt>Каталог</dt>
              <dd>{folderLabel(detail.collection_id)}</dd>
            </div>
            <div>
              <dt>Получен</dt>
              <dd>{date(detail.received_at)}</dd>
            </div>
            <div>
              <dt>Отправитель</dt>
              <dd>{detail.received_by_name || detail.received_by}</dd>
            </div>
            <div>
              <dt>Размер</dt>
              <dd>{bytes(detail.size_bytes)}</dd>
            </div>
            <div>
              <dt>Источник</dt>
              <dd>
                {detail.source === "sftpgo"
                  ? "SFTPGo"
                  : detail.source === "test"
                    ? "Тестовая загрузка"
                    : "Источник не определён"}
              </dd>
            </div>
            <div className="sftp-hash">
              <dt>SHA-256</dt>
              <dd>
                <code>{detail.sha256}</code>
              </dd>
            </div>
          </dl>
          {deletionLabel(detail.deletion_state) && (
            <p className="notice" role="status">
              {deletionLabel(detail.deletion_state)}
              {detail.deleted_at && <> · {date(detail.deleted_at)}</>}
            </p>
          )}
          {!!deleteError && (
            <>
              <ErrorBox error={deleteError} />
              <Button
                size="sm"
                onClick={() => void syncDeletion()}
                disabled={deleteBusy}
              >
                Обновить состояние
              </Button>
            </>
          )}
          {confirmDelete && !isDeletedVersion(detail) && (
            <section className="notice" aria-label="Подтверждение удаления">
              <h3>
                {needsDeletionCheck(detail)
                  ? `Проверить результат удаления «${detail.filename}»?`
                  : `Удалить «${detail.filename}» с SFTP?`}
              </h3>
              <p>
                {needsDeletionCheck(detail)
                  ? "Повторная команда удаления не отправляется. Сервис проверит, остался ли файл на SFTP. Копии в DFS и история действий не изменятся."
                  : "Файл будет удалён без возможности восстановления через панель. Копии в DFS не изменятся. История получения и действий останется в журнале."}
              </p>
              <div className="sftp-actions">
                <Button
                  variant={
                    needsDeletionCheck(detail) ? "secondary" : "destructive"
                  }
                  disabled={deleteBusy}
                  onClick={() => void deleteVersion()}
                >
                  {deleteBusy
                    ? needsDeletionCheck(detail)
                      ? "Проверяем…"
                      : "Удаляем…"
                    : needsDeletionCheck(detail)
                      ? "Проверить результат"
                      : "Подтвердить удаление"}
                </Button>
                <Button
                  disabled={deleteBusy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Отмена
                </Button>
              </div>
            </section>
          )}
          <div className="dialog-footer">
            {versionCanDownload(detail) && !deleteBusy ? (
              <a
                className="button button-primary"
                href={`/api/v1/sftp-server/versions/${encodeURIComponent(detail.id)}/download`}
              >
                <ArrowDownToLine size={16} />
                Скачать архив
              </a>
            ) : (
              <span className="muted">
                {isDeletedVersion(detail)
                  ? "Файл удалён; скачивание недоступно"
                  : ["pending", "uncertain"].includes(
                        detail.deletion_state || "",
                      )
                    ? "Скачивание недоступно до подтверждения состояния файла"
                    : "Скачивание этого каталога вам не разрешено"}
              </span>
            )}
            {data?.can_manage &&
              detail.can_delete &&
              !isDeletedVersion(detail) &&
              !confirmDelete && (
                <Button
                  variant={
                    needsDeletionCheck(detail) ? "secondary" : "destructive"
                  }
                  disabled={deleteBusy}
                  onClick={() => {
                    setDeleteError(undefined);
                    setConfirmDelete(true);
                  }}
                >
                  {needsDeletionCheck(detail) ? (
                    <RefreshCw size={16} />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  {needsDeletionCheck(detail)
                    ? "Проверить удаление"
                    : "Удалить с SFTP"}
                </Button>
              )}
            <Button disabled={deleteBusy} onClick={closeDetail}>
              Закрыть
            </Button>
          </div>
        </Dialog>
      )}
      {editor && (
        <Dialog
          title={
            editor === "collection"
              ? editingCollection
                ? "Настройки каталога"
                : "Новый каталог"
              : editor === "upload"
                ? "Тестовая загрузка"
                : account
                  ? "Настройки учётной записи"
                  : "Новая учётная запись"
          }
          description={
            editor === "account"
              ? "Отдельная учётная запись SFTP с входом по SSH-ключу и доступом только к назначенным папкам."
              : editor === "upload"
                ? "Реальный ZIP-архив до 8 МиБ. Загрузка сохраняется только на локальном стенде."
                : "Каталог объединяет версии одной базы и задаёт область доступа отправителей."
          }
          onClose={closeEditor}
        >
          <form onSubmit={(e) => void save(e)}>
            {!!error && <ErrorBox error={error} />}
            {editor === "collection" ? (
              <>
                <Field label="Филиал">
                  <input
                    name="branch"
                    required
                    maxLength={120}
                    defaultValue={editingCollection?.branch}
                    placeholder="Название филиала"
                  />
                </Field>
                <Field label="Название базы">
                  <input
                    name="label"
                    required
                    maxLength={120}
                    defaultValue={editingCollection?.label}
                    placeholder="Бухгалтерская база"
                  />
                </Field>
                <Field
                  label="Папка"
                  hint="Строчные латинские буквы, цифры, дефис и подчёркивание"
                >
                  <input
                    name="folder"
                    required
                    pattern={"[a-z0-9][a-z0-9_\\-]{0,63}"}
                    maxLength={64}
                    defaultValue={editingCollection?.folder}
                    placeholder="branch-accounting"
                  />
                </Field>
                <Field label="Квота каталога, ГиБ">
                  <input
                    name="quota"
                    required
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    defaultValue={
                      editingCollection
                        ? editingCollection.quota_bytes / 1024 ** 3
                        : 10
                    }
                  />
                </Field>
                <fieldset className="sftp-folder-access">
                  <legend>Кому разрешено скачивание</legend>
                  {readerOptions(
                    data?.available_readers || [],
                    editingCollection?.reader_ids || [],
                  ).map((reader) => (
                    <label className="sftp-check" key={reader.id}>
                      <input
                        type="checkbox"
                        name="reader_ids"
                        value={reader.id}
                        defaultChecked={editingCollection?.reader_ids.includes(
                          reader.id,
                        )}
                      />
                      {reader.name}
                    </label>
                  ))}
                  {!readerOptions(
                    data?.available_readers || [],
                    editingCollection?.reader_ids || [],
                  ).length && (
                    <span className="muted">
                      Пользователей для выбора пока нет.
                    </span>
                  )}
                </fieldset>
                <p className="muted">
                  Пользователи появляются в списке после первого входа в
                  Платформу. Если никого не выбрать, скачивание запрещено всем.
                </p>
              </>
            ) : editor === "upload" ? (
              <>
                <Field label="Каталог">
                  <select
                    name="collection_id"
                    required
                    defaultValue={collection || collections[0]?.id}
                  >
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.branch} · {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="ZIP-архив">
                  <input
                    type="file"
                    name="file"
                    required
                    accept=".zip,application/zip"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="Тип учётной записи">
                  <select
                    name="kind"
                    value={accountKind}
                    onChange={(event) =>
                      setAccountKind(event.target.value as SFTPAccountKind)
                    }
                  >
                    <option value="sender">
                      Отправитель — только загрузка
                    </option>
                    <option value="receiver">
                      Получатель — просмотр и скачивание
                    </option>
                  </select>
                </Field>
                <p className="muted sftp-kind-note">
                  {accountKind === "receiver"
                    ? "Получатель видит список файлов и скачивает их из назначенных папок. Загрузка, изменение и удаление запрещены."
                    : "Отправитель загружает новые файлы. Просмотр, скачивание, перезапись и удаление запрещены."}
                </p>
                <Field label="Название">
                  <input
                    name="label"
                    required
                    maxLength={120}
                    defaultValue={account?.label}
                    placeholder={
                      accountKind === "receiver"
                        ? "Получатель баз"
                        : "Отправитель филиала"
                    }
                  />
                </Field>
                <Field label="Логин SFTP">
                  <input
                    name="username"
                    required
                    pattern={"[a-z0-9][a-z0-9_\\-]{0,63}"}
                    maxLength={64}
                    defaultValue={account?.username}
                    readOnly={!!account}
                    placeholder={
                      accountKind === "receiver"
                        ? "branch-receiver"
                        : "branch-uploader"
                    }
                  />
                </Field>
                <Field
                  label="Публичные SSH-ключи"
                  hint="Вставьте публичный ключ с компьютера пользователя или службы, по одному ключу на строку. Закрытый ключ остаётся у владельца."
                >
                  <textarea
                    name="public_keys"
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    defaultValue={(account?.public_keys || []).join("\n")}
                    placeholder="ssh-ed25519 AAAA… филиал"
                    className="sftp-public-keys"
                  />
                </Field>
                {accountKind === "sender" ? (
                  <>
                    {" "}
                    <Field
                      label="Квота пользователя, ГиБ"
                      hint={`Не меньше суммы квот выбранных каталогов: ${bytes(minimumQuota)}. Лимиты каталогов общие для всех отправителей; заполнение каталога учитывается отдельно от квоты пользователя.`}
                    >
                      <input
                        name="quota"
                        required
                        type="number"
                        min={Math.max(1, minimumQuota / 1024 ** 3)}
                        max="10000"
                        step="1"
                        defaultValue={
                          account && account.quota_bytes > 0
                            ? account.quota_bytes / 1024 ** 3
                            : Math.max(10, minimumQuota / 1024 ** 3)
                        }
                      />
                    </Field>
                  </>
                ) : (
                  <p className="notice compact">
                    Получатель не загружает файлы: квота на запись ему не
                    требуется. Ограничения хранения задаются в каталогах.
                  </p>
                )}
                <fieldset className="sftp-folder-access">
                  <legend>
                    {accountKind === "receiver"
                      ? "Папки для просмотра и скачивания"
                      : "Папки для загрузки"}
                  </legend>
                  {collections.map((c) => (
                    <label className="sftp-check" key={c.id}>
                      <input
                        type="checkbox"
                        name="collection_ids"
                        value={c.id}
                        checked={selectedFolders.includes(c.id)}
                        onChange={(event) =>
                          setSelectedFolders((current) =>
                            event.target.checked
                              ? [...current, c.id]
                              : current.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.branch} · {c.label}
                    </label>
                  ))}
                </fieldset>
                <label className="sftp-check">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={account?.enabled ?? true}
                  />
                  Включить учётную запись
                </label>
                <p className="muted">
                  {localCandidate
                    ? "Изменения сохраняются только на локальном стенде."
                    : "Изменения будут отправлены в SFTPGo. Результат применения виден в таблице учётных записей."}
                </p>
              </>
            )}
            <div className="dialog-footer">
              <Button onClick={closeEditor} disabled={busy}>
                Отмена
              </Button>
              <Button type="submit" variant="default" disabled={busy}>
                {busy
                  ? "Сохраняем…"
                  : editor === "upload"
                    ? "Загрузить архив"
                    : "Сохранить"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </PlatformShell>
  );
}
