/** @jest-environment node */
import { findAgenticAppMessageAction, loadAssistantMessage } from "../assistant-actions";
import { getAgenticAppRoutingSnapshot } from "../config";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

const mockFindOne = jest.fn();
jest.mock("../config", () => ({ getAgenticAppRoutingSnapshot: jest.fn() }));
jest.mock("../proxy", () => ({ proxyAgenticAppRequest: jest.fn() }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: (...args: unknown[]) => mockFindOne(...args) }) }));
jest.mock("@/lib/audit", () => ({ getAuditBackend: () => ({ write: jest.fn() }) }));

const action = { id: "flag-answer", label: "Flag", icon: "flag", path: "/api/example/actions/flag" };
let app: ConfiguredAgenticApp;

beforeEach(() => {
  jest.clearAllMocks();
  app = { installation: { appId: "example-app", installed: true, enabled: true }, manifest: { ui: { assistant: {
    agentId: "example-agent", label: "Ask", name: "Example", streamPath: "/api/example/chat",
    hostOptions: { version: "1.0", messageActions: [action] } } } } } as unknown as ConfiguredAgenticApp;
  jest.mocked(getAgenticAppRoutingSnapshot).mockReturnValue([app]);
});

describe("findAgenticAppMessageAction", () => {
  it("resolves the declared action and its app-relative path", () => {
    expect(findAgenticAppMessageAction("example-agent", "flag-answer")).toEqual({
      appId: "example-app", action, path: ["api", "example", "actions", "flag"],
    });
  });

  it.each([
    ["an undeclared action", () => findAgenticAppMessageAction("example-agent", "other")],
    ["another agent", () => findAgenticAppMessageAction("other-agent", "flag-answer")],
  ])("returns null for %s", (_name, find) => {
    expect(find()).toBeNull();
  });

  it("returns null when the app does not support the web UI", () => {
    app.manifest.ui.assistant!.supportedClients = ["webex"];
    expect(findAgenticAppMessageAction("example-agent", "flag-answer")).toBeNull();
  });

  it("returns null when the app declares no actions", () => {
    delete app.manifest.ui.assistant!.hostOptions;
    expect(findAgenticAppMessageAction("example-agent", "flag-answer")).toBeNull();
  });

  it.each(["installed", "enabled"])("refuses an app that is not %s", (field) => {
    (app.installation as unknown as Record<string, boolean>)[field] = false;
    expect(() => findAgenticAppMessageAction("example-agent", "flag-answer")).toThrow();
  });

  it("refuses when two apps claim the assistant", () => {
    jest.mocked(getAgenticAppRoutingSnapshot).mockReturnValue([app, app]);
    expect(() => findAgenticAppMessageAction("example-agent", "flag-answer")).toThrow();
  });
});

describe("loadAssistantMessage", () => {
  it("returns the stored turn for an assistant message", async () => {
    mockFindOne.mockResolvedValue({ role: "assistant", metadata: { turn_id: "stored-turn" } });
    await expect(loadAssistantMessage("example-conversation", "example-message")).resolves.toEqual({ turnId: "stored-turn" });
    expect(mockFindOne).toHaveBeenCalledWith({ conversation_id: "example-conversation", message_id: "example-message" });
  });

  it.each([
    ["a missing message", null, "missing"],
    ["a user message", { role: "user", metadata: { turn_id: "t" } }, "not-assistant"],
    ["a system message", { role: "system", metadata: { turn_id: "t" } }, "not-assistant"],
    ["an assistant message without a turn", { role: "assistant", metadata: {} }, "not-assistant"],
  ])("reports %s", async (_name, stored, expected) => {
    mockFindOne.mockResolvedValue(stored);
    await expect(loadAssistantMessage("example-conversation", "example-message")).resolves.toBe(expected);
  });
});
