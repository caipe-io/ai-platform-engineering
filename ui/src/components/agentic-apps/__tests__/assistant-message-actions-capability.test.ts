import { ASSISTANT_EXTENSIONS } from "../../../../app-sdk/assistant-options.mjs";
import { createAgenticAppBridge } from "../../../../app-sdk/iframe-bridge.mjs";
import { HOST_ASSISTANT_EVENT } from "@/lib/agentic-apps/assistant-events";
import { createHostChatCapability } from "@/native-extensions/host-chat";

jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({ ChatPanel: () => null }));
jest.mock("@/store/chat-store", () => ({ useChatStore: { getState: () => ({}), setState: jest.fn() } }));

// jsdom omits structuredClone, which the native host uses to copy the configuration.
globalThis.structuredClone ??= ((value: unknown) => JSON.parse(JSON.stringify(value))) as typeof structuredClone;

const options = {
  version: "1.0" as const,
  messageActions: [{ id: "flag-answer", label: "Flag answer", icon: "flag" as const, path: "/api/example/actions/flag" }],
};

describe("native capability", () => {
  it("reports message actions next to the existing extensions", () => {
    expect(ASSISTANT_EXTENSIONS).toEqual(expect.arrayContaining(["configuration.v1", "choices.v1", "presentation.v1", "messageActions.v1"]));
    const { assistant } = createHostChatCapability("example-app", true, options);
    expect(assistant?.extensions).toContain("messageActions.v1");
  });

  it("accepts a declared action and ignores an undeclared one", () => {
    const { assistant } = createHostChatCapability("example-app", true, options);
    const seen = jest.fn();
    window.addEventListener(HOST_ASSISTANT_EVENT, seen);
    expect(() => assistant!.configure!({ version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true } } })).not.toThrow();
    expect(() => assistant!.configure!({
      version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true }, other: { visible: true } },
    })).not.toThrow();
    expect(() => assistant!.configure!({ version: "1.0", visible: true, messageActions: { "Bad Id": { visible: true } } })).toThrow();
    window.removeEventListener(HOST_ASSISTANT_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("iframe bridge", () => {
  let bridge: ReturnType<typeof createAgenticAppBridge>;
  let post: jest.SpyInstance;

  function connect(composerExtensions: string[]) {
    bridge = createAgenticAppBridge({ appId: "example-app", timeoutMs: 60_000 });
    window.dispatchEvent(new MessageEvent("message", {
      source: window.parent, origin: window.location.origin,
      data: {
        type: "caipe.agenticApp.bridge.capabilities.v1", version: "1.0", appId: "example-app",
        capabilities: { assistant: true, composerExtensions, assistantOptions: options },
      },
    }));
  }
  const configureCalls = () => post.mock.calls.filter(([message]) => message.type === "caipe.agenticApp.assistant.configure.v1");
  beforeEach(() => { post = jest.spyOn(window.parent, "postMessage").mockImplementation(() => undefined); });
  afterEach(() => { bridge?.dispose(); jest.restoreAllMocks(); });

  it("reports the capability the host advertised", () => {
    connect([...ASSISTANT_EXTENSIONS]);
    expect(bridge.getCapabilities()?.composerExtensions).toContain("messageActions.v1");
  });

  it("sends per-user visibility to a supporting host", () => {
    connect([...ASSISTANT_EXTENSIONS]);
    bridge.configureAssistant({ version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true } } });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: "caipe.agenticApp.assistant.configure.v1",
      configuration: { version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true } } },
    }), window.location.origin);
  });

  it("still sends the declared actions when the configuration also names an undeclared one", () => {
    connect([...ASSISTANT_EXTENSIONS]);
    expect(() => bridge.configureAssistant({
      version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true }, other: { visible: true } },
    })).not.toThrow();
    expect(configureCalls()).toHaveLength(1);
    expect(() => bridge.configureAssistant({ version: "1.0", visible: true, messageActions: { "Bad Id": { visible: true } } })).toThrow();
    expect(configureCalls()).toHaveLength(1);
  });

  it("refuses visibility on a host without the capability, but still configures the rest", () => {
    connect(["configuration.v1", "choices.v1", "presentation.v1"]);
    expect(() => bridge.configureAssistant({ version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true } } }))
      .toThrow("Host message actions are unsupported");
    expect(configureCalls()).toHaveLength(0);
    expect(() => bridge.configureAssistant({ version: "1.0", visible: true })).not.toThrow();
    expect(configureCalls()).toHaveLength(1);
  });
});
