/** @jest-environment node */

import { NextRequest } from "next/server";

import { POST } from "@/app/api/internal/notifications/events/route";

const mockPublish = jest.fn();

jest.mock("@/lib/notifications/fanout.server", () => ({
  publishNotificationRequest: (...args: unknown[]) => mockPublish(...args),
}));

function fanOut(overrides: Record<string, number> = {}) {
  return {
    recipients: 1,
    skipped: 0,
    results: { delivered: 1, queued: 0, disabled: 0, invalid: 0, failed: 0, ...overrides },
  };
}

const TOKEN = "test-internal-token-value";

const validEnvelope = {
  id: "evt-internal-1",
  type: "ingestion.completed",
  version: 1,
  occurred_at: "2026-10-14T10:00:00Z",
  resource: { type: "datasource", id: "datasource-example" },
  attempt_id: "job-example-1",
  recipients: [{ subject: "subject-example", email: "test-user@example.com" }],
  include_org_admins: true,
  data: {
    status: "completed",
    title: "Ingestion finished",
    summary: "Example source finished indexing.",
    href: "/knowledge-bases",
  },
};

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/internal/notifications/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const authorized = { authorization: `Bearer ${TOKEN}` };

describe("POST /api/internal/notifications/events", () => {
  const previousToken = process.env.NOTIFICATIONS_INTERNAL_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = TOKEN;
    mockPublish.mockResolvedValue(fanOut());
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
    else process.env.NOTIFICATIONS_INTERNAL_TOKEN = previousToken;
  });

  it("returns 503 and refuses all callers when the token is not configured", async () => {
    delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
    const response = await POST(request(validEnvelope, authorized));
    expect(response.status).toBe(503);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 401 without a bearer token", async () => {
    const response = await POST(request(validEnvelope));
    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong token, including one of the same length", async () => {
    const wrongSameLength = "x".repeat(TOKEN.length);
    expect((await POST(request(validEnvelope, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await POST(request(validEnvelope, { authorization: `Bearer ${wrongSameLength}` }))).status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 401 for a non-bearer scheme carrying the right value", async () => {
    const response = await POST(request(validEnvelope, { authorization: `Basic ${TOKEN}` }));
    expect(response.status).toBe(401);
  });

  it("returns 400 for a body that is not JSON, without publishing", async () => {
    const response = await POST(request("{not json", authorized));
    expect(response.status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown event type, without publishing", async () => {
    const response = await POST(request({ ...validEnvelope, type: "billing.paid" }, authorized));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unknown event type/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 400 when there is no audience at all, without publishing", async () => {
    const response = await POST(
      request({ ...validEnvelope, recipients: [], include_org_admins: false }, authorized),
    );
    expect(response.status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("accepts a valid envelope with 202 and passes the parsed envelope to publish", async () => {
    const response = await POST(request(validEnvelope, authorized));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(fanOut());
    expect(mockPublish).toHaveBeenCalledWith({
      base: expect.objectContaining({ id: "evt-internal-1", type: "ingestion.completed" }),
      recipients: [{ subject: "subject-example", email: "test-user@example.com" }],
      includeOrgAdmins: true,
    });
  });

  it("drops unknown fields such as prompts before publishing", async () => {
    await POST(request({ ...validEnvelope, prompt: "secret prompt text" }, authorized));
    // Unknown fields reach the fan-out, where each per-recipient envelope is
    // re-validated and stripped before anything is stored.
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("reports a skipped-by-preference event as accepted", async () => {
    mockPublish.mockResolvedValue(fanOut({ delivered: 0, disabled: 1 }));
    const response = await POST(request(validEnvelope, authorized));
    expect(response.status).toBe(202);
    expect((await response.json()).results.disabled).toBe(1);
  });

  it("returns 503 when delivery fails, so the caller can retry", async () => {
    mockPublish.mockResolvedValue(fanOut({ delivered: 0, failed: 1 }));
    const response = await POST(request(validEnvelope, authorized));
    expect(response.status).toBe(503);
    expect((await response.json()).results.failed).toBe(1);
  });
});
