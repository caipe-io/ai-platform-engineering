import { render,screen } from "@testing-library/react";

import { WorkflowsLayoutClient } from "../layout-client";

jest.mock("@/components/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("@/components/workflows/WorkflowSidebar", () => ({
  WorkflowSidebar: () => <aside>Workflow sidebar</aside>,
}));

describe("WorkflowsLayoutClient", () => {
  it("renders the workspace hierarchy above the sidebar and content", () => {
    render(
      <WorkflowsLayoutClient>
        <div>Workflow content</div>
      </WorkflowsLayoutClient>,
    );

    const breadcrumb = screen.getByRole("navigation",{ name: "Breadcrumb" });
    expect(breadcrumb).toBeVisible();
    expect(screen.getByRole("link",{ name: "Home" })).toHaveAttribute("href","/");
    expect(screen.getByRole("link",{ name: "Workflows" })).toHaveAttribute(
      "href",
      "/workflows",
    );
    expect(screen.getByText("Workflow sidebar")).toBeVisible();
    expect(screen.getByText("Workflow content")).toBeVisible();
  });
});
