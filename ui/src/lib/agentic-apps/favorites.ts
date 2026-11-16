const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_FAVORITES = 100;

export function normalizeFavoriteAppIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string =>
    typeof id === "string" && APP_ID.test(id)))].slice(0, MAX_FAVORITES);
}

export function parseFavoriteAppIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FAVORITES ||
      value.some(id => typeof id !== "string" || !APP_ID.test(id))) {
    throw new Error("Invalid favorite_agentic_apps");
  }
  return [...new Set(value)];
}
