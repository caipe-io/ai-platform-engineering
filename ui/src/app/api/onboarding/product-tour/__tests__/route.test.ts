/** @jest-environment node */

import { NextRequest } from "next/server";

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

function request(init?: RequestInit): NextRequest {
  return new NextRequest("http://localhost:3000/api/onboarding/product-tour", init);
}

describe("product tour route", () => {
  const platformConfig = { findOne: jest.fn() };
  const userSettings = {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
});
