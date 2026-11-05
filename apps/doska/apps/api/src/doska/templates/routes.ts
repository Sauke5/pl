import {
  apiRouter,
  createRoute,
  jsonResponse,
  z,
  pagingNumber,
} from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors, emptyBody } from "../projects/member-schema";
import { projectParams, managementMetadata } from "../projects/schema";
import { taskParams } from "../tasks/schema";
import {
  templateSnapshotSchema,
  templateSelectionBody,
  saveTemplateBody,
  createFromTemplateBody,
  templateVisibility,
} from "./schema";
import {
  getTemplateSelection,
  setTemplateSelection,
  previewTemplate,
} from "./source";
import {
  listTemplates,
  readTemplate,
  saveTemplate,
  createProjectFromTemplate,
} from "./service";
const summary = z.strictObject({
  id: z.string(),
  name: z.string(),
  visibility: templateVisibility,
  revision: z.number().int(),
  snapshotVersion: z.number().int(),
});
const item = summary.extend({ canManage: z.boolean() });
const selection = z.strictObject({
  selected: z.boolean(),
  revision: z.number().int(),
});
const pageQuery = z.strictObject({ page: pagingNumber(1, 10_000, 1) });
const preview = z.strictObject({
  snapshot: templateSnapshotSchema,
  fingerprint: z.string(),
  expandedTaskIds: z.array(z.string()),
});
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
export default router
  .openapi(
    createRoute({
      method: "get",
      path: "/templates",
      operationId: "doskaListTemplates",
      tags: ["Doska templates"],
      summary: "List visible templates",
      request: { query: pageQuery },
      responses: {
        200: jsonResponse(
          "Templates",
          z.strictObject({ items: z.array(item), hasMore: z.boolean() }),
        ),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listTemplates(c.get("userId"), c.req.valid("query").page),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/templates/{id}",
      operationId: "doskaReadTemplate",
      tags: ["Doska templates"],
      summary: "Read the current visible snapshot",
      request: { params: projectParams },
      responses: {
        200: jsonResponse(
          "Template",
          item.extend({ snapshot: templateSnapshotSchema }),
        ),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await readTemplate(c.get("userId"), c.req.valid("param").id), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/templates",
      operationId: "doskaSaveTemplate",
      tags: ["Doska templates"],
      summary:
        "Save or update a snapshot after preview as source and template owner",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: saveTemplateBody } },
        },
      },
      responses: {
        201: jsonResponse("Template saved", summary),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await saveTemplate(c.get("userId"), c.req.valid("json")), 201),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/templates/{id}/projects",
      operationId: "doskaCreateProjectFromTemplate",
      tags: ["Doska templates"],
      summary: "Create a project atomically from a visible template",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: createFromTemplateBody } },
        },
      },
      responses: {
        201: jsonResponse("Project created", managementMetadata),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await createProjectFromTemplate(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/template-selection",
      operationId: "doskaGetTemplateSelection",
      tags: ["Doska templates"],
      summary: "Read template selection as project owner",
      request: { params: projectParams },
      responses: {
        200: jsonResponse(
          "Selection",
          z.array(selection.extend({ taskId: z.string() })),
        ),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await getTemplateSelection(c.get("userId"), c.req.valid("param").id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/template-selection/{taskId}",
      operationId: "doskaSetTemplateSelection",
      tags: ["Doska templates"],
      summary: "Select a task for templates as project owner",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: templateSelectionBody } },
        },
      },
      responses: {
        200: jsonResponse("Selection saved", selection),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await setTemplateSelection(
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
      method: "post",
      path: "/projects/{id}/template-preview",
      operationId: "doskaPreviewTemplate",
      tags: ["Doska templates"],
      summary: "Preview a snapshot and source fingerprint as owner",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: emptyBody } },
        },
      },
      responses: { 200: jsonResponse("Preview", preview), ...memberErrors },
    }),
    async (c) =>
      c.json(
        preview.parse(
          await previewTemplate(c.get("userId"), c.req.valid("param").id),
        ),
        200,
      ),
  );
