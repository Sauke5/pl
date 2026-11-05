import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "./api";
export function DoskaTemplateSelection({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const key = ["doska", "template-selection", projectId];
  const selection = useQuery({
    queryKey: key,
    queryFn: () => api.getTemplateSelection(projectId),
    retry: false,
  });
  const current = selection.data?.find((row) => row.taskId === taskId);
  const mutation = useMutation({
    mutationFn: (selected: boolean) =>
      api.setTemplateSelection(projectId, taskId, {
        selected,
        expectedRevision: current?.revision ?? 0,
      }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: key });
    },
  });
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  return (
    <div className="doska-template-selection">
      <label>
        <input
          type="checkbox"
          checked={current?.selected ?? false}
          disabled={
            !selection.isSuccess ||
            selection.isError ||
            mutation.isPending ||
            conflict
          }
          onChange={(event) => mutation.mutate(event.target.checked)}
        />
        {t("templateSelectTask")}
      </label>
      {(selection.isError || mutation.isError) && (
        <p role="alert" className="doska-error">
          {t(conflict ? "templateSelectionConflict" : "saveError")}{" "}
          <button
            type="button"
            onClick={async () => {
              await selection.refetch();
              mutation.reset();
            }}
          >
            {t("refresh")}
          </button>
        </p>
      )}
    </div>
  );
}
