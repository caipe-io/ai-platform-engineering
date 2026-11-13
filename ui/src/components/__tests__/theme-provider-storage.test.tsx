import { act, render, screen } from "@testing-library/react";
import { useTheme } from "../theme-provider";

function CurrentTheme() {
  const { resolvedTheme } = useTheme();
  return <span>{resolvedTheme}</span>;
}

test("applies a theme selected in another same-origin app", () => {
  document.documentElement.setAttribute("data-theme-preference", "dark");
  document.documentElement.setAttribute("data-theme", "dark");
  const { unmount } = render(<CurrentTheme />);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: "nord" })));
  expect(document.documentElement.getAttribute("data-theme")).toBe("nord");
  expect(screen.getByText("nord")).toBeInTheDocument();
  unmount();
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.removeAttribute("data-theme");
});
