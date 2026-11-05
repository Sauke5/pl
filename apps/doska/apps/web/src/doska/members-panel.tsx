import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaMemberJoin } from "./member-join";
import { DoskaMemberRoster } from "./member-roster";
import { DoskaMemberInvitations } from "./member-invitations";
import { DoskaMemberRequests } from "./member-requests";
import "./members.css";

export function DoskaMembersPanel({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("doska");
  const ref = useRef<HTMLDialogElement>(null);
  const access = useQuery({
    queryKey: ["doska", "access", projectId],
    queryFn: () => api.getAccess(projectId),
  });
  const project = useQuery({
    queryKey: ["doska", "project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const manage = Boolean(
    access.data?.manageParticipants &&
    project.data &&
    !project.data.archivedAt &&
    !access.isError &&
    !project.isError,
  );
  return (
    <dialog
      ref={ref}
      className="doska-dialog doska-members"
      aria-labelledby="doska-members-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="doska-members-heading">
        <h2 id="doska-members-title">{t("membersTitle")}</h2>
        <button
          className="doska-icon"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {access.isError || project.isError ? (
        <div role="alert" className="doska-notice doska-error">
          <p>{t("loadError")}</p>
          <button
            onClick={() => {
              void access.refetch();
              void project.refetch();
            }}
          >
            {t("retry")}
          </button>
        </div>
      ) : access.isPending || project.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          <DoskaMemberJoin project={project.data} access={access.data} />
          <DoskaMemberRoster projectId={projectId} canManage={manage} />
          {manage && (
            <>
              <DoskaMemberInvitations projectId={projectId} />
              <DoskaMemberRequests projectId={projectId} />
            </>
          )}
        </>
      )}
    </dialog>
  );
}
