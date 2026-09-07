"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, Database, ExternalLink, Loader2, Search } from "lucide-react";
import Link from "next/link";
import React from "react";

interface KbAssignment {
  kb_ids: string[];
}

interface DatasourceInfo {
  datasource_id: string;
  name?: string;
}

interface TeamKbAssignmentPanelProps {
  teamId: string;
  teamName: string;
  isAdmin: boolean;
}

function apiData<T>(value: unknown): T {
  const envelope = value as { data?: T };
  return (envelope.data ?? value) as T;
}

/**
 * Team-centric visibility for datasource Search grants.
 *
 * Datasource settings are deliberately the only writer. Keeping Owner,
 * Search, and publication approval in one flow prevents the old team panel
 * from manufacturing manager/ingestor tuples that bypass source policy.
 */
export function TeamKbAssignmentPanel({
  teamId,
  teamName,
  isAdmin,
}: TeamKbAssignmentPanelProps) {
  const [assignment, setAssignment] = React.useState<KbAssignment | null>(null);
  const [datasources, setDatasources] = React.useState<DatasourceInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [assignmentResponse, datasourceResponse] = await Promise.all([
          fetch(`/api/admin/teams/${encodeURIComponent(teamId)}/kb-assignments`),
          fetch("/api/rag/v1/datasources"),
        ]);
        if (!assignmentResponse.ok) {
          const body = await assignmentResponse.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ||
              `Could not load Search access (${assignmentResponse.status})`,
          );
        }
        const assignmentBody = apiData<KbAssignment>(
          await assignmentResponse.json(),
        );
        const datasourceBody = datasourceResponse.ok
          ? apiData<{ datasources?: DatasourceInfo[] }>(
              await datasourceResponse.json(),
            )
          : { datasources: [] };
        if (!cancelled) {
          setAssignment(assignmentBody);
          setDatasources(datasourceBody.datasources ?? []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load Search access",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const names = React.useMemo(
    () => new Map(datasources.map((source) => [source.datasource_id, source.name])),
    [datasources],
  );
  const sourceIds = assignment?.kb_ids ?? [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading Search access…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex items-start gap-3">
          <Search className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Search access for {teamName}</p>
            <p className="text-xs text-muted-foreground">
              Members can query the datasources listed here. Search does not
              grant Owner access or allow members to change, reload, or delete
              a datasource.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <section className="rounded-lg border">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Datasources</h4>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {sourceIds.length}
            </Badge>
          </div>
        </header>

        {sourceIds.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            This team does not have Search access to any datasource.
          </div>
        ) : (
          <ScrollArea className="max-h-[280px] p-2">
            <ul className="space-y-1">
              {sourceIds.map((sourceId) => (
                <li
                  key={sourceId}
                  className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {names.get(sourceId) || sourceId}
                    </p>
                    {names.get(sourceId) && (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {sourceId}
                      </p>
                    )}
                  </div>
                  <Badge variant="outline" className="shrink-0 gap-1">
                    <Search className="h-3 w-3" /> Search
                  </Badge>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </section>

      {isAdmin && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
          <p className="max-w-xl text-xs text-muted-foreground">
            Add or remove Search from a datasource&apos;s Manage Datasource
            dialog. Broad publication requests will then follow the configured
            approval policy.
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link href="/knowledge-bases">
              Manage datasources <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
