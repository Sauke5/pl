import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { PlatformDirectoryClient } from "./client";
import { changeSchema, departmentSchema, identitySchema } from "./dto";

const identity = {
  schema_version: 1,
  sub: "ad:provider:1234",
  name: "Сотрудник",
  state: "active",
  identity_revision: 7,
  department_state: "resolved",
  primary_department_id: "it",
  head_department_ids: [],
  observed_at: "2026-10-23T10:00:00Z",
  valid_until: "2026-10-23T12:00:00Z",
};
const event = {
  cursor: "opaque_0007",
  event_id: "event-7",
  type: "identity.changed",
  occurred_at: "2026-10-23T10:00:00Z",
  subject: identity.sub,
  identity_revision: 7,
  previous_department_id: null,
  primary_department_id: "it",
  identity,
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const token = "synthetic-test-machine-credential-only-12345";
let dir: string;
let machineTokenFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doska-directory-"));
  machineTokenFile = join(dir, "token");
  await writeFile(machineTokenFile, `${token}\n`, { mode: 0o600 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function client(fetcher: typeof fetch, extra = {}) {
  return new PlatformDirectoryClient({
    origin: "https://platform.example",
    machineTokenFile,
    fetch: fetcher,
    ...extra,
  });
}

describe("directory transport", () => {
  it("binds portable module requests to the exact installation instance", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(identity));
    const instanceID = "123e4567-e89b-42d3-a456-426614174000";
    await client(fetcher, { instanceID }).identity(identity.sub);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `https://platform.example/api/v1/modules/${instanceID}/doska-directory/identity?sub=ad%3Aprovider%3A1234`,
    );
    expect(() => client(fetcher, { instanceID: "../another-module" })).toThrow();
    expect(() => client(fetcher, { origin: "" })).toThrow();
  });

  it("uses only the fixed namespace and server credential with no browser session or redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(identity));
    expect(await client(fetcher).identity(identity.sub)).toEqual(identity);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://platform.example/api/v1/doska-directory/identity?sub=ad%3Aprovider%3A1234",
    );
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    expect(Object.keys(init!.headers!)).toEqual(["Authorization", "Accept"]);
  });

  it("preserves opaque cursors and snapshot watermarks without numeric interpretation", async () => {
    const cursor = "AAA_opaque-z9";
    const page = {
      schema_version: 1,
      items: [],
      next_cursor: "ZZZ",
      changes_cursor: "earlier_8",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(page));
    expect(await client(fetcher).employees(cursor)).toEqual(page);
    await client(fetcher).departments(cursor);
    for (const [url] of fetcher.mock.calls) {
      expect(new URL(String(url)).searchParams.get("cursor")).toBe(cursor);
      expect(new URL(String(url)).searchParams.get("limit")).toBe("100");
    }
    fetcher.mockResolvedValue(
      json({ schema_version: 1, items: [event], next_cursor: "opaque_0007" }),
    );
    await client(fetcher).changes(cursor);
    expect(
      new URL(String(fetcher.mock.calls[2]![0])).searchParams.get("after"),
    ).toBe(cursor);
  });

  it.each([
    [410, "resync_required"],
    [404, "identity_not_found"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [503, "unavailable"],
  ])("handles status %s explicitly", async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(token, { status: status as number }));
    await expect(client(fetcher).identity(identity.sub)).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("does not treat an employees 404 as a missing identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(client(fetcher).employees()).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("sanitizes transport errors and never retains a credential-bearing cause", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`failed ${token}`));
    const error = await client(fetcher)
      .identity(identity.sub)
      .catch((e: Error) => e);
    expect(String(error)).not.toContain(token);
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it.each([302, 307, 308])("rejects redirects (%s)", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status,
        headers: { location: "https://evil.example" },
      }),
    );
    await expect(client(fetcher).identity(identity.sub)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized streams, HTML, bad JSON and incorrect identity responses", async () => {
    for (const response of [
      json(identity),
      new Response("<html>"),
      new Response("{", { headers: { "content-type": "application/json" } }),
      json({ ...identity, sub: "different" }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        client(fetcher, { maxResponseBytes: 16 }).identity(identity.sub),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
    await expect(
      client(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ ...identity, sub: "different" })),
      ).identity(identity.sub),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("aborts requests at the timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error(token)),
            { once: true },
          );
        }),
    );
    await expect(
      client(fetcher, { timeoutMs: 5 }).identity(identity.sub),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each([
    "http://platform.example",
    "https://user:pass@platform.example",
    "https://platform.example/path",
    "https://platform.example/?query=1",
    "https://platform.example/#fragment",
  ])("rejects noncanonical origin %s", (origin) => {
    expect(
      () => new PlatformDirectoryClient({ origin, machineTokenFile }),
    ).toThrow("invalid_configuration");
  });

  it("rejects invalid credential files before making any request", async () => {
    await writeFile(machineTokenFile, "too short");
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).employees()).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("strict directory DTOs", () => {
  it("accepts all account states and historical timestamps without extending freshness", () => {
    for (const state of [
      "active",
      "disabled",
      "expired",
      "missing",
      "unknown",
    ]) {
      expect(identitySchema.parse({ ...identity, state }).valid_until).toBe(
        identity.valid_until,
      );
    }
    expect(
      identitySchema.safeParse({
        ...identity,
        state: "unknown",
        observed_at: "0001-01-01T00:00:00Z",
        valid_until: "0001-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });

  it.each([
    { schema_version: 2 },
    { extra: true },
    { identity_revision: Number.MAX_SAFE_INTEGER + 1 },
    { identity_revision: 1.5 },
    { state: "enabled" },
    { primary_department_id: null },
    { department_state: "ambiguous" },
    { observed_at: "yesterday" },
    { observed_at: "2026-02-30T10:00:00Z" },
    { valid_until: "2026-10-23T13:00:00Z" },
    { valid_until: "2026-10-23T09:00:00Z" },
    { valid_until: "2026-10-23T10:00:00Z" },
  ])("rejects malformed identity %j", (override) => {
    expect(identitySchema.safeParse({ ...identity, ...override }).success).toBe(
      false,
    );
  });

  it("validates department fields without inventing freshness", () => {
    const department = {
      id: "it",
      name: "ИТ",
      revision: 2,
      active: true,
      head_subjects: [identity.sub],
    };
    expect(departmentSchema.safeParse(department).success).toBe(true);
    expect(
      departmentSchema.safeParse({
        ...department,
        valid_until: identity.valid_until,
      }).success,
    ).toBe(false);
    expect(
      changeSchema.safeParse({
        cursor: "next",
        event_id: "dep-2",
        type: "department.changed",
        occurred_at: identity.observed_at,
        department,
      }).success,
    ).toBe(true);
  });

  it.each([
    { type: "unknown" },
    { subject: "other" },
    { identity_revision: 8 },
    { primary_department_id: "other" },
    { extra: true },
    { occurred_at: "invalid" },
  ])("rejects malformed/inconsistent events %j", (override) => {
    expect(changeSchema.safeParse({ ...event, ...override }).success).toBe(
      false,
    );
  });

  it("rejects a full page when an unknown event occurs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        schema_version: 1,
        items: [event, { ...event, type: "future.event" }],
        next_cursor: "next",
      }),
    );
    await expect(client(fetcher).changes()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("directory contract boundaries", () => {
  it.each([0, 10_001, 60_000, Number.NaN])(
    "rejects timeout %s outside the 10-second bound",
    (timeoutMs) => {
      expect(() => client(vi.fn<typeof fetch>(), { timeoutMs })).toThrow(
        "invalid_configuration",
      );
    },
  );

  it("accepts the maximum 10-second timeout", () => {
    expect(() =>
      client(vi.fn<typeof fetch>(), { timeoutMs: 10_000 }),
    ).not.toThrow();
  });

  it.each(["disabled", "expired", "missing", "unknown"])(
    "preserves an unobserved %s revocation",
    (state) => {
      expect(
        identitySchema.safeParse({
          ...identity,
          state,
          observed_at: "0001-01-01T00:00:00Z",
          valid_until: "0001-01-01T00:00:00Z",
        }).success,
      ).toBe(true);
      expect(
        identitySchema.safeParse({
          ...identity,
          state,
          valid_until: identity.observed_at,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects active zero freshness", () => {
    expect(
      identitySchema.safeParse({
        ...identity,
        observed_at: "0001-01-01T00:00:00Z",
        valid_until: "0001-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
