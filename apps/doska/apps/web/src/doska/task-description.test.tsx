import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DoskaTaskDescription } from "./task-description";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);
it("formats only the selection and preserves markdown across preview and editing", () => {
  function Form() {
    const [value, setValue] = useState("First selected last");
    return (
      <DoskaTaskDescription
        value={value}
        label="Description"
        editable
        onChange={setValue}
      />
    );
  }
  render(<Form />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.setSelectionRange(6, 14);
  fireEvent.click(screen.getByRole("button", { name: "descriptionBold" }));
  expect(input).toHaveValue("First **selected** last");
  fireEvent.click(screen.getByRole("button", { name: "descriptionPreview" }));
  expect(screen.getByText("selected").tagName).toBe("STRONG");
  fireEvent.click(screen.getByRole("button", { name: "edit" }));
  expect(screen.getByRole("textbox")).toHaveValue("First **selected** last");
});
it("renders safe links in readonly mode and excludes embedded HTML and images", () => {
  render(
    <DoskaTaskDescription
      value={
        "[Safe](https://example.com) [Unsafe](javascript:alert) ![tracking](https://example.com/tracker)\n<script>alert(1)</script>"
      }
      label="Description"
      editable={false}
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("link", { name: "Safe" })).toHaveAttribute(
    "rel",
    "noreferrer noopener",
  );
  expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "descriptionBold" })).toBeNull();
});
it("inserts a separate list without merging adjacent text", () => {
  function Form() {
    const [value, setValue] = useState("Prefix selected suffix");
    return (
      <DoskaTaskDescription
        value={value}
        label="Description"
        editable
        onChange={setValue}
      />
    );
  }
  render(<Form />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.setSelectionRange(7, 15);
  fireEvent.click(screen.getByRole("button", { name: "descriptionList" }));
  expect(input).toHaveValue("Prefix \n- selected\n suffix");
});
