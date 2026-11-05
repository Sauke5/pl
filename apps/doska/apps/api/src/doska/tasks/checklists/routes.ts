import { apiRouter, createRoute, jsonResponse } from "../../../openapi";
import { isDoskaIntegrated } from "../../mode";
import { memberErrors } from "../../projects/member-schema";
import { taskParams } from "../schema";
import {
  checklistParams,
  itemParams,
  titleBody,
  itemBody,
  updateItemBody,
  revisionBody,
  orderBody,
  checklistResponse,
} from "./schema";
import { listChecklists, mutateChecklist } from "./service";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/checklists",
      operationId: "doskaListChecklists",
      tags: ["Doska tasks"],
      summary: "Read task checklists",
      request: { params: taskParams },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listChecklists(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/checklists",
      operationId: "doskaCreateChecklist",
      tags: ["Doska tasks"],
      summary: "CreateChecklist",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: titleBody } },
        },
      },
      responses: {
        201: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          { type: "created", title: body.title },
        ),
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/projects/{id}/tasks/{taskId}/checklists/order",
      operationId: "doskaReorderChecklists",
      tags: ["Doska tasks"],
      summary: "ReorderChecklists",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: orderBody } },
        },
      },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          { type: "reordered", ids: body.ids },
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/tasks/{taskId}/checklists/{checklistId}",
      operationId: "doskaRenameChecklist",
      tags: ["Doska tasks"],
      summary: "RenameChecklist",
      request: {
        params: checklistParams,
        body: {
          required: true,
          content: { "application/json": { schema: titleBody } },
        },
      },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          {
            type: "renamed",
            checklistId: params.checklistId,
            title: body.title,
          },
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/checklists/{checklistId}",
      operationId: "doskaDeleteChecklist",
      tags: ["Doska tasks"],
      summary: "DeleteChecklist",
      request: {
        params: checklistParams,
        body: {
          required: true,
          content: { "application/json": { schema: revisionBody } },
        },
      },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          { type: "deleted", checklistId: params.checklistId },
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/checklists/{checklistId}/items",
      operationId: "doskaCreateChecklistItem",
      tags: ["Doska tasks"],
      summary: "CreateChecklistItem",
      request: {
        params: checklistParams,
        body: {
          required: true,
          content: { "application/json": { schema: itemBody } },
        },
      },
      responses: {
        201: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          {
            type: "item.created",
            checklistId: params.checklistId,
            text: body.text,
          },
        ),
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/projects/{id}/tasks/{taskId}/checklists/{checklistId}/items/order",
      operationId: "doskaReorderChecklistItems",
      tags: ["Doska tasks"],
      summary: "ReorderChecklistItems",
      request: {
        params: checklistParams,
        body: {
          required: true,
          content: { "application/json": { schema: orderBody } },
        },
      },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          {
            type: "items.reordered",
            checklistId: params.checklistId,
            ids: body.ids,
          },
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/tasks/{taskId}/checklists/{checklistId}/items/{itemId}",
      operationId: "doskaUpdateChecklistItem",
      tags: ["Doska tasks"],
      summary: "UpdateChecklistItem",
      request: {
        params: itemParams,
        body: {
          required: true,
          content: { "application/json": { schema: updateItemBody } },
        },
      },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          {
            type: "item.updated",
            checklistId: params.checklistId,
            itemId: params.itemId,
            text: body.text,
            done: body.done,
          },
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/checklists/{checklistId}/items/{itemId}",
      operationId: "doskaDeleteChecklistItem",
      tags: ["Doska tasks"],
      summary: "DeleteChecklistItem",
      request: {
        params: itemParams,
        body: {
          required: true,
          content: { "application/json": { schema: revisionBody } },
        },
      },
      responses: {
        200: jsonResponse("Checklists", checklistResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const params = c.req.valid("param"),
        body = c.req.valid("json");
      return c.json(
        await mutateChecklist(
          c.get("userId"),
          params.id,
          params.taskId,
          body.expectedRevision,
          {
            type: "item.deleted",
            checklistId: params.checklistId,
            itemId: params.itemId,
          },
        ),
        200,
      );
    },
  );
export default routes;
