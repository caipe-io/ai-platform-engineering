/**
 * @jest-environment node
 */
/**
 * Tests for GET /api/rbac/kb-tab-gates.
 *
 * Covers the Knowledge sidebar tab-gating contract (spec 2026-06-03 — explicit
 * ingest capability):
 * - Org admins short-circuit and see every tab (+ can_ingest).
 * - Non-admins with at least one readable KB see Search / Data Sources /
 *   Graph / MCP Tools.
 * - `can_ingest` is now an EXPLICIT org-level capability check
 *   (`organization#can_ingest`), DECOUPLED from per-KB ingest grants: a user
 *   may read+ingest several KBs yet still get `can_ingest: false` unless their
 *   team was opted in.
 * - Non-admins with zero readable KBs AND no explicit capability see no tabs
 *   and have_any_kb=false.
 * - Explicit capabilities unlock their feature tab even before any KB is
 *   assigned: `can_search` → Search + MCP Tools; `can_ingest` → Data Sources.
 *   `graph` remains purely read-driven (needs readable content).
 * - The `RAG_ADMIN_BYPASS_DISABLED` env var disables the org-admin
 *   short-circuit and forces a per-resource path.
 * - The route fails closed (all tabs hidden) on RAG / OpenFGA errors.
 */

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

const mockCheckOpenFgaTuple = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

const mockFilterResourcesByPermission = jest.fn();
jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
}));

const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import { getServerSession } from "next-auth";
import { isBootstrapAdmin } from "@/lib/auth-config";
import { GET } from "@/app/api/rbac/kb-tab-gates/route";

/**
 * Make the OpenFGA check mock relation-aware: `can_manage` drives the
 * org-admin short-circuit; `can_ingest` drives the explicit author capability.
 */
function setOrgChecks(opts: {
  can_manage?: boolean;
  can_ingest?: boolean;
  can_search?: boolean;
}) {
  mockCheckOpenFgaTuple.mockImplementation(async (tuple: { relation: string }) => {
    if (tuple.relation === "can_manage") return { allowed: Boolean(opts.can_manage) };
    if (tuple.relation === "can_ingest") return { allowed: Boolean(opts.can_ingest) };
    if (tuple.relation === "can_search") return { allowed: Boolean(opts.can_search) };
    return { allowed: false };
  });
}

