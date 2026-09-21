import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConnectorIdentityPicker } from "../ConnectorIdentityPicker";

const OPTIONS = [
  { id: "primary", label: "Primary bot" },
  { id: "secondary", label: "Secondary bot" },
];

it("maps connector identity labels to their persisted IDs", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();

  render(
    <ConnectorIdentityPicker
      options={OPTIONS}
      value="primary"
      onChange={onChange}
      ariaLabel="Webex bot"
    />,
  );

  expect(screen.getByRole("combobox", { name: "Webex bot" })).toHaveTextContent(
    "Primary bot",
  );
  await user.click(screen.getByRole("combobox", { name: "Webex bot" }));
  await user.click(screen.getByRole("option", { name: "Secondary bot" }));
  expect(onChange).toHaveBeenCalledWith("secondary");
});

it("preserves an unavailable saved identity label", () => {
  render(
    <ConnectorIdentityPicker
      options={OPTIONS}
      value="saved-bot"
      onChange={jest.fn()}
      ariaLabel="Webex bot"
    />,
  );

  expect(screen.getByRole("combobox", { name: "Webex bot" })).toHaveTextContent(
    "saved-bot",
  );
});
