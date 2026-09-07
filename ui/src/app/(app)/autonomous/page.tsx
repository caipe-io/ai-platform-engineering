"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";

import { AuthGuard } from "@/components/auth-guard";
import { MyTasksPanel, type MyTasksAgent } from "@/components/autonomous/MyTasksPanel";
import { Button } from "@/components/ui/button";
import { getConfig } from "@/lib/config";

export default function AutonomousPage() {
  return (
    <AuthGuard>
      <AutonomousWorkspace />
    </AuthGuard>
  );
}

/**
 * User-facing autonomous workspace.
 */
function AutonomousWorkspace() {
  const { data: session } = useSession();
  const autonomousAgentsEnabled = getConfig("autonomousAgentsEnabled");

  const [agents, setAgents] = useState<MyTasksAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/autonomous/agents");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        data?: { schedulable?: MyTasksAgent[] };
      };
      setAgents(body.data?.schedulable ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents.");
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autonomousAgentsEnabled) void fetchAgents();
  }, [autonomousAgentsEnabled, fetchAgents]);

  if (!autonomousAgentsEnabled) {
    return <div className="p-6 text-sm text-muted-foreground">Autonomous agents are disabled.</div>;
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold">Autonomous</h1>
        <p className="text-sm text-muted-foreground">
          Tasks you own, grouped by the agents you can automate.
        </p>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span>{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void fetchAgents()}>
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <MyTasksPanel agents={agents} currentUserEmail={session?.user?.email ?? null} />
      )}
    </div>
  );
}
