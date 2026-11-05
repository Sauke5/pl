import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DoskaTaskChecklists } from "./task-checklists";
import { api } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("./api", () => ({
  ApiError: class extends Error {},
  api: {
    getChecklists: vi.fn(),
    deleteChecklistItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    updateChecklistItem: vi.fn(),
  },
}));
let cache: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getChecklists).mockResolvedValue({
    taskRevision: 3,
    checklists: [
      {
        id: "l",
        title: "Work",
        position: 0,
        items: [
          { id: "a", text: "First", done: false, position: 0 },
          { id: "b", text: "Second", done: false, position: 1 },
        ],
      },
    ],
  });
  cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={cache}>
      <div role="dialog" tabIndex={-1}>
        <DoskaTaskChecklists projectId="p" taskId="t" canWork />
      </div>
    </QueryClientProvider>,
  );
});
afterEach(cleanup);
it("keeps item deletion inside a labelled disclosure and closes it on Escape", async () => {
  const trigger = await screen.findByText(
    (_, element) =>
      element?.tagName === "SUMMARY" &&
      element.getAttribute("aria-label") === "checklistActions:First",
  );
  const details = trigger.closest("details")!;
  expect(details.open).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "checklistDeleteItem:First" })
      .closest("details"),
  ).toBe(details);
  details.open = true;
  trigger.focus();
  const escape = createEvent.keyDown(trigger, {
    key: "Escape",
    cancelable: true,
  });
  fireEvent(trigger, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(details.open).toBe(false);
  expect(trigger).toHaveFocus();
  details.open = true;
  fireEvent.click(
    screen.getByRole("button", { name: "checklistDeleteItem:First" }),
  );
  await waitFor(() =>
    expect(api.deleteChecklistItem).toHaveBeenCalledWith("p", "t", "l", "a", {
      expectedRevision: 3,
    }),
  );
  expect(details.open).toBe(false);
});
it("preserves keyboard-accessible item reordering", async () => {
  const down = await screen.findByRole("button", {
    name: "checklistDown:First",
  });
  down.focus();
  fireEvent.click(down);
  await waitFor(() =>
    expect(api.reorderChecklistItems).toHaveBeenCalledWith("p", "t", "l", {
      expectedRevision: 3,
      ids: ["b", "a"],
    }),
  );
});

it("keeps item deletion clickable after Safari blur without a related target", async () => {
  const trigger = await screen.findByText(
    (_, element) =>
      element?.tagName === "SUMMARY" &&
      element.getAttribute("aria-label") === "checklistActions:First",
  );
  const menu = trigger.closest("details")!;
  menu.open = true;
  trigger.focus();
  const action = screen.getByRole("button", {
    name: "checklistDeleteItem:First",
  });
  fireEvent.pointerDown(action);
  fireEvent.blur(trigger, { relatedTarget: null });
  fireEvent.focusIn(screen.getByRole("dialog"), { relatedTarget: trigger });
  expect(menu.open).toBe(true);
  fireEvent.click(action);
  await waitFor(() =>
    expect(api.deleteChecklistItem).toHaveBeenCalledWith("p", "t", "l", "a", {
      expectedRevision: 3,
    }),
  );
  expect(menu.open).toBe(false);
});
it("keeps checklist deletion clickable after Safari blur without a related target", async () => {
  const trigger = await screen.findByText(
    (_, element) =>
      element?.tagName === "SUMMARY" &&
      element.getAttribute("aria-label") === "checklistActions:Work",
  );
  const menu = trigger.closest("details")!;
  menu.open = true;
  trigger.focus();
  const action = screen.getByRole("button", { name: "checklistDelete" });
  fireEvent.pointerDown(action);
  fireEvent.blur(trigger, { relatedTarget: null });
  fireEvent.focusIn(screen.getByRole("dialog"), { relatedTarget: trigger });
  expect(menu.open).toBe(true);
  fireEvent.click(action);
  expect(screen.getByText("checklistDeleteConfirm")).toBeInTheDocument();
  expect(menu.open).toBe(false);
});
it.each(["Work", "First"])(
  "dismisses %s actions on outside pointer and keyboard focus",
  async (name) => {
    const trigger = await screen.findByText(
      (_, element) =>
        element?.tagName === "SUMMARY" &&
        element.getAttribute("aria-label") === `checklistActions:${name}`,
    );
    const menu = trigger.closest("details")!;
    menu.open = true;
    fireEvent.pointerDown(document.body);
    expect(menu.open).toBe(false);
    menu.open = true;
    render(<button>Outside menu</button>);
    fireEvent.focusIn(screen.getByRole("button", { name: "Outside menu" }), {
      relatedTarget: trigger,
    });
    expect(menu.open).toBe(false);
  },
);

