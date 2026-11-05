import assert from "node:assert/strict";
import test from "node:test";
import {
  loginReturnTarget,
  pendingLoginReturn,
  clearLoginReturn,
} from "../../src/loginReturn.ts";

const origin = "https://portal.example.test";
function fixture(path = "/") {
  const url = new URL(path, origin);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: url,
  });
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  return storage;
}

test("only the finite Doska page contract may be a login return", () => {
  fixture();
  for (const path of [
    "/doska/",
    "/doska/projects",
    "/doska/projects/p-1",
    "/doska/projects/api",
    "/doska/invitations",
    "/doska/management",
    "/doska/search",
    "/doska/my-tasks",
    "/doska/overview",
    "/doska/projects/p-1?taskId=task-1",
  ])
    assert.equal(loginReturnTarget(path), true, path);
  for (const path of [
    "/doska",
    "/doska/api/doska/context",
    "/doska/assets/index.js",
    "/doska/unknown",
    "/doska/projects/p/task/t",
    "/doska/projects/",
    "/doska/projects/" + "x".repeat(129),
    "/doska/../admin/",
    "/doska//projects",
    "/doska%2f",
    "/doska/projects/p?token=secret",
    "/doska/?next=https://evil.test",
    "//evil.test/doska/",
    "https://evil.test/doska/",
    "/doska/projects/p#task",
  ])
    assert.equal(loginReturnTarget(path), false, path);
});

test("pending Doska return survives the login step and rejects stale unsafe targets", () => {
  const target = "/doska/projects/project-1";
  const storage = fixture("/401?return_to=" + encodeURIComponent(target));
  assert.equal(pendingLoginReturn(), target);
  assert.equal(storage.get("pl-ui-login-return"), target);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("/", origin),
  });
  assert.equal(pendingLoginReturn(), target);
  clearLoginReturn();
  assert.equal(storage.has("pl-ui-login-return"), false);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("/?return_to=%2Fdoska%2Fapi%2Fdoska%2Fcontext", origin),
  });
  storage.set("pl-ui-login-return", target);
  pendingLoginReturn();
  assert.equal(storage.has("pl-ui-login-return"), false);
});
