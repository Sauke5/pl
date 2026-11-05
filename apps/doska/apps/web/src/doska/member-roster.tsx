import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type MemberRoster } from "./api";
import { useMemberAction } from "./member-action";
import { MemberPagination, membersPageSize } from "./member-pagination";

export function DoskaMemberRoster({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation("doska");
  const [offset, setOffset] = useState(0);
  const roster = useQuery({
    queryKey: ["doska", "member-page", projectId, offset],
    queryFn: () =>
      api.listMemberPage(projectId, { limit: membersPageSize, offset }),
  });
  const action = useMemberAction();
  const change = (member: MemberRoster["members"][number], remove = false) => {
    const role = member.role === "participant" ? "observer" : "participant";
    const key = remove
      ? "membersConfirmRemove"
      : role === "observer"
        ? "membersConfirmDemote"
        : "membersConfirmPromote";
    if (!canManage || !window.confirm(t(key, { name: member.name }))) return;
    action.mutate(() =>
      remove
        ? api.removeMember(projectId, member.id, { expectedRole: member.role })
        : api.changeMember(projectId, member.id, {
            expectedRole: member.role,
            role,
          }),
    );
  };
  return (
    <section className="doska-members-section" aria-label={t("membersTitle")}>
      {roster.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void roster.refetch()}>{t("retry")}</button>
        </div>
      ) : roster.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <ul className="doska-member-list">
          <li>
            <div>
              <strong>{roster.data.owner.name}</strong>
              <span className="doska-meta">{t("membersOwner")}</span>
            </div>
          </li>
          {roster.data.members
            .filter((member) => member.userId !== roster.data.owner.userId)
            .map((member) => (
              <li key={member.id}>
                <div>
                  <strong>{member.name}</strong>
                  <span className="doska-meta">
                    {member.role === "participant"
                      ? t("membersParticipant")
                      : t("membersObserver")}
                  </span>
                </div>
                {canManage && (
                  <div className="doska-member-actions">
                    <button
                      disabled={action.isPending}
                      onClick={() => change(member)}
                    >
                      {member.role === "participant"
                        ? t("membersMakeObserver")
                        : t("membersMakeParticipant")}
                    </button>
                    <button
                      disabled={action.isPending}
                      onClick={() => change(member, true)}
                    >
                      {t("membersRemove")}
                    </button>
                  </div>
                )}
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
        count={roster.data?.members.length ?? 0}
        pending={roster.isFetching}
        onPage={setOffset}
      />
    </section>
  );
}