describe("GET /api/rbac/kb-tab-gates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isBootstrapAdmin as jest.Mock).mockReturnValue(false);
    setOrgChecks({ can_manage: false, can_ingest: false, can_search: false });
    mockFilterResourcesByPermission.mockResolvedValue([]);
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    delete process.env.RAG_ADMIN_BYPASS_DISABLED;
    process.env.RAG_SERVER_URL = "http://rag.test";
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ datasources: [] }),
      } as Response),
    ) as jest.Mock;
  });

  it("returns 401 when no session", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("org admin (OpenFGA) sees every tab, kb_count=-1, can_ingest=true", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    setOrgChecks({ can_manage: true });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      gates: {
        search: true,
        collections: true,
        data_sources: true,
        graph: true,
        mcp_tools: true,
        has_any_kb: true,
        kb_count: -1,
        can_ingest: true,
        can_search: true,
      },
      org_admin_bypass: true,
    });
    // The route MUST NOT hit RAG when the org-admin bypass short-circuits.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockFilterResourcesByPermission).not.toHaveBeenCalled();
  });

  it("bootstrap-admin email is treated as org admin even without OpenFGA tuple", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "boot-sub",
      user: { email: "bootstrap@example.com" },
    });
    (isBootstrapAdmin as jest.Mock).mockReturnValue(true);

    const res = await GET();
    const body = await res.json();
    expect(body.org_admin_bypass).toBe(true);
    expect(body.gates.has_any_kb).toBe(true);
    expect(body.gates.can_ingest).toBe(true);
    // OpenFGA is never queried when bootstrap-admin short-circuits.
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("non-admin who can read AND holds the org author capability gets can_ingest=true", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "alice-sub",
      user: { email: "alice@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: true, can_search: true });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ datasources: [{ datasource_id: "kb-alpha" }] }),
    });
    mockFilterResourcesByPermission.mockResolvedValue([{ datasource_id: "kb-alpha" }]);

    const res = await GET();
    const body = await res.json();

    expect(body.org_admin_bypass).toBe(false);
    expect(body.gates).toEqual({
      search: true,
      collections: true,
      data_sources: true,
      graph: true,
      mcp_tools: true,
      has_any_kb: true,
      kb_count: 1,
      can_ingest: true,
      can_search: true,
    });
    // Read visibility is the ONLY datasource enumeration; ingest is a single
    // org-capability check (no per-KB ingest enumeration).
    expect(mockFilterResourcesByPermission).toHaveBeenCalledTimes(1);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.any(Object),
      [{ datasource_id: "kb-alpha" }],
      expect.objectContaining({ type: "knowledge_base", action: "read" }),
      { bypassForOrgAdmin: false },
    );
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith(
      expect.objectContaining({ relation: "can_ingest", object: "organization:caipe" }),
    );
  });

  it("non-admin reader WITHOUT the org author capability gets can_ingest=false", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "reader-sub",
      user: { email: "reader@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: false });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ datasources: [{ datasource_id: "kb-alpha" }] }),
    });
    // Reader can read several KBs but holds no org author capability.
    mockFilterResourcesByPermission.mockResolvedValue([{ datasource_id: "kb-alpha" }]);

    const res = await GET();
    const body = await res.json();

    expect(body.gates.has_any_kb).toBe(true);
    expect(body.gates.kb_count).toBe(1);
    expect(body.gates.can_ingest).toBe(false);
    expect(body.gates).not.toHaveProperty("ingest_kb_count");
  });

  it("non-admin with zero readable KBs sees no tabs and has_any_kb=false", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "newbie-sub",
      user: { email: "newbie@example.com" },
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ datasources: [{ datasource_id: "kb-x" }, { datasource_id: "kb-y" }] }),
    });
    setOrgChecks({ can_manage: false, can_ingest: false });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();

    expect(body.gates).toEqual({
      search: false,
      collections: false,
      data_sources: false,
      graph: false,
      mcp_tools: false,
      has_any_kb: false,
      kb_count: 0,
      can_ingest: false,
      can_search: false,
    });
  });

  it("search and graph require the explicit can_search capability even with readable KBs", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "viewer-sub",
      user: { email: "viewer@example.com" },
    });
    // Reads a KB and can_ingest, but NOT can_search → Search tab stays off.
    setOrgChecks({ can_manage: false, can_ingest: true, can_search: false });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ datasources: [{ datasource_id: "kb-alpha" }] }),
    });
    mockFilterResourcesByPermission.mockResolvedValue([{ datasource_id: "kb-alpha" }]);

    const res = await GET();
    const body = await res.json();
    expect(body.gates.has_any_kb).toBe(true);
    expect(body.gates.can_search).toBe(false);
    expect(body.gates.graph).toBe(false);
    expect(body.gates.search).toBe(false);
    // Other read-driven tabs remain visible.
    expect(body.gates.data_sources).toBe(true);
  });

  it("search is on when the user holds can_search AND has readable KBs", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "searcher-sub",
      user: { email: "searcher@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: false, can_search: true });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ datasources: [{ datasource_id: "kb-alpha" }] }),
    });
    mockFilterResourcesByPermission.mockResolvedValue([{ datasource_id: "kb-alpha" }]);

    const res = await GET();
    const body = await res.json();
    expect(body.gates.can_search).toBe(true);
    expect(body.gates.search).toBe(true);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith(
      expect.objectContaining({ relation: "can_search", object: "organization:caipe" }),
    );
  });

  it("search is ON when can_search is held even with no readable KB (capability gates the tab; results scoped server-side)", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "empty-sub",
      user: { email: "empty@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: false, can_search: true });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    // Regression guard (org admin granted the team Search but assigned no KB
    // yet): the explicit capability MUST unlock the Search + MCP Tools tabs even
    // though has_any_kb is false. The server still scopes /v1/query results to
    // readable datasources, so an empty result set is the expected UX.
    expect(body.gates.can_search).toBe(true);
    expect(body.gates.has_any_kb).toBe(false);
    expect(body.gates.search).toBe(true);
    expect(body.gates.mcp_tools).toBe(true);
    // Read-only graph still needs readable content.
    expect(body.gates.graph).toBe(false);
    // No ingest capability → Data Sources stays hidden.
    expect(body.gates.data_sources).toBe(false);
  });

  it("can_ingest unlocks Data Sources even with no readable KB (author-first, chicken-and-egg)", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "author-sub",
      user: { email: "author@example.com" },
    });
    // Holds the author capability but currently reads no KBs.
    setOrgChecks({ can_manage: false, can_ingest: true });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    expect(body.gates.has_any_kb).toBe(false);
    expect(body.gates.can_ingest).toBe(true);
    // Regression guard: a team granted ingest with no KB assigned must still be
    // able to open Data Sources to author its first source.
    expect(body.gates.data_sources).toBe(true);
    // No search capability → Search/MCP Tools stay hidden.
    expect(body.gates.search).toBe(false);
    expect(body.gates.mcp_tools).toBe(false);
  });

  it("both capabilities granted with no KB assigned unlocks Search, Data Sources, and MCP Tools (screenshot-2 scenario)", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "newteam-sub",
      user: { email: "member@example.com" },
    });
    // Org admin enabled BOTH "Search knowledge bases" and "Create / ingest data
    // sources" for the team, but assigned no KBs yet.
    setOrgChecks({ can_manage: false, can_ingest: true, can_search: true });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    expect(body.gates).toEqual({
      search: true,
      collections: true,
      data_sources: true,
      graph: false,
      mcp_tools: true,
      has_any_kb: false,
      kb_count: 0,
      can_ingest: true,
      can_search: true,
    });
  });

  it("RAG_ADMIN_BYPASS_DISABLED=true disables the org-admin short-circuit", async () => {
    process.env.RAG_ADMIN_BYPASS_DISABLED = "true";
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    // Even though can_manage would be true, the kill switch forces non-admin.
    setOrgChecks({ can_manage: true, can_ingest: true });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ datasources: [{ datasource_id: "kb-1" }] }),
    });
    mockFilterResourcesByPermission.mockResolvedValue([{ datasource_id: "kb-1" }]);

    const res = await GET();
    const body = await res.json();
    expect(body.org_admin_bypass).toBe(false);
    expect(body.gates.kb_count).toBe(1);
    expect(body.gates.can_ingest).toBe(true);
    // Single upstream RAG enumeration for read visibility.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when RAG /v1/datasources returns a 5xx", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "alice-sub",
      user: { email: "alice@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: false });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const res = await GET();
    const body = await res.json();
    expect(body.gates.has_any_kb).toBe(false);
    expect(body.gates.kb_count).toBe(0);
    expect(body.gates.can_ingest).toBe(false);
  });

  it("returns empty gates when the session has no access token", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      sub: "no-token-sub",
      user: { email: "no-token@example.com" },
    });
    const res = await GET();
    const body = await res.json();
    expect(body.gates.has_any_kb).toBe(false);
    expect(body.gates.can_ingest).toBe(false);
    expect(body.gates.data_sources).toBe(false);
    expect(body.org_admin_bypass).toBe(false);
  });

  it("data_sources is true for a non-admin with a readable ingestion source", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "reader-sub",
      user: { email: "reader@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: false, can_search: false });
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ source_id: "slack-channel-C1" }]),
      }),
    });
    mockFilterResourcesByPermission.mockImplementation(async (_session, items: unknown[], target: { type: string }) =>
      target.type === "ingestion_source" ? items : [],
    );

    const res = await GET();
    const body = await res.json();
    expect(body.gates.data_sources).toBe(true);
    expect(body.gates.has_any_kb).toBe(false);
  });

  it("data_sources is true for a non-admin with can_ingest but zero readable sources", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "author-sub",
      user: { email: "author@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: true, can_search: false });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    expect(body.gates.data_sources).toBe(true);
  });

  it("data_sources is false for a non-admin with no readable sources and no can_ingest", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "nobody-sub",
      user: { email: "nobody@example.com" },
    });
    setOrgChecks({ can_manage: false, can_ingest: false, can_search: false });
    mockFilterResourcesByPermission.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    expect(body.gates.data_sources).toBe(false);
  });
});
