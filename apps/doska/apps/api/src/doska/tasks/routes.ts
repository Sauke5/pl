import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors, pageQuery } from "../projects/member-schema";
import { projectParams } from "../projects/schema";
import { createTask, updateTask } from "./service";
import { archiveTask, deleteTask } from "./lifecycle";
import { getTask, listTasks, getTaskHistory } from "./read";
import {
  createTaskBody,
  updateTaskBody,
  archiveTaskBody,
  deleteTaskBody,
  taskParams,
  taskListQuery,
  taskInput,
  taskResponse,
  taskHistoryItem,
} from "./schema";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks",
      operationId: "doskaCreateTask",
      tags: ["Doska tasks"],
      summary: "Create a task",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: createTaskBody } },
        },
      },
      responses: {
        201: jsonResponse("Task created", taskResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await createTask(
          c.get("userId"),
          c.req.valid("param").id,
          taskInput(c.req.valid("json")),
        ),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks",
      operationId: "doskaListTasks",
      tags: ["Doska tasks"],
      summary: "List project tasks",
      request: { params: projectParams, query: taskListQuery },
      responses: {
        200: jsonResponse("Tasks", z.array(taskResponse)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listTasks(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}",
      operationId: "doskaGetTask",
      tags: ["Doska tasks"],
      summary: "Read a task",
      request: { params: taskParams },
      responses: { 200: jsonResponse("Task", taskResponse), ...memberErrors },
    }),
    async (c) =>
      c.json(
        await getTask(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/tasks/{taskId}",
      operationId: "doskaUpdateTask",
      tags: ["Doska tasks"],
      summary: "Update a task",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: updateTaskBody } },
        },
      },
      responses: {
        200: jsonResponse("Task updated", taskResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updateTask(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          taskInput(c.req.valid("json")),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/archive",
      operationId: "doskaArchiveTask",
      tags: ["Doska tasks"],
      summary: "Archive or restore a task",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: archiveTaskBody } },
        },
      },
      responses: {
        200: jsonResponse("Task updated", taskResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await archiveTask(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}",
      operationId: "doskaDeleteTask",
      tags: ["Doska tasks"],
      summary: "Permanently delete a task as project owner",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: deleteTaskBody } },
        },
      },
      responses: {
        200: jsonResponse("Task deleted", z.strictObject({ id: z.string() })),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await deleteTask(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/history",
      operationId: "doskaTaskHistory",
      tags: ["Doska tasks"],
      summary: "Read task history",
      request: { params: taskParams, query: pageQuery },
      responses: {
        200: jsonResponse("History", z.array(taskHistoryItem)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await getTaskHistory(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").taskId,
          c.req.valid("query"),
        ),
        200,
      ),
  );
export default routes;
