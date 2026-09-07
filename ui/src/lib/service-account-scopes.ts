/**
 * Shared scope helpers for the Service Accounts BFF routes.
 *
 * A "scope" is an agent, tool, RAG datasource, or RAG collection grant. These
 * helpers centralize:
 *  - boundary validation of a scope ref (constitution VII)
 *  - the OpenFGA tuple the EDITOR must hold to grant it (FR-006/008/015)
 *  - the BASE OpenFGA tuple reconciled for the service account (the policy
 *    writer rejects materialized `can_*` relations — agent→`user`,
 *    tool→`caller`, datasource→`reader`)
 *
 * Spec: docs/docs/specs/2026-06-05-service-accounts/.
 */

import { readOpenFgaTuples, type OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { RAG_COLLECTION_ID_PATTERN } from "@/types/rag-collection";

/** OpenFGA-safe id segment (agent id, tool server, tool name). */
export const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** RAG datasource ids use the platform-wide OpenFGA object-id alphabet. */
const DATASOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

/**
 * One segment of a tool ref. Either a bare `*`, or an OpenFGA-safe id
 * (alphanumerics + `. _ -`) with an OPTIONAL trailing `*` wildcard. The trailing
 * star covers the underscore-wildcard form `<server>_*` (legacy team-resources)
 * as well as plain ids (`jira_search`, `dynamic-agents-builtin`). A star is only
 * valid as a whole segment or as a single trailing char — never embedded.
 */
const TOOL_SEGMENT = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._-]*\*?)$/;

export interface ScopeRef {
  type: "agent" | "tool" | "datasource" | "collection";
  /** Agent, datasource, or collection id; tools use their object id. */
  ref: string;
}

/**
 * A scope as surfaced by the Unlinked Access resolver, annotated with where the
 * grant comes from:
 *  - `"everyone"` — an agent, datasource, or collection shared with Everyone.
 *    Owned by that resource's sharing settings, so it is read-only here.
 *  - `"explicit"` — added directly to the unlinked SA via this panel; removable.
 */
export interface UnlinkedScope extends ScopeRef {
  source: "everyone" | "explicit";
}

/**
 * Strip the `type:` prefix from an OpenFGA object id (`agent:default` →
 * `default`), yielding the scope `ref`. `listOpenFgaObjects` returns full
 * object ids; scope refs and Mongo snapshots store the bare id.
 */
export function refFromObject(object: string): string {
  return object.slice(object.indexOf(":") + 1);
}

/**
 * Validate a tool ref. A tool ref is just an OpenFGA-safe `tool:` object id —
 * the create route's job is to reject GENUINELY malformed input, NOT to mandate
 * a single `<server>/<tool>` convention (the tool namespace doesn't follow one).
 * Real shapes that all exist in the model + must be accepted (#43, #44):
 *   - `jira/search`            slash server/tool
 *   - `jira/*`                 slash server wildcard (the form the bridge enforces)
 *   - `jira_search`            underscore (MCP-server-prefixed tool id)
 *   - `knowledge-base_*`       underscore wildcard (legacy team-resources form)
 *   - `dynamic-agents-builtin` no separator
 *   - `*`                      bare wildcard
 * Rejected: empty, anything with whitespace / disallowed chars, or more than one
 * slash. The real authorization bound is the per-scope `can_call` check, not this
 * shape filter.
 */
