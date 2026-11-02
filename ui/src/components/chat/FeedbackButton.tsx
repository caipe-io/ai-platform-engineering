"use client";

import { ReportProblemDialog } from "@/components/ticket/ReportProblemDialog";
import { Button } from "@/components/ui/button";
import { Dialog,DialogContent,DialogTitle } from "@/components/ui/dialog";
import type { FeedbackContext, TicketRequest } from "@/lib/ticket-client";
import { getConfig } from "@/lib/config";
import { submitFeedback } from "@/lib/langfuse";
import { cn } from "@/lib/utils";
import { AnimatePresence,motion } from "framer-motion";
import { Loader2,ThumbsDown,ThumbsUp } from "lucide-react";
import React,{ useRef,useState } from "react";

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
  const [reportingNegative, setReportingNegative] = useState(false);
  const reportedRatingRef = useRef<Promise<void> | null>(null);
  const [submitError, setSubmitError] = useState("");
  const submittingRef = useRef(false);

  const reportProblemEnabled = getConfig("reportProblemEnabled");

  const handleThumbClick = (type: FeedbackType, e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled || submittingRef.current) return;
    setSubmitError("");
    setAdditionalFeedback("");

    if (type === "dislike" && reportProblemEnabled && feedback?.type !== "dislike") {
      setReportingNegative(true);
      setDialogOpen(false);
      setReportDialogOpen(true);
      return;
    }

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

  const recordFeedback = async (context: FeedbackContext): Promise<void> => {
    const result = await submitFeedback({
      traceId: traceId || messageId,
      messageId,
      ...context,
      conversationId,
    });
    if (!result.success) throw new Error(result.message || "Could not submit feedback. Please try again.");

    const finalFeedback: Feedback = {
      type: context.feedbackType,
      reason: context.reason,
      additionalFeedback: context.additionalFeedback,
      submitted: true,
      showFeedbackOptions: false,
    };
    onFeedbackChange?.(finalFeedback);
    await onFeedbackSubmit?.(finalFeedback);
  };

  const handleSubmitFeedback = async () => {
    if (!feedback?.reason || !feedback?.type || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError("");
    try {
      if (!feedback.submitted) await recordFeedback({
        feedbackType: feedback.type,
        reason: feedback.reason,
        additionalFeedback: feedback.reason === "Other" ? additionalFeedback : undefined,
      });
      setAdditionalFeedback("");
      setDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not submit feedback. Please try again.");
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleReportFeedback = async (request: TicketRequest): Promise<FeedbackContext> => {
    const context: FeedbackContext = {
      feedbackType: "dislike",
      reason: request.issueType || "Bug",
      additionalFeedback: request.description,
    };
    // Keep the first saved rating across closes/retries, including an in-flight
    // save. The ticket always receives the details from the current attempt.
    if (!reportedRatingRef.current) {
      reportedRatingRef.current = recordFeedback(context).catch(error => {
        reportedRatingRef.current = null;
        throw error;
      });
    }
    await reportedRatingRef.current;
    return context;
  };

  const isLiked = feedback?.type === "like";
  const isDisliked = feedback?.type === "dislike";
  const reasons = isLiked ? LIKE_REASONS : DISLIKE_REASONS;
  const showOtherInput = feedback?.reason === "Other";

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
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

        {submitError && <p role="alert" className="text-xs text-destructive">{submitError}</p>}

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
      </DialogContent>
      </Dialog>

      {reportProblemEnabled && (
        <ReportProblemDialog
          conversationId={conversationId}
          open={reportDialogOpen}
          onOpenChange={setReportDialogOpen}
          onBeforeSubmit={reportingNegative ? handleReportFeedback : undefined}
        />
      )}
    </>
  );
}
