"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { getConfig } from "@/lib/config";
import {
createTicket,
type FeedbackContext,
type TicketResult,
} from "@/lib/ticket-client";
import { AnimatePresence,motion } from "framer-motion";
import Image from "next/image";
import {
AlertCircle,
CheckCircle2,
ChevronDown,
ChevronUp,
Copy,
ExternalLink,
Loader2,
Monitor,
RefreshCw,
Square,
Terminal,
Upload,
X
} from "lucide-react";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import React,{ useCallback,useEffect,useId,useRef,useState } from "react";
import { createPortal } from "react-dom";

type DialogStatus = "idle" | "submitting" | "success" | "error";

interface ReportProblemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-populated feedback context for the combo flow */
  feedbackContext?: FeedbackContext;
}

interface ImageCaptureConstructor {
  new (track: MediaStreamTrack): {
    grabFrame: () => Promise<ImageBitmap>;
  };
}

export function ReportProblemDialog({
  open,
  onOpenChange,
  feedbackContext,
}: ReportProblemDialogProps) {
  const { data: session } = useSession();
  const pathname = usePathname();

  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<DialogStatus>("idle");
  const [ticketResult, setTicketResult] = useState<TicketResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const debugEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const provider = getConfig("ticketProvider");
  const providerLabel = provider === "jira" ? "Jira" : provider === "github" ? "GitHub" : "";

  const contextUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${pathname}`
      : "";

  useEffect(() => {
    if (showDebug && debugEndRef.current) {
      debugEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [debugLog, showDebug]);

  const resetState = useCallback(() => {
    setDescription("");
    setStatus("idle");
    setTicketResult(null);
    setErrorMessage("");
    setDebugLog([]);
    setShowDebug(false);
    setScreenshotDataUrl(null);
    setIsCapturing(false);
    setLightboxOpen(false);
    abortControllerRef.current = null;
  }, []);

  // Capture the tab using getDisplayMedia (browser screen share picker),
  // then grab one video frame into a canvas and convert to a data URL.
  const handleCaptureScreenshot = useCallback(async () => {
    setIsCapturing(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" } as MediaTrackConstraints,
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      // ImageCapture gives a clean single frame without needing a <video> element.
      const IC = (window as Window & { ImageCapture?: ImageCaptureConstructor }).ImageCapture;
      if (IC) {
        const capture = new IC(track);
        const bitmap = await capture.grabFrame();
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        setScreenshotDataUrl(canvas.toDataURL("image/png"));
      } else {
        // Fallback: render into a hidden <video> and snapshot one frame.
        await new Promise<void>((resolve, reject) => {
          const video = document.createElement("video");
          video.srcObject = stream;
          video.muted = true;
          video.onloadedmetadata = () => {
            video.play().then(() => {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              canvas.getContext("2d")!.drawImage(video, 0, 0);
              setScreenshotDataUrl(canvas.toDataURL("image/png"));
              video.srcObject = null;
              resolve();
            }).catch(reject);
          };
          video.onerror = reject;
        });
      }
    } catch (err: unknown) {
      // User cancelled the picker — not an error worth logging loudly.
      const name = (err as { name?: string })?.name;
      if (name !== "NotAllowedError" && name !== "AbortError") {
        console.error("[ReportProblem] Screen capture failed:", err);
      }
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setIsCapturing(false);
    }
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setScreenshotDataUrl(reader.result as string);
    reader.readAsDataURL(file);
    // Reset so selecting the same file again fires onChange
    e.target.value = "";
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        if (status === "submitting") {
          abortControllerRef.current?.abort();
        }
        resetState();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetState, status]
  );

  const appendLog = useCallback((line: string) => {
    setDebugLog((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] ${line}`,
    ]);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!description.trim() && !feedbackContext) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setStatus("submitting");
    setDebugLog([]);
    setErrorMessage("");
    setTicketResult(null);

    const userEmail = session?.user?.email || "unknown";

    appendLog(`Creating ${providerLabel} ticket...`);
    appendLog(`Reporter: ${userEmail}`);
    appendLog(`Context: ${contextUrl}`);

    try {
      const result = await createTicket({
        request: {
          description: feedbackContext
            ? `${feedbackContext.reason}: ${feedbackContext.additionalFeedback || description || "(no additional details)"}`
            : description,
          userEmail,
          contextUrl,
          feedbackContext,
          screenshotDataUrl: screenshotDataUrl ?? undefined,
        },
        accessToken: session?.accessToken,
        signal: controller.signal,
        onEvent: (_event, logLine) => {
          appendLog(logLine);
        },
        onResult: (r) => {
          appendLog(`Ticket created: ${r.id} ${r.url}`);
        },
      });

      if (controller.signal.aborted) return;

      if (result) {
        setTicketResult(result);
        setStatus("success");
      } else {
        setErrorMessage("No ticket ID was returned. The agent may not have created the ticket successfully.");
        setStatus("error");
      }
    } catch (err) {
      if ((err instanceof Error && err.name === "AbortError") || controller.signal.aborted) {
        appendLog("Cancelled by user.");
        resetState();
        return;
      }
      appendLog(`Error: ${getErrorMessage(err, "") || "Unknown error"}`);
      setErrorMessage(getErrorMessage(err, "") || "Failed to create ticket");
      setStatus("error");
    }
  }, [
    description,
    feedbackContext,
    session,
    contextUrl,
    providerLabel,
    screenshotDataUrl,
    appendLog,
    resetState,
  ]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    resetState();
  }, [resetState]);

  const handleCopyDescription = useCallback(() => {
    const text = feedbackContext
      ? `${feedbackContext.reason}: ${feedbackContext.additionalFeedback || description}`
      : description;
    navigator.clipboard.writeText(text);
  }, [description, feedbackContext]);

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {status === "success"
              ? "Ticket Created"
              : status === "error"
                ? "Something Went Wrong"
                : `Report a Problem${providerLabel ? ` via ${providerLabel}` : ""}`}
          </DialogTitle>
          <DialogDescription>
            {status === "idle" &&
              "Describe the issue briefly. A ticket will be created and assigned to the team."}
            {status === "submitting" && "Creating your ticket..."}
            {status === "success" && "Your ticket has been created successfully."}
            {status === "error" && "We couldn't create the ticket. You can retry or copy your description."}
          </DialogDescription>
        </DialogHeader>

        {/* Idle: input form */}
        {status === "idle" && (
          <div className="space-y-3">
            {feedbackContext && (
              <div className="rounded-md bg-muted/50 border border-border/50 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium">Feedback:</span>{" "}
                {feedbackContext.feedbackType === "dislike" ? "👎" : "👍"}{" "}
                {feedbackContext.reason}
                {feedbackContext.additionalFeedback && (
                  <> &mdash; {feedbackContext.additionalFeedback}</>
                )}
              </div>
            )}

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                feedbackContext
                  ? "Add more details for the ticket (optional)"
                  : "What went wrong? Be as specific as you can."
              }
              className="w-full h-24 px-3 py-2 text-sm bg-muted/50 border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              autoFocus
            />

            {/* Screenshot attachment */}
            {screenshotDataUrl ? (
              <div className="relative rounded-lg overflow-hidden border border-border group cursor-zoom-in"
                onClick={() => setLightboxOpen(true)}
              >
                <Image
                  src={screenshotDataUrl}
                  alt="Screenshot preview"
                  width={1280}
                  height={720}
                  unoptimized
                  className="w-full h-32 object-cover object-top"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs font-medium bg-black/60 px-2 py-1 rounded">
                    Click to view
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setScreenshotDataUrl(null); }}
                  className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center transition-colors"
                  aria-label="Remove screenshot"
                >
                  <X className="h-3.5 w-3.5 text-white" />
                </button>
                <div className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white font-medium">
                  Screenshot attached
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCaptureScreenshot}
                  disabled={isCapturing}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground hover:bg-muted/30 transition-all disabled:opacity-50"
                >
                  {isCapturing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Monitor className="h-3.5 w-3.5" />
                  )}
                  {isCapturing ? "Starting capture..." : "Auto-capture screen"}
                </button>
                <label
                  htmlFor={fileInputId}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground hover:bg-muted/30 transition-all cursor-pointer"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload image
                </label>
                <input
                  id={fileInputId}
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleFileUpload}
                />
              </div>
            )}

            <p className="text-[10px] text-muted-foreground/60 text-center break-words">
              The current page URL and your email will be included in the ticket.
            </p>

            <Button
              onClick={handleSubmit}
              disabled={!description.trim() && !feedbackContext}
              className="w-full gap-2"
            >
              Submit Report
            </Button>
          </div>
        )}

        {/* Submitting: progress */}
        {status === "submitting" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center py-2">
              <div className="relative w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                <Loader2 className="h-5 w-5 text-primary animate-spin" />
              </div>
            </div>

            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-primary via-primary/60 to-primary rounded-full"
                initial={{ x: "-100%" }}
                animate={{ x: "100%" }}
                transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
                style={{ width: "50%" }}
              />
            </div>

            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-xs h-7"
                onClick={handleCancel}
              >
                <Square className="h-3 w-3" />
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs h-7 text-muted-foreground"
                onClick={() => setShowDebug(!showDebug)}
              >
                <Terminal className="h-3 w-3" />
                {showDebug ? "Hide" : "Show"} Details
                {showDebug ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </Button>
            </div>

            <AnimatePresence>
              {showDebug && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="rounded-lg border border-border/50 bg-zinc-950 overflow-hidden">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/30 bg-zinc-900">
                      <Terminal className="h-3 w-3 text-green-400" />
                      <span className="text-xs font-mono text-green-400">
                        Stream Events
                      </span>
                      <span className="ml-auto text-xs font-mono text-muted-foreground">
                        {debugLog.length} event{debugLog.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="max-h-48 overflow-y-auto p-2 font-mono text-xs leading-relaxed">
                      {debugLog.length === 0 ? (
                        <p className="text-muted-foreground/50 italic">
                          Waiting for events...
                        </p>
                      ) : (
                        debugLog.map((line, i) => (
                          <p key={i} className="text-green-300/80 break-all">
                            {line}
                          </p>
                        ))
                      )}
                      <div ref={debugEndRef} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Success */}
        {status === "success" && ticketResult && (
          <div className="space-y-4 text-center">
            <div className="flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-green-500" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium">{ticketResult.id}</p>
              {ticketResult.url && (
                <a
                  href={ticketResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                >
                  Open in {providerLabel}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleOpenChange(false)}
            >
              Done
            </Button>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="space-y-4 text-center">
            <div className="flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-destructive/20 flex items-center justify-center">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{errorMessage}</p>

            {debugLog.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs h-7 text-muted-foreground"
                onClick={() => setShowDebug(!showDebug)}
              >
                <Terminal className="h-3 w-3" />
                {showDebug ? "Hide" : "Show"} Details
              </Button>
            )}

            <AnimatePresence>
              {showDebug && debugLog.length > 0 && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="rounded-lg border border-border/50 bg-zinc-950 overflow-hidden text-left">
                    <div className="max-h-32 overflow-y-auto p-2 font-mono text-xs leading-relaxed">
                      {debugLog.map((line, i) => (
                        <p key={i} className="text-red-300/80 break-all">
                          {line}
                        </p>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 gap-1"
                onClick={handleCopyDescription}
              >
                <Copy className="h-3 w-3" />
                Copy Description
              </Button>
              <Button className="flex-1 gap-1" onClick={handleSubmit}>
                <RefreshCw className="h-3 w-3" />
                Retry
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* Lightbox portal — renders outside the Dialog so it isn't clipped */}
    {typeof document !== "undefined" && screenshotDataUrl && lightboxOpen && createPortal(
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="relative max-w-5xl max-h-[90vh] w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <Image
              src={screenshotDataUrl}
              alt="Screenshot full view"
              width={1920}
              height={1080}
              unoptimized
              className="w-full h-auto max-h-[90vh] object-contain rounded-lg shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
              className="absolute top-2 right-2 h-8 w-8 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4 text-white" />
            </button>
          </motion.div>
        </motion.div>
      </AnimatePresence>,
      document.body
    )}
    </>
  );
}
