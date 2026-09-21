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

interface RewindConfirmationDialogProps {
  open: boolean;
  messageCount: number;
  isConfirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RewindConfirmationDialog({
  open,
  messageCount,
  isConfirming,
  onCancel,
  onConfirm,
}: RewindConfirmationDialogProps) {
  const normalizedCount = Math.max(1, messageCount);
  const laterMessageCount = normalizedCount - 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isConfirming) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rewind conversation?</DialogTitle>
          <DialogDescription>
            The edited message will be sent as a new turn from this point in the conversation.
          </DialogDescription>
        </DialogHeader>

        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Messages will be permanently deleted.</p>
            <p className="text-muted-foreground">
              {laterMessageCount === 0
                ? "This message will be lost and cannot be recovered."
                : `This message and the ${laterMessageCount} message${laterMessageCount === 1 ? "" : "s"} after it will be lost and cannot be recovered.`}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isConfirming}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={isConfirming}>
            {isConfirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Rewind and send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
