/** @jest-environment node */
jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: jest.fn(),
  withErrorHandler: (handler: unknown) => handler,
}));
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => ({
    find: () => ({ toArray: async () => name === "agent_skills" ? mockDocs : [] }),
  })),
}));
jest.mock("@/lib/hub-crawl", () => ({ getHubSkills: jest.fn(async () => []) }));
jest.mock("@/lib/rbac/openfga", () => ({ checkOpenFgaTuple: jest.fn() }));

import { NextRequest } from "next/server";
import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import { GET } from "../route";

const mockDocs = ["denied", "allowed"].map(id => ({
  id, name: "Review", owner_id: `${id}@example.test`, visibility: "private",
  skill_content: "# Review", description: "Scoped review", scan_status: "passed",
}));

describe("catalog GET with same-name skill identities", () => {
  const original = process.env.HIDE_BUILTIN_SKILLS;
  beforeEach(() => {
    process.env.HIDE_BUILTIN_SKILLS = "true";
    jest.mocked(getAuthFromBearerOrSession).mockResolvedValue({
      user: { email: "reader@example.test", role: "user" }, session: { sub: "reader" },
    } as Awaited<ReturnType<typeof getAuthFromBearerOrSession>>);
  });
  afterAll(() => {
    if (original === undefined) delete process.env.HIDE_BUILTIN_SKILLS;
    else process.env.HIDE_BUILTIN_SKILLS = original;
  });
  it("keeps an authorized row even when a denied same-name row arrived first", async () => {
    jest.mocked(checkOpenFgaTuple).mockImplementation(async tuple => ({ allowed: tuple.object === "skill:allowed" }));
    const response = await GET(new NextRequest("https://example.test/api/skills?q=Review"));
    expect((await response.json()).skills.map((s: { id: string }) => s.id)).toEqual(["allowed"]);
  });
  it("returns both identities when both are authorized", async () => {
    jest.mocked(checkOpenFgaTuple).mockResolvedValue({ allowed: true });
    const response = await GET(new NextRequest("https://example.test/api/skills?q=Review"));
    expect((await response.json()).skills.map((s: { id: string }) => s.id)).toEqual(["allowed", "denied"]);
  });
});
