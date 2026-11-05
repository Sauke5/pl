import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { z } from "zod";
import {
  changesPageSchema,
  departmentsPageSchema,
  employeesPageSchema,
  identitySchema,
} from "./dto";

export type DirectoryErrorCode =
  | "resync_required"
  | "identity_not_found"
  | "invalid_response"
  | "unavailable"
  | "unauthorized"
  | "invalid_configuration";

export class DirectoryClientError extends Error {
  constructor(
    readonly code: DirectoryErrorCode,
    readonly status?: number,
  ) {
    // Never include remote bodies, URLs, filesystem errors or fetch causes.
    super(`Platform directory: ${code}`);
    this.name = "DirectoryClientError";
  }
}

export interface DirectoryClientOptions {
  origin: string;
  machineTokenFile: string;
  instanceID?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class PlatformDirectoryClient {
  private readonly origin: string;
  private readonly directoryPath: string;
  private readonly machineTokenFile: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: DirectoryClientOptions) {
    try {
      const url = new URL(options.origin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !isAbsolute(options.machineTokenFile)
      ) {
        throw new Error();
      }
      if (options.instanceID !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.instanceID)) throw new Error();
      this.directoryPath = options.instanceID
        ? `/api/v1/modules/${options.instanceID}/doska-directory`
        : "/api/v1/doska-directory";
      this.origin = url.origin;
      this.machineTokenFile = options.machineTokenFile;
      this.fetcher = options.fetch ?? fetch;
      this.timeoutMs = options.timeoutMs ?? 10_000;
      this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
      if (
        !Number.isSafeInteger(this.timeoutMs) ||
        this.timeoutMs < 1 ||
        this.timeoutMs > 10_000 ||
        !Number.isSafeInteger(this.maxResponseBytes) ||
        this.maxResponseBytes < 1 ||
        this.maxResponseBytes > 16 * 1024 * 1024
      ) {
        throw new Error();
      }
    } catch {
      throw new DirectoryClientError("invalid_configuration");
    }
  }

  async identity(sub: string) {
    const identity = await this.request("identity", { sub }, identitySchema);
    if (identity.sub !== sub)
      throw new DirectoryClientError("invalid_response");
    return identity;
  }

  employees(cursor?: string) {
    return this.request(
      "employees",
      { cursor, limit: "100" },
      employeesPageSchema,
    );
  }

  departments(cursor?: string) {
    return this.request(
      "departments",
      { cursor, limit: "100" },
      departmentsPageSchema,
    );
  }

  changes(after?: string) {
    return this.request("changes", { after, limit: "100" }, changesPageSchema);
  }

  private async token(): Promise<string> {
    try {
      const file = await open(this.machineTokenFile, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4098) throw new Error();
        const bytes = Buffer.alloc(4099);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const token = bytes.subarray(0, bytesRead).toString("utf8").trim();
        if (!/^[\x21-\x7e]{32,4096}$/.test(token)) throw new Error();
        return token;
      } finally {
        await file.close();
      }
    } catch {
      throw new DirectoryClientError("invalid_configuration");
    }
  }

  private async request<T>(
    endpoint: "identity" | "employees" | "departments" | "changes",
    params: Record<string, string | undefined>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const token = await this.token();
    const url = new URL(`${this.directoryPath}/${endpoint}`, this.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      reader = response.body?.getReader();
      if (response.status === 410)
        throw new DirectoryClientError("resync_required", 410);
      if (response.status === 404 && endpoint === "identity") {
        throw new DirectoryClientError("identity_not_found", 404);
      }
      if (response.status === 401 || response.status === 403) {
        throw new DirectoryClientError("unauthorized", response.status);
      }
      if (
        (response.status >= 300 && response.status < 400) ||
        response.redirected
      ) {
        throw new DirectoryClientError("invalid_response", response.status);
      }
      if (response.status !== 200)
        throw new DirectoryClientError("unavailable", response.status);
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        throw new DirectoryClientError("invalid_response");
      }
      if (!reader) throw new DirectoryClientError("invalid_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes)
          throw new DirectoryClientError("invalid_response");
        chunks.push(value);
      }
      const parsed = schema.safeParse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      );
      if (!parsed.success) throw new DirectoryClientError("invalid_response");
      return parsed.data;
    } catch (error) {
      if (error instanceof DirectoryClientError) throw error;
      throw new DirectoryClientError(
        controller.signal.aborted ? "unavailable" : "invalid_response",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }
}
