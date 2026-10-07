import { mapCatalogSkillToAgentSkill } from "@/lib/catalog-skill-mapping";

describe("mapCatalogSkillToAgentSkill", () => {
  it("keeps the canonical id, owner, and ancillary files for Mongo-backed skills", () => {
    const mapped = mapCatalogSkillToAgentSkill({
      id: "skill-imported-123",
      name: "Imported skill",
      description: "",
      source: "agent_skills",
      source_id: "skill-imported-123",
      owner_id: "alice@example.com",
      content: "# Imported skill",
      ancillary_files: {
        "scripts/run.sh": "echo ok",
        "references/guide.md": "# Guide",
      },
      metadata: { category: "imported", visibility: "private" },
    });

    expect(mapped).toEqual(
      expect.objectContaining({
        id: "skill-imported-123",
        owner_id: "alice@example.com",
        is_system: false,
        ancillary_files: {
          "scripts/run.sh": "echo ok",
          "references/guide.md": "# Guide",
        },
      }),
    );
    expect(mapped.metadata).toEqual(
      expect.objectContaining({
        catalog_source: "agent_skills",
        catalog_source_id: "skill-imported-123",
      }),
    );
  });

  it.each([
    ["default", "catalog-builtin-one"],
    ["hub", "catalog-hub-one"],
  ])("keeps %s entries in the synthetic catalog namespace", (source, expectedId) => {
    const mapped = mapCatalogSkillToAgentSkill({
      id: source === "default" ? "builtin-one" : "hub-one",
      name: "Read-only skill",
      source,
      source_id: "source-one",
      content: "# Read only",
      metadata: source === "default" ? { is_system: true } : {},
    });

    expect(mapped.id).toBe(expectedId);
    expect(mapped.owner_id).toBe("");
  });
});
