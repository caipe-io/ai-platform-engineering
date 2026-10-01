/**
 * @jest-environment jsdom
 */

import { fireEvent,render,screen } from "@testing-library/react";

import { SettingsSwitch } from "../SettingsSwitch";

describe("SettingsSwitch",() => {
  it("exposes its state and requests the inverse value when activated",() => {
    const onCheckedChange = jest.fn();
    const { rerender } = render(
      <SettingsSwitch
        checked={false}
        label="Example setting"
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch",{ name: "Example setting" });
    expect(toggle).toHaveAttribute("aria-checked","false");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    rerender(
      <SettingsSwitch
        checked
        label="Example setting"
        onCheckedChange={onCheckedChange}
      />,
    );
    expect(toggle).toHaveAttribute("aria-checked","true");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("does not request a change when disabled",() => {
    const onCheckedChange = jest.fn();
    render(
      <SettingsSwitch
        checked
        disabled
        label="Example setting"
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch",{ name: "Example setting" });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
