import { render, screen } from "@testing-library/react";
import { ChatView } from "../DynamicAgentChatView";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
const mockPanel = jest.fn();
jest.mock("../DynamicAgentChatPanel", () => ({ ChatPanel: (props: unknown) => { mockPanel(props); return <p>Shared chat</p>; } }));
jest.mock("@/components/dynamic-agents/DynamicAgentContext", () => ({ DynamicAgentContext: () => <p>Native context</p> }));
jest.mock("react-resizable-panels", () => ({ usePanelRef: () => ({ current: null }) }));
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
const agent = { _id: "example-agent", name: "Example", enabled: true,
  presentation: { app: { id: "example-app", name: "Example App", ownsRuntime: true }, available: true },
} as DynamicAgentConfig;
beforeEach(() => jest.clearAllMocks());
it("renders a registered app in ordinary chat without native runtime controls", () => {
  render(<ChatView conversationId="example-chat" selectedAgentId="example-agent" agent={agent} />);
  expect(screen.getByText("Shared chat")).toBeInTheDocument();
  expect(screen.queryByText("Native context")).toBeNull();
  expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ appOwnedRuntime: true, conversationId: "example-chat" }));
});
it("keeps native controls for a Managed overlay with no app stream", () => {
  render(<ChatView conversationId="example-chat" selectedAgentId="example-agent" agent={{ ...agent,
    presentation: { ...agent.presentation!, app: { ...agent.presentation!.app, ownsRuntime: false } } }} />);
  expect(screen.getByText("Native context")).toBeInTheDocument();
});
it("waits for server-projected agent identity before mounting native controls", () => {
  render(<ChatView conversationId="example-chat" selectedAgentId="example-agent" agent={null} />);
  expect(screen.queryByText("Native context")).toBeNull();
});
it("preserves read-only access when app launch is unavailable", () => {
  render(<ChatView conversationId="example-chat" selectedAgentId="example-agent" agent={{ ...agent,
    presentation: { ...agent.presentation!, available: false } }} />);
  expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
});
