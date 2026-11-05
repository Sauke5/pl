import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { useMemberAction } from "./member-action";
import { MemberPagination, membersPageSize } from "./member-pagination";
import "./members.css";

export function DoskaInvitationInbox() {
  const { t } = useTranslation("doska");
  const [offset, setOffset] = useState(0);
  const invitations = useQuery({
    queryKey: ["doska", "invitations", offset],
    queryFn: () => api.listMyInvitations({ limit: membersPageSize, offset }),
  });
  const action = useMemberAction();
  return (
    <>
      <div className="doska-page-heading">
        <h1>{t("membersInvitations")}</h1>
      </div>
      <section className="doska-panel">
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
          <p>{t("membersInboxEmpty")}</p>
        ) : (
          <ul className="doska-member-list">
            {invitations.data.map((invitation) => (
              <li key={invitation.id}>
                <div>
                  <strong>{invitation.projectName}</strong>
                  {invitation.projectArchivedAt && (
                    <span className="doska-meta">{t("archived")}</span>
                  )}
                  <span className="doska-meta">
                    {invitation.role === "participant"
                      ? t("membersParticipant")
                      : t("membersObserver")}
                  </span>
                </div>
                <div className="doska-member-actions">
                  <button
                    className="doska-primary"
                    disabled={
                      action.isPending || Boolean(invitation.projectArchivedAt)
                    }
                    onClick={() =>
                      action.mutate(() =>
                        api.respondInvitation(
                          invitation.projectId,
                          invitation.id,
                          { accept: true },
                        ),
                      )
                    }
                  >
                    {t("membersAccept")}
                  </button>
                  <button
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate(() =>
                        api.respondInvitation(
                          invitation.projectId,
                          invitation.id,
                          { accept: false },
                        ),
                      )
                    }
                  >
                    {t("membersDecline")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {action.isError && (
          <p role="alert" className="doska-notice doska-error">
            {t(action.errorKey)}
          </p>
        )}
        {action.isSuccess && <p role="status">{t("membersResponseSaved")}</p>}
        <MemberPagination
          offset={offset}
          count={invitations.data?.length ?? 0}
          pending={invitations.isFetching}
          onPage={setOffset}
        />
      </section>
    </>
  );
}
