import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "./api";

type Metadata = Awaited<ReturnType<typeof api.getManagement>>;

export function DoskaProjectManagement({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("doska");
  const dialog = useRef<HTMLDialogElement>(null);
  const metadata = useQuery({
    queryKey: ["doska", "management", projectId],
    queryFn: () => api.getManagement(projectId),
  });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="doska-dialog pl-ui-native-dialog"
      aria-labelledby="project-management-heading"
      onCancel={onClose}
    >
      <h2 id="project-management-heading">{t("projectManagementTitle")}</h2>
      {metadata.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : metadata.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button
            className="pl-ui-button pl-ui-button-secondary"
            onClick={() => void metadata.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : (
        <ManagementActions
          key={generation}
          metadata={metadata.data}
          onClose={onClose}
          onReload={async () => {
            const result = await metadata.refetch();
            if (result.isSuccess) setGeneration((value) => value + 1);
          }}
        />
      )}
      <footer>
        <button className="pl-ui-button pl-ui-button-secondary" onClick={onClose}>
          {t("close")}
        </button>
      </footer>
    </dialog>
  );
}

function ManagementActions({
  metadata,
  onClose,
  onReload,
}: {
  metadata: Metadata;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const [revision] = useState(metadata.revision);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [owner, setOwner] = useState<{ userId: string; name: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<"archive" | "transfer" | null>(null);
  const employees = useQuery({
    queryKey: ["doska", "ownership-options", metadata.id, search, page],
    queryFn: () =>
      api.employeeOptions(metadata.id, {
        purpose: "ownership",
        search,
        limit: 20,
        offset: page * 20,
      }),
  });
  const action = useMutation({
    mutationFn: (kind: "archive" | "transfer") =>
      kind === "archive"
        ? api.archiveProject(metadata.id, {
            expectedRevision: revision,
            archived: !metadata.archivedAt,
          })
        : api.transferProject(metadata.id, {
            expectedRevision: revision,
            newOwnerUserId: owner!.userId,
          }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["doska"] });
      onClose();
    },
  });
  return (
    <>
      <h3>{metadata.name}</h3>
      {
        <section className="doska-management-section">
          <h3>{t("transferOwnership")}</h3>
          <input
            className="pl-ui-input"
            type="search"
            value={search}
            placeholder={t("findEmployee")}
            aria-label={t("findEmployee")}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
          {employees.isPending ? (
            <p role="status">{t("loading")}</p>
          ) : employees.isError ? (
            <p role="alert">
              {t("loadError")}{" "}
              <button
                className="pl-ui-button pl-ui-button-secondary"
                onClick={() => void employees.refetch()}
              >
                {t("retry")}
              </button>
            </p>
          ) : (
            <>
              <div className="doska-employee-options">
                {employees.data.map((employee) => (
                  <button
                    key={employee.userId}
                    aria-pressed={owner?.userId === employee.userId}
                    onClick={() => {
                      setOwner(employee);
                      setConfirm(null);
                    }}
                  >
                    {employee.name}
                  </button>
                ))}
              </div>
              {!employees.data.length && <p>{t("noEmployees")}</p>}
              {(page > 0 || employees.data.length === 20) && (
                <div className="doska-pagination">
                  <button
                    className="pl-ui-button pl-ui-button-secondary"
                    disabled={!page}
                    onClick={() => setPage(page - 1)}
                  >
                    {t("previous")}
                  </button>
                  <button
                    className="pl-ui-button pl-ui-button-secondary"
                    disabled={employees.data.length < 20}
                    onClick={() => setPage(page + 1)}
                  >
                    {t("next")}
                  </button>
                </div>
              )}
            </>
          )}
          {owner && <p>{t("selectedOwner", { name: owner.name })}</p>}
          <button
            className="pl-ui-button pl-ui-button-secondary"
            disabled={!owner || action.isPending}
            onClick={() => setConfirm("transfer")}
          >
            {t("transferOwnership")}
          </button>
        </section>
      }
      <section className="doska-management-section">
        <button
          className={metadata.archivedAt ? undefined : "doska-archive-project"}
          disabled={action.isPending}
          onClick={() => setConfirm("archive")}
        >
          {t(metadata.archivedAt ? "restoreProject" : "archiveProject")}
        </button>
      </section>
      {confirm && (
        <div className="doska-notice" role="alert">
          <p>
            {t(
              confirm === "transfer"
                ? "confirmTransfer"
                : metadata.archivedAt
                  ? "confirmRestoreProject"
                  : "confirmArchiveProject",
              { name: owner?.name },
            )}
          </p>
          <div className="doska-inline-actions">
            <button
              className="pl-ui-button pl-ui-button-secondary"
              disabled={action.isPending}
              onClick={() => action.mutate(confirm)}
            >
              {t("confirm")}
            </button>
            <button
              className="pl-ui-button pl-ui-button-secondary"
              disabled={action.isPending}
              onClick={() => setConfirm(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
      {action.isError && (
        <div role="alert" className="doska-notice doska-error">
          <p>
            {t(
              action.error instanceof ApiError && action.error.status === 409
                ? "projectConflict"
                : "saveError",
            )}
          </p>
          <button
            className="pl-ui-button pl-ui-button-secondary"
            onClick={() => void onReload()}
          >
            {t("reloadProject")}
          </button>
        </div>
      )}
    </>
  );
}
