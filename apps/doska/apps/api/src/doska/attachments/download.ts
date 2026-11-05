import { Readable } from "node:stream";
import { HTTPException } from "hono/http-exception";
import { resolveDoskaIdentity } from "../http-identity";
import { inspectReady } from "./metadata";
import { MAX_ATTACHMENT_BYTES } from "./policy";
import { getAttachmentStore } from "./runtime";
import { AttachmentAdmission } from "./upload-admission";

const admission = new AttachmentAdmission();

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function closeSource(source: Readable) {
  if (source.closed) return;
  const closed = new Promise<void>((resolve) => source.once("close", resolve));
  source.destroy();
  await closed;
}

export async function downloadAttachment(input: {
  request: Request;
  actorId: string;
  subject: string;
  projectId: string;
  taskId: string;
  attachmentId: string;
}): Promise<Response> {
  if (input.request.headers.has("range"))
    throw new HTTPException(416, { message: "attachment_range_unsupported" });
  const release = admission.acquire(input.subject);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, input.request.signal]);
  const totalTimer = setTimeout(() => abort.abort(), 120_000);
  totalTimer.unref();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let leaseDeadline = Date.now() + 5_000;
  const requireLease = () => {
    if (Date.now() >= leaseDeadline) abort.abort();
    signal.throwIfAborted();
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let source: Readable | undefined;
  let finishing: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const finish = () => {
    if (finishing) return finishing;
    closed = true;
    clearTimeout(totalTimer);
    clearTimeout(leaseTimer);
    clearTimeout(refreshTimer);
    if (stop) signal.removeEventListener("abort", stop);
    finishing = (async () => {
      void reader?.cancel().catch(() => {});
      if (source) await closeSource(source);
      release();
    })();
    return finishing;
  };
  const check = async () => {
    const identity = await resolveDoskaIdentity(input.subject);
    if (
      !identity ||
      !identity.active ||
      identity.user.id !== input.actorId ||
      identity.observedAt.getTime() > Date.now() ||
      identity.validUntil.getTime() <= Date.now()
    )
      throw new HTTPException(403, { message: "gateway_identity_unavailable" });
    const row = await inspectReady(
      input.actorId,
      input.projectId,
      input.taskId,
      input.attachmentId,
    );
    requireLease();
    if (closed) throw new Error("Download closed");
    if (identity.validUntil.getTime() <= Date.now())
      throw new HTTPException(403, { message: "gateway_identity_unavailable" });
    clearTimeout(leaseTimer);
    leaseDeadline = Math.min(Date.now() + 5_000, identity.validUntil.getTime());
    leaseTimer = setTimeout(
      () => abort.abort(),
      Math.max(0, leaseDeadline - Date.now()),
    );
    leaseTimer.unref();
    return row;
  };
  try {
    // A stalled first authorization must not occupy an admission slot indefinitely.
    leaseTimer = setTimeout(() => abort.abort(), 5_000);
    leaseTimer.unref();
    const row = await abortable(check(), signal);
    if (!row.objectKey || row.size <= 0 || row.size > MAX_ATTACHMENT_BYTES)
      throw new HTTPException(503, { message: "attachment_unavailable" });
    const openedSource = await abortable(
      getAttachmentStore()
        .read(row.objectKey)
        .then(async (opened) => {
          source = opened;
          // An aborted request may finish before a slow filesystem open returns.
          if (signal.aborted || closed) {
            await closeSource(opened);
            throw signal.reason ?? new Error("Download closed");
          }
          return opened;
        }),
      signal,
    );
    reader = (
      Readable.toWeb(openedSource) as ReadableStream<Uint8Array>
    ).getReader();
    requireLease();
    const refresh = async () => {
      try {
        await abortable(check(), signal);
        if (!closed) {
          refreshTimer = setTimeout(() => {
            void refresh();
          }, 2_000);
          refreshTimer.unref();
        }
      } catch {
        abort.abort();
      }
    };
    refreshTimer = setTimeout(() => {
      void refresh();
    }, 2_000);
    refreshTimer.unref();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stop = () => {
          if (closed) return;
          controller.error(new Error("Attachment download interrupted"));
          void finish();
        };
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      },
      async pull(controller) {
        try {
          requireLease();
          const chunk = await reader!.read();
          requireLease();
          if (chunk.done) {
            if (bytes !== row.size) throw new Error("Attachment size mismatch");
            controller.close();
            await finish();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > row.size) throw new Error("Attachment size mismatch");
          controller.enqueue(chunk.value);
        } catch (error) {
          if (!closed) controller.error(error);
          await finish();
        }
      },
      async cancel() {
        await finish();
      },
    });
    const encodedName = encodeURIComponent(row.filename).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(row.size),
        "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodedName}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Encoding": "identity",
      },
    });
  } catch (error) {
    await finish();
    throw error;
  }
}
