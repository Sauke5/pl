import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DetailsMenu } from "./details-menu";

afterEach(cleanup);

it("keeps a menu open when WebKit focuses its containing dialog before the action click", () => {
  let menu!: HTMLDetailsElement;
  const action = vi.fn(() => expect(menu.open).toBe(true));
  render(
    <div role="dialog" tabIndex={-1}>
      <DetailsMenu
        ref={(element) => {
          if (element) menu = element;
        }}
      >
        <summary>Actions</summary>
        <button onClick={action}>Delete</button>
      </DetailsMenu>
      <button>Outside menu</button>
    </div>,
  );
  const trigger = screen.getByText("Actions");
  const button = screen.getByRole("button", { name: "Delete" });
  menu.open = true;
  trigger.focus();
  fireEvent.pointerDown(button);
  fireEvent.blur(trigger, { relatedTarget: null });
  fireEvent.focusIn(screen.getByRole("dialog"), { relatedTarget: trigger });
  expect(menu.open).toBe(true);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledOnce();

  menu.open = true;
  fireEvent.pointerDown(screen.getByRole("dialog"));
  expect(menu.open).toBe(false);
  menu.open = true;
  fireEvent.focusIn(screen.getByRole("button", { name: "Outside menu" }));
  expect(menu.open).toBe(false);
});
