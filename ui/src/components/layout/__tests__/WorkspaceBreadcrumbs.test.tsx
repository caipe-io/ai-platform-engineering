import { render, screen } from "@testing-library/react";

import { WorkspaceBreadcrumbs } from "../WorkspacePageHeader";

it("keeps hierarchy colors and icons in the shared host breadcrumb row", () => {
  render(<WorkspaceBreadcrumbs portal={false} breadcrumbs={[
    { label: "Home", href: "/" },
    { label: "Example goal", href: "/example/goal", tone: "primary", icon: "target" },
    { label: "Example area", href: "/example/area", tone: "info", icon: "layers" },
    { label: "Agent" },
  ]} />);
  const goal = screen.getByRole("link", { name: "Example goal" });
  expect(goal).toHaveClass("text-primary", "hover:opacity-80");
  expect(goal).not.toHaveClass("hover:text-foreground");
  expect(goal.querySelector("svg.lucide-target")).toBeInTheDocument();
  const area = screen.getByRole("link", { name: "Example area" });
  expect(area).toHaveClass("text-sky-600", "dark:text-sky-400");
  expect(area.querySelector("svg.lucide-layers")).toBeInTheDocument();
  expect(screen.getByText("Agent").closest('[aria-current="page"]')).toHaveClass("text-foreground");
  expect(screen.getByRole("link", { name: "Home" })).not.toHaveClass("text-primary");
});
