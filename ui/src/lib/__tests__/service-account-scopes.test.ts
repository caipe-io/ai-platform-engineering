/**
 * @jest-environment node
 */
/**
 * #43/#44 — isValidToolRef / parseScope must accept the REAL tool: object-id
 * shapes (the tool namespace has no single convention), and reject only
 * genuinely-malformed input. The per-scope can_call check is the real authz
 * bound; this is just a charset/shape filter.
 */

const mockReadOpenFgaTuples = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

import {
  isValidToolRef,
  listDirectServiceAccountKnowledgeScopes,
  parseScope,
  scopeWriteTuple,
  type ScopeRef,
} from "@/lib/service-account-scopes";

beforeEach(() => {
  mockReadOpenFgaTuples.mockReset();
});

describe("isValidToolRef", () => {
  it.each([
    "jira/search", // slash server/tool
    "jira/*", // slash server wildcard (the form the bridge enforces)
    "jira_search", // underscore (MCP-server-prefixed tool id)
    "knowledge-base_*", // underscore wildcard (legacy team-resources form)
    "knowledge-base/*", // slash wildcard with hyphenated server
    "dynamic-agents-builtin", // no separator
    "*", // bare wildcard
    "argocd_list_applications", // multiple underscores
  ])("accepts real tool-id shape %p", (ref) => {
    expect(isValidToolRef(ref)).toBe(true);
  });

  it.each([
    "", // empty
    "jira/search/extra", // more than one slash
    "jira search", // whitespace
    "jira,search", // comma
    "/search", // empty server segment
    "jira/", // empty tool segment
    "../etc", // path traversal-ish / leading dot-dot is fine charset-wise but '/' splits to '..' + 'etc'; '..' starts with '.', not alnum → rejected
  ])("rejects malformed tool ref %p", (ref) => {
    expect(isValidToolRef(ref)).toBe(false);
  });
});

describe("parseScope", () => {
  it("accepts an underscore-wildcard tool ref (team-resources legacy form)", () => {
    expect(parseScope({ type: "tool", ref: "knowledge-base_*" })).toEqual({
      scope: { type: "tool", ref: "knowledge-base_*" },
    });
  });

  it("accepts a slash-wildcard tool ref (new team-resources form)", () => {
    expect(parseScope({ type: "tool", ref: "knowledge-base/*" })).toEqual({
      scope: { type: "tool", ref: "knowledge-base/*" },
    });
  });

  it("rejects a genuinely malformed tool ref with a 400-style error", () => {
    const result = parseScope({ type: "tool", ref: "bad ref/with space" });
    expect(result.scope).toBeUndefined();
    expect(result.error).toMatch(/malformed tool ref/);
  });

  it("still validates agent refs against ID_SEGMENT (no slash/underscore games)", () => {
    expect(
      parseScope({ type: "agent", ref: "incident-resolver" }).scope,
    ).toEqual({
      type: "agent",
      ref: "incident-resolver",
    });
    expect(parseScope({ type: "agent", ref: "bad/agent" }).error).toMatch(
      /malformed agent ref/,
    );
  });

  it("accepts collection ids and rejects malformed collection refs", () => {
    expect(parseScope({ type: "collection", ref: "platform-rag" })).toEqual({
      scope: { type: "collection", ref: "platform-rag" },
    });
    expect(
      parseScope({ type: "collection", ref: "bad collection" }).error,
    ).toMatch(/malformed collection ref/);
  });

  it("writes a collection reader tuple", () => {
    expect(
      scopeWriteTuple(
        { type: "collection", ref: "platform-rag" },
        "service_account:sa-1",
      ),
    ).toEqual({
      user: "service_account:sa-1",
      relation: "reader",
      object: "rag_collection:platform-rag",
    });
  });
});

describe("scopeWriteTuple round-trips every accepted tool shape", () => {
  // The tuple object is `tool:${ref}` and detail/grantable stripType is a
  // prefix-strip, so any accepted ref must survive build → strip unchanged.
  it.each([
    "jira/search",
    "jira/*",
    "knowledge-base_*",
    "dynamic-agents-builtin",
    "*",
  ])("builds tool:%s without mangling the ref", (ref) => {
    const scope: ScopeRef = { type: "tool", ref };
    const tuple = scopeWriteTuple(scope, "service_account:sa-1");
    expect(tuple).toEqual({
      user: "service_account:sa-1",
      relation: "caller",
      object: `tool:${ref}`,
    });
    // Prefix-strip recovers the exact ref.
    expect(tuple.object.slice("tool:".length)).toBe(ref);
  });
});

describe("listDirectServiceAccountKnowledgeScopes", () => {
  it("reads each object type explicitly and returns only direct reader tuples", async () => {
    mockReadOpenFgaTuples.mockImplementation(
      async (input: { tuple: { object: string } }) => ({
        tuples:
          input.tuple.object === "data_source:"
            ? [
                {
                  key: {
                    user: "service_account:sa-1",
                    relation: "reader",
                    object: "data_source:source-1",
                  },
                },
              ]
            : [
                {
                  key: {
                    user: "service_account:sa-1",
                    relation: "reader",
                    object: "rag_collection:platform-rag",
                  },
                },
              ],
        continuationToken: undefined,
      }),
    );

    await expect(
      listDirectServiceAccountKnowledgeScopes("service_account:sa-1"),
    ).resolves.toEqual([
      { type: "collection", ref: "platform-rag" },
      { type: "datasource", ref: "source-1" },
    ]);
    expect(mockReadOpenFgaTuples).toHaveBeenNthCalledWith(1, {
      tuple: {
        user: "service_account:sa-1",
        relation: "reader",
        object: "data_source:",
      },
      continuationToken: undefined,
      pageSize: 100,
    });
    expect(mockReadOpenFgaTuples).toHaveBeenNthCalledWith(2, {
      tuple: {
        user: "service_account:sa-1",
        relation: "reader",
        object: "rag_collection:",
      },
      continuationToken: undefined,
      pageSize: 100,
    });
  });
});
