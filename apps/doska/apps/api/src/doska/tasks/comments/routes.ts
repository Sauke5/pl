import { apiRouter, createRoute, jsonResponse } from "../../../openapi";
import { isDoskaIntegrated } from "../../mode";
import { memberErrors, pageQuery } from "../../projects/member-schema";
import { taskParams } from "../schema";
import { z } from "../../../openapi";
import {
  commentParams,
  commentSchema,
  createCommentBody,
  updateCommentBody,
  deleteCommentBody,
} from "./schema";
import {
  listTaskComments,
  createTaskComment,
  updateTaskComment,
  deleteTaskComment,
} from "./service";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/comments",
      operationId: "doskaListTaskComments",
      tags: ["Doska tasks"],
      summary: "Read task comments",
      request: { params: taskParams, query: pageQuery },
      responses: {
        200: jsonResponse("Comments", z.array(commentSchema)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listTaskComments(
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
      path: "/projects/{id}/tasks/{taskId}/comments",
      operationId: "doskaCreateTaskComment",
      tags: ["Doska tasks"],
      summary: "Create a task comment",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: createCommentBody } },
        },
      },
      responses: {
        201: jsonResponse("Comment", commentSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await createTaskComment(
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
      method: "patch",
      path: "/projects/{id}/tasks/{taskId}/comments/{commentId}",
      operationId: "doskaUpdateTaskComment",
      tags: ["Doska tasks"],
      summary: "Update a task comment",
      request: {
        params: commentParams,
        body: {
          required: true,
          content: { "application/json": { schema: updateCommentBody } },
        },
      },
      responses: {
        200: jsonResponse("Comment", commentSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updateTaskComment(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("param").commentId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/comments/{commentId}",
      operationId: "doskaDeleteTaskComment",
      tags: ["Doska tasks"],
      summary: "Delete a task comment",
      request: {
        params: commentParams,
        body: {
          required: true,
          content: { "application/json": { schema: deleteCommentBody } },
        },
      },
      responses: {
        200: jsonResponse("Comment", commentSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await deleteTaskComment(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("param").commentId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
export default routes;
