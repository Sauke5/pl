import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { runAttachmentCleanup } from "./cleanup";
const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  mark: vi.fn(),
  remove: vi.fn(),
  prune: vi.fn(),
}));
vi.mock("./metadata-cleanup", () => ({
  cleanupCandidates: mocks.candidates,
  markRemoved: mocks.mark,
}));
vi.mock("./runtime", () => ({
  getAttachmentStore: () => ({
    remove: mocks.remove,
    pruneTemporary: mocks.prune,
  }),
}));
describe("attachment cleanup", () => {
  beforeEach(() => {
    vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", "/attachments");
    mocks.candidates.mockResolvedValue([]);
    mocks.mark.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.prune.mockResolvedValue(0);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });
  it("does nothing when storage is disabled", async () => {
    vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", "");
    expect(await runAttachmentCleanup()).toEqual({ degraded: false });
    expect(mocks.candidates).not.toHaveBeenCalled();
  });
  it("retains metadata/quota on unlink failure and continues other objects", async () => {
    mocks.candidates.mockResolvedValue([
      { id: "failed", objectKey: "one" },
      { id: "success", objectKey: "two" },
      { id: "empty", objectKey: null },
    ]);
    mocks.remove.mockRejectedValueOnce(new Error("unlink failed"));
    mocks.mark.mockImplementation(async (id) => {
      if (id === "success") expect(mocks.remove).toHaveBeenCalledWith("two");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runAttachmentCleanup()).toEqual({
      degraded: true,
      failed: 1,
      removed: 2,
    });
    expect(mocks.mark.mock.calls).toEqual([
      ["success", "two"],
      ["empty", null],
    ]);
    expect(mocks.prune).toHaveBeenCalledOnce();
  });
  it("prunes only staging older than one hour and reports pruning failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_000_000);
    mocks.prune.mockRejectedValue(new Error("disk error"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runAttachmentCleanup()).toEqual({
      degraded: true,
      failed: 1,
      removed: 0,
    });
    expect(mocks.prune).toHaveBeenCalledWith(new Date(4_400_000));
  });
});
