"use client";

import type { AgentAvatarAgent } from "@/components/dynamic-agents/AgentAvatar";
import { UnsavedChangesDialog } from "@/components/shared/UnsavedChangesDialog";
import { useToast } from "@/components/ui/toast";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import { useWorkflowConfigStore } from "@/store/workflow-config-store";
import { useWorkflowExecStore } from "@/store/workflow-exec-store";
import type {
  CreateWorkflowConfigInput,
  UpdateWorkflowConfigInput,
  WorkflowConfig,
  WorkflowStep,
} from "@/types/workflow-config";
import { createBlankStep } from "@/types/workflow-config";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Lock } from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import {
  AddButtonNode,
  WorkflowStepNode,
  type AddButtonNodeData,
  type WorkflowStepNodeData,
} from "./WorkflowStepNode";
import { WorkflowStepSidebar } from "./WorkflowStepSidebar";
import { WorkflowToolbar } from "./WorkflowToolbar";
import type { AgentAccessGap } from "@/app/api/workflow-configs/check-agent-access/route";
import { WorkflowAgentAccessModal } from "./WorkflowAgentAccessModal";
import { grantAgentAccessGaps } from "./agent-access-grants";

// ---------------------------------------------------------------------------
// Node types — defined outside component to avoid re-renders
// ---------------------------------------------------------------------------

const nodeTypes = {
  workflowStep: WorkflowStepNode,
  addButton: AddButtonNode,
};

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const NODE_X = 300;
const NODE_WIDTH = 220; // matches w-[220px] in WorkflowStepNode
const NODE_CENTER_X = NODE_X + NODE_WIDTH / 2; // 410
const NODE_VERTICAL_GAP = 140;
const NODE_VERTICAL_GAP_WITH_BADGE = 160; // extra space when on_error badge is shown
const ADD_BUTTON_Y_OFFSET = 80; // position of "+" button below the step node
const ADD_BUTTON_Y_OFFSET_WITH_BADGE = 100; // when step has on_error badge
const ADD_BUTTON_APPEND_SIZE = 28; // w-7
const ADD_BUTTON_INSERT_SIZE = 20; // w-5

// ---------------------------------------------------------------------------
// Agent fetching hook
// ---------------------------------------------------------------------------

interface DAOption {
  value: string;
  label: string;
}

interface AgentInfo extends DAOption {
  description?: string;
  ui?: AgentAvatarAgent["ui"];
}

function useDynamicAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dynamic-agents/available");
        if (!res.ok) throw new Error("Failed to fetch agents");
        const data = await res.json();
        const list = (
          Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : []
        ) as Array<{
          _id?: string;
          id?: string;
          name?: string;
          description?: string;
          ui?: AgentAvatarAgent["ui"];
        }>;
        if (!cancelled) {
          setAgents(
            list.map((a) => ({
              value: a._id || a.id,
              label: a.name || a._id || a.id,
              description: a.description || undefined,
              ui: a.ui || null,
            })),
          );
        }
      } catch {
        if (!cancelled) setAgents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { agents, loading };
}

// ---------------------------------------------------------------------------
// Build nodes & edges from steps (pure functions, no callbacks in data)
// ---------------------------------------------------------------------------