export function isValidToolRef(ref: string): boolean {
  if (!ref) return false;
  if (ref === "*") return true;
  const slashCount = (ref.match(/\//g) ?? []).length;
  if (slashCount > 1) return false;
  if (slashCount === 0) {
    // Single segment (underscore / no-separator / bare-name forms).
    return TOOL_SEGMENT.test(ref);
  }
  // Exactly one slash: `<server>/<tool>` or `<server>/*`.
  const slash = ref.indexOf("/");
  const server = ref.slice(0, slash);
  const tool = ref.slice(slash + 1);
  return TOOL_SEGMENT.test(server) && TOOL_SEGMENT.test(tool);
}

/**
 * Validate + normalize a raw scope object from a request body. Returns the
 * typed scope, or an error string for a 400.
 */
export function parseScope(raw: unknown): { scope?: ScopeRef; error?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "scope must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const ref = typeof obj.ref === "string" ? obj.ref.trim() : "";
  if (obj.type === "agent") {
    if (!ID_SEGMENT.test(ref)) return { error: `malformed agent ref: ${ref}` };
    return { scope: { type: "agent", ref } };
  }
  if (obj.type === "tool") {
    if (!isValidToolRef(ref)) return { error: `malformed tool ref: ${ref}` };
    return { scope: { type: "tool", ref } };
  }
  if (obj.type === "datasource") {
    if (!DATASOURCE_ID.test(ref))
      return { error: `malformed datasource ref: ${ref}` };
    return { scope: { type: "datasource", ref } };
  }
  if (obj.type === "collection") {
    if (!RAG_COLLECTION_ID_PATTERN.test(ref)) {
      return { error: `malformed collection ref: ${ref}` };
    }
    return { scope: { type: "collection", ref } };
  }
  return {
    error: "scope.type must be 'agent', 'tool', 'datasource', or 'collection'",
  };
}

/** The (relation, object) an EDITOR must hold to grant this scope (FR-006/008/015). */
export function scopeCheckTuple(
  scope: ScopeRef,
  editorSubject: string,
): OpenFgaTupleKey {
  if (scope.type === "agent") {
    return {
      user: editorSubject,
      relation: "can_use",
      object: `agent:${scope.ref}`,
    };
  }
  if (scope.type === "datasource") {
    return {
      user: editorSubject,
      relation: "can_read",
      object: `data_source:${scope.ref}`,
    };
  }
  if (scope.type === "collection") {
    return {
      user: editorSubject,
      relation: "can_read",
      object: `rag_collection:${scope.ref}`,
    };
  }
  return {
    user: editorSubject,
    relation: "can_call",
    object: `tool:${scope.ref}`,
  };
}

/**
 * The BASE OpenFGA tuple to write/delete for a service-account scope grant.
 * `writeOpenFgaTuples`/`deleteExactOpenFgaTuples` reject materialized `can_*`
 * relations, so agent grants write the `user` relation and tool grants write
 * `caller` (mirrors team-resource grant writes).
 */
export function scopeWriteTuple(
  scope: ScopeRef,
  saSubject: string,
): OpenFgaTupleKey {
  if (scope.type === "agent") {
    return { user: saSubject, relation: "user", object: `agent:${scope.ref}` };
  }
  if (scope.type === "datasource") {
    return {
      user: saSubject,
      relation: "reader",
      object: `data_source:${scope.ref}`,
    };
  }
  if (scope.type === "collection") {
    return {
      user: saSubject,
      relation: "reader",
      object: `rag_collection:${scope.ref}`,
    };
  }
  return { user: saSubject, relation: "caller", object: `tool:${scope.ref}` };
}

/**
 * Read direct knowledge grants for a service account.
 *
 * A collection grant makes all of its member datasources readable. Listing
 * effective datasource access would therefore expand one collection into
 * hundreds of apparent datasource scopes. The management API must show and
 * remove only the grants the user actually selected.
 */
export async function listDirectServiceAccountKnowledgeScopes(
  saSubject: string,
): Promise<ScopeRef[]> {
  const scopes = new Map<string, ScopeRef>();
  const types = [
    { scopeType: "datasource" as const, objectPrefix: "data_source:" },
    { scopeType: "collection" as const, objectPrefix: "rag_collection:" },
  ];

  for (const { scopeType, objectPrefix } of types) {
    let continuationToken: string | undefined;
    do {
      // OpenFGA requires Read filters to include an object type. Reading each
      // direct knowledge type separately also prevents collection-inherited
      // datasource access from appearing as an explicit scope.
      const page = await readOpenFgaTuples({
        tuple: {
          user: saSubject,
          relation: "reader",
          object: objectPrefix,
        },
        continuationToken,
        pageSize: 100,
      });
      for (const { key } of page.tuples) {
        if (
          key.user !== saSubject ||
          key.relation !== "reader" ||
          !key.object.startsWith(objectPrefix)
        ) {
          continue;
        }
        const ref = key.object.slice(objectPrefix.length);
        if (ref) {
          scopes.set(`${scopeType}:${ref}`, { type: scopeType, ref });
        }
      }
      continuationToken = page.continuationToken;
    } while (continuationToken);
  }

  return [...scopes.values()].sort((left, right) =>
    `${left.type}:${left.ref}`.localeCompare(`${right.type}:${right.ref}`),
  );
}
