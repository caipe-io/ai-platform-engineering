/** @jest-environment node */

import { AuditClient } from "../client";

const ts = "2026-10-01T12:00:00.000Z";
const event = {
  audit_event_id: "event-1", ts, type: "cas_decision", component: "cas", source: "cas",
  subject_ref: "user:test-user", action: "call", resource_ref: "tool:example/list",
  outcome: "deny", reason_code: "NO_CAPABILITY", decision_id: "decision-1",
  gateway_checks: [{ gate: "caller_tool", decision: "DENY", reason: "NO_CAPABILITY" }],
};

function page(records: object[] = []) {
  return { records, limit: 30, cursor: "first", next_cursor: null, since: ts, until: ts, as_of: ts };
}

const originalFetch = global.fetch;
const originalEnv = process.env;
let fetchMock: jest.Mock;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  process.env = { ...originalEnv };
  for (const key of ["AUDIT_LOG_BACKEND", "AUDIT_SERVICE_URL", "AUDIT_LOG_SERVICE_URL", "AUDIT_SERVICE_FLUSH_BATCH_SIZE", "AUDIT_SERVICE_FLUSH_INTERVAL_MS"]) delete process.env[key];
  fetchMock = jest.fn().mockImplementation(async () => new Response(null, { status: 202 }));
  global.fetch = fetchMock;
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  process.env = originalEnv;
});

it("preserves the CAS event, decision ID and gate evidence in one batched POST", async () => {
  const client = new AuditClient({ baseUrl: "http://audit.example.test/", batchSize: 2 });
  client.append(event);
  expect(fetchMock).not.toHaveBeenCalled();
  client.append({ ...event, audit_event_id: "event-2" });
  await client.flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://audit.example.test/v1/audit/events");
  expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
  expect(JSON.parse(init.body)).toEqual({ events: [event, { ...event, audit_event_id: "event-2" }] });
});

it("flushes low-volume events on the interval", async () => {
  const client = new AuditClient({ baseUrl: "http://audit.example.test", flushIntervalMs: 50 });
  client.append(event);
  await jest.advanceTimersByTimeAsync(50);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps one POST in flight and drains arrivals in bounded batches", async () => {
  let release!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  const client = new AuditClient({ baseUrl: "http://audit.example.test", batchSize: 2 });
  for (let i = 0; i < 7; i++) client.append({ ...event, audit_event_id: String(i) });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  release(new Response(null, { status: 202 }));
  await client.flush();
  const batches = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).events);
  expect(batches.map((batch) => batch.length)).toEqual([2, 2, 2, 1]);
  expect(batches.flat().map((row) => row.audit_event_id)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
});

it.each(["network", "http", "serialization"])("does not throw or retry failed audit writes: %s", async (failure) => {
  const client = new AuditClient({ baseUrl: "http://audit.example.test" });
  if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("connection failed"));
  if (failure === "http") fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  const record = failure === "serialization" ? { value: BigInt(1) } : event;
  expect(() => client.append(record)).not.toThrow();
  await expect(client.flush()).resolves.toBeUndefined();
  expect(console.warn).toHaveBeenCalled();
  const calls = fetchMock.mock.calls.length;
  await client.flush();
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it("serializes typed filters and returns the full cursor contract without fetching earlier pages", async () => {
  const result = { ...page([event]), next_cursor: "next-token" };
  fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
  const client = new AuditClient({ baseUrl: "http://audit.example.test" });
  await expect(client.queryPage({ window: "48h", cursor: "page-token", limit: 30, tenant_id: "primary", subject_ref: "user:test-user" })).resolves.toEqual(result);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  const params = new URL(url).searchParams;
  expect(Object.fromEntries(params)).toEqual({ window: "48h", cursor: "page-token", limit: "30", tenant_id: "primary", subject_ref: "user:test-user" });
  expect(params.has("since")).toBe(false);
  expect(init).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
});

it("serializes explicit dates in one place", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(page())));
  const client = new AuditClient({ baseUrl: "http://audit.example.test" });
  await client.queryPage({ since: new Date(ts), until: ts, reason_code: "NO_CAPABILITY" });
  const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
  expect(params.get("since")).toBe(ts);
  expect(params.get("until")).toBe(ts);
  expect(params.get("limit")).toBe("1000");
});

it("distinguishes a valid empty page from service unavailability", async () => {
  const client = new AuditClient({ baseUrl: "http://audit.example.test" });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(page())));
  await expect(client.queryPage()).resolves.toEqual(page());
  fetchMock.mockRejectedValueOnce(new Error("connection failed"));
  await expect(client.queryPage()).rejects.toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });
});

it.each([400, 401, 503])("classifies service HTTP %s without hiding it as an empty page", async (status) => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status }));
  await expect(new AuditClient({ baseUrl: "http://audit.example.test" }).queryPage()).rejects.toMatchObject({ statusCode: status === 400 ? 400 : 503 });
});

it.each([
  null,
  { records: [], total: 0 },
  { ...page(), records: [null] },
  { ...page(), records: [[]] },
  { ...page(), cursor: "" },
  { ...page(), next_cursor: "" },
  { ...page(), as_of: "invalid" },
  { ...page(), limit: 0 },
])("rejects a malformed or old query response: %j", async (body) => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  await expect(new AuditClient({ baseUrl: "http://audit.example.test" }).queryPage()).rejects.toMatchObject({ statusCode: 503 });
});

it("rejects a non-JSON response", async () => {
  fetchMock.mockResolvedValueOnce(new Response("not JSON"));
  await expect(new AuditClient({ baseUrl: "http://audit.example.test" }).queryPage()).rejects.toMatchObject({ statusCode: 503 });
});

it.each(["off", "disabled", "none", "s3"])("uses one explicit disabled state for %s", async (backend) => {
  process.env.AUDIT_LOG_BACKEND = backend;
  const { getAuditClient } = await import("../client");
  const client = getAuditClient();
  expect(client.enabled).toBe(false);
  client.append(event);
  await client.flush();
  await expect(client.queryPage()).rejects.toMatchObject({ statusCode: 503 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shares one lazily initialized client for reads and writes", async () => {
  process.env.AUDIT_LOG_BACKEND = " SERVICE ";
  process.env.AUDIT_SERVICE_URL = "http://audit.example.test///";
  process.env.AUDIT_SERVICE_FLUSH_BATCH_SIZE = "1";
  const { getAuditClient } = await import("../client");
  const client = getAuditClient();
  expect(getAuditClient()).toBe(client);
  expect(client.enabled).toBe(true);
  client.append(event);
  await client.flush();
  expect(fetchMock.mock.calls[0][0]).toBe("http://audit.example.test/v1/audit/events");
});
