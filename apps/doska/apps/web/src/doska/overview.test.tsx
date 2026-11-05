import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { api } from "./api";
import { DoskaOverview } from "./overview";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  navigate.mockClear();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DoskaOverview />
    </QueryClientProvider>,
  );
  return client;
}
it("opens exact unfinished upcoming and assignee filters without disabled pagination", async () => {
  vi.spyOn(api, "overview").mockResolvedValue({
    totals: { active: 2, overdue: 1, unassigned: 3, upcoming: 4 },
    assignees: [{ userId: "u", name: "Анна", count: 2 }],
    hasMore: false,
  });
  const client = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /overviewUpcoming/ }),
  );
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      to: "/search",
      state: expect.objectContaining({
        doskaTaskSearch: expect.objectContaining({
          filters: expect.objectContaining({
            open: true,
            upcoming: true,
            archived: false,
          }),
        }),
      }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Анна/ }));
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      state: expect.objectContaining({
        doskaTaskSearch: expect.objectContaining({
          filters: expect.objectContaining({ assigneeId: "u", open: true }),
        }),
      }),
    }),
  );
  expect(screen.queryByRole("button", { name: "next" })).toBeNull();
  client.clear();
});
it("shows failure rather than stale metrics and supports retry", async () => {
  const request = vi
    .spyOn(api, "overview")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      totals: { active: 0, overdue: 0, unassigned: 0, upcoming: 0 },
      assignees: [],
      hasMore: false,
    });
  const client = mount();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await screen.findByText("overviewNoAssigned");
  client.clear();
});
