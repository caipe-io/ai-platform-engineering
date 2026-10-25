const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Server-side rollout gate for personal private resources.
 *
 * Default-off is intentional: deployments must classify legacy MCP servers
 * and credential metadata before context enforcement becomes active.
 */
export function isPrivateResourcesEnabled(): boolean {
  const raw = process.env.PRIVATE_RESOURCES_ENABLED?.trim().toLowerCase();
  return raw ? ENABLED_VALUES.has(raw) : false;
}
