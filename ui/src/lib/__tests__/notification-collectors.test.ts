/** @jest-environment node */
import { createServer, request as httpRequest } from "node:http";
import {
  collectorJson,
  collectorUrl,
} from "@/lib/notifications/collector-http.server";
import {
  enqueueNotificationExports,
  enqueuePlatformNotificationExports,
} from "@/lib/notifications/exports.server";
import { sendOtelNotificationEvent } from "@/lib/notifications/otel.server";
import { sendSplunkNotificationEvent } from "@/lib/notifications/splunk.server";
import type { NotificationExportEvent } from "@/lib/notifications/delivery-types";

const mockUpdate = jest.fn().mockResolvedValue({});
const mockCollection = jest.fn(async (name: string) => {
  expect(name).toBe("notification_deliveries");
  return { updateOne: mockUpdate };
});
jest.mock("@/lib/mongodb", () => ({
  getCollection: (name: string) => mockCollection(name),
}));
const event: NotificationExportEvent = {
  id: "example-event-hash",
  sourceId: "platform",
  eventType: "workflow.failed",
  occurredAt: "2026-10-01T10:00:00.123Z",
  severity: "error",
  resourceType: "workflow_run",
  resourceIdHash: "example-resource-hash",
};
const originalEnv = { ...process.env };
const realFetch = global.fetch;
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const name of Object.keys(process.env))
    if (name.startsWith("NOTIFICATION_") || name.startsWith("OTEL_"))
      delete process.env[name];
  process.env.NOTIFICATION_SPLUNK_HEC_URL =
    "https://collector.example.test/services/collector/event";
  process.env.NOTIFICATION_SPLUNK_HEC_TOKEN = "example-test-token";
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
    "https://collector.example.test/v1/logs";
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue(Response.json({}));
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = realFetch;
});

