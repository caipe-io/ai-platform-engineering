/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockListTasks = jest.fn();
const mockGetSettings = jest.fn();
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: {
    getSettings: (...a: unknown[]) => mockGetSettings(...a),
    listTasks: (...a: unknown[]) => mockListTasks(...a),
    createTask: jest.fn(),
    updateTask: jest.fn(),
    deleteTask: jest.fn(),
    triggerTask: jest.fn(),
    getTask: jest.fn(),
  },
  AutonomousApiError: class extends Error {},
}));
jest.mock("@/components/autonomous/AgentTaskAccordion", () => ({
  AgentTaskAccordion: ({ tasks }: { tasks: Array<{ id: string }> }) => (
    <div data-testid="accordion">{tasks.map((t) => t.id).join(",")}</div>
  ),
}));
jest.mock("@/components/autonomous/TaskFormDialog", () => ({
  TaskFormDialog: () => <div data-testid="task-form" />,
}));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: jest.fn() }) }));

import { MyTasksPanel } from "@/components/autonomous/MyTasksPanel";

const agents = [
  { id: "deploy-agent", name: "Deploy Agent", owner_team_slug: "primary" },
  { id: "incident-agent", name: "Incident Agent", owner_team_slug: "secondary" },
];

function task(id: string, agentId: string, owner: string) {
  return {
    id,
    name: id,
    enabled: true,
    owner_id: owner,
    dynamic_agent_id: agentId,
    trigger: { type: "cron", cron: "0 2 * * *" },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListTasks.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ minimum_schedule_interval_seconds: 1800 });
});

it("renders a section for every schedulable agent, including empty ones", async () => {
  render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
  await waitFor(() => expect(mockListTasks).toHaveBeenCalled());
  expect(await screen.findByText("Deploy Agent")).toBeInTheDocument();
  expect(screen.getByText("Incident Agent")).toBeInTheDocument();
});

it("starts every agent section collapsed", async () => {
  mockListTasks.mockResolvedValue([task("mine", "deploy-agent", "test-user@example.com")]);
  render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
  await waitFor(() => expect(mockListTasks).toHaveBeenCalled());
  await screen.findByText("Deploy Agent");
  // No task list is rendered until a section is opened.
  expect(screen.queryByTestId("accordion")).not.toBeInTheDocument();
  screen.getAllByRole("button", { expanded: false });
});

it("reveals the task list once a section is expanded", async () => {
  mockListTasks.mockResolvedValue([task("mine", "deploy-agent", "test-user@example.com")]);
  render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
  const header = await screen.findByText("Deploy Agent");
  fireEvent.click(header);
  expect(await screen.findByTestId("accordion")).toHaveTextContent("mine");
});

it("filters out tasks owned by other users", async () => {
  mockListTasks.mockResolvedValue([
    task("mine", "deploy-agent", "test-user@example.com"),
    task("theirs", "deploy-agent", "other-user@example.com"),
  ]);

  render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
  fireEvent.click(await screen.findByText("Deploy Agent"));
  const accordion = await screen.findByTestId("accordion");
  expect(accordion).toHaveTextContent("mine");
  expect(accordion).not.toHaveTextContent("theirs");
});

it("orders agents with tasks before empty agents", async () => {
  mockListTasks.mockResolvedValue([task("t1", "incident-agent", "test-user@example.com")]);

  render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
  // Sort order only settles once tasks land, so wait on the ordering itself
  // rather than on a heading that renders before the fetch resolves.
  await waitFor(() =>
    expect(screen.getAllByTestId("agent-section-name").map((n) => n.textContent)).toEqual([
      "Incident Agent",
      "Deploy Agent",
    ]),
  );
});

it("tells a member with no enabled agents to ask their team admin", async () => {
  render(<MyTasksPanel agents={[]} currentUserEmail="test-user@example.com" />);
  expect(await screen.findByText(/ask your team admin to turn on autonomous/i)).toBeInTheDocument();
});

it("shows a retry affordance when the task fetch fails", async () => {
  mockListTasks.mockRejectedValue(new Error("boom"));
  render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
  expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
});

describe("pending-ack polling", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function pendingTask() {
    return { ...task("t1", "deploy-agent", "test-user@example.com"), last_ack: { ack_status: "pending" } };
  }

  it("re-fetches while an ack is in flight so the spinner resolves itself", async () => {
    mockListTasks.mockResolvedValue([pendingTask()]);
    render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
    // Flush the initial fetch so `tasks` (and therefore the pending-ack
    // effect) has actually settled before the clock moves.
    await act(async () => { await Promise.resolve(); });
    expect(mockListTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockListTasks.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not poll once every ack has settled", async () => {
    mockListTasks.mockResolvedValue([
      { ...task("t1", "deploy-agent", "test-user@example.com"), last_ack: { ack_status: "ok" } },
    ]);
    render(<MyTasksPanel agents={agents} currentUserEmail="test-user@example.com" />);
    await act(async () => { await Promise.resolve(); });
    expect(mockListTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    expect(mockListTasks).toHaveBeenCalledTimes(1);
  });
});
