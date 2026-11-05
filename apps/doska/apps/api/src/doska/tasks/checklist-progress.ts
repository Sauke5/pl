import { asc, eq, inArray, sql } from "drizzle-orm";
import { checklistItemTable, checklistTable } from "../../database/schema";
import type { Transaction } from "../projects/transaction";

type PreviewItem = {
  id: string;
  checklistId: string;
  text: string;
  done: boolean;
};
type ChecklistGroup = {
  id: string;
  title: string;
  total: number;
  done: number;
  preview: PreviewItem[];
};
type ChecklistSummary = {
  total: number;
  done: number;
  preview: PreviewItem[];
  groups: ChecklistGroup[];
};

/** Call only with task IDs already filtered by the caller's content ACL. */
export async function checklistProgress(tx: Transaction, taskIds: string[]) {
  if (!taskIds.length) return new Map<string, ChecklistSummary>();
  const ranked = tx
    .select({
      taskId: checklistTable.taskId,
      id: checklistItemTable.id,
      title: checklistTable.title,
      position: checklistTable.position,
      checklistId: sql<string>`${checklistTable.id}`.as("checklist_id"),
      text: checklistItemTable.text,
      done: checklistItemTable.done,
      rank: sql<number>`row_number() over (partition by ${checklistTable.id} order by ${checklistTable.position}, ${checklistTable.id}, ${checklistItemTable.position}, ${checklistItemTable.id})`.as(
        "item_rank",
      ),
    })
    .from(checklistTable)
    .leftJoin(
      checklistItemTable,
      eq(checklistItemTable.checklistId, checklistTable.id),
    )
    .where(inArray(checklistTable.taskId, taskIds))
    .as("ranked_checklist_items");
  const rows = await tx
    .select({
      taskId: ranked.taskId,
      checklistId: ranked.checklistId,
      title: ranked.title,
      position: ranked.position,
      total: sql<number>`count(${ranked.id})::integer`,
      done: sql<number>`count(*) filter (where ${ranked.done})::integer`,
      preview: sql<
        PreviewItem[]
      >`jsonb_agg(jsonb_build_object('id', ${ranked.id}, 'checklistId', ${ranked.checklistId}, 'text', ${ranked.text}, 'done', ${ranked.done}) order by ${ranked.rank}) filter (where ${ranked.rank} <= 4 and ${ranked.id} is not null)`,
    })
    .from(ranked)
    .groupBy(ranked.taskId, ranked.checklistId, ranked.title, ranked.position)
    .orderBy(asc(ranked.position), asc(ranked.checklistId));
  const result = new Map<string, ChecklistSummary>();
  for (const row of rows) {
    const summary = result.get(row.taskId) ?? {
      total: 0,
      done: 0,
      preview: [],
      groups: [],
    };
    const preview = row.preview ?? [];
    summary.total += row.total;
    summary.done += row.done;
    summary.preview = [...summary.preview, ...preview].slice(0, 4);
    summary.groups.push({
      id: row.checklistId,
      title: row.title,
      total: row.total,
      done: row.done,
      preview,
    });
    result.set(row.taskId, summary);
  }
  return result;
}
