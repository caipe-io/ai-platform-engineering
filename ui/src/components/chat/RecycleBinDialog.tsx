"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
Tooltip,
TooltipContent,
TooltipProvider,
TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiClient } from "@/lib/api-client";
import { cn,truncateText } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import type { Conversation } from "@/types/mongodb";
import {
AlertTriangle,
ArchiveRestore,
Clock,
Loader2,
MessageSquare,
RotateCcw,
} from "lucide-react";
import { useCallback,useEffect,useState } from "react";

const RETENTION_DAYS = 7;

interface RecycleBinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored?: () => void;
}

/** Calculate days remaining before auto-purge */
export function daysRemaining(deletedAt: Date | string): number {
  const deleted = new Date(deletedAt);
  const purgeDate = new Date(deleted);
  purgeDate.setDate(purgeDate.getDate() + RETENTION_DAYS);
  const now = new Date();
  const diff = purgeDate.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/** Format a relative time string */
export function formatDeletedAt(deletedAt: Date | string): string {
  const deleted = new Date(deletedAt);
  const now = new Date();
  const diffMs = now.getTime() - deleted.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export function RecycleBinDialog({ open, onOpenChange, onRestored }: RecycleBinDialogProps) {
  const [trashedConversations, setTrashedConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const { loadConversationsFromServer } = useChatStore();

  const loadTrash = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.getTrash({ page_size: 100 });
      setTrashedConversations(response?.items || []);
    } catch (error) {
      console.error("[RecycleBin] Failed to load trash:", error);
      setTrashedConversations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trash when dialog opens
  useEffect(() => {
    if (open) {
      loadTrash();
      setConfirmPurgeId(null);
    }
  }, [open, loadTrash]);

  const handleRestore = async (id: string) => {
    setActionInProgress(id);
    try {
      await apiClient.restoreConversation(id);
      // Remove from local trash list
      setTrashedConversations((prev) => prev.filter((c) => c._id !== id));
      // Refresh the sidebar conversations
      await loadConversationsFromServer();
      onRestored?.();
    } catch (error) {
      console.error("[RecycleBin] Failed to restore:", error);
    } finally {
      setActionInProgress(null);
    }
  };

  const handlePermanentDelete = async (id: string) => {
    setActionInProgress(id);
    try {
      await apiClient.permanentDeleteConversation(id);
      setTrashedConversations((prev) => prev.filter((c) => c._id !== id));
      setConfirmPurgeId(null);
    } catch (error) {
      console.error("[RecycleBin] Failed to permanently delete:", error);
    } finally {
      setActionInProgress(null);
    }
  };

  const trashCount = trashedConversations.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArchiveRestore className="h-5 w-5 text-muted-foreground" />
            Archive
            {trashCount > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs">
                {trashCount}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Deleted conversations are kept for {RETENTION_DAYS} days before being permanently removed.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : trashCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ArchiveRestore className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Archive is empty</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Deleted conversations will appear here
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-[400px] pr-2">
            <div className="space-y-1">
              {trashedConversations.map((conv) => {
                const remaining = daysRemaining(conv.deleted_at!);
                const isExpiringSoon = remaining <= 2;
                const isBeingActedOn = actionInProgress === conv._id;

                return (
                  <div
                    key={conv._id}
                    className={cn(
                      "group flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
                      "border-border/50 hover:bg-muted/50",
                      isBeingActedOn && "opacity-50 pointer-events-none"
                    )}
                  >
                    {/* Conversation info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <p className="text-sm font-medium truncate">
                          {truncateText(conv.title || "Untitled", 35)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Clock className="h-3 w-3 text-muted-foreground/60" />
                        <span className="text-xs text-muted-foreground/60">
                          Deleted {formatDeletedAt(conv.deleted_at!)}
                        </span>
                        <span className="text-xs text-muted-foreground/40">•</span>
                        <span
                          className={cn(
                            "text-xs",
                            isExpiringSoon
                              ? "text-red-500 font-medium"
                              : "text-muted-foreground/60"
                          )}
                        >
                          {remaining === 0 ? "Expiring today" : `${remaining}d left`}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      {isBeingActedOn ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-500/10"
                                  onClick={() => handleRestore(conv._id)}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top" sideOffset={4}>
                                <p className="text-xs">Restore conversation</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>

                          {confirmPurgeId === conv._id ? (
                            <div className="flex items-center gap-1">
                              <Button
                                variant="destructive"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => handlePermanentDelete(conv._id)}
                              >
                                Confirm
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs px-2"
                                onClick={() => setConfirmPurgeId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <TooltipProvider delayDuration={300}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                    onClick={() => setConfirmPurgeId(conv._id)}
                                  >
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={4}>
                                  <p className="text-xs">Delete permanently</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