async function setChecklists(
  checklists: Awaited<ReturnType<typeof api.getChecklists>>["checklists"],
) {
  await screen.findByText("First");
  await act(async () => {
    cache.setQueryData(["doska", "checklists", "p", "t"], {
      taskRevision: 4,
      checklists,
    });
  });
  await waitFor(() =>
    expect(screen.getByRole("progressbar", { name: "Work" })).toHaveAttribute(
      "value",
      "1",
    ),
  );
}
const completedList = {
  id: "l",
  title: "Work",
  position: 0,
  items: [{ id: "a", text: "First", done: true, position: 0 }],
};
it("keeps completed lists expanded by default and allows independent manual collapse", async () => {
  await setChecklists([
    completedList,
    {
      ...completedList,
      id: "other",
      title: "Other",
      position: 1,
      items: [{ id: "b", text: "Other item", done: true, position: 0 }],
    },
    { id: "empty", title: "Empty", position: 2, items: [] },
  ]);
  const toggles = screen.getAllByRole("button", { name: "checklistCollapse" });
  expect(toggles).toHaveLength(2);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(2);
  expect(screen.getByText("Work").closest("section")).toHaveClass(
    "doska-checklist-complete",
  );
  expect(screen.getByText("Empty").closest("section")).not.toHaveClass(
    "doska-checklist-complete",
  );
  fireEvent.click(toggles[0]);
  expect(screen.queryByRole("checkbox", { name: "First" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Other item" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "checklistExpand" }));
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
});
it("keeps checklist items visible when completing the final item", async () => {
  await setChecklists([completedList]);
  vi.mocked(api.updateChecklistItem).mockResolvedValue({} as never);
  vi.mocked(api.getChecklists).mockResolvedValue({
    taskRevision: 5,
    checklists: [
      { ...completedList, items: [{ ...completedList.items[0], done: false }] },
    ],
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "First" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "First" })).not.toBeChecked(),
  );
  expect(screen.queryByRole("button", { name: "checklistExpand" })).toBeNull();
  expect(api.updateChecklistItem).toHaveBeenCalledWith("p", "t", "l", "a", {
    expectedRevision: 4,
    done: false,
  });
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "First" })).toBeEnabled(),
  );
  vi.mocked(api.getChecklists).mockResolvedValue({
    taskRevision: 6,
    checklists: [completedList],
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "First" }));
  await screen.findByRole("button", { name: "checklistCollapse" });
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
});
it("keeps an active item draft visible if the checklist becomes completed", async () => {
  fireEvent.click(
    await screen.findByRole("button", { name: "checklistEditItem:First" }),
  );
  await setChecklists([completedList]);
  expect(
    screen.getByRole("textbox", { name: "checklistItemText" }),
  ).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "First" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "checklistCollapse" }),
  ).toBeDisabled();
});

it("clears manual collapse when a checklist becomes incomplete", async () => {
  await setChecklists([completedList]);
  fireEvent.click(screen.getByRole("button", { name: "checklistCollapse" }));
  expect(screen.queryByRole("checkbox", { name: "First" })).toBeNull();
  await act(async () => {
    cache.setQueryData(["doska", "checklists", "p", "t"], {
      taskRevision: 5,
      checklists: [
        {
          ...completedList,
          items: [{ ...completedList.items[0], done: false }],
        },
      ],
    });
  });
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "First" })).not.toBeChecked(),
  );
  await setChecklists([completedList]);
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(
    screen.getByRole("button", { name: "checklistCollapse" }),
  ).toHaveAttribute("aria-expanded", "true");
});
