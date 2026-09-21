/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { TaskFormDialog } from "@/components/autonomous/TaskFormDialog";
import type { AutonomousTask } from "@/components/autonomous/types";

function existingTask(): AutonomousTask {
  return {
    id: "daily-report-a3f9",
    name: "Daily report",
    enabled: true,
    dynamic_agent_id: "agent-x",
    prompt: "summarise",
    trigger: { type: "cron", schedule: "0 9 * * *" },
  } as AutonomousTask;
}

const saveTask = async (task: AutonomousTask) => ({ task });
const saveSecret = async (task: AutonomousTask) => task;

function renderDialog(props: Partial<ComponentProps<typeof TaskFormDialog>> = {}) {
  return render(
    <TaskFormDialog
      open
      onOpenChange={() => {}}
      initialAgentId="agent-x"
      onSubmit={saveTask}
      onSaveWebhookSecret={saveSecret}
      {...props}
    />,
  );
}

it("renders no ID input in create mode", () => {
  renderDialog();
  expect(screen.queryByLabelText(/^ID$/i)).not.toBeInTheDocument();
});

it("does not expose obsolete per-task timeout or retry controls", () => {
  renderDialog();
  expect(screen.queryByLabelText(/timeout/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/max retries/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/A2A_(TIMEOUT_SECONDS|MAX_RETRIES)/i)).not.toBeInTheDocument();
});

it("shows the id as read-only text in edit mode", () => {
  renderDialog({ task: existingTask() });
  expect(screen.getByTestId("task-id-readonly")).toHaveTextContent("daily-report-a3f9");
  expect(screen.queryByRole("textbox", { name: /^ID$/i })).not.toBeInTheDocument();
});

it("warns but does not block when the name duplicates another task", () => {
  renderDialog({ existingNames: ["Daily report"] });

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "daily REPORT" } });

  expect(screen.getByTestId("duplicate-name-warning")).toBeInTheDocument();
  // Non-blocking: the submit control stays enabled.
  expect(screen.getByRole("button", { name: /create task/i })).toBeEnabled();
});

it("does not warn for a name that is unique", () => {
  renderDialog({ existingNames: ["Something else"] });

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Daily report" } });

  expect(screen.queryByTestId("duplicate-name-warning")).not.toBeInTheDocument();
});

it("removes Generic HMAC and does not ask for a GitHub secret", () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "webhook" }));

  expect(screen.queryByRole("option", { name: /generic hmac/i })).not.toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(4);
  expect(screen.queryByLabelText(/hmac secret/i)).not.toBeInTheDocument();
  expect(screen.getByText(/generated automatically and shown once/i)).toBeInTheDocument();
});

it("stays open after GitHub creation and shows the full URL plus one-time secret", async () => {
  const onOpenChange = jest.fn();
  const onSubmit = jest.fn(async (task: AutonomousTask) => ({
    task: {
      ...task,
      id: "daily-branch-summary-41a9",
      trigger: { type: "webhook" as const, provider: "github", has_secret: true },
    },
    webhookSetupRequired: true,
    webhookSetupSecret: "generated-secret-value",
  }));
  renderDialog({ onOpenChange, onSubmit });

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Daily branch summary" } });
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "Summarize branches" } });
  fireEvent.click(screen.getByRole("button", { name: "webhook" }));
  fireEvent.click(screen.getByRole("button", { name: /create task/i }));

  expect(await screen.findByTestId("webhook-setup-step")).toBeInTheDocument();
  expect(screen.getByTestId("webhook-url-value")).toHaveTextContent(
    "http://localhost/api/v1/hooks/daily-branch-summary-41a9",
  );
  expect(screen.getByTestId("signing-secret-value")).not.toHaveTextContent("generated-secret-value");
  fireEvent.click(screen.getByRole("button", { name: /show signing secret/i }));
  expect(screen.getByTestId("signing-secret-value")).toHaveTextContent("generated-secret-value");
  expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

it("requires the provider-issued Slack secret after creation", async () => {
  const onSaveWebhookSecret = jest.fn(async (task: AutonomousTask) => task);
  const onSubmit = jest.fn(async (task: AutonomousTask) => ({
    task: {
      ...task,
      id: "slack-task-41a9",
      trigger: { type: "webhook" as const, provider: "slack", has_secret: true },
    },
    webhookSetupRequired: true,
  }));
  renderDialog({ onSubmit, onSaveWebhookSecret });

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Slack task" } });
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "Handle Slack" } });
  fireEvent.click(screen.getByRole("button", { name: "webhook" }));
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "slack" } });
  expect(screen.queryByLabelText(/signing secret/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /create task/i }));

  const secretInput = await screen.findByLabelText("Slack signing secret");
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  fireEvent.change(secretInput, { target: { value: "slack-issued-secret" } });
  fireEvent.click(screen.getByRole("button", { name: /save signing secret/i }));
  await waitFor(() => expect(onSaveWebhookSecret).toHaveBeenCalledWith(
    expect.objectContaining({ id: "slack-task-41a9" }),
    "slack-issued-secret",
  ));
  expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
});

it("continues into setup when an existing scheduled task becomes a webhook", async () => {
  const onSubmit = jest.fn(async (task: AutonomousTask) => ({
    task: {
      ...task,
      id: "daily-report-a3f9",
      trigger: { type: "webhook" as const, provider: "github", has_secret: true },
    },
    webhookSetupRequired: true,
    webhookSetupSecret: "transition-secret",
  }));
  renderDialog({ task: existingTask(), onSubmit });

  fireEvent.click(screen.getByRole("button", { name: "webhook" }));
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

  expect(await screen.findByTestId("webhook-setup-step")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show signing secret/i }));
  expect(screen.getByTestId("signing-secret-value")).toHaveTextContent("transition-secret");
});
