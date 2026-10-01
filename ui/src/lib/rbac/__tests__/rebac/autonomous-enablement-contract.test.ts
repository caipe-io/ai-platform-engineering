/**
 * Authorization-model contract for autonomous-agent enablement
 *
 * Team eligibility is a user entitlement inherited from any enabled team.
 * Agent access remains independently enforced by `agent#can_use`.
 * Pinned in BOTH the authored `.fga` and the deployed chart JSON so they can't drift.
 */
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const MODEL_FGA = join(REPO_ROOT, "deploy", "openfga", "model.fga");
const CHART_JSON = join(
  REPO_ROOT, "charts", "ai-platform-engineering", "charts", "openfga", "authorization-model.json",
);

function fgaTypeBlock(typeName: string): string {
  const text = readFileSync(MODEL_FGA, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `type ${typeName}`);
  if (start === -1) throw new Error(`type ${typeName} missing from model.fga`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("type ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

interface DirectType { type: string; relation?: string }
function chartDirectTypes(typeName: string, relation: string): DirectType[] {
  const model = JSON.parse(readFileSync(CHART_JSON, "utf8")) as {
    type_definitions: Array<{
      type: string;
      metadata?: { relations?: Record<string, { directly_related_user_types?: DirectType[] }> };
    }>;
  };
  const def = model.type_definitions.find((t) => t.type === typeName);
  if (!def) throw new Error(`${typeName} type missing from chart JSON`);
  return def.metadata?.relations?.[relation]?.directly_related_user_types ?? [];
}
function hasTeamMember(types: DirectType[]): boolean {
  return types.some((t) => t.type === "team" && t.relation === "member");
}

function chartRelations(typeName: string): string[] {
  const model = JSON.parse(readFileSync(CHART_JSON, "utf8")) as {
    type_definitions: Array<{ type: string; relations?: Record<string, unknown> }>;
  };
  const definition = model.type_definitions.find((item) => item.type === typeName);
  if (!definition) throw new Error(`${typeName} type missing from chart JSON`);
  return Object.keys(definition.relations ?? {});
}

describe("autonomous-enablement model contract", () => {
  it(".fga: organization defines automation_eligible + can_automate", () => {
    const org = fgaTypeBlock("organization");
    expect(org).toMatch(/define automation_eligible: \[team#member, team#admin\]/);
    expect(org).toMatch(/define can_automate: automation_eligible or admin/);
  });

  it(".fga: agent access has no separate autonomous owner-team grant", () => {
    const agent = fgaTypeBlock("agent");
    expect(agent).toMatch(/define can_use:/);
    expect(agent).not.toMatch(/define automator:/);
    expect(agent).not.toMatch(/define can_schedule:/);
  });

  it("chart JSON mirrors the user entitlement model", () => {
    expect(hasTeamMember(chartDirectTypes("organization", "automation_eligible"))).toBe(true);
    expect(chartRelations("organization")).toContain("can_automate");
    expect(chartRelations("agent")).not.toContain("automator");
    expect(chartRelations("agent")).not.toContain("can_schedule");
  });
});