function buildNodes(steps: WorkflowStep[], agents: AgentInfo[]): Node[] {
  const nodes: Node[] = [];
  const agentMap = new Map(agents.map((a) => [a.value, a]));

  let yPos = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const agentInfo = agentMap.get(step.agent_id);
    const hasBadge = step.on_error && step.on_error !== "abort";

    nodes.push({
      id: `step-${i}`,
      type: "workflowStep",
      position: { x: NODE_X, y: yPos },
      draggable: false,
      data: {
        stepIndex: i,
        display_text: step.display_text,
        agent_id: step.agent_id,
        prompt: step.prompt,
        on_error: step.on_error,
        agent: agentInfo ? { name: agentInfo.label, ui: agentInfo.ui } : null,
      } satisfies WorkflowStepNodeData,
    });

    // "+" button after each step
    const isLastStep = i === steps.length - 1;
    const btnSize = isLastStep
      ? ADD_BUTTON_APPEND_SIZE
      : ADD_BUTTON_INSERT_SIZE;
    const btnYOffset = hasBadge
      ? ADD_BUTTON_Y_OFFSET_WITH_BADGE
      : ADD_BUTTON_Y_OFFSET;
    nodes.push({
      id: `add-${i}`,
      type: "addButton",
      position: { x: NODE_CENTER_X - btnSize / 2, y: yPos + btnYOffset },
      selectable: false,
      draggable: false,
      data: {
        insertIndex: i + 1,
        variant: isLastStep ? "append" : "insert",
        onAdd: () => {},
      } satisfies AddButtonNodeData,
    });

    // Advance Y for next step
    yPos += hasBadge ? NODE_VERTICAL_GAP_WITH_BADGE : NODE_VERTICAL_GAP;
  }

  // If no steps, show a single "+" button
  if (steps.length === 0) {
    nodes.push({
      id: "add-initial",
      type: "addButton",
      position: { x: NODE_CENTER_X - ADD_BUTTON_APPEND_SIZE / 2, y: 0 },
      selectable: false,
      draggable: false,
      data: {
        insertIndex: 0,
        variant: "append",
        onAdd: () => {},
      } satisfies AddButtonNodeData,
    });
  }

  return nodes;
}

