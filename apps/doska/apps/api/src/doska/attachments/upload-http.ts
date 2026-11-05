import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { GatewayError } from "../gateway/types";
import type { DoskaGatewayVerifier } from "../gateway/verifier";
import {
  loadDoskaGatewayVerifier,
  resolveDoskaIdentity,
  type DoskaHttpEnv,
  type ResolvedDoskaIdentity,
} from "../http-identity";
import { attachmentUploadRoute } from "../route-policy";
import { AttachmentStorageError } from "./local-store";
import { beginReceiving, markUploaded, requestDelete } from "./metadata";
import { getAttachmentStore } from "./runtime";
import {
  AttachmentContentError,
  screenAttachmentStream,
} from "./screen-stream";
import { attachmentSessionBinding } from "./session-binding";
import { AttachmentAdmission } from "./upload-admission";

const admission = new AttachmentAdmission();
function requireIdentity(
  identity: ResolvedDoskaIdentity | null,
  subject: string,
) {
  const now = Date.now();
  if (
    !identity ||
    identity.subject !== subject ||
    !identity.active ||
    !Number.isFinite(identity.observedAt.getTime()) ||
    !Number.isFinite(identity.validUntil.getTime()) ||
    identity.observedAt.getTime() > now ||
    identity.validUntil.getTime() <= now
  )
    throw new GatewayError("gateway_identity_unavailable", 403);
  return identity;
}

/** Isolated raw upload path: never sets the generic fully body-verified identity. */
export function createDoskaAttachmentUpload(
  options: {
    verifier?: Pick<
      DoskaGatewayVerifier,
      "verifyUploadHeaders" | "verifyUploadBody"
    >;
    resolveIdentity?: (
      subject: string,
    ) => Promise<ResolvedDoskaIdentity | null>;
  } = {},
) {
  let verifier = options.verifier;
  return createMiddleware<DoskaHttpEnv>(async (c) => {
    const startedAt = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error("Upload timed out")),
      120_000,
    );
    timer.unref();
    let identityTimer: ReturnType<typeof setTimeout> | undefined;
    let release: (() => void) | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const route = attachmentUploadRoute(c.req.method, c.req.path);
      if (!route) return c.json({ error: "Not found" }, 404);
      if (!process.env.DOSKA_ATTACHMENTS_DIRECTORY)
        throw new GatewayError("attachment_storage_unavailable", 503);
      const incoming = c.env?.incoming;
      if (
        !incoming?.url ||
        incoming.method !== "PUT" ||
        !Array.isArray(incoming.rawHeaders) ||
        incoming.rawHeaders.length % 2 ||
        c.req.raw.bodyUsed ||
        Object.keys(c.req.bodyCache).length
      )
        throw new GatewayError("gateway_raw_request_unavailable", 503);
      const headers: [string, string][] = [];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i];
        const value = incoming.rawHeaders[i + 1];
        if (typeof name !== "string" || typeof value !== "string")
          throw new GatewayError("gateway_raw_request_unavailable", 503);
        headers.push([name, value]);
      }
      // The route dispatcher and authenticated raw URI must address the same ticket.
      if (incoming.url !== c.req.path)
        throw new GatewayError("gateway_request_mismatch");
      verifier ??= loadDoskaGatewayVerifier();
      const claims = await verifier.verifyUploadHeaders(
        { method: incoming.method, rawUri: incoming.url, headers },
        { requiredScope: "doska:write" },
      );
      const resolve = options.resolveIdentity ?? resolveDoskaIdentity;
      const identity = requireIdentity(await resolve(claims.sub), claims.sub);
      release = admission.acquire(claims.sub);
      const deadline = new Date(
        Math.min(startedAt + 120_000, identity.validUntil.getTime()),
      );
      const remaining = deadline.getTime() - Date.now();
      if (remaining <= 0)
        throw new GatewayError("gateway_identity_unavailable", 403);
      identityTimer = setTimeout(
        () => abort.abort(new Error("Upload lease expired")),
        remaining,
      );
      identityTimer.unref();
      const signal = AbortSignal.any([abort.signal, c.req.raw.signal]);
      signal.throwIfAborted();
      const store = await getAttachmentStore();
      const binding = attachmentSessionBinding(claims);
      const row = await beginReceiving(
        identity.user.id,
        route.projectId,
        route.taskId,
        binding,
        route.uploadId,
      );
      if (row.state !== "receiving" || !row.objectKey)
        throw new HTTPException(409, { message: "Upload is already received" });
      const objectKey = row.objectKey;
      cleanup = async () => {
        // ACL may already be revoked. The durable lease/expiry still lets the worker clean metadata.
        await requestDelete(
          identity.user.id,
          route.projectId,
          route.taskId,
          row.id,
          binding,
        ).catch(() => {});
        await store.remove(objectKey);
      };
      signal.throwIfAborted();
      if (!c.req.raw.body)
        throw new HTTPException(400, { message: "Missing attachment content" });
      const extension = row.filename
        .slice(row.filename.lastIndexOf(".") + 1)
        .toLowerCase();
      const actual = await store.write(
        screenAttachmentStream(c.req.raw.body, extension),
        { key: objectKey, size: row.size, sha256: row.sha256, signal },
      );
      verifier.verifyUploadBody(claims, actual);
      signal.throwIfAborted();
      const currentIdentity = requireIdentity(
        await resolve(claims.sub),
        claims.sub,
      );
      if (currentIdentity.user.id !== identity.user.id)
        throw new GatewayError("gateway_identity_unavailable", 403);
      signal.throwIfAborted();
      const uploaded = await markUploaded(
        identity.user.id,
        route.projectId,
        route.taskId,
        binding,
        row.id,
        { objectKey, size: actual.size, sha256: actual.sha256, deadline },
      );
      cleanup = undefined;
      return c.json({
        id: uploaded.id,
        state: uploaded.state,
        expiresAt: uploaded.expiresAt,
      });
    } catch (error) {
      if (cleanup) {
        try {
          await cleanup();
        } catch {
          return c.json({ error: "attachment_cleanup_pending" }, 503);
        }
      }
      if (error instanceof GatewayError)
        return c.json({ error: error.code }, error.status);
      if (error instanceof HTTPException) throw error;
      if (error instanceof AttachmentContentError)
        return c.json({ error: "attachment_content_mismatch" }, 400);
      if (error instanceof AttachmentStorageError)
        return c.json(
          { error: `attachment_${error.code}` },
          error.code === "too_large" ? 413 : 400,
        );
      return c.json(
        {
          error: abort.signal.aborted
            ? "attachment_upload_expired"
            : "attachment_upload_failed",
        },
        503,
      );
    } finally {
      clearTimeout(timer);
      if (identityTimer) clearTimeout(identityTimer);
      release?.();
    }
  });
}