it("leaves both collectors off without touching storage or the network", async () => {
  await enqueueNotificationExports({ ...event, key: ["example"] });
  await enqueuePlatformNotificationExports(null);
  expect(mockCollection).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("queues only allowlisted metadata per sink, with no synthetic recipient", async () => {
  process.env.NOTIFICATION_SPLUNK_ENABLED = "true";
  process.env.NOTIFICATION_OTEL_ENABLED = "true";
  await enqueueNotificationExports({
    ...event,
    key: ["example"],
    title: "private title",
    recipient: "private@example.test",
    message: "private body",
  } as Parameters<typeof enqueueNotificationExports>[0]);
  expect(mockUpdate).toHaveBeenCalledTimes(2);
  const records = mockUpdate.mock.calls.map((call) => call[1].$setOnInsert);
  expect(records.map((record) => record.channel)).toEqual(["splunk", "otel"]);
  expect(records[0].event).toEqual({ ...event, id: expect.any(String) });
  expect(records[0]).not.toHaveProperty("recipient");
  expect(JSON.stringify(records)).not.toMatch(/private/);
  expect(records[0].event.id).toBe(records[1].event.id);
});
it("respects the kill switch and exact event-type filter", async () => {
  process.env.NOTIFICATION_SPLUNK_ENABLED = "true";
  process.env.NOTIFICATION_EXPORT_EVENT_TYPES =
    "agent.failed,workflow.completed";
  await enqueueNotificationExports({ ...event, key: ["example"] });
  process.env.NOTIFICATION_EXPORT_EVENT_TYPES = "workflow.failed";
  process.env.NOTIFICATION_EVENTS_ENABLED = "false";
  await enqueueNotificationExports({ ...event, key: ["example"] });
  expect(mockCollection).not.toHaveBeenCalled();
});
it.each([
  "http://collector.example.test",
  "https://user:secret@collector.example.test",
  "https://collector.example.test?token=secret",
  "https://collector.example.test/#secret",
  "file:///tmp/example",
  "invalid",
])("rejects unsafe collector configuration %s", (value) => {
  expect(() => collectorUrl(value)).toThrow();
});
it("formats HEC metadata and keeps credentials out of its payload", async () => {
  jest.mocked(fetch).mockResolvedValue(Response.json({ code: 0 }));
  await sendSplunkNotificationEvent(event);
  const [url, request] = jest.mocked(fetch).mock.calls[0];
  expect(url).toBe(process.env.NOTIFICATION_SPLUNK_HEC_URL);
  expect(request).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { Authorization: "Splunk example-test-token" },
  });
  expect(JSON.parse(request?.body as string)).toEqual({
    time: Date.parse(event.occurredAt) / 1000,
    source: "caipe.notifications",
    sourcetype: "_json",
    event,
  });
  expect(request?.body).not.toContain("example-test-token");
});
it.each([
  [401, false],
  [429, true],
  [500, true],
])("classifies HEC HTTP %i for retries", async (status, retryable) => {
  jest
    .mocked(fetch)
    .mockResolvedValue(new Response("error", { status: status as number }));
  await expect(sendSplunkNotificationEvent(event)).rejects.toMatchObject({
    retryable,
  });
});
it.each([
  [2, false],
  [8, true],
  [9, true],
])("does not treat HEC error code %i as success", async (code, retryable) => {
  jest.mocked(fetch).mockResolvedValue(Response.json({ code }));
  await expect(sendSplunkNotificationEvent(event)).rejects.toMatchObject({
    retryable,
  });
});
it("formats OTLP JSON logs, headers, severity and nanoseconds", async () => {
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
    "https://collector.example.test/base/";
  process.env.OTEL_EXPORTER_OTLP_HEADERS =
    "authorization=Bearer%20example-token";
  await sendOtelNotificationEvent(event);
  const [url, request] = jest.mocked(fetch).mock.calls[0];
  expect(url).toBe("https://collector.example.test/base/v1/logs");
  expect(request).toMatchObject({
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer example-token",
    },
  });
  const logs = JSON.parse(request?.body as string).resourceLogs[0];
  expect(logs.scopeLogs[0].logRecords[0]).toMatchObject({
    timeUnixNano: (BigInt(Date.parse(event.occurredAt)) * BigInt(1000000)).toString(),
    severityNumber: 17,
    severityText: "ERROR",
    eventName: event.eventType,
  });
  expect(request?.body).not.toContain("example-token");
});
it.each([
  "content-type=text/plain",
  "host=example.test",
  "cookie=secret",
  "authorization=Bearer%0D%0Ainvalid",
  "invalid",
  "name=%xx",
])("rejects invalid OTLP header %s", async (value) => {
  process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = value;
  await expect(sendOtelNotificationEvent(event)).rejects.toMatchObject({
    retryable: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [400, false],
  [401, false],
  [429, true],
  [500, false],
  [502, true],
  [503, true],
  [504, true],
])("classifies OTLP HTTP %i for retries", async (status, retryable) => {
  jest.mocked(fetch).mockResolvedValue(
    new Response("error", {
      status: status as number,
      headers: { "Retry-After": "120" },
    }),
  );
  await expect(sendOtelNotificationEvent(event)).rejects.toMatchObject({
    retryable,
    retryAfterMs: 120000,
  });
});
it("does not retry partial OTLP rejection", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(
      Response.json({ partialSuccess: { rejectedLogRecords: "1" } }),
    );
  await expect(sendOtelNotificationEvent(event)).rejects.toMatchObject({
    retryable: false,
  });
});
it("accepts an OTLP warning with zero records rejected", async () => {
  jest.mocked(fetch).mockResolvedValue(
    Response.json({
      partialSuccess: {
        rejectedLogRecords: "0",
        errorMessage: "example warning",
      },
    }),
  );
  await expect(sendOtelNotificationEvent(event)).resolves.toBeUndefined();
});
it("bounds and validates collector responses", async () => {
  await expect(collectorJson(new Response("x".repeat(65537)))).rejects.toThrow(
    "size limit",
  );
  await expect(collectorJson(new Response("invalid"))).rejects.toThrow(
    "JSON object",
  );
});
it("sends both protocols to a real local HTTP mock collector", async () => {
  const requests: Array<{
    path: string;
    authorization?: string;
    body: string;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    response.setHeader("Content-Type", "application/json");
    response.end(request.url === "/v1/logs" ? "{}" : '{"code":0}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // Shared Jest setup replaces native fetch. Use a real socket here to
    // verify the adapter's headers and payload against the mock collector.
    global.fetch = (async (url, options) =>
      new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest(
          String(url),
          {
            method: options?.method,
            headers: options?.headers as Record<string, string>,
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: incoming.statusCode,
                }),
              ),
            );
            incoming.on("error", reject);
          },
        );
        outgoing.on("error", reject);
        outgoing.end(options?.body);
      })) as typeof fetch;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Mock collector did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    process.env.NOTIFICATION_COLLECTOR_ALLOW_HTTP = "true";
    process.env.NOTIFICATION_SPLUNK_HEC_URL =
      base + "/services/collector/event";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = base + "/v1/logs";
    await sendSplunkNotificationEvent(event);
    await sendOtelNotificationEvent(event);
    expect(requests.map((request) => request.path)).toEqual([
      "/services/collector/event",
      "/v1/logs",
    ]);
    expect(requests[0].authorization).toBe("Splunk example-test-token");
    expect(JSON.parse(requests[0].body).event).toEqual(event);
    expect(JSON.parse(requests[1].body).resourceLogs).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
