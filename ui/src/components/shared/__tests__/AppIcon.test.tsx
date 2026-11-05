import { fireEvent, render, screen } from "@testing-library/react";
import { AgenticAppIcon } from "../AgenticAppIcon";
import { AppIcon } from "../AppIcon";

it("renders a filled app tile at the caller's size without nested icons or masks", () => {
  const { container } = render(<>
    <AgenticAppIcon className="h-4 w-4" aria-label="Primary app" />
    <AgenticAppIcon className="h-5 w-5" aria-label="Secondary app" />
  </>);
  expect(screen.getByLabelText("Primary app")).toHaveClass("lucide-app-tile", "h-4", "w-4");
  expect(screen.getByLabelText("Secondary app")).toHaveClass("h-5", "w-5");
  expect(container.querySelectorAll("mask, svg svg")).toHaveLength(0);
  expect(container.querySelectorAll('svg[fill="currentColor"] path[fill-rule="evenodd"]')).toHaveLength(2);
});

it.each([undefined, "https://example.test/logo.svg"])("uses the app tile for missing or unsafe branding: %s", icon => {
  const { container } = render(<AppIcon appId="example-app" icon={icon} className="h-5 w-5" />);
  expect(container.querySelector(".lucide-app-tile")).toHaveClass("h-5", "w-5");
  expect(container.querySelector("img")).toBeNull();
});

it("retains catalog branding and falls back to the app tile if the image fails", () => {
  const { container } = render(<AppIcon appId="example-app" icon="/app-icons/example-app/logo.png" />);
  const image = container.querySelector("img")!;
  expect(new URL(image.getAttribute("src")!, window.location.origin).pathname).toBe("/app-icons/example-app/logo.png");
  fireEvent.error(image);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".lucide-app-tile")).toBeInTheDocument();
});
