// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Check, Copy } from "lucide-react";
import React from "react";

/**
 * Copyable webhook endpoint path for a webhook-triggered task, rendered in
 * task rows so operators can grab `/api/v1/hooks/<task-id>` without opening
 * the edit form. Copies the path only — the externally reachable host of the
 * autonomous-agents service varies by deployment.
 */
export function WebhookHookPath({ taskId }: { taskId: string }) {
  const [copied, setCopied] = React.useState(false);
  const path = `/api/v1/hooks/${taskId}`;

  const copy = async (event: React.MouseEvent) => {
    // Rows nest this inside expandable containers — don't toggle them.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied permission); the
      // path is still visible for manual selection.
    }
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      <code
        className="truncate font-mono"
        title={path}
        data-testid="webhook-hook-path"
      >
        {path}
      </code>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy webhook path"}
        aria-label="Copy webhook path"
        className="shrink-0 rounded p-0.5 hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
    </span>
  );
}
