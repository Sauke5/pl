import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export function useMemberAction() {
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey: ["doska"] });
    },
  });
  const errorKey =
    mutation.error instanceof ApiError && mutation.error.status === 409
      ? "membersConflict"
      : mutation.error instanceof ApiError &&
          [403, 404].includes(mutation.error.status)
        ? "membersAccessChanged"
        : "membersSaveError";
  return { ...mutation, errorKey };
}
