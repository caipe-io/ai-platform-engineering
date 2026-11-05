/** @jest-environment node */
import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockGate = jest.fn();
const mockRead = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/rbac/require-openfga", () => ({ requireAdminSurfaceManage: (...args: unknown[]) => mockGate(...args) }));
jest.mock("@/lib/app-usage", () => ({ readAppUsage: () => mockRead() }));
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true }));

import { ApiError } from "@/lib/api-middleware";
import { GET } from "../route";

describe("aggregate usage API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ session: { sub: "user-primary" } });
    mockGate.mockResolvedValue(undefined);
    mockRead.mockResolvedValue({ enabled: true, retention_days: 30, total_loads: 5, daily: [] });
  });

  it("uses the existing stats gate and returns private non-cacheable counts", async () => {
    const response = await GET(new NextRequest("https://app.example.test/api/admin/stats/app-usage"));
    expect(mockGate).toHaveBeenCalledWith({ sub: "user-primary" }, "stats");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).data.total_loads).toBe(5);
  });

  it.each([401, 403])("does not query aggregates after an auth denial (%s)", async (status) => {
    if (status === 401) mockAuth.mockRejectedValue(new ApiError("Unauthorized", 401));
    else mockGate.mockRejectedValue(new ApiError("Forbidden", 403));
    const response = await GET(new NextRequest("https://app.example.test/api/admin/stats/app-usage"));
    expect(response.status).toBe(status);
    expect(mockRead).not.toHaveBeenCalled();
  });
});
