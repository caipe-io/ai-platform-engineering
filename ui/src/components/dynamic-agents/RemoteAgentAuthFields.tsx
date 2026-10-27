"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderSelect, type ProviderOption } from "@/components/ui/provider-select";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import type { RemoteAgentCredentialSource } from "@/types/dynamic-agent";
import React from "react";

interface SecretOption {
  id: string;
  name: string;
}

export function defaultRemoteAgentAuth(): RemoteAgentCredentialSource {
  return { kind: "caller_token", target: "header", name: "Authorization" };
}

export function isRemoteAgentAuthConfigured(source: RemoteAgentCredentialSource): boolean {
  return Boolean(source.name.trim()) && (
    source.kind === "caller_token" ||
    (source.kind === "secret_ref" && Boolean(source.secret_ref?.trim())) ||
    (source.kind === "provider_connection" && Boolean(source.provider?.trim()))
  );
}

export function RemoteAgentAuthFields({
  value,
  onChange,
  idPrefix,
  disabled,
}: {
  value: RemoteAgentCredentialSource;
  onChange: (value: RemoteAgentCredentialSource) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const [secrets, setSecrets] = React.useState<SecretOption[]>([]);
  const [providers, setProviders] = React.useState<ProviderOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);

  React.useEffect(() => {
    if (value.kind === "caller_token") {
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const kind = value.kind;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(
          kind === "secret_ref" ? "/api/credentials/secrets" : "/api/credentials/oauth-connectors",
          { credentials: "include", signal: controller.signal },
        );
        const payload = await response.json();
        if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
          throw new Error(payload.error || "Could not load credentials");
        }
        if (controller.signal.aborted) return;
        if (kind === "secret_ref") setSecrets(payload.data);
        else setProviders(payload.data);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Could not load credentials");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [value.kind, retry]);

  const selectedSecret = value.secret_ref
    ? secrets.find((secret) => secret.id === value.secret_ref) ?? {
        id: value.secret_ref,
        name: "Configured secret (not in your available secrets)",
      }
    : undefined;
  const providerOptions = value.provider && !providers.some((item) => item.provider === value.provider)
    ? [{ provider: value.provider, name: `${value.provider} (configured)` }, ...providers]
    : providers;

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="font-medium text-sm">Authentication</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-auth-kind`}>Credential source</Label>
          <Select
            id={`${idPrefix}-auth-kind`}
            value={value.kind}
            disabled={disabled}
            onChange={(event) => onChange({
              kind: event.target.value as RemoteAgentCredentialSource["kind"],
              target: "header",
              name: value.name,
            })}
          >
            <option value="caller_token">User JWT</option>
            <option value="secret_ref">Saved secret</option>
            <option value="provider_connection">Connected credential</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-auth-header`}>Header name</Label>
          <Input
            id={`${idPrefix}-auth-header`}
            placeholder="Authorization"
            value={value.name}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </div>
      </div>
      {value.kind === "secret_ref" && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-auth-secret`}>Saved secret</Label>
          <SearchablePicker
            id={`${idPrefix}-auth-secret`}
            ariaLabel="Saved secret"
            options={secrets}
            selected={selectedSecret}
            onSelect={(secret) => onChange({ ...value, secret_ref: secret.id })}
            getOptionKey={(secret) => secret.id}
            getOptionLabel={(secret) => secret.name}
            placeholder="Select a saved secret"
            searchPlaceholder="Search secrets…"
            emptyLabel="No saved secrets available"
            loading={loading}
            error={error}
            onRetry={() => setRetry((current) => current + 1)}
            required
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Select a secret from Credentials. Each caller must have permission to use it.
          </p>
        </div>
      )}
      {value.kind === "provider_connection" && (
        <div className="space-y-1">
          <Label>Connected provider</Label>
          <ProviderSelect
            options={providerOptions}
            value={value.provider || ""}
            onChange={(provider) => onChange({ ...value, provider })}
            ariaLabel="Connected provider"
            disabled={disabled || loading}
            className="w-full"
          />
          {loading && <p role="status" className="text-xs text-muted-foreground">Loading connected providers…</p>}
          {error && <div role="alert" className="text-xs text-destructive">{error} <Button type="button" variant="link" size="sm" onClick={() => setRetry((current) => current + 1)}>Retry</Button></div>}
          <p className="text-xs text-muted-foreground">
            Each caller uses their own account connected in Credentials.
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Authorization sends a Bearer token. Other headers receive the credential value directly.
      </p>
    </div>
  );
}
