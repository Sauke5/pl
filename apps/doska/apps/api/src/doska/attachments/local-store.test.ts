import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { LocalAttachmentStore, MAX_ATTACHMENT_BYTES } from "./local-store";

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomUUID: vi.fn(
    (await original<typeof import("node:crypto")>()).randomUUID,
  ),
}));

function stream(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("local attachment store", () => {
  let root: string;
  let store: LocalAttachmentStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "doska-attachment-"));
    store = new LocalAttachmentStore(root);
  });
  afterEach(async () => {
    vi.clearAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("streams bytes, checks metadata and restricts permissions", async () => {
    const bytes = Buffer.from("Привет, вложение");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const saved = await store.write(
      stream(bytes.subarray(0, 4), bytes.subarray(4)),
      { size: bytes.length, sha256 },
    );
    expect(saved).toMatchObject({ size: bytes.length, sha256 });
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read(saved.key)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect((await stat(join(root, saved.key))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual([saved.key]);
    await store.remove(saved.key);
    await store.remove(saved.key);
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts exactly 25 MiB and rejects excess without partial files", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const saved = await store.write(
      stream(...Array<Uint8Array>(25).fill(chunk)),
    );
    expect(saved.size).toBe(MAX_ATTACHMENT_BYTES);
    await store.remove(saved.key);
    await expect(
      store.write(
        stream(...Array<Uint8Array>(25).fill(chunk), new Uint8Array(1)),
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects mismatched size and digest and cleans partial files", async () => {
    await expect(
      store.write(stream(Buffer.from("x")), { size: 2 }),
    ).rejects.toMatchObject({ code: "size_mismatch" });
    await expect(
      store.write(stream(Buffer.from("x")), { sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels a pending read when aborted and removes partial bytes", async () => {
    const abort = new AbortController();
    let cancel = false;
    let reads = 0;
    const pending = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (reads++ === 0) controller.enqueue(Buffer.from("partial"));
          else abort.abort();
        },
        cancel() {
          cancel = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      store.write(pending, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("cleans an errored or locked stream", async () => {
    await expect(
      store.write(
        new ReadableStream({
          start(c) {
            c.error(new Error("source failed"));
          },
        }),
      ),
    ).rejects.toThrow("source failed");
    const locked = stream();
    const reader = locked.getReader();
    await expect(store.write(locked)).rejects.toThrow();
    reader.releaseLock();
    expect(await readdir(root)).toEqual([]);
  });

  it("never replaces an existing object", async () => {
    const saved = await store.write(stream(Buffer.from("original")));
    vi.mocked(randomUUID).mockReturnValueOnce(
      saved.key as ReturnType<typeof randomUUID>,
    );
    await expect(
      store.write(stream(Buffer.from("replacement"))),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read(saved.key)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("original");
    expect(await readdir(root)).toEqual([saved.key]);
  });

  it("uses a reserved server key and refuses overwrite or invalid keys", async () => {
    const key = randomUUID();
    expect(
      await store.write(stream(Buffer.from("reserved")), { key }),
    ).toMatchObject({ key });
    await expect(
      store.write(stream(Buffer.from("replacement")), { key }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      store.write(stream(), { key: "../escape" }),
    ).rejects.toMatchObject({ code: "invalid_key" });
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read(key)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("reserved");
    expect(await readdir(root)).toEqual([key]);
  });

  it("rejects traversal and refuses symlink reads", async () => {
    for (const key of ["../escape", "/tmp/escape", "file.txt", ""]) {
      await expect(store.read(key)).rejects.toMatchObject({
        code: "invalid_key",
      });
      await expect(store.remove(key)).rejects.toMatchObject({
        code: "invalid_key",
      });
    }
    const target = join(root, "private");
    await writeFile(target, "private");
    const key = randomUUID();
    await symlink(target, join(root, key));
    await expect(store.read(key)).rejects.toMatchObject({ code: "ELOOP" });
    await store.remove(key);
    expect(await stat(target)).toBeDefined();
  });

  it("prunes only old regular staging files, retaining committed objects and unrelated paths", async () => {
    const old = new Date("2020-01-01T00:00:00Z");
    const stale = `.${randomUUID()}.part`;
    const fresh = `.${randomUUID()}.part`;
    const object = randomUUID();
    for (const name of [stale, fresh, object, ".unrelated.part"])
      await writeFile(join(root, name), name);
    for (const name of [stale, object, ".unrelated.part"])
      await utimes(join(root, name), old, old);
    const directory = `.${randomUUID()}.part`;
    await mkdir(join(root, directory));
    const symbolic = `.${randomUUID()}.part`;
    await symlink(join(root, object), join(root, symbolic));
    expect(await store.pruneTemporary(new Date("2021-01-01T00:00:00Z"))).toBe(
      1,
    );
    expect((await readdir(root)).sort()).toEqual(
      [fresh, object, ".unrelated.part", directory, symbolic].sort(),
    );
    expect(await store.pruneTemporary(new Date("2021-01-01T00:00:00Z"))).toBe(
      0,
    );
  });

  it("protects active staging files even with a future cutoff", async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          started();
        },
      },
      { highWaterMark: 0 },
    );
    const write = store.write(source);
    await reading;
    expect(await store.pruneTemporary(new Date("2100-01-01T00:00:00Z"))).toBe(
      0,
    );
    controller.enqueue(Buffer.from("active"));
    controller.close();
    const stored = await write;
    expect(await readdir(root)).toEqual([stored.key]);
  });

  it("does not hang if aborted before the reader is attached", async () => {
    const abort = new AbortController();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const write = store.write(source, { signal: abort.signal });
    abort.abort();
    await expect(write).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
});
