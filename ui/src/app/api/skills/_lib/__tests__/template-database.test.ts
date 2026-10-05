/** @jest-environment node */

const mockFind = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async () => ({ findOne: mockFind }),
}));
import { GET as live } from "../../live-skills/route";
import { GET as update } from "../../update-skills/route";

beforeEach(() => { jest.resetAllMocks(); });

it.each([["live-skills", live], ["update-skills", update]])(
  "renders the edited %s instruction from MongoDB", async (id, handler) => {
    mockFind.mockResolvedValue({ skill_content: "---\ndescription: Example gateway\n---\nEdited instruction for {{BASE_URL}}." });
    const response = await handler(new Request(`https://app.example.com/api/skills/${id}`));
    const data = await response.json();
    expect(data.source).toBe(`mongodb:${id}`);
    expect(data.template).toContain("Edited instruction for https://app.example.com");
    expect(mockFind).toHaveBeenCalledWith({ is_system: true, visibility: "global",
      $or: [{ id }, { "metadata.template_source_id": id }],
    });
  },
);

it("does not restore a deleted or private instruction from packaged files or environment", async () => {
  const original = process.env.SKILLS_LIVE_SKILLS_TEMPLATE;
  process.env.SKILLS_LIVE_SKILLS_TEMPLATE = "A filesystem fallback";
  try {
    mockFind.mockResolvedValue(null);
    expect((await live(new Request("https://app.example.com/api/skills/live-skills"))).status).toBe(404);
  } finally {
    if (original === undefined) delete process.env.SKILLS_LIVE_SKILLS_TEMPLATE;
    else process.env.SKILLS_LIVE_SKILLS_TEMPLATE = original;
  }
});

it("returns an unavailable response on database failure", async () => {
  mockFind.mockRejectedValue(new Error("database unavailable"));
  expect((await live(new Request("https://app.example.com/api/skills/live-skills"))).status).toBe(503);
});
