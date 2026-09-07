/**
 * Shareable-type drift check (spec 2026-06-03-unified-shareable-resource-rbac,
 * contract C5 / FR-007). For every type declared "shareable" it asserts:
 *
 *   1. `creator: [user]` is present.
 *   2. `creator` is referenced by NO `can_*` permission (audit-only).
 *   3. `can_manage` resolves through `manager` and/or `owner`.
 *   4. The authored `.fga` and the deployed chart JSON forms agree on the
 *      type's relations (so a future type can't silently diverge).
 *
 * This is the CI guard that stops a new shareable type from accidentally
 * wiring `creator` into authority or forgetting the audit relation entirely.
 */

import { readFileSync } from "fs";
import { join } from "path";

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

/** Types that carry the canonical shareable shape (owner team + share-with-teams). */
const SHAREABLE_TYPES = [
  "agent",
  "rag_collection",
  "knowledge_base",
  "data_source",
  "mcp_tool",
  "ingestion_source",
] as const;

describe("rag_collection management/search separation", () => {
  const collection = () => modelTypes.get("rag_collection")!;
  const chartCollection = () => chartTypes.get("rag_collection")!;

  it("does not derive query access from owner, publisher, or manager", () => {
    expect(collection().definitions.get("can_read")).toBe("reader");
    const chartCanRead = JSON.stringify(chartCollection().relations.can_read);
    expect(chartCanRead).toContain('"relation":"reader"');
    expect(chartCanRead).not.toMatch(
      /owner|publisher|manager|can_publish|can_manage/,
    );
  });

  it("still lets non-reader maintainers discover the control-plane object", () => {
    expect(collection().definitions.get("can_discover")).toBe(
      "can_read or can_publish or can_manage",
    );
    const chartCanDiscover = JSON.stringify(
      chartCollection().relations.can_discover,
    );
    expect(chartCanDiscover).toContain('"relation":"can_read"');
    expect(chartCanDiscover).toContain('"relation":"can_publish"');
    expect(chartCanDiscover).toContain('"relation":"can_manage"');
  });
});

interface ParsedType {
  relations: Set<string>;
  /** relation name → its raw definition expression (right of the colon). */
  definitions: Map<string, string>;
}

/** Parse `model.fga` into a map of type name → relations + definitions. */
function parseModelFga(text: string): Map<string, ParsedType> {
  const types = new Map<string, ParsedType>();
  let current: ParsedType | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    const typeMatch = /^type\s+([A-Za-z0-9_]+)\s*$/.exec(line.trim());
    if (typeMatch) {
      current = { relations: new Set(), definitions: new Map() };
      types.set(typeMatch[1], current);
      continue;
    }
    const defMatch = /^\s+define\s+([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line);
    if (defMatch && current) {
      current.relations.add(defMatch[1]);
      current.definitions.set(defMatch[1], defMatch[2].trim());
    }
  }
  return types;
}

interface ChartType {
  relations: Record<string, unknown>;
  metadata?: {
    relations?: Record<
      string,
      { directly_related_user_types?: Array<{ type: string }> }
    >;
  };
}

function parseChartJson(text: string): Map<string, ChartType> {
  const model = JSON.parse(text) as {
    type_definitions: Array<{
      type: string;
      relations?: Record<string, unknown>;
      metadata?: ChartType["metadata"];
    }>;
  };
  const out = new Map<string, ChartType>();
  for (const t of model.type_definitions) {
    out.set(t.type, { relations: t.relations ?? {}, metadata: t.metadata });
  }
  return out;
}

const modelTypes = parseModelFga(readFileSync(MODEL_FGA, "utf8"));
const chartTypes = parseChartJson(readFileSync(CHART_JSON, "utf8"));

