import type { PublicAgenticApp } from "@/types/agentic-app";

const normalize = (value: string) => value.toLowerCase().replace(/[-_:/]+/g, " ").replace(/\s+/g, " ").trim();

/** Match every query term across public metadata, independent of field order. */
export function matchesAgenticAppSearch(app: PublicAgenticApp, query: string): boolean {
  const searchable = normalize([app.appId, app.displayName, app.description, ...app.categories, ...app.capabilities].join(" "));
  return normalize(query).split(" ").filter(Boolean).every((term) => searchable.includes(term));
}
