/** @jest-environment node */

import { NextRequest } from "next/server";

import { GET, PATCH } from "@/app/api/settings/notification-preferences/route";
import { POST as sendTest } from "@/app/api/settings/notification-preferences/test/route";

type Doc = { user_id: string; notification_preferences?: unknown };

const store = new Map<string, Doc>();
const mockPublish = jest.fn();
let currentUser: { email: string; sub: string } | null = null;

jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({
    findOne: async (filter: { user_id: string }) => store.get(filter.user_id) ?? null,
    updateOne: async (
      filter: { user_id: string },
      update: { $set: Record<string, unknown> },
    ) => {
      const existing = store.get(filter.user_id) ?? { user_id: filter.user_id };
      store.set(filter.user_id, { ...existing, ...update.$set } as Doc);
      return { acknowledged: true };
    },
  }),
}));

jest.mock("@/lib/notifications/consumer.server", () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  const session = () => {
    if (!currentUser) throw new actual.ApiError("You are not signed in.", 401, "NOT_SIGNED_IN");
    return { user: { email: currentUser.email, name: "Test User", role: "user" }, session: { sub: currentUser.sub } };
  };
  return {
    ...actual,
    getAuthFromBearerOrSession: jest.fn(async () => session()),
    withAuth: jest.fn(async (request: NextRequest, handler: (...args: unknown[]) => unknown) => {
      const { user, session: s } = session();
      return handler(request, user, s);
    }),
  };
});

