"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Conversation } from "@/types/a2a";
import { cn } from "@/lib/utils";
import { Check, Share2, Users2 } from "lucide-react";
import React, { useState } from "react";
import { ShareDialog } from "./ShareDialog";

interface ShareButtonProps {
  conversationId: string;
  conversationTitle?: string;
  isOwner?: boolean;
  isSharedWithViewer?: boolean;
  sharedBy?: string;
  sharing?: Conversation["sharing"];
  accessLevel?: Conversation["accessLevel"];
  className?: string;
}

export function ShareButton({
  conversationId,
  conversationTitle = "Conversation",
  isOwner = true,
  isSharedWithViewer = false,
  sharedBy,
  sharing,
  accessLevel,
  className,
}: ShareButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleQuickCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();

    const shareUrl = `${window.location.origin}/chat/${conversationId}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleOpenDialog = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDialog(true);
  };

  const sharedByText = sharedBy?.trim()
    ? `Shared by ${sharedBy.trim()}`
    : "Shared conversation";
  const shouldShowButton = isOwner || isSharedWithViewer;
  const shouldOpenDialog = isOwner || accessLevel === "shared";
  const hasSharingConfig = Boolean(
    (sharing?.shared_with?.length ?? 0) > 0 ||
    (sharing?.shared_with_teams?.length ?? 0) > 0 ||
    sharing?.share_link_enabled,
  );
  // assisted-by Codex Codex-sonnet-4-6
  const isShared = hasSharingConfig || isSharedWithViewer;
  const Icon = isShared ? Users2 : Share2;
  const iconClassName = isShared
    ? "h-3 w-3 text-blue-500"
    : "h-3 w-3 text-foreground";

  return (
    <>
      <TooltipProvider>
        {shouldShowButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={shouldOpenDialog ? handleOpenDialog : handleQuickCopy}
                className={cn("h-6 w-6", className)}
                aria-label={isOwner ? "Share conversation" : sharedByText}
              >
                {copied ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Icon className={iconClassName} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {isOwner ? (
                <p>{isShared ? "Edit Share" : "Share"}</p>
              ) : (
                <>
                  {/* assisted-by Codex Codex-sonnet-4-6 */}
                  <p>{copied ? "Link copied" : sharedByText}</p>
                  {!copied && !shouldOpenDialog && (
                    <p className="text-xs text-muted-foreground">
                      Click to copy link
                    </p>
                  )}
                </>
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>

      {/* Share dialog */}
      {shouldShowButton && shouldOpenDialog && (
        <ShareDialog
          conversationId={conversationId}
          conversationTitle={conversationTitle}
          open={showDialog}
          onOpenChange={setShowDialog}
          canManageSharing={isOwner}
          sharedBy={sharedBy}
          initialSharing={sharing}
        />
      )}
    </>
  );
}
