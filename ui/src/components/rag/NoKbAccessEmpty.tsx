"use client";

import { Lock,ShieldQuestion } from "lucide-react";

interface NoKbAccessEmptyProps {
  /** Short label naming the surface, e.g. "search", "data sources", "graph", "MCP tools". */
  surface: string;
  /** Optional secondary line shown under the headline. */
  secondary?: string;
}

/**
 * Empty-state shown by Knowledge sidebar pages (Search, Data Sources, Graph,
 * MCP Tools) when the BFF would 403 because the user is not org-admin and has
 * no readable `knowledge_base:<id>`.
 *
 * This replaces the silent "no results" or raw `403` error the user would
 * otherwise see.
 */
export function NoKbAccessEmpty({ surface, secondary }: NoKbAccessEmptyProps) {
  const headline = `You don't have access to any knowledge bases yet.`;
  const detail =
    secondary ??
    `Ask an admin for Search access to an existing knowledge base or permission to create a datasource, then come back to ${surface}.`;

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-12 text-center">
      <div className="rounded-full bg-muted/40 p-4">
        <Lock className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{headline}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{detail}</p>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <ShieldQuestion className="h-3.5 w-3.5" />
        <span>
          This is enforced by the platform&apos;s access controls. Org admins always see every
          knowledge base.
        </span>
      </div>
    </div>
  );
}
