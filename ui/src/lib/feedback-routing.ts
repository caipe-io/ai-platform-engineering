import { validateFeedbackDestination } from "../../app-sdk/agentic-app-manifest.mjs";

export interface FeedbackRoute {
  id: string;
  label: string;
  provider: "github" | "jira";
  githubRepo?: string;
  jiraProject?: string;
  appId?: string;
  pathPrefixes?: string[];
  labels?: string[];
  issueTypes?: { Bug?: string; Enhancement?: string };
  canAttachScreenshot?: boolean;
}

const AREAS = [
  ["chat", "Chat", "/chat"],
  ["skills", "Skills", "/skills"],
  ["workflows", "Workflows", "/workflows"],
  ["knowledge-bases", "Knowledge Bases", "/knowledge-bases"],
  ["agents", "Agents", "/agents"],
  ["mcp-servers", "MCP Servers", "/mcp-servers"],
  ["models", "LLM Models", "/models"],
  ["credentials", "Credentials", "/credentials"],
  ["admin", "Admin Settings", "/admin"],
] as const;

/** Only deployment-owned destinations may be submitted to the ticket API. */
export function parseFeedbackRoutes(raw?: string): FeedbackRoute[] {
  if (!raw?.trim()) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("FEEDBACK_ROUTES must be a JSON array");
  const ids = new Set<string>();
  return rows.map((row: unknown): FeedbackRoute => {
    if (!row || typeof row !== "object") throw new Error("Invalid FEEDBACK_ROUTES entry");
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id) || ids.has(r.id) ||
        typeof r.label !== "string" || !r.label.trim() || r.label.length > 100) {
      throw new Error("Feedback routes require unique IDs and nonempty labels");
    }
    ids.add(r.id);
    const destination = validateFeedbackDestination({ provider: r.provider, ...(r.githubRepo !== undefined ? { githubRepo: r.githubRepo } : {}), ...(r.jiraProject !== undefined ? { jiraProject: r.jiraProject } : {}), ...(r.issueTypes !== undefined ? { issueTypes: r.issueTypes } : {}) });
    const strings = (key: "pathPrefixes" | "labels"): string[] | undefined => {
      const value = r[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim() || v.length > 200)) {
        throw new Error(`Invalid feedback ${key}`);
      }
      return value as string[];
    };
    const pathPrefixes = strings("pathPrefixes");
    if (pathPrefixes?.some(p => !p.startsWith("/") || p.includes("?") || p.includes("#"))) {
      throw new Error("Feedback pathPrefixes must be absolute URL paths");
    }
    if (r.appId !== undefined && (typeof r.appId !== "string" || !/^[a-z0-9-]+$/.test(r.appId))) {
      throw new Error("Invalid feedback appId");
    }
    return {
      id: r.id, label: r.label.trim(), ...destination,
      ...(typeof r.appId === "string" ? { appId: r.appId } : {}),
      ...(pathPrefixes ? { pathPrefixes } : {}),
      ...(r.labels ? { labels: strings("labels") } : {}),
    };
  });
}

export function buildFeedbackRoutes(
  configured: FeedbackRoute[],
  provider: "github" | "jira" | null,
  githubRepo: string | null,
  jiraProject: string | null,
): FeedbackRoute[] {
  const destination = provider === "github" && githubRepo ? { provider, githubRepo }
    : provider === "jira" && jiraProject ? { provider, jiraProject } : null;
  const defaults: FeedbackRoute[] = destination ? AREAS.map(([id, label, path]) => ({
    id, label, ...destination, pathPrefixes: [path],
  })) : [];
  const merged = new Map(defaults.map(route => [route.id, route]));
  for (const route of configured) merged.set(route.id, { ...merged.get(route.id), ...route });
  return [...merged.values()];
}

export function feedbackRouteForPath(routes: FeedbackRoute[], pathname: string): FeedbackRoute | undefined {
  return routes.flatMap(route => (route.pathPrefixes ?? []).filter(prefix =>
    pathname === prefix || pathname.startsWith(`${prefix.replace(/\/$/, "")}/`),
  ).map(prefix => ({ route, length: prefix.length })))
    .sort((a, b) => b.length - a.length)[0]?.route;
}
