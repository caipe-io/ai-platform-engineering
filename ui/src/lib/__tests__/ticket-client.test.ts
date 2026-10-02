/**
 * Unit tests for ticket-client.ts
 *
 * Tests:
 * - createTicketViaAgent creates a conversation and streams through dynamic agents
 * - Jira ticket result extraction from agent response
 * - GitHub issue result extraction from agent response
 * - Error handling when agent fails
 * - onEvent and onResult callbacks fire
 * - Abort signal cancels streaming
 * - Provider not configured throws error
 * - Label included in prompt
 */

// ============================================================================
// Mocks
// ============================================================================

let mockProvider: string | null = "jira";
let mockProject: string | null = "OPENSD";
let mockLabel: string = "caipe-reported";
let mockGithubRepo: string | null = "org/repo";
let mockGithubLabel: string = "caipe-reported";

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    switch (key) {
      case "ticketProvider":
        return mockProvider;
      case "jiraTicketProject":
        return mockProject;
      case "jiraTicketLabel":
        return mockLabel;
      case "githubTicketRepo":
        return mockGithubRepo;
      case "githubTicketLabel":
        return mockGithubLabel;
      default:
        return null;
    }
  },
}));

let mockStreamEvents: Array<{ type: string; text?: string; message?: string }> = [];
const mockStreamMessage = jest.fn(async (_params: unknown, callbacks: unknown) => {
  for (const event of mockStreamEvents) {
    if (event.type === "content") {
      callbacks.onContent?.(event.text ?? "", []);
    } else if (event.type === "done") {
      callbacks.onDone?.();
    } else if (event.type === "error") {
      callbacks.onError?.(event.message ?? "stream failed");
    }
  }
});
const mockAbort = jest.fn();

jest.mock("@/lib/chat-agent-selection", () => ({
  resolveUsableChatAgent: jest.fn().mockResolvedValue({
    id: "agent-1",
    name: "Platform Engineer",
    source: "platform-default",
  }),
}));

const mockCreateConversation = jest.fn().mockResolvedValue({
  conversation: { _id: "conv-1" },
  created: true,
});

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    createConversation: (...args: unknown[]) => mockCreateConversation(...args),
  },
}));

