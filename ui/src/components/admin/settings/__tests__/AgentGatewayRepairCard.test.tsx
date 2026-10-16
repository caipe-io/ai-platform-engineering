/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentGatewayRepairCard } from "../AgentGatewayRepairCard";

describe("AgentGatewayRepairCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue(
      {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            added: ["primary"],
            migrated: ["secondary"],
            refreshed: ["existing"],
            skipped: [{ id: "conflict", reason: "conflict" }],
            migration_warnings: [
              {
                id: "conflict",
                message: "A conflicting registration requires manual review.",
              },
            ],
          },
        }),
      } as Response,
    ) as unknown as typeof fetch;
  });

  it("explains the global repair scope and requires confirmation", async () => {
    render(<AgentGatewayRepairCard isAdmin />);

    expect(screen.getByText(/global maintenance action, not a connection test/i)).toBeInTheDocument();
    expect(screen.getByText(/adds missing registrations/i)).toBeInTheDocument();
    expect(screen.getByText(/reconciles OpenFGA grants/i)).toBeInTheDocument();
    expect(screen.getByText(/does not change AgentGateway listeners or JWT policy/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Repair AgentGateway" }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /Repair all AgentGateway MCP registrations/i })).toBeInTheDocument();
    expect(screen.getByText(/not limited to a selected server/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Repair all discovered targets" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/mcp-servers/agentgateway/sync",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    });
    expect(await screen.findByText("Repair completed")).toBeInTheDocument();
    expect(screen.getByText(/Added 1, migrated 1, refreshed 1, and skipped 1/i)).toBeInTheDocument();
    expect(screen.getByText(/conflict: A conflicting registration requires manual review/i)).toBeInTheDocument();
  });

  it("disables repair during Admin access preview", () => {
    render(<AgentGatewayRepairCard isAdmin readOnly />);

    expect(screen.getByRole("button", { name: "Repair AgentGateway" })).toBeDisabled();
    expect(screen.getByText(/disabled while previewing another user's Admin access/i)).toBeInTheDocument();
  });

  it("does not render for non-admin users", () => {
    const { container } = render(<AgentGatewayRepairCard isAdmin={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
