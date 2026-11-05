import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import {
  archiveProjectBody,
  createProjectBody,
  managementMetadata,
  projectParams,
  transferProjectBody,
  updateProjectBody,
} from "./schema";
import {
  archiveProject,
  createProject,
  getManagementMetadata,
  transferProject,
  updateProject,
} from "./service";

const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Authentication required"),
  403: errorResponse("Operation not permitted"),
  404: errorResponse("Project unavailable"),
  409: errorResponse("Concurrent change or project key conflict"),
  503: errorResponse("Directory unavailable"),
};
const projects = apiRouter();
projects.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});

const routes = projects
  .openapi(
    createRoute({
      method: "post",
      path: "/projects",
      operationId: "doskaCreateProject",
      tags: ["Doska projects"],
      summary: "Create a project in the employee's primary department",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: createProjectBody } },
        },
      },
      responses: {
        201: jsonResponse("Project created", managementMetadata),
        ...errors,
      },
    }),
    async (c) =>
      c.json(await createProject(c.get("userId"), c.req.valid("json")), 201),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}",
      operationId: "doskaUpdateProject",
      tags: ["Doska projects"],
      summary: "Change project settings as its owner",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: updateProjectBody } },
        },
      },
      responses: {
        200: jsonResponse("Project updated", managementMetadata),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await updateProject(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/archive",
      operationId: "doskaArchiveProject",
      tags: ["Doska projects"],
      summary: "Archive or restore a project as its owner or department head",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: archiveProjectBody } },
        },
      },
      responses: {
        200: jsonResponse("Archive state changed", managementMetadata),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await archiveProject(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/owner",
      operationId: "doskaTransferProject",
      tags: ["Doska projects"],
      summary: "Transfer project ownership with an audit record",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: transferProjectBody } },
        },
      },
      responses: {
        200: jsonResponse("Ownership transferred", managementMetadata),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await transferProject(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/management",
      operationId: "doskaProjectManagementMetadata",
      tags: ["Doska projects"],
      summary: "Read management metadata without exposing project content",
      request: { params: projectParams },
      responses: {
        200: jsonResponse("Management metadata", managementMetadata),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await getManagementMetadata(c.get("userId"), c.req.valid("param").id),
        200,
      ),
  );

export default routes;
