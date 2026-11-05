import React from "react";
import { fireEvent,render,screen,waitFor } from "@testing-library/react";

jest.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AgentPicker,AgentSelector } from "../AgentSelector";

const availableAgents = [
  {
    _id: "legacy-agent",
    name: "Legacy Agent",
    description: "Existing Dynamic Agent",
    enabled: true,
  },
  {
    _id: "provider-agent",
    name: "Provider Agent",
    description: "Harness Engine agent",
    enabled: true,
    execution_harness_id: "agentcore",
  },
  {
    _id: "app-agent",
    name: "App Assistant",
    enabled: true,
    presentation: { app: { id: "example-app", name: "Example Workspace", icon: "/app-icons/example-app/logo.png" }, available: true },
  },
];

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true,data: availableAgents }),
  } as Response);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AgentPicker", () => {
  it("shows legacy Dynamic Agents and Harness Engine agents in one picker", async () => {
    const onSelectAgent = jest.fn();
    render(
      <AgentPicker
        selectedAgentId="legacy-agent"
        onSelectAgent={onSelectAgent}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "Choose agent. Current agent: Legacy Agent",
    });
    expect(screen.getByLabelText("Execution harness: LangChain Deep Agents")).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.getByText("Choose an agent")).toBeInTheDocument();
    expect(screen.getByText("Existing Dynamic Agent")).toBeInTheDocument();
    expect(screen.getByText("Harness Engine agent")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Execution harness: LangChain Deep Agents")).toHaveLength(2);
    expect(screen.getByLabelText("Execution harness: Amazon Bedrock AgentCore")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Provider Agent/ }));
    expect(onSelectAgent).toHaveBeenCalledWith("provider-agent");
  });

  it("searches by agent details and harness identity", async () => {
    render(<AgentPicker selectedAgentId="legacy-agent" onSelectAgent={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Choose agent. Current agent: Legacy Agent",
      }),
    );

    const search = screen.getByRole("searchbox", { name: "Search agents or harnesses" });
    fireEvent.change(search, { target: { value: "AgentCore" } });

    expect(screen.getByText("Provider Agent")).toBeInTheDocument();
    expect(screen.queryByText("Existing Dynamic Agent")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "not available" } });
    expect(screen.getByText("No agents match your search.")).toBeInTheDocument();
  });

  it("preserves the AgentSelector export used by existing chat surfaces", async () => {
    render(<AgentSelector onSelectAgent={jest.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Choose agent. Current agent: Legacy Agent",
        }),
      ).toBeInTheDocument();
    });
  });

  it("identifies and searches an app assistant by its app without inferring a harness", async () => {
    render(<AgentPicker selectedAgentId="app-agent" onSelectAgent={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose agent. Current agent: App Assistant" }));
    expect(screen.getAllByLabelText("App: Example Workspace")).toHaveLength(2);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Example Workspace" } });
    expect(screen.getAllByText("App Assistant")).toHaveLength(2);
    expect(screen.queryByText("Legacy Agent")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Deep Agents" } });
    expect(screen.getByText("Legacy Agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^App Assistant/ })).not.toBeInTheDocument();
  });
});
