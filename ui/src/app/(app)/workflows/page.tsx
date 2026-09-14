"use client";

import { Button } from "@/components/ui/button";
import { WorkflowCanvas } from "@/components/workflows/WorkflowCanvas";
import { useWorkflowConfigStore } from "@/store/workflow-config-store";
import { useWorkflowExecStore } from "@/store/workflow-exec-store";
import type { WorkflowStep } from "@/types/workflow-config";
import { Bot,GitBranch,Play,Plus,Workflow } from "lucide-react";
import { useRouter,useSearchParams } from "next/navigation";
import { useEffect,useMemo,useState } from "react";

export default function WorkflowsPage() {
  const { configs, editMode, selectedConfigId, closeEditor, loadConfigs, openEditor } =
    useWorkflowConfigStore();
  const { runs, loadRuns } = useWorkflowExecStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const workflowId = searchParams.get("workflow");

  // Fetch agents count
  const [agentCount, setAgentCount] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/dynamic-agents/available")
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
        setAgentCount(list.length);
      })
      .catch(() => setAgentCount(null));
    loadConfigs();
    loadRuns();
  }, [loadConfigs, loadRuns]);

  useEffect(() => {
    if (!workflowId || !configs.some((config) => config._id === workflowId)) return;
    openEditor("edit", workflowId);
  }, [configs, openEditor, workflowId]);

  const selectedConfig = useMemo(
    () => (selectedConfigId ? configs.find((c) => c._id === selectedConfigId) : undefined),
    [configs, selectedConfigId]
  );

  const handleBack = () => {
    closeEditor();
    loadConfigs();
    if (workflowId) router.replace("/workflows");
  };

  // Clone: pre-populate from the selected config
  const cloneProps = useMemo(() => {
    if (editMode !== "clone" || !selectedConfig) return {};
    return {
      initialName: `${selectedConfig.name} (Copy)`,
      initialDescription: selectedConfig.description || undefined,
      initialSteps: selectedConfig.steps
        .filter((s): s is WorkflowStep => s.type === "step")
        .map((s) => ({ ...s })),
    };
  }, [editMode, selectedConfig]);

  // Editor mode
  if (editMode === "edit" && selectedConfig) {
    return (
      <div className="flex-1 overflow-hidden">
        <WorkflowCanvas key={selectedConfig._id} existingConfig={selectedConfig} onBack={handleBack} />
      </div>
    );
  }

  if (editMode === "clone") {
    return (
      <div className="flex-1 overflow-hidden">
        <WorkflowCanvas
          key={`clone-${selectedConfigId}`}
          {...cloneProps}
          onBack={handleBack}
        />
      </div>
    );
  }

  if (editMode === "new") {
    return (
      <div className="flex-1 overflow-hidden">
        <WorkflowCanvas key="new" onBack={handleBack} />
      </div>
    );
  }

  // Landing state — welcome page
  const stats = [
    { icon: GitBranch, label: "Workflows", value: configs.length },
    { icon: Play, label: "Runs", value: runs.length },
    ...(agentCount !== null ? [{ icon: Bot, label: "Agents Available", value: agentCount }] : []),
  ];

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          <Workflow className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-xl font-bold text-foreground mb-2">
          Workflows
        </h2>
        <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
          Chain multiple agents together into automated, multi-step workflows.
          Each step runs an agent with its own prompt, skills, and tools.
        </p>

        <Button
          onClick={() => openEditor("new")}
          className="gap-2 gradient-primary text-white mb-8"
        >
          <Plus className="h-4 w-4" />
          Create Workflow
        </Button>

        {stats.length > 0 && (
          <div className="flex items-center justify-center gap-6">
            {stats.map((stat) => (
              <div key={stat.label} className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <stat.icon className="h-3.5 w-3.5" />
                  <span className="text-xs">{stat.label}</span>
                </div>
                <span className="text-lg font-semibold text-foreground">{stat.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
