import type { CardColor } from "./card-color";
export type CreateTaskInput = {
  labels?: { name: string; color: string }[];
  customValues?: { fieldId: string; value: string | null }[];
  title: string;
  cardColor?: CardColor | null;
  parentTaskId?: string | null;
  description?: string | null;
  columnId?: string;
  userId?: string | null;
  coexecutorIds?: string[];
  priority?: "no-priority" | "low" | "medium" | "high" | "urgent";
  startDate?: Date | null;
  dueDate?: Date | null;
  dueDateHasTime?: boolean;
};
export type UpdateTaskInput = Partial<CreateTaskInput> & {
  expectedRevision: number;
  beforeTaskId?: string | null;
  confirmIncompleteSubtasks?: boolean;
};
