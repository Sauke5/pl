import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { emptyBody, memberErrors } from "../projects/member-schema";
import { projectParams } from "../projects/schema";
import { notificationPage, notificationQuery } from "./schema";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "./preferences";
import {
  listTaskNotificationPage,
  countUnreadTaskNotifications,
  markTaskNotificationRead,
  markAllTaskNotificationsRead,
} from "./inbox";
const count = z.strictObject({ count: z.number().int().nonnegative() });
const preferences = z.strictObject({ dueDateReminderEnabled: z.boolean() });
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const body = {
  required: true,
  content: { "application/json": { schema: emptyBody } },
};
export default router
  .openapi(
    createRoute({
      method: "get",
      path: "/notifications/preferences",
      operationId: "doskaNotificationPreferences",
      tags: ["Doska notifications"],
      summary: "Read own reminder preference",
      responses: {
        200: jsonResponse("Preferences", preferences),
        ...memberErrors,
      },
    }),
    async (c) => c.json(await getNotificationPreferences(c.get("userId")), 200),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/notifications/preferences",
      operationId: "doskaUpdateNotificationPreferences",
      tags: ["Doska notifications"],
      summary: "Update own reminder preference",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: preferences } },
        },
      },
      responses: {
        200: jsonResponse("Preferences", preferences),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updateNotificationPreferences(
          c.get("userId"),
          c.req.valid("json").dueDateReminderEnabled,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/notifications",
      operationId: "doskaListNotifications",
      tags: ["Doska notifications"],
      summary: "List accessible notifications",
      request: { query: notificationQuery },
      responses: {
        200: jsonResponse("Notifications", notificationPage),
        ...memberErrors,
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      return c.json(
        await listTaskNotificationPage(
          c.get("userId"),
          query.limit,
          query.cursor,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/notifications/unread-count",
      operationId: "doskaCountUnreadNotifications",
      tags: ["Doska notifications"],
      summary: "Count accessible unread notifications",
      responses: { 200: jsonResponse("Count", count), ...memberErrors },
    }),
    async (c) =>
      c.json(
        { count: await countUnreadTaskNotifications(c.get("userId")) },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/notifications/{id}/read",
      operationId: "doskaReadNotification",
      tags: ["Doska notifications"],
      summary: "Mark notification read",
      request: { params: projectParams, body },
      responses: {
        200: jsonResponse("Read", z.strictObject({ id: z.string() })),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await markTaskNotificationRead(
          c.get("userId"),
          c.req.valid("param").id,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/notifications/read-all",
      operationId: "doskaReadAllNotifications",
      tags: ["Doska notifications"],
      summary: "Mark accessible notifications read",
      request: { body },
      responses: { 200: jsonResponse("Marked read", count), ...memberErrors },
    }),
    async (c) =>
      c.json(await markAllTaskNotificationsRead(c.get("userId")), 200),
  );
