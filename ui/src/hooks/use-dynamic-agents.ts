// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useCallback, useEffect, useState } from "react";

/** Minimal option shape the autonomous task form needs to pick a target. */
export interface DynamicAgentOption {
  id: string;
  name: string;
}

export interface DynamicAgentsData {
  agents: DynamicAgentOption[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

/**
 * List the dynamic agents the current user can target, used by the
 * autonomous task form to choose the agent a task runs against.
 *
 * Reads the same BFF endpoint the Custom Agents tab uses
 * (`GET /api/dynamic-agents`), which returns `{ success, data: { items } }`
 * scoped to what the caller is allowed to see. Only `id` / `name` are kept;
 * the form has no use for the full agent config.
 */
export function useDynamicAgents(): DynamicAgentsData {
  const [agents, setAgents] = useState<DynamicAgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch("/api/dynamic-agents?page_size=100");
      const data = await response.json();
      if (response.ok && data?.success) {
        const items: Array<{ id?: unknown; name?: unknown }> =
          data?.data?.items ?? [];
        setAgents(
          items
            .filter((a) => typeof a.id === "string")
            .map((a) => ({
              id: a.id as string,
              name: typeof a.name === "string" && a.name ? a.name : (a.id as string),
            })),
        );
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { agents, loading, error, refresh: load };
}
