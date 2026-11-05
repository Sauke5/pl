import { expect, it } from "vite-plus/test";
import { ApiError } from "./api";
import {
  resourceCreateSearch,
  newResourceCreateAttempt,
  knownResourceCreateRejection,
} from "./resource-create-state";
const selection = {
  resourceId: "11111111-1111-4111-8111-111111111111",
  sourceKind: "platform" as const,
};
it("accepts only complete canonical resource selection URLs", () => {
  expect(resourceCreateSearch({})).toEqual({});
  expect(resourceCreateSearch(selection)).toEqual(selection);
  for (const input of [
    { resourceId: selection.resourceId },
    { ...selection, sourceKind: "other" },
    { ...selection, resourceId: [selection.resourceId] },
    { ...selection, resourceId: "javascript:alert(1)" },
  ])
    expect(resourceCreateSearch(input)).toEqual({ resourceInvalid: true });
});
it("freezes the original request content independently of subsequent draft edits", () => {
  const task = {
    title: "Original",
    columnId: "c",
    customValues: [{ fieldId: "f", value: "one" }],
  };
  const attempt = newResourceCreateAttempt(selection, task);
  task.title = "Changed";
  task.customValues[0]!.value = "two";
  expect(attempt.task.title).toBe("Original");
  expect(attempt.task.customValues?.[0]?.value).toBe("one");
  expect(attempt.clientRequestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(attempt.expectedRevision).toBe(0);
});
it("only clears a first attempt after definite rejection, not conflict or transport failure", () => {
  for (const status of [400, 401, 403, 404, 413, 422, 429])
    expect(knownResourceCreateRejection(new ApiError(status, "error"))).toBe(
      true,
    );
  for (const error of [
    new ApiError(409, "error"),
    new ApiError(500, "error"),
    new TypeError("Network"),
    new DOMException("Timeout", "TimeoutError"),
  ])
    expect(knownResourceCreateRejection(error)).toBe(false);
});
