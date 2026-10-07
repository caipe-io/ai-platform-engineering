import { authOptions,isBootstrapAdmin } from "@/lib/auth-config";
import { getCollection } from "@/lib/mongodb";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import type { KbTabGatesMap } from "@/lib/rbac/types";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

/**
 * GET /api/rbac/kb-tab-gates
 *
 * Returns visibility for the four tabs in the Knowledge sidebar
 * (`search`, `data_sources`, `graph`, `mcp_tools`) plus the convenience
 * `has_any_kb` flag the sidebar uses to render an empty-state banner.
 *
 * Decision order (mirrors `/api/rbac/admin-tab-gates`):
 *   1. Org admin (`organization#admin` via `can_manage organization:<key>`)
 *      or `BOOTSTRAP_ADMIN_EMAILS` → all tabs visible, `kb_count: -1` ("admin
 *      bypass, unknown count"), `has_any_kb: true`. This is the documented
 *      org-admin super-grant.
 *   2. Non-admin → resolve two independent signals:
 *        a. Read count: list `/v1/datasources` from the RAG server (proxied
 *           with the session's bearer token) and filter via
 *           `filterResourcesByPermission` on `knowledge_base:<id>#can_read`.
 *           `has_any_kb` / `kb_count` and the `graph` tab derive from this.
 *        b. Explicit org capabilities: `organization#can_ingest` and
 *           `organization#can_search` (team-granted via the admin toggles).
 *      Tab visibility then combines them so a capability alone is enough to
 *      reach its feature even before any KB is assigned:
 *        - `search`       = can_search
 *        - `data_sources` = has_any_kb OR can_ingest
 *        - `mcp_tools`    = has_any_kb OR can_search
 *        - `graph`        = has_any_kb AND can_search
 *      Server-side data paths re-check the same capabilities and scope results
 *      to readable datasources, so an enabled-but-empty tab never leaks data.
 *
 * Kill switch: `RAG_ADMIN_BYPASS_DISABLED=true` disables the org-admin
 * super-grant and forces a per-resource path even for admins, matching the
 * behaviour of `filterResourcesByPermission({ bypassForOrgAdmin: true })`.
 *
 * Failure mode: fails closed (all tabs hidden) on any backend error so the
 * sidebar never silently exposes a tab that the API would 403.
 */
