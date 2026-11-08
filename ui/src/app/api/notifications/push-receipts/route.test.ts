/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ updateOne: mockUpdate }),
}));

import { POST } from "./route";

const request = (deliveryId: string) =>
  new NextRequest("https://host.example.test/api/notifications/push-receipts", {
    method: "POST",
    body: JSON.stringify({ deliveryId }),
  });
describe("browser push display receipts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ session: { sub: "test-user" } });
    mockUpdate.mockResolvedValue({ modifiedCount: 1 });
  });
  it("only updates the current user's unexpired push delivery", async () => {
    expect((await POST(request("a".repeat(64)))).status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "a".repeat(64),
        "recipient.subject": "test-user",
        channel: "web_push",
        expiresAt: { $gt: expect.any(Date) },
        browserDisplayedAt: { $exists: false },
      }),
      { $set: { browserDisplayedAt: expect.any(Date) } },
    );
  });
  it("rejects malformed identifiers and service accounts", async () => {
    expect((await POST(request("invalid"))).status).toBe(400);
    mockAuth.mockResolvedValue({
      session: { isServiceAccount: true, sub: "example-service" },
    });
    expect((await POST(request("a".repeat(64)))).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
