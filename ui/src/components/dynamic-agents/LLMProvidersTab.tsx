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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  LLM_PROVIDERS,
  providerBindingsWithLegacySecrets,
  providerFieldAcceptsSecret,
  providerSecretName,
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
  const [availableSecrets, setAvailableSecrets] = React.useState(secrets);
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

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const fields: Record<string, string> = {};
    if (!useDeployment) {
      for (const field of provider.fields) {
        const source = sources[field.id];
        const required =
          field.required ||
          (provider.id === "aws-bedrock" && field.id !== "session_token");
        if (source.mode === "saved") {
          if (source.secretId) {
            if (
              !availableSecrets.some(
                (secret) =>
                  secret.id === source.secretId &&
                  providerFieldAcceptsSecret(field, secret),
              )
            ) {
              setError(`Choose an available saved secret for ${field.label}.`);
              return;
            }
            fields[field.id] = source.secretId;
          } else if (required) {
            setError(
              `Choose a saved secret for ${field.label}, or enter a new value.`,
            );
            return;
          }
        } else {
          const value = source.value.trim();
          if (required && !value) {
            setError(`${field.label} is required.`);
            return;
          }
          if (field.inputType === "url" && value) {
            try {
              const url = new URL(value);
              if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw new Error("Invalid endpoint");
            } catch {
              setError(
                `${field.label} must be an HTTP or HTTPS URL without embedded credentials.`,
              );
              return;
            }
          }
        }
      }
    }
    setSaving(true);
    try {
      if (!useDeployment)
        for (const field of provider.fields) {
          const source = sources[field.id];
          if (source.mode !== "new" || !source.value.trim()) continue;
          const created = await fetch("/api/credentials/secrets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: providerSecretName(provider.id, field.id),
              type: field.secretType,
              description: `${provider.name} ${field.label}`,
              value: source.value.trim(),
            }),
          }).then(parseData<SavedProviderSecret>);
          if (!created?.id) throw new Error(`Could not save ${field.label}`);
          fields[field.id] = created.id;
          setAvailableSecrets((current) => [
            ...current.filter((secret) => secret.id !== created.id),
            {
              ...created,
              name: created.name || providerSecretName(provider.id, field.id),
              type: created.type || field.secretType,
            },
          ]);
          updateSource(field.id, {
            mode: "saved",
            secretId: created.id,
            value: "",
          });
        }
      await fetch("/api/credentials/llm-providers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, fields }),
      }).then(parseData);
      onSaved();
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save provider credentials",
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
            {provider.fields.map((field) => {
              const source = sources[field.id];
              const options = availableSecrets.filter((secret) =>
                providerFieldAcceptsSecret(field, secret),
              );
              const required =
                field.required ||
                (provider.id === "aws-bedrock" && field.id !== "session_token");
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
          {!provider.deploymentHelp && (
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
              Connection
            </Button>
          )}
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
      const [metadata, configuration] = await Promise.all([
        fetch("/api/credentials/secrets").then(
          parseData<SavedProviderSecret[]>,
        ),
        fetch("/api/credentials/llm-providers").then(
          parseData<{ bindings: ProviderSecretBindings }>,
        ),
      ]);
      setSecrets(metadata);
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
        These choices are saved for your account. Applying saved provider
        choices to model requests is not yet available; model requests currently
        use deployment credentials.
      </p>
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
              {savedProvider} details saved.{" "}
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
                      disabled={loading || Boolean(error)}
                      aria-label={
                        provider.deploymentHelp
                          ? `View ${provider.name} requirements`
                          : `Connect ${provider.name}`
                      }
                      onClick={() => setEditingProvider(provider)}
                    >
                      {provider.deploymentHelp
                        ? "View requirements"
                        : "Configure provider"}
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