const EMPTY_GATES: KbTabGatesMap = {
  search: false,
  collections: false,
  data_sources: false,
  graph: false,
  mcp_tools: false,
  has_any_kb: false,
  kb_count: 0,
  can_ingest: false,
  can_search: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSessionSubject(session: {
  accessToken?: string;
  sub?: string;
}): string | undefined {
  if (session.sub) return session.sub;
  if (!session.accessToken) return undefined;
  try {
    const parts = session.accessToken.split(".");
    if (parts.length < 2) return undefined;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as
      | { sub?: unknown }
      | undefined;
    return typeof payload?.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

function isOrgAdminBypassKillSwitchEnabled(): boolean {
  const raw = process.env.RAG_ADMIN_BYPASS_DISABLED;
  if (!raw) return false;
  return raw === "1" || raw.trim().toLowerCase() === "true";
}

async function isOrgAdmin(session: {
  accessToken?: string;
  sub?: string;
  user?: { email?: string | null };
}): Promise<boolean> {
  if (isOrgAdminBypassKillSwitchEnabled()) return false;
  if (isBootstrapAdmin(session.user?.email ?? "")) return true;
  const subject = getSessionSubject(session);
  if (!subject) return false;
  try {
    const decision = await checkOpenFgaTuple({
      user: `user:${subject}`,
      relation: "can_manage",
      object: organizationObjectId(),
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

function datasourceIdOf(resource: Record<string, unknown>): string {
  const value = resource.datasource_id ?? resource.id;
  return typeof value === "string" ? value : "";
}

/**
 * Count how many datasources the caller can `can_read`, by enumerating the RAG
 * `/v1/datasources` list and filtering on `knowledge_base:<id>#can_read`. This
 * read count drives the `search`/`data_sources`/`graph`/`mcp_tools` tab
 * visibility and `has_any_kb`. Fails closed (zero) on any error.
 *
 * Note: the ingest gate is NO LONGER derived from this enumeration. Authoring
 * new data sources is an explicit org-level capability (`organization#can_ingest`,
 * spec 2026-06-03) checked separately in `orgCanIngest`, so per-KB ingest grants
 * no longer implicitly grant authoring.
 */
async function loadReadableKbCount(session: {
  sub?: string;
  role?: string;
  user?: { email?: string | null };
  accessToken: string;
  org?: string;
}): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (session.org) headers["X-Tenant-Id"] = session.org;

  let response: Response;
  try {
    response = await fetch(`${getRagServerUrl()}/v1/datasources`, {
      method: "GET",
      headers,
    });
  } catch {
    return 0;
  }
  if (!response.ok) return 0;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return 0;
  }
  if (!isRecord(data) || !Array.isArray((data as { datasources?: unknown }).datasources)) {
    return 0;
  }

  const candidates = (data as { datasources: unknown[] }).datasources
    .filter(isRecord)
    .filter((resource) => datasourceIdOf(resource));
  if (candidates.length === 0) return 0;

  const principal = { sub: session.sub, role: session.role, user: session.user };
  try {
    const readable = await filterResourcesByPermission(
      principal,
      candidates,
      { type: "knowledge_base", action: "read", id: datasourceIdOf },
      { bypassForOrgAdmin: false },
    );
    return readable.length;
  } catch {
    return 0;
  }
}

/**
 * Count how many `rag_ingestion_sources` records the caller can `can_read`,
 * analogous to {@link loadReadableKbCount} but reading Mongo directly (there
 * is no RAG-server-side enumeration for pre-ingestion source configs). Feeds
 * into the merged `data_sources` tab visibility so a caller with a pending
 * (not-yet-ingested) config row can still open the tab. Fails closed (zero)
 * on any error.
 */
async function loadReadableIngestionSourceCount(session: {
  sub?: string;
  role?: string;
  user?: { email?: string | null };
}): Promise<number> {
  try {
    const collection = await getCollection<IngestionSourceConfig>("rag_ingestion_sources");
    const candidates = await collection.find({}).project({ source_id: 1 }).toArray();
    if (candidates.length === 0) return 0;

    const readable = await filterResourcesByPermission(
      session,
      candidates,
      { type: "ingestion_source", action: "read", id: (source) => source.source_id },
      { bypassForOrgAdmin: false },
    );
    return readable.length;
  } catch {
    return 0;
  }
}

/**
 * Explicit "data source author" capability check (spec 2026-06-03). Returns
 * true iff the caller holds `organization#can_ingest` — i.e. they are a member
 * of a team that an org admin opted in via the ingest capability toggle (or
 * they are an org admin, who satisfy `can_ingest` through `admin`). Fails
 * closed (false) on any error.
 */
async function orgCanIngest(session: { sub?: string }): Promise<boolean> {
  const subject = session.sub;
  if (!subject) return false;
  try {
    const decision = await checkOpenFgaTuple({
      user: `user:${subject}`,
      relation: "can_ingest",
      object: organizationObjectId(),
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

/**
 * Explicit "search" capability check (spec
 * 2026-06-03-explicit-search-capability). Returns true iff the caller holds
 * `organization#can_search` — i.e. they are a member of a team an org admin
 * opted in via the search capability toggle (or they are an org admin, who
 * satisfy `can_search` through `admin`). Fails closed (false) on any error.
 */
async function orgCanSearch(session: { sub?: string }): Promise<boolean> {
  const subject = session.sub;
  if (!subject) return false;
  try {
    const decision = await checkOpenFgaTuple({
      user: `user:${subject}`,
      relation: "can_search",
      object: organizationObjectId(),
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

export async function GET() {
  const session = (await getServerSession(authOptions)) as
    | {
        accessToken?: string;
        sub?: string;
        role?: string;
        org?: string;
        user?: { email?: string | null };
      }
    | null;

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await isOrgAdmin(session)) {
    const gates: KbTabGatesMap = {
      search: true,
      collections: true,
      data_sources: true,
      graph: true,
      mcp_tools: true,
      has_any_kb: true,
      kb_count: -1,
      can_ingest: true,
      can_search: true,
    };
    return NextResponse.json({ gates, org_admin_bypass: true });
  }

  if (!session.accessToken) {
    return NextResponse.json({ gates: EMPTY_GATES, org_admin_bypass: false });
  }

  // Read visibility (tabs) and the explicit author/search capabilities are
  // independent: the former enumerates readable KBs; the latter are single
  // org-capability checks. Run them concurrently.
  const [readCount, canIngest, canSearch, ingestionSourceCount] = await Promise.all([
    loadReadableKbCount({
      sub: session.sub,
      role: session.role,
      user: session.user,
      accessToken: session.accessToken,
      org: session.org,
    }),
    orgCanIngest({ sub: session.sub }),
    orgCanSearch({ sub: session.sub }),
    loadReadableIngestionSourceCount({
      sub: session.sub,
      role: session.role,
      user: session.user,
    }),
  ]);

  const hasAnyKb = readCount > 0;
  const hasAnyIngestionSource = ingestionSourceCount > 0;
  const gates: KbTabGatesMap = {
    // Search is gated by the explicit search capability ALONE — not by whether
    // the caller currently has a readable KB (spec
    // 2026-06-03-explicit-search-capability). An org admin can grant a team the
    // search capability before assigning any KB; members must still reach the
    // Search tab (the toggle's own copy says "results are still limited to the
    // data sources each member can read"). The server-side `/v1/query` and
    // `/v1/mcp/invoke` paths re-check `can_search` AND scope results to readable
    // datasources, so showing the tab with an empty result set is safe and is
    // strictly better UX than a greyed-out tab. Holding a tool share
    // (`can_call`) still does NOT imply search.
    search: canSearch,
    collections: hasAnyKb || hasAnyIngestionSource || canIngest || canSearch,
    // Data Sources lists existing readable KBs and ingestion-source config
    // rows, AND authors new ones. Unlock it when the caller can read
    // something on either surface OR holds the explicit author capability —
    // otherwise a team granted `can_ingest` with nothing yet assigned could
    // never open the tab to create its first source (chicken-and-egg).
    data_sources: hasAnyKb || hasAnyIngestionSource || canIngest,
    // Every graph read endpoint is part of the RAG search data path and checks
    // organization#can_search server-side. Match that gate here so a caller
    // with datasource metadata access but no query grant does not land on a
    // page whose requests are guaranteed to return 403.
    graph: hasAnyKb && canSearch,
    // MCP Tools is the search-tool surface, so unlock it for readers (existing
    // behaviour) AND for the explicit search capability. The RAG server still
    // returns an empty list when nothing matches, so this never over-exposes.
    mcp_tools: hasAnyKb || canSearch,
    has_any_kb: hasAnyKb,
    kb_count: readCount,
    // Explicit, team-granted "data source author" capability (decoupled from
    // per-KB ingest). See orgCanIngest / spec 2026-06-03.
    can_ingest: canIngest,
    // Explicit, team-granted "search" capability. See orgCanSearch / spec
    // 2026-06-03-explicit-search-capability.
    can_search: canSearch,
  };

  return NextResponse.json({ gates, org_admin_bypass: false });
}
