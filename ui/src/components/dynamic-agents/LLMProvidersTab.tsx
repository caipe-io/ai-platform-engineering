"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  KeyRound,
  Loader2,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import React from "react";
import { SecretProtectionBadge } from "@/components/credentials/SecretProtectionDetails";
import { SavedSecretPicker } from "@/components/credentials/SavedSecretPicker";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ModelConnectionTest } from "./ModelConnectionTest";
import type { ModelConnection } from "@/lib/model-connections";
import type { LLMModelConfig } from "@/types/dynamic-agent";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  LLM_PROVIDERS,
  providerBindingsWithLegacySecrets,
  providerFieldAcceptsSecret,
  type ProviderDefinition,
  type ProviderSecretBindings,
  type SavedProviderSecret,
} from "@/lib/llm-provider-credentials";

async function parseData<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as {
    data?: T;
    success?: boolean;
    error?: string;
  };
  if (!response.ok || payload.success === false)
    throw new Error(payload.error || "Request failed");
  return payload.data as T;
}

type FieldSource = { mode: "saved" | "new"; secretId?: string; value: string };

function ProviderCredentialDialog({
  provider,
  secrets,
  initialBindings,
  onClose,
  onSaved,
}: {
  provider: ProviderDefinition;
  secrets: SavedProviderSecret[];
  initialBindings: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const availableSecrets = secrets;
  const [connectionName, setConnectionName] = React.useState("");
  const [modelIds, setModelIds] = React.useState("");
  const [compatible, setCompatible] = React.useState(false);
  const [noKey, setNoKey] = React.useState(false);
  const operation = React.useRef(crypto.randomUUID());
  const [sources, setSources] = React.useState<Record<string, FieldSource>>(
    () =>
      Object.fromEntries(
        provider.fields.map((field) => [
          field.id,
          {
            mode:
              initialBindings[field.id] ||
              secrets.some((secret) =>
                providerFieldAcceptsSecret(field, secret),
              )
                ? "saved"
                : "new",
            secretId: initialBindings[field.id],
            value: "",
          },
        ]),
      ),
  );
  const [bedrockAuth, setBedrockAuth] = React.useState(
    initialBindings.access_key_id || initialBindings.secret_access_key
      ? "keys"
      : "deployment",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const useDeployment =
    Boolean(provider.deploymentHelp) ||
    (provider.id === "aws-bedrock" && bedrockAuth === "deployment");

  const updateSource = (id: string, value: Partial<FieldSource>) =>
    setSources((current) => ({
      ...current,
      [id]: { ...current[id], ...value },
    }));

  const draft = {
    provider: compatible ? "openai-compatible" : provider.id,
    auth_mode: useDeployment ? "deployment" : noKey ? "none" : "secrets",
    fields: Object.fromEntries(
      Object.entries(sources)
        .filter(
          ([id, source]) =>
            !useDeployment &&
            !(noKey && id === "api_key") &&
            source.mode === "saved" &&
            source.secretId,
        )
        .map(([id, source]) => [id, source.secretId]),
    ),
    values: Object.fromEntries(
      Object.entries(sources)
        .filter(
          ([id, source]) =>
            !useDeployment &&
            !(noKey && id === "api_key") &&
            source.mode === "new" &&
            source.value.trim(),
        )
        .map(([id, source]) => [id, source.value.trim()]),
    ),
  };
  const upstreamIds = modelIds
    .split(/[,\n]/)
    .map((id) => id.trim())
    .filter(Boolean);
  const payload = JSON.stringify({
    ...draft,
    name: connectionName,
    models: upstreamIds,
  });
  React.useEffect(() => {
    operation.current = crypto.randomUUID();
  }, [payload]);
  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await fetch("/api/llm-models/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...JSON.parse(payload),
          operation_id: operation.current,
        }),
      }).then(parseData);
      onSaved();
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create model connection",
      );
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
      <form
        onSubmit={handleSave}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">Connect {provider.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose saved credentials or enter new values.{" "}
              {provider.id === "openai" &&
                "Any OpenAI-compatible endpoint is supported."}
            </p>
          </div>
          <button
            type="button"
            className="text-sm text-muted-foreground"
            disabled={saving}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="connection-name">Connection name</Label>
            <Input
              id="connection-name"
              value={connectionName}
              required
              maxLength={160}
              placeholder="Primary model gateway"
              disabled={saving}
              onChange={(event) => setConnectionName(event.target.value)}
            />
          </div>
          {provider.id === "openai" && (
            <div className="space-y-2">
              <Label htmlFor="connection-type">Provider type</Label>
              <Select
                id="connection-type"
                value={compatible ? "openai-compatible" : "openai"}
                disabled={saving}
                onChange={(event) =>
                  setCompatible(event.target.value === "openai-compatible")
                }
              >
                <option value="openai">OpenAI</option>
                <option value="openai-compatible">
                  Any OpenAI-compatible endpoint
                </option>
              </Select>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="connection-models">Model IDs</Label>
          <textarea
            id="connection-models"
            className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
            required
            disabled={saving}
            value={modelIds}
            onChange={(event) => setModelIds(event.target.value)}
            placeholder="Enter one model ID per line"
          />
          <p className="text-xs text-muted-foreground">
            Use the IDs exposed by your endpoint. Model discovery is not
            required. Azure uses deployment names.
          </p>
        </div>
        {provider.id === "openai" && (
          <div className="space-y-2">
            <Label htmlFor="connection-key-mode">Authentication</Label>
            <Select
              id="connection-key-mode"
              value={noKey ? "none" : "secrets"}
              disabled={saving}
              onChange={(event) => setNoKey(event.target.value === "none")}
            >
              <option value="secrets">Saved or new API key</option>
              <option value="none">Endpoint does not require a key</option>
            </Select>
          </div>
        )}
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            Saved securely in Saved Secrets
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Your values are encrypted when saved. Full values stay hidden after
            saving, and existing values are preserved.
          </p>
          <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
            <li className="flex items-start gap-2">
              <Share2
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>
                Use{" "}
                <strong className="font-medium text-foreground">Share</strong>{" "}
                on a saved secret to grant a team access.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Trash2
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>
                Use{" "}
                <strong className="font-medium text-foreground">Delete</strong>{" "}
                on a saved secret and confirm to remove it. This does not revoke
                the key at its provider.
              </span>
            </li>
          </ul>
          <NavigationProgressLink
            href="/credentials/secrets"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Manage Saved Secrets
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </NavigationProgressLink>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {provider.id === "aws-bedrock" && (
          <div className="space-y-2">
            <Label htmlFor="bedrock-auth">Authentication</Label>
            <Select
              id="bedrock-auth"
              value={bedrockAuth}
              disabled={saving}
              onChange={(event) => setBedrockAuth(event.target.value)}
            >
              <option value="deployment">Use deployment IAM credentials</option>
              <option value="keys">Use saved or new access keys</option>
            </Select>
          </div>
        )}
        {useDeployment ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            {provider.deploymentHelp ??
              "Uses the runtime’s existing AWS identity and region. No access key is stored by this form."}
          </p>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {provider.fields
              .filter((field) => !(noKey && field.id === "api_key"))
              .map((field) => {
                const source = sources[field.id];
                const options = availableSecrets.filter((secret) =>
                  providerFieldAcceptsSecret(field, secret),
                );
                const required =
                  field.required ||
                  (provider.id === "aws-bedrock" &&
                    field.id !== "session_token");
                const inputId = `${provider.id}-${field.id}`;
                return (
                  <div key={field.id} className="space-y-2 text-sm">
                    <Label htmlFor={inputId}>
                      {field.label}
                      {required && (
                        <span
                          aria-hidden="true"
                          className="ml-1 text-destructive"
                        >
                          *
                        </span>
                      )}
                    </Label>
                    <Select
                      aria-label={`${field.label} source`}
                      value={source.mode}
                      disabled={saving}
                      onChange={(event) =>
                        updateSource(field.id, {
                          mode: event.target.value as FieldSource["mode"],
                          value: "",
                        })
                      }
                    >
                      <option value="saved">Choose a saved secret</option>
                      <option value="new">Enter a new value</option>
                    </Select>
                    {source.mode === "saved" ? (
                      <SavedSecretPicker
                        id={inputId}
                        label={field.label}
                        secrets={options}
                        value={source.secretId}
                        disabled={saving}
                        onChange={(secretId) =>
                          updateSource(field.id, { secretId })
                        }
                      />
                    ) : (
                      <Input
                        id={inputId}
                        aria-label={field.label}
                        aria-describedby={`${inputId}-help`}
                        type={
                          field.inputType ??
                          (field.secretType === "api_key" ? "password" : "text")
                        }
                        required={required}
                        disabled={saving}
                        autoComplete="off"
                        placeholder={field.placeholder}
                        value={source.value}
                        onChange={(event) =>
                          updateSource(field.id, { value: event.target.value })
                        }
                      />
                    )}
                    <p
                      id={`${inputId}-help`}
                      className="text-xs leading-5 text-muted-foreground"
                    >
                      {source.mode === "saved"
                        ? "Only the secret reference is saved. Its value stays hidden."
                        : (field.help ??
                          "The new value will be encrypted in Saved Secrets.")}
                    </p>
                    {options.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No saved secrets available for this field. Enter a new
                        value to create one.
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        )}
        <div className="flex gap-2">
          <ModelConnectionTest
            request={{ draft, upstream_model_id: upstreamIds[0] }}
            disabled={saving || !upstreamIds.length}
          />
          <Button
            type="submit"
            disabled={saving || !connectionName.trim() || !upstreamIds.length}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
            Connection
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export function LLMProvidersTab(): React.ReactElement {
  const [secrets, setSecrets] = React.useState<SavedProviderSecret[]>([]);
  const [connections, setConnections] = React.useState<ModelConnection[]>([]);
  const [connectionModels, setConnectionModels] = React.useState<
    LLMModelConfig[]
  >([]);
  const [canManage, setCanManage] = React.useState(false);
  const [runtimeSupported, setRuntimeSupported] = React.useState(false);
  const [bindings, setBindings] = React.useState<ProviderSecretBindings>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [savedProvider, setSavedProvider] = React.useState<string | null>(null);
  const [editingProvider, setEditingProvider] =
    React.useState<ProviderDefinition | null>(null);
  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metadata, configuration, catalog] = await Promise.all([
        fetch("/api/credentials/secrets").then(
          parseData<SavedProviderSecret[]>,
        ),
        fetch("/api/credentials/llm-providers").then(
          parseData<{ bindings: ProviderSecretBindings }>,
        ),
        fetch("/api/llm-models/connections").then(
          parseData<{
            connections: ModelConnection[];
            models: LLMModelConfig[];
            can_manage: boolean;
            runtime_supported: boolean;
          }>,
        ),
      ]);
      setSecrets(metadata);
      setConnections(catalog.connections);
      setConnectionModels(catalog.models);
      setCanManage(catalog.can_manage);
      setRuntimeSupported(catalog.runtime_supported);
      setBindings(
        providerBindingsWithLegacySecrets(configuration.bindings, metadata),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load provider credentials",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-tour="model-providers" className="space-y-6">
      <WorkspacePageActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Settings className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </WorkspacePageActions>
      <p
        role="note"
        className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground"
      >
        Named connections bind an endpoint and credentials to specific models.
        Test them here, then select the model in an agent. Existing models
        continue using their deployment settings.
      </p>
      {!runtimeSupported && !loading && (
        <p role="alert" className="text-sm text-destructive">
          Creating saved connections requires a compatible Dynamic Agents
          runtime with its credential API configured.
        </p>
      )}
      {connections.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">Your model connections</h2>
          {connections.map((connection) => (
            <Card key={connection._id}>
              <CardHeader>
                <CardTitle className="text-base">{connection.name}</CardTitle>
                <CardDescription>
                  {connection.provider} ·{" "}
                  {connection.auth_mode === "deployment"
                    ? "Deployment identity"
                    : "Protected saved credentials"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {connectionModels
                  .filter((model) => model.connection_id === connection._id)
                  .map((model) => (
                    <div
                      key={model._id}
                      className="flex flex-wrap items-start justify-between gap-3 border-t pt-3"
                    >
                      <span className="font-mono text-sm">
                        {model.upstream_model_id}
                      </span>
                      <ModelConnectionTest request={{ model_id: model._id }} />
                    </div>
                  ))}
                <NavigationProgressLink
                  href="/credentials/secrets"
                  className="inline-block text-xs text-primary hover:underline"
                >
                  Share, rotate, or delete credentials in Saved Secrets
                </NavigationProgressLink>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Card className="rounded-none border-0 bg-transparent shadow-none">
        <CardContent className="space-y-4 px-0 pt-0">
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <span className="flex-1 text-sm">{error}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void load()}
              >
                Retry
              </Button>
            </div>
          )}
          {savedProvider && (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm"
            >
              <ShieldCheck
                className="h-4 w-4 text-primary"
                aria-hidden="true"
              />
              {savedProvider} connection and models saved. Test the connection
              below.{" "}
              <NavigationProgressLink
                href="/credentials/secrets"
                className="font-medium text-primary hover:underline"
              >
                Manage Saved Secrets
              </NavigationProgressLink>
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {LLM_PROVIDERS.map((provider) => {
              const fields = bindings[provider.id] ?? {};
              const selected = provider.fields.filter((field) =>
                secrets.some((secret) => secret.id === fields[field.id]),
              );
              const deployment =
                Boolean(provider.deploymentHelp) ||
                (provider.id === "aws-bedrock" &&
                  Object.hasOwn(bindings, provider.id) &&
                  Object.keys(fields).length === 0);
              const required =
                provider.id === "aws-bedrock"
                  ? ["access_key_id", "secret_access_key", "region"]
                  : provider.fields
                      .filter((field) => field.required)
                      .map((field) => field.id);
              const complete =
                selected.length > 0 &&
                required.every((id) =>
                  selected.some((field) => field.id === id),
                );
              return (
                <Card key={provider.id} className="border-border/70">
                  <CardHeader className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">
                        {provider.name}
                      </CardTitle>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs ${complete || deployment ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400"}`}
                      >
                        {complete || deployment ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <KeyRound className="h-3.5 w-3.5" />
                        )}
                        {deployment
                          ? provider.deploymentHelp
                            ? "Deployment identity"
                            : "Deployment IAM"
                          : complete
                            ? "Saved"
                            : selected.length
                              ? "Partly saved"
                              : "Needs credentials"}
                      </span>
                    </div>
                    <CardDescription>{provider.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      {deployment
                        ? "Using deployment credentials."
                        : `${selected.length} of ${provider.fields.length} saved-secret references selected.`}
                    </p>
                    {selected.length > 0 && <SecretProtectionBadge />}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        loading ||
                        Boolean(error) ||
                        !canManage ||
                        !runtimeSupported
                      }
                      aria-label={
                        provider.deploymentHelp
                          ? `View ${provider.name} requirements`
                          : `Connect ${provider.name}`
                      }
                      onClick={() => setEditingProvider(provider)}
                    >
                      {provider.deploymentHelp
                        ? "View requirements"
                        : "Add connection"}
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
          key={editingProvider.id}
          provider={editingProvider}
          secrets={secrets}
          initialBindings={bindings[editingProvider.id] ?? {}}
          onClose={() => {
            setEditingProvider(null);
            void load();
          }}
          onSaved={() => setSavedProvider(editingProvider.name)}
        />
      )}
    </section>
  );
}