function req(method: string, body?: unknown, path = "preferences"): NextRequest {
  return new NextRequest(`http://localhost/api/settings/notification-preferences${path === "preferences" ? "" : "/test"}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function view(response: Response) {
  const json = await response.json();
  return json.data as {
    events: { type: string; enabled: boolean; explicit: boolean }[];
    preferences: { categories: Record<string, boolean>; events: Record<string, boolean> };
  };
}

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  currentUser = { email: "alice@example.com", sub: "sub-alice" };
  mockPublish.mockResolvedValue("delivered");
});

describe("GET /api/settings/notification-preferences", () => {
  it("requires a signed-in user", async () => {
    currentUser = null;
    expect((await GET(req("GET"))).status).toBe(401);
  });

  it("returns every catalog event with its default for a user with no settings", async () => {
    const data = await view(await GET(req("GET")));
    expect(data.events).toHaveLength(12);
    expect(data.events.every((event) => event.explicit === false)).toBe(true);
    expect(data.events.find((e) => e.type === "workflow.completed")?.enabled).toBe(true);
    expect(data.events.find((e) => e.type === "workflow.started")?.enabled).toBe(false);
  });
});

describe("PATCH /api/settings/notification-preferences", () => {
  it("requires a signed-in user and stores nothing when unauthenticated", async () => {
    currentUser = null;
    expect((await PATCH(req("PATCH", { events: { "workflow.failed": false } }))).status).toBe(401);
    expect(store.size).toBe(0);
  });

  it("saves an override that GET then reflects", async () => {
    await PATCH(req("PATCH", { events: { "workflow.failed": false } }));
    const data = await view(await GET(req("GET")));
    expect(data.events.find((e) => e.type === "workflow.failed")).toMatchObject({ enabled: false, explicit: true });
  });

  it("keeps each user's preferences separate", async () => {
    await PATCH(req("PATCH", { categories: { workflow: false } }));

    currentUser = { email: "bob@example.com", sub: "sub-bob" };
    const bob = await view(await GET(req("GET")));
    expect(bob.events.find((e) => e.type === "workflow.completed")?.enabled).toBe(true);
    expect(store.has("bob@example.com")).toBe(false);
    expect(store.has("alice@example.com")).toBe(true);
  });

  it("ignores a user id in the body and rejects it as an unknown section", async () => {
    const response = await PATCH(req("PATCH", { user_id: "bob@example.com", events: { "workflow.failed": false } }));
    expect(response.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("is idempotent: the same request twice leaves the same stored state", async () => {
    const body = { events: { "agent.failed": false }, categories: { ingestion: true } };
    await PATCH(req("PATCH", body));
    const first = JSON.stringify(store.get("alice@example.com")?.notification_preferences);
    await PATCH(req("PATCH", body));
    expect(JSON.stringify(store.get("alice@example.com")?.notification_preferences)).toBe(first);
  });

  it("merges with existing overrides instead of replacing them", async () => {
    await PATCH(req("PATCH", { events: { "workflow.failed": false } }));
    await PATCH(req("PATCH", { events: { "agent.failed": false } }));
    const data = await view(await GET(req("GET")));
    expect(data.preferences.events).toEqual({ "workflow.failed": false, "agent.failed": false });
  });

  it("clears an override when the value is null", async () => {
    await PATCH(req("PATCH", { events: { "workflow.failed": false } }));
    await PATCH(req("PATCH", { events: { "workflow.failed": null } }));
    const data = await view(await GET(req("GET")));
    expect(data.preferences.events).toEqual({});
    expect(data.events.find((e) => e.type === "workflow.failed")).toMatchObject({ enabled: true, explicit: false });
  });

  it.each([
    ["an unknown event", { events: { "billing.paid": true } }],
    ["an unknown category", { categories: { billing: true } }],
    ["a non-boolean value", { events: { "workflow.failed": "no" } }],
    ["an unknown section", { admin: { events: {} } }],
    ["an array body", [{ events: {} }]],
    ["a string body", "events"],
  ])("rejects %s with 400 and stores nothing", async (_label, body) => {
    const response = await PATCH(req("PATCH", body));
    expect(response.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await PATCH(req("PATCH", "{not json"));
    expect(response.status).toBe(400);
    expect(store.size).toBe(0);
  });
});

describe("POST /api/settings/notification-preferences/test", () => {
  it("requires a signed-in user", async () => {
    currentUser = null;
    expect((await sendTest(req("POST", { type: "workflow.completed" }, "test"))).status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("sends one test notification to the caller, using the session identity", async () => {
    const response = await sendTest(req("POST", { type: "workflow.completed" }, "test"));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ outcome: "delivered" });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow.completed",
        recipient_subject: "sub-alice",
        recipient_email: "alice@example.com",
        data: expect.objectContaining({ status: "test", href: "/settings/notifications" }),
      }),
    );
  });

  it("cannot be aimed at someone else: recipient fields in the body are ignored", async () => {
    await sendTest(
      req("POST", { type: "workflow.completed", recipient_subject: "sub-bob", recipient_email: "bob@example.com" }, "test"),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_subject: "sub-alice", recipient_email: "alice@example.com" }),
    );
  });

  it("reports a skipped test when the user turned that event off", async () => {
    mockPublish.mockResolvedValue("disabled");
    const response = await sendTest(req("POST", { type: "workflow.started" }, "test"));
    expect((await response.json()).data).toEqual({ outcome: "disabled" });
  });

  it.each([{}, { type: "billing.paid" }, { type: 5 }, "nope"])("rejects an invalid type %p", async (body) => {
    const response = await sendTest(req("POST", body, "test"));
    expect(response.status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 503 when delivery fails", async () => {
    mockPublish.mockResolvedValue("failed");
    const response = await sendTest(req("POST", { type: "workflow.completed" }, "test"));
    expect(response.status).toBe(503);
  });

  it("limits how many tests one user can send per minute", async () => {
    currentUser = { email: "limited@example.com", sub: "sub-limited" };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await sendTest(req("POST", { type: "workflow.completed" }, "test"))).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(mockPublish).toHaveBeenCalledTimes(10);
  });

  it("does not share the limit between users", async () => {
    currentUser = { email: "busy@example.com", sub: "sub-busy" };
    for (let i = 0; i < 10; i += 1) await sendTest(req("POST", { type: "workflow.completed" }, "test"));
    currentUser = { email: "quiet@example.com", sub: "sub-quiet" };
    expect((await sendTest(req("POST", { type: "workflow.completed" }, "test"))).status).toBe(200);
  });
});
