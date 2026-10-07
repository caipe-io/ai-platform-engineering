/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";

const authenticate = jest.fn();
const proxy = jest.fn();
const updateOne = jest.fn();
jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => authenticate(...args),
  getDynamicAgentsConfig: () => ({ dynamicAgentsUrl: "https://runtime.example.test" }),
  proxyRequest: (...args: unknown[]) => proxy(...args),
}));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ updateOne }) }));

import { POST } from "../route";

const invoke = (body = '{}') => POST(new NextRequest("https://ui.example.test/api/dynamic-agents/agents/primary/badge", {
  method: "POST", body,
}), { params: Promise.resolve({ id: "primary" }) });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AGNTCY_IDENTITY_ENABLED = "true";
  authenticate.mockResolvedValue({ role: "admin", subject: "test-user" });
  proxy.mockResolvedValue(NextResponse.json({ credential_id: "urn:uuid:primary", subject: "agntcy://IDP-primary" }));
  updateOne.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.AGNTCY_IDENTITY_ENABLED;
});

test.each([undefined, "false", "", "1"])("disabled for flag %s without auth, backend or database access", async (flag) => {
  if (flag === undefined) delete process.env.AGNTCY_IDENTITY_ENABLED;
  else process.env.AGNTCY_IDENTITY_ENABLED = flag;
  expect((await invoke()).status).toBe(404);
  expect(authenticate).not.toHaveBeenCalled();
  expect(proxy).not.toHaveBeenCalled();
  expect(updateOne).not.toHaveBeenCalled();
});

test("requires admin permission and records only the publication receipt", async () => {
  const response = await invoke('{"name":"primary"}');
  expect(response.status).toBe(200);
  expect(authenticate).toHaveBeenCalledWith(expect.any(NextRequest), { resource: "admin_ui", scope: "admin" });
  expect(proxy).toHaveBeenCalledWith("https://runtime.example.test/api/v1/agents/primary/badge", "POST",
    expect.any(Object), "[agent-badge]", '{"name":"primary"}');
  expect(updateOne).toHaveBeenCalledWith({ _id: "urn:uuid:primary" }, {
    $set: { credential_id: "urn:uuid:primary", subject: "agntcy://IDP-primary", published_by: "test-user", published_at: expect.any(Date) },
  }, { upsert: true });
});

test("rejects non-admin and oversized requests before publication", async () => {
  authenticate.mockResolvedValue({ role: "user" });
  expect((await invoke()).status).toBe(403);
  authenticate.mockResolvedValue({ role: "admin" });
  expect((await invoke('x'.repeat(512 * 1024 + 1))).status).toBe(413);
  expect(proxy).not.toHaveBeenCalled();
});

test("does not persist failed publication", async () => {
  proxy.mockResolvedValue(NextResponse.json({ error: "unavailable" }, { status: 502 }));
  expect((await invoke()).status).toBe(502);
  expect(updateOne).not.toHaveBeenCalled();
});

test("returns receipt when remote publication succeeds but receipt persistence fails", async () => {
  updateOne.mockRejectedValue(new Error("database unavailable"));
  const response = await invoke();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({ credential_id: "urn:uuid:primary", receipt_persisted: false }));
});

test("passes through authentication failure", async () => {
  authenticate.mockResolvedValue(NextResponse.json({ error: "sign in" }, { status: 401 }));
  expect((await invoke()).status).toBe(401);
  expect(proxy).not.toHaveBeenCalled();
});
