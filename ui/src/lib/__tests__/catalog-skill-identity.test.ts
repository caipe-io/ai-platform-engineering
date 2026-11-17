import { mergeCatalogSkills } from "../catalog-skill-identity";

describe("catalog skill identity", () => {
  it("preserves same-name skills across owners and sources", () => {
    const skills = [
      { id: "private-b", name: "Review", source: "agent_skills" as const },
      { id: "private-a", name: "Review", source: "agent_skills" as const },
      { id: "builtin", name: "Review", source: "default" as const },
      { id: "hub-example", name: "Review", source: "hub" as const },
    ];
    expect(mergeCatalogSkills(skills).map(s => s.id))
      .toEqual(["builtin", "private-a", "private-b", "hub-example"]);
  });

  it("coalesces the same ID with source precedence, independently of input order", () => {
    const builtin = { id: "same", name: "Built in", source: "default" as const };
    const alias = { id: "same", name: "Other label", source: "agent_skills" as const };
    expect(mergeCatalogSkills([alias, builtin])).toEqual([builtin]);
    expect(mergeCatalogSkills([builtin, alias])).toEqual([builtin]);
  });
});
