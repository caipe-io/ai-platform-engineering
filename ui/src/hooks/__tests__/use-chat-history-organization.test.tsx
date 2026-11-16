import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatHistoryOrganization } from "../use-chat-history-organization";
import { EMPTY_CHAT_ORGANIZATION } from "@/lib/chat-history-organization";

const mockGet = jest.fn();
const mockSave = jest.fn();
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => "mongodb" }));
jest.mock("@/lib/api-client", () => ({ apiClient: { getSettings: (...args: unknown[]) => mockGet(...args), updatePreferences: (...args: unknown[]) => mockSave(...args) } }));
beforeEach(() => { jest.clearAllMocks(); mockGet.mockResolvedValue({ preferences: {} }); mockSave.mockResolvedValue({}); });
it("saves folders and grouping to account preferences", async () => {
  const { result } = renderHook(() => useChatHistoryOrganization("member@example.test"));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.update(v => ({ ...v, view: "folders", folders: [{ id: "example", name: "Example" }] })); });
  expect(mockSave).toHaveBeenCalledWith({ chat_history: expect.objectContaining({ view: "folders", folders: [{ id: "example", name: "Example" }] }) });
  expect(result.current.value.folders).toHaveLength(1);
});
it("does not show the previous account's folders during an account change", async () => {
  mockGet.mockResolvedValueOnce({ preferences: { chat_history: { ...EMPTY_CHAT_ORGANIZATION, folders: [{ id: "example", name: "Example" }] } } })
    .mockReturnValueOnce(new Promise(() => {}));
  const { result, rerender } = renderHook(({ identity }) => useChatHistoryOrganization(identity), { initialProps: { identity: "first@example.test" } });
  await waitFor(() => expect(result.current.ready).toBe(true));
  rerender({ identity: "second@example.test" });
  expect(result.current.ready).toBe(false); expect(result.current.value.folders).toEqual([]);
});
it("keeps the saved state when persistence fails and allows retry", async () => {
  const { result } = renderHook(() => useChatHistoryOrganization("member@example.test"));
  await waitFor(() => expect(result.current.ready).toBe(true));
  mockSave.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => { await result.current.update(v => ({ ...v, view: "agents" })); });
  expect(result.current.value.view).toBe("ungrouped"); expect(result.current.error).toBe("Unavailable");
  await act(async () => { await result.current.update(v => ({ ...v, view: "agents" })); });
  expect(result.current.value.view).toBe("agents"); expect(result.current.error).toBe("");
});
