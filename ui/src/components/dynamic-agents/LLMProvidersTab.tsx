"use client";

// assisted-by Codex Codex-sonnet-4-6

import { AlertTriangle,CheckCircle2,KeyRound,Loader2,Settings } from "lucide-react";
import React from "react";

import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ProviderField = {
  id: string;
  label: string;
  secretType: "api_key" | "custom";
  placeholder?: string;
};

type ProviderDefinition = {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  fields: ProviderField[];
};

type SecretMetadata = {
  id: string;
  name: string;
  type: string;
  maskedPreview?: string;
};

type LlmModel = {
  model_id: string;
  name: string;
  provider: string;
};

const PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT and OpenAI-compatible model providers.",
    aliases: ["openai"],
    fields: [{ id: "api_key", label: "API Key", secretType: "api_key", placeholder: "sk-..." }],
  },
  {
    id: "anthropic-claude",
    name: "Anthropic Claude",
    description: "Claude models through the Anthropic API.",
    aliases: ["anthropic-claude", "anthropic", "claude"],
    fields: [{ id: "api_key", label: "API Key", secretType: "api_key", placeholder: "sk-ant-..." }],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    description: "OpenAI models hosted on Azure deployments.",
    aliases: ["azure-openai", "azure"],
    fields: [
      { id: "api_key", label: "API Key", secretType: "api_key" },
      { id: "endpoint", label: "Endpoint", secretType: "custom", placeholder: "https://resource.openai.azure.com/" },
      { id: "api_version", label: "API Version", secretType: "custom", placeholder: "2024-02-01" },
    ],
  },
  {
    id: "aws-bedrock",
    name: "AWS Bedrock",
    description: "Claude and other foundation models through AWS Bedrock.",
    aliases: ["aws-bedrock", "bedrock", "aws"],
    fields: [
      { id: "access_key_id", label: "Access Key ID", secretType: "custom", placeholder: "AKIA..." },
      { id: "secret_access_key", label: "Secret Access Key", secretType: "api_key" },
      { id: "region", label: "Region", secretType: "custom", placeholder: "us-east-1" },
    ],
  },
  {
    id: "google-genai",
    name: "Google Gemini",
    description: "Gemini models through Google AI APIs.",
    aliases: ["google-genai", "google-gemini", "gemini", "google"],
    fields: [{ id: "api_key", label: "API Key", secretType: "api_key" }],
  },
];

function secretName(providerId: string, fieldId: string): string {
  return `llm:${providerId}:${fieldId}`;
}

function providerForModel(provider: string): ProviderDefinition | null {
  const normalized = provider.toLowerCase();
  return PROVIDERS.find((definition) => definition.aliases.some((alias) => normalized.includes(alias))) ?? null;
}

async function parseData<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { data?: T; success?: boolean; error?: string };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || "Request failed");
  }
  return payload.data as T;
}

function ProviderCredentialDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: ProviderDefinition;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      for (const field of provider.fields) {
        const value = values[field.id]?.trim();
        if (!value) continue;
        await fetch("/api/credentials/secrets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: secretName(provider.id, field.id),
            type: field.secretType,
            description: `${provider.name} ${field.label}`,
            value,
          }),
        }).then(async (response) => {
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `Could not save ${field.label}`);
          }
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider credentials");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Configure ${provider.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <form onSubmit={handleSave} className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">Connect {provider.name}</h2>
            <p className="text-sm text-muted-foreground">
              Values are saved as protected secrets. Existing secrets are left unchanged.
            </p>
          </div>
          <button type="button" className="text-sm text-muted-foreground" onClick={onClose}>
            Close
          </button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          {provider.fields.map((field) => (
            <label key={field.id} className="space-y-1 text-sm">
              <Label htmlFor={`${provider.id}-${field.id}`}>{field.label}</Label>
              <Input
                id={`${provider.id}-${field.id}`}
                aria-label={field.label}
                placeholder={field.placeholder}
                type={field.secretType === "api_key" ? "password" : "text"}
                value={values[field.id] ?? ""}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
              />
            </label>
          ))}
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={saving || Object.values(values).every((value) => !value.trim())}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Connection
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export function LLMProvidersTab() {
  const [models, setModels] = React.useState<LlmModel[]>([]);
  const [secrets, setSecrets] = React.useState<SecretMetadata[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editingProvider, setEditingProvider] = React.useState<ProviderDefinition | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [modelsResult, secretsResult] = await Promise.all([
        fetch("/api/llm-models?page_size=100").then((response) =>
          parseData<{ items?: LlmModel[] }>(response),
        ),
        fetch("/api/credentials/secrets")
          .then((response) => (response.ok ? parseData<SecretMetadata[]>(response) : []))
          .catch(() => []),
      ]);
      setModels(modelsResult.items ?? []);
      setSecrets(secretsResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load LLM providers");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const modelProviders = React.useMemo(() => {
    const ids = new Set(models.map((model) => providerForModel(model.provider)?.id ?? model.provider));
    return PROVIDERS.filter((provider) => ids.has(provider.id));
  }, [models]);

  const visibleProviders = modelProviders.length > 0 ? modelProviders : PROVIDERS;
  const configuredSecretNames = new Set(secrets.map((secret) => secret.name));

  return (
    <section className="space-y-6">
      <WorkspacePageActions>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Settings className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </WorkspacePageActions>
      <Card className="rounded-none border-0 bg-transparent shadow-none">
        <CardContent className="space-y-4 px-0 pt-0">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleProviders.map((provider) => {
              const configuredFields = provider.fields.filter((field) =>
                configuredSecretNames.has(secretName(provider.id, field.id)),
              );
              const configured = configuredFields.length > 0;
              return (
                <Card key={provider.id} className="border-border/70">
                  <CardHeader className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{provider.name}</CardTitle>
                      {configured ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
                          <KeyRound className="h-3.5 w-3.5" />
                          Needs secret
                        </span>
                      )}
                    </div>
                    <CardDescription>{provider.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Saved as: {provider.fields.map((field) => secretName(provider.id, field.id)).join(", ")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Connect ${provider.name}`}
                      onClick={() => setEditingProvider(provider)}
                    >
                      Connect provider
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {editingProvider && (
        <ProviderCredentialDialog
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
          onSaved={() => void load()}
        />
      )}
    </section>
  );
}
