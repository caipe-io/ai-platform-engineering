/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
  };
});

interface SlackFetchCall {
  endpoint: string;
  cursor: string | null;
  url: string;
}

const slackCalls: SlackFetchCall[] = [];

function mockSlackFetch(handler: (call: SlackFetchCall) => unknown) {
  (global.fetch as jest.Mock).mockImplementation(async (input: string) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    const endpoint = parsed.pathname.split("/").pop() ?? "";
    const call = { endpoint, cursor: parsed.searchParams.get("cursor"), url };
    slackCalls.push(call);
    return {
      ok: true,
      status: 200,
      headers: new Map<string, string>(),
      json: async () => handler(call),
      text: async () => JSON.stringify(handler(call)),
    };
  });
}

async function makeRequest(query: string): Promise<unknown> {
  const { GET } = await import("../route");
  const response = await GET(
    new NextRequest(
      `http://localhost:3000/api/admin/slack/users/lookup?${query}`,
      { headers: { Authorization: "Bearer test-token" } },
    ),
  );
  return response.json();
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  jest.clearAllMocks();
  slackCalls.length = 0;
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "admin@example.com" },
    session: { sub: "admin-sub" },
  });
  mockRequireRbacPermission.mockResolvedValue(undefined);
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token-abcdefghijkl";
  const route = await import("../route");
  route.__resetSlackUsersLookupCacheForTests();
  const cfg = await import("@/lib/rbac/discovery-cache-config");
  cfg.__resetDiscoveryCacheConfigForTests();
  delete process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES;
});

describe("GET /api/admin/slack/users/lookup", () => {
  it("filters cached users.list results without returning email addresses", async () => {
    mockSlackFetch(() => ({
      ok: true,
      members: [
        {
          id: "U123",
          name: "alice",
          profile: { display_name: "Alice", real_name: "Alice Example", email: "alice@example.com", image_32: "https://avatar/alice.png" },
        },
        {
          id: "U456",
          name: "bob",
          profile: { display_name: "Bob", real_name: "Bob Example", first_name: "Robert", email: "bob@example.com" },
        },
      ],
      response_metadata: { next_cursor: "" },
    }));

    const warming = await makeRequest("q=ali&limit=5") as { data: { users: Array<Record<string, unknown>>; warming: boolean } };
    expect(warming.data.warming).toBe(true);
    await flushPromises();

    const body = await makeRequest("q=ali&limit=5") as { data: { users: Array<Record<string, unknown>>; cached: boolean } };
    const second = await makeRequest("q=bob&limit=5") as { data: { users: Array<Record<string, unknown>>; cached: boolean } };

    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0].endpoint).toBe("users.list");
    expect(body.data.cached).toBe(true);
    expect(body.data.users).toEqual([
      expect.objectContaining({ id: "U123", label: "Alice", avatar: "https://avatar/alice.png" }),
    ]);
    expect(body.data.users[0]).not.toHaveProperty("email");
    expect(body.data.users[0]).not.toHaveProperty("search_terms");
    expect(second.data.cached).toBe(true);
    expect(second.data.users).toEqual([
      expect.objectContaining({ id: "U456", label: "Bob" }),
    ]);
    const third = await makeRequest("q=robert&limit=5") as { data: { users: Array<Record<string, unknown>> } };
    expect(third.data.users).toEqual([
      expect.objectContaining({ id: "U456", label: "Bob" }),
    ]);
    expect(third.data.users[0]).not.toHaveProperty("email");
    expect(third.data.users[0]).not.toHaveProperty("search_terms");
  });

  it("uses users.lookupByEmail for email-shaped queries", async () => {
    mockSlackFetch(() => ({
      ok: true,
      user: {
        id: "U789",
        name: "carol",
        profile: { display_name: "Carol", email: "carol@example.com" },
      },
    }));

    const body = await makeRequest("q=carol%40example.com") as { data: { users: Array<{ id: string }> } };

    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0].endpoint).toBe("users.lookupByEmail");
    expect(body.data.users).toEqual([expect.objectContaining({ id: "U789", label: "Carol" })]);
  });

  it("filters bot lookup mode to bots and workflow-like users", async () => {
    mockSlackFetch(() => ({
      ok: true,
      members: [
        { id: "U-human", name: "human", profile: { display_name: "Human User" } },
        { id: "B-bot", name: "alertbot", is_bot: true, profile: { display_name: "Alert Bot" } },
        { id: "W-workflow", name: "deploy-workflow", profile: { display_name: "Deploy Workflow" } },
      ],
      response_metadata: { next_cursor: "" },
    }));

    await makeRequest("q=deploy&kind=bots&limit=10");
    await flushPromises();
    const body = await makeRequest("q=deploy&kind=bots&limit=10") as { data: { users: Array<{ id: string }> } };

    expect(body.data.users).toEqual([
      expect.objectContaining({ id: "W-workflow", label: "Deploy Workflow" }),
    ]);
  });

  it("requires admin UI view permission", async () => {
    mockSlackFetch(() => ({ ok: true, members: [] }));

    await makeRequest("q=alice");

    expect(mockRequireRbacPermission).toHaveBeenCalledWith({ sub: "admin-sub" }, "admin_ui", "view");
  });
});
