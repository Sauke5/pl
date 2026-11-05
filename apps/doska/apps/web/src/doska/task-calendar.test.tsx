import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { DoskaTaskCalendar } from "./task-calendar";
import type { Task, Column } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));
afterEach(cleanup);
const now = Date.parse("2026-10-23T10:00:00Z");
const tasks = [
  {
    id: "one",
    title: "Due task",
    columnId: "active",
    dueDate: "2026-10-22T12:30:00Z",
    dueDateHasTime: true,
  },
  {
    id: "done",
    title: "Completed task",
    columnId: "done",
    dueDate: "2026-10-22T12:30:00Z",
    dueDateHasTime: true,
  },
  {
    id: "none",
    title: "Undated task",
    columnId: "active",
    dueDate: null,
    dueDateHasTime: false,
  },
] as Task[];
const columns = [
  { id: "active", name: "Active", semanticState: "active" },
  { id: "done", name: "Done", semanticState: "completed" },
] as Column[];
it("opens dated and undated tasks and respects completed deadline semantics", () => {
  const onOpen = vi.fn();
  render(
    <DoskaTaskCalendar
      tasks={tasks}
      columns={columns}
      onOpen={onOpen}
      now={now}
    />,
  );
  const due = screen.getByRole("button", { name: /Due task/ });
  expect(due).toHaveClass("is-overdue");
  expect(within(due).getByText("15:30")).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Completed task/ }),
  ).not.toHaveClass("is-overdue");
  fireEvent.click(due);
  fireEvent.click(screen.getByRole("button", { name: /Undated task/ }));
  expect(onOpen.mock.calls).toEqual([["one"], ["none"]]);
});
it("navigates months and returns to Moscow today while retaining undated tasks", () => {
  render(
    <DoskaTaskCalendar
      tasks={tasks}
      columns={columns}
      onOpen={vi.fn()}
      now={now}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "calendarNextMonth" }));
  expect(screen.getByRole("heading", { name: "November 2026" })).toBeVisible();
  expect(screen.getByRole("button", { name: /Undated task/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "calendarToday" }));
  expect(screen.getByRole("heading", { name: "October 2026" })).toBeVisible();
  expect(
    screen.getByText("23", { selector: '[aria-current="date"]' }),
  ).toBeVisible();
});
