import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import type { Transaction } from "../projects/transaction";
import { taskLabelsPatchSchema, labelInputSchema } from "./schema";
export type TaskLabel = { name: string; color: string };
export async function listTaskLabels(tx: Transaction, taskIds: string[]) {
  const result = new Map<string, TaskLabel[]>();
  if (!taskIds.length) return result;
  const rows = await tx
    .select({
      taskId: labelTable.taskId,
      name: labelTable.name,
      color: labelTable.color,
    })
    .from(labelTable)
    .where(
      and(
        inArray(labelTable.taskId, taskIds),
        isNull(labelTable.deletionStartedAt),
      ),
    )
    .orderBy(asc(labelTable.name));
  for (const { taskId, ...label } of rows) {
    if (!taskId) continue;
    const labels = result.get(taskId) ?? [];
    labels.push(label);
    result.set(taskId, labels);
  }
  return result;
}
export async function prepareTaskLabels(
  tx: Transaction,
  taskId: string | undefined,
  input: TaskLabel[] | undefined,
) {
  const before = taskId
    ? ((await listTaskLabels(tx, [taskId])).get(taskId) ?? [])
    : [];
  if (input === undefined) return { before, after: before, changed: false };
  const parsed = taskLabelsPatchSchema.safeParse(input);
  if (!parsed.success)
    throw new HTTPException(400, {
      message:
        "Проверьте метки: до 20 меток, название до 100 символов, цвет из палитры",
    });
  const normalized = parsed.data.map((label) => {
    const strict = labelInputSchema.safeParse(label);
    if (strict.success) return strict.data;
    if (
      before.some((old) => old.name === label.name && old.color === label.color)
    )
      return label;
    throw new HTTPException(400, { message: "Выберите цвет метки из палитры" });
  });
  const after = normalized.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const sorted = [...before].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    before,
    after,
    changed: JSON.stringify(sorted) !== JSON.stringify(after),
  };
}
export async function applyTaskLabels(
  tx: Transaction,
  taskId: string,
  after: TaskLabel[],
) {
  // Preserve unchanged row identities; workspace-wide label definitions are never touched.
  const [project] = await tx
    .select({ workspaceId: projectTable.workspaceId })
    .from(taskTable)
    .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(eq(taskTable.id, taskId));
  if (!project) throw new HTTPException(404, { message: "Task not found" });
  const rows = await tx
    .select()
    .from(labelTable)
    .where(eq(labelTable.taskId, taskId));
  const wanted = new Map(after.map((label) => [label.name, label.color]));
  for (const row of rows) {
    if (!wanted.has(row.name))
      await tx.delete(labelTable).where(eq(labelTable.id, row.id));
  }
  for (const label of after) {
    const current = rows.find((row) => row.name === label.name);
    if (current) {
      if (current.color !== label.color || current.deletionStartedAt)
        await tx
          .update(labelTable)
          .set({ color: label.color, deletionStartedAt: null })
          .where(eq(labelTable.id, current.id));
    } else
      await tx
        .insert(labelTable)
        .values({ taskId, workspaceId: project.workspaceId, ...label });
  }
}
