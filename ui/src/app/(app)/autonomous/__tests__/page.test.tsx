/**
 * @jest-environment jsdom
 *
 * Tests for the user-facing autonomous page (spec 2026-07-28). Every user
 * sees their own tasks grouped by usable agent. Team entitlement is managed
 * centrally from Security & Policy → Autonomous Enablement.
 */
import { render, screen } from "@testing-library/react";

jest.mock("@/components/auth-guard", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AuthGuard: ({ children }: any) => <div>{children}</div>,
}));
// Mutable so the feature-flag-off case can flip it. Using jest.resetModules()
// plus a dynamic import instead would load a SECOND React copy into the test,
// leaving the hook dispatcher null and crashing on the first useState.
let mockAutonomousEnabled = true;
jest.mock("@/lib/config", () => ({
  getConfig: (k: string) => (k === "autonomousAgentsEnabled" ? mockAutonomousEnabled : undefined),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "test-user@example.com" } }, status: "authenticated" }),
}));
jest.mock("@/components/autonomous/MyTasksPanel", () => ({
  MyTasksPanel: ({ agents }: { agents: Array<{ id: string }> }) => (
    <div data-testid="my-tasks">{agents.map((a) => a.id).join(",")}</div>
  ),
}));
import Page from "../page";

const agentsResponse = {
  success: true,
  data: {
    schedulable: [{ id: "deploy-agent", name: "Deploy Agent", owner_team_slug: "primary" }],
    eligible: true,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAutonomousEnabled = true;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => agentsResponse }) as never;
});

it("renders my tasks for a non-admin without redirecting", async () => {
  render(<Page />);
  expect(await screen.findByTestId("my-tasks")).toHaveTextContent("deploy-agent");
});

it("scrolls when the agent list exceeds the application viewport", async () => {
  render(<Page />);
  await screen.findByTestId("my-tasks");

  const heading = screen.getByRole("heading", { name: "Autonomous" });
  expect(heading.parentElement?.parentElement).toHaveClass(
    "min-h-0",
    "flex-1",
    "overflow-y-auto",
  );
});

it("still renders for an eligible team member with no enabled agents", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({
      ...agentsResponse,
      data: { ...agentsResponse.data, schedulable: [], eligible: true },
    }),
  });

  render(<Page />);
  expect(await screen.findByTestId("my-tasks")).toHaveTextContent("");
});

it("does not expose per-agent Autonomous configuration", async () => {
  render(<Page />);
  await screen.findByTestId("my-tasks");
  expect(screen.queryByRole("tab", { name: /configure/i })).not.toBeInTheDocument();
});

it("renders the disabled notice when the feature flag is off", async () => {
  mockAutonomousEnabled = false;
  render(<Page />);
  expect(await screen.findByText(/autonomous agents are disabled/i)).toBeInTheDocument();
});
