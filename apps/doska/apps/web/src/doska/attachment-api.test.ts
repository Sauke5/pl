import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { waitFor } from "@testing-library/react";
vi.mock("@kaneo/libs", async () => {
  const { hc } = await import("hono/client");
  return {
    client: hc("/doska/api", {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, init),
    }),
    resolveApiBaseUrl: () => "/doska/api",
  };
});
const fetchMock = vi.fn<typeof fetch>();
class FakeXHR {
  static instances: FakeXHR[] = [];
  static complete = true;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  withCredentials = false;
  timeout = 0;
  status = 200;
  upload: {
    onprogress?: (event: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
  } = {};
  onload?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    if (FakeXHR.complete)
      queueMicrotask(() => {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 2,
          total: 4,
        });
        this.onload?.();
      });
  }
  abort() {
    this.onabort?.();
  }
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const context = { csrfToken: "doska-csrf" };
const attachment = {
  id: "upload",
  filename: "note.txt",
  size: 4,
  createdAt: "2026-10-23T00:00:00Z",
  createdBy: "owner",
};
function file() {
  const result = new File(["text"], "note.txt", { type: "text/plain" });
  Object.defineProperty(result, "arrayBuffer", {
    value: async () => new TextEncoder().encode("text").buffer,
  });
  return result;
}
function options(controller = new AbortController()) {
  return {
    signal: controller.signal,
    onProgress: vi.fn(),
    clientRequestId: "first-request",
  };
}
beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  FakeXHR.instances = [];
  FakeXHR.complete = true;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => vi.unstubAllGlobals());
it("builds a relative download URL and encodes every path segment", async () => {
  const { api } = await import("./api");
  expect(api.attachmentDownloadUrl("p/one", "t space", "a?x")).toBe(
    "/doska/api/doska/projects/p%2Fone/tasks/t%20space/attachments/a%3Fx/content",
  );
});
it("uploads the raw File to the relative URL with CSRF and then finalizes", async () => {
  const { api } = await import("./api");
  fetchMock
    .mockResolvedValueOnce(json(context))
    .mockResolvedValueOnce(json({ id: "upload", state: "reserved" }))
    .mockResolvedValueOnce(json(attachment));
  const value = file(),
    config = options();
  expect(await api.uploadAttachment("p", "t", value, config)).toEqual(
    attachment,
  );
  const xhr = FakeXHR.instances[0]!;
  expect(xhr.method).toBe("PUT");
  expect(xhr.url).toBe(
    "/doska/api/doska/projects/p/tasks/t/attachment-uploads/upload/content",
  );
  expect(xhr.body).toBe(value);
  expect(xhr.headers).toEqual({
    "Content-Type": "application/octet-stream",
    "X-CSRF-Token": "doska-csrf",
  });
  expect(xhr.withCredentials).toBe(true);
  expect(xhr.timeout).toBe(125_000);
  expect(config.onProgress).toHaveBeenCalledWith(50);
  const reserve = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
  expect(reserve).toEqual({
    filename: "note.txt",
    size: 4,
    sha256: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1",
    clientRequestId: "first-request",
  });
  expect(String(fetchMock.mock.calls[2]![0])).toBe(
    "/doska/api/doska/projects/p/tasks/t/attachment-uploads/upload/finalize",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({});
  expect(
    new Headers(fetchMock.mock.calls[2]![1]!.headers).get("X-CSRF-Token"),
  ).toBe("doska-csrf");
});
it("reserves a fresh request ID after an expired or cancelled reservation conflicts", async () => {
  const { api } = await import("./api");
  fetchMock
    .mockResolvedValueOnce(json(context))
    .mockResolvedValueOnce(json({ error: "expired" }, 409))
    .mockResolvedValueOnce(json({ id: "fresh", state: "reserved" }))
    .mockResolvedValueOnce(json(attachment));
  await api.uploadAttachment("p", "t", file(), options());
  const first = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
  const next = JSON.parse(String(fetchMock.mock.calls[2]![1]!.body));
  expect(next.clientRequestId).not.toBe(first.clientRequestId);
  expect({ ...next, clientRequestId: first.clientRequestId }).toEqual(first);
  expect(FakeXHR.instances[0]!.url).toContain("/fresh/content");
});
it.each(["uploaded", "ready"])(
  "does not resend file bytes for a %s ticket",
  async (state) => {
    const { api } = await import("./api");
    fetchMock
      .mockResolvedValueOnce(json(context))
      .mockResolvedValueOnce(json({ id: "upload", state }))
      .mockResolvedValueOnce(json(attachment));
    expect(await api.uploadAttachment("p", "t", file(), options())).toEqual(
      attachment,
    );
    expect(FakeXHR.instances).toHaveLength(0);
    expect(String(fetchMock.mock.calls[2]![0])).toContain("/upload/finalize");
  },
);
it("cancels the reserved ticket when the raw upload is aborted", async () => {
  const { api } = await import("./api");
  FakeXHR.complete = false;
  fetchMock
    .mockResolvedValueOnce(json(context))
    .mockResolvedValueOnce(json({ id: "upload", state: "reserved" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const controller = new AbortController();
  const promise = api.uploadAttachment("p", "t", file(), options(controller));
  const rejected = expect(promise).rejects.toMatchObject({
    name: "AbortError",
  });
  await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
  controller.abort();
  await rejected;
  expect(String(fetchMock.mock.calls[2]![0])).toBe(
    "/doska/api/doska/projects/p/tasks/t/attachment-uploads/upload",
  );
  expect(fetchMock.mock.calls[2]![1]!.method).toBe("DELETE");
  expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({});
});
