import { describe, expect, it } from "vite-plus/test";
import { AttachmentAdmission } from "./upload-admission";

describe("attachment upload admission", () => {
  it("limits service concurrency and verified subjects independently of sessions", () => {
    const admission = new AttachmentAdmission();
    const first = admission.acquire("subject-a")!;
    expect(() => admission.acquire("subject-a")).toThrow(
      "Attachment transfer limit reached",
    );
    const second = admission.acquire("subject-b")!;
    expect(() => admission.acquire("subject-c")).toThrow(
      "Attachment transfer limit reached",
    );
    first();
    const third = admission.acquire("subject-a");
    expect(third).not.toBeNull();
    first(); // An old release cannot release a new request by the same subject.
    expect(() => admission.acquire("subject-c")).toThrow(
      "Attachment transfer limit reached",
    );
    second();
    expect(admission.acquire("subject-c")).not.toBeNull();
    third?.();
  });
});
