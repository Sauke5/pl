import assert from "node:assert/strict";
import test from "node:test";
import {
  historyRows,
  historyActor,
  type Switch,
  type ModeEvent,
} from "../../src/proxyHistory.ts";

const switched: Switch = {
  at: "2026-10-15T10:55:15.098878+00:00",
  from: "relay",
  to: "final185",
  actor: "admin",
  reason: "Проверка",
};
const selected: ModeEvent = {
  at: "2026-10-15T10:55:15.099452+00:00",
  event: "mode",
  mode: "final185",
  actor: "admin",
  reason: "Проверка",
  revision: 6,
};

test("shows verified names and readable fallback without replacing stable IDs", () => {
  const event = {
    ...switched,
    actor: "ad:opaque-id",
    actor_name: "Иван Петров",
  };
  assert.equal(historyActor(event), "Иван Петров");
  assert.equal(event.actor, "ad:opaque-id");
  assert.equal(
    historyActor({ ...event, actor_name: undefined }),
    "Пользователь AD",
  );
  assert.equal(historyActor({ ...switched, actor: "automatic" }), "Автоматика");
});

test("one manual operation retains both route and mode in one row", () => {
  for (const mode of ["final185", "auto"] as const) {
    const rows = historyRows([switched, { ...selected, mode }]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].path, switched);
    assert.equal(rows[0].mode, mode);
    assert.equal(rows[0].revision, 6);
  }
});

test("distinct or ambiguous events are preserved", () => {
  for (const changed of [
    { ...selected, actor: "other" },
    { ...selected, reason: "Другая причина" },
    { ...selected, mode: "final2" as const },
    { ...selected, at: "2026-10-15T10:55:17Z" },
    { ...selected, at: "2026-10-15T10:55:14Z" },
  ])
    assert.equal(historyRows([switched, changed]).length, 2);
  assert.equal(
    historyRows([
      { ...switched, actor: "automatic" },
      { ...selected, actor: "automatic" },
    ]).length,
    2,
  );
  assert.equal(historyRows([switched]).length, 1);
  assert.equal(historyRows([selected]).length, 1);
});

test("latest events come first without mutating or losing equal-time events", () => {
  const events = Object.freeze([
    Object.freeze({ ...selected, revision: 1, at: "2026-10-15T10:00:00Z" }),
    Object.freeze({ ...selected, revision: 2, at: "2026-10-15T11:00:00Z" }),
    Object.freeze({ ...selected, revision: 3, at: "2026-10-15T11:00:00Z" }),
  ]);
  assert.deepEqual(
    historyRows(events).map((r) => r.revision),
    [3, 2, 1],
  );
  assert.equal(events[0].revision, 1);
});
