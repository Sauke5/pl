import { HTTPException } from "hono/http-exception";
import {
  apiRouter,
  createRoute,
  jsonResponse,
  z,
  type BaseVariables,
} from "../openapi";
import { isDoskaIntegrated } from "./mode";
import { getProjectCapabilities } from "./project-access";
import { memberErrors, projectParams } from "./projects/member-schema";
import { getContentProject } from "./projects/list";
import { projectListItem } from "./projects/discovery-schema";
import { getCreationContext } from "./projects/service";
import { listMyTasks } from "./tasks/my-tasks";
import { searchTasks } from "./tasks/search";
import { taskSearchQuery } from "./tasks/search-schema";
import { taskListQuery, taskResponse } from "./tasks/schema";

const contextResponse = z.strictObject({
  mode: z.literal("platform"),
  user: z.strictObject({ id: z.string(), name: z.string() }),
  csrfToken: z.string(),
  workspaceId: z.string(),
  canCreateProject: z.boolean(),
  departmentId: z.string().nullable(),
});
const capabilitiesResponse = z.strictObject({
  readContent: z.boolean(),
  workOnTasks: z.boolean(),
  manageSettings: z.boolean(),
  manageParticipants: z.boolean(),
  deleteTask: z.boolean(),
  transferOwnership: z.boolean(),
  archiveProject: z.boolean(),
  readManagementMetadata: z.boolean(),
});
const myTaskResponse = taskResponse.extend({
  columnName: z.string().nullable(),
  columnState: z.enum(["planned", "active", "completed"]).nullable(),
  projectName: z.string(),
  projectSlug: z.string(),
  assigneeName: z.string().nullable(),
});
const router = apiRouter<
  BaseVariables & { doskaIdentity?: { csrfToken: string } }
>();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
export default router
  .openapi(
    createRoute({
      method: "get",
      path: "/task-search",
      operationId: "doskaSearchTasks",
      tags: ["Doska tasks"],
      summary: "Search content-visible tasks and comments",
      request: { query: taskSearchQuery },
      responses: {
        200: jsonResponse("Tasks", z.array(myTaskResponse)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await searchTasks(c.get("userId"), c.req.valid("query")), 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}",
      operationId: "doskaGetProject",
      tags: ["Doska projects"],
      summary: "Read content-visible project metadata",
      request: { params: projectParams },
      responses: {
        200: jsonResponse("Project", projectListItem),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await getContentProject(c.get("userId"), c.req.valid("param").id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/context",
      operationId: "doskaContext",
      tags: ["Doska"],
      summary: "Read current Platform session context",
      responses: {
        200: jsonResponse("Session context", contextResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const identity = c.get("doskaIdentity"),
        user = c.get("user");
      if (!identity || !user)
        throw new HTTPException(401, { message: "Platform identity required" });
      return c.json(
        {
          mode: "platform" as const,
          user: { id: c.get("userId"), name: user.name },
          csrfToken: identity.csrfToken,
          ...(await getCreationContext(c.get("userId"))),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/my-tasks",
      operationId: "doskaMyTasks",
      tags: ["Doska tasks"],
      summary: "List tasks assigned to the current user",
      request: { query: taskListQuery.omit({ parentTaskId: true }) },
      responses: {
        200: jsonResponse("Assigned tasks", z.array(myTaskResponse)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await listMyTasks(c.get("userId"), c.req.valid("query")), 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/access",
      operationId: "doskaProjectAccess",
      tags: ["Doska"],
      summary: "Read capabilities for a content-visible project",
      request: { params: projectParams },
      responses: {
        200: jsonResponse("Project capabilities", capabilitiesResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const capabilities = await getProjectCapabilities(
        c.get("userId"),
        c.req.valid("param").id,
      );
      if (!capabilities.readContent)
        throw new HTTPException(404, { message: "Project not found" });
      return c.json(capabilities, 200);
    },
  );
