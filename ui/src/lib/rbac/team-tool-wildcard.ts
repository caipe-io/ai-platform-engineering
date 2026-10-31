/** Concrete intent marker; runtime authorization only checks per-server tool objects. */
export const TEAM_TOOL_WILDCARD_SENTINEL_ID = "__all_mcp_servers_intent__";
export const TEAM_TOOL_WILDCARD_SENTINEL_OBJECT = `tool:${TEAM_TOOL_WILDCARD_SENTINEL_ID}`;
