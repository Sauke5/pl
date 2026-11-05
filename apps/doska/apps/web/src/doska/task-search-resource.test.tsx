import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { TaskSearchResource } from "./task-search-resource";
import { emptyTaskSearch } from "./task-search-context";
import { resourceLinksApi } from "./resource-links-api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("revalidates the selected descriptor and hides cached text after access loss", async () => {
  const resolve = vi.spyOn(resourceLinksApi, "resolve").mockResolvedValue({
    index: 0,
    available: true,
    descriptor: { displayName: "Private service", objectKind: "service" },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const change = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TaskSearchResource
        filters={{
          ...emptyTaskSearch,
          projectId: "p",
          resourceId: "11111111-1111-4111-8111-111111111111",
          sourceKind: "platform",
        }}
        onChange={change}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("Private service");
  resolve.mockResolvedValue({ index: 0, available: false });
  await client.invalidateQueries({
    queryKey: ["doska", "resource-search-selection"],
  });
  await screen.findByText("resourceLinksUnavailable");
  expect(screen.queryByText("Private service")).toBeNull();
  resolve.mockRejectedValue(new Error("Offline"));
  await client.invalidateQueries({
    queryKey: ["doska", "resource-search-selection"],
  });
  await screen.findByRole("button", { name: "retry" });
  expect(screen.queryByText("Private service")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "searchResourceClear" }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith({ resourceId: "", sourceKind: "" }),
  );
});
