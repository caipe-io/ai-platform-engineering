import { getCollection } from "@/lib/mongodb";
import type {
  AgentIdentityDisplay,
  DynamicAgentBrowserConfig,
  DynamicAgentConfig,
} from "@/types/dynamic-agent";
import type { User } from "@/types/mongodb";

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function indexUserIdentity(userIndex: Map<string, User>, user: User): void {
  const subjects = [
    user.keycloak_sub,
    user.metadata?.keycloak_sub,
    user.metadata?.sso_id,
  ];
  for (const subject of subjects) {
    const normalized = normalizedString(subject);
    if (normalized) userIndex.set(normalized, user);
  }
}

function identityDisplay(
  subject: string | null,
  fallbackId: string | null,
  userIndex: ReadonlyMap<string, User>,
): AgentIdentityDisplay | undefined {
  const user = subject ? userIndex.get(subject) : undefined;
  if (user) {
    const name = normalizedString(user.name) ?? undefined;
    const email = normalizedString(user.email) ?? undefined;
    return {
      label: name ?? email ?? "Unknown user",
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    };
  }

  if (!fallbackId) return undefined;
  if (fallbackId === "system") return { label: "System" };
  // Legacy owner_id values were not uniformly typed. Only expose an email;
  // an opaque identifier may itself be a stable identity subject.
  if (!fallbackId.includes("@")) return { label: "Unknown user" };
  return {
    label: fallbackId,
    email: fallbackId,
  };
}

async function loadUserIndex(agents: DynamicAgentConfig[]): Promise<Map<string, User>> {
  const subjects = Array.from(new Set(agents.flatMap((agent) => [
    normalizedString(agent.creator_subject) ?? normalizedString(agent.owner_subject),
    agent.visibility === "private" ? normalizedString(agent.owner_subject) : null,
  ]).filter((subject): subject is string => Boolean(subject))));

  const userIndex = new Map<string, User>();
  if (subjects.length === 0) return userIndex;

  try {
    const users = await (await getCollection<User>("users")).find({
      $or: [
        { keycloak_sub: { $in: subjects } },
        { "metadata.keycloak_sub": { $in: subjects } },
        { "metadata.sso_id": { $in: subjects } },
      ],
    }).toArray();
    users.forEach((user) => indexUserIdentity(userIndex, user));
  } catch (error) {
    console.warn("[dynamic-agents] Could not enrich agent identity labels:", error);
  }

  return userIndex;
}

/**
 * Project persisted agent documents into a browser-safe response. Stable
 * identity subjects remain server-side; clients receive directory labels.
 */
export async function dynamicAgentsForBrowser(
  agents: DynamicAgentConfig[],
): Promise<DynamicAgentBrowserConfig[]> {
  const userIndex = await loadUserIndex(agents);

  return agents.map((agent) => {
    const safeAgent = { ...agent } as Partial<DynamicAgentConfig>;
    delete safeAgent.owner_subject;
    delete safeAgent.creator_subject;

    const creatorSubject = normalizedString(agent.creator_subject)
      ?? normalizedString(agent.owner_subject);
    const creatorId = normalizedString(agent.creator_id)
      ?? normalizedString(agent.owner_id);
    const ownerSubject = normalizedString(agent.owner_subject);
    const ownerId = normalizedString(agent.owner_id);
    const creator = identityDisplay(creatorSubject, creatorId, userIndex);
    const owner = agent.visibility === "private"
      ? identityDisplay(ownerSubject, ownerId, userIndex)
      : undefined;

    return {
      ...(safeAgent as DynamicAgentBrowserConfig),
      ...(creator ? { creator } : {}),
      ...(owner ? { owner } : {}),
    };
  });
}

export async function dynamicAgentForBrowser(
  agent: DynamicAgentConfig,
): Promise<DynamicAgentBrowserConfig> {
  const [result] = await dynamicAgentsForBrowser([agent]);
  return result;
}
