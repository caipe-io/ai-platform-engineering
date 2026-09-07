/**
 * @jest-environment node
 */
/**
 * Contract test for the explicit "search" capability
 * (spec 2026-06-03-explicit-search-capability).
 *
 * Locks the deployed OpenFGA authorization model so the org-level capability
 * cannot silently regress:
 *  - `organization#searcher` exists and is grantable to teams or explicitly
 *    scoped service accounts — never directly to a user or external group.
 *  - `organization#can_search` is the union `searcher or admin`, so org admins
 *    search implicitly and opted-in teams search explicitly.
 *
 * Reads the chart JSON (the runtime source of truth mounted into openfga-init).
 */

import { readFileSync } from "fs";
import { join } from "path";

interface RelationDef {
  union?: { child: Array<{ computedUserset?: { relation: string } }> };
  this?: Record<string, never>;
  computedUserset?: { relation: string };
}
interface TypeDef {
  type: string;
  relations: Record<string, RelationDef>;
  metadata?: {
    relations?: Record<string, { directly_related_user_types?: Array<{ type: string; relation?: string }> }>;
  };
}

const MODEL_PATH = join(
  __dirname,
  "../../../../../../charts/ai-platform-engineering/charts/openfga/authorization-model.json",
);

function loadOrgType(): TypeDef {
  const model = JSON.parse(readFileSync(MODEL_PATH, "utf8")) as {
    type_definitions: TypeDef[];
  };
  const org = model.type_definitions.find((t) => t.type === "organization");
  if (!org) throw new Error("organization type not found in authorization model");
  return org;
}

describe("organization search capability (contract)", () => {
  const org = loadOrgType();

  it("defines a `searcher` relation grantable to teams and service accounts", () => {
    expect(org.relations.searcher).toBeDefined();
    const allowed = org.metadata?.relations?.searcher?.directly_related_user_types ?? [];
    // Teams and explicitly scoped service accounts can receive the capability.
    expect(allowed).toEqual(
      expect.arrayContaining([
        { type: "service_account" },
        { type: "team", relation: "member" },
        { type: "team", relation: "admin" },
      ]),
    );
    // Individual users and externally asserted groups cannot self-grant it.
    const types = allowed.map((a) => a.type);
    expect(types).not.toContain("user");
    expect(types).not.toContain("external_group");
  });

  it("defines `can_search` as the union of `searcher` and `admin`", () => {
    const canSearch = org.relations.can_search;
    expect(canSearch).toBeDefined();
    const children = (canSearch.union?.child ?? []).map((c) => c.computedUserset?.relation);
    expect(children).toEqual(expect.arrayContaining(["searcher", "admin"]));
    expect(children).toHaveLength(2);
  });
});
