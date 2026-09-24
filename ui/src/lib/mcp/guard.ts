/**
 * Feature gate for the CAIPE Platform MCP server (`POST /api/mcp`).
 *
 * Disabled by default. A disabled deployment returns 404 (not 401/403)
 * from every route under this feature, so it doesn't leak the feature's
 * existence — the same convention other optional BFF surfaces use.
 */

import { getConfig } from "@/lib/config";

export function isPlatformMcpEnabled(): boolean {
  return getConfig("platformMcpEnabled");
}
