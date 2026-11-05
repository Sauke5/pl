import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type EmployeeOption } from "./api";
import { useMemberAction } from "./member-action";
import { MemberPagination, membersPageSize } from "./member-pagination";

export function DoskaMemberInviteForm({ projectId }: { projectId: string }) {
  const { t } = useTranslation("doska");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<EmployeeOption | null>(null);
  const [role, setRole] = useState<"participant" | "observer">("participant");
  const action = useMemberAction();
  const employees = useQuery({
    queryKey: [
      "doska",
      "employee-options",
      projectId,
      "invitation",
      search.trim(),
      offset,
    ],
    queryFn: () =>
      api.employeeOptions(projectId, {
        purpose: "invitation",
        q: search.trim(),
        limit: membersPageSize,
        offset,
      }),
    enabled: Boolean(search.trim()) && !selected,
  });
  return (
    <form
      className="doska-member-invite"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected) return;
        action.mutate(
          () =>
            api.createInvitation(projectId, {
              inviteeUserId: selected.userId,
              role,
            }),
          {
            onSuccess: () => {
              setSelected(null);
              setSearch("");
              setOffset(0);
            },
          },
        );
      }}
    >
      <label className="doska-field">
        {t("membersEmployeeSearch")}
        <input
          type="search"
          value={search}
          disabled={action.isPending}
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected(null);
            setOffset(0);
            action.reset();
          }}
        />
      </label>
      {search.trim() && !selected && (
        <div>
          {employees.isPending ? (
            <p role="status">{t("loading")}</p>
          ) : employees.isError ? (
            <div role="alert">
              <p>{t("membersSearchError")}</p>
              <button type="button" onClick={() => void employees.refetch()}>
                {t("retry")}
              </button>
            </div>
          ) : (
            <>
              {employees.data.length === 0 ? (
                <p>{t("membersNoEmployees")}</p>
              ) : (
                <ul className="doska-member-list doska-employee-options">
                  {employees.data.map((employee) => (
                    <li key={employee.userId}>
                      <button
                        type="button"
                        onClick={() => setSelected(employee)}
                      >
                        {employee.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <MemberPagination
                offset={offset}
                count={employees.data.length}
                pending={employees.isFetching}
                onPage={setOffset}
              />
            </>
          )}
        </div>
      )}
      {selected && (
        <div className="doska-member-selected">
          <strong>{selected.name}</strong>
          <button type="button" onClick={() => setSelected(null)}>
            {t("membersChooseAnother")}
          </button>
        </div>
      )}
      <div className="doska-member-actions">
        <label>
          {t("membersRole")}
          <select
            value={role}
            disabled={action.isPending}
            onChange={(event) =>
              setRole(event.target.value as "participant" | "observer")
            }
          >
            <option value="participant">{t("membersParticipant")}</option>
            <option value="observer">{t("membersObserver")}</option>
          </select>
        </label>
        <button
          type="submit"
          className="doska-primary"
          disabled={!selected || action.isPending}
        >
          {action.isPending ? t("saving") : t("membersInvite")}
        </button>
      </div>
      {action.isError && (
        <p role="alert" className="doska-notice doska-error">
          {t(action.errorKey)}
        </p>
      )}
      {action.isSuccess && <p role="status">{t("membersInvitationSent")}</p>}
    </form>
  );
}
