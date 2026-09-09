/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";

const mockGetTask = jest.fn();
const mockTaskId = "repository-pr-check-1234";

jest.mock("next/navigation", () => ({
  useParams: () => ({ taskId: mockTaskId }),
}));

jest.mock("@/components/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
  },
  AutonomousApiError: class AutonomousApiError extends Error {},
}));

jest.mock("@/components/autonomous/RunHistory", () => ({
  RunHistory: (props: {
    taskId: string;
    triggerType: string;
    allowWebhookFollowUp?: boolean;
  }) => (
    <div
      data-testid="run-history"
      data-task-id={props.taskId}
      data-trigger-type={props.triggerType}
      data-follow-up={String(props.allowWebhookFollowUp)}
    />
  ),
}));

import Page from "../page";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTask.mockResolvedValue({
    id: mockTaskId,
    name: "Repository PR check",
    description: "Review new pull requests",
    agent: null,
    dynamic_agent_id: "review-agent",
    prompt: "Review the pull request",
    trigger: { type: "webhook", provider: "github", has_secret: true },
    enabled: true,
  });
});

it("renders the selected webhook task and its run history", async () => {
  render(<Page />);

  expect(await screen.findByRole("heading", { name: "Repository PR check" })).toBeVisible();
  expect(mockGetTask).toHaveBeenCalledWith(mockTaskId);
  expect(screen.getByText(/each webhook delivery has its own conversation context/i)).toBeVisible();
  expect(screen.getByTestId("run-history")).toHaveAttribute("data-task-id", mockTaskId);
  expect(screen.getByTestId("run-history")).toHaveAttribute("data-trigger-type", "webhook");
  expect(screen.getByTestId("run-history")).toHaveAttribute("data-follow-up", "true");
});

it("rejects a non-webhook task instead of rendering unrelated history", async () => {
  mockGetTask.mockResolvedValue({
    id: mockTaskId,
    name: "Scheduled task",
    trigger: { type: "cron", schedule: "0 9 * * *" },
  });

  render(<Page />);

  expect(await screen.findByText("This autonomous task is not webhook-triggered.")).toBeVisible();
  expect(screen.queryByTestId("run-history")).not.toBeInTheDocument();
});
