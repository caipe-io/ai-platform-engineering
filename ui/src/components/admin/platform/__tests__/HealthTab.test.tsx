/** @jest-environment jsdom */

import { act, fireEvent, render,screen } from "@testing-library/react";

jest.mock("@/lib/config", () => ({ getConfig: () => "/logo.svg" }));

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
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { inventory: { models: 2, mcp_servers: 3, connected_credentials: 1, knowledge_sources: 0 } } }) });
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

  it("shows branded service inventory and remediation on Platform Health", async () => {
    const health = mockUsePlatformHealthProbes();
    mockUsePlatformHealthProbes.mockReturnValue({
      ...health,
      components: [
        { id: "caipe-agent-harness", label: "CAIPE Agent Harness", status: "healthy", detail: "Runtime reachable", version: null },
        { id: "scheduler", label: "CAIPE Agent Scheduler", status: "disabled", detail: "Enable SCHEDULER_ENABLED and deploy the scheduler", version: null },
        { id: "openfga", label: "OpenFGA", status: "down", detail: "Unreachable", version: null },
      ],
      probes: [
        { id: "dynamic-agents-runtime", label: "Dynamic Agents", group: "runtime", status: "down", detail: "Runtime connection refused", target: "http://runtime.example.test:8000", latency_ms: 15 },
        { id: "caipe-mongodb", label: "MongoDB", group: "storage", status: "healthy", detail: "Connected", target: "database.example.test:27017", latency_ms: 2 },
        { id: "rebac-migrations", label: "RBAC Migrations", group: "bootstrap", status: "warning", detail: "Pending migrations", target: "migration service", latency_ms: null, remediation: { href: "/admin/security", label: "Migration Assistant" } },
      ],
    });
    const { container } = render(<HealthTab />);
    await act(async () => { jest.advanceTimersByTime(0); });
    expect(screen.getByText("Connected credentials")).toBeInTheDocument();
    expect(screen.getByText("Platform Services - Readiness Checks")).toBeInTheDocument();
    expect(screen.queryByText("Platform services")).not.toBeInTheDocument();
    expect(screen.getByText("CAIPE Agent Scheduler")).toBeInTheDocument();
    expect(container.querySelectorAll('img[src="/logo.svg"]')).toHaveLength(3);
    expect(screen.getByRole("img", { name: "Not enabled" })).toBeInTheDocument();
    expect(screen.getAllByText("CAIPE Agent Harness")).toHaveLength(1);
    expect(screen.getByText("Runtime connection refused · 15ms")).toBeInTheDocument();
    expect(screen.getByText("http://runtime.example.test:8000")).toBeInTheDocument();
    expect(screen.getByText("MongoDB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to enable" })).toHaveAttribute("href", "https://caipe.io/docs/architecture/scheduler/#enable-the-scheduler");
    expect(screen.queryByText("Readiness checks")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Migration Assistant" })).toHaveAttribute("href", "/admin/security");
    fireEvent.error(screen.getByAltText("OpenFGA logo"));
    expect(screen.queryByAltText("OpenFGA logo")).not.toBeInTheDocument();
  });
});
