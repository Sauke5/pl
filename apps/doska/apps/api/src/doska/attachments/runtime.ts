import { isAbsolute } from "node:path";
import { HTTPException } from "hono/http-exception";
import { LocalAttachmentStore } from "./local-store";

let configured: { root: string; store: LocalAttachmentStore } | undefined;

export function ensureAttachmentStorage(): void {
  const root = process.env.DOSKA_ATTACHMENTS_DIRECTORY;
  if (!root || !isAbsolute(root))
    throw new HTTPException(503, { message: "attachment_storage_unavailable" });
}

export function getAttachmentStore(): LocalAttachmentStore {
  ensureAttachmentStorage();
  const root = process.env.DOSKA_ATTACHMENTS_DIRECTORY!;
  if (configured?.root !== root)
    configured = { root, store: new LocalAttachmentStore(root) };
  return configured.store;
}
