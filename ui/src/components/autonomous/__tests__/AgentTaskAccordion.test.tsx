/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// RunHistory fetches on mount — stub it so the accordion renders in isolation.
jest.mock("@/components/autonomous/RunHistory", () => ({
  RunHistory: ({ taskId }: { taskId: string }) => (
    <div data-testid="run-history">{taskId}</div>
  ),
}));

import { AgentTaskAccordion } from "@/components/autonomous/AgentTaskAccordion";
import type { AutonomousTask } from "@/components/autonomous/types";

function makeTask(over: Partial<AutonomousTask> & { id: string; name: string }): AutonomousTask {
  return {
    enabled: true,
    trigger: { type: "cron", schedule: "0 9 * * *" },
    ...over,
  } as AutonomousTask;
}

const baseProps = {
  busyIds: new Set<string>(),
  runHistoryRefreshKey: 0,
  onEdit: jest.fn(),
  onDelete: jest.fn(),
  onTrigger: jest.fn(),
};

it("renders one collapsed row per task and no run history until expanded", () => {
  render(
    <AgentTaskAccordion
      {...baseProps}
      tasks={[makeTask({ id: "t1", name: "Alpha" }), makeTask({ id: "t2", name: "Beta" })]}
    />,
  );
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("Beta")).toBeInTheDocument();
  expect(screen.queryByTestId("run-history")).not.toBeInTheDocument();
});

it("expands rows independently and keeps multiple open", async () => {
  const user = userEvent.setup();
  render(
    <AgentTaskAccordion
      {...baseProps}
      tasks={[makeTask({ id: "t1", name: "Alpha" }), makeTask({ id: "t2", name: "Beta" })]}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Alpha/ }));
  expect(screen.getByTestId("run-history")).toHaveTextContent("t1");
  await user.click(screen.getByRole("button", { name: /Beta/ }));
  expect(screen.getAllByTestId("run-history").map((n) => n.textContent)).toEqual(["t1", "t2"]);
});

it("auto-expands defaultExpandedId", () => {
  render(
    <AgentTaskAccordion
      {...baseProps}
      defaultExpandedId="t2"
      tasks={[makeTask({ id: "t1", name: "Alpha" }), makeTask({ id: "t2", name: "Beta" })]}
    />,
  );
  expect(screen.getByTestId("run-history")).toHaveTextContent("t2");
});

it("renders the Thread link only when chat_conversation_id is present", async () => {
  const user = userEvent.setup();
  render(
    <AgentTaskAccordion
      {...baseProps}
      tasks={[
        makeTask({ id: "t1", name: "Alpha" }),
        makeTask({ id: "t2", name: "Beta", chat_conversation_id: "conv-2" }),
      ]}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Alpha/ }));
  await user.click(screen.getByRole("button", { name: /Beta/ }));
  const links = screen.getAllByTestId("autonomous-thread-link");
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute("href", "/chat/conv-2");
});

it("disables Run when the task is busy or disabled", async () => {
  const user = userEvent.setup();
  render(
    <AgentTaskAccordion
      {...baseProps}
      busyIds={new Set(["t1"])}
      tasks={[
        makeTask({ id: "t1", name: "Alpha" }),
        makeTask({ id: "t2", name: "Beta", enabled: false }),
      ]}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Alpha/ }));
  await user.click(screen.getByRole("button", { name: /Beta/ }));
  screen.getAllByRole("button", { name: /Run/ }).forEach((b) => expect(b).toBeDisabled());
});

it("shows the copyable hook path for webhook tasks when expanded", async () => {
  const user = userEvent.setup();
  render(
    <AgentTaskAccordion
      {...baseProps}
      tasks={[
        makeTask({
          id: "hooked",
          name: "Hooked",
          trigger: { type: "webhook", path: "/hooks/hooked" },
        }),
      ]}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Hooked/ }));
  expect(screen.getByTestId("webhook-hook-path")).toHaveTextContent(
    "/api/v1/hooks/hooked",
  );
});
