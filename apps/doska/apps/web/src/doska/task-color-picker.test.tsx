import { afterEach, it, expect, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DoskaTaskColorPicker } from "./task-color-picker";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);
it("opens palette, selects color and closes with focus restored", () => {
  const change = vi.fn();
  render(
    <DoskaTaskColorPicker value={null} disabled={false} onChange={change} />,
  );
  const trigger = screen.getByRole("button", { name: "cardColor" });
  fireEvent.click(trigger);
  expect(
    screen.getByRole("radio", { name: "cardColor_default" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "cardColor_blue" }));
  expect(change).toHaveBeenCalledWith("blue");
  expect(screen.queryByRole("radio")).toBeNull();
  expect(trigger).toHaveFocus();
});
it("escape closes only palette and outside pointer dismisses it", () => {
  const outer = vi.fn();
  render(
    <div role="dialog" onKeyDown={outer}>
      <DoskaTaskColorPicker value="blue" disabled={false} onChange={vi.fn()} />
      <button>Outside</button>
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "cardColor" }));
  fireEvent.keyDown(screen.getByRole("radio", { name: "cardColor_blue" }), {
    key: "Escape",
  });
  expect(outer).not.toHaveBeenCalled();
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "cardColor" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("radio")).toBeNull();
});
it("resets color to null and prevents read-only changes", () => {
  const change = vi.fn();
  const view = render(
    <DoskaTaskColorPicker value="red" disabled={false} onChange={change} />,
  );
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(screen.getByRole("radio", { name: "cardColor_default" }));
  expect(change).toHaveBeenCalledWith(null);
  view.rerender(
    <DoskaTaskColorPicker value="red" disabled onChange={change} />,
  );
  expect(screen.getByRole("button")).toBeDisabled();
});
