import { act, renderHook } from "@testing-library/react";
import { useChatSessionRecovery } from "../use-chat-session-recovery";

const mockSetActivity = jest.fn();
const mockLoad = jest.fn();
const mockState = {
  activeConversationId: "example-conversation",
  conversations: [{ id: "example-conversation", participants: [{ type: "agent", id: "agent-example" }],
    messages: [{ role: "assistant", isFinal: false, turnId: "example-turn" }] }],
  streamingConversations: new Map(),
  setExternalActivity: mockSetActivity,
  loadMessagesFromServer: mockLoad,
};
jest.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { email: "member@example.test" } } }) }));
jest.mock("@/store/chat-store", () => ({ useChatStore: { getState: () => mockState } }));

async function tick(ms = 0) {
  await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); });
}
describe("app chat session recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks();
    mockState.streamingConversations.clear();
    mockState.conversations = [{ id: "example-conversation", participants: [{ type: "agent", id: "agent-example" }],
      messages: [{ role: "assistant", isFinal: false, turnId: "example-turn" }] }];
    global.fetch = jest.fn(); mockLoad.mockResolvedValue(undefined);
  });
  afterEach(() => { jest.useRealTimers(); });
  it("observes an active turn and reconciles its completed saved answer without invoking it", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ running: true, turnId: "example-turn" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ running: false }) });
    mockLoad.mockImplementation(async () => {
      if (mockLoad.mock.calls.length === 2) mockState.conversations[0].messages[0].isFinal = true;
    });
    const view = renderHook(useChatSessionRecovery);
    await tick();
    expect(mockSetActivity).toHaveBeenCalledWith("example-conversation", expect.objectContaining({ state: "running" }));
    await tick(3000);
    expect(mockSetActivity).toHaveBeenLastCalledWith("example-conversation", null);
    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect((fetch as jest.Mock).mock.calls.every(([url]) => url === "/api/v1/chat/stream/status")).toBe(true);
    view.unmount();
  });
  it("does not poll or overwrite the stream owned by the current window", async () => {
    mockState.streamingConversations.set("example-conversation", {});
    const view = renderHook(useChatSessionRecovery); await tick(4000);
    expect(fetch).not.toHaveBeenCalled(); expect(mockLoad).not.toHaveBeenCalled(); view.unmount();
  });
  it("stops on denied access without reading messages", async () => {
    (fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });
    const view = renderHook(useChatSessionRecovery); await tick(); await tick(30_000);
    expect(fetch).toHaveBeenCalledTimes(1); expect(mockLoad).not.toHaveBeenCalled(); view.unmount();
  });
  it("does not lock the composer or show saving for an inactive stale reply", async () => {
    (fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ running: false }) });
    const view = renderHook(useChatSessionRecovery); await tick(); await tick(40_000);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockSetActivity.mock.calls.every(([, activity]) => activity === null)).toBe(true);
    view.unmount();
  });
  it("does not re-add activity after a pending status request's conversation is removed", async () => {
    let finish!: (value: unknown) => void;
    (fetch as jest.Mock).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = renderHook(useChatSessionRecovery); await tick();
    mockState.conversations = []; await tick(1000);
    await act(async () => { finish({ ok: true, json: async () => ({ running: true }) }); });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockSetActivity.mock.calls.every(([, activity]) => activity === null)).toBe(true);
    view.unmount();
  });
  it("bounds recovery and clears activity when its view is disposed", async () => {
    (fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ running: true }) });
    const view = renderHook(useChatSessionRecovery); await tick();
    await tick(20 * 60_000 + 1000);
    expect(mockSetActivity).toHaveBeenLastCalledWith("example-conversation", null);
    view.unmount();
  });
});
