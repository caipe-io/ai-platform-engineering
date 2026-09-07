export interface DynamicAgentListItem {
  _id: string;
  name?: string;
}

interface DynamicAgentPage<T extends DynamicAgentListItem> {
  items?: T[];
  has_more?: boolean;
}

interface DynamicAgentPageEnvelope<T extends DynamicAgentListItem> {
  data?: DynamicAgentPage<T>;
  items?: T[];
  has_more?: boolean;
  error?: string;
}

interface LoadAllDynamicAgentsOptions {
  enabledOnly?: boolean;
  pageSize?: number;
  cache?: RequestCache;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Fall back to the HTTP status below when the response is not JSON.
  }
  return `Failed to load agents (HTTP ${response.status})`;
}

/** Load every page from the RBAC-filtered Dynamic Agents list endpoint. */
export async function loadAllDynamicAgents<
  T extends DynamicAgentListItem = DynamicAgentListItem,
>({
  enabledOnly = false,
  pageSize = 100,
  cache = "no-store",
  signal,
  fetcher = fetch,
}: LoadAllDynamicAgentsOptions = {}): Promise<T[]> {
  const agents = new Map<string, T>();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams();
    if (enabledOnly) params.set("enabled_only", "true");
    params.set("page", String(page));
    params.set("page_size", String(pageSize));

    const init: RequestInit = { cache };
    if (signal) init.signal = signal;

    const response = await fetcher(`/api/dynamic-agents?${params.toString()}`, init);
    if (!response.ok) throw new Error(await responseError(response));

    const envelope = (await response.json()) as DynamicAgentPageEnvelope<T>;
    const payload = envelope.data ?? envelope;
    const pageItems = payload.items ?? [];
    for (const agent of pageItems) agents.set(agent._id, agent);

    hasMore = Boolean(payload.has_more);
    page += 1;
  }

  return Array.from(agents.values());
}
