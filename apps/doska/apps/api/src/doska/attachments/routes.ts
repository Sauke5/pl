import { HTTPException } from "hono/http-exception";
import {
  apiRouter,
  createRoute,
  jsonResponse,
  z,
  type BaseVariables,
} from "../../openapi";
import type { DoskaHttpEnv } from "../http-identity";
import { isDoskaIntegrated } from "../mode";
import { emptyBody } from "../projects/member-schema";
import { taskParams } from "../tasks/schema";
import { downloadAttachment } from "./download";
import { finalize, listReady, requestDelete, reserve } from "./metadata";
import { AttachmentPolicyError } from "./policy";
import { ensureAttachmentStorage } from "./runtime";
import { attachmentSessionBinding } from "./session-binding";
import {
  attachmentErrors,
  attachmentParams,
  attachmentQuery,
  attachmentResponse,
  reserveBody,
  uploadParams,
  uploadResponse,
} from "./schema";
const router = apiRouter<
  BaseVariables & Pick<DoskaHttpEnv["Variables"], "doskaIdentity">
>();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
function binding(identity: DoskaHttpEnv["Variables"]["doskaIdentity"]) {
  return attachmentSessionBinding({
    sub: identity.subject,
    csrf_token: identity.csrfToken,
  });
}
const emptyJson = {
  required: true,
  content: { "application/json": { schema: emptyBody } },
};
export default router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/attachments",
      operationId: "doskaListAttachments",
      tags: ["Doska attachments"],
      summary: "List ready task attachments",
      request: { params: taskParams, query: attachmentQuery },
      responses: {
        200: jsonResponse("Attachments", z.array(attachmentResponse)),
        ...attachmentErrors,
      },
    }),
    async (c) => {
      ensureAttachmentStorage();
      const p = c.req.valid("param");
      return c.json(
        await listReady(c.get("userId"), p.id, p.taskId, c.req.valid("query")),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/attachment-uploads",
      operationId: "doskaReserveAttachment",
      tags: ["Doska attachments"],
      summary: "Reserve a task attachment upload",
      request: {
        params: taskParams,
        body: {
          required: true,
          content: { "application/json": { schema: reserveBody } },
        },
      },
      responses: {
        200: jsonResponse("Upload reservation", uploadResponse),
        ...attachmentErrors,
      },
    }),
    async (c) => {
      ensureAttachmentStorage();
      const p = c.req.valid("param");
      try {
        const row = await reserve(
          c.get("userId"),
          p.id,
          p.taskId,
          binding(c.get("doskaIdentity")),
          c.req.valid("json"),
        );
        return c.json(
          { id: row.id, state: row.state, expiresAt: row.expiresAt },
          200,
        );
      } catch (error) {
        if (error instanceof AttachmentPolicyError)
          throw new HTTPException(error.code === "file_too_large" ? 413 : 400, {
            message: error.code,
          });
        throw error;
      }
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/tasks/{taskId}/attachment-uploads/{uploadId}/finalize",
      operationId: "doskaFinalizeAttachment",
      tags: ["Doska attachments"],
      summary: "Publish a verified attachment",
      request: { params: uploadParams, body: emptyJson },
      responses: {
        200: jsonResponse("Attachment", attachmentResponse),
        ...attachmentErrors,
      },
    }),
    async (c) => {
      ensureAttachmentStorage();
      const p = c.req.valid("param");
      return c.json(
        await finalize(
          c.get("userId"),
          p.id,
          p.taskId,
          binding(c.get("doskaIdentity")),
          p.uploadId,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/attachment-uploads/{uploadId}",
      operationId: "doskaCancelAttachmentUpload",
      tags: ["Doska attachments"],
      summary: "Cancel an upload reservation",
      request: { params: uploadParams, body: emptyJson },
      responses: { 204: { description: "Cancelled" }, ...attachmentErrors },
    }),
    async (c) => {
      ensureAttachmentStorage();
      const p = c.req.valid("param");
      await requestDelete(
        c.get("userId"),
        p.id,
        p.taskId,
        p.uploadId,
        binding(c.get("doskaIdentity")),
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/tasks/{taskId}/attachments/{attachmentId}/content",
      operationId: "doskaDownloadAttachment",
      tags: ["Doska attachments"],
      summary: "Download an accessible attachment",
      request: { params: attachmentParams },
      responses: {
        200: {
          description: "Attachment bytes",
          content: {
            "application/octet-stream": {
              schema: z.string().openapi({ format: "binary" }),
            },
          },
        },
        ...attachmentErrors,
      },
    }),
    async (c) => {
      ensureAttachmentStorage();
      const p = c.req.valid("param");
      return downloadAttachment({
        request: c.req.raw,
        actorId: c.get("userId"),
        subject: c.get("doskaIdentity").subject,
        projectId: p.id,
        taskId: p.taskId,
        attachmentId: p.attachmentId,
      });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/tasks/{taskId}/attachments/{attachmentId}",
      operationId: "doskaDeleteAttachment",
      tags: ["Doska attachments"],
      summary: "Delete an attachment with task audit",
      request: { params: attachmentParams, body: emptyJson },
      responses: { 204: { description: "Deleted" }, ...attachmentErrors },
    }),
    async (c) => {
      ensureAttachmentStorage();
      const p = c.req.valid("param");
      await requestDelete(c.get("userId"), p.id, p.taskId, p.attachmentId);
      return c.body(null, 204);
    },
  );
