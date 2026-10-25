/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

const mockGetAuth = jest.fn();
const mockFindProducer = jest.fn();
const mockCreate = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
    successResponse: (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status }),
    withErrorHandler:
      (handler: (request: NextRequest) => Promise<Response>) => async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode ?? 500;
          return NextResponse.json({ success: false, error: (error as Error).message }, { status });
        }
      },
  };
});
jest.mock("@/lib/agentic-apps/notification-producer", () => ({
  findNotificationProducer: (...args: unknown[]) => mockFindProducer(...args),
}));
jest.mock("@/lib/in-app-notifications.server", () => ({
  createInAppNotification: (...args: unknown[]) => mockCreate(...args),
  listInAppNotifications: jest.fn(),
}));
jest.mock("@/lib/notification-preferences.server", () => ({ platformHealthNotificationsEnabled: jest.fn() }));
jest.mock("@/lib/platform-health-notifications.server", () => ({ runPlatformHealthNotificationAudit: jest.fn() }));
jest.mock("@/app/api/skills/_lib/request-origin", () => ({ getRequestOrigin: jest.fn() }));

import { POST } from "../route";

const app = { installation: { appId: "example-app" }, manifest: { displayName: "Example App" } };
const valid = {
  eventKey: "report:2026-10-19:ready",
  recipientUserSubjects: ["user-1"],
  title: "Your report is ready",
  message: "Open the report page to read it.",
  href: "/example/report",
  severity: "info",
};

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuth.mockResolvedValue({ session: { isServiceAccount: true, serviceAccountClientId: "example-client" } });
  mockFindProducer.mockReturnValue(app);
  mockCreate.mockResolvedValue(true);
});

describe("POST /api/notifications", () => {
  it("creates a notification for the named users and answers 201", async () => {
    const response = await post(valid);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { created: true } });
    expect(mockFindProducer).toHaveBeenCalledWith("example-client");
    expect(mockCreate).toHaveBeenCalledWith({
      eventKey: "app:example-app:report:2026-10-19:ready",
      recipientUserSubjects: ["user-1"],
      title: "Your report is ready",
      message: "Open the report page to read it.",
      href: "/example/report",
      severity: "info",
      sourceLabel: "Example App",
    });
  });

  it("answers 200 and writes nothing new when the event key was already there", async () => {
    mockCreate.mockResolvedValue(false);
    const response = await post(valid);

    expect(response.status).toBe(200);
    expect((await response.json()).data.created).toBe(false);
  });

  it("takes the event key space and source label from the app, not the request", async () => {
    await post({ ...valid, sourceLabel: "Platform", category: "platform_health", recipientTeamSlugs: ["admins"], recipientPlatformUsers: true, recipientOrganizationAdmins: true });

    const input = mockCreate.mock.calls[0][0];
    expect(input.sourceLabel).toBe("Example App");
    expect(input.eventKey.startsWith("app:example-app:")).toBe(true);
    expect(input).not.toHaveProperty("category");
    expect(input).not.toHaveProperty("recipientTeamSlugs");
    expect(input).not.toHaveProperty("recipientPlatformUsers");
    expect(input).not.toHaveProperty("recipientOrganizationAdmins");
  });

  it("refuses a user session, and a service account that no installed app is bound to", async () => {
    mockGetAuth.mockResolvedValue({ session: { isServiceAccount: false, serviceAccountClientId: "example-client" } });
    expect((await post(valid)).status).toBe(403);
    expect(mockFindProducer).not.toHaveBeenCalled();

    mockGetAuth.mockResolvedValue({ session: { isServiceAccount: true, serviceAccountClientId: "other-client" } });
    mockFindProducer.mockReturnValue(null);
    expect((await post(valid)).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["no recipients", { recipientUserSubjects: [] }],
    ["a blank recipient", { recipientUserSubjects: ["user-1", " "] }],
    ["more than 50 recipients", { recipientUserSubjects: Array.from({ length: 51 }, (_, index) => `user-${index}`) }],
    ["no title", { title: "" }],
    ["a title over 200 characters", { title: "x".repeat(201) }],
    ["a message over 1000 characters", { message: "x".repeat(1001) }],
    ["no event key", { eventKey: undefined }],
    ["an absolute link", { href: "https://example.com/x" }],
    ["a protocol-relative link", { href: "//example.com/x" }],
    ["a backslash authority", { href: "/\\example.com/login" }],
    ["a tab-hidden authority", { href: "/\t/example.com/login" }],
    ["a newline-hidden authority", { href: "/\n/example.com/login" }],
    ["a control character in a path", { href: "/example/\u0000report" }],
    ["an unknown severity", { severity: "loud" }],
  ])("rejects %s", async (_name, change) => {
    const response = await post({ ...valid, ...change });

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    expect((await post("not json")).status).toBe(400);
  });

  it("accepts a request with no link and no severity", async () => {
    const response = await post({ ...valid, href: undefined, severity: undefined });

    expect(response.status).toBe(201);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ severity: "info", href: undefined });
  });

  it("accepts a local link with a query and fragment", async () => {
    const href = "/example/report?view=summary#results";
    expect((await post({ ...valid, href })).status).toBe(201);
    expect(mockCreate.mock.calls[0][0].href).toBe(href);
  });
});
