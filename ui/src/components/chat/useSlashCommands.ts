"use client";

import { useEffect,useMemo,useState } from "react";
import type { SubAgentRef } from "@/types/dynamic-agent";
import type { SlashCommand } from "./SlashCommandMenu";

/**
 * Built-in commands that are always available.
 */
const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    id: "skills",
    label: "skills",
    description: "List available skills",
    category: "command",
    action: "execute",
    value: "skills",
  },
  {
    id: "effort",
    label: "effort",
    description: "Set this chat's reasoning effort",
    category: "command",
    action: "insert",
    value: "/effort ",
  },
  {
    id: "help",
    label: "help",
    description: "Show available commands",
    category: "command",
    action: "execute",
    value: "help",
  },
  {
    id: "clear",
    label: "clear",
    description: "Clear conversation",
    category: "command",
    action: "execute",
    value: "clear",
  },
];

/**
 * Catalog payload shape we actually consume here. Mirrors the API contract
 * in ``app/api/skills/route.ts`` (specifically the ``applyRunnableGate``
 * helper that stamps ``runnable``/``blocked_reason``/``scan_status`` on
 * every entry). We type it locally instead of importing ``CatalogSkill``
 * to keep this hook free of cross-package coupling -- only these four
 * fields drive selection logic.
 */
type CatalogSkillLite = {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  scan_status?: string | null;
  runnable?: boolean;
  blocked_reason?: string | null;
  // Presence (truthy) = admin override active. The catalog API
  // already stamps ``runnable: true`` for overridden skills, but
  // we mirror the field here so the predicate can reach the same
  // verdict locally even when consumers pass synthesized lite
  // skills that don't carry ``runnable`` (tests, transitions).
  scan_override?: unknown;
};

/**
 * Defense-in-depth filter for flagged skills.
 *
 * The skill scanner and dynamic-agent runtime refuse to execute any
 * flagged skill (loaders and ``dynamic_agents/services/skills.py`` funnel
 * through ``is_skill_blocked`` / ``mongo_scan_filter``). But
 * surfacing the skill in the slash-command menu means a user can pick
 * something the runtime will then refuse, which is a confusing UX and
 * leaks the skill's existence + metadata to the model. Per product
 * decision we hide flagged entries from the picker entirely so the menu
 * only shows things that are actually runnable.
 *
 * We treat all the signals the gateway stamps as authoritative
 * (``scan_status``, ``runnable``, ``blocked_reason``, ``scan_override``)
 * so a future schema tweak on either side can't silently re-enable a
 * flagged skill in the picker. ``scan_status === "flagged"`` is gated
 * by ``!scan_override`` so an admin-overridden flagged skill still
 * shows up — the override is the admin's "trust this regardless of
 * the scanner" assertion, mirrored by the catalog API stamping
 * ``runnable: true`` on the same row.
 */
function isFlaggedSkill(skill: CatalogSkillLite): boolean {
  if (skill.runnable === false) return true;
  if (skill.blocked_reason === "scan_flagged") return true;
  if (skill.scan_status === "flagged" && !skill.scan_override) return true;
  return false;
}

/**
 * Hook that assembles the full slash command list from:
 * 1. Built-in commands (static)
 * 2. Skills (dynamic, scoped to agent when agentSkillIds is provided)
 * 3. Enabled MCP servers and configured subagents for the current agent
 *
 * @param agentSkillIds - Skill IDs configured on the current dynamic agent.
 *   When provided with items: fetches GET /api/skills (merged catalog), filters to those IDs.
 *   When provided as empty array: no skills shown.
 *   When undefined: fetches full global catalog from /api/skills.
 */
export function useSlashCommands(
  agentSkillIds?: string[],
  allowedTools?: Record<string, string[] | boolean>,
  subagents?: SubAgentRef[],
): SlashCommand[] {
  const [skillCommands, setSkillCommands] = useState<SlashCommand[]>([]);

  // Stable key for the dependency array — avoids re-fetching on every render
  const skillIdsKey = agentSkillIds ? agentSkillIds.join(",") : undefined;

  useEffect(() => {
    // Dynamic agent with no skills configured — show nothing
    if (agentSkillIds && agentSkillIds.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: conditional state reset when agentSkillIds becomes empty
      setSkillCommands([]);
      return;
    }

    let cancelled = false;

    if (agentSkillIds) {
      // Dynamic agent — fetch from unified catalog and filter to configured IDs
      const skillIdSet = new Set(agentSkillIds);

      fetch("/api/skills", { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled) return;
          const allSkills: CatalogSkillLite[] = data?.skills || [];
          const filtered = allSkills.filter(
            (s) => skillIdSet.has(s.id) && !isFlaggedSkill(s),
          );
          setSkillCommands(
            filtered.map((s) => ({
              id: s.id,
              label: s.title || s.name || s.id,
              description: s.description || s.title || s.name || s.id,
              category: "skill" as const,
              action: "insert" as const,
              value: s.title || s.name || s.id,
            })),
          );
        })
        .catch(() => {});
    } else {
      // Supervisor / no agent context — fetch full global catalog
      fetch("/api/skills", { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled || !data?.skills) return;
          const allSkills: CatalogSkillLite[] = data.skills;
          const runnable = allSkills.filter((s) => !isFlaggedSkill(s));
          setSkillCommands(
            runnable.map((s) => ({
              id: (s.name || s.id).toLowerCase().replace(/\s+/g, "-"),
              label: s.name || s.id,
              description: s.description || s.name || s.id,
              category: "skill" as const,
              action: "insert" as const,
              value: s.name || s.id,
            })),
          );
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [skillIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const mcpCommands: SlashCommand[] = useMemo(
    () => Object.entries(allowedTools ?? {})
      .filter(([, selection]) => selection !== false)
      .map(([serverId]) => ({
        id: `mcp-${serverId}`,
        label: serverId,
        description: `${serverId} MCP server`,
        category: "mcp" as const,
        action: "insert" as const,
        value: `@${serverId}`,
      })),
    [allowedTools],
  );

  const subagentCommands: SlashCommand[] = useMemo(
    () => (subagents ?? []).map((subagent) => ({
      id: `subagent-${subagent.agent_id}`,
      label: subagent.name || subagent.agent_id,
      description: subagent.description || "Configured subagent",
      category: "subagent" as const,
      action: "insert" as const,
      value: `@${subagent.name || subagent.agent_id}`,
    })),
    [subagents],
  );

  return useMemo(
    () => [...BUILTIN_COMMANDS, ...skillCommands, ...mcpCommands, ...subagentCommands],
    [skillCommands, mcpCommands, subagentCommands],
  );
}
