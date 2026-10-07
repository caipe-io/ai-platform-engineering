"use client";

import { getErrorMessage } from "@/lib/error-utils";

// assisted-by Codex Codex-sonnet-4-6

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toYaml } from "@/lib/yaml-serializer";
import type { LLMModelConfig } from "@/types/dynamic-agent";
import {
AlertTriangle,
ArrowLeft,
Cpu,
Download,
Loader2,
Plus,
RefreshCw,
Trash2,
} from "lucide-react";
import React from "react";

// ═══════════════════════════════════════════════════════════════
// Editor (inline create/edit form)
// ═══════════════════════════════════════════════════════════════

interface LLMModelEditorProps {
  model: LLMModelConfig | null; // null = create mode
  readOnly?: boolean;
  onSave: () => void;
  onCancel: () => void;
}

function LLMModelEditor({ model, readOnly, onSave, onCancel }: LLMModelEditorProps) {
  const isEditing = !!model;
  const [modelId, setModelId] = React.useState(model?.model_id ?? "");
  const [name, setName] = React.useState(model?.name ?? "");
  const [provider, setProvider] = React.useState(model?.provider ?? "");
  const [description, setDescription] = React.useState(model?.description ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (isEditing) {
        const response = await fetch(`/api/llm-models?id=${model._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, provider, description }),
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || "Failed to update model");
      } else {
        if (!modelId) throw new Error("Model ID is required");
        const response = await fetch("/api/llm-models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId, name, provider, description }),
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || "Failed to create model");
      }
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onCancel}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <CardTitle>{readOnly ? "View Model" : isEditing ? "Edit Model" : "Add LLM Model"}</CardTitle>
            <CardDescription>
              {readOnly
                ? "This model is managed by configuration and cannot be edited."
                : isEditing
                ? "Update how this model appears to agent builders."
                : "Add a model that agents can use."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <fieldset disabled={readOnly} className={readOnly ? "opacity-70 space-y-4" : "space-y-4"}>
          {!isEditing && !readOnly && (
            <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-yellow-700 dark:text-yellow-300">
                Make sure this model provider is connected before assigning the model to an agent.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="model-id">Model ID</Label>
            <Input
              id="model-id"
              placeholder="e.g. gpt-4o, claude-sonnet-4-20250514, gemini-2.0-flash"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={isEditing}
            />
            <p className="text-xs text-muted-foreground">
              Unique model identifier. This cannot be changed after creation.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="model-name">Display Name</Label>
            <Input
              id="model-name"
              placeholder="e.g. GPT-4o, Claude Sonnet 4, Gemini 2.0 Flash"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="model-provider">Provider</Label>
            <Input
              id="model-provider"
              placeholder="e.g. openai, anthropic-claude, google-genai, bedrock"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use the provider name configured for this model.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="model-description">Description (optional)</Label>
            <Input
              id="model-description"
              placeholder="Brief description of the model"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </fieldset>

        <div className="flex gap-2 pt-2">
          {readOnly && (
            <span className="text-xs text-muted-foreground mr-auto self-center">
              Config-driven — managed by configuration file
            </span>
          )}
          {!readOnly && (
            <Button onClick={handleSave} disabled={saving || !name || !provider || (!isEditing && !modelId)}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isEditing ? "Save Changes" : "Add Model"}
            </Button>
          )}
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// Provider badge colors
// ═══════════════════════════════════════════════════════════════

function getProviderColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("openai") || p.includes("gpt")) {
    return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30";
  }
  if (p.includes("anthropic") || p.includes("claude")) {
    return "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30";
  }
  if (p.includes("google") || p.includes("gemini")) {
    return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30";
  }
  if (p.includes("bedrock") || p.includes("aws")) {
    return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30";
  }
  if (p.includes("azure")) {
    return "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30";
  }
  return "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30";
}

// ═══════════════════════════════════════════════════════════════
// Main tab component
// ═══════════════════════════════════════════════════════════════

export interface LLMModelsTabProps {
  selectedModelId?: string | null;
  onSelectedModelChange?: (modelId: string | null) => void;
}

export function LLMModelsTab({
  selectedModelId,
  onSelectedModelChange,
}: LLMModelsTabProps = {}) {
  const [models, setModels] = React.useState<LLMModelConfig[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editingModel, setEditingModel] = React.useState<LLMModelConfig | null>(null);
  const [selectionLoading, setSelectionLoading] = React.useState(false);
  const [selectionError, setSelectionError] = React.useState<string | null>(null);
  const selectionRequestRef = React.useRef(0);
  const loadedSelectionIdRef = React.useRef<string | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);

  const fetchModels = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/llm-models?page_size=100");
      const data = await response.json();
      if (data.success) {
        setModels(data.data.items || []);
      } else {
        setError(data.error || "Failed to fetch models");
      }
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to fetch models");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  React.useEffect(() => {
    if (selectedModelId === undefined) return;

    const requestId = ++selectionRequestRef.current;
    if (!selectedModelId) {
      loadedSelectionIdRef.current = null;
      setEditingModel(null);
      setSelectionError(null);
      setSelectionLoading(false);
      return;
    }

    if (loadedSelectionIdRef.current === selectedModelId) {
      setSelectionError(null);
      setSelectionLoading(false);
      return;
    }

    setSelectionLoading(true);
    setSelectionError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/llm-models?id=${encodeURIComponent(selectedModelId)}`);
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "LLM model not found");
        }
        if (selectionRequestRef.current === requestId) {
          loadedSelectionIdRef.current = selectedModelId;
          setEditingModel(data.data as LLMModelConfig);
        }
      } catch (err: unknown) {
        if (selectionRequestRef.current === requestId) {
          loadedSelectionIdRef.current = null;
          setEditingModel(null);
          setSelectionError(err instanceof Error ? err.message : "Failed to load LLM model");
        }
      } finally {
        if (selectionRequestRef.current === requestId) {
          setSelectionLoading(false);
        }
      }
    })();
  }, [selectedModelId]);

  const handleDelete = async (modelId: string) => {
    if (!confirm("Are you sure you want to delete this model?")) return;

    try {
      const response = await fetch(`/api/llm-models?id=${modelId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (data.success) {
        fetchModels();
      } else {
        alert(data.error || "Failed to delete model");
      }
    } catch (err) {
      alert(getErrorMessage(err, "") || "Failed to delete model");
    }
  };

  /**
   * Export model configuration as YAML file
   */
  const handleExportYaml = (model: LLMModelConfig) => {
    const exportConfig = {
      model_id: model.model_id,
      name: model.name,
      provider: model.provider,
      description: model.description || undefined,
    };

    const yamlContent = toYaml(exportConfig);
    const blob = new Blob([yamlContent], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${model.model_id}.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openModel = (model: LLMModelConfig) => {
    loadedSelectionIdRef.current = model._id;
    setSelectionError(null);
    setEditingModel(model);
    onSelectedModelChange?.(model._id);
  };

  const closeModelEditor = () => {
    selectionRequestRef.current += 1;
    loadedSelectionIdRef.current = null;
    setEditingModel(null);
    setIsCreating(false);
    setSelectionError(null);
    setSelectionLoading(false);
    onSelectedModelChange?.(null);
  };

  const hasMatchingSelectedModel = editingModel?._id === selectedModelId;

  if (selectedModelId && selectionLoading && !hasMatchingSelectedModel) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (selectedModelId && selectionError && !hasMatchingSelectedModel) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive">{selectionError}</p>
          <Button variant="outline" className="mt-4" onClick={closeModelEditor}>
            Back to LLM Models
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isCreating || editingModel) {
    return (
      <LLMModelEditor
        key={editingModel?._id ?? "new"}
        model={editingModel}
        readOnly={editingModel?.config_driven}
        onSave={() => {
          closeModelEditor();
          fetchModels();
        }}
        onCancel={closeModelEditor}
      />
    );
  }

  return (
    <>
      <WorkspacePageActions>
        <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={fetchModels} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Model
            </Button>
        </div>
      </WorkspacePageActions>
      <Card className="rounded-none border-0 bg-transparent shadow-none">
        <CardContent className="px-0 pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={fetchModels}>
              Retry
            </Button>
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-12">
            <Cpu className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No LLM Models Yet</h3>
            <p className="text-muted-foreground mb-4">
              Add a model before assigning one to an agent.
            </p>
            <Button onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Model
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Header */}
            <div className="grid grid-cols-12 gap-4 pb-2 border-b text-xs font-medium text-muted-foreground px-2">
              <div className="col-span-3">Model ID</div>
              <div className="col-span-3">Display Name</div>
              <div className="col-span-2">Provider</div>
              <div className="col-span-2">Description</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>

            {/* Model rows */}
            {models.map((model) => (
              <div
                key={model._id}
                className="grid grid-cols-12 gap-4 py-3 px-2 rounded-lg hover:bg-muted/50 items-center cursor-pointer"
                onClick={() => openModel(model)}
              >
                <div className="col-span-3">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-purple-500/10 flex items-center justify-center">
                      <Cpu className="h-5 w-5 text-purple-500" />
                    </div>
                    <div>
                      <div className="font-medium text-sm font-mono">{model.model_id}</div>
                    </div>
                  </div>
                </div>

                <div className="col-span-3">
                  <span className="text-sm">{model.name}</span>
                </div>

                <div className="col-span-2">
                  <Badge variant="outline" className={`gap-1 ${getProviderColor(model.provider)}`}>
                    {model.provider}
                  </Badge>
                </div>

                <div className="col-span-2">
                  <span className="text-sm text-muted-foreground truncate block max-w-[200px]">
                    {model.description || "—"}
                  </span>
                </div>

                <div className="col-span-2 flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleExportYaml(model)}
                    title="Export as YAML"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {model.config_driven && (
                    <Badge
                      variant="outline"
                      className="gap-1 bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30"
                      title="Loaded from config.yaml - cannot be edited"
                    >
                      Config
                    </Badge>
                  )}
                  {!model.config_driven && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(model._id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        </CardContent>
      </Card>
    </>
  );
}
