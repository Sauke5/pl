import { z } from "../../openapi";
import { createTaskBody } from "../tasks/schema";

export const taskImportBody = z.strictObject({
  clientRequestId: z.string().uuid(),
  tasks: z.array(createTaskBody).min(1).max(500),
});
export const taskImportResponse = z.strictObject({
  taskIds: z.array(z.string()).min(1).max(500),
  imported: z.number().int().min(1).max(500),
  replayed: z.boolean(),
});
export type TaskImportInput = z.infer<typeof taskImportBody>;
