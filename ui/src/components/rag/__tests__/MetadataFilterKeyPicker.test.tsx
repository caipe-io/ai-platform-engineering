import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MetadataFilterKeyPicker } from "../MetadataFilterKeyPicker";

it("maps schema keys and the custom metadata action", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();

  render(
    <MetadataFilterKeyPicker
      keys={["source", "team"]}
      value=""
      onChange={onChange}
    />,
  );

  await user.click(
    screen.getByRole("combobox", { name: "Metadata filter key" }),
  );
  await user.click(
    screen.getByRole("option", { name: "Custom key (metadata.*)" }),
  );

  expect(onChange).toHaveBeenCalledWith("__custom__");
});
