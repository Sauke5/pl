import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaMemberInviteForm } from "./member-invite-form";
import { useMemberAction } from "./member-action";
import { MemberPagination, membersPageSize } from "./member-pagination";

export function DoskaMemberInvitations({ projectId }: { projectId: string }) {
  const { t } = useTranslation("doska");
  const [offset, setOffset] = useState(0);
  const invitations = useQuery({
    queryKey: ["doska", "project-invitations", projectId, offset],
    queryFn: () =>
      api.listProjectInvitations(projectId, { limit: membersPageSize, offset }),
  });
  const action = useMemberAction();
  return (
    <section className="doska-members-section">
      <h3>{t("membersInvitations")}</h3>
      <DoskaMemberInviteForm projectId={projectId} />
      {invitations.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : invitations.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void invitations.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : invitations.data.length === 0 ? (
        <p>{t("membersNoInvitations")}</p>
      ) : (
        <ul className="doska-member-list">
          {invitations.data.map((invitation) => (
            <li key={invitation.id}>
              <div>
                <strong>
                  {invitation.inviteeName ?? t("membersUnknownEmployee")}
                </strong>
                <span className="doska-meta">
                  {invitation.role === "participant"
                    ? t("membersParticipant")
                    : t("membersObserver")}
                </span>
              </div>
              <button
                disabled={action.isPending}
                onClick={() =>
                  action.mutate(() =>
                    api.revokeInvitation(projectId, invitation.id),
                  )
                }
              >
                {t("membersRevoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {action.isError && (
        <p role="alert" className="doska-notice doska-error">
          {t(action.errorKey)}
        </p>
      )}
      <MemberPagination
        offset={offset}
        count={invitations.data?.length ?? 0}
        pending={invitations.isFetching}
        onPage={setOffset}
      />
    </section>
  );
}
