"use client";

import { FEEDBACK_SEVERITIES, describeFeedbackBrowser, type FeedbackSeverity } from "@/lib/feedback-features";
import { getErrorMessage } from "@/lib/error-utils";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
Dialog,
DialogContent,
DialogDescription,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import {
createTicketViaAgent,
fetchFeedbackOptions,
fetchFeedbackComponents,
type FeedbackComponent,
type FeedbackOptions,
type FeedbackContext,
type TicketResult,
type TicketRequest,
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
GitBranch,
Loader2,
Monitor,
RefreshCw,
Square,
Terminal,
Upload,
X
} from "lucide-react";
import { useSession } from "next-auth/react";
import React,{ useCallback,useEffect,useId,useRef,useState } from "react";
import { createPortal } from "react-dom";

const REPORT_FIELDS = {
  Bug: [
    { key: "steps", label: "Steps to reproduce", required: true, placeholder: "1. Open the page\n2. Click ...\n3. ..." },
    { key: "expected", label: "What I expected", required: false, placeholder: "What should have happened" },
    { key: "actual", label: "What happened instead", required: false, placeholder: "What happened instead" },
  ],
  Enhancement: [
    { key: "goal", label: "What I am trying to do", required: true, placeholder: "What you want to get done" },
    { key: "today", label: "How I do it today", required: false, placeholder: "Your current workaround, if any" },
    { key: "who", label: "Who else needs this", required: false, placeholder: "Who would benefit" },
  ],
} as const;
const FIELD_CLASS = "w-full px-3 py-2 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50";

type DialogStatus = "idle" | "submitting" | "success" | "error";

