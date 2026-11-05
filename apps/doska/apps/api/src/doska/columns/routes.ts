import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors } from "../projects/member-schema";
import { projectParams } from "../projects/schema";
import {
  listColumns,
  createColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
} from "./service";
import {
  columnParams,
  createColumnBody,
  updateColumnBody,
  reorderColumnsBody,
  deleteColumnBody,
  columnResponse,
  columnsMutationResponse,
} from "./schema";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/columns",
      operationId: "doskaListColumns",
      tags: ["Doska columns"],
      summary: "Read project columns",
      request: { params: projectParams },
      responses: {
        200: jsonResponse("Columns", z.array(columnResponse)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await listColumns(c.get("userId"), c.req.valid("param").id), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/columns",
      operationId: "doskaCreateColumn",
      tags: ["Doska columns"],
      summary: "Create a column as project owner",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: createColumnBody } },
        },
      },
      responses: {
        201: jsonResponse("Column created", columnsMutationResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await createColumn(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/columns/{columnId}",
      operationId: "doskaUpdateColumn",
      tags: ["Doska columns"],
      summary: "Update a column as project owner",
      request: {
        params: columnParams,
        body: {
          required: true,
          content: { "application/json": { schema: updateColumnBody } },
        },
      },
      responses: {
        200: jsonResponse("Column updated", columnsMutationResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updateColumn(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").columnId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/columns/reorder",
      operationId: "doskaReorderColumns",
      tags: ["Doska columns"],
      summary: "Reorder project columns",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: reorderColumnsBody } },
        },
      },
      responses: {
        200: jsonResponse("Columns reordered", columnsMutationResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await reorderColumns(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/columns/{columnId}",
      operationId: "doskaDeleteColumn",
      tags: ["Doska columns"],
      summary: "Delete a column and move its tasks",
      request: {
        params: columnParams,
        body: {
          required: true,
          content: { "application/json": { schema: deleteColumnBody } },
        },
      },
      responses: {
        200: jsonResponse("Column deleted", columnsMutationResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await deleteColumn(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").columnId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
export default routes;
