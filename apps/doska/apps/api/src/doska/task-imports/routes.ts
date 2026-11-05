import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../../errors/api-error";
import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors } from "../projects/member-schema";
import { projectParams } from "../projects/schema";
import { taskImportBody, taskImportResponse } from "./schema";
import { importTasks } from "./service";
const router = apiRouter();
router.use(
  "/projects/:id/task-imports",
  bodyLimit({
    maxSize: 3_145_728,
    onError: () => {
      throw new ApiError(413, {
        code: "PAYLOAD_TOO_LARGE",
        message: "Task import exceeds 3 MiB",
      });
    },
  }),
);
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
export default router.openapi(
  createRoute({
    method: "post",
    path: "/projects/{id}/task-imports",
    operationId: "doskaImportTasks",
    tags: ["Doska tasks"],
    summary: "Import tasks atomically with durable retry protection",
    request: {
      params: projectParams,
      body: {
        required: true,
        content: { "application/json": { schema: taskImportBody } },
      },
    },
    responses: {
      201: jsonResponse(
        "Tasks imported or previous import replayed",
        taskImportResponse,
      ),
      ...memberErrors,
      413: errorResponse("Import exceeds 3 MiB"),
    },
  }),
  async (c) =>
    c.json(
      await importTasks(
        c.get("userId"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
      201,
    ),
);
