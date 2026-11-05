import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ensureAttachmentStorage, getAttachmentStore } from "./runtime";
describe("attachment storage configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["", "relative/files"])(
    "rejects unconfigured or relative root %s",
    (root) => {
      vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", root);
      expect(() => ensureAttachmentStorage()).toThrow(
        "attachment_storage_unavailable",
      );
      expect(() => getAttachmentStore()).toThrow(
        "attachment_storage_unavailable",
      );
    },
  );
  it("reuses the instance for active-write tracking and replaces only on root change", () => {
    vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", "/one");
    const store = getAttachmentStore();
    expect(getAttachmentStore()).toBe(store);
    vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", "/two");
    expect(getAttachmentStore()).not.toBe(store);
  });
});
