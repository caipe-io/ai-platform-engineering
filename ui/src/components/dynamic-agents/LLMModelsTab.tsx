"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { ModelConnectionTest } from "./ModelConnectionTest";
import { Select } from "@/components/ui/select";
import type { ModelConnection } from "@/lib/model-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

function LLMModelEditor({
  model,
  readOnly,
  onSave,
  onCancel,
}: LLMModelEditorProps) {
  const isEditing = !!model;
  const [modelId, setModelId] = React.useState(
    model?.upstream_model_id ?? model?.model_id ?? "",
  );
  const [connections, setConnections] = React.useState<ModelConnection[]>([]);
  const [connectionId, setConnectionId] = React.useState(
    model?.connection_id ?? "",
  );
  React.useEffect(() => {
    void fetch("/api/llm-models/connections")
      .then((response) => response.json())
      .then((payload) => {
        if (payload.success) setConnections(payload.data.connections);
      })
      .catch(() =>
        setError(
          "Saved connections could not be loaded. Retry from Model Providers.",
        ),
      );
  }, []);
  const [name, setName] = React.useState(model?.name ?? "");
  const [provider, setProvider] = React.useState(model?.provider ?? "");
  const [description, setDescription] = React.useState(
    model?.description ?? "",
  );
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
        if (!data.success)
          throw new Error(data.error || "Failed to update model");
      } else {
        if (!modelId) throw new Error("Model ID is required");
        const response = await fetch("/api/llm-models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: modelId,
            name,
            provider,
            description,
            ...(connectionId ? { connection_id: connectionId } : {}),
          }),
        });
        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "Failed to create model");
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
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onCancel}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <CardTitle>
              {readOnly
                ? "View Model"
                : isEditing
                  ? "Edit Model"
                  : "Add LLM Model"}
            </CardTitle>
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

        <fieldset
          disabled={readOnly}
          className={readOnly ? "opacity-70 space-y-4" : "space-y-4"}
        >
          {!isEditing && !readOnly && (
            <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-yellow-700 dark:text-yellow-300">
                Make sure this model provider is connected before assigning the
                model to an agent.
              </p>
            </div>
          )}

          {!isEditing && (
            <div className="space-y-2">
              <Label htmlFor="model-connection">Connection</Label>
              <Select
                id="model-connection"
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  const selected = connections.find(
                    (item) => item._id === event.target.value,
                  );
                  if (selected) setProvider(selected.provider);
                }}
              >
                <option value="">Deployment settings</option>
                {connections.map((item) => (
                  <option key={item._id} value={item._id}>
                    {item.name} · {item.provider}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {model?.connection_name && (
            <p className="text-sm text-muted-foreground">
              Connection: {model.connection_name}. Manage credentials in Model
              Providers or Saved Secrets.
            </p>
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
              disabled={Boolean(connectionId)}
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

        <ModelConnectionTest
          request={
            model
              ? { model_id: model._id }
              : connectionId
                ? { connection_id: connectionId, upstream_model_id: modelId }
                : {
                    draft: { provider, auth_mode: "deployment", fields: {} },
                    upstream_model_id: modelId,
                  }
          }
          disabled={!modelId || !provider || saving}
        />
        <div className="flex gap-2 pt-2">
          {readOnly && (
            <span className="text-xs text-muted-foreground mr-auto self-center">
              Config-driven — managed by configuration file
            </span>
          )}
          {!readOnly && (
            <Button
              onClick={handleSave}
              disabled={
                saving || !name || !provider || (!isEditing && !modelId)
              }
            >
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
  const [editingModel, setEditingModel] = React.useState<LLMModelConfig | null>(
    null,
  );
  const [selectionLoading, setSelectionLoading] = React.useState(false);
  const [selectionError, setSelectionError] = React.useState<string | null>(
    null,
  );
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
        const response = await fetch(
          `/api/llm-models?id=${encodeURIComponent(selectedModelId)}`,
        );
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
          setSelectionError(
            err instanceof Error ? err.message : "Failed to load LLM model",
          );
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
          <Button
            variant="outline"
            size="sm"
            onClick={fetchModels}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            data-tour="add-model"
            size="sm"
            onClick={() => setIsCreating(true)}
          >
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
            <div className="w-full overflow-x-auto rounded-lg border border-border/60">
              <table
                className="w-full min-w-[1056px] table-fixed text-left text-sm"
                aria-label="LLM models"
              >
                <colgroup>
                  <col className="w-[29%]" />
                  <col className="w-[22%]" />
                  <col className="w-[14%]" />
                  <col />
                  <col className="w-72" />
                </colgroup>
                <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Model ID
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Display Name
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Provider
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Description
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-3 text-right font-medium"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {models.map((model) => (
                    <tr
                      key={model._id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => openModel(model)}
                    >
                      <td className="px-3 py-3 align-middle">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/10">
                            <Cpu className="h-4 w-4 text-purple-500" />
                          </div>
                          <div className="min-w-0">
                            <button
                              type="button"
                              className="block max-w-full break-all text-left font-mono text-sm font-medium hover:underline focus-visible:underline"
                              onClick={(event) => {
                                event.stopPropagation();
                                openModel(model);
                              }}
                            >
                              {model.upstream_model_id ?? model.model_id}
                            </button>
                            {model.connection_name && (
                              <p
                                className="mt-1 truncate text-xs text-muted-foreground"
                                title={model.connection_name}
                              >
                                {model.connection_name}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate" title={model.name}>
                            {model.name}
                          </span>
                          {model.config_driven && (
                            <Badge
                              variant="outline"
                              className="shrink-0 text-xs text-muted-foreground"
                              title="Managed by configuration"
                            >
                              Config
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <Badge
                          variant="outline"
                          className={`max-w-full ${getProviderColor(model.provider)}`}
                          title={model.provider}
                        >
                          <span className="truncate">{model.provider}</span>
                        </Badge>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <span
                          className="block truncate text-muted-foreground"
                          title={model.description || undefined}
                        >
                          {model.description || "—"}
                        </span>
                      </td>
                      <td
                        className="px-3 py-3 align-middle"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-1">
                          <ModelConnectionTest
                            compact
                            request={{ model_id: model._id }}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => handleExportYaml(model)}
                            title="Export as YAML"
                          >
                            <Download className="h-4 w-4" />
                            <span className="sr-only">
                              Export {model.name} as YAML
                            </span>
                          </Button>
                          {!model.config_driven ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                              onClick={() => handleDelete(model._id)}
                              aria-label={`Delete ${model.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : (
                            <span
                              aria-hidden="true"
                              className="h-8 w-8 shrink-0"
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
