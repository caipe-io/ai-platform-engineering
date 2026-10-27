"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { PublicationDriftItem } from "@/types/publication-approval";

export type { PublicationDriftItem };

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  return String(value);
}

function arrayDiff(before: unknown, after: unknown): { removed: string[]; added: string[] } | null {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const beforeValues = before.map(String);
  const afterValues = after.map(String);
  const afterSet = new Set(afterValues);
  const beforeSet = new Set(beforeValues);
  return {
    removed: beforeValues.filter((value) => !afterSet.has(value)),
    added: afterValues.filter((value) => !beforeSet.has(value)),
  };
}

export function DriftRow({ item }: { item: PublicationDriftItem }) {
  const diff = arrayDiff(item.before, item.after);
  return (
    <div className="space-y-1 rounded-md border border-border/60 bg-muted/30 p-2 text-sm">
      <p>
        <span className="font-medium text-foreground">{item.label}:</span>{" "}
        {diff ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            {diff.removed.length === 0 && diff.added.length === 0 && (
              <span className="text-muted-foreground">No change</span>
            )}
            {diff.removed.map((value) => (
              <s key={`removed-${value}`} className="text-muted-foreground">{value}</s>
            ))}
            {diff.added.map((value) => (
              <span key={`added-${value}`} className="text-foreground">+{value}</span>
            ))}
          </span>
        ) : (
          <span>
            <s className="text-muted-foreground">{formatValue(item.before)}</s>
            {" "}
            <span className="text-foreground">{formatValue(item.after)}</span>
          </span>
        )}
      </p>
      {item.will_apply !== undefined && (
        <p className="text-xs text-amber-600">
          Approving will set this to: {formatValue(item.will_apply)}
        </p>
      )}
    </div>
  );
}

export function DriftRows({ drift }: { drift: PublicationDriftItem[] }) {
  if (drift.length === 0) return null;
  return (
    <div className="space-y-2">
      {drift.map((item) => <DriftRow key={item.field} item={item} />)}
    </div>
  );
}

interface PublicationDriftDialogProps {
  open: boolean;
  mode: "soft" | "hard";
  drift: PublicationDriftItem[];
  reason?: string;
  isConfirming: boolean;
  onCancel: () => void;
  onConfirm?: () => void;
}

export function PublicationDriftDialog({
  open,
  mode,
  drift,
  reason,
  isConfirming,
  onCancel,
  onConfirm,
}: PublicationDriftDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isConfirming) onCancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>These factors have changed since the proposal was created</DialogTitle>
          <DialogDescription>
            {mode === "hard"
              ? "This request can no longer be approved as-is. The requester needs to submit a new request."
              : "Review what changed before deciding whether to approve this request against the current state."}
          </DialogDescription>
        </DialogHeader>

        {mode === "hard" && reason && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <p className="text-foreground">{reason}</p>
          </div>
        )}

        <DriftRows drift={drift} />

        <DialogFooter className="gap-2 sm:gap-2">
          {mode === "hard" ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onCancel} disabled={isConfirming}>
                Cancel
              </Button>
              <Button type="button" onClick={onConfirm} disabled={isConfirming}>
                {isConfirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Approve anyway
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
