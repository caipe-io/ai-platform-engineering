/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { PendingPublicationRequestNotice } from "../PendingPublicationRequestNotice";

describe("PendingPublicationRequestNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the requested Search audience and lets the requester withdraw", async () => {
    const onWithdrawn = jest.fn();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    render(
      <PendingPublicationRequestNotice
        request={{
          id: "request-primary",
          status: "pending",
          requested_state: { search_team_slugs: ["everyone"] },
          effective_state: { search_team_slugs: [] },
          risk_facts: {
            organization_wide: true,
            target_team_slugs: ["everyone"],
            added_team_slugs: ["everyone"],
            reasons: ["new organization-wide audience"],
          },
          requester: { subject: "test-user" },
          created_at: "2026-01-01T00:00:00.000Z",
        }}
        teams={[{ slug: "everyone", name: "Everyone" }]}
        onWithdrawn={onWithdrawn}
      />,
    );

    expect(screen.getByText("Requested Search: Everyone")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw request" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/publication-requests/request-primary/cancel",
      { method: "POST" },
    );
    expect(onWithdrawn).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith("Change request withdrawn.", "success");
  });

  it("shows a company-wide Search removal while current access remains active", () => {
    render(
      <PendingPublicationRequestNotice
        request={{
          id: "request-removal",
          status: "pending",
          requested_state: { search_team_slugs: [] },
          effective_state: { search_team_slugs: ["everyone"] },
          risk_facts: {
            organization_wide: true,
            target_team_slugs: ["everyone"],
            removed_team_slugs: ["everyone"],
            reasons: ["organization-wide audience removal"],
          },
          requester: { subject: "test-user" },
          created_at: "2026-01-01T00:00:00.000Z",
        }}
        teams={[{ slug: "everyone", name: "Everyone" }]}
      />,
    );

    expect(
      screen.getByText("Requested Search removal: Everyone"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Current Search access stays the same until this request is approved.",
      ),
    ).toBeInTheDocument();
  });
});
