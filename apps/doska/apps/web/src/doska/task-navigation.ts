export type MyTasksContext = {
  page: number;
  archived: boolean;
  scrollY: number;
};

export function readMyTasksContext(state: unknown): MyTasksContext | null {
  const context = (state as { doskaMyTasks?: MyTasksContext } | null)
    ?.doskaMyTasks;
  if (
    !context ||
    !Number.isSafeInteger(context.page) ||
    context.page < 0 ||
    typeof context.archived !== "boolean" ||
    !Number.isFinite(context.scrollY) ||
    context.scrollY < 0
  )
    return null;
  return context;
}
