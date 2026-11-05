import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
vi.mock("@kaneo/libs", async () => {
  const { hc } = await import("hono/client");
  return {
    client: hc("https://doska.test/doska/api", {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, init),
    }),
  };
});
const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { assign } });
});
afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const context = {
  mode: "platform",
  user: { id: "u", name: "User" },
  csrfToken: "doska-csrf",
  workspaceId: "w",
  departmentId: "d",
  canCreateProject: true,
};
describe("Doska API adapter", () => {
  it("loads context before a mutation and sends Doska CSRF only on the mutation", async () => {
    const { api } = await import("./api");
    fetchMock
      .mockResolvedValueOnce(json(context))
      .mockResolvedValueOnce(json({ id: "p" }, 201))
      .mockResolvedValueOnce(json([]));
    await api.createProject({
      name: "Project",
      slug: "P",
      visibility: "private",
    });
    await api.listMyTasks();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://doska.test/doska/api/doska/context",
      "https://doska.test/doska/api/doska/projects",
      "https://doska.test/doska/api/doska/my-tasks?limit=50&offset=0&archived=false",
    ]);
    expect(
      new Headers(fetchMock.mock.calls[0]![1]?.headers).has("X-CSRF-Token"),
    ).toBe(false);
    expect(
      new Headers(fetchMock.mock.calls[1]![1]?.headers).get("X-CSRF-Token"),
    ).toBe("doska-csrf");
    expect(
      new Headers(fetchMock.mock.calls[2]![1]?.headers).has("X-CSRF-Token"),
    ).toBe(false);
  });
  it("logs out through Platform using its independent CSRF token", async () => {
    const { api } = await import("./api");
    fetchMock
      .mockResolvedValueOnce(json(context))
      .mockResolvedValueOnce(json({ csrf_token: "platform-csrf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.getContext();
    await api.logout();
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/v1/session");
    expect(fetchMock.mock.calls[2]).toEqual([
      "/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: { "X-CSRF-Token": "platform-csrf" },
        credentials: "include",
      }),
    ]);
    expect(assign).toHaveBeenCalledWith("/");
  });
  it("keeps the page and Doska token when logout fails", async () => {
    const { api } = await import("./api");
    fetchMock
      .mockResolvedValueOnce(json(context))
      .mockResolvedValueOnce(json({ csrf_token: "platform-csrf" }))
      .mockResolvedValueOnce(json({ error: "Denied" }, 403))
      .mockResolvedValueOnce(json({ id: "p" }, 201));
    await api.getContext();
    await expect(api.logout()).rejects.toMatchObject({
      status: 403,
      message: "Denied",
    });
    expect(assign).not.toHaveBeenCalled();
    await api.createProject({
      name: "Project",
      slug: "P",
      visibility: "private",
    });
    expect(
      new Headers(fetchMock.mock.calls[3]![1]?.headers).get("X-CSRF-Token"),
    ).toBe("doska-csrf");
  });
  it("returns home on expired Platform session without calling native auth", async () => {
    const { api } = await import("./api");
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await api.logout();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/session");
    expect(assign).toHaveBeenCalledWith("/");
  });
  it("aggregates member pages without truncating the assignment roster", async () => {
    const { api } = await import("./api");
    const members = Array.from({ length: 100 }, (_, i) => ({
      userId: `u${i}`,
    }));
    fetchMock
      .mockResolvedValueOnce(
        json({ owner: { userId: "owner", name: "Owner" }, members }),
      )
      .mockResolvedValueOnce(
        json({
          owner: { userId: "owner", name: "Owner" },
          members: [{ userId: "last" }],
        }),
      );
    expect((await api.listMembers("p")).members).toHaveLength(101);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("offset=100");
  });
});

it("keeps revision bodies and CSRF on column and membership mutations", async () => {
  const { api } = await import("./api");
  fetchMock
    .mockResolvedValueOnce(json(context))
    .mockResolvedValueOnce(json({ revision: 3, columns: [] }))
    .mockResolvedValueOnce(json({ id: "invite", inviteeName: "Анна" }));
  await api.updateColumn("p", "c", {
    expectedRevision: 2,
    semanticState: "completed",
    confirmIncompleteSubtasks: true,
  });
  await api.createInvitation("p", { inviteeUserId: "u", role: "observer" });
  expect(fetchMock.mock.calls[1]![1]?.method).toBe("PATCH");
  expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
    expectedRevision: 2,
    semanticState: "completed",
    confirmIncompleteSubtasks: true,
  });
  expect(
    new Headers(fetchMock.mock.calls[2]![1]?.headers).get("X-CSRF-Token"),
  ).toBe("doska-csrf");
});
it("sends employee purpose and search with explicit pagination", async () => {
  const { api } = await import("./api");
  fetchMock.mockResolvedValueOnce(json([]));
  await api.employeeOptions("p", {
    purpose: "ownership",
    search: "Иван",
    limit: 10,
    offset: 20,
  });
  const url = new URL(String(fetchMock.mock.calls[0]![0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({
    purpose: "ownership",
    q: "Иван",
    limit: "10",
    offset: "20",
  });
});

it("does not let an older context response replace the current CSRF token", async () => {
  const { api } = await import("./api");
  let resolveOld!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const old = api.getContext();
  fetchMock.mockResolvedValueOnce(json({ ...context, csrfToken: "new-csrf" }));
  await api.getContext();
  resolveOld(json({ ...context, csrfToken: "old-csrf" }));
  await old;
  fetchMock.mockResolvedValueOnce(json({ id: "p" }, 201));
  await api.createProject({
    name: "Project",
    slug: "P",
    visibility: "private",
  });
  expect(
    new Headers(fetchMock.mock.calls.at(-1)![1]?.headers).get("X-CSRF-Token"),
  ).toBe("new-csrf");
});

it("passes cancellation to context and ACL requests and rejects an aborted late response", async () => {
  const { api } = await import("./api");
  const controller = new AbortController();
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const request = api.getContext({ signal: controller.signal });
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  controller.abort();
  resolve(json(context));
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  fetchMock.mockResolvedValueOnce(json({ readContent: true }));
  const next = new AbortController();
  await api.getAccess("p", { signal: next.signal });
  expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(next.signal);
});

it("failed logout does not restore an old token over a newer context", async () => {
  const { api } = await import("./api");
  fetchMock.mockResolvedValueOnce(json(context));
  await api.getContext();
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const logout = api.logout();
  fetchMock.mockResolvedValueOnce(json({ ...context, csrfToken: "new-csrf" }));
  await api.getContext();
  resolve(json({}, 503));
  await expect(logout).rejects.toMatchObject({ status: 503 });
  fetchMock.mockResolvedValueOnce(json({ id: "p" }, 201));
  await api.createProject({
    name: "Project",
    slug: "P",
    visibility: "private",
  });
  expect(
    new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("X-CSRF-Token"),
  ).toBe("new-csrf");
});
