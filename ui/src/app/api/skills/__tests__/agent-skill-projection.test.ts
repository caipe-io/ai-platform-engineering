import { projectAgentSkillCatalogDoc } from "@/lib/catalog-skill-projection";

describe("projectAgentSkillCatalogDoc", () => {
  it("uses the Mongo skill id as source_id and keeps owner identity separate", () => {
    const projected = projectAgentSkillCatalogDoc(
      {
        id: "skill-imported-123",
        name: "Imported skill",
        description: "",
        owner_id: "alice@example.com",
        category: "imported",
        skill_content: "# Imported",
        ancillary_files: { "scripts/run.sh": "echo ok" },
      },
      true,
    );

    expect(projected).toEqual(
      expect.objectContaining({
        id: "skill-imported-123",
        source: "agent_skills",
        source_id: "skill-imported-123",
        owner_id: "alice@example.com",
        description: "",
        content: "# Imported",
        ancillary_files: { "scripts/run.sh": "echo ok" },
      }),
    );
  });

  it("omits content and ancillary files unless include_content is requested", () => {
    const projected = projectAgentSkillCatalogDoc(
      {
        id: "skill-imported-123",
        name: "Imported skill",
        skill_content: "# Imported",
        ancillary_files: { "scripts/run.sh": "echo ok" },
      },
      false,
    );

    expect(projected?.content).toBeNull();
    expect(projected?.ancillary_files).toBeUndefined();
  });

  it("keeps skills with an empty description", () => {
    expect(
      projectAgentSkillCatalogDoc(
        { id: "skill-no-description", name: "No description" },
        false,
      ),
    ).not.toBeNull();
  });
});
