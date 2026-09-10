"use client";

import { getErrorMessage } from "@/lib/error-utils";
import type { Extension } from "@codemirror/state";

import {
  AiReviewButton,
  AiReviewPanel,
  buildBlockingMessage,
  buildLastReview,
  useAiReview,
} from "@/components/ai-review";
import { TeamOwnershipFields } from "@/components/rbac/TeamOwnershipFields";
import { UnsavedChangesDialog } from "@/components/shared/UnsavedChangesDialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/ui/model-picker";
import { type TeamPickerOption } from "@/components/ui/team-picker";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useEditorDirtyTracking } from "@/hooks/use-editor-dirty-tracking";
import { gradientThemes } from "@/lib/gradient-themes";
import { getMarkdownComponents } from "@/lib/markdown-components";
import { cn } from "@/lib/utils";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type {
  AgentUIConfig,
  BuiltinToolsConfig,
  CustomThemeConfig,
  DynamicAgentConfig,
  DynamicAgentConfigCreate,
  DynamicAgentConfigUpdate,
  FeaturesConfig,
  InterruptOn,
  SubAgentRef,
  VisibilityType,
} from "@/types/dynamic-agent";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Globe,
  GripHorizontal,
  Loader2,
  Pencil,
  Sparkles,
  Users,
} from "lucide-react";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentAvatar } from "./AgentAvatar";
import { AllowedToolsPicker } from "./AllowedToolsPicker";
import { BuiltinToolsPicker } from "./BuiltinToolsPicker";
import { DatasourcePicker } from "./DatasourcePicker";
import { InterruptConfigPicker } from "./InterruptConfigPicker";
import { MiddlewarePicker } from "./MiddlewarePicker";
import { SkillsSelector } from "./SkillsSelector";
import { SubagentPicker } from "./SubagentPicker";
import { WorkflowToolsPicker } from "./WorkflowToolsPicker";
import type { AgentSetupStep } from "./deep-linking";

// Lazy-load CodeMirror to avoid SSR issues
const CodeMirrorEditor = React.lazy(() => import("@uiw/react-codemirror"));

interface DynamicAgentEditorProps {
  agent: DynamicAgentConfig | null; // null = creating new
  cloneFrom?: DynamicAgentConfig | null; // Agent to clone from (for pre-filling)
  readOnly?: boolean; // true for view-only mode
  readOnlyReason?: "config" | "permissions"; // why readOnly is true
  initialStep?: AgentSetupStep;
  onStepChange?: (step: AgentSetupStep) => void;
  onSave: () => void;
  onCancel: () => void;
}
/**
 * Generate a URL-safe slug from an agent name with agent- prefix.
 * e.g., "Knowledge Agent" -> "agent-knowledge-agent"
 */
function generateSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special characters
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
  return slug ? `agent-${slug}` : "";
}

function hasRagToolAccess(
  allowedTools: Record<string, string[] | boolean>,
): boolean {
  const selection = allowedTools["knowledge-base"];
  return selection !== undefined && selection !== false;
}

function normalizeKnowledgeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && Boolean(item.trim()),
  );
}

// Visibility picker — `private` was retired on 2026-05-22 (see
// `docs/docs/changes/2026-05-22-remove-private-agents.md` and the
// `VisibilityType` definition in `@/types/dynamic-agent`). Every dynamic
// agent is now team-owned; users who want a truly personal agent should
// create a single-member team and own the agent through that team.
const VISIBILITY_OPTIONS: {
  value: VisibilityType;
  label: string;
  icon: React.ReactNode;
  description: string;
}[] = [
  {
    value: "team",
    label: "Team",
    icon: <Users className="h-4 w-4" />,
    description:
      "Team members can use; you manage as creator; team admins can manage. Optionally share with other teams.",
  },
  {
    value: "global",
    label: "Global",
    icon: <Globe className="h-4 w-4" />,
    description: "Available to all users; owner-team admins manage it.",
  },
];

interface TeamOption {
  _id: string;
  name: string;
  slug?: string;
  description?: string;
  user_role?: string | null;
  can_own_agents?: boolean;
}

// Step definitions for the wizard
const STEPS = [
  {
    id: "basic" as const,
    label: "Basic Info",
    hint: "Define your agent's identity and access level",
  },
  {
    id: "instructions" as const,
    label: "Instructions",
    hint: "Configure how your agent behaves",
  },
  {
    id: "tools" as const,
    label: "Tools",
    hint: "Select which tools your agent can use",
  },
  {
    id: "knowledge" as const,
    label: "Knowledge",
    hint: "Choose the collections and datasources this agent can search",
  },
  {
    id: "skills" as const,
    label: "Skills",
    hint: "Attach skills that guide your agent's behavior (optional)",
  },
  {
    id: "advanced" as const,
    label: "Advanced",
    hint: "Subagents, approval rules, and middleware",
  },
];

type StepId = AgentSetupStep;

/**
 * Horizontal step indicator component
 */
