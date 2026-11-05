import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors, pageQuery } from "../projects/member-schema";
import { taskParams, deleteTaskBody } from "./schema";
import {
  createTaskRelation,
  deleteTaskRelation,
  listTaskRelations,
} from "./relations";
const type = z.enum(["related", "blocks", "duplicate"]);
const relationParams = taskParams.extend({
  relationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const createBody = deleteTaskBody.extend({
  targetTaskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  type,
});
const response = z.strictObject({
  id: z.string(),
  type,
  direction: z.enum(["outgoing", "incoming", "symmetric"]),
  task: z.strictObject({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    number: z.number().nullable(),
  }),
});
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/relations",
      operationId: "doskaListTaskRelations",
      tags: ["Doska tasks"],
      summary: "Read visible task relations",
      request: { params: taskParams, query: pageQuery },
      responses: {
        200: jsonResponse("Relations", z.array(response)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listTaskRelations(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("query"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/relations",
      operationId: "doskaCreateTaskRelation",
      tags: ["Doska tasks"],
      summary: "Link two tasks",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: createBody } },
        },
      },
      responses: {
        201: jsonResponse("Relation created", response),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await createTaskRelation(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/relations/{relationId}",
      operationId: "doskaDeleteTaskRelation",
      tags: ["Doska tasks"],
      summary: "Remove a task relation",
      request: {
        params: relationParams,
        body: {
          required: true,
          content: { "application/json": { schema: deleteTaskBody } },
        },
      },
      responses: {
        200: jsonResponse(
          "Relation removed",
          z.strictObject({ id: z.string() }),
        ),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await deleteTaskRelation(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("param").relationId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
export default routes;
