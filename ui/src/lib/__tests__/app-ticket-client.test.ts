const mockStream = jest.fn();
let mockAppsEnabled = true;
const mockResult = jest.fn();
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => ({
  agenticAppsEnabled: mockAppsEnabled, ticketProvider: "jira", jiraTicketProject: "TEST", jiraTicketLabel: "feedback",
})[key] }));
jest.mock("@/lib/api-client", () => ({ apiClient: { createConversation: async () => ({ conversation: { _id: "test-chat" } }) } }));
jest.mock("@/lib/chat-agent-selection", () => ({ resolveUsableChatAgent: async () => ({ id: "test-agent" }) }));
jest.mock("@/lib/streaming", () => ({ createStreamAdapter: () => ({ streamMessage: mockStream, abort: jest.fn() }) }));
import { createTicketViaAgent, fetchFeedbackComponents, fetchFeedbackOptions } from "../ticket-client";

const originalFetch = global.fetch;
const submit = () => createTicketViaAgent({ request: { description: "Feedback", userEmail: "reporter@example.test", contextUrl: "https://host.example.test/projects" }, onResult: mockResult });
beforeEach(() => { jest.clearAllMocks(); mockAppsEnabled = true; });
afterAll(() => { global.fetch = originalFetch; });
it("accepts the app receipt without starting an agent", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: "42", provider: "gitlab" } }) });
  expect(await submit()).toEqual({ id: "42", provider: "gitlab", url: "" });
  expect(mockStream).not.toHaveBeenCalled();
});
it("keeps the existing agent flow for explicit no-handler responses", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { handled: false, componentId: null } }) });
  mockStream.mockImplementation(async (_request, callbacks) => callbacks.onContent("Created TEST-1 https://jira.example.test/browse/TEST-1"));
  expect((await submit())?.id).toBe("TEST-1");
  expect(mockStream).toHaveBeenCalledTimes(1);
});
it("never falls back after an app submission fails", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "App unavailable" }) });
  await expect(submit()).rejects.toThrow("App unavailable");
  expect(mockStream).not.toHaveBeenCalled();
});

it("discovers registered components independently of their feature capabilities", async () => {
  const data = { appId: null, components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) });
  expect(await fetchFeedbackComponents("https://host.example.test/chat")).toEqual(data);
  expect(new URL((global.fetch as jest.Mock).mock.calls[0][0], "https://host.example.test").searchParams.get("view")).toBe("components");
});
it.each([null, "example"])("sends the explicitly selected component %s when loading features", async componentId => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { appId: componentId, features: ["Other"] } }) });
  await fetchFeedbackOptions("https://host.example.test/chat", undefined, undefined, componentId);
  const query = new URL((global.fetch as jest.Mock).mock.calls[0][0], "https://host.example.test").searchParams;
  expect(query.has("componentId")).toBe(true);
  expect(query.get("componentId")).toBe(componentId ?? "");
});

it("does not accept features for a different component", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { appId: "secondary", features: ["Other"] } }) });
  await expect(fetchFeedbackOptions("https://host.example.test/chat", undefined, undefined, "example")).rejects.toThrow("Invalid feedback categories");
});
it("dispatches an explicit component through the server even when the legacy app flag is off", async () => {
  mockAppsEnabled = false;
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Unavailable" }) });
  await expect(createTicketViaAgent({ request: { description: "Feedback", userEmail: "reporter@example.test", contextUrl: "https://host.example.test/chat", componentId: "example" } })).rejects.toThrow("Unavailable");
  expect(mockStream).not.toHaveBeenCalled();
});

it.each(["", "   "])("rejects an empty receipt ID %j without reporting success", async id => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id, provider: "github" } }) });
  await expect(submit()).rejects.toThrow("feedback receipt");
  expect(mockResult).not.toHaveBeenCalled();
  expect(mockStream).not.toHaveBeenCalled();
});
it.each([undefined, "example"])("rejects app-owned unhandled responses for selection %s", async componentId => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { handled: false } }) });
  await expect(createTicketViaAgent({ request: { description: "Feedback", userEmail: "reporter@example.test", contextUrl: "https://host.example.test/projects", componentId } })).rejects.toThrow("feedback receipt");
  expect(mockStream).not.toHaveBeenCalled();
});
it("never accepts platform fallback for an explicitly selected app", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { handled: false, componentId: null } }) });
  await expect(createTicketViaAgent({ request: { description: "Feedback", userEmail: "reporter@example.test", contextUrl: "https://host.example.test/projects", componentId: "example" } })).rejects.toThrow("feedback receipt");
  expect(mockStream).not.toHaveBeenCalled();
});
it("resolves enhancement intent against the Jira project's supported types", async () => {
  mockAppsEnabled = false;
  mockStream.mockImplementation(async (_request, callbacks) => callbacks.onContent("Created TEST-1"));
  await createTicketViaAgent({ request: { description: "Improve navigation", issueType: "Enhancement", userEmail: "reporter@example.test", contextUrl: "https://host.example.test/chat" } });
  const prompt = mockStream.mock.calls[0][0].message;
  expect(prompt).toContain("feedback category is Enhancement");
  expect(prompt).toContain("Resolve an issue type supported by Jira project TEST");
  expect(prompt).toContain("ask the reporter instead of guessing");
  expect(prompt).not.toContain("Set the issue type to Enhancement");
});
