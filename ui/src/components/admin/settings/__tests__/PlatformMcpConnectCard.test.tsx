/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

const mockGetConfig = jest.fn();

jest.mock("@/lib/config", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

import { PlatformMcpConnectCard } from "../PlatformMcpConnectCard";

describe("PlatformMcpConnectCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("disables the trigger and explains why when Platform MCP is disabled on this deployment", () => {
    mockGetConfig.mockReturnValue(false);
    render(<PlatformMcpConnectCard />);

    expect(screen.getByRole("button", { name: "Connect via MCP" })).toBeDisabled();
    expect(screen.getByText(/CAIPE_MCP_ENABLED=true/)).toBeInTheDocument();
  });

  it("opens the dialog with the real /api/mcp endpoint and the default Claude Code instructions", () => {
    mockGetConfig.mockReturnValue(true);
    render(<PlatformMcpConnectCard />);

    fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));

    expect(screen.getByText(/claude mcp add --transport http caipe/)).toHaveTextContent(
      "/api/mcp",
    );
  });

  it("switches to Claude Desktop and shows the mcp-remote bridge config, not a raw HTTP url", () => {
    mockGetConfig.mockReturnValue(true);
    render(<PlatformMcpConnectCard />);
    fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));

    // Radix's TabsTrigger switches on mousedown, not click (see
    // @radix-ui/react-tabs) — fireEvent.click alone never focuses the
    // trigger in jsdom, so a plain click leaves the panel unchanged.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Claude Desktop" }));

    // "mcp-remote" alone also matches the explanatory prose above the code
    // block, so match a fragment unique to the JSON snippet instead.
    expect(screen.getByText(/"command":\s*"npx"/)).toBeInTheDocument();
    expect(screen.getByText(/http-only/)).toBeInTheDocument();
  });

  it("includes the caipe_whoami test prompt so a user can confirm the connection", () => {
    mockGetConfig.mockReturnValue(true);
    render(<PlatformMcpConnectCard />);
    fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));

    expect(screen.getByText(/call caipe_whoami once/)).toBeInTheDocument();
  });

  it("disables the trigger during a simulation preview even when the feature is enabled", () => {
    mockGetConfig.mockReturnValue(true);
    render(<PlatformMcpConnectCard readOnly />);

    expect(screen.getByRole("button", { name: "Connect via MCP" })).toBeDisabled();
  });
});
