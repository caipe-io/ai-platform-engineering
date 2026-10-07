import { fireEvent, render, screen } from "@testing-library/react";

import { ProviderSelect } from "../provider-select";

describe("ProviderSelect", () => {
  it("maps provider values and disables an unavailable provider set", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <ProviderSelect
        ariaLabel="Example provider"
        options={[
          { provider: "primary", name: "Primary" },
          { provider: "secondary", name: "Secondary" },
        ]}
        value=""
        onChange={onChange}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Example provider" }),
      { target: { value: "secondary" } },
    );
    expect(onChange).toHaveBeenCalledWith("secondary");

    rerender(
      <ProviderSelect
        ariaLabel="Example provider"
        options={[]}
        value=""
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Example provider" }),
    ).toBeDisabled();
  });
});
