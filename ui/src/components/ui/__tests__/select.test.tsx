import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Select } from "../select";

it("keeps native form and keyboard selection behavior", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();
  render(
    <Select aria-label="Mode" defaultValue="primary" onChange={onChange} required>
      <option value="primary">Primary</option>
      <option value="secondary">Secondary</option>
    </Select>,
  );

  const select = screen.getByRole("combobox", { name: "Mode" });
  await user.selectOptions(select, "secondary");

  expect(select).toHaveValue("secondary");
  expect(select).toBeRequired();
  expect(onChange).toHaveBeenCalledTimes(1);
});
