/** @jest-environment node */

const mockFind = jest.fn();
const mockGetCollection = jest.fn(async () => ({ findOne: mockFind }));
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));
import { GET as live } from "../../live-skills/route";
import { GET as update } from "../../update-skills/route";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCollection.mockResolvedValue({ findOne: mockFind });
});

it.each([["live-skills", live], ["update-skills", update]])(
  "renders the protected %s instruction from MongoDB", async (id, handler) => {
    mockFind.mockResolvedValue({ content: "---\ndescription: Example gateway\n---\nSystem instruction for {{BASE_URL}}." });
    const response = await handler(new Request(`https://app.example.com/api/skills/${id}`));
    const data = await response.json();
    expect(data.source).toBe(`mongodb:system_skills/${id}`);
    expect(data.template).toContain("System instruction for https://app.example.com");
    expect(mockGetCollection).toHaveBeenCalledWith("system_skills");
    expect(mockFind).toHaveBeenCalledWith({ _id: id });
  },
);

it.each([["live-skills", live], ["update-skills", update]])("points missing %s records to system initialization recovery", async (id, handler) => {
  const original = process.env.SKILLS_LIVE_SKILLS_TEMPLATE;
  process.env.SKILLS_LIVE_SKILLS_TEMPLATE = "A filesystem fallback";
  try {
    mockFind.mockResolvedValue(null);
    const response = await handler(new Request(`https://app.example.com/api/skills/${id}`));
    expect(response.status).toBe(404);
    const { error } = await response.json();
    expect(error).toContain("system skill initialization");
    expect(error).toContain("restart the UI service");
    expect(error).not.toMatch(/import|catalog migration|app-config/i);
  } finally {
    if (original === undefined) delete process.env.SKILLS_LIVE_SKILLS_TEMPLATE;
    else process.env.SKILLS_LIVE_SKILLS_TEMPLATE = original;
  }
});

it("returns an unavailable response on database failure", async () => {
  mockFind.mockRejectedValue(new Error("database unavailable"));
  expect((await live(new Request("https://app.example.com/api/skills/live-skills"))).status).toBe(503);
});
