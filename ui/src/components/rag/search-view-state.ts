export interface SearchViewState {
  query: string;
  tool: string;
  limit: number;
  filters: Record<string, string | boolean>;
}

interface SearchParamsReader {
  get(name: string): string | null;
  forEach(callback: (value: string, key: string) => void): void;
}

export const DEFAULT_SEARCH_TOOL = "search";
export const DEFAULT_SEARCH_LIMIT = 10;

function boundedLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? String(DEFAULT_SEARCH_LIMIT), 10);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(1, parsed))
    : DEFAULT_SEARCH_LIMIT;
}

export function parseSearchViewState(params: SearchParamsReader): SearchViewState {
  const filters: Record<string, string | boolean> = {};
  params.forEach((value, key) => {
    if (!key.startsWith("filter.")) return;
    const filterKey = key.slice("filter.".length).trim();
    if (!filterKey) return;
    filters[filterKey] = value === "true" ? true : value === "false" ? false : value;
  });

  return {
    query: params.get("q") ?? "",
    tool: params.get("tool")?.trim() || DEFAULT_SEARCH_TOOL,
    limit: boundedLimit(params.get("limit")),
    filters,
  };
}

export function serializeSearchViewState(state: SearchViewState): URLSearchParams {
  const params = new URLSearchParams();
  const query = state.query.trim();
  if (query) params.set("q", query);
  if (state.tool && state.tool !== DEFAULT_SEARCH_TOOL) params.set("tool", state.tool);
  const limit = Math.min(100, Math.max(1, Math.trunc(state.limit || DEFAULT_SEARCH_LIMIT)));
  if (limit !== DEFAULT_SEARCH_LIMIT) params.set("limit", String(limit));
  for (const key of Object.keys(state.filters).sort()) {
    const value = state.filters[key];
    if (typeof value === "string" && !value.trim()) continue;
    params.set(`filter.${key}`, String(value));
  }
  return params;
}
