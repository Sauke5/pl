import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { useMemberAction } from "./member-action";
import { MemberPagination, membersPageSize } from "./member-pagination";

export function DoskaMemberRequests({ projectId }: { projectId: string }) {
  const { t } = useTranslation("doska");
  const [offset, setOffset] = useState(0);
  const requests = useQuery({
    queryKey: ["doska", "join-requests", projectId, offset],
    queryFn: () =>
      api.listJoinRequests(projectId, { limit: membersPageSize, offset }),
  });
  const action = useMemberAction();
  return (
    <section className="doska-members-section">
      <h3>{t("membersRequests")}</h3>
      {requests.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : requests.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void requests.refetch()}>{t("retry")}</button>
        </div>
      ) : requests.data.length === 0 ? (
        <p>{t("membersNoRequests")}</p>
      ) : (
        <ul className="doska-member-list">
          {requests.data.map((request) => (
            <li key={request.id}>
              <strong>
                {request.applicantName ?? t("membersUnknownEmployee")}
              </strong>
              <div className="doska-member-actions">
                <button
                  className="doska-primary"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(() =>
                      api.resolveJoinRequest(projectId, request.id, {
                        approve: true,
                      }),
                    )
                  }
                >
                  {t("membersApprove")}
                </button>
                <button
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(() =>
                      api.resolveJoinRequest(projectId, request.id, {
                        approve: false,
                      }),
                    )
                  }
                >
                  {t("membersReject")}
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
      <MemberPagination
        offset={offset}
        count={requests.data?.length ?? 0}
        pending={requests.isFetching}
        onPage={setOffset}
      />
    </section>
  );
}