function buildEdges(steps: WorkflowStep[]): Edge[] {
  const edges: Edge[] = steps.slice(0, -1).map((_, i) => ({
    id: `edge-${i}-${i + 1}`,
    source: `step-${i}`,
    target: `step-${i + 1}`,
    type: "default",
    animated: true,
    style: {
      stroke: "hsl(var(--primary))",
      strokeWidth: 2,
      strokeDasharray: "5 5",
    },
  }));

  // Connector from last step to the trailing "+" button
  if (steps.length > 0) {
    const lastIdx = steps.length - 1;
    edges.push({
      id: `edge-${lastIdx}-add`,
      source: `step-${lastIdx}`,
      target: `add-${lastIdx}`,
      type: "default",
      animated: true,
      style: {
        stroke: "hsl(var(--muted-foreground))",
        strokeWidth: 2,
        strokeDasharray: "5 5",
      },
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Canvas controls
// ---------------------------------------------------------------------------

function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const btnClass =
    "w-8 h-8 flex items-center justify-center rounded-md text-primary hover:bg-primary/15 hover:text-primary transition-colors";

  return (
    <Panel position="bottom-left">
      <div className="flex flex-col gap-0.5 bg-card border border-border rounded-lg p-1 shadow-lg">
        <button onClick={() => zoomIn()} className={btnClass} title="Zoom in">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button onClick={() => zoomOut()} className={btnClass} title="Zoom out">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <div className="h-px bg-border my-0.5" />
        <button
          onClick={() => fitView({ padding: 0.3 })}
          className={btnClass}
          title="Fit view"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkflowCanvasProps {
  existingConfig?: WorkflowConfig;
  initialName?: string;
  initialDescription?: string;
  initialSteps?: WorkflowStep[];
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowCanvasInner({
  existingConfig,
  initialName,
  initialDescription,
  initialSteps,
  onBack,
}: WorkflowCanvasProps) {
  const {
    createConfig,
    updateConfig,
    deleteConfig,
    closeEditor,
    loadConfigs,
    openEditor,
  } = useWorkflowConfigStore();
  const { data: authSession } = useSession();
  const { executeWorkflow } = useWorkflowExecStore();
  const {
    hasUnsavedChanges,
    setUnsaved,
    pendingNavigationHref,
    pendingDeferredAction,
    cancelNavigation,
    confirmNavigation,
    confirmDeferredAction,
  } = useUnsavedChangesStore();
  const { agents, loading: agentsLoading } = useDynamicAgents();
  const router = useRouter();
  const { toast } = useToast();

  // -----------------------------------------------------------------------
  // Steps = source of truth
  // -----------------------------------------------------------------------

  const seedSteps = useMemo(() => {
    if (existingConfig) {
      return existingConfig.steps.filter(
        (s): s is WorkflowStep => s.type === "step",
      );
    }
    return initialSteps && initialSteps.length > 0 ? initialSteps : [];
  }, [existingConfig, initialSteps]);

  const [steps, setSteps] = useState<WorkflowStep[]>(seedSteps);
  const [name, setName] = useState(existingConfig?.name || initialName || "");
  const [description, setDescription] = useState(
    existingConfig?.description || initialDescription || "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [agentAccessGaps, setAgentAccessGaps] = useState<AgentAccessGap[]>([]);
  const [showAccessModal, setShowAccessModal] = useState(false);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number>(-1);

  // Visibility & sharing
  const [visibility, setVisibility] = useState<"private" | "team" | "global">(
    existingConfig?.visibility || "private",
  );
  const [sharedWithTeams, setSharedWithTeams] = useState<string[]>(
    existingConfig?.shared_with_teams || [],
  );
  const [availableTeams, setAvailableTeams] = useState<
    { _id: string; slug: string; name: string }[]
  >([]);

  useEffect(() => {
    fetch("/api/dynamic-agents/teams")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.success && Array.isArray(data.data)) {
          setAvailableTeams(
            data.data.filter(
              (team: { slug?: string }) =>
                typeof team.slug === "string" && team.slug.length > 0,
            ),
          );
        }
      })
      .catch(() => {});
  }, []);

  // Legacy workflows stored Mongo team _id in shared_with_teams; normalize to slug in UI.
  useEffect(() => {
    if (
      !existingConfig?.shared_with_teams?.length ||
      availableTeams.length === 0
    )
      return;
    setSharedWithTeams((current) => {
      const normalized = existingConfig.shared_with_teams!.map((ref) => {
        const refLower = ref.trim().toLowerCase();
        const bySlug = availableTeams.find(
          (t) => t.slug.toLowerCase() === refLower,
        );
        if (bySlug) return bySlug.slug;
        const byId = availableTeams.find((t) => t._id === ref);
        return byId?.slug ?? refLower;
      });
      const same =
        current.length === normalized.length &&
        current.every((slug, i) => slug === normalized[i]);
      return same ? current : normalized;
    });
  }, [existingConfig?._id, existingConfig?.shared_with_teams, availableTeams]);

  const isDirtyRef = useRef(false);

  const markDirty = useCallback(() => {
    isDirtyRef.current = true;
    setUnsaved(true);
  }, [setUnsaved]);

  // -----------------------------------------------------------------------
  // Derive nodes & edges from steps + agents (reactive, no stale closures)
  // -----------------------------------------------------------------------

  const nodes = useMemo(() => buildNodes(steps, agents), [steps, agents]);
  const edges = useMemo(() => buildEdges(steps), [steps]);

  // -----------------------------------------------------------------------
  // Node click handler — handles both step selection and "+" button clicks
  // -----------------------------------------------------------------------

  const isConfigDriven = !!existingConfig?.config_driven;

  const { isReadOnly, readOnlyHint } = useMemo(() => {
    if (!existingConfig) {
      return { isReadOnly: false, readOnlyHint: undefined };
    }
    if (existingConfig.config_driven) {
      return {
        isReadOnly: true,
        readOnlyHint:
          "This workflow is seeded from config/app-config.yaml and cannot be overwritten. " +
          "Edit steps here, then use Save as copy or Run (which saves a copy first).",
      };
    }
    const userEmail = authSession?.user?.email?.trim().toLowerCase();
    const ownerId = existingConfig.owner_id?.trim().toLowerCase();
    if (ownerId === "system") {
      return {
        isReadOnly: true,
        readOnlyHint:
          "This is a platform workflow (owner: system). Use Clone to edit to create your own editable copy.",
      };
    }
    if (userEmail && ownerId && ownerId !== userEmail) {
      return {
        isReadOnly: true,
        readOnlyHint:
          "You can run this workflow, but only the owner can change it. Use Clone to edit to create your own copy.",
      };
    }
    return { isReadOnly: false, readOnlyHint: undefined };
  }, [existingConfig, authSession?.user?.email]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type === "addButton") {
        if (isReadOnly) {
          toast(
            "This workflow is config-driven and cannot be edited",
            "warning",
          );
          return;
        }
        const insertIndex = (node.data as unknown as AddButtonNodeData)
          .insertIndex;
        markDirty();
        const newStep = createBlankStep();
        setSteps((prev) => {
          const next = [...prev];
          next.splice(insertIndex, 0, newStep);
          return next;
        });
        // Select the newly inserted step
        setSelectedStepIndex(insertIndex);
      } else if (node.type === "workflowStep") {
        const d = node.data as unknown as WorkflowStepNodeData;
        setSelectedStepIndex(d.stepIndex);
      }
    },
    [markDirty, isReadOnly, toast],
  );

  // Clicking on the canvas background deselects
  const onPaneClick = useCallback(() => {
    setSelectedStepIndex(-1);
  }, []);

  // -----------------------------------------------------------------------
  // Selected step
  // -----------------------------------------------------------------------

  const selectedStep =
    selectedStepIndex >= 0 && selectedStepIndex < steps.length
      ? steps[selectedStepIndex]
      : null;

  // -----------------------------------------------------------------------
  // Step mutations (called from sidebar)
  // -----------------------------------------------------------------------

  const handleStepChange = useCallback(
    (updates: Partial<WorkflowStep>) => {
      if (selectedStepIndex < 0) return;
      markDirty();
      setSteps((prev) =>
        prev.map((s, i) =>
          i === selectedStepIndex ? { ...s, ...updates } : s,
        ),
      );
    },
    [selectedStepIndex, markDirty],
  );

  const handleDeleteStep = useCallback(
    (stepIndex: number) => {
      markDirty();
      setSteps((prev) => prev.filter((_, i) => i !== stepIndex));
      if (selectedStepIndex === stepIndex) setSelectedStepIndex(-1);
      else if (selectedStepIndex > stepIndex)
        setSelectedStepIndex((i) => i - 1);
    },
    [selectedStepIndex, markDirty],
  );

  // Expose delete to node via a ref so it's always fresh
  const deleteStepRef = useRef(handleDeleteStep);
  deleteStepRef.current = handleDeleteStep;

  // -----------------------------------------------------------------------
  // Unsaved changes & navigation guards
  // -----------------------------------------------------------------------

  useEffect(() => {
    return () => setUnsaved(false);
  }, [setUnsaved]);

  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  const guardAction = useCallback((action: () => void) => {
    if (isDirtyRef.current) {
      pendingActionRef.current = action;
      setShowUnsavedDialog(true);
    } else {
      action();
    }
  }, []);

  useEffect(() => {
    if (!isDirtyRef.current) return;

    if (pendingNavigationHref) {
      setShowUnsavedDialog(true);
      pendingActionRef.current = () => {
        const href = confirmNavigation();
        if (href) {
          isDirtyRef.current = false;
          setUnsaved(false);
          window.location.href = href;
        }
      };
      return;
    }

    if (pendingDeferredAction) {
      setShowUnsavedDialog(true);
      pendingActionRef.current = () => {
        confirmDeferredAction();
        isDirtyRef.current = false;
      };
    }
  }, [
    pendingNavigationHref,
    pendingDeferredAction,
    confirmNavigation,
    confirmDeferredAction,
    setUnsaved,
  ]);

  const handleBack = useCallback(() => {
    guardAction(onBack);
  }, [onBack, guardAction]);

  const handleCloneToEdit = useCallback(() => {
    if (!existingConfig) return;
    guardAction(() => openEditor("clone", existingConfig._id));
  }, [existingConfig, openEditor, guardAction]);

  const handleNameChange = useCallback(
    (v: string) => {
      markDirty();
      setName(v);
    },
    [markDirty],
  );

  const handleDescriptionChange = useCallback(
    (v: string) => {
      markDirty();
      setDescription(v);
    },
    [markDirty],
  );

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  const persistWorkflow = useCallback(
    async (
      overrides?: Pick<
        CreateWorkflowConfigInput,
        "visibility" | "shared_with_teams"
      >,
    ): Promise<string | null> => {
      if (!name || steps.length === 0) {
        toast("Workflow name and at least one step are required", "error");
        return null;
      }

      const effectiveVisibility = overrides?.visibility ?? visibility;
      const effectiveSharedWithTeams =
        effectiveVisibility === "team"
          ? (overrides?.shared_with_teams ?? sharedWithTeams)
          : undefined;

      if (existingConfig?.config_driven) {
        const input: CreateWorkflowConfigInput = {
          name: `${name.trim()} (editable)`,
          description: description.trim() || undefined,
          steps,
          visibility: effectiveVisibility,
          shared_with_teams: effectiveSharedWithTeams,
        };
        const newId = await createConfig(input);
        openEditor("edit", newId);
        return newId;
      }

      if (existingConfig) {
        const updates: UpdateWorkflowConfigInput = {
          name: name.trim(),
          description: description.trim() || undefined,
          steps,
          visibility: effectiveVisibility,
          shared_with_teams: effectiveSharedWithTeams,
        };
        await updateConfig(existingConfig._id, updates);
        return existingConfig._id;
      }

      const input: CreateWorkflowConfigInput = {
        name: name.trim(),
        description: description.trim() || undefined,
        steps,
        visibility: effectiveVisibility,
        shared_with_teams: effectiveSharedWithTeams,
      };
      const newId = await createConfig(input);
      openEditor("edit", newId);
      return newId;
    },
    [
      name,
      description,
      steps,
      visibility,
      sharedWithTeams,
      existingConfig,
      createConfig,
      updateConfig,
      openEditor,
      toast,
    ],
  );

  const doSave = useCallback(
    async (successMsg?: string) => {
      setIsSaving(true);
      try {
        const savedId = await persistWorkflow();
        if (!savedId) return;
        isDirtyRef.current = false;
        setUnsaved(false);
        toast(
          successMsg ??
            (existingConfig?.config_driven
              ? "Saved as a new editable workflow"
              : "Workflow saved"),
          "success",
        );
      } catch (error) {
        console.error("Failed to save workflow config:", error);
        toast(
          error instanceof Error ? error.message : "Failed to save workflow",
          "error",
        );
      } finally {
        setIsSaving(false);
      }
    },
    [persistWorkflow, existingConfig?.config_driven, setUnsaved, toast],
  );

  const handleSave = useCallback(async () => {
    if (visibility !== "private") {
      let gaps: AgentAccessGap[] = [];
      try {
        const res = await fetch("/api/workflow-configs/check-agent-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            steps,
            visibility,
            shared_with_teams: sharedWithTeams,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          gaps = data.gaps ?? [];
        }
      } catch {
        /* non-fatal — proceed to save */
      }
      if (gaps.length > 0) {
        setAgentAccessGaps(gaps);
        setShowAccessModal(true);
        return;
      }
    }
    await doSave();
  }, [doSave, visibility, steps, sharedWithTeams]);

  const handleGrantAndSave = useCallback(async () => {
    try {
      await grantAgentAccessGaps(agentAccessGaps);
      setShowAccessModal(false);
      setAgentAccessGaps([]);
      await doSave("Agent access granted and workflow saved");
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Failed to grant agent access",
        "error",
      );
    }
  }, [agentAccessGaps, doSave, toast]);

  const handleSaveAsPrivate = useCallback(async () => {
    setIsSaving(true);
    try {
      const savedId = await persistWorkflow({
        visibility: "private",
        shared_with_teams: [],
      });
      if (!savedId) return;
      setVisibility("private");
      setSharedWithTeams([]);
      setShowAccessModal(false);
      setAgentAccessGaps([]);
      isDirtyRef.current = false;
      setUnsaved(false);
      toast("Workflow saved as private", "success");
    } catch (error) {
      console.error("Failed to save workflow as private:", error);
      toast(
        error instanceof Error ? error.message : "Failed to save workflow",
        "error",
      );
    } finally {
      setIsSaving(false);
    }
  }, [persistWorkflow, setUnsaved, toast]);

  // -----------------------------------------------------------------------
  // Run workflow
  // -----------------------------------------------------------------------

  const handleRun = useCallback(async () => {
    if (!existingConfig) return;

    if (isReadOnly && isDirtyRef.current) {
      toast(
        "Unsaved changes cannot be applied to a config-driven workflow. Click Save to create an editable copy, or Clone to edit, then run that copy.",
        "error",
      );
      return;
    }

    setIsSaving(true);
    let configId = existingConfig._id;
    try {
      if (isDirtyRef.current) {
        const savedId = await persistWorkflow();
        if (!savedId) return;
        configId = savedId;
        isDirtyRef.current = false;
        setUnsaved(false);
      }

      const runId = await executeWorkflow(configId);
      closeEditor();
      router.push(`/workflows/run/${runId}`);
    } catch (error) {
      console.error("Failed to execute workflow:", error);
      toast(
        error instanceof Error ? error.message : "Failed to start workflow",
        "error",
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    existingConfig,
    isReadOnly,
    persistWorkflow,
    executeWorkflow,
    setUnsaved,
    closeEditor,
    router,
    toast,
  ]);

  // -----------------------------------------------------------------------
  // Delete workflow
  // -----------------------------------------------------------------------

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleDelete = useCallback(() => {
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!existingConfig) return;
    try {
      await deleteConfig(existingConfig._id);
      isDirtyRef.current = false;
      setUnsaved(false);
      closeEditor();
      loadConfigs();
    } catch (error) {
      console.error("Failed to delete workflow:", error);
    } finally {
      setShowDeleteDialog(false);
    }
  }, [existingConfig, deleteConfig, setUnsaved, closeEditor, loadConfigs]);

  // -----------------------------------------------------------------------
  // Export / Import workflow YAML
  // -----------------------------------------------------------------------

  const handleExport = useCallback(() => {
    const config: Record<string, unknown> = {
      name,
      description: description || undefined,
      visibility,
      ...(visibility === "team" && sharedWithTeams.length > 0
        ? { shared_with_teams: sharedWithTeams }
        : {}),
      steps,
    };
    const blob = new Blob([YAML.stringify(config)], {
      type: "application/x-yaml",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "workflow"}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [name, description, steps, visibility, sharedWithTeams]);

  const handleImport = useCallback(
    (parsed: unknown) => {
      if (!parsed || typeof parsed !== "object") return;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.name === "string") setName(obj.name);
      if (typeof obj.description === "string") setDescription(obj.description);
      if (
        obj.visibility === "private" ||
        obj.visibility === "team" ||
        obj.visibility === "global"
      ) {
        setVisibility(obj.visibility);
      }
      if (Array.isArray(obj.shared_with_teams)) {
        const refs = (obj.shared_with_teams as string[]).map((ref) =>
          ref.trim().toLowerCase(),
        );
        setSharedWithTeams(
          refs
            .map((ref) => {
              const bySlug = availableTeams.find(
                (t) => t.slug.toLowerCase() === ref,
              );
              if (bySlug) return bySlug.slug;
              const byId = availableTeams.find((t) => t._id === ref);
              return byId?.slug ?? ref;
            })
            .filter(Boolean),
        );
      }
      if (Array.isArray(obj.steps)) {
        setSteps(obj.steps as WorkflowStep[]);
      }
      markDirty();
    },
    [availableTeams, markDirty],
  );

  // Agent objects for the sidebar (with _id, name, description, ui)
  const sidebarAgents = useMemo(
    () =>
      agents.map((a) => ({
        _id: a.value,
        name: a.label,
        description: a.description,
        ui: a.ui,
      })),
    [agents],
  );

  // -----------------------------------------------------------------------
  // Unsaved changes dialog handlers
  // -----------------------------------------------------------------------

  const handleDiscardChanges = useCallback(() => {
    setShowUnsavedDialog(false);
    isDirtyRef.current = false;
    setUnsaved(false);
    pendingActionRef.current?.();
    pendingActionRef.current = null;
    cancelNavigation();
  }, [setUnsaved, cancelNavigation]);

  const handleCancelUnsavedDialog = useCallback(() => {
    setShowUnsavedDialog(false);
    pendingActionRef.current = null;
    cancelNavigation();
  }, [cancelNavigation]);

  // -----------------------------------------------------------------------
  // Mark selected node visually
  // -----------------------------------------------------------------------

  const nodesWithSelection = useMemo(() => {
    if (selectedStepIndex < 0) return nodes;
    const selectedId = `step-${selectedStepIndex}`;
    return nodes.map((n) =>
      n.id === selectedId
        ? { ...n, selected: true }
        : { ...n, selected: false },
    );
  }, [nodes, selectedStepIndex]);

  return (
    <div className="flex flex-col h-full">
      <WorkflowToolbar
        name={name}
        description={description}
        onNameChange={handleNameChange}
        onDescriptionChange={handleDescriptionChange}
        onSave={handleSave}
        onBack={handleBack}
        onRun={handleRun}
        onDelete={handleDelete}
        onExport={handleExport}
        onImport={handleImport}
        isSaving={isSaving}
        isEditing={!!existingConfig}
        hasUnsavedChanges={hasUnsavedChanges}
        stepCount={steps.length}
        readOnly={isReadOnly}
        saveAsCopy={isConfigDriven}
        readOnlyHint={readOnlyHint}
        onCloneToEdit={existingConfig ? handleCloneToEdit : undefined}
        visibility={visibility}
        onVisibilityChange={(v) => {
          setVisibility(v);
          markDirty();
        }}
        sharedWithTeams={sharedWithTeams}
        onSharedWithTeamsChange={(t) => {
          setSharedWithTeams(t);
          markDirty();
        }}
        teams={availableTeams}
        authzDocument={existingConfig}
      />

      {isReadOnly && readOnlyHint && (
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-start gap-2 shrink-0">
          <Lock className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
            {readOnlyHint}
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          <ReactFlow
            nodes={nodesWithSelection}
            edges={edges}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.5, maxZoom: 1.5 }}
            className="bg-background"
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
          >
            <CanvasControls />
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="hsl(var(--muted-foreground) / 0.15)"
            />
          </ReactFlow>
        </div>

        <WorkflowStepSidebar
          step={selectedStep}
          stepIndex={selectedStepIndex}
          onChange={handleStepChange}
          onDelete={handleDeleteStep}
          onAddStep={
            isReadOnly
              ? undefined
              : () => {
                  markDirty();
                  const newStep = createBlankStep();
                  setSteps((prev) => [...prev, newStep]);
                  setSelectedStepIndex(0);
                }
          }
          agents={sidebarAgents}
          agentsLoading={agentsLoading}
          readOnly={isReadOnly}
          readOnlyHint={readOnlyHint}
        />
      </div>

      <UnsavedChangesDialog
        open={showUnsavedDialog}
        onDiscard={handleDiscardChanges}
        onCancel={handleCancelUnsavedDialog}
        description="You have unsaved changes in this workflow. They will be lost if you leave without saving."
      />

      {showAccessModal && agentAccessGaps.length > 0 && (
        <WorkflowAgentAccessModal
          gaps={agentAccessGaps}
          visibility={visibility}
          onGrantAndSave={handleGrantAndSave}
          onSaveAsPrivate={handleSaveAsPrivate}
          onCancel={() => {
            setShowAccessModal(false);
            setAgentAccessGaps([]);
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 shadow-xl max-w-sm mx-4">
            <h3 className="text-sm font-bold text-foreground mb-2">
              Delete workflow
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Are you sure you want to delete &ldquo;{name}&rdquo;? This cannot
              be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteDialog(false)}
                className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
