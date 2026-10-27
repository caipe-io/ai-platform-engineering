import { fireEvent, render, screen } from "@testing-library/react";

import { NativeExtensionAssistant } from "../NativeExtensionAssistant";

const mockResolve = jest.fn();
const mockOverlay = jest.fn((props: { assistantAgentId: string; open: boolean; onOpenChange: (open: boolean) => void }) =>
  <button onClick={() => props.onOpenChange(true)} data-open={String(props.open)}>Ask Example</button>);
jest.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { email: "test-user@example.test" } } }) }));
jest.mock("@/lib/chat-agent-selection", () => ({ resolveUsableChatAgent: (options: unknown) => mockResolve(options) }));
jest.mock("@/components/agentic-apps/AgenticAppAssistantOverlay", () => ({
  AgenticAppAssistantOverlay: (props: Parameters<typeof mockOverlay>[0]) => mockOverlay(props),
}));
const props = { assistant: { agentId: "publisher-agent", label: "Ask Example", name: "Example Assistant" }, extensionId: "example-app", pathname: "/example/detail" };
const app = { appId: "example-app", displayName: "Example", canLaunch: true, assistantAgentId: "bound-agent", assistantOverlay: "host" };
describe("NativeExtensionAssistant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue({ id: "bound-agent" });
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ item: app }) } as Response);
  });
  afterEach(() => jest.restoreAllMocks());
  it("opens a host-owned assistant for the declared agent", async () => {
    render(<NativeExtensionAssistant {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Example" }));
    expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true");
    expect(mockOverlay.mock.calls.at(-1)?.[0]).toMatchObject({ assistantAgentId: "bound-agent" });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ requestedAgentId: "bound-agent", requireAvailableAgent: true }));
  });
  it("does not render a chat when agent access is denied", async () => {
    mockResolve.mockRejectedValue(new Error("Assistant access was denied"));
    render(<NativeExtensionAssistant {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("access was denied");
    expect(mockOverlay).not.toHaveBeenCalled();
  });
  it("clears a transient fetch error while reopening and only creates chat after access succeeds", async () => {
    mockResolve.mockRejectedValueOnce(new Error("Temporary connection failure")).mockResolvedValueOnce({ id: "bound-agent" });
    render(<NativeExtensionAssistant {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary connection failure");
    expect(mockOverlay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry assistant" }));
    expect(await screen.findByRole("button", { name: "Ask Example" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("never creates conversation history for a disabled agent, including retries", async () => {
    mockResolve.mockRejectedValue(new Error("Assistant is disabled"));
    render(<NativeExtensionAssistant {...props} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry assistant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disabled");
    expect(mockOverlay).not.toHaveBeenCalled();
  });
});
