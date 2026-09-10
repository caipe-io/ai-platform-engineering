/** @jest-environment jsdom */

import { render,screen } from "@testing-library/react";

const mockUsePlatformHealthProbes = jest.fn();
jest.mock("@/hooks/use-platform-health-probes",() => ({
  usePlatformHealthProbes: () => mockUsePlatformHealthProbes(),
}));

const mockUseVersion = jest.fn();
jest.mock("@/hooks/use-version",() => ({ useVersion: () => mockUseVersion() }));

import { HealthTab } from "../HealthTab";

describe("HealthTab",() => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUseVersion.mockReturnValue({
      versionInfo: {
        version: "preview",
        packageVersion: "0.2.0",
        gitCommit: "abc123456",
        buildDate: "2026-08-21T18:45:37Z",
      },
    });
    mockUsePlatformHealthProbes.mockReturnValue({
      capabilities: [{
        id: "chat-runtime",
        label: "Chat Runtime",
        description: "Chat runtime availability",
        detail: "Runtime reachable",
        group: "runtime",
        latency_ms: 12,
        required: true,
        status: "healthy",
        version: "0.5.67",
      }],
      summary: { healthy: 1,degraded: 0,down: 0,disabled: 0 },
      probes: [],
      probeSummary: { healthy: 0,total: 0 },
      status: "healthy",
      checkNow: jest.fn(),
      secondsUntilNextCheck: 30,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows build metadata first and component versions with admin health",() => {
    render(<HealthTab />);

    const buildHeading = screen.getByText("Build information");
    const statusText = screen.getByText("System Status: Healthy");
    expect(buildHeading.compareDocumentPosition(statusText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("abc123456")).toBeInTheDocument();
    expect(screen.getByText("v0.5.67")).toBeInTheDocument();
  });
});
