import React from "react";
import { Clock, Repeat, Webhook, CheckCircle2, AlertTriangle, XCircle, Loader2, CircleDashed } from "lucide-react";

import type { Acknowledgement, AcknowledgementStatus, Trigger } from "./types";

export function describeTrigger(trigger: Trigger): string {
  if (trigger.type === "cron") return `cron · ${trigger.schedule}`;
  if (trigger.type === "interval") {
    const parts: string[] = [];
    if (trigger.hours) parts.push(`${trigger.hours}h`);
    if (trigger.minutes) parts.push(`${trigger.minutes}m`);
    if (trigger.seconds) parts.push(`${trigger.seconds}s`);
    return `every ${parts.join(" ") || "—"}`;
  }
  return `webhook · ${trigger.provider ?? "generic_hmac"}`;
}

export function TriggerIcon({ type }: { type: Trigger["type"] }) {
  if (type === "cron") return <Clock className="h-3.5 w-3.5" />;
  if (type === "interval") return <Repeat className="h-3.5 w-3.5" />;
  return <Webhook className="h-3.5 w-3.5" />;
}

export function formatNextRun(value?: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/** Human-readable relative offset, e.g. "in 4h" or "5m ago". Spec #099 FR-012. */
export function formatRelative(value?: string | null, nowMs: number = Date.now()): string {
  if (!value) return "";
  try {
    const t = new Date(value).getTime();
    const deltaSec = Math.round((t - nowMs) / 1000);
    const abs = Math.abs(deltaSec);
    const future = deltaSec >= 0;
    let unit: string;
    let n: number;
    if (abs < 60) { unit = "s"; n = abs; }
    else if (abs < 3600) { unit = "m"; n = Math.round(abs / 60); }
    else if (abs < 86400) { unit = "h"; n = Math.round(abs / 3600); }
    else { unit = "d"; n = Math.round(abs / 86400); }
    return future ? `in ${n}${unit}` : `${n}${unit} ago`;
  } catch {
    return "";
  }
}

/**
 * Visual treatment for the per-task pre-flight badge. Maps the four
 * Acknowledgement statuses to icon + color + label so the row reads at
 * a glance: green check for "ack ok", yellow triangle for "warn",
 * red x for "failed", grey spinner for "pending".
 */
export function ackBadgeFor(ack?: Acknowledgement | null): {
  label: string;
  className: string;
  icon: React.ReactNode;
  status: AcknowledgementStatus | "absent";
} {
  // No ack at all -- the task has never been pre-flighted. This is a RESTING
  // state, not an in-flight one: nothing will resolve it until the task runs.
  // It previously shared the spinning "Ack pending" badge with the genuinely
  // pending case, so a never-run task appeared to hang forever.
  if (!ack) {
    return {
      label: "No ack yet",
      className: "border-muted-foreground/30 text-muted-foreground",
      icon: <CircleDashed className="h-3 w-3" />,
      status: "absent",
    };
  }
  switch (ack.ack_status) {
    case "ok":
      return {
        label: "Ack OK",
        className: "border-green-600/40 text-green-600",
        icon: <CheckCircle2 className="h-3 w-3" />,
        status: "ok",
      };
    case "warn":
      return {
        label: "Ack warn",
        className: "border-yellow-600/40 text-yellow-700",
        icon: <AlertTriangle className="h-3 w-3" />,
        status: "warn",
      };
    case "failed":
      return {
        label: "Ack failed",
        className: "border-red-600/40 text-red-600",
        icon: <XCircle className="h-3 w-3" />,
        status: "failed",
      };
    case "pending":
    default:
      return {
        label: "Ack pending",
        className: "border-muted-foreground/30 text-muted-foreground",
        icon: <Loader2 className="h-3 w-3 animate-spin" />,
        status: "pending",
      };
  }
}

/** Plain-text tooltip body assembled from the ack payload (newline-separated). */
export function ackTooltip(ack?: Acknowledgement | null): string {
  if (!ack) return "Pre-flight not yet attempted.";
  const lines: string[] = [];
  if (ack.ack_detail) lines.push(ack.ack_detail);
  if (ack.routed_to) lines.push(`Routed to: ${ack.routed_to}`);
  if (ack.dry_run_summary) lines.push("", ack.dry_run_summary);
  return lines.join("\n");
}
