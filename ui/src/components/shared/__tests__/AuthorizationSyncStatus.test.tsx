import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AuthorizationSyncStatus } from "../AuthorizationSyncStatus";

describe("AuthorizationSyncStatus", () => {
  it("stays hidden for resources without reconciliation metadata", () => {
    const { container } = render(<AuthorizationSyncStatus document={{}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a quiet healthy state with plain-language detail", async () => {
    const user = userEvent.setup();
    render(
      <AuthorizationSyncStatus
        document={{
          authz_sync_state: "ready",
          authz_revision: 3,
          authz_last_synced_revision: 3,
        }}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Access synced");
    await user.hover(status);
    expect(await screen.findByText("Ownership and sharing access are in sync.")).toBeInTheDocument();
  });

  it("shows progress while a save is reconciling access", () => {
    render(
      <AuthorizationSyncStatus
        document={{ authz_sync_state: "ready" }}
        busy
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Syncing access");
  });

  it.each([
    { authz_sync_state: "error" as const },
    { authz_sync_state: "ready" as const },
    {
      authz_sync_state: "ready" as const,
      authz_revision: 4,
      authz_last_synced_revision: 3,
    },
  ])("shows a retryable state when access is not in sync", (document) => {
    render(<AuthorizationSyncStatus document={document} />);

    expect(screen.getByRole("status")).toHaveTextContent("Access sync needed");
  });
});