interface ReportProblemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-populated feedback context for the combo flow */
  feedbackContext?: FeedbackContext;
  /** Record response feedback on an explicit submission, before creating its report. */
  onBeforeSubmit?: (request: TicketRequest) => Promise<FeedbackContext>;
  /** Optional visible chat excerpt; sent only after the reporter opts in. */
  chatContext?: string;
  conversationId?: string;
  /** Select the calling app through the authorized component registry. */
  initialComponentId?: string | null;
  initialFeature?: string;
  appContext?: Record<string, string>;
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
  onBeforeSubmit,
  chatContext,
  conversationId,
  initialComponentId,
  initialFeature,
  appContext,
}: ReportProblemDialogProps) {
  const { data: session } = useSession();

  const [issueType, setIssueType] = useState<"Bug" | "Enhancement">("Bug");
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<FeedbackOptions | null>(null);
  const [components, setComponents] = useState<FeedbackComponent[]>([]);
  const [componentId, setComponentId] = useState<string | null | undefined>(undefined);
  const [registryAttempt, setRegistryAttempt] = useState(0);
  const [optionsError, setOptionsError] = useState("");
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [feature, setFeature] = useState<string>("Other");
  const [relatedUrl, setRelatedUrl] = useState("");
  const fieldId = useId();
  const fields = REPORT_FIELDS[issueType];
  const validRelatedUrl = !relatedUrl.trim() || (() => {
    try { return ["http:", "https:"].includes(new URL(relatedUrl.trim()).protocol); }
    catch { return false; }
  })();
  const sections = fields.flatMap(field => values[field.key]?.trim() ? [{ label: field.label, value: values[field.key].trim() }] : []);

  const [severity, setSeverity] = useState<FeedbackSeverity>();
  const [includeChatContext, setIncludeChatContext] = useState(false);
  const [chatContextDraft, setChatContextDraft] = useState("");
  const [status, setStatus] = useState<DialogStatus>("idle");
  const [ticketResult, setTicketResult] = useState<TicketResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const canSubmit = Boolean(options) && (!screenshotDataUrl || options?.screenshotsEnabled !== false) && Boolean(title.trim()) && fields.every(field => !field.required || values[field.key]?.trim()) && validRelatedUrl;
  const [isCapturing, setIsCapturing] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const debugEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const reportDescription = [
    title.trim(),
    ...sections.map(section => `${section.label}:\n${section.value}`),
    feedbackContext && `Feedback: ${feedbackContext.reason}`,
    feedbackContext?.additionalFeedback,
    severity && `Impact: ${severity}`,
    options && `Component: ${options.label}`,
    `Feature: ${feature}`,
    relatedUrl.trim() && `Link: ${relatedUrl.trim()}`,
  ].filter(Boolean).join("\n\n");

  const contextUrl =
    typeof window !== "undefined"
      ? window.location.href
      : "";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setComponents([]);
    setComponentId(undefined);
    setOptions(null);
    setOptionsError("");
    void fetchFeedbackComponents(contextUrl, conversationId, controller.signal, initialComponentId).then(data => {
      if (controller.signal.aborted) return;
      setComponents(data.components);
      setComponentId(data.appId);
    }).catch(error => {
      if (!controller.signal.aborted) setOptionsError(error instanceof Error ? error.message : "Could not load feedback components");
    });
    return () => controller.abort();
  }, [open, contextUrl, conversationId, registryAttempt, initialComponentId]);

  useEffect(() => {
    if (!open || !components.length || componentId === undefined) return;
    const controller = new AbortController();
    setOptions(null);
    setOptionsError("");
    void fetchFeedbackOptions(contextUrl, conversationId, controller.signal, componentId).then(data => {
      if (controller.signal.aborted) return;
      setOptions(data);
      setFeature(componentId === initialComponentId && initialFeature && data.features.includes(initialFeature)
        ? initialFeature : data.features.includes("Other") ? "Other" : data.features[0]);
    }).catch(error => {
      if (!controller.signal.aborted) setOptionsError(error instanceof Error ? error.message : "Could not load feedback categories");
    });
    return () => controller.abort();
  }, [open, components.length, componentId, contextUrl, conversationId, optionsAttempt, initialComponentId, initialFeature]);

  useEffect(() => {
    if (showDebug && debugEndRef.current) {
      debugEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [debugLog, showDebug]);

  const resetState = useCallback(() => {
    setIssueType("Bug");
    setComponents([]);
    setComponentId(undefined);
    setOptions(null);
    setFeature("Other");
    setTitle("");
    setValues({});
    setRelatedUrl("");
    setSeverity(undefined);
    setIncludeChatContext(false);
    setChatContextDraft("");
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
    if (!canSubmit || abortControllerRef.current) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setStatus("submitting");
    setDebugLog([]);
    setErrorMessage("");
    setTicketResult(null);

    const userEmail = session?.user?.email || "unknown";

    appendLog("Submitting feedback...");
    appendLog(`Reporter: ${userEmail}`);
    appendLog(`Context: ${contextUrl}`);

    try {
      const request: TicketRequest = {
        description: reportDescription,
        title: title.trim(),
        issueType,
        feature,
        severity,
        sections,
        relatedUrl: relatedUrl.trim() || undefined,
        browser: describeFeedbackBrowser(navigator.userAgent),
        source: onBeforeSubmit || conversationId || feedbackContext ? "chat-feedback" : initialComponentId ? "app" : "header",
        appContext: options?.appId === initialComponentId ? appContext : undefined,
        userEmail,
        contextUrl,
        conversationId,
        componentId: options?.appId,
        feedbackContext,
        screenshotDataUrl: screenshotDataUrl ?? undefined,
        ...(includeChatContext && chatContext && chatContextDraft.trim()
          ? { chatContext: chatContextDraft.trim() } : {}),
      };
      const submittedContext = await onBeforeSubmit?.(request);
      if (controller.signal.aborted) return;
      const result = await createTicketViaAgent({
        request: { ...request, feedbackContext: submittedContext ?? request.feedbackContext },
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
        if (abortControllerRef.current === controller) {
          appendLog("Cancelled by user.");
          resetState();
        }
        return;
      }
      appendLog(`Error: ${getErrorMessage(err, "") || "Unknown error"}`);
      setErrorMessage(getErrorMessage(err, "") || "Failed to create ticket");
      setStatus("error");
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  }, [
    canSubmit,
    options,
    reportDescription,
    title,
    issueType,
    feature,
    severity,
    sections,
    relatedUrl,
    appContext,
    initialComponentId,
    feedbackContext,
    onBeforeSubmit,
    session,
    contextUrl,
    conversationId,
    screenshotDataUrl,
    includeChatContext,
    chatContext,
    chatContextDraft,
    appendLog,
    resetState,
  ]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    resetState();
  }, [resetState]);

  const handleCopyDescription = useCallback(() => {
    navigator.clipboard.writeText(reportDescription);
  }, [reportDescription]);

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl max-h-[90dvh] gap-3 overflow-y-auto p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle>
            {status === "success"
              ? "Ticket Created"
              : status === "error"
                ? "Something Went Wrong"
                : "Provide Feedback"}
          </DialogTitle>
          <DialogDescription>
            {status === "idle" &&
              "Tell us what happened. Fields marked * are required."}
            {status === "submitting" && "Creating your ticket..."}
            {status === "success" && "Your ticket has been created successfully."}
            {status === "error" && "We couldn't create the ticket. You can retry or copy your description."}
          </DialogDescription>
        </DialogHeader>

        {/* Idle: input form */}
        {status === "idle" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-4">
            <div className="flex min-w-0 flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <label htmlFor={`${fieldId}-component`} className="shrink-0 text-xs font-medium text-muted-foreground">Component *</label>
                <Select id={`${fieldId}-component`} required disabled={!components.length} className="min-w-0 flex-1"
                  value={componentId === undefined ? "" : componentId === null ? "platform" : `app:${componentId}`}
                  onChange={event => {
                    const next = event.target.value === "platform" ? null : event.target.value.slice(4);
                    if (next !== componentId) {
                      setOptions(null);
                      setFeature("Other");
                      setComponentId(next);
                    }
                  }}>
                  {!components.length && <option value="">{optionsError ? "Components unavailable" : "Loading components…"}</option>}
                  {components.map(item => <option key={item.appId === null ? "platform" : `app:${item.appId}`}
                    value={item.appId === null ? "platform" : `app:${item.appId}`}>{item.label}</option>)}
                </Select>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <label htmlFor={`${fieldId}-feature`} className="shrink-0 text-xs font-medium text-muted-foreground">Feature</label>
                <Select id={`${fieldId}-feature`} value={feature} disabled={!options} className="min-w-0 flex-1" onChange={event => setFeature(event.target.value)}>
                  {!options && <option value="Other">{optionsError ? "Categories unavailable" : "Loading categories…"}</option>}
                  {options?.features.map(item => <option key={item} value={item}>{item}</option>)}
                </Select>
              </div>
            </div>

            {options?.destination && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
                <GitBranch aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="break-all">{options.destination.provider === "github"
                  ? `→ GitHub issue in ${options.destination.repository}`
                  : `→ Jira issue in ${options.destination.project}`}</span>
              </p>
            )}

            {feedbackContext && (
              <div className="rounded-md bg-muted/50 border border-border/50 px-3 py-2 text-xs text-muted-foreground sm:col-span-2">
                <span className="font-medium">Feedback:</span>{" "}
                {feedbackContext.feedbackType === "dislike" ? "👎" : "👍"}{" "}
                {feedbackContext.reason}
                {feedbackContext.additionalFeedback && (
                  <> &mdash; {feedbackContext.additionalFeedback}</>
                )}
              </div>
            )}

            <fieldset className="space-y-1 sm:col-span-2">
              <legend className="text-xs font-medium text-muted-foreground">Type *</legend>
              <div className="flex flex-wrap gap-1.5">
                {(["Bug", "Enhancement"] as const).map(type => (
                  <button key={type} type="button" aria-pressed={issueType === type}
                    onClick={() => setIssueType(type)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${issueType === type ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
                    {type}
                  </button>
                ))}
              </div>
            </fieldset>
            {optionsError && <div role="alert" className="text-xs text-destructive sm:col-span-2">{optionsError} <button type="button" className="underline" onClick={() => components.length ? setOptionsAttempt(value => value + 1) : setRegistryAttempt(value => value + 1)}>Retry categories</button></div>}

            <div className="space-y-1 sm:col-span-2">
              <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                <label htmlFor={`${fieldId}-title`} className="font-medium">Short title *</label>
                <span>{title.length}/60</span>
              </div>
              <input id={`${fieldId}-title`} value={title} onChange={event => setTitle(event.target.value)}
                maxLength={60} required autoFocus placeholder="One line that names the problem" className={FIELD_CLASS} />
            </div>
            {fields.map(field => (
              <div key={field.key} className={`space-y-1 ${field.required ? "sm:col-span-2" : ""}`}>
                <label htmlFor={`${fieldId}-${field.key}`} className="text-xs font-medium text-muted-foreground">
                  {field.label}{field.required ? " *" : ""}
                </label>
                <textarea id={`${fieldId}-${field.key}`} required={field.required} value={values[field.key] ?? ""}
                  maxLength={4000} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                  placeholder={field.placeholder} className={`${FIELD_CLASS} ${field.required ? "h-20" : "h-16"} resize-y`} />
              </div>
            ))}
            <div className="space-y-1 sm:col-span-2">
              <label htmlFor={`${fieldId}-link`} className="text-xs font-medium text-muted-foreground">Link (optional)</label>
              <input id={`${fieldId}-link`} type="url" value={relatedUrl} maxLength={2000}
                onChange={event => setRelatedUrl(event.target.value)} aria-invalid={!validRelatedUrl}
                placeholder="Paste the page or item this is about" className={FIELD_CLASS} />
              {!validRelatedUrl && <p role="alert" className="text-xs text-destructive">Use a link starting with http:// or https://.</p>}
            </div>

            <details open className="rounded-lg border border-border px-3 py-2 sm:col-span-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">More details (optional)</summary>
              <div className="mt-3 space-y-3">
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-muted-foreground">How much does it affect you?</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {FEEDBACK_SEVERITIES.map(value => <button key={value} type="button" aria-pressed={severity === value}
                      onClick={() => setSeverity(current => current === value ? undefined : value)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${severity === value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
                      {value}
                    </button>)}
                  </div>
                </fieldset>

            {chatContext && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" checked={includeChatContext}
                    onChange={event => {
                      setIncludeChatContext(event.target.checked);
                      if (event.target.checked && !chatContextDraft) setChatContextDraft(chatContext);
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary focus:ring-2 focus:ring-primary/50" />
                  <span>Include your chat</span>
                </label>
                {includeChatContext && (
                  <textarea aria-label="Chat context to include" value={chatContextDraft} maxLength={14000}
                    onChange={event => setChatContextDraft(event.target.value)}
                    className="h-40 w-full resize-y rounded-md border border-border bg-muted/50 p-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                )}
              </div>
            )}

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
            ) : options?.screenshotsEnabled !== false ? (
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
            ) : null}
            {screenshotDataUrl && options?.screenshotsEnabled === false && <p role="alert" className="text-xs text-destructive">This component does not support screenshots. Remove the image to submit.</p>}

              </div>
            </details>

            <div className="space-y-3 sm:col-span-2">
            <p className="text-center text-xs text-muted-foreground break-words">
              The current page URL and your email will be included in the ticket.
            </p>

            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full gap-2"
            >
              Submit Report
            </Button>
            </div>
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
                  Open in {{ jira: "Jira", github: "GitHub", gitlab: "GitLab", webex: "Webex" }[ticketResult.provider]}
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