describe.each(SHAREABLE_TYPES)("shareable type drift: %s", (typeName) => {
  it("exists in both the authored model and the chart JSON", () => {
    expect(modelTypes.has(typeName)).toBe(true);
    expect(chartTypes.has(typeName)).toBe(true);
  });

  it("declares `creator: [user]` (audit relation present)", () => {
    const t = modelTypes.get(typeName)!;
    expect(t.relations.has("creator")).toBe(true);
    expect(t.definitions.get("creator")).toBe("[user]");
  });

  it("never references `creator` in any can_* permission", () => {
    const t = modelTypes.get(typeName)!;
    for (const [relation, definition] of t.definitions) {
      if (!relation.startsWith("can_")) continue;
      // word-boundary match so `creator` is not confused with substrings.
      expect(definition).not.toMatch(/\bcreator\b/);
    }
  });

  it("resolves can_manage through manager and/or owner", () => {
    const t = modelTypes.get(typeName)!;
    const canManage = t.definitions.get("can_manage") ?? "";
    expect(/\bmanager\b/.test(canManage) || /\bowner\b/.test(canManage)).toBe(
      true,
    );
  });

  it("agrees between authored .fga and chart JSON on the relation set", () => {
    const model = modelTypes.get(typeName)!;
    const chart = chartTypes.get(typeName)!;
    const chartRelations = new Set(Object.keys(chart.relations));
    expect([...chartRelations].sort()).toEqual([...model.relations].sort());
  });

  it("declares `creator` as a user relation in the chart JSON too", () => {
    const chart = chartTypes.get(typeName)!;
    const directTypes =
      chart.metadata?.relations?.creator?.directly_related_user_types ?? [];
    expect(directTypes.map((d) => d.type)).toEqual(["user"]);
  });

  it("the chart JSON `can_*` definitions never resolve through `creator` (grants nothing)", () => {
    // Structural equivalent of `Check(user:C, can_manage, <type>:X) == false`
    // when only a `creator` tuple exists: if no permission's userset graph
    // references the `creator` relation, a creator tuple can grant no access.
    const chart = chartTypes.get(typeName)!;
    for (const [relation, def] of Object.entries(chart.relations)) {
      if (!relation.startsWith("can_")) continue;
      const serialized = JSON.stringify(def);
      expect(serialized).not.toContain('"creator"');
    }
  });
});

describe("data_source parent_kb inheritance (US4)", () => {
  const ds = () => modelTypes.get("data_source")!;
  const dsChart = () => chartTypes.get("data_source")!;

  it("declares `parent_kb: [knowledge_base]` in the authored model", () => {
    expect(ds().relations.has("parent_kb")).toBe(true);
    expect(ds().definitions.get("parent_kb")).toBe("[knowledge_base]");
  });

  it.each(["can_read", "can_ingest", "can_manage"])(
    "inherits %s from parent_kb in the authored model",
    (perm) => {
      const def = ds().definitions.get(perm) ?? "";
      expect(def).toContain(`${perm} from parent_kb`);
    },
  );

  it("declares `parent_kb` as a knowledge_base relation in the chart JSON", () => {
    const directTypes =
      dsChart().metadata?.relations?.parent_kb?.directly_related_user_types ??
      [];
    expect(directTypes.map((d) => d.type)).toEqual(["knowledge_base"]);
  });

  it.each(["can_read", "can_ingest", "can_manage"])(
    "has a parent_kb tupleToUserset for %s in the chart JSON (round-trips the `from` form)",
    (perm) => {
      const def = dsChart().relations[perm] as {
        union?: { child?: Array<Record<string, unknown>> };
      };
      const children = def.union?.child ?? [];
      const hasTtu = children.some((c) => {
        const ttu = (
          c as {
            tupleToUserset?: {
              tupleset?: { relation?: string };
              computedUserset?: { relation?: string };
            };
          }
        ).tupleToUserset;
        return (
          ttu?.tupleset?.relation === "parent_kb" &&
          ttu?.computedUserset?.relation === perm
        );
      });
      expect(hasTtu).toBe(true);
    },
  );
});
