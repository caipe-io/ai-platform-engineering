"use client";

import { AdminBadge } from "@/components/admin/shared/AdminBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Wrench } from "lucide-react";
import { useState } from "react";

interface AgentGatewayRepairCardProps {
  isAdmin: boolean;
  readOnly?: boolean;
}

interface RepairWarning {
  id: string;
  message: string;
}

interface RepairResult {
  added: number;
  migrated: number;
  refreshed: number;
  skipped: number;
  warnings: RepairWarning[];
}

function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function AgentGatewayRepairCard({
  isAdmin,
  readOnly = false,
}: AgentGatewayRepairCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [result, setResult] = useState<RepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) return null;

  const handleRepair = async () => {
    if (readOnly || repairing) return;
    setRepairing(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/mcp-servers/agentgateway/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "AgentGateway repair failed");
      }
      const data = payload.data ?? {};
      setResult({
        added: itemCount(data.added),
        migrated: itemCount(data.migrated),
        refreshed: itemCount(data.refreshed),
        skipped: itemCount(data.skipped),
        warnings: Array.isArray(data.migration_warnings) ? data.migration_warnings : [],
      });
      setConfirmOpen(false);
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : "AgentGateway repair failed");
      setConfirmOpen(false);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>AgentGateway MCP registration repair</CardTitle>
            <AdminBadge />
          </div>
          <CardDescription>
            Reconcile GRID&apos;s MCP registrations with every MCP target currently configured in AgentGateway.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-2">
                <p className="font-medium text-amber-800 dark:text-amber-300">
                  This is a global maintenance action, not a connection test.
                </p>
                <p className="text-amber-700 dark:text-amber-400">
                  It reads all AgentGateway MCP targets, adds missing registrations, safely migrates legacy direct
                  registrations, and reconciles OpenFGA grants for existing targets. Conflicting registrations are
                  skipped and reported.
                </p>
                <p className="text-amber-700 dark:text-amber-400">
                  It does not change AgentGateway listeners or JWT policy, invoke MCP tools, delete registrations, or
                  overwrite an existing credential during migration.
                </p>
              </div>
            </div>
          </div>

          {result && (
            <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <div className="space-y-1">
                  <p className="font-medium text-green-700 dark:text-green-400">Repair completed</p>
                  <p className="text-green-700 dark:text-green-400">
                    Added {result.added}, migrated {result.migrated}, refreshed {result.refreshed}, and skipped{" "}
                    {result.skipped} MCP registrations.
                  </p>
                  {result.warnings.map((warning) => (
                    <p key={warning.id} className="text-xs text-amber-700 dark:text-amber-400">
                      {warning.id}: {warning.message}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={readOnly || repairing}
          >
            {repairing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="mr-2 h-4 w-4" />
            )}
            Repair AgentGateway
          </Button>
          {readOnly && (
            <p className="text-xs text-muted-foreground">
              Repair is disabled while previewing another user&apos;s Admin access.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Repair all AgentGateway MCP registrations?</DialogTitle>
            <DialogDescription>
              This will inspect every configured AgentGateway MCP target and may change shared MCP registration and
              OpenFGA access state. It is not limited to a selected server.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Use this only when registrations are missing or stale after an AgentGateway configuration change.</p>
            <p>Conflicts will be skipped for manual review; existing registrations will not be deleted.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={repairing}>
              Cancel
            </Button>
            <Button type="button" onClick={handleRepair} disabled={repairing}>
              {repairing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Repair all discovered targets
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