function StepIndicator({
  steps,
  currentStep,
  onStepClick,
}: {
  steps: typeof STEPS;
  currentStep: StepId;
  onStepClick: (stepId: StepId) => void;
}) {
  return (
    <div className="flex items-center gap-0 ml-auto">
      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          {index > 0 && <div className="w-5 h-0.5 bg-border mx-0.5" />}
          <button
            type="button"
            onClick={() => onStepClick(step.id)}
            className={cn(
              "flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-md transition-colors min-w-[64px]",
              currentStep === step.id
                ? "bg-primary/10 text-primary"
                : "hover:bg-muted text-muted-foreground",
            )}
          >
            <div
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium",
                currentStep === step.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted",
              )}
            >
              {index + 1}
            </div>
            <span className="text-xs font-medium">{step.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * Collapsible sub-section used in the Advanced step.
 */
function CollapsibleSection({
  title,
  description,
  badge,
  defaultExpanded = false,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);

  return (
    <div className="border rounded-lg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors rounded-lg"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1">
          <span className="text-sm font-semibold">{title}</span>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {badge && (
          <span className="text-xs text-muted-foreground font-medium">
            {badge}
          </span>
        )}
      </button>
      {expanded && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}

/**
 * Advanced step: collapsible sub-sections for subagents, interrupts, middleware.
 */
function AdvancedStep({
  agent,
  subagents,
  setSubagents,
  interruptOn,
  setInterruptOn,
  allowedTools,
  builtinTools,
  setBuiltinTools,
  features,
  setFeatures,
  availableModels,
  setMiddlewareError,
  loading,
  visibility,
}: {
  agent: DynamicAgentConfig | null;
  subagents: SubAgentRef[];
  setSubagents: (v: SubAgentRef[]) => void;
  interruptOn: InterruptOn;
  setInterruptOn: (v: InterruptOn) => void;
  allowedTools: Record<string, string[] | boolean>;
  builtinTools?: BuiltinToolsConfig;
  setBuiltinTools: (v: BuiltinToolsConfig) => void;
  features: FeaturesConfig | undefined;
  setFeatures: (v: FeaturesConfig | undefined) => void;
  availableModels: { model_id: string; name: string; provider: string }[];
  setMiddlewareError: (v: boolean) => void;
  loading: boolean;
  visibility: VisibilityType;
}) {
  const interruptRuleCount = Object.values(interruptOn).reduce(
    (sum, tools) => sum + Object.keys(tools).length,
    0,
  );
  const workflowCount = builtinTools?.workflows?.length ?? 0;

  return (
    <div className="space-y-4 pt-2">
      <CollapsibleSection
        title="Subagents"
        description="Delegate tasks to other custom agents"
        badge={`${subagents.length} subagent${subagents.length !== 1 ? "s" : ""}`}
        defaultExpanded={false}
      >
        <p className="text-xs text-muted-foreground mb-2">
          <span className="font-medium">Note:</span> Subagents cannot be nested.
          The agents you add here will not have access to their own subagents
          when invoked.
        </p>
        <SubagentPicker
          agentId={agent?._id || null}
          value={subagents}
          onChange={setSubagents}
          disabled={loading}
          parentVisibility={visibility}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Human Approval"
        description="Require approval before executing specific tools"
        badge={`${interruptRuleCount} rule${interruptRuleCount !== 1 ? "s" : ""}`}
        defaultExpanded={false}
      >
        <InterruptConfigPicker
          value={interruptOn}
          onChange={setInterruptOn}
          allowedTools={allowedTools}
          builtinTools={builtinTools}
          disabled={loading}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Middleware"
        description="Retries, limits, and preprocessing"
      >
        <MiddlewarePicker
          value={features}
          onChange={setFeatures}
          disabled={loading}
          availableModels={availableModels}
          onError={setMiddlewareError}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Workflows"
        description="Allow this agent to trigger and monitor workflows"
        badge={`${workflowCount} workflow${workflowCount !== 1 ? "s" : ""}`}
        defaultExpanded={false}
      >
        <WorkflowToolsPicker
          value={builtinTools?.workflows ?? []}
          onChange={(ids) => {
            setBuiltinTools({
              ...builtinTools,
              workflows: ids.length > 0 ? ids : undefined,
            } as BuiltinToolsConfig);
          }}
          disabled={loading}
        />
      </CollapsibleSection>
    </div>
  );
}

export function DynamicAgentEditor({
  agent,
  cloneFrom,
  readOnly,
  readOnlyReason,
  initialStep = "basic",
  onStepChange,
  onSave,
  onCancel,
}: DynamicAgentEditorProps) {
  const isEditing = !!agent;
  const isCloning = !!cloneFrom;
  const { toast } = useToast();

  // Source for initial values: editing agent > cloning source > empty defaults
  const source = agent || cloneFrom;

  // Form state - when cloning, append " (New)" to name
  const [name, setName] = React.useState(
    isCloning && source ? `${source.name} (New)` : source?.name || "",
  );
  const [description, setDescription] = React.useState(
    source?.description || "",
  );
  const [systemPrompt, setSystemPrompt] = React.useState(
    source?.system_prompt || "",
  );
  // Default to `team` for new agents — every agent must have an owner
  // team, and team-scoped sharing is the safest default. `private` is
  // retired (see `VisibilityType` in `@/types/dynamic-agent`); legacy
  // docs that still carry `visibility: 'private'` on the wire are coerced
  // to `team` here so the picker has a matching tile to highlight. The
  // BFF-side `coerceAgentVisibilityOnRead` helper does the same on read,
  // but we coerce defensively in the UI in case a stale GET response
  // slips through before that helper is wired into every route.
  const [visibility, setVisibility] = React.useState<VisibilityType>(() => {
    const raw = source?.visibility as VisibilityType | "private" | undefined;
    if (raw === "team" || raw === "global") return raw;
    return "team";
  });
  const [sharedWithTeams, setSharedWithTeams] = React.useState<string[]>(
    source?.shared_with_teams || [],
  );
  const [ownerTeamSlug, setOwnerTeamSlug] = React.useState(
    source?.owner_team_slug || "",
  );
  // Ownership transfer (spec 2026-06-03, US3). On edit, changing the owner
  // picker marks a pending transfer so the PUT can send owner_team_slug +
  // confirm_not_member.
  const [transferRequested, setTransferRequested] = React.useState(false);
  const [transferConfirmedNotMember, setTransferConfirmedNotMember] =
    React.useState(false);
  // When the server rejects a transfer with TRANSFER_NOT_MEMBER_UNCONFIRMED
  // (the caller is not a member of the destination team per OpenFGA, even
  // though the client-side picker showed it — e.g. an org admin who is not a
  // literal team member), surface an inline "Confirm Transfer" affordance
  // instead of a dead-end error so the user can explicitly proceed.
  const [transferNeedsServerConfirm, setTransferNeedsServerConfirm] =
    React.useState(false);
  const [allowedTools, setAllowedTools] = React.useState<
    Record<string, string[] | boolean>
  >(source?.allowed_tools || {});
  const [builtinTools, setBuiltinTools] = React.useState<
    BuiltinToolsConfig | undefined
  >(source?.builtin_tools);
  const [subagents, setSubagents] = React.useState<SubAgentRef[]>(
    source?.subagents || [],
  );
  const [skills, setSkills] = React.useState<string[]>(source?.skills || []);
  const [datasourceIds, setDatasourceIds] = React.useState<string[]>(() =>
    normalizeKnowledgeIds(source?.datasource_ids),
  );
  const [ragCollectionIds, setRagCollectionIds] = React.useState<string[]>(() =>
    normalizeKnowledgeIds(source?.rag_collection_ids),
  );
  const [features, setFeatures] = React.useState<FeaturesConfig | undefined>(
    source?.features,
  );
  const [interruptOn, setInterruptOn] = React.useState<InterruptOn>(
    source?.interrupt_on || { builtin: { request_user_input: true } },
  );
  const [modelId, setModelId] = React.useState(source?.model?.id || "");
  const [modelProvider, setModelProvider] = React.useState(
    source?.model?.provider || "",
  );
  const [gradientTheme, setGradientTheme] = React.useState<string>(
    source?.ui?.gradient_theme || "default",
  );
  const [customThemeConfig, setCustomThemeConfig] =
    React.useState<CustomThemeConfig>(
      source?.ui?.custom_theme_config || {
        gradient_from: "#6366f1",
        gradient_to: "#1e1b4b",
        accent_color: "#ffffff",
      },
    );
  const [showCustomPicker, setShowCustomPicker] = React.useState(false);

  // Sync request_user_input interrupt rule with builtin tool enabled state
  const hasRequestUserInputInterrupt =
    !!interruptOn?.builtin?.request_user_input;
  React.useEffect(() => {
    const cfg = (
      builtinTools as Record<string, { enabled?: boolean } | undefined>
    )?.["request_user_input"];
    const isEnabled = !!(cfg && cfg.enabled);
    const hasRule = hasRequestUserInputInterrupt;

    if (isEnabled && !hasRule) {
      // Tool enabled — add the rule
      setInterruptOn((prev) => ({
        ...prev,
        builtin: { ...prev.builtin, request_user_input: true },
      }));
    } else if (!isEnabled && hasRule) {
      // Tool disabled — remove the rule
      setInterruptOn((prev) => {
        const next = { ...prev };
        if (next.builtin) {
          const rest = { ...next.builtin };
          delete rest.request_user_input;
          if (Object.keys(rest).length === 0) {
            delete next.builtin;
          } else {
            next.builtin = rest;
          }
        }
        return next;
      });
    }
  }, [builtinTools, hasRequestUserInputInterrupt]);

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Blocking-review message, kept separate from `error` so it only renders on
  // the Instructions step and can auto-clear the moment the review passes.
  const [blockingMessage, setBlockingMessage] = React.useState<string | null>(
    null,
  );
  const [, setMiddlewareError] = React.useState(false);
  const [availableModels, setAvailableModels] = React.useState<
    { model_id: string; name: string; provider: string; description: string }[]
  >([]);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [availableTeams, setAvailableTeams] = React.useState<TeamOption[]>([]);

  // AI suggestion state
  const [generatingField, setGeneratingField] = React.useState<string | null>(
    null,
  );
  const [promptTab, setPromptTab] = React.useState<"edit" | "preview">("edit");
  const [editorHeight, setEditorHeight] = React.useState(480);
  const dragRef = React.useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const [showSuggestPromptInput, setShowSuggestPromptInput] =
    React.useState(false);
  const [suggestPromptInstruction, setSuggestPromptInstruction] =
    React.useState("");
  const [showSuggestBasicInput, setShowSuggestBasicInput] =
    React.useState(false);
  const [suggestBasicInstruction, setSuggestBasicInstruction] =
    React.useState("");
  const [enhanceExisting, setEnhanceExisting] = React.useState(false);
  const [enhanceExistingBasic, setEnhanceExistingBasic] = React.useState(false);
  const [promptStyle, setPromptStyle] = React.useState<
    "concise" | "comprehensive"
  >("concise");

  // AI Review hook for the system prompt (Instructions step). The hook is a no-op
  // when `/api/review-configs/agent-system-prompt` is not configured / disabled —
  // both the button and panel render null in that case.
  const review = useAiReview({
    target: "agent-system-prompt",
    content: systemPrompt,
    context: {
      name,
      agent_description: description,
      extra_context: undefined,
    },
    onApplyFix: setSystemPrompt,
  });

  // Clear the blocking-review banner once the review passes — including a
  // re-run triggered from the panel (apply-all-fixes → run again), not just a
  // Next/Save click.
  React.useEffect(() => {
    if (review.isPassed) setBlockingMessage(null);
  }, [review.isPassed]);

  // Editor resize drag handlers
  const handleDragStart = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: editorHeight };

      const handleDragMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = ev.clientY - dragRef.current.startY;
        const newHeight = Math.max(
          200,
          Math.min(
            window.innerHeight * 0.85,
            dragRef.current.startHeight + delta,
          ),
        );
        setEditorHeight(newHeight);
      };

      const handleDragEnd = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleDragMove);
        document.removeEventListener("mouseup", handleDragEnd);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleDragMove);
      document.addEventListener("mouseup", handleDragEnd);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [editorHeight],
  );

  // CodeMirror extensions for markdown syntax highlighting
  const [cmExtensions, setCmExtensions] = React.useState<Extension[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("@codemirror/lang-markdown"),
      import("@codemirror/language-data"),
      import("@codemirror/view"),
      import("@/lib/codemirror/jinja2-highlight"),
      import("@/lib/codemirror/markdown-highlight"),
    ]).then(([mdMod, langDataMod, viewMod, jinja2Mod, mdHighlightMod]) => {
      if (!cancelled) {
        setCmExtensions([
          mdMod.markdown({ codeLanguages: langDataMod.languages }),
          viewMod.EditorView.lineWrapping,
          mdHighlightMod.markdownHighlight,
          jinja2Mod.jinja2Highlight,
        ]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ID generation and validation
  const generatedId = React.useMemo(() => generateSlug(name), [name]);
  const [existingIds, setExistingIds] = React.useState<Set<string>>(new Set());

  // Check if the generated ID clashes with existing agents
  const idClash = React.useMemo(() => {
    if (isEditing) return false; // When editing, ID doesn't change
    if (!generatedId) return false;
    return existingIds.has(generatedId);
  }, [isEditing, generatedId, existingIds]);

  // Fetch existing agent IDs for clash detection
  React.useEffect(() => {
    if (isEditing) return; // No need to check when editing

    async function fetchExistingIds() {
      try {
        const response = await fetch("/api/dynamic-agents");
        const data = await response.json();
        // API returns paginated response: {success, data: {items: [...], ...}}
        if (
          data.success &&
          data.data?.items &&
          Array.isArray(data.data.items)
        ) {
          const ids = new Set<string>(
            data.data.items.map((a: DynamicAgentConfig) => a._id),
          );
          setExistingIds(ids);
        }
      } catch (err) {
        console.error("Failed to fetch existing agent IDs:", err);
      }
    }
    fetchExistingIds();
  }, [isEditing]);

  // Fetch available models on mount
  React.useEffect(() => {
    async function fetchModels() {
      setModelsLoading(true);
      try {
        const response = await fetch("/api/dynamic-agents/models");
        const data = await response.json();
        if (data.success && Array.isArray(data.data)) {
          setAvailableModels(data.data);

          if (source?.model?.id) {
            // Editing or cloning existing agent - verify model exists using both model AND provider
            // (same model can exist for different providers, e.g., gpt-4o for openai and azure-openai)
            const existingModel = data.data.find(
              (m: { model_id: string; provider: string }) =>
                m.model_id === source.model.id &&
                m.provider === source.model.provider,
            );
            if (existingModel) {
              // Model exists - ensure provider is in sync with config
              setModelProvider(existingModel.provider);
            } else {
              // Model no longer available - reset to first available
              console.warn(
                `Agent model "${source.model.id}" no longer available, resetting to default`,
              );
              if (data.data.length > 0) {
                setModelId(data.data[0].model_id);
                setModelProvider(data.data[0].provider);
              }
            }
          } else if (data.data.length > 0) {
            // Creating new agent - default to first model
            setModelId(data.data[0].model_id);
            setModelProvider(data.data[0].provider);
          }
        }
      } catch (err) {
        console.error("Failed to fetch models:", err);
      } finally {
        setModelsLoading(false);
        // Flip the snapshot sentinel after models load. This causes the dirty
        // tracker to re-snapshot WITH the freshly applied default model, so a
        // newly opened editor doesn't immediately appear dirty.
        setModelDefaultsApplied(true);
      }
    }
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount - agent prop is stable

  // Fetch available teams for team visibility sharing
  React.useEffect(() => {
    async function fetchTeams() {
      try {
        const response = await fetch("/api/dynamic-agents/teams");
        const data = await response.json();
        if (data.success && Array.isArray(data.data)) {
          setAvailableTeams(data.data);
        }
      } catch (err) {
        console.error("Failed to fetch teams:", err);
      }
    }
    fetchTeams();
  }, []);

  // When editing an existing agent, find out if it is the platform default.
  // If it is, lock the visibility selector so the admin can't accidentally
  // demote `global → team` from here — the BFF would reject the request
  // with 409 / AGENT_IS_PLATFORM_DEFAULT anyway, so we surface that
  // constraint up front. The platform-config endpoint is readable by any
  // signed-in user (it's how the Slack bot resolves the DM default), so
  // this works for editors who aren't admins too.
  const [isPlatformDefault, setIsPlatformDefault] = React.useState(false);
  React.useEffect(() => {
    if (!agent?._id) return;
    let cancelled = false;
    async function checkDefault() {
      try {
        const response = await fetch("/api/admin/platform-config");
        const data = await response.json();
        if (cancelled) return;
        if (data.success && data.data?.default_agent_id === agent?._id) {
          setIsPlatformDefault(true);
        }
      } catch {
        // Non-fatal: the BFF will still enforce the invariant on save.
      }
    }
    checkDefault();
    return () => {
      cancelled = true;
    };
  }, [agent?._id]);

  // Step wizard state
  const [activeStep, setActiveStep] = React.useState<StepId>(initialStep);

  React.useEffect(() => {
    setActiveStep(initialStep);
  }, [initialStep]);

  const selectStep = React.useCallback(
    (step: StepId) => {
      setActiveStep(step);
      onStepChange?.(step);
    },
    [onStepChange],
  );

  // Local state for the in-app "you have unsaved changes" confirmation when the
  // user clicks the back arrow. We don't route this through the global store's
  // pendingNavigationHref because closing the editor isn't an href navigation —
  // it's a parent-state flip controlled by the onCancel prop.
  const [pendingClose, setPendingClose] = React.useState(false);

  // Snapshot sentinel: flips once after the async models endpoint resolves and
  // applies a default modelId/modelProvider to a previously empty form. This
  // ensures the dirty-tracking snapshot is taken AFTER defaults are applied,
  // preventing a false "dirty" right after model defaults populate.
  const [modelDefaultsApplied, setModelDefaultsApplied] = React.useState(
    !!source?.model?.id,
  );

  // Aggregate all editable form fields into a single object so the
  // dirty-tracking hook can compare current vs initial values.
  const currentFormValues = React.useMemo(
    () => ({
      name,
      description,
      systemPrompt,
      visibility,
      sharedWithTeams,
      ownerTeamSlug,
      allowedTools,
      builtinTools,
      subagents,
      skills,
      datasourceIds,
      ragCollectionIds,
      features,
      modelId,
      modelProvider,
      gradientTheme,
    }),
    [
      name,
      description,
      systemPrompt,
      visibility,
      sharedWithTeams,
      ownerTeamSlug,
      allowedTools,
      builtinTools,
      subagents,
      skills,
      datasourceIds,
      ragCollectionIds,
      features,
      modelId,
      modelProvider,
      gradientTheme,
    ],
  );

  // The snapshot key combines the source identity with the model-defaults
  // sentinel. When either changes, the dirty hook re-snapshots so the form
  // appears clean.
  const snapshotIdentity = agent?._id ?? cloneFrom?._id ?? "new";
  const snapshotKey = `${snapshotIdentity}|${modelDefaultsApplied ? "1" : "0"}`;

  const { dirty, resetSnapshot } = useEditorDirtyTracking({
    enabled: !readOnly,
    currentValues: currentFormValues,
    snapshotKey,
  });
  const currentStepIndex = STEPS.findIndex((s) => s.id === activeStep);
  const currentStepConfig = STEPS.find((s) => s.id === activeStep);

  const goToPreviousStep = () => {
    if (currentStepIndex > 0) {
      selectStep(STEPS[currentStepIndex - 1].id);
    }
  };

  const goToNextStep = async () => {
    // Gate the instructions → tools transition behind a passing AI Review when
    // the admin has flagged this target as "blocking". `ensurePassedOrRun` is a
    // no-op when the config is disabled or informational.
    if (activeStep === "instructions" && review.isBlocking) {
      const { passed, result } = await review.ensurePassedOrRun();
      if (!passed) {
        const message = buildBlockingMessage(
          review.config,
          result,
          "the comments below",
          "continuing",
        );
        // The banner below carries the message — visible even when the footer
        // is below the fold.
        setBlockingMessage(message);
        return;
      }
      // Review passed — clear any stale blocking banner from a prior attempt.
      setBlockingMessage(null);
    }
    if (currentStepIndex < STEPS.length - 1) {
      selectStep(STEPS[currentStepIndex + 1].id);
    }
  };

  /**
   * Call the AI suggest endpoint for a given field.
   * Accepts an optional instruction string for guidance.
   */
  const handleSuggest = async (
    field: "description" | "system_prompt" | "theme",
    instruction?: string,
  ) => {
    if (!name.trim() || !modelId) return;

    setGeneratingField(field);
    try {
      const response = await fetch("/api/dynamic-agents/assistant/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field,
          context: {
            name,
            description: description || undefined,
            system_prompt: systemPrompt || undefined,
            allowed_tools:
              Object.keys(allowedTools).length > 0 ? allowedTools : undefined,
            builtin_tools: builtinTools,
            subagents:
              subagents.length > 0
                ? subagents.map((s) => ({
                    agent_id: s.agent_id,
                    name: s.name || s.agent_id,
                    description: s.description,
                  }))
                : undefined,
          },
          model: { id: modelId, provider: modelProvider },
          ...(instruction ? { instruction } : {}),
          ...(field === "system_prompt" ? { prompt_style: promptStyle } : {}),
        }),
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to generate suggestion");
      }

      const content = (data.data?.content ?? "").trim();
      if (!content) {
        throw new Error("Empty response from AI");
      }

      switch (field) {
        case "description":
          setDescription(content);
          break;
        case "system_prompt":
          setSystemPrompt(content);
          // Switch to preview tab so user sees the rendered result
          setPromptTab("preview");
          break;
        case "theme": {
          // Check for custom theme response: "custom:#hex1,#hex2,#hex3"
          const customMatch = content.match(
            /custom:\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})/,
          );
          if (customMatch) {
            setGradientTheme("custom");
            setCustomThemeConfig({
              gradient_from: customMatch[1],
              gradient_to: customMatch[2],
              accent_color: customMatch[3],
            });
            setShowCustomPicker(true);
            break;
          }
          // Try exact match first (after normalization)
          const normalized = content.toLowerCase().replace(/[^a-z_]/g, "");
          const exactMatch = gradientThemes.find((t) => t.id === normalized);
          if (exactMatch) {
            setGradientTheme(exactMatch.id);
          } else {
            // Fuzzy: find any valid theme ID contained in the response
            const fuzzyMatch = gradientThemes.find((t) =>
              content.toLowerCase().includes(t.id),
            );
            if (fuzzyMatch) {
              setGradientTheme(fuzzyMatch.id);
            } else {
              console.warn(`AI suggested unknown theme "${content}", ignoring`);
              toast("Could not determine theme from AI response", "error");
            }
          }
          break;
        }
      }
    } catch (err) {
      console.error(`AI suggest (${field}) failed:`, err);
      toast(
        getErrorMessage(err, "") || "Failed to generate suggestion",
        "error",
      );
    } finally {
      setGeneratingField(null);
    }
  };

  /**
   * Combined handler for Step 1: generates both description and theme in parallel.
   */
  const handleSuggestBasicInfo = async (instruction?: string) => {
    if (!name.trim() || !modelId) return;
    setShowSuggestBasicInput(false);
    setSuggestBasicInstruction("");
    // If enhancing existing description, pass it as context
    const existingHint =
      enhanceExistingBasic && description.trim()
        ? `The current description is: "${description}". Use it as a starting point and enhance/refine it.`
        : undefined;
    const fullInstruction = [existingHint, instruction]
      .filter(Boolean)
      .join("\n\n");
    setEnhanceExistingBasic(false);
    // Run both in parallel
    await Promise.all([
      handleSuggest("description", fullInstruction || undefined),
      handleSuggest("theme", instruction),
    ]);
  };

  /**
   * Handle system prompt suggestion via the popover.
   * If enhanceExisting is checked and content exists, pass it as context.
   */
  const handleSuggestSystemPrompt = (instruction?: string) => {
    setShowSuggestPromptInput(false);
    setSuggestPromptInstruction("");
    // If user wants to enhance existing content, pass it as context
    const existingHint =
      enhanceExisting && systemPrompt.trim()
        ? `The current system prompt is provided below — use it as a starting point and enhance/refine it based on the user's guidance.\n\n<current_prompt>\n${systemPrompt}\n</current_prompt>`
        : undefined;
    const fullInstruction = [existingHint, instruction]
      .filter(Boolean)
      .join("\n\n");
    setEnhanceExisting(false);
    handleSuggest("system_prompt", fullInstruction || undefined);
  };

  const canSuggest = name.trim() && modelId && !generatingField;
  const isGenerating = !!generatingField;

  const handleSubmit = async (
    e?: React.FormEvent,
    opts?: { forceConfirmNotMember?: boolean },
  ) => {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    setTransferNeedsServerConfirm(false);
    // `setState` is async, so a confirm-and-retry can't rely on the freshly-set
    // `transferConfirmedNotMember`; the caller passes the value through opts.
    const confirmNotMember =
      opts?.forceConfirmNotMember || transferConfirmedNotMember;

    // Gate save behind a passing AI Review when the admin has flagged this
    // target as "blocking". `ensurePassedOrRun` is a no-op when the config is
    // disabled or informational.
    // Capture the freshly-run review result so the grade we persist below
    // comes from the run we just awaited — `review.result` state lags by a
    // render after an inline `ensurePassedOrRun`, so reading it here would
    // stamp a stale (often null) grade onto the save.
    let reviewResult = review.result;
    if (review.isBlocking) {
      const { passed, result } = await review.ensurePassedOrRun();
      reviewResult = result;
      if (!passed) {
        const message = buildBlockingMessage(
          review.config,
          result,
          "the Instructions step",
          "saving",
        );
        // Return to the reviewed content so the user can see and act on the
        // inline comments; the banner below carries the message.
        selectStep("instructions");
        setBlockingMessage(message);
        setLoading(false);
        return;
      }
    }

    // Validate required fields
    if (!modelId || !modelProvider) {
      setError("Model selection is required");
      setLoading(false);
      return;
    }
    if (!isEditing && !ownerTeamSlug) {
      setError("Owner team is required");
      setLoading(false);
      return;
    }

    // Validate ID for new agents
    if (!isEditing) {
      if (!generatedId) {
        setError("Agent name is required to generate ID");
        setLoading(false);
        return;
      }
      if (idClash) {
        setError(
          `Agent ID "${generatedId}" already exists. Please use a different name.`,
        );
        setLoading(false);
        return;
      }
    }

    try {
      // Build UI config if gradient theme is set
      const uiConfig: AgentUIConfig | undefined = gradientTheme
        ? {
            gradient_theme: gradientTheme,
            ...(gradientTheme === "custom"
              ? { custom_theme_config: customThemeConfig }
              : {}),
          }
        : undefined;

      // Stamp the latest in-memory review verdict onto the saved row so the
      // list view can show a grade badge without re-running the LLM. Only
      // emit the field when we actually have a result this session — never
      // overwrite a prior `last_review` with null.
      const lastReview = buildLastReview(reviewResult, "agent-system-prompt");

      if (isEditing) {
        // Update existing agent
        const updateData: DynamicAgentConfigUpdate & {
          owner_team_slug?: string;
          confirm_not_member?: boolean;
        } = {
          name,
          description: description || undefined,
          system_prompt: systemPrompt,
          visibility,
          shared_with_teams:
            visibility === "team" ? sharedWithTeams : undefined,
          allowed_tools: allowedTools,
          builtin_tools: builtinTools,
          subagents: subagents.length > 0 ? subagents : undefined,
          skills,
          // Always send the array, even empty — `pickMutableFields` only
          // omits keys that are `undefined`, so sending `undefined` here
          // when the picker is cleared would leave the previously-saved
          // restriction in place instead of clearing it.
          datasource_ids: datasourceIds,
          rag_collection_ids: ragCollectionIds,
          model: { id: modelId, provider: modelProvider },
          ui: uiConfig,
          features: features,
          interrupt_on: interruptOn,
          // Ownership transfer (US3): only send owner_team_slug when the user
          // changed the owner picker, so a normal edit never trips the route's
          // transfer guard.
          ...(transferRequested
            ? {
                owner_team_slug: ownerTeamSlug,
                confirm_not_member: confirmNotMember,
              }
            : {}),
          ...(lastReview ? { last_review: lastReview } : {}),
        };

        const response = await fetch(`/api/dynamic-agents?id=${agent._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updateData),
        });

        const data = await response.json();
        if (!data.success) {
          // The destination team is one the caller can pick in the UI but is
          // not an OpenFGA member of (e.g. org admin). Offer an explicit
          // confirm-and-retry instead of a dead-end error.
          if (data.code === "TRANSFER_NOT_MEMBER_UNCONFIRMED") {
            const err = new Error(data.error || "Confirmation required");
            (err as { code?: string }).code = "TRANSFER_NOT_MEMBER_UNCONFIRMED";
            throw err;
          }
          throw new Error(data.error || "Failed to update agent");
        }
      } else {
        // Create new agent
        const createData: DynamicAgentConfigCreate = {
          id: generatedId,
          name,
          description: description || undefined,
          system_prompt: systemPrompt,
          visibility,
          owner_team_slug: ownerTeamSlug,
          shared_with_teams:
            visibility === "team" ? sharedWithTeams : undefined,
          allowed_tools: allowedTools,
          builtin_tools: builtinTools,
          subagents: subagents.length > 0 ? subagents : undefined,
          skills,
          // New agents follow the combined collection + datasource hand
          // exactly. Empty arrays keep RAG tools available with no indexed
          // content in scope.
          datasource_ids: datasourceIds,
          rag_collection_ids: ragCollectionIds,
          model: { id: modelId, provider: modelProvider },
          ui: uiConfig,
          features: features,
          interrupt_on: interruptOn,
          ...(lastReview ? { last_review: lastReview } : {}),
        };

        const response = await fetch("/api/dynamic-agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createData),
        });

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to create agent");
        }
      }

      // Clear unsaved-changes state BEFORE calling onSave(): the parent will
      // unmount this editor in response to onSave, and we want the global flag
      // to be false by the time any header/tab guards re-evaluate. resetSnapshot
      // also re-points the snapshot at the just-saved values so a follow-up
      // dirty check (in the unlikely case the editor stays mounted) is correct.
      resetSnapshot();
      useUnsavedChangesStore.getState().setUnsaved(false);

      onSave();
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "TRANSFER_NOT_MEMBER_UNCONFIRMED"
      ) {
        setTransferNeedsServerConfirm(true);
        setError(
          'You are not a member of the destination team. Click "Confirm Transfer" to transfer ownership anyway.',
        );
      } else {
        setError(getErrorMessage(err, "") || "An error occurred");
      }
    } finally {
      setLoading(false);
    }
  };

  // Each entry describes one reason the Create Agent / Save Changes button is
  // disabled. We render `blockers[0]` next to the button so the user always
  // sees WHY they can't submit and on which step to fix it — previously the
  // button just went `disabled` with no explanation, which the user reported
  // as confusing (especially the Owner Team case, where the picker sits on
  // the first wizard step but the button lives below step 5's content).
  //
  // assisted-by Cursor claude-opus-4-7
  const ownerTeamMissing = !isEditing && !ownerTeamSlug;

  const blockers: { field: string; label: string; step: StepId }[] =
    React.useMemo(() => {
      const list: { field: string; label: string; step: StepId }[] = [];
      if (!name.trim()) {
        list.push({ field: "name", label: "Agent name", step: "basic" });
      }
      if (availableModels.length === 0) {
        // Distinct from "model not picked" — the user can't pick anything
        // because nothing is configured. Surfacing this separately tells the
        // operator the problem is upstream (no providers configured).
        list.push({
          field: "modelAvailability",
          label: "At least one model provider must be configured",
          step: "basic",
        });
      } else if (!modelId) {
        list.push({ field: "model", label: "Model", step: "basic" });
      }
      if (ownerTeamMissing) {
        list.push({ field: "ownerTeam", label: "Owner Team", step: "basic" });
      }
      if (!systemPrompt.trim()) {
        list.push({
          field: "systemPrompt",
          label: "Instructions (system prompt)",
          step: "instructions",
        });
      }
      return list;
    }, [name, systemPrompt, modelId, availableModels.length, ownerTeamMissing]);

  const isValid = blockers.length === 0;
  const firstBlocker = blockers[0];
  const blockerStepLabel = firstBlocker
    ? (STEPS.find((s) => s.id === firstBlocker.step)?.label ??
      firstBlocker.step)
    : null;

  // Back-button click handler. When the form has unsaved changes, we surface
  // an in-app confirmation modal instead of silently discarding work. The
  // dialog itself is rendered at the bottom of this component.
  const handleBackClick = () => {
    if (dirty) {
      setPendingClose(true);
    } else {
      onCancel();
    }
  };

  const handleConfirmDiscard = () => {
    setPendingClose(false);
    // Belt-and-suspenders: clear the global flag here AND let the unmount
    // cleanup in useEditorDirtyTracking do the same. Either alone is enough.
    useUnsavedChangesStore.getState().setUnsaved(false);
    onCancel();
  };

  const handleCancelDiscard = () => {
    setPendingClose(false);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleBackClick}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <CardTitle>
              {readOnly
                ? `View Agent - ${agent?.name}`
                : isEditing
                  ? `Edit Agent - ${agent?.name}`
                  : isCloning
                    ? "Clone Agent"
                    : "Create Agent"}
            </CardTitle>
            <CardDescription>
              {readOnly
                ? readOnlyReason === "permissions"
                  ? "You do not have permission to edit this agent"
                  : "This agent is managed by configuration and cannot be edited"
                : isEditing
                  ? "Update the agent configuration"
                  : isCloning
                    ? `Creating a copy of "${cloneFrom?.name}"`
                    : "Configure a new custom AI agent"}
            </CardDescription>
          </div>
          <AgentAvatar
            gradientTheme={gradientTheme}
            customThemeConfig={
              gradientTheme === "custom" ? customThemeConfig : undefined
            }
            rounded="rounded-lg"
            size="ml-auto h-9 w-9"
            iconSize="h-5 w-5"
            className="transition-all"
          />
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Step Indicator + title inline */}
          <div className="flex items-center gap-4 border-b pb-3 mt-2">
            <div className="shrink-0">
              <h3 className="text-xl font-bold text-primary">
                Step {currentStepIndex + 1}: {currentStepConfig?.label}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {currentStepConfig?.hint}
              </p>
            </div>
            <StepIndicator
              steps={STEPS}
              currentStep={activeStep}
              onStepClick={selectStep}
            />
          </div>

          <fieldset
            className={cn("space-y-4 min-w-0", readOnly && "opacity-70")}
          >
            {/* Basic Info Step */}
            {activeStep === "basic" && (
              <div className="space-y-4 pt-2">
                <div className="space-y-2">
                  <Label htmlFor="name">
                    Agent Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="name"
                    placeholder="e.g., Code Review Agent"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={loading || !!readOnly}
                  />
                  {/* Show generated ID */}
                  {isEditing ? (
                    <p className="text-xs text-muted-foreground">
                      id:{" "}
                      <code className="bg-muted px-1 py-0.5 rounded">
                        {agent._id}
                      </code>
                    </p>
                  ) : generatedId ? (
                    <p
                      className={`text-xs ${idClash ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      id:{" "}
                      <code
                        className={`px-1 py-0.5 rounded ${idClash ? "bg-destructive/10" : "bg-muted"}`}
                      >
                        {generatedId}
                      </code>
                      {idClash && (
                        <span className="ml-1 font-medium">
                          - already exists, choose a different name
                        </span>
                      )}
                    </p>
                  ) : null}
                </div>

                {/* LLM Model - right after name so AI Suggest buttons can use it */}
                <div className="space-y-2">
                  <Label htmlFor="modelId">
                    LLM Model <span className="text-destructive">*</span>
                  </Label>
                  <div className="p-3 rounded-lg border-2 border-primary/20 bg-primary/5">
                    <ModelPicker
                      id="modelId"
                      options={availableModels}
                      modelId={modelId}
                      modelProvider={modelProvider}
                      onChange={(selectedId, selectedProvider) => {
                        setModelId(selectedId);
                        setModelProvider(selectedProvider);
                      }}
                      loading={modelsLoading}
                      disabled={
                        loading ||
                        !!readOnly
                      }
                      triggerClassName="font-medium"
                    />
                    {!modelsLoading && availableModels.length === 0 ? (
                      <p className="text-xs text-destructive mt-2">
                        No LLM models available. Please check your deployment
                        configuration.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-2">
                        The language model that powers this agent&apos;s
                        reasoning.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between relative">
                    <Label htmlFor="description">Description</Label>
                    <div className="relative">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1 px-2 border-primary/30 text-primary hover:bg-primary/10"
                        disabled={!canSuggest || loading || !!readOnly}
                        onClick={() => {
                          setShowSuggestBasicInput((v) => {
                            if (!v)
                              setEnhanceExistingBasic(!!description.trim());
                            return !v;
                          });
                          setShowSuggestPromptInput(false);
                        }}
                        title={
                          !name.trim()
                            ? "Enter a name first"
                            : !modelId
                              ? "Select a model first"
                              : "AI-generate description and theme"
                        }
                      >
                        {isGenerating &&
                        (generatingField === "description" ||
                          generatingField === "theme") ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Sparkles className="h-3 w-3" />
                        )}
                        AI Suggest
                      </Button>
                      <AnimatePresence>
                        {showSuggestBasicInput && (
                          <motion.div
                            initial={{ opacity: 0, y: -4, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -4, scale: 0.95 }}
                            transition={{ duration: 0.15 }}
                            className="absolute top-full right-0 mt-1 z-50 w-80 p-3 rounded-lg border border-border/50 bg-background shadow-xl"
                          >
                            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                              Describe what this agent does
                            </label>
                            <p className="text-[11px] text-muted-foreground/70 mb-2">
                              Generates a description and picks a matching
                              theme.
                            </p>
                            <Input
                              autoFocus
                              value={suggestBasicInstruction}
                              onChange={(e) =>
                                setSuggestBasicInstruction(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  handleSuggestBasicInfo(
                                    suggestBasicInstruction.trim() || undefined,
                                  );
                                if (e.key === "Escape")
                                  setShowSuggestBasicInput(false);
                              }}
                              placeholder="e.g., Summarizes documents and answers questions..."
                              className="h-8 text-sm mb-2"
                            />
                            {description.trim() && (
                              <label className="flex items-center gap-2 mb-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={enhanceExistingBasic}
                                  onChange={(e) =>
                                    setEnhanceExistingBasic(e.target.checked)
                                  }
                                  className="rounded border-muted"
                                />
                                <span className="text-xs text-muted-foreground">
                                  Enhance existing text
                                </span>
                              </label>
                            )}
                            <div className="flex justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => setShowSuggestBasicInput(false)}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 text-xs gap-1 gradient-primary text-white"
                                onClick={() =>
                                  handleSuggestBasicInfo(
                                    suggestBasicInstruction.trim() || undefined,
                                  )
                                }
                              >
                                <Sparkles className="h-3 w-3" />
                                Generate
                              </Button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                  <Textarea
                    id="description"
                    placeholder="What does this agent do?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={loading || !!readOnly}
                    rows={2}
                  />
                </div>

                {/* Agent Theme */}
                <div className="space-y-2">
                  <Label>Agent Theme</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Choose a color theme for this agent&apos;s avatar.
                  </p>
                  <div className="grid grid-cols-6 gap-1.5">
                    {gradientThemes.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        onClick={() => {
                          setGradientTheme(theme.id);
                          setShowCustomPicker(false);
                        }}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-all text-left",
                          gradientTheme === theme.id
                            ? "border-primary bg-primary/10"
                            : "border-border hover:border-primary/50 hover:bg-muted/50",
                        )}
                        disabled={loading || !!readOnly}
                        title={theme.description}
                      >
                        <div
                          className="w-6 h-6 rounded-md shrink-0"
                          style={{
                            background: `linear-gradient(to bottom right, ${theme.from}, ${theme.to})`,
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-[11px] font-medium block truncate">
                            {theme.label.split(" (")[0]}
                          </span>
                          <span className="text-[10px] text-muted-foreground block truncate">
                            {theme.description}
                          </span>
                        </div>
                        {gradientTheme === theme.id && (
                          <Check className="h-3 w-3 text-primary shrink-0" />
                        )}
                      </button>
                    ))}
                    {/* Custom theme button */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setGradientTheme("custom");
                          setShowCustomPicker(!showCustomPicker);
                        }}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-all text-left w-full",
                          gradientTheme === "custom"
                            ? "border-primary bg-primary/10"
                            : "border-border hover:border-primary/50 hover:bg-muted/50",
                        )}
                        disabled={loading || !!readOnly}
                        title="Custom colors"
                      >
                        <div
                          className="w-6 h-6 rounded-md shrink-0 border border-dashed border-muted-foreground/40 flex items-center justify-center"
                          style={
                            gradientTheme === "custom"
                              ? {
                                  background: `linear-gradient(to bottom right, ${customThemeConfig.gradient_from}, ${customThemeConfig.gradient_to})`,
                                }
                              : undefined
                          }
                        >
                          {gradientTheme !== "custom" && (
                            <span className="text-[10px] text-muted-foreground">
                              +
                            </span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[11px] font-medium block truncate">
                            Custom
                          </span>
                          <span className="text-[10px] text-muted-foreground block truncate">
                            Pick your own
                          </span>
                        </div>
                        {gradientTheme === "custom" && (
                          <Check className="h-3 w-3 text-primary shrink-0" />
                        )}
                      </button>

                      {/* Custom theme picker popup — positioned to the left of the button */}
                      {showCustomPicker && gradientTheme === "custom" && (
                        <div className="absolute right-full top-0 mr-2 p-4 rounded-lg border border-border bg-card shadow-lg space-y-4 w-72 z-50">
                          {/* Preview */}
                          <div className="flex items-center gap-3">
                            <AgentAvatar
                              gradientTheme="custom"
                              customThemeConfig={customThemeConfig}
                              rounded="rounded-xl"
                              size="h-12 w-12"
                              iconSize="h-6 w-6"
                              className="transition-all"
                            />
                            <div className="text-xs text-muted-foreground">
                              Live preview
                            </div>
                          </div>

                          {/* Color inputs */}
                          <div className="space-y-2.5">
                            <div className="flex items-center gap-2">
                              <label className="text-[11px] font-medium w-24 shrink-0">
                                Gradient From
                              </label>
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  type="color"
                                  value={customThemeConfig.gradient_from}
                                  onChange={(e) =>
                                    setCustomThemeConfig((prev) => ({
                                      ...prev,
                                      gradient_from: e.target.value,
                                    }))
                                  }
                                  className="h-7 w-7 rounded cursor-pointer border border-border shrink-0"
                                />
                                <Input
                                  value={customThemeConfig.gradient_from}
                                  onChange={(e) =>
                                    setCustomThemeConfig((prev) => ({
                                      ...prev,
                                      gradient_from: e.target.value,
                                    }))
                                  }
                                  className="h-7 text-xs font-mono"
                                  placeholder="#6366f1"
                                />
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-[11px] font-medium w-24 shrink-0">
                                Gradient To
                              </label>
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  type="color"
                                  value={customThemeConfig.gradient_to}
                                  onChange={(e) =>
                                    setCustomThemeConfig((prev) => ({
                                      ...prev,
                                      gradient_to: e.target.value,
                                    }))
                                  }
                                  className="h-7 w-7 rounded cursor-pointer border border-border shrink-0"
                                />
                                <Input
                                  value={customThemeConfig.gradient_to}
                                  onChange={(e) =>
                                    setCustomThemeConfig((prev) => ({
                                      ...prev,
                                      gradient_to: e.target.value,
                                    }))
                                  }
                                  className="h-7 text-xs font-mono"
                                  placeholder="#1e1b4b"
                                />
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-[11px] font-medium w-24 shrink-0">
                                Icon Color
                              </label>
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  type="color"
                                  value={customThemeConfig.accent_color}
                                  onChange={(e) =>
                                    setCustomThemeConfig((prev) => ({
                                      ...prev,
                                      accent_color: e.target.value,
                                    }))
                                  }
                                  className="h-7 w-7 rounded cursor-pointer border border-border shrink-0"
                                />
                                <Input
                                  value={customThemeConfig.accent_color}
                                  onChange={(e) =>
                                    setCustomThemeConfig((prev) => ({
                                      ...prev,
                                      accent_color: e.target.value,
                                    }))
                                  }
                                  className="h-7 text-xs font-mono"
                                  placeholder="#ffffff"
                                />
                              </div>
                            </div>
                          </div>

                          {/* Done button */}
                          <Button
                            type="button"
                            size="sm"
                            className="w-full h-7 text-xs"
                            onClick={() => setShowCustomPicker(false)}
                          >
                            Done
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Owner-team picker + share-with-teams multi-select +
                  effective-access preview are now the shared
                  <TeamOwnershipFields> control bundle (spec 2026-06-03,
                  US1). The agent's visibility toggle is interleaved via
                  `betweenOwnerAndShare`, the platform-admin warning via
                  `ownerExtra`, and the agent-specific grant copy via
                  `renderGrantDetail`, so the UX is unchanged (SC-006). */}
                <TeamOwnershipFields
                  ownerTeamSlug={ownerTeamSlug}
                  sharedTeamSlugs={sharedWithTeams}
                  isEditing={isEditing}
                  ownerRequired
                  allowTransfer={isEditing}
                  resourceNoun="agent"
                  disabled={loading || !!readOnly}
                  showShare={visibility === "team"}
                  currentUserTeamSlugs={availableTeams
                    .map((team) => team.slug)
                    .filter((slug): slug is string => Boolean(slug))}
                  onOwnerTeamChange={setOwnerTeamSlug}
                  onSharedTeamsChange={setSharedWithTeams}
                  onTransfer={(_newOwnerSlug, confirmedNotMember) => {
                    // The component already applied the new slug via
                    // onOwnerTeamChange; record that this edit is a transfer so
                    // the PUT sends owner_team_slug + confirm_not_member.
                    setTransferRequested(true);
                    setTransferConfirmedNotMember(confirmedNotMember);
                    // Picking a different destination clears any stale
                    // not-a-member rejection so the inline "Confirm Transfer"
                    // button (and its message) can't linger and refer to the
                    // previously-chosen team.
                    setTransferNeedsServerConfirm(false);
                    setError(null);
                  }}
                  availableTeams={availableTeams
                    .filter((team): team is typeof team & { slug: string } =>
                      Boolean(team.slug),
                    )
                    .map<TeamPickerOption>((team) => ({
                      slug: team.slug,
                      name: team.name,
                      _id: team._id,
                    }))}
                  ownerTeamOptions={availableTeams
                    .filter((team): team is typeof team & { slug: string } =>
                      Boolean(team.slug),
                    )
                    .map<TeamPickerOption>((team) => ({
                      slug: team.slug,
                      name: team.user_role
                        ? `${team.name} (${team.user_role})`
                        : team.name,
                      _id: team._id,
                      disabled: team.can_own_agents === false,
                    }))}
                  ownerHelpText={
                    <>
                      Select a team you belong to as the owner. You manage this
                      agent as its creator; team members can use it; team admins
                      can manage it.
                    </>
                  }
                  shareHelpText={
                    <>
                      Select which additional teams can access this agent.
                      Members of a shared team can DM it and use it in any Slack
                      channel or Webex space mapped to that team. Team admins
                      can manage shared agents.
                    </>
                  }
                  ownerExtra={
                    !isEditing && availableTeams.length === 0 ? (
                      <p className="text-xs text-destructive">
                        You must belong to at least one team to create a
                        team-owned agent.
                      </p>
                    ) : null
                  }
                  betweenOwnerAndShare={
                    <div className="space-y-2">
                      <Label>Visibility</Label>
                      {isPlatformDefault && (
                        <p
                          className="text-xs text-amber-600 dark:text-amber-400"
                          data-testid="platform-default-visibility-note"
                        >
                          This agent is the platform default for new chats, so
                          every signed-in user can use it. Change the platform
                          default in Admin → Settings before changing its
                          visibility.
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        {VISIBILITY_OPTIONS.map((opt) => {
                          // When this agent is the platform default, lock the
                          // selector so the admin can't try to demote
                          // `global → team` here — the BFF will reject it.
                          const lockedByPlatformDefault = isPlatformDefault;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => setVisibility(opt.value)}
                              className={`p-3 rounded-lg border text-left transition-colors ${
                                visibility === opt.value
                                  ? "border-primary bg-primary/5"
                                  : "border-muted hover:border-primary/50"
                              } ${lockedByPlatformDefault ? "opacity-60 cursor-not-allowed" : ""}`}
                              disabled={
                                loading || !!readOnly || lockedByPlatformDefault
                              }
                            >
                              <div className="flex items-center gap-2 mb-1">
                                {opt.icon}
                                <span className="font-medium text-sm">
                                  {opt.label}
                                </span>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {opt.description}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {visibility === "global" && (
                        <div
                          role="note"
                          aria-label="Global visibility summary"
                          className="space-y-1 rounded-lg border bg-muted/30 p-3 text-xs"
                          data-testid="global-visibility-grant-preview"
                        >
                          <div className="font-medium text-foreground">
                            Everyone can use this agent
                            {isPlatformDefault
                              ? " (it is also the platform default)"
                              : ""}
                            .
                          </div>
                          <p className="text-muted-foreground">
                            When you save, every signed-in user will be able to
                            chat with this agent. Owner-team admins still manage
                            it.
                          </p>
                        </div>
                      )}
                    </div>
                  }
                />
              </div>
            )}

            {/* Instructions Step */}
            {activeStep === "instructions" && (
              <div className="space-y-4 pt-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between relative">
                    <Label htmlFor="systemPrompt">
                      System Prompt <span className="text-destructive">*</span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1 px-2 border-primary/30 text-primary hover:bg-primary/10"
                          disabled={!canSuggest || loading || !!readOnly}
                          onClick={() => {
                            setShowSuggestPromptInput((v) => {
                              if (!v) setEnhanceExisting(!!systemPrompt.trim());
                              return !v;
                            });
                            setShowSuggestBasicInput(false);
                          }}
                          title={
                            !name.trim()
                              ? "Enter a name first"
                              : !modelId
                                ? "Select a model first"
                                : "Generate system prompt with AI"
                          }
                        >
                          {generatingField === "system_prompt" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Sparkles className="h-3 w-3" />
                          )}
                          AI Suggest
                        </Button>

                        {/* Inline popover for instructions */}
                        <AnimatePresence>
                          {showSuggestPromptInput && (
                            <motion.div
                              initial={{ opacity: 0, y: -4, scale: 0.95 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -4, scale: 0.95 }}
                              transition={{ duration: 0.15 }}
                              className="absolute top-full right-0 mt-1 z-50 w-80 p-3 rounded-lg border border-border/50 bg-background shadow-xl"
                            >
                              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                                What should the system prompt cover?
                              </label>
                              <Input
                                autoFocus
                                value={suggestPromptInstruction}
                                onChange={(e) =>
                                  setSuggestPromptInstruction(e.target.value)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    handleSuggestSystemPrompt(
                                      suggestPromptInstruction.trim() ||
                                        undefined,
                                    );
                                  if (e.key === "Escape")
                                    setShowSuggestPromptInput(false);
                                }}
                                placeholder="e.g., Focus on step-by-step reasoning..."
                                className="h-8 text-sm mb-2"
                              />
                              {systemPrompt.trim() && (
                                <label className="flex items-center gap-2 mb-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={enhanceExisting}
                                    onChange={(e) =>
                                      setEnhanceExisting(e.target.checked)
                                    }
                                    className="rounded border-muted"
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    Enhance existing text
                                  </span>
                                </label>
                              )}
                              <div className="flex items-center gap-1 mb-2">
                                <button
                                  type="button"
                                  className={cn(
                                    "px-2 py-0.5 text-xs rounded-full border transition-colors",
                                    promptStyle === "concise"
                                      ? "border-primary text-primary bg-primary/10"
                                      : "border-border text-muted-foreground hover:border-primary/30",
                                  )}
                                  onClick={() => setPromptStyle("concise")}
                                >
                                  Concise
                                </button>
                                <button
                                  type="button"
                                  className={cn(
                                    "px-2 py-0.5 text-xs rounded-full border transition-colors",
                                    promptStyle === "comprehensive"
                                      ? "border-primary text-primary bg-primary/10"
                                      : "border-border text-muted-foreground hover:border-primary/30",
                                  )}
                                  onClick={() =>
                                    setPromptStyle("comprehensive")
                                  }
                                >
                                  Comprehensive
                                </button>
                              </div>
                              <div className="flex justify-end gap-1.5">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() =>
                                    setShowSuggestPromptInput(false)
                                  }
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-7 text-xs gap-1 gradient-primary text-white"
                                  onClick={() =>
                                    handleSuggestSystemPrompt(
                                      suggestPromptInstruction.trim() ||
                                        undefined,
                                    )
                                  }
                                >
                                  <Sparkles className="h-3 w-3" />
                                  Generate
                                </Button>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      {/* AI Review button — sibling to AI Suggest. Renders disabled
                      when the target isn't configured; the panel below renders
                      null in the same case so this is the only visible affordance. */}
                      <AiReviewButton review={review} size="sm" />
                    </div>
                  </div>

                  {/* Edit / Preview tabs */}
                  <div className="flex items-center gap-1 border-b border-border/30">
                    <button
                      type="button"
                      onClick={() => setPromptTab("edit")}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px",
                        promptTab === "edit"
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setPromptTab("preview")}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px",
                        promptTab === "preview"
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Eye className="h-3 w-3" />
                      Preview
                    </button>
                  </div>

                  {/* Editor column + AI Review panel side-by-side. Panel renders
                    null when the target isn't configured / disabled, so the
                    flex container collapses to just the editor in that case. */}
                  <div className="flex gap-3 min-h-0">
                    <div className="flex-1 min-w-0">
                      {promptTab === "edit" ? (
                        <div
                          className="rounded-lg overflow-hidden border border-border/30 bg-[#1e1e2e]"
                          style={{ height: `${editorHeight}px` }}
                        >
                          <React.Suspense
                            fallback={
                              <div className="flex items-center justify-center h-48 text-zinc-500">
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                <span className="text-sm">
                                  Loading editor...
                                </span>
                              </div>
                            }
                          >
                            <CodeMirrorEditor
                              value={systemPrompt}
                              onChange={(val: string) => setSystemPrompt(val)}
                              extensions={cmExtensions}
                              theme="dark"
                              height={`${editorHeight}px`}
                              style={{ fontSize: "15px" }}
                              basicSetup={{
                                lineNumbers: true,
                                foldGutter: true,
                                highlightActiveLine: true,
                                bracketMatching: true,
                                autocompletion: false,
                                indentOnInput: true,
                              }}
                              placeholder="You are a helpful AI assistant that specializes in..."
                              editable={
                                !loading &&
                                !readOnly &&
                                generatingField !== "system_prompt"
                              }
                            />
                          </React.Suspense>
                        </div>
                      ) : (
                        <div
                          className="rounded-lg border p-4 overflow-y-auto prose prose-sm dark:prose-invert max-w-none"
                          style={{ height: `${editorHeight}px` }}
                        >
                          {systemPrompt.trim() ? (
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={getMarkdownComponents()}
                            >
                              {systemPrompt}
                            </ReactMarkdown>
                          ) : (
                            <p className="text-muted-foreground italic text-sm">
                              Nothing to preview. Switch to Edit to write your
                              system prompt.
                            </p>
                          )}
                        </div>
                      )}

                      {/* Drag handle to resize editor */}
                      <div
                        onMouseDown={handleDragStart}
                        className="flex items-center justify-center h-3 cursor-row-resize group hover:bg-muted/50 rounded-b-lg transition-colors"
                      >
                        <GripHorizontal className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground" />
                      </div>
                    </div>
                    <AiReviewPanel
                      review={review}
                      style={{ height: `${editorHeight + 12}px` }}
                      onClickAnchor={(anchor) => {
                        // Phase 1: no-op stub. A follow-up will scroll the
                        // CodeMirror view to `anchor.line_start` and flash a
                        // gutter decoration. Logging keeps the wiring observable
                        // during development.
                        if (process.env.NODE_ENV !== "production") {
                          console.debug("[ai-review] anchor click", anchor);
                        }
                      }}
                    />
                  </div>

                  <p className="text-sm text-muted-foreground">
                    Define your agent&apos;s behavior, personality, and
                    capabilities.
                  </p>

                  {blockingMessage && (
                    <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                      <p className="text-sm text-destructive">
                        {blockingMessage}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tools Step */}
            {activeStep === "tools" && (
              <div className="space-y-6 pt-2">
                {/* Built-in Tools */}
                <BuiltinToolsPicker
                  value={builtinTools}
                  onChange={setBuiltinTools}
                  disabled={loading || !!readOnly}
                />

                {/* MCP Tools */}
                <div className="space-y-4">
                  <div>
                    <Label>MCP Tool Access</Label>
                    <p className="text-xs text-muted-foreground mb-4">
                      Select which MCP servers and tools this agent can use. If
                      no servers are selected, the agent will have no external
                      tool access.
                    </p>
                  </div>

                  <AllowedToolsPicker
                    value={allowedTools}
                    onChange={setAllowedTools}
                    disabled={loading || !!readOnly}
                  />
                </div>
              </div>
            )}

            {/* Knowledge Step */}
            {activeStep === "knowledge" && (
              <div className="space-y-4 pt-2">
                {!hasRagToolAccess(allowedTools) && (
                  <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      To enable access to knowledge bases, enable the Knowledge
                      Base tool calls in the previous step.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => selectStep("tools")}
                    >
                      Go to Tools
                    </Button>
                  </div>
                )}
                <div
                  className={cn(
                    "transition-opacity",
                    !hasRagToolAccess(allowedTools) && "opacity-50",
                  )}
                >
                  <DatasourcePicker
                    ownerTeamSlug={ownerTeamSlug}
                    value={datasourceIds}
                    onChange={setDatasourceIds}
                    collectionValue={ragCollectionIds}
                    onCollectionChange={setRagCollectionIds}
                    // A new RAG-enabled agent starts with Platform RAG only
                    // after migration has actually created that collection.
                    defaultToPlatform={
                      !source && hasRagToolAccess(allowedTools)
                    }
                    disabled={
                      loading || !!readOnly || !hasRagToolAccess(allowedTools)
                    }
                  />
                </div>
              </div>
            )}

            {/* Step: Skills */}
            {activeStep === "skills" && (
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Skills provide specialized instructions and workflows that
                    guide your agent&apos;s behavior for specific tasks. The
                    agent reads skill content on demand via progressive
                    disclosure.
                  </p>
                </div>

                <SkillsSelector
                  value={skills}
                  onChange={setSkills}
                  disabled={loading || !!readOnly}
                />
              </div>
            )}

            {/* Advanced Step */}
            {activeStep === "advanced" && (
              <AdvancedStep
                agent={agent}
                subagents={subagents}
                setSubagents={setSubagents}
                interruptOn={interruptOn}
                setInterruptOn={setInterruptOn}
                allowedTools={allowedTools}
                builtinTools={builtinTools}
                setBuiltinTools={(v) => setBuiltinTools(v)}
                features={features}
                setFeatures={setFeatures}
                availableModels={availableModels}
                setMiddlewareError={setMiddlewareError}
                loading={loading || !!readOnly}
                visibility={visibility}
              />
            )}

            {/* Error */}
            {error && (
              <div
                role="alert"
                className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 space-y-2"
              >
                <p className="text-sm text-destructive">{error}</p>
                {transferNeedsServerConfirm && (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={loading}
                    onClick={() => {
                      setTransferConfirmedNotMember(true);
                      void handleSubmit(undefined, {
                        forceConfirmNotMember: true,
                      });
                    }}
                  >
                    Confirm Transfer
                  </Button>
                )}
              </div>
            )}
          </fieldset>

          {/* Step Navigation - Right aligned */}
          <div className="flex items-center justify-end gap-2 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={goToPreviousStep}
              disabled={currentStepIndex === 0 || loading}
              size="sm"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void goToNextStep()}
              disabled={currentStepIndex === STEPS.length - 1 || loading}
              size="sm"
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </form>
      </CardContent>

      {/* Action Buttons - Outside the card content */}
      <div className="flex items-center gap-2 px-6 py-4 border-t bg-muted/30">
        <div className="text-xs text-muted-foreground mr-auto hidden sm:block">
          {readOnly ? (
            "This agent is config-driven and cannot be modified"
          ) : (
            <>
              {builtinTools?.fetch_url?.enabled ? "1 built-in, " : ""}
              {Object.keys(allowedTools).length} MCP server(s),{" "}
              {subagents.length} subagent(s)
            </>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={loading}
        >
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {!readOnly && (
          <Button
            onClick={handleSubmit}
            disabled={loading || !isValid}
            // Native-tooltip mirror of the inline hint above. Helps users who
            // hover the button looking for an explanation when they miss the
            // inline text (e.g. on narrow screens where the hint wraps).
            title={
              !loading && firstBlocker
                ? `${firstBlocker.label} is required${blockerStepLabel ? ` (on ${blockerStepLabel} step)` : ""}`
                : undefined
            }
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {isEditing ? "Saving..." : "Creating..."}
              </>
            ) : isEditing ? (
              "Save Changes"
            ) : (
              "Create Agent"
            )}
          </Button>
        )}
      </div>

      <UnsavedChangesDialog
        open={pendingClose}
        onCancel={handleCancelDiscard}
        onDiscard={handleConfirmDiscard}
        title="Unsaved changes"
        description="You have unsaved changes in the agent editor. They will be lost if you leave now."
      />
    </Card>
  );
}
