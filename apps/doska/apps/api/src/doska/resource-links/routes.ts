import { HTTPException } from "hono/http-exception";
import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors } from "../projects/member-schema";
import {
  attachBody,
  backrefsBody,
  backrefsResponse,
  createBody,
  createResponse,
  linkParams,
  linksResponse,
  mutationBody,
  mutationResponse,
} from "./schema";
import {
  attachResource,
  createTaskFromResource,
  detachResource,
  listResourceLinks,
  resourceCapabilities,
} from "./service";
import { resourceBackrefs } from "./backrefs";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
function checkKey(header: string | undefined, key: string) {
  if (header !== key)
    throw new HTTPException(400, { message: "Invalid idempotency key" });
}
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/resource-link-capabilities",
      operationId: "doskaResourceCapabilities",
      tags: ["Doska resources"],
      summary: "Internal gateway resource-link capabilities",
      request: { params: linkParams.pick({ id: true }) },
      responses: {
        200: jsonResponse(
          "Capabilities",
          z.strictObject({
            version: z.literal(1),
            readContent: z.boolean(),
            workOnTasks: z.boolean(),
          }),
        ),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await resourceCapabilities(c.get("userId"), c.req.valid("param").id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/resource-links",
      operationId: "doskaListResourceLinks",
      tags: ["Doska resources"],
      summary: "Internal resource references for gateway resolution",
      request: { params: linkParams },
      responses: { 200: jsonResponse("Links", linksResponse), ...memberErrors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await listResourceLinks(c.get("userId"), p.id, p.taskId),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/resource-links",
      operationId: "doskaAttachResource",
      tags: ["Doska resources"],
      summary: "Attach a gateway-authorized resource",
      request: { params: linkParams, body: body(attachBody) },
      responses: {
        200: jsonResponse("Attached", mutationResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const p = c.req.valid("param"),
        input = attachBody.parse(c.req.valid("json"));
      checkKey(c.req.header("Idempotency-Key"), input.clientRequestId);
      return c.json(
        mutationResponse.parse(
          await attachResource(c.get("userId"), p.id, p.taskId, input),
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/resource-links/{linkId}",
      operationId: "doskaDetachResource",
      tags: ["Doska resources"],
      summary: "Detach a resource",
      request: {
        params: linkParams.extend({ linkId: linkParams.shape.taskId }),
        body: body(mutationBody),
      },
      responses: {
        200: jsonResponse("Detached", mutationResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const p = c.req.valid("param"),
        input = mutationBody.parse(c.req.valid("json"));
      checkKey(c.req.header("Idempotency-Key"), input.clientRequestId);
      return c.json(
        mutationResponse.parse(
          await detachResource(
            c.get("userId"),
            p.id,
            p.taskId,
            p.linkId,
            input,
          ),
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/from-resource",
      operationId: "doskaCreateTaskFromResource",
      tags: ["Doska resources"],
      summary: "Create task and initial resource link atomically",
      request: {
        params: linkParams.pick({ id: true }),
        body: body(createBody),
      },
      responses: {
        200: jsonResponse("Created", createResponse),
        ...memberErrors,
      },
    }),
    async (c) => {
      const input = createBody.parse(c.req.valid("json"));
      checkKey(c.req.header("Idempotency-Key"), input.clientRequestId);
      return c.json(
        createResponse.parse(
          await createTaskFromResource(
            c.get("userId"),
            c.req.valid("param").id,
            input,
          ),
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/catalog/task-links",
      operationId: "doskaResourceBackrefs",
      tags: ["Doska resources"],
      summary: "Read accessible tasks linked to a resource",
      request: { body: body(backrefsBody) },
      responses: {
        200: jsonResponse("Linked tasks", backrefsResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await resourceBackrefs(
          c.get("userId"),
          backrefsBody.parse(c.req.valid("json")),
        ),
        200,
      ),
  );
export default routes;
