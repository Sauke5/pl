import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type Project, type Capabilities } from "./api";
import { useDoskaSession } from "./session";
import { useMemberAction } from "./member-action";

export function DoskaMemberJoin({
  project,
  access,
}: {
  project: Project;
  access: Capabilities;
}) {
  const { t } = useTranslation("doska");
  const { context } = useDoskaSession();
  const eligibleProject = Boolean(
    access.readContent &&
    !access.workOnTasks &&
    !project.archivedAt &&
    project.visibility === "department" &&
    context.departmentId &&
    context.departmentId === project.departmentId,
  );
  const roster = useQuery({
    queryKey: ["doska", "members", project.id],
    queryFn: () => api.listMembers(project.id),
    enabled: eligibleProject,
  });
  const canRequest = Boolean(
    eligibleProject &&
    roster.data &&
    !roster.isError &&
    roster.data.owner.userId !== context.user.id &&
    !roster.data.members.some((member) => member.userId === context.user.id),
  );
  const requests = useQuery({
    queryKey: ["doska", "own-join-requests", project.id],
    queryFn: () => api.listJoinRequests(project.id, { limit: 1, offset: 0 }),
    enabled: canRequest,
  });
  const action = useMemberAction();
  if (!eligibleProject) return null;
  if (roster.isError || (canRequest && requests.isError))
    return (
      <div role="alert">
        <p>{t("loadError")}</p>
        <button
          onClick={() => {
            void roster.refetch();
            if (canRequest) void requests.refetch();
          }}
        >
          {t("retry")}
        </button>
      </div>
    );
  if (roster.isPending || (canRequest && requests.isPending))
    return <p role="status">{t("loading")}</p>;
  if (!canRequest) return null;
  const pending = requests.data?.find(
    (request) =>
      request.applicantUserId === context.user.id &&
      request.status === "pending",
  );
  return (
    <section className="doska-members-section">
      {pending ? (
        <div className="doska-member-actions">
          <span>{t("membersJoinPending")}</span>
          <button
            disabled={action.isPending}
            onClick={() =>
              action.mutate(() => api.cancelJoinRequest(project.id, pending.id))
            }
          >
            {t("membersCancelRequest")}
          </button>
        </div>
      ) : (
        <button
          className="doska-primary"
          disabled={action.isPending}
          onClick={() => action.mutate(() => api.createJoinRequest(project.id))}
        >
          {t("membersRequestJoin")}
        </button>
      )}
      {action.isError && (
        <p role="alert" className="doska-notice doska-error">
          {t(action.errorKey)}
        </p>
      )}
    </section>
  );
}
