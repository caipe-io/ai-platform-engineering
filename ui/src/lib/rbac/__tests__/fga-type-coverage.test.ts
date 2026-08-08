/**
 * FGA type-coverage guard (spec 2026-06-04-fga-coverage-guarantee, Layer 1).
 *
 * Guarantees that the set of resource (object) types agrees across all four
 * authoritative sources, so a NEW type cannot be introduced silently without
 * being registered (and therefore classified + given actions + default-deny
 * covered):
 *
 *   1. Authored OpenFGA model        — deploy/openfga/model.fga
 *   2. Deployed chart model          — charts/.../openfga/authorization-model.json
 *   3. TypeScript resource union     — UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES
 *   4. Runtime resource registry     — UNIVERSAL_REBAC_RESOURCE_TYPES
 *
 * Subject-only model types (authorization subjects, not actionable resources) are
 * tracked via an explicit allowlist with documented rationale; everything else MUST
 * appear in both the union and the registry.
 *
 * assisted-by Cursor claude-opus-4.8
 */

import { readFileSync } from "fs";
import { join } from "path";

import { UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES } from "@/types/rbac-universal";
import { UNIVERSAL_REBAC_RESOURCE_TYPES } from "../resource-model";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MODEL_FGA = join(REPO_ROOT, "deploy", "openfga", "model.fga");
const CHART_JSON = join(
  REPO_ROOT,
  "charts",
  "ai-platform-engineering",
  "charts",
  "openfga",
  "authorization-model.json",
);

/**
 * Model types that are authorization SUBJECTS, not actionable resources. They
 * legitimately exist in the OpenFGA model but must NOT appear in the resource
 * registry. Each entry needs a reason so the allowlist can't silently grow.
 */
const SUBJECT_ONLY_TYPES: Record<string, string> = {
  service_account: "Non-human principal; a subject in tuples, never an action target.",
  anonymous: "Unauthenticated-caller placeholder used by the AGW bridge; grants nothing.",
  webex_bot: "Configured Webex bot identity used only to identify an installation.",
  webex_bot_installation: "Bot-in-space identity used as an authorization subject.",
};

function parseModelFgaTypes(text: string): Set<string> {
  const types = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^type\s+([A-Za-z0-9_]+)\s*$/.exec(line);
    if (m) types.add(m[1]);
  }
  return types;
}

function parseChartJsonTypes(text: string): Set<string> {
  const model = JSON.parse(text) as { type_definitions: Array<{ type: string }> };
  return new Set(model.type_definitions.map((t) => t.type));
}

const modelTypes = parseModelFgaTypes(readFileSync(MODEL_FGA, "utf8"));
const chartTypes = parseChartJsonTypes(readFileSync(CHART_JSON, "utf8"));
const chartModel = JSON.parse(readFileSync(CHART_JSON, "utf8")) as {
  type_definitions: Array<{
    type: string;
    metadata?: {
      relations?: Record<
        string,
        { directly_related_user_types?: Array<{ type: string; relation?: string }> }
      >;
    };
  }>;
};
const unionTypes = new Set<string>(UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES);
const registryTypes = new Set<string>(UNIVERSAL_REBAC_RESOURCE_TYPES.map((d) => d.type));

const sorted = (s: Iterable<string>) => [...s].sort();

describe("fga type coverage", () => {
  it("authored model and deployed chart JSON declare the exact same object types", () => {
    expect(sorted(modelTypes)).toEqual(sorted(chartTypes));
  });

  it("the subject-only allowlist only contains types that exist in the model", () => {
    for (const t of Object.keys(SUBJECT_ONLY_TYPES)) {
      expect(modelTypes.has(t)).toBe(true);
    }
  });

  it("every non-subject model type is in BOTH the TS union and the runtime registry", () => {
    const actionable = sorted([...modelTypes].filter((t) => !(t in SUBJECT_ONLY_TYPES)));
    expect(sorted(unionTypes)).toEqual(actionable);
    expect(sorted(registryTypes)).toEqual(actionable);
  });

  it("the TS union and the runtime registry are identical", () => {
    expect(sorted(unionTypes)).toEqual(sorted(registryTypes));
  });

  it("authorizes Webex agent routes only through bot-scoped installations", () => {
    const authoredAgent = readFileSync(MODEL_FGA, "utf8")
      .split("type agent\n", 2)[1]
      ?.split("\ntype ", 1)[0];
    expect(authoredAgent).toContain("webex_bot_installation");
    expect(authoredAgent).not.toMatch(/define (reader|user): .*\bwebex_space\b/);

    const chartAgent = chartModel.type_definitions.find((definition) => definition.type === "agent");
    for (const relation of ["reader", "user"]) {
      const subjectTypes = chartAgent?.metadata?.relations?.[relation]
        ?.directly_related_user_types?.map((subject) => subject.type) ?? [];
      expect(subjectTypes).toContain("webex_bot_installation");
      expect(subjectTypes).not.toContain("webex_space");
    }
  });

  it("allows organization usersets generated for organization-owned secrets", () => {
    const secretRef = chartModel.type_definitions.find(
      (definition) => definition.type === "secret_ref",
    );
    const allowedSubjects = (relation: string) =>
      secretRef?.metadata?.relations?.[relation]?.directly_related_user_types ?? [];

    for (const relation of ["metadata_reader", "user"]) {
      expect(allowedSubjects(relation)).toEqual(
        expect.arrayContaining([
          { type: "organization", relation: "member" },
          { type: "organization", relation: "admin" },
        ]),
      );
    }
    for (const relation of ["manager", "auditor"]) {
      expect(allowedSubjects(relation)).toContainEqual({
        type: "organization",
        relation: "admin",
      });
    }
  });

  it("no registry/union type is missing from the authored model (no orphan registrations)", () => {
    for (const t of unionTypes) expect(modelTypes.has(t)).toBe(true);
    for (const t of registryTypes) expect(modelTypes.has(t)).toBe(true);
  });

  it.each(["data_source", "mcp_tool"])(
    "regression: actionable resource %s is registered (was previously missing)",
    (t) => {
      expect(unionTypes.has(t)).toBe(true);
      expect(registryTypes.has(t)).toBe(true);
    },
  );
});
