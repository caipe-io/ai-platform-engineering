"use client";

/**
 * SkillWorkspace — full-screen wizard-style editor for a single skill.
 *
 * Replaces the long, monolithic `SkillsBuilderEditor` dialog with a richer
 * surface composed of:
 *
 *   Header   — back, name, sync/scan badges, dirty indicator, Export, Save
 *   Steps    — 1. Overview · 2. Skill content · 3. Tools · 4. Scan skill
 *   Footer   — sticky "Previous: <name>" / "Next: <name>" buttons; the Next
 *              button on the last writable step becomes "Save".
 *
 * The workflow is intentionally numbered so first-time builders have a
 * clear "do this then do that" path — a guided wizard, not a free-form
 * tab grid. Power users can still click any step header to jump.
 *
 * The Test surface lives outside the builder (gallery → "Try Skill")
 * because it requires a saved skill and is a different mental mode
 * (running, not authoring).
 *
 * All form state is owned by the shared `useSkillForm` hook. Tab
 * components are pure consumers of the hook output, which keeps each tab
 * small and trivially testable in isolation.
 */

import {
ArrowLeft,
ArrowRight,
Copy,
Download,
Eye,
FileCode,
History as HistoryIcon,
Loader2,
Save,
Settings as SettingsIcon,
ShieldCheck,
Wrench,
} from "lucide-react";
import { useRouter } from "next/navigation";
import React,{ useCallback,useEffect,useMemo,useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import {
Tabs,
TabsContent,
TabsList,
TabsTrigger,
} from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { getConfig } from "@/lib/config";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { cn } from "@/lib/utils";

import { buildBlockingMessage,buildLastReview,useAiReview } from "@/components/ai-review";
import { SkillScanStatusIndicator } from "@/components/skills/SkillScanStatusIndicator";
import {
useSkillForm,
} from "@/components/skills/workspace/use-skill-form";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type { AgentSkill } from "@/types/agent-skill";

import { FilesTab } from "@/components/skills/workspace/tabs/FilesTab";
import { ScanTab } from "@/components/skills/workspace/tabs/HistoryTab";
import { OverviewTab } from "@/components/skills/workspace/tabs/OverviewTab";
import { ToolsTab } from "@/components/skills/workspace/tabs/ToolsTab";
import { VersionsTab } from "@/components/skills/workspace/tabs/VersionsTab";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Step identifiers — kept stable so deep links (`?tab=files`) keep working
 * even though the visible labels are now numbered. We intentionally keep
 * legacy values like `"test"` and `"variables"` out of the union but
 * accept them at runtime (page.tsx's `LEGACY_TAB_REMAP` redirects them
 * — `variables` → `files` since the variables editor was folded into
 * the Files step) so old bookmarks don't 404 the editor.
 */
export type SkillWorkspaceTabId =
  | "overview"
  | "files"
  | "tools"
  | "versions"
  | "history";

export interface SkillWorkspaceProps {
  /** Existing saved skill (omit for new). */
  existingConfig?: AgentSkill;
  /** Initial step id. Default: "files" (the editing surface most users want). */
  initialTab?: SkillWorkspaceTabId;
  /** Where to navigate when the user clicks "Back". Default: "/skills". */
  backHref?: string;
  /** Override the back-button label. */
  backLabel?: string;
  /** Force read-only mode (built-in / hub skill). */
  readOnly?: boolean;
}

interface StepDef {
  id: SkillWorkspaceTabId;
  /** Short, action-oriented label shown in the header (e.g. "Files"). */
  label: string;
  /** One-sentence hint shown under the step number on the active panel. */
  hint: string;
  icon: React.ElementType;
  /**
   * Whether this step's panel should consume the full viewport width
   * (true for editor-heavy tabs like Files) or stay in a centered
   * reading-width column (false for short forms like Overview).
   */
  fullWidth?: boolean;
}

/**
 * The wizard order. Position in this array drives the displayed step
 * number and the Previous / Next button targets — keep "Scan History"
 * last so first-time builders aren't tempted to skip authoring steps to
 * reach it.
 */
const STEPS: StepDef[] = [
  {
    id: "overview",
    label: "Overview",
    hint: "Name your skill and describe what it does.",
    icon: SettingsIcon,
  },
  {
    // Files step now hosts both the multi-file editor AND the input
    // variables editor (the latter as a collapsible side-panel toggled
    // from the toolbar). Variables were promoted into this step so
    // authors don't have to flip wizard tabs every time they add a
    // `{{var}}` reference to SKILL.md. Tools share the Files step's
    // full-width layout so long lists / large tool catalogs get the
    // same horizontal real estate as the SKILL.md editor.
    id: "files",
    label: "Skill content",
    hint: "Write SKILL.md, add helper files, and declare any input variables the template references.",
    icon: FileCode,
    fullWidth: true,
  },
  {
    id: "tools",
    label: "Tools",
    hint: "Pick the agent tools this skill is allowed to call.",
    icon: Wrench,
  },
  {
    // Version history sits between the authoring steps and the
    // scanner so users have a clear "I broke something — let me roll
    // back" affordance available without leaving the workspace.
    // Only available for saved skills (no draft has history yet).
    id: "versions",
    label: "Versions",
    hint: "Browse, diff, and restore earlier snapshots of this skill.",
    icon: HistoryIcon,
    fullWidth: true,
  },
  {
    // Step id stays "history" so existing deep links (`?tab=history`)
    // and saved workspace state continue to work — only the label and
    // icon change. The page-level `LEGACY_TAB_REMAP` also accepts
    // `?tab=scan` as an alias so users naturally typing the new name
    // don't get bounced.
    id: "history",
    label: "Scan skill",
    hint: "Run the security scanner now and review past results.",
    icon: ShieldCheck,
    fullWidth: true,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SkillWorkspace({
  existingConfig,
  initialTab,
  backHref = "/skills",
  backLabel = "Back to Skills",
  readOnly = false,
}: SkillWorkspaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  // For NEW skills we land on Step 1 (Overview) so the wizard reads
  // "1. Name it" naturally; for EXISTING skills we drop straight into
  // the Files editor since that's the surface returning users edit most.
  const defaultInitialTab: SkillWorkspaceTabId = existingConfig
    ? "files"
    : "overview";
  const [tab, setTab] = useState<SkillWorkspaceTabId>(
    initialTab ?? defaultInitialTab,
  );

  const form = useSkillForm({
    existingConfig,
    onSuccess: ({ id, created }) => {
      toast(
        created ? "Skill created" : "Skill updated successfully",
        "success",
      );
      if (created) {
        // The form was operating on an unsaved draft (`existingConfig` was
        // undefined). Navigate to the persisted workspace so subsequent
        // edits hit the update branch instead of creating duplicates, and
        // jump straight to the Scan step + kick off a scan so the user
        // sees the next milestone in the authoring flow rather than being
        // stranded on the same form. The scan request is fire-and-forget;
        // the Scan tab polls for status on mount, so we don't need to
        // await it here.
        try {
          void fetch(
            `/api/skills/configs/${encodeURIComponent(id)}/scan`,
            { method: "POST" },
          );
        } catch {
          // Non-fatal — the Scan tab also exposes a manual "Scan now"
          // button. We deliberately swallow rather than block navigation.
        }
        router.push(
          `/skills/workspace/${encodeURIComponent(id)}?tab=scan`,
        );
      }
      // For updates we stay on the workspace so the user can keep editing.
    },
  });

  // -------------------------------------------------------------------
  // AI Review for SKILL.md
  //
  // The review hook lives here (not in `FilesTab`) so the wizard's
  // Next/Save click handlers can call `review.ensurePassedOrRun()` from
  // any step. `FilesTab` consumes the same hook result via prop and
  // renders the button + panel in its toolbar / editor row.
  // -------------------------------------------------------------------
  const review = useAiReview({
    target: "skill-md",
    content: form.skillContent,
    context: {
      name: form.formData.name,
      skill_description: form.formData.description,
    },
    onApplyFix: (next) => form.setSkillContentAndSyncTools(next),
  });

  // History tab needs a stable id; for new (unsaved) skills there is no
  // backing audit log yet.
  const skillIdForHistory = existingConfig?.id;

  // ---------------------------------------------------------------------
  // Unsaved-changes guard
  //
  // We integrate with the global `useUnsavedChangesStore` so the app-shell
  // header (`AppHeader` / `NavLink`) intercepts clicks on top-level nav
  // links (Home, Chat, Skills, Admin, …) and routes them through the
  // SAME discard-confirm dialog the in-workspace Back button uses. Without
  // this wiring the browser would silently swap pages and trash unsaved
  // edits.
  //
  // We additionally:
  //   - Mark the page dirty in the store whenever the form is dirty
  //   - Clear it on unmount (so a stale flag doesn't follow the user)
  //   - Block browser tab close / refresh via `beforeunload` while dirty
  // ---------------------------------------------------------------------
  const {
    setUnsaved,
    pendingNavigationHref,
    cancelNavigation,
    confirmNavigation,
  } = useUnsavedChangesStore();

  // Read-only skills (built-in / hub) are never dirty from the user's
  // perspective even if some local form state changes — don't surface the
  // guard for them.
  const trackDirty = form.isDirty && !readOnly;

  useEffect(() => {
    setUnsaved(trackDirty);
  }, [trackDirty, setUnsaved]);

  // Always clear on unmount — even if the workspace was unmounted while
  // dirty (e.g. the user confirmed discard via a modal), the next page
  // shouldn't inherit the dirty flag.
  useEffect(() => {
    return () => setUnsaved(false);
  }, [setUnsaved]);

  // Browser tab close / refresh / hard navigation. The browser shows its
  // own native confirm prompt; the message string is ignored by modern
  // engines but `e.preventDefault()` is what triggers the dialog.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!trackDirty) return;
      e.preventDefault();
      // Legacy browsers required a returnValue assignment; harmless on
      // modern ones and keeps a few enterprise IE/Edge variants honest.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [trackDirty]);

  // When application navigation records a pending destination (e.g. the user
  // clicked "Chat" while dirty), surface our existing
  // discard-confirm dialog. The handshake happens via the form's
  // `guardedClose` so we reuse the same UI for ALL navigation entry
  // points (Back button, application navigation, deep links).
  useEffect(() => {
    if (pendingNavigationHref && trackDirty) {
      form.guardedClose();
    }
  }, [pendingNavigationHref, trackDirty, form]);

  // Confirm-on-back when dirty.
  const handleBack = useCallback(() => {
    if (trackDirty) {
      form.guardedClose();
      return;
    }
    pushWithNavigationProgress(router,backHref);
  }, [form,router,backHref,trackDirty]);

  // Confirm + navigate. Prefer the pending external href (application-navigation click)
  // over `backHref` — when the user clicks "Chat" in the global header and
  // then confirms "Discard & leave", they expect to land on Chat, not on
  // the Skills gallery.
  const confirmDiscardAndNavigate = useCallback(() => {
    form.confirmDiscard();
    setUnsaved(false);
    const externalHref = pendingNavigationHref
      ? confirmNavigation()
      : null;
    const target = externalHref || backHref;
    pushWithNavigationProgress(router,target);
  }, [
    form,
    router,
    backHref,
    pendingNavigationHref,
    confirmNavigation,
    setUnsaved,
  ]);

  // Cancelling the discard dialog also clears the pending external nav
  // request — otherwise the next dirty edit would re-open the dialog.
  const cancelDiscardAndKeep = useCallback(() => {
    form.cancelDiscard();
    cancelNavigation();
  }, [form, cancelNavigation]);

  // ---------------------------------------------------------------------
  // Export — download a ZIP of SKILL.md + ancillary files.
  //
  // The endpoint streams `application/zip` bytes (not JSON), so we read the
  // response as a Blob and trigger a synthetic <a download> click. Works
  // for both editable user skills and read-only built-ins. We surface a
  // toast on failure since browsers swallow non-2xx responses silently for
  // attachment downloads.
  // ---------------------------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);
  const handleExport = useCallback(async () => {
    if (!existingConfig?.id) return;
    setIsExporting(true);
    try {
      const url = `/api/skills/configs/${encodeURIComponent(existingConfig.id)}/export`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error || body?.message) {
            detail = body.message || body.error;
          }
        } catch {
          // Response wasn't JSON — keep the status-code fallback.
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const dispo = res.headers.get("Content-Disposition") || "";
      const match = dispo.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] || `${existingConfig.name || "skill"}.zip`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast(`Exported "${existingConfig.name}"`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      toast(`Export failed: ${message}`, "error");
    } finally {
      setIsExporting(false);
    }
  }, [existingConfig, toast]);

  // -------------------------------------------------------------------
  // Built-in mutation lock
  //
  // When a built-in skill is opened (read-only) and the operator
  // hasn't set ALLOW_BUILTIN_SKILL_MUTATION=true, we surface a
  // "Clone to edit" CTA next to the disabled Save. This is the same
  // escape hatch the gallery offers; rendering it here too means the
  // user can act on the lock without going back to the gallery.
  // -------------------------------------------------------------------
  const allowBuiltinSkillMutation = getConfig("allowBuiltinSkillMutation");
  const showCloneCta =
    !!existingConfig &&
    !!existingConfig.is_system &&
    !allowBuiltinSkillMutation;

  const [isCloning, setIsCloning] = useState(false);
  const handleClone = useCallback(async () => {
    if (!existingConfig || isCloning) return;
    setIsCloning(true);
    try {
      const res = await fetch(
        `/api/skills/configs/${encodeURIComponent(existingConfig.id)}/clone`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Clone failed (${res.status})`);
      }
      const json = await res.json();
      // Clone returns the success-envelope shape ({ success, data: { id, name } })
      // via successResponse(); unwrap it (falling back to the flat shape) so we
      // never navigate to /skills/workspace/undefined.
      const data = json?.data ?? json;
      toast(`Cloned to "${data.name}"`, "success");
      router.push(`/skills/workspace/${encodeURIComponent(data.id)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clone failed";
      toast(`Clone failed: ${message}`, "error");
    } finally {
      setIsCloning(false);
    }
  }, [existingConfig, isCloning, router, toast]);

  const submitDisabled = useMemo(
    () =>
      readOnly ||
      form.isSubmitting ||
      form.ancillaryOverLimit ||
      !form.formData.name.trim() ||
      !form.formData.category.trim(),
    [
      readOnly,
      form.isSubmitting,
      form.ancillaryOverLimit,
      form.formData.name,
      form.formData.category,
    ],
  );

  // ---------------------------------------------------------------------
  // Wizard navigation
  //
  // We compute current/prev/next from the STEPS array. Disabled steps
  // (Scan History before the skill is saved) are skipped so the Next
  // button always lands somewhere meaningful.
  // ---------------------------------------------------------------------
  const isStepDisabled = useCallback(
    // Both Versions and Scan need a saved skill — they read
    // collections keyed off the persisted skill id. New (unsaved)
    // drafts hide both so the wizard footer's Next button always
    // lands somewhere meaningful.
    (id: SkillWorkspaceTabId) =>
      (id === "history" || id === "versions") && !existingConfig,
    [existingConfig],
  );
  const visibleSteps = useMemo(
    () => STEPS.filter((s) => !isStepDisabled(s.id)),
    [isStepDisabled],
  );
  const currentIndex = useMemo(() => {
    const i = visibleSteps.findIndex((s) => s.id === tab);
    return i === -1 ? 0 : i;
  }, [visibleSteps, tab]);
  const prevStep = currentIndex > 0 ? visibleSteps[currentIndex - 1] : null;
  const nextStep =
    currentIndex < visibleSteps.length - 1
      ? visibleSteps[currentIndex + 1]
      : null;
  const isFinalStep = nextStep === null;
  const currentStepIsFullWidth =
    visibleSteps[currentIndex]?.fullWidth ?? false;

  // ---------------------------------------------------------------------
  // Save / Next gating — when AI Review is configured as `blocking` for
  // skill-md, both Save buttons (header + footer) and Next-from-files
  // must run the review first and only proceed when it passes. The hook
  // caches the last-passing hash so unmodified content doesn't re-trigger
  // an LLM call.
  // ---------------------------------------------------------------------
  const handleSave = useCallback(async () => {
    // Capture the freshly-run review result — `review.result` state lags by a
    // render after an inline `ensurePassedOrRun`, so the grade we stamp below
    // must come from the run we just awaited, not the stale closure value.
    let reviewResult = review.result;
    if (review.isBlocking) {
      const { passed, result } = await review.ensurePassedOrRun();
      reviewResult = result;
      if (!passed) {
        toast(
          buildBlockingMessage(
            review.config,
            result,
            "the Skill content step",
            "saving",
          ),
          "error",
        );
        return;
      }
    }
    // Stamp the latest in-memory review verdict onto the saved row so the
    // skills gallery can show a grade badge without re-running the LLM.
    const lastReview = buildLastReview(reviewResult, "skill-md");
    await form.handleSubmit(
      lastReview ? { last_review: lastReview } : undefined,
    );
  }, [review, form, toast]);

  const handleNext = useCallback(async () => {
    // Only the Files step is gated by skill-md review; advancing from
    // any other step is unconditional. We still gate Save from any step
    // (see `handleSave`) so the user can't sidestep the review by
    // jumping back and clicking Save.
    if (tab === "files" && review.isBlocking) {
      const { passed, result } = await review.ensurePassedOrRun();
      if (!passed) {
        toast(
          buildBlockingMessage(
            review.config,
            result,
            "the comments",
            "continuing",
          ),
          "error",
        );
        return;
      }
    }
    if (nextStep) setTab(nextStep.id);
  }, [tab, review, toast, nextStep]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <header
        className="shrink-0 border-b border-border/60 bg-background/80 backdrop-blur"
        data-testid="skill-workspace-header"
      >
        <div className="flex flex-wrap items-center gap-2 px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {backLabel}
          </Button>
          <div className="h-5 w-px bg-border/60" />

          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold truncate max-w-[320px]">
              {form.formData.name || (
                <span className="text-muted-foreground">Untitled skill</span>
              )}
            </span>
            {readOnly && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Eye className="h-3 w-3" />
                Read-only
              </Badge>
            )}
            {existingConfig && (
              <SkillScanStatusIndicator config={existingConfig} />
            )}
            {form.isDirty && !readOnly && (
              <Badge variant="secondary" className="text-[10px]">
                Unsaved changes
              </Badge>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {existingConfig && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleExport()}
                disabled={isExporting}
                className="gap-1.5"
                title="Download SKILL.md + ancillary files as a ZIP"
                data-testid="skill-workspace-export"
              >
                {isExporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {isExporting ? "Exporting…" : "Export"}
              </Button>
            )}
            {showCloneCta && (
              <Button
                size="sm"
                variant="default"
                onClick={() => void handleClone()}
                disabled={isCloning}
                className="gap-1.5"
                title="Built-in skills are read-only. Clone produces an editable copy you own."
                data-testid="skill-workspace-clone"
              >
                {isCloning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {isCloning ? "Cloning…" : "Clone to edit"}
              </Button>
            )}
            {/* When the built-in lock is active we hide the disabled
                Save altogether — the Clone CTA above is the actionable
                next step. Showing both a disabled Save *and* a Clone
                button doubled up the visual noise without adding
                signal. */}
            {!showCloneCta && (
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={submitDisabled}
                className="gap-1.5"
              >
                <Save className="h-3.5 w-3.5" />
                {form.isSubmitting
                  ? "Saving…"
                  : existingConfig
                    ? "Save"
                    : "Create skill"}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Compact wizard stepper.
          Earlier this lived in a tall card with a stacked
          "circle / icon+label / hint caption" treatment that ate
          ~120px of vertical real estate above the editor. The Files
          step (the most editor-heavy of the bunch) was getting
          squeezed below the fold on 13" laptops as a result.
          The stepper is now a single 36-px row: number bubble +
          icon + label inline, hairline connectors between steps. The
          per-step hint moved into the trigger's `title` attribute
          (browser tooltip on hover) and the wizard footer keeps the
          authoritative "Step N of M" indicator, so we removed the
          duplicate caption that used to sit below the stepper. */}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as SkillWorkspaceTabId)}
        className="flex flex-1 min-h-0 flex-col"
      >
        <div className="shrink-0 border-b border-border/40 bg-muted/10 px-4 py-2">
          <TabsList
            className="mx-auto flex h-auto w-full max-w-3xl items-center justify-between gap-0 bg-transparent p-0"
            aria-label="Skill builder steps"
            indicator="none"
          >
            {STEPS.map((s, idx) => {
              const Icon = s.icon;
              const disabled = isStepDisabled(s.id);
              const stepNumber = idx + 1;
              const isActive = tab === s.id;
              const isComplete = idx < currentIndex && !disabled;
              const isLast = idx === STEPS.length - 1;
              return (
                <React.Fragment key={s.id}>
                  <TabsTrigger
                    value={s.id}
                    disabled={disabled}
                    className={cn(
                      "group flex flex-row items-center gap-2 rounded-md bg-transparent px-2 py-1 text-xs",
                      "h-auto data-[state=active]:bg-transparent data-[state=active]:shadow-none",
                      "disabled:opacity-50",
                    )}
                    data-testid={`skill-workspace-step-${s.id}`}
                    title={`${s.label} — ${s.hint}`}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors",
                        isActive
                          ? "border-primary bg-primary text-primary-foreground"
                          : isComplete
                            ? "border-primary/60 bg-primary/15 text-primary"
                            : "border-border bg-background text-muted-foreground",
                      )}
                    >
                      {stepNumber}
                    </span>
                    <span
                      className={cn(
                        "hidden sm:inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap",
                        isActive
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <Icon className="h-3 w-3 shrink-0" />
                      {s.label}
                    </span>
                  </TabsTrigger>
                  {!isLast && (
                    <span
                      aria-hidden
                      className={cn(
                        "h-px flex-1 transition-colors",
                        idx < currentIndex
                          ? "bg-primary/40"
                          : "bg-border/60",
                      )}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </TabsList>
        </div>

        {/* Step content. Editor-heavy steps (Files, Scan skill) take the
            full viewport width with tight padding so the editor / scan
            results take precedence; short forms keep a comfortable
            reading column with breathing room so they don't sprawl
            across a 27-inch monitor. */}
        <div className="flex-1 min-h-0 overflow-auto">
          <div
            className={cn(
              "h-full",
              currentStepIsFullWidth
                ? "w-full px-3 py-2"
                : "mx-auto w-full max-w-3xl px-4 py-6",
            )}
          >
            <TabsContent value="overview" className="mt-0 outline-none">
              <OverviewTab form={form} />
            </TabsContent>
            <TabsContent value="files" className="mt-0 h-full outline-none">
              <FilesTab form={form} readOnly={readOnly} review={review} />
            </TabsContent>
            <TabsContent value="tools" className="mt-0 outline-none">
              <ToolsTab form={form} />
            </TabsContent>
            <TabsContent value="versions" className="mt-0 outline-none">
              {skillIdForHistory ? (
                <VersionsTab
                  skillId={skillIdForHistory}
                  skillName={existingConfig?.name}
                  canRestore={!readOnly}
                  onRestored={() => {
                    // After a restore the live skill content has
                    // diverged from whatever the form is holding;
                    // the simplest correct UX is a hard refresh of
                    // the workspace page so `existingConfig` is
                    // re-fetched from the server.
                    if (typeof window !== "undefined") {
                      window.location.reload();
                    }
                  }}
                />
              ) : (
                <EmptyTabState text="Save the skill first — version history starts at the first save." />
              )}
            </TabsContent>
            <TabsContent value="history" className="mt-0 outline-none">
              {skillIdForHistory ? (
                <ScanTab
                  skillId={skillIdForHistory}
                  skillName={existingConfig?.name}
                />
              ) : (
                <EmptyTabState text="Save the skill first — scanning runs against the persisted SKILL.md." />
              )}
            </TabsContent>
          </div>
        </div>

        {/* Sticky wizard footer — Previous / Next navigation. The Next
            button on the final step turns into Save so users have a
            single, obvious "you're done — submit" action. */}
        <footer
          className="shrink-0 border-t border-border/60 bg-background/80 backdrop-blur"
          data-testid="skill-workspace-step-footer"
        >
          <div
            className={cn(
              "flex items-center justify-between gap-2 px-4 py-2",
              currentStepIsFullWidth ? "w-full" : "mx-auto w-full max-w-3xl",
            )}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => prevStep && setTab(prevStep.id)}
              disabled={!prevStep}
              className="gap-1.5"
              data-testid="skill-workspace-step-prev"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {prevStep ? `Previous: ${prevStep.label}` : "Previous"}
            </Button>

            <div className="text-[11px] text-muted-foreground">
              Step {currentIndex + 1} of {visibleSteps.length}
            </div>

            {isFinalStep ? (
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={submitDisabled}
                className="gap-1.5"
                data-testid="skill-workspace-step-save"
              >
                <Save className="h-3.5 w-3.5" />
                {form.isSubmitting
                  ? "Saving…"
                  : existingConfig
                    ? "Save skill"
                    : "Create skill"}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void handleNext()}
                className="gap-1.5"
                data-testid="skill-workspace-step-next"
              >
                Next: {nextStep!.label}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </footer>
      </Tabs>

      {/* Discard-confirmation dialog (driven by the form hook + the
          global unsaved-changes store). Used by ALL exit paths: Back
          button, application-navigation links, and any future
          programmatic navigation that calls `requestNavigation`. */}
      <Dialog
        open={form.showDiscardConfirm}
        onOpenChange={(o) => {
          if (!o) cancelDiscardAndKeep();
        }}
      >
        <DialogContent data-testid="skill-workspace-discard-dialog">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have unsaved edits to this skill. Leaving now will
              discard them. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelDiscardAndKeep}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDiscardAndNavigate}
              data-testid="skill-workspace-discard-confirm"
            >
              Discard & leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyTabState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
