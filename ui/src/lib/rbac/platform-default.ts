// Tiny helper that reads `platform_config.default_agent_id` so we can
// protect the invariant "platform default agent stays usable" — i.e.
// admins can't quietly delete or demote it outside Settings → Platform settings → Defaults.
//
// Intentionally uncached for v1: the only callers are the dynamic-agent
// PUT/DELETE handlers, which already hit Mongo for the agent doc, so the
// extra round trip is negligible. If we ever start calling this in a
// hot path, layer caching here — not at call sites.
//
// assisted-by claude code claude-sonnet-4-6

import { getCollection } from "@/lib/mongodb";

const CONFIG_ID = "platform_settings";
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

interface PlatformConfigDoc {
  _id?: string;
  default_agent_id?: unknown;
}

function normalizeDefaultAgentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && OPENFGA_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Returns the currently configured platform default agent id, or null
 * if none is set in MongoDB. Falls back to `DEFAULT_AGENT_ID` env var
 * so locked-down environments that only set the Helm value still get
 * the invariant enforced.
 */
export async function getPlatformDefaultAgentId(): Promise<string | null> {
  try {
    const col = await getCollection<PlatformConfigDoc>("platform_config");
    const doc = await col.findOne({ _id: CONFIG_ID } as never);
    const fromDb = normalizeDefaultAgentId(doc?.default_agent_id);
    if (fromDb) return fromDb;
    return normalizeDefaultAgentId(process.env.DEFAULT_AGENT_ID);
  } catch {
    return normalizeDefaultAgentId(process.env.DEFAULT_AGENT_ID);
  }
}

/**
 * True when `agentId` is the currently configured platform default agent.
 * Used to block demotes and deletes that would silently break new-user
 * access.
 */
export async function isPlatformDefaultAgent(agentId: string): Promise<boolean> {
  const defaultId = await getPlatformDefaultAgentId();
  return defaultId !== null && defaultId === agentId;
}
