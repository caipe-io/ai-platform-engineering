import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { requestHostAssistant } from "@/lib/agentic-apps/assistant-events";

import { NativeExtensionAssistant } from "../NativeExtensionAssistant";

const mockResolve = jest.fn();
let mockSession = { sub: "test-user", org: "example-org", role: "user", user: { email: "test-user@example.test" } };
const mockOverlay = jest.fn((props: { assistantAgentId: string; open: boolean; onOpenChange: (open: boolean) => void;
  activeContext?: { title?: string } | null }) =>
  <button onClick={() => props.onOpenChange(true)} data-open={String(props.open)}>Ask Example</button>);
jest.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: mockSession }) }));
jest.mock("@/lib/chat-agent-selection", () => ({ resolveUsableChatAgent: (options: unknown) => mockResolve(options) }));
jest.mock("@/components/agentic-apps/AgenticAppAssistantOverlay", () => ({
  AgenticAppAssistantOverlay: (props: Parameters<typeof mockOverlay>[0]) => mockOverlay(props),
}));
const props = { assistant: { agentId: "publisher-agent", label: "Ask Example", name: "Example Assistant" }, extensionId: "example-app", pathname: "/example/detail" };
const app = { appId: "example-app", displayName: "Example", canLaunch: true, assistantAgentId: "bound-agent", assistantOverlay: "host" };
function MountRequest() {
  useLayoutEffect(() => { requestHostAssistant("example-app", { route: props.pathname, title: "Mount context" }); }, []);
  return null;
}
describe("NativeExtensionAssistant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { sub: "test-user", org: "example-org", role: "user", user: { email: "test-user@example.test" } };
    mockResolve.mockResolvedValue({ id: "bound-agent" });
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ item: app }) } as Response);
  });
  afterEach(() => jest.restoreAllMocks());
  it("retains mount-time requests until the current app binding is admitted", async () => {
    render(<><NativeExtensionAssistant {...props} /><MountRequest /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true"));
    expect(mockOverlay.mock.calls.at(-1)?.[0].activeContext?.title).toBe("Mount context");
  });

  it("does not reopen a closed assistant for unrelated query changes", async () => {
    const view = render(<NativeExtensionAssistant {...props} search="assistant_chat=chat-a&view=first" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true"));
    act(() => mockOverlay.mock.calls.at(-1)?.[0].onOpenChange(false));
    view.rerender(<NativeExtensionAssistant {...props} search="assistant_chat=chat-a&view=second" />);
    expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "false");
    view.rerender(<NativeExtensionAssistant {...props} search="assistant_chat=chat-b&view=second" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true"));
  });

  it("still opens for an explicitly empty assistant_chat parameter", async () => {
    render(<NativeExtensionAssistant {...props} search="assistant_chat=" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true"));
  });

  it.each(["subject", "account", "organization", "role"])("clears prior context and open state when the %s changes", async field => {
    const view = render(<><NativeExtensionAssistant {...props} /><MountRequest /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true"));
    if (field === "subject") mockSession.sub = "secondary-user";
    if (field === "account") mockSession.user.email = "secondary-user@example.test";
    if (field === "organization") mockSession.org = "secondary-org";
    if (field === "role") mockSession.role = "admin";
    view.rerender(<><NativeExtensionAssistant {...props} /><MountRequest /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "false"));
    expect(mockOverlay.mock.calls.at(-1)?.[0].activeContext).toBeNull();
  });

  it("does not replay the previous binding's request after unmount and remount", async () => {
    const view = render(<><NativeExtensionAssistant {...props} /><MountRequest /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "true"));
    view.unmount();
    mockSession.sub = "secondary-user";
    render(<NativeExtensionAssistant {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Example" })).toHaveAttribute("data-open", "false"));
    expect(mockOverlay.mock.calls.at(-1)?.[0].activeContext).toBeNull();
  });
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
