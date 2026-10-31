const mockStream = jest.fn();
const mockResult = jest.fn();
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => ({
  agenticAppsEnabled: true, ticketProvider: "jira", jiraTicketProject: "TEST", jiraTicketLabel: "feedback",
})[key] }));
jest.mock("@/lib/api-client", () => ({ apiClient: { createConversation: async () => ({ conversation: { _id: "test-chat" } }) } }));
jest.mock("@/lib/chat-agent-selection", () => ({ resolveUsableChatAgent: async () => ({ id: "test-agent" }) }));
jest.mock("@/lib/streaming", () => ({ createStreamAdapter: () => ({ streamMessage: mockStream, abort: jest.fn() }) }));
import { createTicketViaAgent } from "../ticket-client";

const originalFetch = global.fetch;
const submit = () => createTicketViaAgent({ request: { description: "Feedback", userEmail: "reporter@example.test", contextUrl: "https://host.example.test/projects" }, onResult: mockResult });
beforeEach(() => { jest.clearAllMocks(); });
afterAll(() => { global.fetch = originalFetch; });
it("accepts the app receipt without starting an agent", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: "42", provider: "gitlab" } }) });
  expect(await submit()).toEqual({ id: "42", provider: "gitlab", url: "" });
  expect(mockStream).not.toHaveBeenCalled();
});
it("keeps the existing agent flow for explicit no-handler responses", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { handled: false } }) });
  mockStream.mockImplementation(async (_request, callbacks) => callbacks.onContent("Created TEST-1 https://jira.example.test/browse/TEST-1"));
  expect((await submit())?.id).toBe("TEST-1");
  expect(mockStream).toHaveBeenCalledTimes(1);
});
it("never falls back after an app submission fails", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "App unavailable" }) });
  await expect(submit()).rejects.toThrow("App unavailable");
  expect(mockStream).not.toHaveBeenCalled();
});
