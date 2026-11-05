import { sql } from "drizzle-orm";
import { columnTable, taskTable } from "../../database/schema";
export const unfinishedTask = sql`COALESCE(${columnTable.semanticState}, 'planned') <> 'completed'`;
export const overdueTask = sql`(${taskTable.dueDate} IS NOT NULL AND ${unfinishedTask} AND (
  (${taskTable.dueDateHasTime}=true AND ${taskTable.dueDate} < (statement_timestamp() AT TIME ZONE 'UTC')) OR
  (${taskTable.dueDateHasTime}=false AND (${taskTable.dueDate} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date < (statement_timestamp() AT TIME ZONE 'Europe/Moscow')::date)
))`;
export const upcomingTask = sql`(${taskTable.dueDate} IS NOT NULL AND ${unfinishedTask} AND NOT ${overdueTask}
  AND (${taskTable.dueDate} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date < (statement_timestamp() AT TIME ZONE 'Europe/Moscow')::date + 7)`;
