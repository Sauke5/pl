import { Readable } from "node:stream";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { downloadAttachment } from "./download";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  inspect: vi.fn(),
  read: vi.fn(),
  release: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock("../http-identity", () => ({ resolveDoskaIdentity: mocks.identity }));
vi.mock("./metadata", () => ({ inspectReady: mocks.inspect }));
vi.mock("./runtime", () => ({
  getAttachmentStore: () => ({ read: mocks.read }),
}));
vi.mock("./upload-admission", () => ({
  AttachmentAdmission: class {
    acquire = mocks.acquire;
  },
}));
const input = () => ({
  request: new Request("http://localhost/file"),
  actorId: "actor",
  subject: "subject",
  projectId: "project",
  taskId: "task",
  attachmentId: "attachment",
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

describe("attachment download lease and stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.acquire.mockReturnValue(mocks.release);
    mocks.identity.mockResolvedValue({
      active: true,
      user: { id: "actor" },
      observedAt: new Date(Date.now() - 1000),
      validUntil: new Date(Date.now() + 60000),
    });
    mocks.inspect.mockResolvedValue({
      objectKey: "key",
      size: 3,
      filename: "файл.txt",
    });
    mocks.read.mockImplementation(async () =>
      Readable.from([Buffer.from("abc")]),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("sends exact bytes as download and closes before releasing admission", async () => {
    const source = Readable.from([Buffer.from("abc")]);
    mocks.read.mockResolvedValue(source);
    mocks.release.mockImplementation(() => {
      expect(source.closed).toBe(true);
    });
    const response = await downloadAttachment(input());
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%D1%84",
    );
    expect(await response.text()).toBe("abc");
    await flush();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("releases a stalled initial authorization after five seconds", async () => {
    mocks.identity.mockReturnValue(new Promise(() => {}));
    const pending = downloadAttachment(input());
    const failed = expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("expires the last successful lease while a refresh is stalled", async () => {
    mocks.identity
      .mockResolvedValueOnce({
        active: true,
        user: { id: "actor" },
        observedAt: new Date(Date.now() - 1000),
        validUntil: new Date(Date.now() + 60000),
      })
      .mockReturnValue(new Promise(() => {}));
    const source = new Readable({ read() {} });
    mocks.read.mockResolvedValue(source);
    const response = await downloadAttachment(input());
    const failed = expect(response.text()).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    await flush();
    expect(source.closed).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("closes a filesystem open that returns after request cancellation", async () => {
    let opened!: (stream: Readable) => void;
    mocks.read.mockReturnValue(
      new Promise((resolve) => {
        opened = resolve;
      }),
    );
    const abort = new AbortController();
    const pending = downloadAttachment({
      ...input(),
      request: new Request("http://localhost/file", { signal: abort.signal }),
    });
    const failed = expect(pending).rejects.toBeDefined();
    await flush();
    abort.abort();
    await failed;
    expect(mocks.release).toHaveBeenCalledOnce();
    const source = new Readable({ read() {} });
    const closed = new Promise((resolve) => source.once("close", resolve));
    opened(source);
    await closed;
    expect(source.closed).toBe(true);
  });

  it("checks lease expiry before enqueue even when the timer has not run", async () => {
    const source = new Readable({ read() {} });
    const closed = new Promise((resolve) => source.once("close", resolve));
    mocks.read.mockResolvedValue(source);
    const response = await downloadAttachment(input());
    vi.setSystemTime(Date.now() + 5_001);
    const failed = expect(response.text()).rejects.toBeDefined();
    source.push(Buffer.from("abc"));
    await failed;
    await closed;
    await flush();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(["ab", "abcd"])(
    "errors the response body on size mismatch: %s",
    async (bytes) => {
      const source = Readable.from([Buffer.from(bytes)]);
      const closed = new Promise((resolve) => source.once("close", resolve));
      mocks.read.mockResolvedValue(source);
      const response = await downloadAttachment(input());
      await expect(response.text()).rejects.toThrow("Attachment size mismatch");
      await closed;
      await flush();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it("waits for source close when a consumer cancels", async () => {
    let finishDestroy!: (error?: Error | null) => void;
    const source = new Readable({
      read() {},
      destroy(_error, callback) {
        finishDestroy = callback;
      },
    });
    mocks.read.mockResolvedValue(source);
    const response = await downloadAttachment(input());
    const cancelled = response.body!.cancel();
    await flush();
    expect(mocks.release).not.toHaveBeenCalled();
    finishDestroy();
    await cancelled;
    expect(source.closed).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
