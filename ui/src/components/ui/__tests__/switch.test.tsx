import { fireEvent, render, screen } from "@testing-library/react";

import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("keeps a white thumb inside the themed track", () => {
    const onCheckedChange = jest.fn();
    const { rerender } = render(
      <Switch
        checked
        onCheckedChange={onCheckedChange}
        aria-label="Example setting"
      />,
    );

    const control = screen.getByRole("switch", { name: "Example setting" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control.firstElementChild).toHaveClass("bg-white", "translate-x-[22px]");

    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(false);

    rerender(
      <Switch
        checked={false}
        onCheckedChange={onCheckedChange}
        aria-label="Example setting"
      />,
    );
    expect(control.firstElementChild).toHaveClass("translate-x-0.5");
  });
});
