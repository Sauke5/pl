import { render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { DoskaTaskExcerpt } from "./task-excerpt";

it("renders nested formatting without Markdown markers or interactive links", () => {
  const { container } = render(
    <button>
      <DoskaTaskExcerpt
        value={
          "надо получить _**пи-пи**_\n\n[ссылка](https://example.com)\n\n- пункт"
        }
      />
    </button>,
  );
  expect(container.querySelector("em strong")?.textContent).toBe("пи-пи");
  expect(screen.getByRole("button").textContent).not.toContain("**");
  expect(screen.getByText("ссылка")).toBeTruthy();
  expect(container.querySelector("a, img, script")).toBeNull();
  expect(screen.getByText("• пункт")).toBeTruthy();
});
