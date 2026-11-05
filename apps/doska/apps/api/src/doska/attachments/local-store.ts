import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { MAX_ATTACHMENT_BYTES } from "./policy";
export { MAX_ATTACHMENT_BYTES } from "./policy";
const keyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AttachmentStorageError extends Error {
  constructor(
    public readonly code:
      | "invalid_key"
      | "too_large"
      | "size_mismatch"
      | "hash_mismatch"
      | "invalid_metadata"
      | "invalid_root"
      | "invalid_file",
  ) {
    super(code);
    this.name = "AttachmentStorageError";
  }
}

export type StoredAttachment = { key: string; size: number; sha256: string };
export type AttachmentWriteOptions = {
  /** Server-reserved metadata UUID; never a client filename. */
  key?: string;
  size?: number;
  sha256?: string;
  signal?: AbortSignal;
};

/** The root and its ancestors are administrator-owned, never supplied by a request. */
export class LocalAttachmentStore {
  private readonly activeTemporary = new Set<string>();

  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new AttachmentStorageError("invalid_root");
  }

  private path(key: string) {
    if (!keyPattern.test(key)) throw new AttachmentStorageError("invalid_key");
    return join(this.root, key);
  }

  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AttachmentStorageError("invalid_root");
    }
    await chmod(this.root, 0o700);
  }

  async write(
    source: ReadableStream<Uint8Array>,
    options: AttachmentWriteOptions = {},
  ): Promise<StoredAttachment> {
    if (
      options.size !== undefined &&
      (!Number.isSafeInteger(options.size) || options.size < 0)
    ) {
      throw new AttachmentStorageError("invalid_metadata");
    }
    if (options.size !== undefined && options.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentStorageError("too_large");
    }
    if (
      options.sha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(options.sha256)
    ) {
      throw new AttachmentStorageError("invalid_metadata");
    }
    options.signal?.throwIfAborted();
    await this.prepare();
    const key = options.key ?? randomUUID();
    const destination = this.path(key);
    const temporary = join(this.root, `.${randomUUID()}.part`);
    this.activeTemporary.add(temporary);
    const file = await open(temporary, "wx", 0o600).catch((error: unknown) => {
      this.activeTemporary.delete(temporary);
      throw error;
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => {
      void reader?.cancel(options.signal?.reason).catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let size = 0;
    const hash = createHash("sha256");
    try {
      reader = source.getReader();
      // Abort may have happened during filesystem setup, before the reader existed.
      options.signal?.throwIfAborted();
      for (;;) {
        options.signal?.throwIfAborted();
        const chunk = await reader.read();
        options.signal?.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_ATTACHMENT_BYTES)
          throw new AttachmentStorageError("too_large");
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await file.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset,
          );
          if (!bytesWritten)
            throw new Error("Attachment write made no progress");
          offset += bytesWritten;
        }
      }
      if (options.size !== undefined && options.size !== size)
        throw new AttachmentStorageError("size_mismatch");
      const sha256 = hash.digest("hex");
      if (options.sha256 !== undefined && options.sha256 !== sha256)
        throw new AttachmentStorageError("hash_mismatch");
      await file.sync();
      await file.close();
      options.signal?.throwIfAborted();
      // Hard linking publishes atomically and fails if the destination already exists.
      await link(temporary, destination);
      return { key, size, sha256 };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      void reader?.cancel().catch(() => {});
      reader?.releaseLock();
      try {
        await file.close();
      } finally {
        try {
          await unlink(temporary);
        } finally {
          this.activeTemporary.delete(temporary);
        }
      }
    }
  }

  async read(key: string) {
    const path = this.path(key);
    await this.prepare();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new AttachmentStorageError("invalid_file");
      return file.createReadStream({ autoClose: true });
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async remove(key: string) {
    const path = this.path(key);
    await this.prepare();
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  /** Only abandoned staging files; committed UUID objects require metadata cleanup. */
  async pruneTemporary(before: Date): Promise<number> {
    if (!Number.isFinite(before.getTime())) {
      throw new AttachmentStorageError("invalid_metadata");
    }
    await this.prepare();
    let removed = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(".") ||
        !entry.name.endsWith(".part")
      )
        continue;
      if (!keyPattern.test(entry.name.slice(1, -5))) continue;
      const path = join(this.root, entry.name);
      if (this.activeTemporary.has(path)) continue;
      try {
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.mtimeMs >= before.getTime() ||
          this.activeTemporary.has(path)
        )
          continue;
        await unlink(path);
        removed++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }
}
