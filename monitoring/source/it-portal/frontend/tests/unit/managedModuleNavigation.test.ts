import assert from "node:assert/strict";
import test from "node:test";
import { netMapModules } from "../../src/managedModuleNavigation.ts";

test("NetMap navigation follows persisted local/external connections through outage, disable and removal", () => {
  for (const mode of ["local", "external"]) {
    for (const observed_state of [
      "running",
      "unavailable",
      "disabled",
      "pending",
    ]) {
      const instance = {
        id: "netmap",
        name: "Сеть",
        module_id: "netmap",
        mode,
        desired_state: observed_state === "disabled" ? "disabled" : "enabled",
        observed_state,
      };
      assert.deepEqual(netMapModules([instance]), [instance]);
      assert.deepEqual(
        netMapModules([{ ...instance, desired_state: "removed" }]),
        [],
      );
      assert.deepEqual(
        netMapModules([{ ...instance, observed_state: "absent" }]),
        [],
      );
      assert.deepEqual(
        netMapModules([{ ...instance, module_id: "mailcow" }]),
        [],
      );
    }
  }
  assert.deepEqual(
    netMapModules([
      {
        id: "unknown",
        name: "Другой режим",
        module_id: "netmap",
        mode: "legacy",
        desired_state: "enabled",
      },
    ]),
    [],
  );
  assert.deepEqual(netMapModules(), []);
});
