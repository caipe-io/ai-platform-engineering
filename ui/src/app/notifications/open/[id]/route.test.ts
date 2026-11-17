/** @jest-environment node */
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-error";
import { GET } from "./route";

const mockUser = jest.fn();
const mockResolve = jest.fn();
jest.mock("@/lib/notifications/request-user.server", () => ({
  notificationUser: (...args: unknown[]) => mockUser(...args),
}));
jest.mock("@/lib/notifications/callback.server", () => ({
  resolveNotificationCallback: (...args: unknown[]) => mockResolve(...args),
}));
const marker = "a".repeat(64);
const originalEnv = { ...process.env };
const open = (id = marker) =>
  GET(new NextRequest(`https://host.example.test/notifications/open/${id}`), {
    params: Promise.resolve({ id }),
  });
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://host.example.test";
  mockUser.mockResolvedValue({
    subject: "test-user",
    session: { sub: "test-user", roles: ["user"] },
    user: { role: "user" },
  });
  mockResolve.mockResolvedValue(
    "/projects/example/wiki/overview.md?view=changes#decision-42",
  );
});
afterEach(() => {
  process.env = { ...originalEnv };
});
it("redirects straight to the exact page, query and anchor without caching", async () => {
  const response = await open();
  expect(response.status).toBe(303);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Location")).toBe(
    "https://host.example.test/projects/example/wiki/overview.md?view=changes#decision-42",
  );
  expect(mockResolve).toHaveBeenCalledWith(marker, "test-user", {
    role: "user",
    roles: ["user"],
  });
});
it("preserves the marker through sign-in without exposing or losing the destination", async () => {
  mockUser.mockRejectedValue(new ApiError("Sign in", 401));
  const response = await open();
  const login = new URL(response.headers.get("Location")!);
  expect(login.pathname).toBe("/login");
  expect(login.searchParams.get("callbackUrl")).toBe(
    `/notifications/open/${marker}`,
  );
  expect(mockResolve).not.toHaveBeenCalled();
});
it.each([403, 404])(
  "shows unavailable without disclosing a destination (%i)",
  async (status) => {
    mockResolve.mockRejectedValue(new ApiError("Unavailable", status));
    const response = await open();
    expect(response.status).toBe(status);
    expect(response.headers.has("Location")).toBe(false);
    expect(await response.text()).toContain("Notification unavailable");
  },
);
it("does not accept malformed markers", async () => {
  expect((await open("invalid")).status).toBe(404);
  expect(mockUser).not.toHaveBeenCalled();
});