jest.mock("@/lib/streaming", () => ({
  createStreamAdapter: jest.fn().mockImplementation(() => {
    return {
      streamMessage: mockStreamMessage,
      abort: mockAbort,
    };
  }),
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Set up the mock stream adapter to fire events synchronously then resolve.
 */
function mockSSEEvents(events: Array<{ type: string; text?: string; turn_id?: string; message?: string }>) {
  mockStreamEvents = events;
}

// ============================================================================
// Imports — after mocks
// ============================================================================

import { createTicketViaAgent } from "../ticket-client";
import { createStreamAdapter } from "@/lib/streaming";

// ============================================================================
// Tests
// ============================================================================

describe("createTicketViaAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateConversation.mockResolvedValue({
      conversation: { _id: "conv-1" },
      created: true,
    });
    mockProvider = "jira";
    mockProject = "OPENSD";
    mockLabel = "caipe-reported";
    mockGithubRepo = "org/repo";
    mockGithubLabel = "caipe-reported";
    // Default: no events
    mockSSEEvents([]);
  });

  it("throws when provider is not configured", async () => {
    mockProvider = null;

    await expect(
      createTicketViaAgent({
        request: {
          description: "test",
          userEmail: "u@e.com",
          contextUrl: "http://localhost/chat/1",
        },
      })
    ).rejects.toThrow("Ticket provider is not configured");
  });

  it("throws when project is not configured", async () => {
    mockProvider = "jira";
    mockProject = null;

    await expect(
      createTicketViaAgent({
        request: {
          description: "test",
          userEmail: "u@e.com",
          contextUrl: "http://localhost/chat/1",
        },
      })
    ).rejects.toThrow("Ticket provider is not configured");
  });

  it("creates stream adapter with correct protocol and accessToken", async () => {
    await createTicketViaAgent({
      request: {
        description: "something broke",
        userEmail: "user@test.com",
        contextUrl: "http://localhost/chat/abc",
      },
      accessToken: "tok-123",
    });

    expect(createStreamAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "custom",
        accessToken: "tok-123",
      })
    );
  });

  it("creates conversation and streams prompt with agent context", async () => {
    await createTicketViaAgent({
      request: {
        description: "something broke",
        userEmail: "user@test.com",
        contextUrl: "http://localhost/chat/abc",
      },
      accessToken: "tok-123",
    });

    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Support Ticket Request",
        client_type: "webui",
        agent_id: "agent-1",
      })
    );
    expect(mockStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("something broke"),
        conversationId: "conv-1",
        agentId: "agent-1",
        clientContext: expect.objectContaining({ source: "webui" }),
      }),
      expect.any(Object),
    );
  });

  // Regression test for #2230: the custom stream consumer serializes only
  // `client_context` into the POST body (params.source is dropped), and the
  // backend ClientContext model requires `source` — so it MUST be inside
  // clientContext or the request fails with 422 Unprocessable Content.
  it("sends source inside clientContext so the backend does not 422", async () => {
    await createTicketViaAgent({
      request: {
        description: "something broke",
        userEmail: "user@test.com",
        contextUrl: "http://localhost/chat/abc",
      },
    });

    const callArg = mockStreamMessage.mock.calls[0][0];
    expect(callArg.clientContext).toEqual(
      expect.objectContaining({
        source: "webui",
        userEmail: "user@test.com",
        ticketProvider: "jira",
      })
    );
  });

  it("extracts Jira ticket from content events", async () => {
    mockSSEEvents([
      { type: "content", text: "Created Jira issue OPENSD-456. View at https://jira.example.com/browse/OPENSD-456" },
      { type: "done" },
    ]);

    const result = await createTicketViaAgent({
      request: {
        description: "bug",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    expect(result).toEqual({
      id: "OPENSD-456",
      url: "https://jira.example.com/browse/OPENSD-456",
      provider: "jira",
    });
  });

  it("extracts GitHub issue from content events", async () => {
    mockProvider = "github";
    mockSSEEvents([
      { type: "content", text: "Created issue #42 at https://github.com/org/repo/issues/42" },
      { type: "done" },
    ]);

    const result = await createTicketViaAgent({
      request: {
        description: "bug",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    expect(result).toEqual({
      id: "#42",
      url: "https://github.com/org/repo/issues/42",
      provider: "github",
    });
  });

  it("returns null when no final content", async () => {
    mockSSEEvents([{ type: "done" }]);

    const result = await createTicketViaAgent({
      request: {
        description: "bug",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    expect(result).toBeNull();
  });

  it("fires onEvent callback for each event", async () => {
    mockSSEEvents([
      { type: "content", text: "Working on it..." },
      { type: "done" },
    ]);

    const onEvent = jest.fn();

    await createTicketViaAgent({
      request: {
        description: "bug",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    // First arg is the event, second is the log line string
    expect(onEvent.mock.calls[0][0]).toMatchObject({ type: "content" });
    expect(onEvent.mock.calls[0][1]).toContain("content");
    expect(onEvent.mock.calls[1][0]).toMatchObject({ type: "done" });
  });

  it("fires onResult callback when ticket is extracted", async () => {
    mockSSEEvents([
      { type: "content", text: "Created OPENSD-101" },
      { type: "done" },
    ]);

    const onResult = jest.fn();

    await createTicketViaAgent({
      request: {
        description: "bug",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
      onResult,
    });

    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: "OPENSD-101", provider: "jira" })
    );
  });

  it("includes feedback context in prompt", async () => {
    await createTicketViaAgent({
      request: {
        description: "Inaccurate: it was wrong",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
        feedbackContext: {
          reason: "Inaccurate",
          additionalFeedback: "Response was wrong",
          feedbackType: "dislike",
        },
      },
    });

    const callArg = mockStreamMessage.mock.calls[0][0];
    expect(callArg.message).toContain("Jira issue in project OPENSD");
    expect(callArg.message).toContain("Feedback Type: dislike");
    expect(callArg.message).toContain("Feedback Reason: Inaccurate");
    expect(callArg.message).toContain("Additional Feedback: Response was wrong");
    expect(callArg.message).toContain(`"caipe-reported"`);
  });

  it("includes custom label in prompt", async () => {
    mockLabel = "my-custom-label";

    await createTicketViaAgent({
      request: {
        description: "test",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    const callArg = mockStreamMessage.mock.calls[0][0];
    expect(callArg.message).toContain(`"my-custom-label"`);
  });

  it("uses GitHub target when provider is github", async () => {
    mockProvider = "github";

    await createTicketViaAgent({
      request: {
        description: "test",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    const callArg = mockStreamMessage.mock.calls[0][0];
    expect(callArg.message).toContain("GitHub issue in repository org/repo");
  });

  it("extracts Jira key without URL", async () => {
    mockSSEEvents([
      { type: "content", text: "Created issue OPENSD-999 successfully." },
      { type: "done" },
    ]);

    const result = await createTicketViaAgent({
      request: {
        description: "bug",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    expect(result).toEqual({
      id: "OPENSD-999",
      url: "",
      provider: "jira",
    });
  });

  it("accumulates multiple content chunks before extracting result", async () => {
    mockSSEEvents([
      { type: "content", text: "Working on creating the issue..." },
      { type: "content", text: " Created OPENSD-200 at https://jira.example.com/browse/OPENSD-200" },
      { type: "done" },
    ]);

    const result = await createTicketViaAgent({
      request: {
        description: "multi-chunk test",
        userEmail: "u@e.com",
        contextUrl: "http://localhost/chat/1",
      },
    });

    expect(result).toEqual({
      id: "OPENSD-200",
      url: "https://jira.example.com/browse/OPENSD-200",
      provider: "jira",
    });
  });
});
