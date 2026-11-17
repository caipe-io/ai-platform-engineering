/** @jest-environment node */

import { NextRequest } from "next/server";

const mockGetServerConfig = jest.fn();
jest.mock("@/lib/config", () => ({ getServerConfig: () => mockGetServerConfig() }));

const mockWithAuth = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withAuth: (...args: unknown[]) => mockWithAuth(...args),
    withErrorHandler: <T,>(handler: (request: NextRequest) => Promise<T>) => handler,
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

function request(init?: RequestInit, query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/onboarding/product-tour${query}`, init);
}

describe("product tour route", () => {
  const platformConfig = { findOne: jest.fn() };
  const userSettings = {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerConfig.mockReturnValue({ setupWizardEnabled: true });
    platformConfig.findOne.mockResolvedValue({
      _id: "platform_settings",
      setup_wizard: { status: "completed", current_step: 5 },
    });
    userSettings.findOneAndUpdate.mockResolvedValue({
      user_id: "user@example.com",
      preferences: {},
    });
    userSettings.updateOne.mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "platform_config") return platformConfig;
      if (name === "user_settings") return userSettings;
      throw new Error(`Unexpected collection: ${name}`);
    });
    mockWithAuth.mockImplementation((_request, handler) => handler(
      _request,
      { email: "user@example.com" },
      { sub: "user-sub", user: { email: "user@example.com" } },
    ));
  });

  it("suppresses automatic tours when onboarding is disabled", async () => {
    mockGetServerConfig.mockReturnValue({ setupWizardEnabled: false });
    const { GET } = await import("../route");
    const body = await (await GET(request())).json();
    expect(body.data).toMatchObject({ auto_start: false, eligible: true });
  });

  it("offers the tour once platform setup is complete", async () => {
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(body.data).toMatchObject({
      auto_start: true,
      eligible: true,
      state: { status: "not_started", current_step: 1 },
    });
  });

  it("does not interrupt users before platform setup is complete", async () => {
    platformConfig.findOne.mockResolvedValue({
      _id: "platform_settings",
      setup_wizard: { status: "in_progress", current_step: 3 },
    });
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(body.data).toMatchObject({ auto_start: false, eligible: false });
  });

  it("does not repeat a completed tour", async () => {
    userSettings.findOneAndUpdate.mockResolvedValue({
      user_id: "user@example.com",
      preferences: {
        product_tour: { status: "completed", current_step: 5, run_count: 1 },
      },
    });
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(body.data.auto_start).toBe(false);
    expect(body.data.state.status).toBe("completed");
  });

  it("persists completion for the signed-in user", async () => {
    userSettings.findOneAndUpdate.mockResolvedValue({
      user_id: "user@example.com",
      preferences: {
        product_tour: { status: "in_progress", current_step: 4, run_count: 1 },
      },
    });
    const { PATCH } = await import("../route");
    const response = await PATCH(request({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", current_step: 5 }),
    }));
    const body = await response.json();

    expect(body.data.state).toMatchObject({ status: "completed", current_step: 5 });
    expect(userSettings.updateOne).toHaveBeenCalledWith(
      { user_id: "user@example.com" },
      {
        $set: {
          "preferences.product_tour": expect.objectContaining({ status: "completed" }),
          updated_at: expect.any(Date),
        },
      },
    );
  });
  it.each(["add-model", "add-mcp", "add-agent", "chat", "credentials"])("keeps %s on demand even after setup", async (id) => {
    const { GET } = await import("../route");
    const body = await (await GET(request(undefined, `?tour=${id}`))).json();
    expect(body.data).toMatchObject({ tour_id: id, auto_start: false, state: { status: "not_started" } });
  });

  it("loads task progress independently of the original workspace tour", async () => {
    userSettings.findOneAndUpdate.mockResolvedValue({
      user_id: "user@example.com",
      preferences: {
        product_tour: { status: "completed", current_step: 5, run_count: 2 },
        task_tours: { chat: { status: "in_progress", current_step: 3, run_count: 1 } },
      },
    });
    const { GET } = await import("../route");
    const body = await (await GET(request(undefined, "?tour=chat"))).json();
    expect(body.data.state).toMatchObject({ status: "in_progress", current_step: 3, run_count: 1 });
  });

  it("updates only the selected tour and preserves other preferences", async () => {
    const { PATCH } = await import("../route");
    await PATCH(request({ method: "PATCH", body: JSON.stringify({ tour_id: "add-model", action: "progress", current_step: 3 }) }));
    expect(userSettings.updateOne).toHaveBeenCalledWith(
      { user_id: "user@example.com" },
      { $set: { "preferences.task_tours.add-model": expect.objectContaining({ current_step: 3 }), updated_at: expect.any(Date) } },
    );
  });

  it.each(["unknown", "__proto__", "constructor", "chat.status", ""])("rejects an invalid tour id: %s", async (id) => {
    const { GET, PATCH } = await import("../route");
    await expect(GET(request(undefined, `?tour=${id}`))).rejects.toMatchObject({ statusCode: 400 });
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ tour_id: id, action: "reset" }) }))).rejects.toMatchObject({ statusCode: 400 });
    expect(userSettings.updateOne).not.toHaveBeenCalled();
  });

  it("validates steps against the selected tour length", async () => {
    const { PATCH } = await import("../route");
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ tour_id: "chat", action: "progress", current_step: 5 }) }))).rejects.toMatchObject({ statusCode: 400 });
    expect(userSettings.updateOne).not.toHaveBeenCalled();
  });

  it("completes a task tour at its final step", async () => {
    const { PATCH } = await import("../route");
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({ tour_id: "chat", action: "complete" }) }))).json();
    expect(body.data.state).toMatchObject({ status: "completed", current_step: 4 });
  });

  it("keeps existing installations enabled and returns the operator selection", async () => {
    const { GET } = await import("../route");
    const body = await (await GET(request())).json();
    expect(body.data).toMatchObject({ enabled: true, tours_enabled: true });
    expect(body.data.enabled_tours).toHaveLength(6);
  });

  it.each(["start", "progress", "reset", "complete"])("blocks %s for an operator-disabled tour", async (action) => {
    platformConfig.findOne.mockResolvedValue({ caipe_tour: { enabled_tours: [] } });
    const { GET, PATCH } = await import("../route");
    const body = await (await GET(request())).json();
    expect(body.data).toMatchObject({ enabled: false, enabled_tours: [], auto_start: false });
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ action }) }))).rejects.toMatchObject({ statusCode: 403, code: "TOUR_DISABLED" });
    expect(userSettings.updateOne).not.toHaveBeenCalled();
  });

  it.each(["start", "progress", "reset", "complete"])("blocks %s when the platform switch is off and keeps the allowlist", async (action) => {
    platformConfig.findOne.mockResolvedValue({ caipe_tour: { enabled: false, enabled_tours: ["workspace", "chat"] } });
    const { GET, PATCH } = await import("../route");
    expect((await (await GET(request())).json()).data).toMatchObject({ enabled: false, platform_enabled: false, tours_enabled: true, enabled_tours: ["workspace", "chat"], auto_start: false });
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ action }) }))).rejects.toMatchObject({ statusCode: 403, code: "TOUR_DISABLED" });
    expect(userSettings.updateOne).not.toHaveBeenCalled();
    const personal = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "set_enabled", enabled: true }) }))).json();
    expect(personal.data).toMatchObject({ enabled: false, platform_enabled: false, tours_enabled: true });
  });

  it("persists only the caller's opt-out and preserves tour progress", async () => {
    const { PATCH } = await import("../route");
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "set_enabled", enabled: false }) }))).json();
    expect(body.data).toMatchObject({ enabled: false, tours_enabled: false, auto_start: false });
    expect(userSettings.updateOne).toHaveBeenCalledWith({ user_id: "user@example.com" }, { $set: { "preferences.caipe_tour_enabled": false, updated_at: expect.any(Date) } });
  });

  it("loads the opt-out across sessions and allows re-enabling it", async () => {
    userSettings.findOneAndUpdate.mockResolvedValue({ user_id: "user@example.com", preferences: { caipe_tour_enabled: false, product_tour: { status: "in_progress", current_step: 3 } } });
    const { GET, PATCH } = await import("../route");
    expect((await (await GET(request())).json()).data).toMatchObject({ tours_enabled: false, auto_start: false, state: { current_step: 3 } });
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "reset" }) }))).rejects.toMatchObject({ statusCode: 403 });
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "set_enabled", enabled: true }) }))).json();
    expect(body.data).toMatchObject({ tours_enabled: true, state: { current_step: 3 } });
  });

  it("cannot override the operator allowlist by re-enabling personal tours", async () => {
    platformConfig.findOne.mockResolvedValue({ caipe_tour: { enabled_tours: ["chat"] } });
    const { GET, PATCH } = await import("../route");
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "set_enabled", enabled: true }) }))).json();
    expect(body.data).toMatchObject({ tours_enabled: true, enabled: false, enabled_tours: ["chat"] });
    expect((await (await GET(request(undefined, "?tour=chat"))).json()).data.enabled).toBe(true);
  });

  it("rejects a non-boolean opt-out without changing preferences", async () => {
    const { PATCH } = await import("../route");
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "set_enabled", enabled: "false" }) }))).rejects.toMatchObject({ statusCode: 400 });
    expect(userSettings.updateOne).not.toHaveBeenCalled();
  });

});
