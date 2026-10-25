/** @jest-environment node */
import { NextRequest } from "next/server";

const mockSession = jest.fn();
const mockBearer = jest.fn();
const mockCollection = jest.fn();
let mockSsoEnabled = true;
let mockDevelopmentAuth = false;
jest.mock("next-auth", () => ({ getServerSession: () => mockSession() }));
jest.mock("@/lib/auth-config", () => ({ authOptions: {}, isBootstrapAdmin: () => false }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "ssoEnabled" ? mockSsoEnabled :
  ["allowDevAdminWhenSsoDisabled", "unsafeRbacBypassEnabled"].includes(key) && mockDevelopmentAuth }));
jest.mock("@/lib/jwt-validation", () => ({
  validateBearerJWT: (...args: unknown[]) => mockBearer(...args),
  validateLocalSkillsJWT: async () => null,
}));
jest.mock("@/lib/catalog-api-keys", () => ({ verifyCatalogApiKey: async () => null }));
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockCollection(...args) }));

// Exercise the real shared authentication helper, not a route-level auth mock.
import { GET } from "../route";

const originalAllowedRepositories = process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
afterEach(() => {
  if (originalAllowedRepositories === undefined) delete process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES;
  else process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = originalAllowedRepositories;
});

describe("configured release notes authentication", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_NOTES_ALLOWED_REPOSITORIES = "https://github.com/example/repository";
    mockSsoEnabled = true;
    mockDevelopmentAuth = false;
    mockSession.mockResolvedValue(null);
    mockBearer.mockRejectedValue(Object.assign(new Error("Invalid bearer"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }));
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ commits: [] }) })) as unknown as typeof fetch;
    mockCollection.mockResolvedValue({ findOne: async () => ({ release_notes: {
      repository_url: "https://github.com/example/repository", previous_commit: "1111111", latest_commit: "2222222",
    } }) });
  });
  afterAll(() => { global.fetch = originalFetch; });
  const request = (headers?: HeadersInit) => new NextRequest("https://app.example.test/api/release-notes?version=1&compare=platform", { headers });

  it("rejects a missing SSO session before reading config or calling GitHub", async () => {
    expect((await GET(request())).status).toBe(401);
    expect(mockCollection).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("rejects an invalid bearer without falling back to a valid session", async () => {
    mockSession.mockResolvedValue({ user: { email: "user@example.test" } });
    expect((await GET(request({ Authorization: "Bearer example-invalid" }))).status).toBe(401);
    expect(mockCollection).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("rejects a session denied admission before accessing private metadata", async () => {
    mockSession.mockResolvedValue({ user: { email: "user@example.test" }, isAuthorized: false });
    expect((await GET(request())).status).toBe(403);
    expect(mockCollection).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("admits ordinary users but rechecks admission after warming the private compare cache", async () => {
    mockSession.mockResolvedValue({ user: { email: "user@example.test" }, role: "user", isAuthorized: true });
    expect((await GET(request())).status).toBe(200);
    expect((await GET(request())).status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    mockSession.mockResolvedValue(null);
    mockCollection.mockClear();
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect((await response.json()).body).toBeNull();
    expect(mockCollection).not.toHaveBeenCalled();
  });
  it("retains deliberate no-SSO development admission through the shared provider", async () => {
    mockSsoEnabled = false;
    mockDevelopmentAuth = true;
    expect((await GET(request())).status).toBe(200);
  });
});
