import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { resourceLinksApi } from "./resource-links-api";
import { DoskaTaskResourceLinks } from "./task-resource-links";
import { ApiError } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(canWork = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DoskaTaskResourceLinks projectId="p" taskId="t" canWork={canWork} />
    </QueryClientProvider>,
  );
  return client;
}
it("shows only safe descriptors and lets observers read without mutation controls", async () => {
  vi.spyOn(resourceLinksApi, "list").mockResolvedValue({
    version: 1,
    revision: 2,
    links: [
      {
        linkId: "a",
        available: true,
        descriptor: { displayName: "Сервер", objectKind: "device" },
      },
      { linkId: "b", available: false },
    ],
  });
  const client = mount(false);
  await screen.findByText("Сервер");
  expect(screen.getByText("resourceLinksUnavailable")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "resourceLinksRemove" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "resourceLinksAdd" })).toBeNull();
  client.clear();
});
it("retries uncertain mutations with original key and revision", async () => {
  vi.spyOn(resourceLinksApi, "list").mockResolvedValue({
    version: 1,
    revision: 2,
    links: [{ linkId: "b", available: false }],
  });
  const mutate = vi
    .spyOn(resourceLinksApi, "mutate")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ version: 1, revision: 3, linkId: "b" });
  const client = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "resourceLinksRemove" }),
  );
  await screen.findByText("resourceLinksSaveError");
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
  expect(mutate.mock.calls[0][2]).toEqual(mutate.mock.calls[1][2]);
  expect(mutate.mock.calls[0][2].expectedRevision).toBe(2);
  client.clear();
});
it("refreshes conflicts and never automatically retries with a fresh revision", async () => {
  const list = vi.spyOn(resourceLinksApi, "list").mockResolvedValue({
    version: 1,
    revision: 2,
    links: [{ linkId: "b", available: false }],
  });
  const mutate = vi
    .spyOn(resourceLinksApi, "mutate")
    .mockRejectedValue(new ApiError(409, "revision_conflict"));
  const client = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "resourceLinksRemove" }),
  );
  await screen.findByText("resourceLinksConflict");
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
  client.clear();
});
it("does not search empty text and attaches only explicit selection", async () => {
  vi.spyOn(resourceLinksApi, "list").mockResolvedValue({
    version: 1,
    revision: 0,
    links: [],
  });
  const search = vi.spyOn(resourceLinksApi, "search").mockResolvedValue({
    version: 1,
    items: [
      {
        displayName: "Сервис",
        objectKind: "service",
        selection: {
          resourceId: "11111111-1111-4111-8111-111111111111",
          sourceKind: "platform",
        },
      },
    ],
    nextCursor: null,
  });
  const mutate = vi
    .spyOn(resourceLinksApi, "mutate")
    .mockResolvedValue({ version: 1, revision: 1, linkId: "l" });
  const client = mount();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "resourceLinksAdd" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "resourceLinksAdd" }));
  expect(search).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Сервис" },
  });
  const item = await screen.findByRole("button", { name: /Сервис/ });
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(item);
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(mutate.mock.calls[0][2]).toMatchObject({
    operation: "attach",
    expectedRevision: 0,
    selection: { sourceKind: "platform" },
  });
  client.clear();
});
it("hides old descriptors while policy revalidation is pending and after failure", async () => {
  const list = vi.spyOn(resourceLinksApi, "list").mockResolvedValueOnce({
    version: 1,
    revision: 1,
    links: [
      {
        linkId: "a",
        available: true,
        descriptor: { displayName: "Бывший ресурс", objectKind: "service" },
      },
    ],
  });
  const client = mount(false);
  await screen.findByText("Бывший ресурс");
  let reject: (reason: Error) => void = () => {};
  list.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  void client.invalidateQueries({
    queryKey: ["doska", "resource-links", "p", "t"],
  });
  await waitFor(() => expect(screen.queryByText("Бывший ресурс")).toBeNull());
  reject(new Error("policy unavailable"));
  await screen.findByRole("alert");
  expect(screen.queryByText("Бывший ресурс")).toBeNull();
  client.clear();
});
