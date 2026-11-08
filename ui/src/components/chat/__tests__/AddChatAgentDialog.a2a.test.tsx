import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddChatAgentDialog } from "../AddChatAgentDialog";
import type { ChatCoordination } from "@/hooks/use-chat-coordination";

jest.mock("@/components/ui/agent-picker", () => ({ AgentPicker: ({ value, onChange, options, ariaLabel }: { value: string; onChange: (id: string) => void; options: { value: string; label: string }[]; ariaLabel: string }) =>
  <select aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)}><option value="">Choose</option>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select> }));
it("joins an existing registry participant from chat using its namespaced ID", async () => {
  const addAgent = jest.fn().mockResolvedValue(undefined);
  const coordination = { primaryAgentId: "agent-primary", agents: [], canManage: true, available: true,
    availableAgents: [{ _id: "agent-helper", name: "Local helper" }, { _id: "a2a-remote-example", name: "Example remote", execution_harness_id: "a2a_remote" }], addAgent,
  } as unknown as ChatCoordination;
  render(<AddChatAgentDialog coordination={coordination} />);
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  expect(screen.getByRole("option", { name: "Local helper" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Example remote" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Agent source" }), { target: { value: "a2a" } });
  expect(screen.queryByRole("option", { name: "Local helper" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Coordination agent" }), { target: { value: "a2a-remote-example" } });
  fireEvent.click(screen.getByRole("button", { name: "Join chat" }));
  await waitFor(() => expect(addAgent).toHaveBeenCalledWith("a2a-remote-example", "example-remote"));
});
