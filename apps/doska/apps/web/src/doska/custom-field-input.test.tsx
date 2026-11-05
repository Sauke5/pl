import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DoskaCustomFieldInput } from "./custom-field-input";
import type { CustomField } from "./custom-fields";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);
const base: CustomField = {
  id: "f",
  name: "Field",
  type: "text",
  required: false,
  defaultValue: null,
  options: null,
  position: 0,
  archivedAt: null,
};
it("offers separate false and unset values for a required boolean", () => {
  const change = vi.fn();
  render(
    <DoskaCustomFieldInput
      field={{ ...base, type: "boolean", required: true }}
      value="false"
      onChange={change}
      required
    />,
  );
  const select = screen.getByRole("combobox");
  expect(select).toHaveValue("false");
  expect(select).toBeRequired();
  fireEvent.change(select, { target: { value: "" } });
  expect(change).toHaveBeenCalledWith(null);
});
it("preserves a retired choice until explicitly removed and does not offer it again", () => {
  function Form() {
    const [value, setValue] = useState<string | null>('["Retired"]');
    return (
      <DoskaCustomFieldInput
        field={{ ...base, type: "multiselect", options: ["Current"] }}
        value={value}
        onChange={setValue}
      />
    );
  }
  render(<Form />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Retired/ }));
  expect(screen.queryByRole("checkbox", { name: /Retired/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Current" })).not.toBeChecked();
});
it("shows unavailable stored employees without exposing their identifier", () => {
  render(
    <DoskaCustomFieldInput
      field={{ ...base, type: "user" }}
      value="private-user-id"
      onChange={() => {}}
      people={[{ userId: "active", name: "Active Person" }]}
    />,
  );
  expect(
    screen.getByRole("option", { name: "unavailableMember" }),
  ).toBeTruthy();
  expect(screen.queryByText("private-user-id")).toBeNull();
  expect(screen.getByRole("option", { name: "Active Person" })).toBeTruthy();
});
