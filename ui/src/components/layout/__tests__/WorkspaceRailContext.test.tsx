import { fireEvent,render,screen } from "@testing-library/react";

import {
  useWorkspaceRail,
  WorkspaceRailProvider,
} from "../WorkspaceRailContext";

const TEST_COOKIE = "test-workspace-navigation-collapsed";

function RailState(): React.ReactElement {
  const { collapsed,toggle } = useWorkspaceRail();
  return (
    <button onClick={toggle} type="button">
      {collapsed ? "Collapsed" : "Expanded"}
    </button>
  );
}

describe("WorkspaceRailProvider", () => {
  afterEach(() => {
    document.cookie = `${TEST_COOKIE}=; Path=/; Max-Age=0`;
  });

  it("uses the server-provided state on its first render", () => {
    render(
      <WorkspaceRailProvider
        collapsible
        cookieName={TEST_COOKIE}
        initialCollapsed
      >
        <RailState />
      </WorkspaceRailProvider>,
    );

    expect(screen.getByRole("button",{ name: "Collapsed" })).toBeVisible();
  });

  it("updates the rail and its persistent cookie together", () => {
    render(
      <WorkspaceRailProvider collapsible cookieName={TEST_COOKIE}>
        <RailState />
      </WorkspaceRailProvider>,
    );

    fireEvent.click(screen.getByRole("button",{ name: "Expanded" }));

    expect(screen.getByRole("button",{ name: "Collapsed" })).toBeVisible();
    expect(document.cookie).toContain(`${TEST_COOKIE}=true`);
  });
});
