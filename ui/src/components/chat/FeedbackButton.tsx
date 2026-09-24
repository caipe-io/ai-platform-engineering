"use client";

import { ReportProblemDialog } from "@/components/ticket/ReportProblemDialog";
import { Button } from "@/components/ui/button";
import { Dialog,DialogContent,DialogTitle,DialogTrigger } from "@/components/ui/dialog";
import { getConfig } from "@/lib/config";
import { submitFeedback } from "@/lib/langfuse";
import { cn } from "@/lib/utils";
import { AnimatePresence,motion } from "framer-motion";
import { AlertTriangle,Loader2,ThumbsDown,ThumbsUp } from "lucide-react";
import React,{ useState } from "react";

export type FeedbackType = "like" | "dislike" | null;

export interface Feedback {
  type: FeedbackType;
  reason?: string;
  additionalFeedback?: string;
  submitted?: boolean;
  showFeedbackOptions?: boolean;
}

interface FeedbackButtonProps {
  messageId: string;
  /** Optional trace ID for Langfuse feedback tracking. Falls back to messageId if not provided. */
  traceId?: string;
  /** Optional conversation ID for context */
  conversationId?: string;
  feedback?: Feedback;
  onFeedbackChange?: (feedback: Feedback) => void;
  onFeedbackSubmit?: (feedback: Feedback) => void;
  disabled?: boolean;
}

// Feedback reasons matching agent-forge
const LIKE_REASONS = ["Very Helpful", "Accurate", "Simplified My Task", "Other"];
const DISLIKE_REASONS = ["Inaccurate", "Poorly Formatted", "Incomplete", "Off-topic", "Other"];

export function FeedbackButton({
  messageId,
  traceId,
  conversationId,
  feedback,
  onFeedbackChange,
  onFeedbackSubmit,
  disabled = false,
}: FeedbackButtonProps) {
  const [additionalFeedback, setAdditionalFeedback] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);

  const reportProblemEnabled = getConfig("reportProblemEnabled");

  const handleThumbClick = (type: FeedbackType, e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;

    // If same type clicked, deselect (clear feedback)
    if (feedback?.type === type) {
      onFeedbackChange?.({
        type: null,
        showFeedbackOptions: false,
        submitted: false,
        reason: undefined,
        additionalFeedback: undefined,
      });
      setDialogOpen(false);
    } else {
      // New selection or changing feedback - open dialog for reason selection
      onFeedbackChange?.({
        type,
        showFeedbackOptions: true,
        submitted: false,
        reason: undefined,
        additionalFeedback: undefined,
      });
      setDialogOpen(true);
    }
  };

  const handleReasonClick = (reason: string) => {
    onFeedbackChange?.({
      ...feedback,
      type: feedback?.type || null,
      reason,
      showFeedbackOptions: true,
    });

    // Clear additional feedback if not "Other"
    if (reason !== "Other") {
      setAdditionalFeedback("");
    }
  };

  const submitPendingFeedback = async (): Promise<void> => {
    if (!feedback?.reason || !feedback?.type || feedback.submitted) return;
    const finalFeedback: Feedback = {
      ...feedback,
      additionalFeedback: feedback.reason === "Other" ? additionalFeedback : undefined,
      submitted: true,
      showFeedbackOptions: false,
    };

    // Send feedback to server-side API (which forwards to Langfuse if configured)
    await submitFeedback({
      traceId: traceId || messageId,
      messageId,
      feedbackType: feedback.type,
      reason: feedback.reason,
      additionalFeedback: feedback.reason === "Other" ? additionalFeedback : undefined,
      conversationId,
    });

    onFeedbackChange?.(finalFeedback);
    await onFeedbackSubmit?.(finalFeedback);
  };

  const handleSubmitFeedback = async () => {
    if (!feedback?.reason || !feedback?.type) return;
    setIsSubmitting(true);
    await submitPendingFeedback();
    setIsSubmitting(false);
    setAdditionalFeedback("");
    setDialogOpen(false);
  };

  const handleOpenReportDialog = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await submitPendingFeedback();
    setAdditionalFeedback("");
    setDialogOpen(false);
    setReportDialogOpen(true);
  };

  const isLiked = feedback?.type === "like";
  const isDisliked = feedback?.type === "dislike";
  const reasons = isLiked ? LIKE_REASONS : DISLIKE_REASONS;
  const showOtherInput = feedback?.reason === "Other";

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <div className="flex items-center gap-1">
          {/* Thumbs Up Button */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 hover:bg-muted",
              isLiked
                ? "text-green-500 hover:text-green-600"
                : "text-muted-foreground hover:text-foreground"
            )}
            disabled={disabled}
            onClick={(e) => handleThumbClick("like", e)}
            title="Helpful"
          >
            <ThumbsUp className={cn("h-3.5 w-3.5", isLiked && "fill-current")} />
          </Button>

          {/* Thumbs Down Button */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 hover:bg-muted",
              isDisliked
                ? "text-red-500 hover:text-red-600"
                : "text-muted-foreground hover:text-foreground"
            )}
            disabled={disabled}
            onClick={(e) => handleThumbClick("dislike", e)}
            title="Not helpful"
          >
            <ThumbsDown className={cn("h-3.5 w-3.5", isDisliked && "fill-current")} />
          </Button>
        </div>
      </DialogTrigger>

      <DialogContent className="p-5 max-w-xs overflow-hidden">
        <DialogTitle className="sr-only">
          {isLiked ? "Positive Feedback" : "Negative Feedback"}
        </DialogTitle>

        <div className="text-xs text-muted-foreground mb-3">
          {isLiked ? "What did you like?" : "What went wrong?"}
        </div>

        {/* Reason Chips */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {reasons.map((reason) => (
            <button
              key={reason}
              onClick={() => handleReasonClick(reason)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium transition-all",
                feedback?.reason === reason
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {reason}
            </button>
          ))}
        </div>

        {/* Additional Feedback Text Area (for "Other") */}
        <AnimatePresence>
          {showOtherInput && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-3"
            >
              <textarea
                value={additionalFeedback}
                onChange={(e) => setAdditionalFeedback(e.target.value)}
                placeholder="Provide additional feedback"
                className="w-full h-20 px-3 py-2 text-sm bg-muted/50 border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </motion.div>
          )}
        </AnimatePresence>

        <p className="text-[10px] text-muted-foreground/60 mb-2 text-center break-words">
          Feedback is shared with your platform engineering team to help improve the experience.
        </p>

        {/* Submit Buttons */}
        <div className="space-y-2">
          <Button
            size="sm"
            onClick={handleSubmitFeedback}
            disabled={!feedback?.reason || isSubmitting}
            className="w-full gap-2"
          >
            {isSubmitting && <Loader2 className="h-3 w-3 animate-spin" />}
            Submit Feedback
          </Button>

        </div>

        {reportProblemEnabled && isDisliked && (
          <button
            type="button"
            onClick={handleOpenReportDialog}
            className="w-full mt-1 flex items-center justify-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <AlertTriangle className="h-3 w-3" />
            Report a Problem
          </button>
        )}
      </DialogContent>

      {reportProblemEnabled && (
        <ReportProblemDialog
          open={reportDialogOpen}
          onOpenChange={setReportDialogOpen}
          feedbackContext={
            feedback?.type && feedback?.reason
              ? {
                  reason: feedback.reason,
                  additionalFeedback: feedback.reason === "Other" ? additionalFeedback : undefined,
                  feedbackType: feedback.type,
                }
              : undefined
          }
        />
      )}
    </Dialog>
  );
}
